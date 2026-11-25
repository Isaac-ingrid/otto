// Stage 1 agent-autoloop adoption contract tests across PiAdapter, ClaudeAdapter,
// CodexAdapter, LocalStore, and WorkerManager — 100% offline via fake-pi / fake-claude / fake-codex.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawAdapterEvent, StartSpec } from "../src/agent.ts";
import { ClaudeAdapter, claudeSessionId, probeClaudeAuthStatus } from "../src/claude-adapter.ts";
import {
  CodexAdapter,
  detectCodex,
  grantWindowsCodexSandboxReadAcl,
  MACOS_CODEX_APP_PATHS,
  probeCodexAuthStatus,
  resolveDefaultCodexCommand,
} from "../src/codex-adapter.ts";
import { EventLog } from "../src/events.ts";
import { childEnv, PiAdapter } from "../src/pi-adapter.ts";
import { LocalStore } from "../src/store.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
  claudeAssistantText,
  claudeToolUse,
  fakePiAdapter,
  makeGitRepo,
  tmpDir,
  waitFor,
  writeClaudeScenario,
  writeScenario,
} from "./helpers.ts";

let dir: string;
let stateDir: string;

beforeEach(() => {
  dir = tmpDir("otto-autoloop-s1");
  stateDir = join(dir, "state");
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function readJsonLines<T = Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

describe("childEnv sanitization", () => {
  it("strips OTTO_*, CLAUDE_CODE_*, and CLAUDECODE from inherited environment", () => {
    const cleaned = childEnv(
      {
        PATH: "/usr/bin",
        OTTO_HOME: "/secret/otto",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_SSE_PORT: "9999",
        CLAUDECODE: "1",
        DEEPSEEK_API_KEY: "sk-keep",
      },
      { CUSTOM_TEST: "ok" },
    );
    expect(cleaned.PATH).toBe("/usr/bin");
    expect(cleaned.DEEPSEEK_API_KEY).toBe("sk-keep");
    expect(cleaned.CUSTOM_TEST).toBe("ok");
    expect(cleaned.OTTO_HOME).toBeUndefined();
    expect(cleaned.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(cleaned.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(cleaned.CLAUDECODE).toBeUndefined();
  });
});

describe("PiAdapter single-pass report-only rewrite & guardrail", () => {
  it("recovers a missing report via one live RPC rewrite pass when the run executed tools", async () => {
    const promptLog = join(dir, "pi-prompts.log");
    const scenario = writeScenario(dir, "pi-rewrite-ok", [
      // Run 0: ran Bash, wrote plain text, forgot `report`.
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "turn_start" } },
        { emit: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "pnpm test" } } },
        { emit: { type: "tool_execution_end", toolCallId: "t1", toolName: "bash" } },
        { emit: { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Tests passed." }] } } },
        { emit: { type: "agent_settled", aborted: false } },
      ],
      // Run 1 (rewrite pass): calls `report` and settles cleanly.
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "tool_execution_start", toolCallId: "t2", toolName: "report", args: { status: "done", summary: "Recovered via rewrite pass" } } },
        { emit: { type: "tool_execution_end", toolCallId: "t2", toolName: "report" } },
        { emit: { type: "agent_settled", aborted: false } },
      ],
    ]);

    const events: RawAdapterEvent[] = [];
    let promptAccepted = false;
    const adapter = new PiAdapter({
      stateDir,
      command: [process.execPath, join(import.meta.dirname, "fake-pi.mjs")],
      env: { FAKE_PI_SCRIPT: scenario, FAKE_PI_LOG: promptLog, FAKE_PI_SESSIONS_DIR: join(dir, "sessions") },
    });
    adapter.on("worker-event", (e) => events.push(e));

    await adapter.start({
      workerId: "w-pi-rw1",
      threadId: "t-1",
      cwd: dir,
      mode: "write",
      prompt: "Run tests and fix",
      commandId: "cmd-pi-1",
      onPromptAccepted: () => {
        promptAccepted = true;
      },
    });
    expect(promptAccepted).toBe(true);

    await waitFor(() => events.find((e) => e.type === "settled"), 10_000, "pi rewrite settle");
    const settled = events.filter((e) => e.type === "settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      outcome: "reported",
      report: { status: "done", summary: "Recovered via rewrite pass" },
    });
    const prompts = readJsonLines<{ text: string }>(promptLog).filter((p) => typeof p.text === "string");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.text).toContain("without calling the `report` tool");
    await adapter.stopProcess("w-pi-rw1");
  });

  it("aborts immediately if the rewrite pass tries to invoke a non-report tool and preserves original lastText", async () => {
    const scenario = writeScenario(dir, "pi-rewrite-guard", [
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { path: "a.ts" } } },
        { emit: { type: "tool_execution_end", toolCallId: "t1", toolName: "edit" } },
        { emit: { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Original summary text" }] } } },
        { emit: { type: "agent_settled", aborted: false } },
      ],
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "rm -rf /" } } },
        { delayMs: 200 },
        { emit: { type: "agent_settled", aborted: false } },
      ],
    ]);

    const events: RawAdapterEvent[] = [];
    const adapter = new PiAdapter({
      stateDir,
      command: [process.execPath, join(import.meta.dirname, "fake-pi.mjs")],
      env: { FAKE_PI_SCRIPT: scenario, FAKE_PI_SESSIONS_DIR: join(dir, "sessions") },
    });
    adapter.on("worker-event", (e) => events.push(e));

    await adapter.start({
      workerId: "w-pi-rw2",
      threadId: "t-1",
      cwd: dir,
      mode: "write",
      prompt: "Edit a.ts",
      commandId: "cmd-pi-2",
    });

    await waitFor(() => events.find((e) => e.type === "settled"), 10_000, "pi guardrail settle");
    const settled = events.find((e) => e.type === "settled")!;
    expect(settled).toMatchObject({
      outcome: "unreported",
      lastText: "Original summary text",
    });
    await adapter.stopProcess("w-pi-rw2");
  });
});

