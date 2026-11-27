// Stage 2 Contract Tests:
// 1. Generic `AcpAdapter` (`opencode`, `agentica`):
//    - `session/load` ignoring replayed historical `session/update` notifications before `window.open`
//    - `-32000` `thread_active_writer` mapped to retriable `AdapterError("session_in_use", ..., true)`
//    - `session/request_permission` worktree `realpath` confinement (`allow_once` inside worktree vs `reject_once` outside / symlink escape / readonly write)
// 2. `CommandAdapter` (`dsh` 0.2.2+ & `zcode` + local allowlist):
//    - Single-pass callback placeholder substitution (`$&` literal preservation + zero recursive `{cwd}` expansion)
//    - `dsh` 0.2.2+ official `headless --json` CLI flags (`--permission-mode`, `--approval-policy never`, worktree `--add-dir <git-common-dir>`, zero `--model`), opening `session` identity capture, `step_end` token-only accumulation (`inputTokens` + `cacheReadTokens` + `cacheWriteTokens`, no fabricated USD cost), `final` completion/error adjudication (`RATE_LIMIT`), and `--session-id` continuation
//    - `zcode` official `-p ... --mode edit|plan --json` CLI flags, `.cjs` script `process.execPath` prefixing, `response` + `sessionId` (`sess_...`) + `usage` extraction, and `WorkerManager` cold `send` `--resume` persistence
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AcpAdapter,
  detectOpenCode,
  isPathInsideWorktree,
} from "../src/acp-adapter.ts";
import {
  buildDshPreset,
  buildZcodePreset,
  CommandAdapter,
  normalizeCommandExecutable,
  presetFromStoredConfig,
  resolveWorktreeGitCommonDir,
  substituteCommandArgv,
} from "../src/command-adapter.ts";
import type { RawAdapterEvent } from "../src/agent.ts";
import { EventLog } from "../src/events.ts";
import { LocalStore } from "../src/store.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { git, makeGitRepo } from "./helpers.ts";

const FAKE_ACP = join(import.meta.dirname, "fake-acp.mjs");
const FAKE_CMD = join(import.meta.dirname, "fake-command.mjs");

