// Stage 2 Contract Tests:
// 1. Generic `AcpAdapter` (`opencode`, `agentica`):
//    - `session/load` ignoring replayed historical `session/update` notifications before `window.open`
//    - `-32000` `thread_active_writer` mapped to retriable `AdapterError("session_in_use", ..., true)`
//    - `session/request_permission` worktree `realpath` confinement (`allow_once` inside worktree vs `reject_once` outside / symlink escape / readonly write)
// 2. `CommandAdapter` (`dsh` 0.2.2+ & `zcode` + local allowlist):
//    - Single-pass callback placeholder substitution (`$&` literal preservation + zero recursive `{cwd}` expansion)
//    - `dsh` multi-step `step_end` token (`input` + `cacheRead` + `output`) & USD cost accumulation + `sessionID` continuation
//    - `LocalStore` local-only allowlist persistence
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  substituteCommandArgv,
} from "../src/command-adapter.ts";
import type { RawAdapterEvent } from "../src/agent.ts";
import { LocalStore } from "../src/store.ts";

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
  it("substitutes placeholders in a single callback pass without `$&` corruption or recursive `{cwd}` expansion", () => {
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
  });

  it("accumulates `dsh` 0.2.2+ `step_end` tokens & USD cost, captures `sessionID`, and continues via `--session`", async () => {
    const scenario1 = join(rootDir, "dsh-1.json");
    const cmdLog = join(rootDir, "dsh.log");
    writeFileSync(
      scenario1,
      JSON.stringify({
        lines: [
          { type: "step_start", sessionID: "dsh_ses_900" },
          {
            type: "tool_call",
            sessionID: "dsh_ses_900",
            tool: "read_file",
            input: { path: "src/app.ts" },
          },
          {
            type: "step_end",
            sessionID: "dsh_ses_900",
            part: {
              tokens: { input: 300, cacheRead: 700, output: 120, reasoning: 30 },
              cost: 0.0012,
              contextWindow: 128000,
            },
          },
          {
            type: "step_end",
            sessionID: "dsh_ses_900",
            part: {
              tokens: { input: 200, cacheRead: 800, output: 100 },
              cost: 0.0015,
              contextWindow: 128000,
            },
          },
          { type: "text", sessionID: "dsh_ses_900", text: "Completed two steps." },
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

    const events: RawAdapterEvent[] = [];
    adapter.on("worker-event", (e) => events.push(e));

    await adapter.start({
      workerId: "w-dsh-1",
      threadId: "t-dsh",
      cwd: worktreeDir,
      mode: "readonly",
      model: "deepseek-chat",
      prompt: "Audit src/app.ts with $& pattern",
      commandId: "cmd-dsh-1",
    });

    await viWaitFor(() => events.some((e) => e.type === "settled"));
    const settled1 = events.find((e) => e.type === "settled");
    expect(settled1).toMatchObject({
      outcome: "reported",
      report: { status: "done", summary: "DSH completed multi-step analysis" },
      usage: {
        tokens: {
          // (300+700) + (200+800) = 2000 input (1500 cached), (120+30) + 100 = 250 output
          input: 2000,
          output: 250,
          totalTokens: 2250,
          cachedInputTokens: 1500,
        },
        cost: 0.0027,
      },
    });

    // Follow-up `send` uses captured `dsh_ses_900` via `--session dsh_ses_900`!
    events.length = 0;
    await adapter.send("w-dsh-1", { text: "Check one more file", commandId: "cmd-dsh-2" }, "prompt");
    await viWaitFor(() => events.some((e) => e.type === "settled"));

    const invocations = readFileSync(cmdLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; hasOttoToken: boolean });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.hasOttoToken).toBe(false);
    expect(invocations[0]!.argv).toContain("--readonly");
    expect(invocations[0]!.argv).toContain("deepseek-chat");
    expect(invocations[1]!.argv).toContain("--session");
    expect(invocations[1]!.argv).toContain("dsh_ses_900");
  });

  it("persists local-only CommandAdapter allowlist in LocalStore and parses `zcode` JSON output", async () => {
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    store.setCommandAdapterConfig("zcode", {
      enabled: true,
      command: [process.execPath, FAKE_CMD],
    });
    expect(store.getCommandAdaptersConfig().zcode?.enabled).toBe(true);
    store.close();

    const scenarioZcode = join(rootDir, "zcode.json");
    writeFileSync(
      scenarioZcode,
      JSON.stringify({
        lines: [
          {
            session_id: "zc_77",
            result: "Done!",
            otto_report: { status: "done", summary: "ZCode task finished" },
            usage: { input_tokens: 450, output_tokens: 90 },
            cost_usd: 0.004,
          },
        ],
      }),
    );

    const adapter = new CommandAdapter({
      stateDir,
      preset: buildZcodePreset([process.execPath, FAKE_CMD]),
      env: { FAKE_CMD_SCENARIO: scenarioZcode },
    });
    const events: RawAdapterEvent[] = [];
    adapter.on("worker-event", (e) => events.push(e));
    await adapter.start({
      workerId: "w-zc-1",
      threadId: "t-zc",
      cwd: worktreeDir,
      mode: "write",
      prompt: "Run zcode",
      commandId: "cmd-zc-1",
    });
    await viWaitFor(() => events.some((e) => e.type === "settled"));
    expect(events.find((e) => e.type === "settled")).toMatchObject({
      outcome: "reported",
      report: { status: "done", summary: "ZCode task finished" },
      usage: { tokens: { input: 450, output: 90, totalTokens: 540 }, cost: 0.004 },
    });
  });
});

async function viWaitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
