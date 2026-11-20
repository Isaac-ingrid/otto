import { existsSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeRepoSkillOp, scanRepoSkillBriefsSync } from "../src/repo-skills.ts";
import { LocalStore } from "../src/store.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { fakePiAdapter, git, makeGitRepo, reportRun, tmpDir, waitFor, writeScenario } from "./helpers.ts";

let dir: string;
let repo: string;

beforeEach(async () => {
  dir = tmpDir("otto-repo-skills-test");
  repo = await makeGitRepo(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("executeRepoSkillOp & WorkerManager.repoSkillOp (Direction 2B, Stage 1)", () => {
  it("lists, writes, reads, CAS-updates, tracks Git status, and cleans empty skill subdirs across all 3 slots", async () => {
    const scope = { kind: "repo" as const, repoId: repo };

    // 1. Write universal .agents/skills/<slug>/SKILL.md
    const w1 = await executeRepoSkillOp({
      rootDir: repo,
      isGitRepo: true,
      op: {
        action: "write",
        scope,
        target: "agents-skill",
        slug: "run-tests",
        markdown: "---\nname: Run Tests\ndescription: Fast local test workflow\n---\n\n# Steps\n1. Run vitest\n",
      },
    });
    expect(w1.ok).toBe(true);
    if (!w1.ok || w1.data.action !== "write") throw new Error("expected write ok");
    expect(w1.data.summary).toMatchObject({
      target: "agents-skill",
      slug: "run-tests",
      relativePath: ".agents/skills/run-tests/SKILL.md",
      name: "Run Tests",
      description: "Fast local test workflow",
      gitStatus: "untracked",
    });
    const firstSha = w1.data.summary.sha256;

    // 2. Duplicate write without overwrite is refused with already_exists + existingSha256
    const dup = await executeRepoSkillOp({
      rootDir: repo,
      isGitRepo: true,
      op: {
        action: "write",
        scope,
        target: "agents-skill",
        slug: "run-tests",
        markdown: "# Overwrite attempt",
      },
    });
    expect(dup).toEqual({ ok: false, code: "already_exists", existingSha256: firstSha });

    // 3. Commit file -> gitStatus flips to clean; then CAS edit -> gitStatus flips to modified
    await git(repo, ["add", ".agents/skills/run-tests/SKILL.md"]);
    await git(repo, ["commit", "-m", "add run-tests skill"]);

    const listedClean = await executeRepoSkillOp({ rootDir: repo, isGitRepo: true, op: { action: "list", scope } });
    expect(listedClean.ok).toBe(true);
    if (!listedClean.ok || listedClean.data.action !== "list") throw new Error("expected list");
    expect(listedClean.data.skills[0]?.gitStatus).toBe("clean");

    // Stale expectedSha256 is rejected with sha256_conflict
    const badCas = await executeRepoSkillOp({
      rootDir: repo,
      isGitRepo: true,
      op: {
        action: "write",
        scope,
        target: "agents-skill",
        slug: "run-tests",
        markdown: "---\nname: Run Tests\ndescription: Updated\n---\n\n# Steps\n",
        expectedSha256: "0".repeat(64),
      },
    });
    expect(badCas).toEqual({ ok: false, code: "sha256_conflict", existingSha256: firstSha });

    // Valid CAS update succeeds and reports modified
    const updated = await executeRepoSkillOp({
      rootDir: repo,
      isGitRepo: true,
      op: {
        action: "write",
        scope,
        target: "agents-skill",
        slug: "run-tests",
        markdown: "---\nname: Run Tests\ndescription: Updated workflow\n---\n\n# Steps\nAuthorization: Bearer YOUR_PLACEHOLDER\n",
        expectedSha256: firstSha,
      },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok || updated.data.action !== "write") throw new Error("expected cas write");
    expect(updated.data.summary.gitStatus).toBe("modified");
    expect(updated.data.summary.description).toBe("Updated workflow");

    // 4. Write claude-skill & claude-command slots
    await executeRepoSkillOp({
      rootDir: repo,
      isGitRepo: true,
      op: { action: "write", scope, target: "claude-skill", slug: "lint-fix", markdown: "# Lint Fix\nRun eslint --fix." },
    });
    await executeRepoSkillOp({
      rootDir: repo,
      isGitRepo: true,
      op: { action: "write", scope, target: "claude-command", slug: "deploy-check", markdown: "# Deploy Check\nVerify build." },
    });

    const all = await executeRepoSkillOp({ rootDir: repo, isGitRepo: true, op: { action: "list", scope } });
    expect(all.ok && all.data.action === "list" ? all.data.skills.map((s) => `${s.target}:${s.slug}`) : []).toEqual([
      "agents-skill:run-tests",
      "claude-skill:lint-fix",
      "claude-command:deploy-check",
    ]);

    // 5. Read back & CAS delete removes empty <slug> subdir
    const readRes = await executeRepoSkillOp({
      rootDir: repo,
      isGitRepo: true,
      op: { action: "read", scope, target: "agents-skill", slug: "run-tests" },
    });
    expect(readRes.ok).toBe(true);
    if (!readRes.ok || readRes.data.action !== "read") throw new Error("expected read");
    expect(readRes.data.markdown).toContain("Authorization: Bearer YOUR_PLACEHOLDER");

    const delRes = await executeRepoSkillOp({
      rootDir: repo,
      isGitRepo: true,
      op: { action: "delete", scope, target: "agents-skill", slug: "run-tests", expectedSha256: readRes.data.summary.sha256 },
    });
    expect(delRes).toEqual({
      ok: true,
      data: { action: "delete", deleted: true, relativePath: ".agents/skills/run-tests/SKILL.md" },
    });
    expect(existsSync(join(repo, ".agents/skills/run-tests"))).toBe(false);
  });

  it("blocks invalid slugs, symlinks at parent or file level, and leaked secrets", async () => {
    const scope = { kind: "repo" as const, repoId: repo };

    for (const bad of ["../evil", "a/b", "Upper", "-bad", "bad-", ".dot"]) {
      const res = await executeRepoSkillOp({
        rootDir: repo,
        isGitRepo: true,
        op: { action: "write", scope, target: "agents-skill", slug: bad, markdown: "# x" },
      });
      expect(res).toEqual({ ok: false, code: "invalid_slug" });
    }

    // Secret-leak preflight catches OpenAI/GitHub keys and runtime extraSecrets
    const openAiKey = `sk-proj-${"A1b2C3d4E5f6G7h8I9j0"}`;
    expect(
      await executeRepoSkillOp({
        rootDir: repo,
        isGitRepo: true,
        op: { action: "write", scope, target: "agents-skill", slug: "leak-key", markdown: `Key: ${openAiKey}` },
      }),
    ).toEqual({ ok: false, code: "secret_detected" });

    expect(
      await executeRepoSkillOp({
        rootDir: repo,
        isGitRepo: true,
        extraSecrets: ["otto_dev_token_secret_123456"],
        op: { action: "write", scope, target: "agents-skill", slug: "leak-tok", markdown: "token=otto_dev_token_secret_123456" },
      }),
    ).toEqual({ ok: false, code: "secret_detected" });

    // Symlink escape inside .claude/commands/link.md -> outside target
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "# outside secret\n");
    mkdirSync(join(repo, ".claude/commands"), { recursive: true });
    symlinkSync(outside, join(repo, ".claude/commands/escape.md"));

    expect(
      await executeRepoSkillOp({
        rootDir: repo,
        isGitRepo: true,
        op: { action: "read", scope, target: "claude-command", slug: "escape" },
      }),
    ).toEqual({ ok: false, code: "symlink_forbidden" });

    expect(
      await executeRepoSkillOp({
        rootDir: repo,
        isGitRepo: true,
        op: { action: "write", scope, target: "claude-command", slug: "escape", markdown: "# overwrite", overwrite: true },
      }),
    ).toEqual({ ok: false, code: "symlink_forbidden" });

    // Symlinked intermediate directory (.agents/skills -> outsideDir)
    const outsideDir = join(dir, "outside-dir");
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(join(repo, ".agents"), { recursive: true });
    symlinkSync(outsideDir, join(repo, ".agents/skills"));

    expect(
      await executeRepoSkillOp({
        rootDir: repo,
        isGitRepo: true,
        op: { action: "write", scope, target: "agents-skill", slug: "escaped", markdown: "# test" },
      }),
    ).toEqual({ ok: false, code: "symlink_forbidden" });

    expect(
      await executeRepoSkillOp({
        rootDir: repo,
        isGitRepo: true,
        op: { action: "list", scope },
      }),
    ).toEqual({ ok: false, code: "symlink_forbidden" });
  });

  it("wires WorkerManager.repoSkillOp across registered repo and isolated write worktree scopes", async () => {
    const stateDir = join(dir, "state");
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    const events: Array<Record<string, unknown>> = [];
    const scenario = writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "done" })]);
    const manager = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario),
      emit: (_w, fields) => { events.push(fields); },
    });

    try {
      expect(
        await manager.repoSkillOp({ action: "list", scope: { kind: "repo", repoId: "/unregistered" } }),
      ).toEqual({ ok: false, code: "not_registered_repo" });

      store.addRepo({
        repoId: repo,
        name: "repo-a",
        path: repo,
        capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null },
      });

      const started = await manager.startWorker("cmd-wt-skill", {
        workerId: "w-wt-skill",
        threadId: "t-skill",
        repoId: repo,
        mode: "write",
        prompt: "work",
      });
      await waitFor(() => events.find((e) => e.type === "settled"), 15_000, "worker settled");
      expect(started.worktree).toBeTruthy();

      const wtWrite = await manager.repoSkillOp({
        action: "write",
        scope: { kind: "worktree", repoId: repo, workerId: "w-wt-skill" },
        target: "agents-skill",
        slug: "branch-only",
        markdown: "---\nname: Branch Skill\ndescription: Isolated in worktree\n---\n\n# Body\n",
      });
      expect(wtWrite.ok).toBe(true);
      expect(existsSync(join(started.worktree!, ".agents/skills/branch-only/SKILL.md"))).toBe(true);
      expect(existsSync(join(repo, ".agents/skills/branch-only/SKILL.md"))).toBe(false);
    } finally {
      manager.stop();
      await manager.stopProcess("w-wt-skill").catch(() => undefined);
      store.close();
    }
  }, 30_000);

  it("scanRepoSkillBriefsSync returns bounded, redacted metadata and silently skips symlinks", () => {
    mkdirSync(join(repo, ".agents/skills/db-migrate"), { recursive: true });
    const fakeKey = `sk-proj-${"Z9y8X7w6V5u4T3s2R1q0"}`;
    writeFileSync(
      join(repo, ".agents/skills/db-migrate/SKILL.md"),
      `---\nname: DB Migrate\ndescription: Run migrations without leaking ${fakeKey}\n---\n\n# Body\n`,
    );
    const outside = join(dir, "secret.md");
    writeFileSync(outside, "# secret\n");
    mkdirSync(join(repo, ".claude/commands"), { recursive: true });
    symlinkSync(outside, join(repo, ".claude/commands/evil-link.md"));

    const briefs = scanRepoSkillBriefsSync(repo);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({
      target: "agents-skill",
      slug: "db-migrate",
      relativePath: ".agents/skills/db-migrate/SKILL.md",
      name: "DB Migrate",
    });
    expect(briefs[0]!.description).toContain("[REDACTED]");
    expect(briefs[0]!.description).not.toContain(fakeKey);
    expect(scanRepoSkillBriefsSync(join(dir, "does-not-exist"))).toEqual([]);
  });
});