let rootDir: string;
let stateDir: string;
let worktreeDir: string;
let outsideDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "otto-stage2-"));
  stateDir = join(rootDir, "state");
  worktreeDir = join(rootDir, "worktree");
  outsideDir = join(rootDir, "outside");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("Stage 2 — Generic AcpAdapter (`opencode`, `agentica`)", () => {
  it("ignores replayed history during `session/load`, enforces worktree `realpath` permission confinement (`allow_once` vs `reject_once`), and settles with report", async () => {
    // Create a symlink inside worktree pointing outside to verify `realpathSync` confinement!
    writeFileSync(join(outsideDir, "secret.txt"), "top-secret");
    symlinkSync(outsideDir, join(worktreeDir, "escaped-link"));
    expect(isPathInsideWorktree(join(worktreeDir, "src", "new-file.ts"), worktreeDir)).toBe(true);
    expect(isPathInsideWorktree(join(worktreeDir, "escaped-link", "secret.txt"), worktreeDir)).toBe(false);
    expect(isPathInsideWorktree(join(outsideDir, "secret.txt"), worktreeDir)).toBe(false);

    const scenarioPath = join(rootDir, "acp-scenario.json");
    const logPath = join(rootDir, "acp.log");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        supportResume: false,
        loadSession: true,
        replayHistoryDuringLoad: [
          {
            sessionUpdate: "tool_call",
            toolCallId: "old_tc_1",
            name: "mcp__otto__report",
            rawInput: { status: "blocked", summary: "STALE REPLAYED REPORT MUST BE IGNORED" },
            status: "completed",
          },
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "old_msg",
            content: { type: "text", text: "STALE HISTORY CHUNK " },
          },
        ],
        permissionChecks: [
          {
            toolCall: {
              name: "edit_file",
              kind: "edit",
              locations: [{ path: join(worktreeDir, "src", "index.ts") }],
            },
          },
          {
            toolCall: {
              name: "edit_file",
              kind: "edit",
              locations: [{ path: join(worktreeDir, "escaped-link", "secret.txt") }],
            },
          },
        ],
        assistantText: "Fresh turn output",
        report: { status: "done", summary: "OpenCode ACP turn completed cleanly" },
      }),
    );

    const detected = detectOpenCode([process.execPath, FAKE_ACP]);
    expect(detected.installed).toBe(true);
    expect(detected.version).toContain("opencode");

    const adapter = new AcpAdapter({
      kind: "opencode",
      stateDir,
      command: [process.execPath, FAKE_ACP],
      env: { FAKE_ACP_SCENARIO: scenarioPath, FAKE_ACP_LOG: logPath },
    });

    const events: RawAdapterEvent[] = [];
    adapter.on("worker-event", (e) => events.push(e));

    let promptAccepted = false;
    const handle = await adapter.start({
      workerId: "w-acp-1",
      threadId: "t-1",
      cwd: worktreeDir,
      mode: "write",
      prompt: "Continue work",
      commandId: "cmd-1",
      resumeSessionId: "ses_existing_42",
      onPromptAccepted: () => {
        promptAccepted = true;
      },
    });
    expect(handle.sessionId).toBe("ses_existing_42");
    expect(promptAccepted).toBe(true);

    await viWaitFor(() => events.some((e) => e.type === "settled"));
    await adapter.stopProcess("w-acp-1");

    const settled = events.find((e) => e.type === "settled");
    expect(settled).toMatchObject({
      type: "settled",
      outcome: "reported",
      report: { status: "done", summary: "OpenCode ACP turn completed cleanly" },
      usage: {
        tokens: { input: 200, output: 40, totalTokens: 240, cachedInputTokens: 80 },
      },
    });

    const logs = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const methods = logs
      .filter((l) => l.dir === "in")
      .map((l) => (l.msg as { method?: string }).method)
      .filter(Boolean);
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/resume");

    const permResults = logs.filter((l) => l.dir === "permission_result");
    expect(permResults).toHaveLength(2);
    // 1st tool inside worktree -> `opt_allow_once` (never `opt_allow_always`!)
    expect(permResults[0]!.permOutcome).toEqual({
      outcome: { outcome: "selected", optionId: "opt_allow_once" },
    });
    // 2nd tool escaping worktree via symlink -> `opt_reject_once`!
    expect(permResults[1]!.permOutcome).toEqual({
      outcome: { outcome: "selected", optionId: "opt_reject_once" },
    });
  });

  it("maps ACP -32000 `thread_active_writer` contention to retriable `session_in_use`", async () => {
    const scenarioPath = join(rootDir, "acp-locked.json");
    writeFileSync(scenarioPath, JSON.stringify({ supportResume: true, activeWriterError: true }));

    const adapter = new AcpAdapter({
      kind: "agentica",
      stateDir,
      command: [process.execPath, FAKE_ACP],
      env: { FAKE_ACP_SCENARIO: scenarioPath },
    });

    await expect(
      adapter.start({
        workerId: "w-acp-locked",
        threadId: "t-1",
        cwd: worktreeDir,
        mode: "write",
        prompt: "Resume locked session",
        commandId: "cmd-locked",
        resumeSessionId: "ses_locked",
      }),
    ).rejects.toMatchObject({
      code: "session_in_use",
      retriable: true,
    });
  });
});

