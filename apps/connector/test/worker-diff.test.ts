import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerDiffPayloadSchema } from "@isaac2ingrid/protocol";
import { EventLog } from "../src/events.ts";
import { LocalStore } from "../src/store.ts";
import { collectWorkerDiff, sliceUtf8ByBytes } from "../src/worker-diff.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { WorktreeManager } from "../src/worktree.ts";
import { fakePiAdapter, git, makeGitRepo, reportRun, tmpDir, waitFor, writeScenario } from "./helpers.ts";

let dir: string;
let repo: string;

beforeEach(async () => {
  dir = tmpDir("otto-worker-diff-test");
  repo = await makeGitRepo(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("collectWorkerDiff & UTF-8 byte slicing", () => {
  it("slices multi-byte UTF-8 strings cleanly without splitting surrogate/UTF-8 sequences", () => {
    const sample = "中文🙂abc";
    for (let budget = 1; budget <= Buffer.byteLength(sample, "utf8") + 2; budget += 1) {
      const { text } = sliceUtf8ByBytes(sample, budget);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(budget);
      expect(text.includes("\uFFFD")).toBe(false);
    }
  });

  it("collects committed, unstaged, renamed, binary, and untracked changes and scrubs secrets", async () => {
    const baseDoc = Array.from({ length: 10 }, (_, i) => `shared line ${i}`).join("\n") + "\n";
    writeFileSync(join(repo, "README.md"), baseDoc, "utf8");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "chore: expand readme"]);
    const wtManager = new WorktreeManager({ worktreesRoot: join(dir, "wts") });
    const wt = await wtManager.create({ repoPath: repo, threadId: "diff-t1" });

    // Commit a rename + modification containing a secret token.
    await git(wt.path, ["mv", "README.md", "DOCS.md"]);
    writeFileSync(join(wt.path, "DOCS.md"), `${baseDoc}token=CUSTOM_SECRET_VAL_999\n`, "utf8");
    writeFileSync(join(wt.path, "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await git(wt.path, ["add", "."]);
    await git(wt.path, ["commit", "-m", "feat: rename with CUSTOM_SECRET_VAL_999"]);

    // Leave untracked file in working tree.
    mkdirSync(join(wt.path, "src"), { recursive: true });
    writeFileSync(join(wt.path, "src/new.ts"), "export const x = 42;\n", "utf8");

    const res = await collectWorkerDiff({
      workDir: wt.path,
      base: wt.base,
      extraSecrets: ["CUSTOM_SECRET_VAL_999"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(WorkerDiffPayloadSchema.safeParse(res.diff).success).toBe(true);
    expect(res.diff.ahead).toBe(1);
    expect(res.diff.dirty).toBe(1);
    expect(res.diff.patchTruncated).toBe(false);
    expect(res.diff.commits[0]!.subject).not.toContain("CUSTOM_SECRET_VAL_999");
    expect(res.diff.patch).not.toContain("CUSTOM_SECRET_VAL_999");
    expect(res.diff.patch).toContain("export const x = 42;");

    const byPath = new Map(res.diff.files.map((f) => [f.path, f]));
    expect(byPath.get("DOCS.md")).toMatchObject({ status: "R", oldPath: "README.md", binary: false });
    expect(byPath.get("bin.dat")).toMatchObject({ status: "A", binary: true });
    expect(byPath.get("src/new.ts")).toMatchObject({ status: "U", insertions: 1, deletions: 0, binary: false });
  });

  it("enforces two-tier 128 KiB inline patch budget, serves per-file diffs, and rejects unsafe filePath", async () => {
    const wtManager = new WorktreeManager({ worktreesRoot: join(dir, "wts-large") });
    const wt = await wtManager.create({ repoPath: repo, threadId: "diff-large" });

    writeFileSync(join(wt.path, "huge.txt"), `${"line-of-diff-content-0123456789\n".repeat(5000)}`, "utf8");
    writeFileSync(join(wt.path, "small.txt"), "small change\n", "utf8");
    await git(wt.path, ["add", "huge.txt", "small.txt"]);

    const overview = await collectWorkerDiff({ workDir: wt.path, base: wt.base });
    expect(overview).toMatchObject({
      ok: true,
      diff: { patch: "", patchTruncated: true },
    });
    if (overview.ok) {
      expect(overview.diff.files.map((f) => f.path)).toEqual(["huge.txt", "small.txt"]);
    }

    const singleSmall = await collectWorkerDiff({ workDir: wt.path, base: wt.base, filePath: "small.txt" });
    expect(singleSmall.ok).toBe(true);
    if (singleSmall.ok) {
      expect(singleSmall.diff.patchTruncated).toBe(false);
      expect(singleSmall.diff.patch).toContain("+small change");
    }

    const singleHuge = await collectWorkerDiff({ workDir: wt.path, base: wt.base, filePath: "huge.txt" });
    expect(singleHuge.ok).toBe(true);
    if (singleHuge.ok) {
      expect(singleHuge.diff.patchTruncated).toBe(true);
      expect(WorkerDiffPayloadSchema.safeParse(singleHuge.diff).success).toBe(true);
    }

    for (const bad of ["../outside.txt", "/etc/passwd", "a/../../b"]) {
      expect(await collectWorkerDiff({ workDir: wt.path, base: wt.base, filePath: bad })).toEqual({
        ok: false,
        code: "invalid_path",
      });
    }
  });

  it("wires WorkerManager.diffWorker and cleans readonly/zero-ahead worktrees with force=false", async () => {
    const stateDir = join(dir, "state");
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    const eventLog = new EventLog(store.database);
    const events: Array<{ workerId: string; type: string }> = [];
    store.addRepo({
      repoId: repo,
      name: "repo-a",
      path: repo,
      capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null },
    });
    const scenario = writeScenario(dir, "pi-diff", [
      reportRun({ status: "done", summary: "ok" }),
      reportRun({ status: "done", summary: "ro ok" }),
    ]);
    const manager = new WorkerManager({
      store,
      stateDir,
      adapters: [fakePiAdapter(stateDir, scenario)],
      emit: (workerId, fields) => {
        events.push(JSON.parse(eventLog.append(workerId, fields).payload) as { workerId: string; type: string });
      },
    });

    try {
      const started = await manager.startWorker("cmd-w1", {
        workerId: "w-diff-1",
        threadId: "t-diff-1",
        repoId: repo,
        mode: "write",
        prompt: "No-op run",
      });
      await waitFor(() => events.some((e) => e.workerId === "w-diff-1" && e.type === "settled"), 15_000, "w1 settled");
      await manager.stopProcess("w-diff-1");

      writeFileSync(join(started.worktree!, "note.txt"), "draft\n", "utf8");
      const dirtyDiff = await manager.diffWorker({ workerId: "w-diff-1" });
      expect(dirtyDiff.ok).toBe(true);
      if (dirtyDiff.ok) expect(dirtyDiff.diff.files.map((f) => f.path)).toContain("note.txt");

      await expect(manager.cleanupWorktree("w-diff-1", false)).rejects.toMatchObject({ code: "worktree_dirty" });
      rmSync(join(started.worktree!, "note.txt"));
      await expect(manager.cleanupWorktree("w-diff-1", false)).resolves.toMatchObject({ removed: started.worktree });
      expect(await manager.diffWorker({ workerId: "w-diff-1" })).toEqual({ ok: false, code: "no_worktree" });

      await git(repo, ["branch", "otto/base-branch-1"]);
      const roStarted = await manager.startWorker("cmd-ro1", {
        workerId: "w-ro-clean",
        threadId: "t-diff-1",
        repoId: repo,
        mode: "readonly",
        base: "otto/base-branch-1",
        prompt: "Readonly check",
      });
      await waitFor(() => events.some((e) => e.workerId === "w-ro-clean" && e.type === "settled"), 15_000, "ro settled");
      await manager.stopProcess("w-ro-clean");
      await expect(manager.cleanupWorktree("w-ro-clean", false)).resolves.toMatchObject({ removed: roStarted.worktree });
    } finally {
      manager.stop();
      store.close();
    }
  });
});