describe("ClaudeAdapter Stage 1 refinements", () => {
  it("counts cache_read_input_tokens + cache_creation_input_tokens in settled usage.tokens.input, captures rate_limit_event, and recovers omitted report via --resume plan pass", async () => {
    const argvLog = join(dir, "claude-s1-argv.log");
    const resetSec = Math.floor((Date.now() + 90 * 60_000) / 1000);
    const scenario = writeClaudeScenario(dir, "claude-s1", [
      // Run 0 (worker 1): tool work without report -> triggers Run 1 (--resume plan report-only).
      [
        { emit: claudeToolUse("Edit", { file_path: "src/app.ts" }) },
        { emit: claudeAssistantText("Edited src/app.ts, all done.") },
        {
          result: {
            usage: {
              input_tokens: 200,
              cache_read_input_tokens: 1500,
              cache_creation_input_tokens: 300,
              output_tokens: 80,
            },
            total_cost_usd: 0.015,
          },
        },
      ],
      // Run 1 (worker 1 rewrite pass): calls mcp__otto__report.
      [
        {
          emit: claudeToolUse("mcp__otto__report", {
            status: "done",
            summary: "Claude recovered report",
          }),
        },
        {
          result: {
            usage: {
              input_tokens: 50,
              cache_read_input_tokens: 1800,
              output_tokens: 40,
            },
            total_cost_usd: 0.005,
          },
        },
      ],
      // Run 2 (worker 2): emits rate_limit_event + error result.
      [
        { emit: { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: resetSec } } },
        { result: { subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached" } },
      ],
    ] as never);

    const events: RawAdapterEvent[] = [];
    const adapter = new ClaudeAdapter({
      stateDir,
      command: [process.execPath, join(import.meta.dirname, "fake-claude.mjs")],
      env: { FAKE_CLAUDE_SCRIPT: scenario, FAKE_CLAUDE_ARGV_LOG: argvLog },
      initTimeoutMs: 10_000,
    });
    adapter.on("worker-event", (e) => events.push(e));

    const spec = (workerId: string, mode: "write" | "readonly" = "write"): StartSpec => ({
      workerId,
      threadId: "t-claude",
      cwd: dir,
      mode,
      prompt: "Update src/app.ts",
      commandId: `cmd-${workerId}`,
    });

    await adapter.start(spec("w-claude-rw"));
    await waitFor(
      () => events.find((e) => e.type === "settled" && e.workerId === "w-claude-rw"),
      15_000,
      "claude rewrite settle",
    );
    const rwSettled = events.find((e) => e.type === "settled" && e.workerId === "w-claude-rw")!;
    expect(rwSettled).toMatchObject({
      outcome: "reported",
      report: { status: "done", summary: "Claude recovered report" },
      usage: {
        // (200 + 1500 + 300) + (50 + 1800) = 3850 input, 80 + 40 = 120 output, cached = 3600
        tokens: { input: 3850, output: 120, totalTokens: 3970, cachedInputTokens: 3600 },
        cost: 0.02,
      },
    });
    const argvs = readJsonLines<string[]>(argvLog);
    expect(argvs[1]).toContain("--resume");
    expect(argvs[1]).toContain("--permission-mode");
    expect(argvs[1]).toContain("plan");
    expect(argvs[1]).not.toContain("--dangerously-skip-permissions");

    // Rate-limit event extraction:
    await adapter.start(spec("w-claude-rl", "readonly"));
    await waitFor(
      () => events.find((e) => e.type === "settled" && e.workerId === "w-claude-rl"),
      15_000,
      "claude rate limit settle",
    );
    const rlSettled = events.find((e) => e.type === "settled" && e.workerId === "w-claude-rl")!;
    expect(rlSettled).toMatchObject({
      outcome: "error",
      errorClass: "rate_limited",
      limitedUntil: resetSec * 1000,
    });

    expect(
      probeClaudeAuthStatus([process.execPath, join(import.meta.dirname, "fake-claude.mjs")]),
    ).toBe("ready");
  });
});

describe("CodexAdapter Stage 1 refinements", () => {
  it("clears transient mid-turn error on turn.completed, recovers omitted report via exec resume, and passes reasoningEffort + serviceTier", async () => {
    const argvLog = join(dir, "codex-s1-argv.log");
    const scenarioPath = join(dir, "codex-s1.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        runs: [
          // Run 0: emits transient `error`, then executes Bash (`hadWork=true`) and completes without report!
          [
            { emit: { type: "error", message: "stream hiccup that recovered" } },
            { emit: { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", status: "completed" } } },
            { emit: { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Tests green, forgot report." } } },
          ],
          // Run 1 (rewrite pass via `exec resume` in read-only): calls otto report!
          [
            {
              emit: {
                type: "item.completed",
                item: {
                  id: "r1",
                  type: "mcp_tool_call",
                  server: "otto",
                  tool: "report",
                  status: "completed",
                  arguments: { status: "done", summary: "Codex recovered report after transient stream error" },
                },
              },
            },
          ],
        ],
      }),
    );

    const events: RawAdapterEvent[] = [];
    let accepted = false;
    const adapter = new CodexAdapter({
      stateDir,
      command: [process.execPath, join(import.meta.dirname, "fake-codex.mjs")],
      env: { FAKE_CODEX_SCRIPT: scenarioPath, FAKE_CODEX_ARGV_LOG: argvLog, CODEX_HOME: join(dir, "codex-home") },
      reasoningEffort: "high",
      serviceTier: "fast",
      initTimeoutMs: 10_000,
    });
    adapter.on("worker-event", (e) => events.push(e));

    await adapter.start({
      workerId: "w-codex-s1",
      threadId: "t-codex",
      cwd: dir,
      mode: "write",
      prompt: "Fix & test",
      commandId: "cmd-codex-s1",
      onPromptAccepted: () => {
        accepted = true;
      },
    });

    await waitFor(() => events.find((e) => e.type === "settled"), 15_000, "codex settle");
    expect(accepted).toBe(true);
    const settled = events.filter((e) => e.type === "settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      outcome: "reported",
      report: { status: "done", summary: "Codex recovered report after transient stream error" },
    });

    const argvs = readJsonLines<string[]>(argvLog);
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).toContain('model_reasoning_effort="high"');
    expect(argvs[0]).toContain('service_tier="fast"');
    expect(argvs[1]!.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(argvs[1]).toContain('sandbox_mode="read-only"');
  });

  it("settles error when mid-turn error is followed by process exit without turn.completed", async () => {
    const scenarioPath = join(dir, "codex-err-exit.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        runs: [
          [
            { emit: { type: "error", message: "Codex error: The usage limit has been reached" } },
            { exit: 1 },
          ],
        ],
      }),
    );
    const events: RawAdapterEvent[] = [];
    const adapter = new CodexAdapter({
      stateDir,
      command: [process.execPath, join(import.meta.dirname, "fake-codex.mjs")],
      env: { FAKE_CODEX_SCRIPT: scenarioPath, CODEX_HOME: join(dir, "codex-home-2") },
      initTimeoutMs: 10_000,
    });
    adapter.on("worker-event", (e) => events.push(e));

    await adapter.start({
      workerId: "w-codex-exit-err",
      threadId: "t-codex",
      cwd: dir,
      mode: "write",
      prompt: "Run",
      commandId: "cmd-codex-exit",
    });
    await waitFor(() => events.find((e) => e.type === "settled"), 10_000, "codex exit error settle");
    expect(events.find((e) => e.type === "settled")).toMatchObject({
      outcome: "error",
      errorClass: "rate_limited",
    });
    const procExit = events.find((e) => e.type === "process_exit") as { unexpected: boolean } | undefined;
    expect(procExit?.unexpected).toBe(false);
  });

  it("supports macOS desktop binary fallback, Windows CodexSandboxUsers ACL helper, and login status preflight", () => {
    expect(
      resolveDefaultCodexCommand({
        env: {},
        platform: "darwin",
        pathProbeFn: () => false,
        existsFn: (p) => p === MACOS_CODEX_APP_PATHS[1],
      }),
    ).toEqual([MACOS_CODEX_APP_PATHS[1]]);

    const aclCalls: string[][] = [];
    expect(
      grantWindowsCodexSandboxReadAcl("C:\\temp\\codex-img", "win32", ((file: string, args: string[]) => {
        aclCalls.push([file, ...args]);
        return { status: 0 };
      }) as never),
    ).toBe(true);
    expect(aclCalls[0]).toEqual(["icacls", "C:\\temp\\codex-img", "/grant", "CodexSandboxUsers:(OI)(CI)(RX)"]);
    expect(grantWindowsCodexSandboxReadAcl("/tmp/codex-img", "darwin")).toBe(false);

    const fakeCmd = [process.execPath, join(import.meta.dirname, "fake-codex.mjs")];
    expect(detectCodex(fakeCmd)).toMatchObject({
      installed: true,
      version: "codex-cli 0.170.0",
      authStatus: "ready",
    });
    expect(
      probeCodexAuthStatus(fakeCmd, 3000, ((file: string, args: string[], opts: Record<string, unknown>) => {
        expect(args.slice(-2)).toEqual(["login", "status"]);
        expect(file).toBe(process.execPath);
        void opts;
        return { status: 1, stdout: "Not logged in\n", stderr: "" };
      }) as never),
    ).toBe("unauthenticated");
  });
});

