// ADR-0022 Stage 2 (Plan B): locally approved worktree lifecycle hooks in connector.sqlite.
// Covers LocalStore schema migration, ~/.otto/hooks containment + symlink defense,
// SHA-256 config+bytes approval invalidation, rejectLocalOnlyArgs remote blocking,
// setup_hook progress + fail-closed empty-worktree rollback, readonly/in-place/detached
// non-execution, dirty-worktree refusal + archive_hook_failed preservation, OTTO_* env
// scrubbing, proxy inheritance, and secret redaction in ~/.otto/logs/hook-<workerId>.log.
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events.ts";
import {
  computeHooksApprovalDigest,
  HookConfigError,
  hookLogPath,
  hooksRootDir,
  normalizeHookScriptInput,
  repoHookCapabilitySummary,
  verifyRepoHooks,
} from "../src/hooks.ts";
import { lockPath } from "../src/locks.ts";
import { LocalStore, WritePolicyError } from "../src/store.ts";
import { WorkerManager, type StartWorkerArgs } from "../src/worker-manager.ts";
import {
  fakePiAdapter,
  git,
  makeGitRepo,
  reportRun,
  tmpDir,
  waitFor,
  writeScenario,
  type ScenarioStep,
} from "./helpers.ts";

interface EmittedEvent {
  workerId: string;
  seq: number;
  ts: number;
  type: string;
  [key: string]: unknown;
}

let dir: string;
let stateDir: string;
let repo: string;
let store: LocalStore;
let eventLog: EventLog;
let events: EmittedEvent[];
let manager: WorkerManager | undefined;
const workerIds = new Set<string>();

beforeEach(async () => {
  dir = tmpDir("otto-hooks-test");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  eventLog = new EventLog(store.database);
  events = [];
});