describe("Stage 2 — CommandAdapter (`dsh` 0.2.2+, `zcode`, single-pass template & local allowlist)", () => {
  it("substitutes placeholders in a single callback pass without `$&` corruption or recursive `{cwd}` expansion, and prefixes `node` for `.cjs` scripts", () => {
    const trickyPrompt = "Replace foo with $& and $' and keep literal {cwd} untouched";
    const argv = substituteCommandArgv(["run", "--cwd", "{cwd}", "--model", "{model}", "{prompt}"], {
      prompt: trickyPrompt,
      cwd: "/tmp/secret-worktree",
      model: "deepseek-reasoner",
    });
    expect(argv).toEqual([
      "run",
      "--cwd",
      "/tmp/secret-worktree",
      "--model",
      "deepseek-reasoner",
      "Replace foo with $& and $' and keep literal {cwd} untouched",
    ]);

    expect(normalizeCommandExecutable(["C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs"], "/usr/bin/node")).toEqual([
      "/usr/bin/node",
      "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
    ]);
    expect(normalizeCommandExecutable(["dsh"], "/usr/bin/node")).toEqual(["dsh"]);

    // Custom `command` preset with `{model}` advertises launch-time model selection, whereas
    // `dsh` and `zcode` advertise `selection: "none"`.
    const custom = new CommandAdapter({
      stateDir,
      preset: presetFromStoredConfig("command", {
        enabled: true,
        command: ["my-cli"],
        argsTemplate: ["--model", "{model}", "{prompt}"],
      }),
    });
    expect(custom.modelCatalog.capabilities.selection).toBe("launch");
  });

  it("drives `dsh` 0.2.2+ `headless --json`, grants `--add-dir <git-common-dir>` on worktrees, sums `step_end` tokens (no fake cost), and resumes via `--session-id`", async () => {
    // Create a real Git repo + linked worktree to verify zero-subprocess `resolveWorktreeGitCommonDir`.
    const repoPath = await makeGitRepo(rootDir, "dsh-repo");
    const linkedWt = join(rootDir, "dsh-wt");
    await git(repoPath, ["worktree", "add", "-b", "otto/dsh-branch", linkedWt]);
    const expectedCommonGit = realpathSync(join(repoPath, ".git"));
    expect(resolveWorktreeGitCommonDir(linkedWt)).toBe(expectedCommonGit);
    expect(resolveWorktreeGitCommonDir(repoPath)).toBeNull();

    const scenario1 = join(rootDir, "dsh-1.json");
    const cmdLog = join(rootDir, "dsh.log");
    writeFileSync(
      scenario1,
      JSON.stringify({
        lines: [
          { type: "session", sessionId: "session-900-uuid" },
          {
            type: "tool_call",
            name: "read_file",
            arguments: { path: "src/app.ts" },
          },
          {
            type: "step_end",
            usage: {
              inputTokens: 300,
              outputTokens: 150,
              totalTokens: 1200,
              cacheReadTokens: 700,
              cacheWriteTokens: 50,
            },
          },
          {
            type: "step_end",
            usage: {
              inputTokens: 200,
              outputTokens: 100,
              totalTokens: 1100,
              cacheReadTokens: 800,
            },
          },
          { type: "text", text: "Intermediate step note." },
          {
            type: "final",
            sessionId: "session-900-uuid",
            text: "Completed two steps.",
            reason: { kind: "completed" },
          },
        ],
        reportFilePayload: {
          status: "done",
          summary: "DSH completed multi-step analysis",
          answer: "All checks green",
        },
      }),
    );

    const adapter = new CommandAdapter({
      stateDir,
      preset: buildDshPreset([process.execPath, FAKE_CMD]),
      env: { FAKE_CMD_SCENARIO: scenario1, FAKE_CMD_LOG: cmdLog },
    });
    expect(adapter.modelCatalog.capabilities.selection).toBe("none");

    const events: RawAdapterEvent[] = [];
    adapter.on("worker-event", (e) => events.push(e));

    let observedSid: string | null = null;
    let promptAccepted = false;
    await adapter.start({
      workerId: "w-dsh-1",
      threadId: "t-dsh",
      cwd: linkedWt,
      mode: "write",
      prompt: "Implement fix in src/app.ts with $& pattern",
      commandId: "cmd-dsh-1",
      onSessionId: (sid) => {
        observedSid = sid;
      },
      onPromptAccepted: () => {
        promptAccepted = true;
      },
    });

    await viWaitFor(() => events.some((e) => e.type === "settled"));
    expect(observedSid).toBe("session-900-uuid");
    expect(promptAccepted).toBe(true);

    const settled1 = events.find((e) => e.type === "settled");
    expect(settled1).toMatchObject({
      outcome: "reported",
      sessionId: "session-900-uuid",
      report: { status: "done", summary: "DSH completed multi-step analysis" },
      usage: {
        tokens: {
          // Step 1: 300 + 700 + 50 = 1050 input (750 cached), 150 output
          // Step 2: 200 + 800 = 1000 input (800 cached), 100 output
          // Total: 2050 input (1550 cached), 250 output = 2300 totalTokens
          input: 2050,
          output: 250,
          totalTokens: 2300,
          cachedInputTokens: 1550,
        },
      },
    });
    // `dsh` 0.2.2+ reports tokens only — never fabricate a USD `cost` field.
    expect(settled1 && settled1.type === "settled" ? settled1.usage?.cost : undefined).toBeUndefined();

    // Follow-up `send` uses captured `session-900-uuid` via `--session-id session-900-uuid`
    // and repeats `--add-dir <git-common-dir>`!
    events.length = 0;
    await adapter.send("w-dsh-1", { text: "Check one more file", commandId: "cmd-dsh-2" }, "prompt");
    await viWaitFor(() => events.some((e) => e.type === "settled"));

    const invocations = readFileSync(cmdLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; hasOttoToken: boolean });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.hasOttoToken).toBe(false);
    expect(invocations[0]!.argv.slice(0, 8)).toEqual([
      "headless",
      "--json",
      "--permission-mode",
      "workspace-write",
      "--approval-policy",
      "never",
      "--add-dir",
      expectedCommonGit,
    ]);
    expect(invocations[0]!.argv).not.toContain("--model");
    expect(invocations[0]!.argv).not.toContain("--session-id");

    expect(invocations[1]!.argv).toContain("--session-id");
    expect(invocations[1]!.argv).toContain("session-900-uuid");
    expect(invocations[1]!.argv).toContain("--add-dir");
    expect(invocations[1]!.argv).toContain(expectedCommonGit);
  }, 20_000);

  it("classifies `dsh` in-turn `final.reason` `RATE_LIMIT` errors as `rate_limited` and refuses bogus `--session-id` when no `session` event arrived", async () => {
    const scenarioRateLimit = join(rootDir, "dsh-rl.json");
    writeFileSync(
      scenarioRateLimit,
      JSON.stringify({
        lines: [
          { type: "session", sessionId: "session-rl-1" },
          {
            type: "final",
            sessionId: "session-rl-1",
            text: "",
            reason: {
              kind: "error",
              error: {
                code: "RATE_LIMIT",
                message: "429 usage limit reached, resets in 30m",
              },
            },
          },
        ],
        exitCode: 1,
      }),
    );

    const adapter = new CommandAdapter({
      stateDir,
      preset: buildDshPreset([process.execPath, FAKE_CMD]),
      env: { FAKE_CMD_SCENARIO: scenarioRateLimit },
    });
    const events: RawAdapterEvent[] = [];
    adapter.on("worker-event", (e) => events.push(e));
    await adapter.start({
      workerId: "w-dsh-rl",
      threadId: "t-dsh-rl",
      cwd: worktreeDir,
      mode: "readonly",
      prompt: "Audit repo",
      commandId: "cmd-dsh-rl",
    });
    await viWaitFor(() => events.some((e) => e.type === "settled"));
    const settled = events.find((e) => e.type === "settled");
    expect(settled).toMatchObject({
      outcome: "error",
      errorClass: "rate_limited",
      sessionId: "session-rl-1",
    });

    // Pre-session driver error (exits without emitting `session`): `resume()` must reject
    // rather than passing Otto's `w-dsh-nosess` to `dsh --session-id`!
    const scenarioPreFail = join(rootDir, "dsh-prefail.json");
    writeFileSync(
      scenarioPreFail,
      JSON.stringify({
        lines: [{ type: "error", message: "MISSING_CREDENTIAL: no API key" }],
        exitCode: 1,
      }),
    );
    const adapter2 = new CommandAdapter({
      stateDir,
      preset: buildDshPreset([process.execPath, FAKE_CMD]),
      env: { FAKE_CMD_SCENARIO: scenarioPreFail },
    });
    const events2: RawAdapterEvent[] = [];
    adapter2.on("worker-event", (e) => events2.push(e));
    await adapter2.start({
      workerId: "w-dsh-nosess",
      threadId: "t-dsh-nosess",
      cwd: worktreeDir,
      mode: "readonly",
      prompt: "Audit repo",
      commandId: "cmd-dsh-nosess",
    });
    await viWaitFor(() => events2.some((e) => e.type === "settled"));
    await expect(adapter2.resume("w-dsh-nosess", "manual")).rejects.toMatchObject({ code: "not_found" });
  });

  it("persists local-only `zcode` allowlist, passes `-p ... --mode edit|plan --json`, and preserves `sess_...` across `WorkerManager` cold `send`", async () => {
    const repoPath = await makeGitRepo(rootDir, "zc-repo");
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    store.setCommandAdapterConfig("zcode", {
      enabled: true,
      command: [FAKE_CMD], // `.mjs` script — verifies `normalizeCommandExecutable` prepends `process.execPath`!
    });
    expect(store.getCommandAdaptersConfig().zcode?.enabled).toBe(true);
    store.addRepo({
      repoId: repoPath,
      name: "zc-repo",
      path: repoPath,
      capability: { kind: "git", gitRoot: repoPath, defaultBranch: "main", remote: null },
    });

    const scenarioZcode = join(rootDir, "zcode.json");
    const zcLog = join(rootDir, "zcode.log");
    writeFileSync(
      scenarioZcode,
      JSON.stringify({
        rawStdout: JSON.stringify(
          {
            sessionId: "sess_zc_77",
            response: "```json\n{\"otto_report\":{\"status\":\"done\",\"summary\":\"ZCode task finished\"}}\n```",
            usage: { inputTokens: 67500, outputTokens: 900, cacheReadTokens: 42000 },
          },
          null,
          2,
        ),
      }),
    );

    const adapter = new CommandAdapter({
      stateDir,
      preset: buildZcodePreset([FAKE_CMD]),
      env: { FAKE_CMD_SCENARIO: scenarioZcode, FAKE_CMD_LOG: zcLog },
    });
    const eventLog = new EventLog(store.database);
    const managerEvents: Array<Record<string, unknown>> = [];
    const manager = new WorkerManager({
      store,
      stateDir,
      adapters: [adapter],
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        managerEvents.push(JSON.parse(stored.payload) as Record<string, unknown>);
      },
    });

    try {
      await manager.startWorker("cmd-zc-1", {
        workerId: "w-zc-1",
        threadId: "t-zc",
        repoId: repoPath,
        mode: "readonly",
        agent: "zcode",
        prompt: "Review module in plan mode",
      });

      await viWaitFor(() => managerEvents.some((e) => e.type === "settled"));
      expect(managerEvents.find((e) => e.type === "settled")).toMatchObject({
        outcome: "reported",
        usage: {
          tokens: { input: 67500, output: 900, totalTokens: 68400, cachedInputTokens: 42000 },
        },
      });
      // `WorkerManager` persisted `sess_zc_77` into SQLite so cold `send` resumes with `--resume sess_zc_77`!
      expect(store.getWorker("w-zc-1")?.sessionId).toBe("sess_zc_77");

      managerEvents.length = 0;
      await manager.handleCommand("cmd-zc-2", "send", {
        workerId: "w-zc-1",
        text: "Follow-up question in plan mode",
        intent: "auto",
      });
      await viWaitFor(() => managerEvents.some((e) => e.type === "settled"));

      const invocations = readFileSync(zcLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { argv: string[] });
      expect(invocations).toHaveLength(2);
      expect(invocations[0]!.argv[0]).toBe("-p");
      expect(invocations[0]!.argv.slice(2)).toEqual(["--mode", "plan", "--json"]);
      expect(invocations[1]!.argv[0]).toBe("-p");
      expect(invocations[1]!.argv.slice(2)).toEqual(["--mode", "plan", "--resume", "sess_zc_77", "--json"]);
    } finally {
      manager.stop();
      store.close();
    }
  }, 20_000);
});

async function viWaitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