describe("WorkerManager promptAccepted & rate_limited reconciliation", () => {
  it("breaks unaccepted startup crashes cleanly while keeping rate_limited workers idle without burning auto-resume", async () => {
    const repo = await makeGitRepo(dir);
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    const eventLog = new EventLog(store.database);
    const emitted: Array<Record<string, unknown>> = [];
    store.addRepo({
      repoId: repo,
      name: "repo-s1",
      path: repo,
      capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null },
    });

    // Seed a worker row that had a pre-assigned sessionId but NEVER accepted a prompt (promptAccepted = 0).
    store.upsertWorker({
      workerId: "w-unaccepted",
      threadId: "t-crash",
      repoId: repo,
      agent: "claude-code",
      mode: "write",
      state: "starting",
      sessionId: claudeSessionId("w-unaccepted"),
    });

    const resetAt = Date.now() + 2 * 3_600_000;
    const piScenario = writeScenario(dir, "pi-rl", [
      [
        { emit: { type: "agent_start" } },
        {
          emit: {
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: `usage_limit_reached: Coding Plan 5-hour limit reached, resets at ${new Date(resetAt).toISOString()}`,
              content: [],
            },
          },
        },
        { emit: { type: "agent_settled", aborted: false } },
      ],
    ]);

    const manager = new WorkerManager({
      store,
      stateDir,
      adapters: [fakePiAdapter(stateDir, piScenario)],
      recovery: { autoResumeBackoffMs: 100 },
      emit: (workerId, fields) => {
        const saved = eventLog.append(workerId, fields);
        emitted.push(JSON.parse(saved.payload) as Record<string, unknown>);
      },
    });

    await manager.reconcileStartup();
    expect(store.getWorker("w-unaccepted")).toMatchObject({
      state: "broken",
      lastOutcome: "startup_interrupted",
    });

    await manager.handleCommand("cmd-rl", "start_worker", {
      workerId: "w-pi-rl",
      threadId: "t-rl",
      repoId: repo,
      mode: "write",
      prompt: "Implement feature",
    });
    await waitFor(
      () => emitted.find((e) => e.workerId === "w-pi-rl" && e.type === "settled"),
      10_000,
      "pi rate_limited settle",
    );

    // Wait > autoResumeBackoffMs (100ms) to prove rate_limited NEVER triggers local 30s auto-resume!
    await new Promise((r) => setTimeout(r, 250));
    expect(store.getWorker("w-pi-rl")).toMatchObject({
      state: "idle",
      lastOutcome: "error:rate_limited",
      promptAccepted: 1,
    });
    expect(store.countResumes("w-pi-rl")).toBe(0);
    const settledEvt = emitted.find((e) => e.workerId === "w-pi-rl" && e.type === "settled")!;
    expect(settledEvt).toMatchObject({
      outcome: "error",
      errorClass: "rate_limited",
      limitedUntil: Math.floor(resetAt / 1000) * 1000 === resetAt ? resetAt : Date.parse(new Date(resetAt).toISOString()),
    });

    await manager.stopProcess("w-pi-rl").catch(() => undefined);
    manager.stop();
    store.close();
  });
});