afterEach(async () => {
  manager?.stop();
  for (const workerId of workerIds) {
    await manager?.stopProcess(workerId).catch(() => undefined);
  }
  workerIds.clear();
  await new Promise((resolve) => setTimeout(resolve, 80));
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function writeHookScript(name: string, body: string, mode = 0o755): string {
  const root = hooksRootDir(stateDir);
  mkdirSync(root, { recursive: true });
  const target = join(root, name);
  writeFileSync(target, body, "utf8");
  chmodSync(target, mode);
  return target;
}

function configureAndApproveHooks(patch: { setupHook?: string | null; archiveHook?: string | null }): string {
  store.setRepoHooks(repo, patch);
  const current = store.getRepo(repo)!;
  const digest = computeHooksApprovalDigest(stateDir, current.hooks);
  if (!digest.ok) throw new Error(`expected valid hook digest, got: ${digest.reason}`);
  store.approveRepoHooks(repo, digest.sha256);
  return digest.sha256;
}

function setupManager(runs: ScenarioStep[][], hookTimeoutMs = 5_000): void {
  const scenario = writeScenario(dir, "scenario", runs);
  manager = new WorkerManager({
    store,
    stateDir,
    adapter: fakePiAdapter(stateDir, scenario),
    hooks: { timeoutMs: hookTimeoutMs },
    emit: (workerId, fields) => {
      const stored = eventLog.append(workerId, fields);
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
  });
}

function registerGitRepo(): void {
  store.addRepo({
    repoId: repo,
    name: "repo-a",
    path: repo,
    capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null },
  });
}

function startArgs(overrides: Partial<StartWorkerArgs> = {}): StartWorkerArgs {
  const merged: StartWorkerArgs = {
    workerId: "w-hook-1",
    threadId: "hook-thread",
    repoId: repo,
    mode: "write",
    prompt: "Implement feature",
    ...overrides,
  };
  workerIds.add(merged.workerId);
  return merged;
}

const settledOf = (workerId: string) => events.find((e) => e.type === "settled" && e.workerId === workerId);

describe("B1: LocalStore hook columns, path containment, and SHA-256 approval binding", () => {
  it("migrates a pre-Stage-2 repo table without losing existing local policy columns", () => {
    const legacyDbPath = join(dir, "legacy-connector.sqlite");
    const raw = new DatabaseSync(legacyDbPath);
    raw.exec(`CREATE TABLE repo (
      repoId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'git',
      defaultBranch TEXT,
      remote TEXT,
      addedAt INTEGER NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      isolation TEXT NOT NULL DEFAULT 'worktree',
      concurrency TEXT NOT NULL DEFAULT 'parallel'
    )`);
    raw
      .prepare(
        "INSERT INTO repo (repoId, name, path, kind, defaultBranch, remote, addedAt, approved, isolation, concurrency) VALUES (?, ?, ?, 'git', 'main', NULL, 1, 1, 'worktree', 'serial')",
      )
      .run(repo, "repo-a", repo);
    raw.close();

    const upgraded = new LocalStore(legacyDbPath);
    try {
      expect(upgraded.getRepo(repo)).toMatchObject({
        repoId: repo,
        approved: true,
        writePolicy: { isolation: "worktree", concurrency: "serial" },
        hooks: {
          setupHook: null,
          archiveHook: null,
          hookApprovedSha256: null,
          hookApprovedAt: null,
        },
      });
    } finally {
      upgraded.close();
    }
  });

  it("rejects worktree hooks on plain (non-Git) workspaces and preserves Git hooks across addRepo re-registration", () => {
    const plainDir = join(dir, "plain-ws");
    mkdirSync(plainDir);
    store.addRepo({ repoId: plainDir, name: "plain-ws", path: plainDir, capability: { kind: "plain" } });
    expect(() => store.setRepoHooks(plainDir, { setupHook: "setup.sh" })).toThrow(WritePolicyError);
    expect(() => store.approveRepoHooks(plainDir, "a".repeat(64))).toThrow(WritePolicyError);

    registerGitRepo();
    writeHookScript("setup.sh", "#!/bin/sh\nexit 0\n");
    const sha = configureAndApproveHooks({ setupHook: "setup.sh" });

    // Re-announcing the repo on reconnect refreshes identity only, never wiping local hook approval.
    store.addRepo({
      repoId: repo,
      name: "repo-a-renamed",
      path: repo,
      capability: { kind: "git", gitRoot: repo, defaultBranch: "develop", remote: "git@example.com:a.git" },
    });
    expect(store.getRepo(repo)?.hooks).toMatchObject({
      setupHook: "setup.sh",
      archiveHook: null,
      hookApprovedSha256: sha,
    });
  });

  it("enforces ~/.otto/hooks containment and blocks .. traversal, repo scripts, and symlink escapes", () => {
    writeHookScript("valid-setup.sh", "#!/bin/sh\nexit 0\n");
    const repoScript = join(repo, "conductor-setup.sh");
    writeFileSync(repoScript, "#!/bin/sh\necho pwned\n");
    chmodSync(repoScript, 0o755);

    const outsideScript = join(dir, "outside.sh");
    writeFileSync(outsideScript, "#!/bin/sh\necho outside\n");
    chmodSync(outsideScript, 0o755);

    const symlinkInHooks = join(hooksRootDir(stateDir), "escape-link.sh");
    symlinkSync(repoScript, symlinkInHooks);

    expect(normalizeHookScriptInput(stateDir, "valid-setup.sh").canonicalName).toBe("valid-setup.sh");
    expect(normalizeHookScriptInput(stateDir, join(hooksRootDir(stateDir), "valid-setup.sh")).canonicalName).toBe(
      "valid-setup.sh",
    );

    expect(() => normalizeHookScriptInput(stateDir, "../outside.sh")).toThrow(HookConfigError);
    expect(() => normalizeHookScriptInput(stateDir, repoScript)).toThrow(HookConfigError);
    expect(() => normalizeHookScriptInput(stateDir, outsideScript)).toThrow(HookConfigError);
    expect(() => normalizeHookScriptInput(stateDir, "escape-link.sh")).toThrow(/symlink/i);
    expect(() => normalizeHookScriptInput(stateDir, symlinkInHooks)).toThrow(/symlink/i);
  });

  it("invalidates approval on any script byte change or hook config mutation, and emits boolean-only summaries", () => {
    registerGitRepo();
    const setupPath = writeHookScript("setup.sh", "#!/bin/sh\necho v1\n");
    writeHookScript("archive.sh", "#!/bin/sh\necho clean\n");

    store.setRepoHooks(repo, { setupHook: "setup.sh" });
    expect(verifyRepoHooks(stateDir, store.getRepo(repo)!.hooks)).toMatchObject({
      configured: true,
      approved: false,
    });
    expect(repoHookCapabilitySummary(store.getRepo(repo)!, stateDir)).toEqual({
      capabilityKind: "git",
      hasSetupHook: true,
      hasArchiveHook: false,
      approved: false,
    });

    configureAndApproveHooks({ setupHook: "setup.sh" });
    const approvedSummary = repoHookCapabilitySummary(store.getRepo(repo)!, stateDir);
    expect(approvedSummary).toEqual({
      capabilityKind: "git",
      hasSetupHook: true,
      hasArchiveHook: false,
      approved: true,
    });
    expect(JSON.stringify(approvedSummary)).not.toContain("setup.sh");
    expect(JSON.stringify(approvedSummary)).not.toContain(stateDir);

    // 1-byte mutation on disk immediately invalidates SHA-256 approval without touching SQLite.
    writeFileSync(setupPath, "#!/bin/sh\necho v2\n", "utf8");
    expect(verifyRepoHooks(stateDir, store.getRepo(repo)!.hooks)).toMatchObject({
      configured: true,
      approved: false,
      reason: expect.stringMatching(/SHA-256 mismatch/i),
    });
    expect(repoHookCapabilitySummary(store.getRepo(repo)!, stateDir).approved).toBe(false);

    // Re-approve v2, then mutate hook configuration (adding archiveHook) -> clears approval column.
    configureAndApproveHooks({ setupHook: "setup.sh" });
    expect(verifyRepoHooks(stateDir, store.getRepo(repo)!.hooks).approved).toBe(true);
    store.setRepoHooks(repo, { archiveHook: "archive.sh" });
    expect(store.getRepo(repo)!.hooks.hookApprovedSha256).toBeNull();
    expect(verifyRepoHooks(stateDir, store.getRepo(repo)!.hooks).approved).toBe(false);
  });
});

describe("B2/B3/B4: WorkerManager hook execution, security boundaries, and rollback", () => {
  it("rejects remote start_worker and cleanup_worktree commands carrying any hook setting", async () => {
    setupManager([[]]);
    registerGitRepo();

    for (const key of [
      "setupHook",
      "archiveHook",
      "hooks",
      "approveHooks",
      "clearHooks",
      "hookApprovedSha256",
      "hookApprovedAt",
    ]) {
      await expect(
        manager!.handleCommand(`cmd-start-${key}`, "start_worker", {
          ...startArgs({ workerId: `w-bad-${key}` }),
          [key]: "setup.sh",
        }),
      ).rejects.toMatchObject({ code: "local_only_setting" });

      await expect(
        manager!.handleCommand(`cmd-clean-${key}`, "cleanup_worktree", {
          workerId: "w-any",
          [key]: "archive.sh",
        }),
      ).rejects.toMatchObject({ code: "local_only_setting" });
    }
    expect(events).toHaveLength(0);
  });

  it("runs approved setup hook in worktree with progress{phase:'setup_hook'}, EOF stdin, scrubbed OTTO_* env, proxy env, and redacted logs", async () => {
    registerGitRepo();
    store.saveCredentials({
      serverUrl: "https://steward.example.com",
      deviceId: "dev_secret_test",
      token: "st1.dev_secret_test.99.supersecretdevicetokenvalue",
    });
    store.setProxyConfig({ url: "http://127.0.0.1:7890/", noProxy: ".internal.example" });

    // `cat` proves stdin is non-interactive (EOF immediately); env dump proves OTTO_* is stripped
    // while proxy vars pass through; echo prints secret-shaped tokens to test log redaction.
    writeHookScript(
      "setup.sh",
      `#!/bin/sh
set -eu
STDIN_CONTENT="$(cat)"
printf '%s' "$STDIN_CONTENT" > .hook-stdin
pwd > .hook-cwd
env | grep '^OTTO_' > .hook-otto-env || true
printf '%s|%s' "\${HTTPS_PROXY:-}" "\${NO_PROXY:-}" > .hook-proxy
echo "bootstrapped with sk-proj-1234567890abcdefghij and st1.dev_secret_test.99.supersecretdevicetokenvalue"
`,
    );
    configureAndApproveHooks({ setupHook: "setup.sh" });

    const prevSecret = process.env.OTTO_INTERNAL_TEST_SECRET;
    process.env.OTTO_INTERNAL_TEST_SECRET = "must-never-reach-hook";
    try {
      setupManager([reportRun({ status: "done", summary: "feature ready" })]);
      const result = await manager!.startWorker("cmd-setup-ok", startArgs({ workerId: "w-setup-ok" }));
      await waitFor(() => settledOf("w-setup-ok"), 15_000, "settled event");

      expect(result.worktree).toBeTruthy();
      expect(readFileSync(join(result.worktree!, ".hook-stdin"), "utf8")).toBe("");
      expect(readFileSync(join(result.worktree!, ".hook-otto-env"), "utf8")).toBe("");
      expect(readFileSync(join(result.worktree!, ".hook-proxy"), "utf8")).toContain("http://127.0.0.1:7890/");
      expect(readFileSync(join(result.worktree!, ".hook-proxy"), "utf8")).toContain(".internal.example");

      // Event sequence: progress{phase:"setup_hook", target:"setup"} arrives BEFORE `started`!
      const workerEvents = events.filter((e) => e.workerId === "w-setup-ok");
      expect(workerEvents[0]).toMatchObject({
        type: "progress",
        seq: 1,
        phase: "setup_hook",
        target: "setup",
      });
      expect(workerEvents[1]).toMatchObject({
        type: "started",
        seq: 2,
      });

      const logContent = readFileSync(hookLogPath(stateDir, "w-setup-ok"), "utf8");
      expect(logContent).toContain("phase=setup status=ok");
      expect(logContent).not.toContain("sk-proj-1234567890abcdefghij");
      expect(logContent).not.toContain("supersecretdevicetokenvalue");
      expect(logContent).toContain("[redacted]");
    } finally {
      if (prevSecret === undefined) delete process.env.OTTO_INTERNAL_TEST_SECRET;
      else process.env.OTTO_INTERNAL_TEST_SECRET = prevSecret;
    }
  }, 30_000);

  it("never runs setup or archive hooks on readonly main-checkout, in-place write, or detached-HEAD readonly worktrees", async () => {
    registerGitRepo();
    const markerFile = join(dir, "hook-invocations.log");
    writeHookScript(
      "setup.sh",
      `#!/bin/sh\necho "setup:$(pwd)" >> "${markerFile}"\n`,
    );
    writeHookScript(
      "archive.sh",
      `#!/bin/sh\necho "archive:$(pwd)" >> "${markerFile}"\n`,
    );
    configureAndApproveHooks({ setupHook: "setup.sh", archiveHook: "archive.sh" });

    // Prepare a branch for detached-HEAD readonly relay (`createReadonlyWorktree`).
    await git(repo, ["checkout", "-b", "otto/prior-leg-1"]);
    writeFileSync(join(repo, "RELAY.md"), "relay\n");
    await git(repo, ["add", "RELAY.md"]);
    await git(repo, ["commit", "-m", "relay base"]);
    await git(repo, ["checkout", "main"]);

    setupManager([
      reportRun({ status: "done", summary: "ro main" }),
      reportRun({ status: "done", summary: "ro detached" }),
      reportRun({ status: "done", summary: "in-place write" }),
    ]);

    // 1. Main-checkout readonly
    await manager!.startWorker("cmd-ro-main", startArgs({ workerId: "w-ro-main", mode: "readonly" }));
    await waitFor(() => settledOf("w-ro-main"), 15_000, "ro main settled");

    // 2. Detached-HEAD readonly worktree (`createReadonlyWorktree`) + cleanup_worktree
    const roDetached = await manager!.startWorker(
      "cmd-ro-det",
      startArgs({ workerId: "w-ro-det", mode: "readonly", base: "otto/prior-leg-1" }),
    );
    expect(roDetached.worktree).toBeTruthy();
    await waitFor(() => settledOf("w-ro-det"), 15_000, "ro detached settled");
    await manager!.stopProcess("w-ro-det");
    await waitFor(() => !existsSync(lockPath(stateDir, "w-ro-det")), 10_000, "ro lock released");
    await manager!.cleanupWorktree("w-ro-det", true);

    // 3. In-place write
    store.setWritePolicy(repo, { isolation: "in-place" });
    await manager!.startWorker("cmd-inplace", startArgs({ workerId: "w-inplace", mode: "write" }));
    await waitFor(() => settledOf("w-inplace"), 15_000, "in-place settled");

    expect(existsSync(markerFile)).toBe(false);
    expect(events.some((e) => e.type === "progress" && e.phase === "setup_hook")).toBe(false);
  }, 45_000);

  it("aborts launch, removes the freshly created empty worktree, marks broken, and returns setup_hook_failed on unapproved, mutated, failing, or timed-out setup hooks", async () => {
    registerGitRepo();
    const agentSpawnLog = join(dir, "pi-spawns.jsonl");
    const scenario = writeScenario(dir, "scenario-never", [reportRun({ status: "done", summary: "should not run" })]);
    manager = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario, { FAKE_PI_ARGV_LOG: agentSpawnLog }),
      hooks: { timeoutMs: 10_000 },
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });

    const assertNoOrphanWorktrees = () => {
      const root = join(stateDir, "worktrees");
      const entries = existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]) : [];
      expect(entries.filter((entry) => entry === ".git" || entry.endsWith("/.git"))).toHaveLength(0);
    };

    // Case 1: Unapproved setup hook
    const scriptPath = writeHookScript("setup.sh", "#!/bin/sh\nexit 0\n");
    store.setRepoHooks(repo, { setupHook: "setup.sh" });
    await expect(manager.startWorker("cmd-unap", startArgs({ workerId: "w-unap" }))).rejects.toMatchObject({
      code: "setup_hook_failed",
    });
    expect(store.getWorker("w-unap")).toMatchObject({ state: "broken", lastOutcome: "setup_hook_failed", worktree: null });
    assertNoOrphanWorktrees();

    // Case 2: Approved, then mutated 1 byte on disk (SHA-256 mismatch)
    configureAndApproveHooks({ setupHook: "setup.sh" });
    writeFileSync(scriptPath, "#!/bin/sh\necho tampered\nexit 0\n", "utf8");
    await expect(manager.startWorker("cmd-tamper", startArgs({ workerId: "w-tamper" }))).rejects.toMatchObject({
      code: "setup_hook_failed",
    });
    expect(store.getWorker("w-tamper")).toMatchObject({ state: "broken", lastOutcome: "setup_hook_failed", worktree: null });
    assertNoOrphanWorktrees();

    // Case 3: Approved non-zero exit
    writeHookScript("setup.sh", "#!/bin/sh\necho 'missing pnpm lockfile' >&2\nexit 12\n");
    configureAndApproveHooks({ setupHook: "setup.sh" });
    await expect(manager.startWorker("cmd-exit12", startArgs({ workerId: "w-exit12" }))).rejects.toMatchObject({
      code: "setup_hook_failed",
      message: expect.stringContaining("missing pnpm lockfile"),
    });
    expect(store.getWorker("w-exit12")).toMatchObject({ state: "broken", lastOutcome: "setup_hook_failed", worktree: null });
    assertNoOrphanWorktrees();

    // Case 4: Approved hook exceeding hard timeout (spawns a child `sleep 30` to test tree kill & pipe destroy)
    manager.stop();
    manager = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario, { FAKE_PI_ARGV_LOG: agentSpawnLog }),
      hooks: { timeoutMs: 300 },
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });
    writeHookScript("setup.sh", "#!/bin/sh\nsleep 30\n");
    configureAndApproveHooks({ setupHook: "setup.sh" });
    const t0 = Date.now();
    await expect(manager.startWorker("cmd-timeout", startArgs({ workerId: "w-timeout" }))).rejects.toMatchObject({
      code: "setup_hook_failed",
      message: expect.stringMatching(/timed out/i),
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(store.getWorker("w-timeout")).toMatchObject({ state: "broken", lastOutcome: "setup_hook_failed", worktree: null });
    assertNoOrphanWorktrees();

    // Coding agent never spawned once across all four fail-closed cases!
    expect(existsSync(agentSpawnLog)).toBe(false);
  }, 30_000);

  it("enforces archive hook ordering on cleanup_worktree: skips on dirty worktree, preserves worktree on archive_hook_failed, and removes after clean success", async () => {
    registerGitRepo();
    const archiveTrace = join(dir, "archive-trace.log");
    writeHookScript("archive.sh", `#!/bin/sh\npwd >> "${archiveTrace}"\nexit 0\n`);
    configureAndApproveHooks({ archiveHook: "archive.sh" });

    setupManager([
      reportRun(
        { status: "done", summary: "dirty work" },
        { shellBefore: "echo uncommitted > dirty.txt" },
      ),
    ]);

    const workerId = "w-archive-flow";
    const result = await manager!.startWorker("cmd-arch-1", startArgs({ workerId }));
    await waitFor(() => settledOf(workerId), 15_000, "worker settled");
    await manager!.stopProcess(workerId);
    await waitFor(() => !existsSync(lockPath(stateDir, workerId)), 10_000, "lock released");
    const worktree = result.worktree!;

    // 1. Dirty worktree without force -> fails with `worktree_dirty` BEFORE archive hook runs.
    await expect(manager!.cleanupWorktree(workerId, false)).rejects.toMatchObject({ code: "worktree_dirty" });
    expect(existsSync(archiveTrace)).toBe(false);
    expect(existsSync(worktree)).toBe(true);

    // Clean & push the worktree so non-force cleanup passes the git check.
    rmSync(join(worktree, "dirty.txt"));
    const head = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["update-ref", "refs/remotes/origin/otto-archive-flow", head]);

    // 2. Replace archive hook with a failing script and re-approve -> fails with `archive_hook_failed`
    //    and PRESERVES the worktree directory + worker DB pointer as evidence!
    writeHookScript("archive.sh", "#!/bin/sh\necho 'artifact upload failed' >&2\nexit 5\n");
    configureAndApproveHooks({ archiveHook: "archive.sh" });
    await expect(manager!.cleanupWorktree(workerId, false)).rejects.toMatchObject({
      code: "archive_hook_failed",
      message: expect.stringContaining("artifact upload failed"),
    });
    expect(existsSync(worktree)).toBe(true);
    expect(store.getWorker(workerId)?.worktree).toBe(worktree);

    // 3. Restore working archive hook and re-approve -> runs archive in worktree, then removes directory.
    writeHookScript("archive.sh", `#!/bin/sh\npwd >> "${archiveTrace}"\nexit 0\n`);
    configureAndApproveHooks({ archiveHook: "archive.sh" });
    const cleaned = await manager!.cleanupWorktree(workerId, false);
    expect(cleaned.removed).toBe(worktree);
    expect(existsSync(worktree)).toBe(false);
    expect(store.getWorker(workerId)?.worktree).toBeNull();
    expect(readFileSync(archiveTrace, "utf8").trim()).toContain("hook-thread-1");
  }, 45_000);
});
