import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStore } from "../src/store.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
  collectWorktreeAudit,
  executeWorktreeCleanup,
  measureDirectoryBytesBounded,
} from "../src/worktree-audit.ts";
import { managedRepoBucketName } from "../src/worktree.ts";
import { fakePiAdapter, git, makeGitRepo, reportRun, tmpDir, waitFor, writeScenario } from "./helpers.ts";

let dir: string;
let repo: string;

beforeEach(async () => {
  dir = tmpDir("otto-worktree-audit-test");
  repo = await makeGitRepo(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("Worktree audit & controlled cleanup engine (Direction E, Stage 1)", () => {
  it("performs strictly read-only inspection across clean, dirty, unmerged, orphan, prunable, and external worktrees", async () => {
    const stateDir = join(dir, "state");
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    const worktreesRoot = join(stateDir, "worktrees");
    const bucket = managedRepoBucketName(repo);

    try {
      store.addRepo({
        repoId: repo,
        name: "repo-main",
        path: repo,
        capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null },
      });
      store.setWritePolicy(repo, { isolation: "worktree", concurrency: "serial" });

      // 1. Clean managed worktree bound to w-clean
      const wtClean = join(worktreesRoot, bucket, "clean-1");
      mkdirSync(join(worktreesRoot, bucket), { recursive: true });
      await git(repo, ["worktree", "add", "-b", "otto/clean-1", wtClean, "main"]);
      store.upsertWorker({
        workerId: "w-clean",
        threadId: "t-clean",
        repoId: repo,
        mode: "write",
        state: "idle",
        branch: "otto/clean-1",
        worktree: wtClean,
        base: "main",
      });

      // 2. Dirty + unmerged managed worktree bound to w-dirty
      const wtDirty = join(worktreesRoot, bucket, "dirty-1");
      await git(repo, ["worktree", "add", "-b", "otto/dirty-1", wtDirty, "main"]);
      writeFileSync(join(wtDirty, "feature.txt"), "committed work\n");
      await git(wtDirty, ["add", "feature.txt"]);
      await git(wtDirty, ["commit", "-m", "add feature"]);
      writeFileSync(join(wtDirty, "feature.txt"), "modified uncommitted\n");
      writeFileSync(join(wtDirty, "scratch.tmp"), "untracked file\n");
      store.upsertWorker({
        workerId: "w-dirty",
        threadId: "t-dirty",
        repoId: repo,
        mode: "write",
        state: "idle",
        branch: "otto/dirty-1",
        worktree: wtDirty,
        base: "main",
      });

      // 3. Unregistered crash-orphan directory inside managed bucket (not in LocalStore or git worktree list)
      const wtOrphanLoose = join(worktreesRoot, bucket, "crash-leftover-1");
      mkdirSync(wtOrphanLoose, { recursive: true });
      writeFileSync(join(wtOrphanLoose, "partial.log"), "crash bytes");

      // 4. Prunable git worktree (directory deleted behind git's back — audit MUST NOT prune it)
      const wtPrunable = join(worktreesRoot, bucket, "vanished-1");
      await git(repo, ["worktree", "add", "-b", "otto/vanished-1", wtPrunable, "main"]);
      rmSync(wtPrunable, { recursive: true, force: true });

      // 5. User-created external worktree outside ~/.otto/worktrees
      const wtExternal = join(dir, "user-external-wt");
      await git(repo, ["worktree", "add", "-b", "user/private-wt", wtExternal, "main"]);

      const beforePorcelain = await git(repo, ["worktree", "list", "--porcelain"]);
      const res = await collectWorktreeAudit({ store, stateDir, now: () => 1_700_000_000_000 });
      const afterPorcelain = await git(repo, ["worktree", "list", "--porcelain"]);

      // Read-only invariant: git worktree metadata was NOT pruned or mutated during audit.
      expect(afterPorcelain).toBe(beforePorcelain);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected audit ok");

      expect(res.audit.repos).toHaveLength(1);
      expect(res.audit.repos[0]).toMatchObject({
        repoId: repo,
        name: "repo-main",
        capabilityKind: "git",
        defaultBranch: "main",
        writeIsolation: "worktree",
        writeConcurrency: "serial",
        prunableCount: 1,
      });

      const byBranchOrKey = new Map(
        res.audit.worktrees.map((w) => [w.localWorkerId ?? w.worktreeKey, w]),
      );

      const cleanItem = byBranchOrKey.get("w-clean")!;
      expect(cleanItem).toMatchObject({
        managedByOtto: true,
        existsOnDisk: true,
        branch: "otto/clean-1",
        dirty: false,
        modifiedCount: 0,
        untrackedCount: 0,
        ahead: 0,
        mergedIntoBase: true,
        diskComplete: true,
      });
      expect(cleanItem.diskBytes).toBeGreaterThan(0);

      const dirtyItem = byBranchOrKey.get("w-dirty")!;
      expect(dirtyItem).toMatchObject({
        managedByOtto: true,
        existsOnDisk: true,
        branch: "otto/dirty-1",
        dirty: true,
        modifiedCount: 1,
        untrackedCount: 1,
        ahead: 1,
        mergedIntoBase: false,
      });

      const looseOrphan = byBranchOrKey.get(`${bucket}/crash-leftover-1`)!;
      expect(looseOrphan).toMatchObject({
        managedByOtto: true,
        existsOnDisk: true,
        localWorkerId: null,
        dirty: true,
        untrackedCount: 1,
      });

      const vanishedItem = byBranchOrKey.get(`${bucket}/vanished-1`)!;
      expect(vanishedItem).toMatchObject({
        managedByOtto: true,
        existsOnDisk: false,
        prunable: true,
        diskBytes: 0,
      });

      const extItem = res.audit.worktrees.find((w) => w.branch === "user/private-wt")!;
      expect(extItem).toBeTruthy();
      expect(extItem.managedByOtto).toBe(false);
      expect(extItem.worktreeKey.startsWith("ext:")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("caps directory byte scanning deterministically without following symlinks", async () => {
    const sample = join(dir, "bounded-scan");
    mkdirSync(join(sample, "nested"), { recursive: true });
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(sample, "nested", `f-${i}.bin`), "x".repeat(128));
    }
    const outsideBig = join(dir, "outside-big.bin");
    writeFileSync(outsideBig, "y".repeat(4096));
    symlinkSync(outsideBig, join(sample, "sym-big.bin"));

    const full = await measureDirectoryBytesBounded(sample, 100);
    expect(full.diskComplete).toBe(true);
    expect(full.diskBytes).toBe(8 * 128);

    const capped = await measureDirectoryBytesBounded(sample, 4);
    expect(capped.diskComplete).toBe(false);
    expect(capped.diskBytes).toBeLessThan(8 * 128);
  });

  it("enforces path containment, active-worker immunity, TOCTOU dirty/unmerged gates, and idle-hot process stop during cleanup", async () => {
    const stateDir = join(dir, "state-clean");
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    const worktreesRoot = join(stateDir, "worktrees");
    const bucket = managedRepoBucketName(repo);
    const events: Array<Record<string, unknown>> = [];
    const scenario = writeScenario(dir, "scenario-clean", [reportRun({ status: "done", summary: "finished" })]);
    const manager = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario),
      emit: (_w, fields) => { events.push(fields); },
    });

    try {
      store.addRepo({
        repoId: repo,
        name: "repo-main",
        path: repo,
        capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null },
      });

      // Start and settle a real worker so it has an idle-hot process in a managed worktree
      const started = await manager.startWorker("cmd-clean-hot", {
        workerId: "w-hot-idle",
        threadId: "t-hot",
        repoId: repo,
        mode: "write",
        prompt: "finish cleanly",
      });
      await waitFor(() => events.find((e) => e.type === "settled"), 15_000, "hot worker settled");
      expect(started.worktree).toBeTruthy();

      // Active running worker in another worktree — MUST be immune even under force + confirmedRisks
      const wtRunning = join(worktreesRoot, bucket, "running-1");
      await git(repo, ["worktree", "add", "-b", "otto/running-1", wtRunning, "main"]);
      store.upsertWorker({
        workerId: "w-active",
        threadId: "t-active",
        repoId: repo,
        mode: "write",
        state: "running",
        branch: "otto/running-1",
        worktree: wtRunning,
        base: "main",
      });

      // Dirty worktree — blocked without force+confirmedRisks, cleaned with both
      const wtDirty = join(worktreesRoot, bucket, "dirty-gate-1");
      await git(repo, ["worktree", "add", "-b", "otto/dirty-gate-1", wtDirty, "main"]);
      store.upsertWorker({
        workerId: "w-dirty-gate",
        threadId: "t-dirty-gate",
        repoId: repo,
        mode: "write",
        state: "idle",
        branch: "otto/dirty-gate-1",
        worktree: wtDirty,
        base: "main",
      });
      // Simulate TOCTOU dirty edit right before non-forced cleanup
      writeFileSync(join(wtDirty, "late-edit.txt"), "unsaved work\n");

      // Unmerged clean worktree — blocked without force+confirmedRisks
      const wtUnmerged = join(worktreesRoot, bucket, "unmerged-1");
      await git(repo, ["worktree", "add", "-b", "otto/unmerged-1", wtUnmerged, "main"]);
      writeFileSync(join(wtUnmerged, "unmerged.txt"), "ahead commit\n");
      await git(wtUnmerged, ["add", "unmerged.txt"]);
      await git(wtUnmerged, ["commit", "-m", "unmerged commit"]);
      store.upsertWorker({
        workerId: "w-unmerged",
        threadId: "t-unmerged",
        repoId: repo,
        mode: "write",
        state: "idle",
        branch: "otto/unmerged-1",
        worktree: wtUnmerged,
        base: "main",
      });

      // External worktree & symlink escape inside bucket
      const wtExt = join(dir, "ext-never-touch");
      await git(repo, ["worktree", "add", "-b", "user/ext", wtExt, "main"]);
      store.upsertWorker({
        workerId: "w-ext-spoof",
        threadId: "t-ext",
        repoId: repo,
        mode: "write",
        state: "idle",
        branch: "user/ext",
        worktree: wtExt,
        base: "main",
      });

      const outsideTarget = join(dir, "outside-precious");
      mkdirSync(outsideTarget, { recursive: true });
      writeFileSync(join(outsideTarget, "keep.txt"), "precious");
      symlinkSync(outsideTarget, join(worktreesRoot, bucket, "sym-escape"));

      // Clean empty orphan directory
      const wtCleanOrphan = join(worktreesRoot, bucket, "orphan-clean-1");
      await git(repo, ["worktree", "add", "--detach", wtCleanOrphan, "main"]);

      // Pass 1: Safe cleanup batch (force: false, confirmedRisks: false) + forbidden/active probes
      const pass1 = await manager.cleanupWorktrees({
        confirmedRisks: false,
        pruneRepoIds: [repo],
        targets: [
          { kind: "worker", repoId: repo, workerId: "w-hot-idle", force: false },
          { kind: "orphan_dir", repoId: repo, worktreeKey: `${bucket}/orphan-clean-1`, force: false },
          { kind: "worker", repoId: repo, workerId: "w-active", force: true },
          { kind: "worker", repoId: repo, workerId: "w-dirty-gate", force: false },
          { kind: "worker", repoId: repo, workerId: "w-unmerged", force: false },
          { kind: "worker", repoId: repo, workerId: "w-ext-spoof", force: true },
          { kind: "orphan_dir", repoId: repo, worktreeKey: `${bucket}/sym-escape`, force: true },
          { kind: "orphan_dir", repoId: repo, worktreeKey: "wrongbucket-00000000/foo", force: true },
        ],
      });
      expect(pass1.ok).toBe(true);
      if (!pass1.ok) throw new Error("expected pass1 ok");

      const statusMap = Object.fromEntries(pass1.result.items.map((i) => [i.targetKey, i.status]));
      expect(statusMap).toEqual({
        "worker:w-hot-idle": "cleaned",
        [`orphan:${bucket}/orphan-clean-1`]: "cleaned",
        "worker:w-active": "worker_active",
        "worker:w-dirty-gate": "blocked_dirty",
        "worker:w-unmerged": "blocked_unmerged",
        "worker:w-ext-spoof": "forbidden_path",
        [`orphan:${bucket}/sym-escape`]: "forbidden_path",
        "orphan:wrongbucket-00000000/foo": "forbidden_path",
      });

      expect(existsSync(started.worktree!)).toBe(false);
      expect(store.getWorker("w-hot-idle")?.worktree).toBeNull();
      expect(store.getWorker("w-hot-idle")?.worktreeCleanedAt).toBeTypeOf("number");
      expect(existsSync(wtCleanOrphan)).toBe(false);

      // Protected directories MUST remain intact
      expect(existsSync(wtRunning)).toBe(true);
      expect(existsSync(wtDirty)).toBe(true);
      expect(existsSync(wtUnmerged)).toBe(true);
      expect(existsSync(wtExt)).toBe(true);
      expect(existsSync(join(outsideTarget, "keep.txt"))).toBe(true);

      // Even force: true WITHOUT confirmedRisks: true is still blocked on the server!
      const missingConfirm = await executeWorktreeCleanup(
        { store, stateDir },
        {
          confirmedRisks: false,
          targets: [{ kind: "worker", repoId: repo, workerId: "w-dirty-gate", force: true }],
        },
      );
      expect(missingConfirm.ok && missingConfirm.result.items[0]?.status).toBe("blocked_dirty");
      expect(existsSync(wtDirty)).toBe(true);

      // Pass 2: Explicit secondary confirmation (`force: true, confirmedRisks: true`) removes dirty & unmerged
      const pass2 = await manager.cleanupWorktrees({
        confirmedRisks: true,
        targets: [
          { kind: "worker", repoId: repo, workerId: "w-dirty-gate", expectedBranch: "otto/dirty-gate-1", force: true },
          { kind: "worker", repoId: repo, workerId: "w-unmerged", expectedBranch: "otto/unmerged-1", force: true },
        ],
      });
      expect(pass2.ok).toBe(true);
      if (!pass2.ok) throw new Error("expected pass2 ok");
      expect(pass2.result.items.map((i) => i.status)).toEqual(["cleaned", "cleaned"]);
      expect(existsSync(wtDirty)).toBe(false);
      expect(existsSync(wtUnmerged)).toBe(false);
    } finally {
      manager.stop();
      await manager.stopProcess("w-hot-idle").catch(() => undefined);
      store.close();
    }
  }, 30_000);
});
