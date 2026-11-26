// AntigravityAdapter contract tests over ACP v1 (`agy acp`): handshake, MCP `report` server
// injection (both streamed tool_call and real out-of-band report-server.mjs execution),
// auth_required (-32000) recovery with GEMINI_API_KEY and oauth-personal, permission gating
// (`allow_once` preference, readonly defense-in-depth, cancel-on-interrupt), cooperative
// `session/cancel` keeping the session hot, wedged-cancel SIGKILL fallback, `session/load`
// history-replay isolation, `session/resume`, multimodal images, and model observation.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AntigravityAdapter,
  type AntigravityAdapterOptions,
  detectAntigravity,
  isAcpProposalTool,
  isAcpReportTool,
  isolatedAgyGeminiDir,
  mapAcpStopReason,
} from "../src/antigravity-adapter.ts";
import type { RawAdapterEvent, StartSpec } from "../src/agent.ts";
import type { AgentModelObservation } from "@isaac2ingrid/protocol";
import { tmpDir, waitFor } from "./helpers.ts";

let dir: string;
let stateDir: string;
let adapter: AntigravityAdapter;
let events: RawAdapterEvent[];

const RPC_LOG = () => join(dir, "agy-rpc.log");
const ARGV_LOG = () => join(dir, "agy-argv.log");
const FAKE_AGY = () => [process.execPath, join(import.meta.dirname, "fake-agy.mjs")];

beforeEach(() => {
  dir = tmpDir("otto-agy-test");
  stateDir = join(dir, "state");
  events = [];
});

afterEach(async () => {
  await adapter?.stopProcess("w-agy-1").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function setup(
  runs: Array<Array<Record<string, unknown>>>,
  startup?: Record<string, unknown>,
  opts: Partial<AntigravityAdapterOptions> = {},
): void {
  const { env: extraEnv, ...restOpts } = opts;
  const scenarioPath = join(dir, `scenario-${Math.random().toString(36).slice(2, 7)}.agy.json`);
  writeFileSync(scenarioPath, JSON.stringify({ ...(startup ? { startup } : {}), runs }));
  adapter = new AntigravityAdapter({
    stateDir,
    command: FAKE_AGY(),
    initTimeoutMs: 10_000,
    ...restOpts,
    env: {
      FAKE_AGY_SCRIPT: scenarioPath,
      FAKE_AGY_LOG: RPC_LOG(),
      FAKE_AGY_ARGV_LOG: ARGV_LOG(),
      ...(extraEnv ?? {}),
    },
  });
  adapter.on("worker-event", (e) => events.push(e));
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function spec(overrides: Partial<StartSpec> = {}): StartSpec {
  return {
    workerId: "w-agy-1",
    threadId: "t-agy-1",
    cwd: dir,
    mode: "write",
    prompt: "Implement feature X",
    commandId: "cmd-agy-1",
    ...overrides,
  };
}

const settledOf = (workerId = "w-agy-1") =>
  events.filter((e) => e.type === "settled" && e.workerId === workerId) as Array<{
    type: "settled";
    outcome: string;
    errorClass?: string;
    errorMessage?: string;
    lastText?: string;
    report?: Record<string, unknown>;
    usage?: Record<string, unknown>;
  }>;

describe("ACP handshake, systemPrompt negotiation, and MCP report server", () => {
  it("spawns `agy acp`, strips OTTO_* env, passes MCP report server, and settles via real MCP tool execution", async () => {
    process.env.OTTO_TEST_SECRET_LEAK = "must-not-reach-child";
    try {
      setup([
        [
          { thought: "Inspecting repository" },
          {
            callMcpReport: {
              status: "done",
              summary: "Implemented via real MCP server",
              changes: ["src/x.ts"],
              labels: ["needs-human-verify", "unknown-label", "needs-human-verify", "flaky-test", "needs-migration", "scope-creep"],
            },
          },
          { text: "All done." },
        ],
      ]);
      let promptAccepted = 0;
      const handle = await adapter.start(spec({ onPromptAccepted: () => { promptAccepted += 1; } }));
      expect(promptAccepted).toBe(1);
      await waitFor(() => settledOf()[0], 10_000, "settle");

      expect(handle.sessionId).toBe("agy-sess-1");
      const argvs = readJsonLines(ARGV_LOG()) as unknown as string[][];
      expect(argvs[0]!.slice(2)).toEqual([
        "acp",
        "--log-file",
        join(stateDir, "logs", "agy-acp-w-agy-1.log"),
      ]);

      const rpc = readJsonLines(RPC_LOG());
      const initReq = rpc.find((r) => r.method === "initialize")!;
      expect(initReq.envLeak).toEqual([]);
      const newReq = rpc.find((r) => r.method === "session/new")!;
      const params = newReq.params as Record<string, unknown>;
      expect(params.cwd).toBe(dir);
      expect(params.systemPrompt).toMatchObject({ mode: "append" });
      expect(Array.isArray(params.mcpServers)).toBe(true);

      const settled = settledOf()[0]!;
      expect(settled.outcome).toBe("reported");
      expect(settled.report).toMatchObject({
        status: "done",
        summary: "Implemented via real MCP server",
        changes: ["src/x.ts"],
        labels: ["needs-human-verify", "flaky-test", "needs-migration"],
      });
      // Resident ACP process stays hot after turn settlement!
      expect(adapter.isRunning("w-agy-1")).toBe(true);
      expect(adapter.isStreaming("w-agy-1")).toBe(false);
    } finally {
      delete process.env.OTTO_TEST_SECRET_LEAK;
    }
  });

  it("falls back to prepending WORKER_SYSTEM_PROMPT on first prompt when sessionCapabilities.systemPrompt is absent", async () => {
    setup([[{ text: "Answered without report" }]], { systemPrompt: false });
    await adapter.start(spec());
    await waitFor(() => settledOf()[0], 10_000, "settle");

    const rpc = readJsonLines(RPC_LOG());
    const newReq = rpc.find((r) => r.method === "session/new")!;
    expect((newReq.params as Record<string, unknown>).systemPrompt).toBeUndefined();

    const promptReq = rpc.find((r) => r.method === "session/prompt")!;
    const blocks = (promptReq.params as { prompt: Array<{ type: string; text: string }> }).prompt;
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.text).toContain("call the `report` tool");
    expect(blocks[1]!.text).toBe("Implement feature X");
    expect(settledOf()[0]!.outcome).toBe("unreported");
    expect(settledOf()[0]!.lastText).toBe("Answered without report");
  });

  it("matches namespaced MCP report tools and ignores unrelated bare `report` tools", async () => {
    setup([
      [
        {
          toolCall: {
            toolCallId: "c1",
            name: "report",
            title: "Generate coverage report",
            kind: "execute",
            rawInput: { status: "done", summary: "not otto" },
          },
        },
        { text: "Plain text ending." },
      ],
      [
        {
          toolCall: {
            toolCallId: "c2",
            name: "mcp__otto__report",
            title: "Report task status",
            kind: "other",
            rawInput: { status: "needs_decision", summary: "Pick DB", question: "SQLite or Postgres?" },
          },
        },
      ],
    ]);
    await adapter.start(spec());
    await waitFor(() => settledOf()[0], 10_000, "turn 1 settle");
    expect(settledOf()[0]!.outcome).toBe("unreported");
    expect(settledOf()[0]!.lastText).toBe("Plain text ending.");

    // Hot second turn on the same resident process!
    await adapter.send("w-agy-1", { text: "Now report properly" }, "prompt");
    await waitFor(() => settledOf()[1], 10_000, "turn 2 settle");
    expect(settledOf()[1]!.outcome).toBe("reported");
    expect(settledOf()[1]!.report).toMatchObject({
      status: "needs_decision",
      summary: "Pick DB",
      question: "SQLite or Postgres?",
    });

    expect(isAcpReportTool("mcp__otto__report")).toBe(true);
    expect(isAcpReportTool("otto/report")).toBe(true);
    expect(isAcpReportTool("report")).toBe(false);
    expect(isAcpReportTool("report", "otto report tool")).toBe(true);
    expect(isAcpProposalTool("mcp__otto__propose")).toBe(true);
    expect(isAcpProposalTool("otto/propose")).toBe(true);
    expect(isAcpProposalTool("propose")).toBe(false);
    expect(isAcpProposalTool("propose", "otto propose tool")).toBe(true);
    expect(mapAcpStopReason("end_turn")).toBe("stop");
    expect(mapAcpStopReason("max_tokens")).toBe("length");
    expect(mapAcpStopReason("cancelled")).toBe("aborted");
  });

  it("recovers multiple out-of-band MCP propose calls from argv[3] JSONL before settled while preserving argv[2] report JSON", async () => {
    setup([
      [
        {
          callMcpPropose: {
            kind: "readonly_probe",
            targetRepoRef: "shared-contracts",
            prompt: "Check v2 User schema",
            reason: "Need exact field optionality",
            proposalKey: "agy-probe-1",
          },
        },
        {
          callMcpPropose: {
            kind: "readonly_probe",
            targetRepoRef: "auth-service",
            prompt: "Check JWT claims",
            reason: "Need audience claim name",
            proposalKey: "agy-probe-2",
          },
        },
        {
          callMcpReport: {
            status: "done",
            summary: "Finished local changes alongside two readonly probes",
          },
        },
      ],
    ]);
    await adapter.start(spec());
    await waitFor(() => settledOf()[0], 10_000, "settle");

    const proposals = events.filter((e) => e.type === "proposal");
    expect(proposals).toEqual([
      {
        type: "proposal",
        workerId: "w-agy-1",
        proposal: {
          kind: "readonly_probe",
          targetRepoRef: "shared-contracts",
          prompt: "Check v2 User schema",
          reason: "Need exact field optionality",
          proposalKey: "agy-probe-1",
        },
      },
      {
        type: "proposal",
        workerId: "w-agy-1",
        proposal: {
          kind: "readonly_probe",
          targetRepoRef: "auth-service",
          prompt: "Check JWT claims",
          reason: "Need audience claim name",
          proposalKey: "agy-probe-2",
        },
      },
    ]);
    const settledIdx = events.findIndex((e) => e.type === "settled");
    const lastProposalIdx = events.map((e, i) => (e.type === "proposal" ? i : -1)).filter((i) => i >= 0).at(-1)!;
    expect(lastProposalIdx).toBeLessThan(settledIdx);
    expect(settledOf()[0]!.outcome).toBe("reported");
    expect(settledOf()[0]!.report).toMatchObject({
      status: "done",
      summary: "Finished local changes alongside two readonly probes",
    });
  });
});

describe("ACP authentication (-32000 auth_required)", () => {
  it("authenticates automatically with GEMINI_API_KEY when session/new returns -32000", async () => {
    setup([[{ text: "Authenticated with API key" }]], { requireAuth: true }, { env: { GEMINI_API_KEY: "test-key-123" } });
    await adapter.start(spec());
    await waitFor(() => settledOf()[0], 10_000, "settle");

    const rpc = readJsonLines(RPC_LOG());
    const authReq = rpc.find((r) => r.method === "authenticate")!;
    expect(authReq.params).toEqual({
      methodId: "gemini-api-key",
      _meta: { "api-key": "test-key-123" },
    });
    expect(settledOf()[0]!.lastText).toBe("Authenticated with API key");
  });

  it("authenticates with oauth-personal when no GEMINI_API_KEY is set, and fails cleanly on auth rejection", async () => {
    setup([], { requireAuth: true, failAuth: true }, { env: { GEMINI_API_KEY: "" } });
    await expect(adapter.start(spec())).rejects.toMatchObject({ code: "auth_required" });
  });
});

describe("permission prompts, cooperative session/cancel, and wedged fallback", () => {
  it("prefers allow_once over allow_always in write mode so persistent user settings stay untouched", async () => {
    setup([
      [
        {
          requestPermission: {
            toolCall: { toolCallId: "edit-1", title: "Write src/a.ts", kind: "edit", locations: [{ path: `${dir}/src/a.ts` }] },
            options: [
              { optionId: "proceed_always", name: "Allow always", kind: "allow_always" },
              { optionId: "proceed_once", name: "Allow once", kind: "allow_once" },
              { optionId: "cancel", name: "Reject", kind: "reject_once" },
            ],
          },
        },
        {
          elicitation: "Ask interactive form",
        },
        {
          usageUpdate: { used: 12_000, size: 120_000, cost: { amount: 0.025, currency: "USD" } },
        },
        {
          text: "Edited file.",
          usage: { input_tokens: 1000, output_tokens: 250, total_tokens: 1250 },
        },
      ],
    ]);
    await adapter.start(spec());
    await waitFor(() => settledOf()[0], 10_000, "settle");

    const rpc = readJsonLines(RPC_LOG());
    const permOutcome = rpc.find((r) => r.direction === "permission_outcome")!;
    expect(permOutcome.outcome).toEqual({ outcome: "selected", optionId: "proceed_once" });
    const elicOutcome = rpc.find((r) => r.direction === "elicitation_outcome")!;
    expect(elicOutcome.action).toBe("decline");

    expect(settledOf()[0]!.usage).toMatchObject({
      cost: 0.025,
      tokens: { input: 1000, output: 250, totalTokens: 1250 },
      contextUsage: { tokens: 12_000, contextWindow: 120_000, percent: 10 },
    });
  });

  it("rejects mutating permission requests while allowing read/search/report in readonly mode", async () => {
    setup([
      [
        {
          requestPermission: {
            toolCall: { toolCallId: "read-1", title: "Read README.md", kind: "read" },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
            ],
          },
        },
        {
          requestPermission: {
            toolCall: { toolCallId: "edit-1", title: "Modify src/a.ts", kind: "edit" },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
            ],
          },
        },
        { text: "Readonly summary" },
      ],
    ]);
    await adapter.start(spec({ mode: "readonly" }));
    await waitFor(() => settledOf()[0], 10_000, "readonly settle");
    const outcomes = readJsonLines(RPC_LOG())
      .filter((r) => r.direction === "permission_outcome")
      .map((r) => r.outcome);
    expect(outcomes).toEqual([
      { outcome: "selected", optionId: "allow_once" },
      { outcome: "selected", optionId: "reject_once" },
    ]);
  });

  it("cancels pending permission requests and keeps the ACP process alive on cooperative interrupt", async () => {
    let permissionPending = false;
    setup(
      [
        [
          {
            // Blocks until client responds; interrupt() must cancel it + send session/cancel!
            requestPermission: {
              toolCall: { toolCallId: "cmd-1", title: "Run long build", kind: "execute" },
              options: [
                { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
                { optionId: "cancel", name: "Reject", kind: "reject_once" },
              ],
            },
          },
        ],
        [{ callMcpReport: { status: "done", summary: "Second turn on same hot process" } }],
      ],
      undefined,
      {
        onPermissionRequest: () => {
          permissionPending = true;
          return new Promise(() => {
            // Held open until `interrupt()` sends `{ outcome: { outcome: "cancelled" } }`.
          });
        },
      },
    );

    const handle = await adapter.start(spec());
    await waitFor(() => permissionPending, 5_000, "permission pending");
    const interruptRes = await adapter.interrupt("w-agy-1");
    expect(interruptRes).toEqual({ returned: [] });

    await waitFor(() => settledOf()[0], 5_000, "aborted settle");
    expect(settledOf()[0]!.outcome).toBe("aborted");
    const permOutcome = readJsonLines(RPC_LOG()).find((r) => r.direction === "permission_outcome")!;
    expect(permOutcome.outcome).toEqual({ outcome: "cancelled" });
    // Process did NOT exit — cooperative cancel kept `agy acp` hot!
    expect(adapter.isRunning("w-agy-1")).toBe(true);
    expect(events.filter((e) => e.type === "process_exit")).toHaveLength(0);

    // Follow-up turn runs in the exact same process without spawning a second `agy acp`!
    await adapter.send("w-agy-1", { text: "Switch approach" }, "prompt");
    await waitFor(() => settledOf()[1], 10_000, "second turn settle");
    expect(settledOf()[1]!.outcome).toBe("reported");
    expect(readJsonLines(ARGV_LOG())).toHaveLength(1);
    expect(handle.sessionId).toBe("agy-sess-1");
  });

  it("escalates to SIGKILL when a wedged ACP agent ignores session/cancel past cancelGraceMs", async () => {
    setup([[{ ignoreCancel: true, delayMs: 60_000 }]], undefined, { cancelGraceMs: 200 });
    await adapter.start(spec());
    await adapter.interrupt("w-agy-1");
    await waitFor(() => settledOf()[0], 5_000, "aborted settle after kill");
    expect(settledOf()[0]!.outcome).toBe("aborted");
    const exit = events.find((e) => e.type === "process_exit") as { unexpected: boolean } | undefined;
    expect(exit?.unexpected).toBe(false);
  });
});

describe("cold session resumption (`session/load` replay isolation and `session/resume`)", () => {
  it("resumes via `session/load` after process stop and ignores replayed history reports", async () => {
    setup(
      [
        [{ text: "Turn 1 done" }],
        [{ text: "Turn 2 fresh answer without report" }],
      ],
      { loadSession: true, replayHistoryOnLoad: true },
    );

    const handle = await adapter.start(spec());
    await waitFor(() => settledOf()[0], 10_000, "turn 1 settle");
    await adapter.stopProcess("w-agy-1");
    expect(adapter.isRunning("w-agy-1")).toBe(false);

    // Cold send relaunches a second `agy acp` and calls `session/load` with the original sessionId.
    await adapter.send("w-agy-1", { text: "Continue after cold reclaim" }, "prompt");
    await waitFor(() => settledOf()[1], 10_000, "turn 2 settle");

    const rpc = readJsonLines(RPC_LOG());
    const loadReq = rpc.find((r) => r.method === "session/load")!;
    expect((loadReq.params as { sessionId: string }).sessionId).toBe(handle.sessionId);
    // Proof that `STALE_REPLAYED_REPORT_MUST_BE_IGNORED` from `session/load` replay did NOT leak!
    expect(settledOf()[1]!.outcome).toBe("unreported");
    expect(settledOf()[1]!.lastText).toBe("Turn 2 fresh answer without report");
  });

  it("prefers `session/resume` over `session/load` when sessionCapabilities.resume is advertised", async () => {
    setup([[{ text: "Turn 1" }], [{ text: "Resumed cleanly" }]], { sessionResume: true, loadSession: true });
    const handle = await adapter.start(spec());
    await waitFor(() => settledOf()[0], 10_000, "turn 1");
    await adapter.stopProcess("w-agy-1");

    await adapter.resume("w-agy-1", "manual");
    await waitFor(() => settledOf()[1], 10_000, "turn 2");

    const rpc = readJsonLines(RPC_LOG());
    expect(rpc.some((r) => r.method === "session/resume" && (r.params as { sessionId: string }).sessionId === handle.sessionId)).toBe(
      true,
    );
    expect(rpc.some((r) => r.method === "session/load")).toBe(false);
  });
});

describe("images, errors, model observations, and binary detection", () => {
  it("forwards image blocks on session/prompt and refuses when promptCapabilities.image is false", async () => {
    setup([[{ text: "Saw image" }]], { image: true });
    await adapter.start(spec({ images: [{ data: "aGk=", mimeType: "image/png" }] }));
    await waitFor(() => settledOf()[0], 10_000, "settle");

    const promptReq = readJsonLines(RPC_LOG()).find((r) => r.method === "session/prompt")!;
    expect((promptReq.params as { prompt: unknown[] }).prompt).toContainEqual({
      type: "image",
      data: "aGk=",
      mimeType: "image/png",
    });
    await adapter.stopProcess("w-agy-1");

    setup([], { image: false });
    await expect(
      adapter.start(spec({ workerId: "w-agy-no-img", images: [{ data: "aGk=", mimeType: "image/png" }] })),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
  });

  it("classifies ACP JSON-RPC prompt errors and observes model updates (ADR-0021)", async () => {
    const observed: AgentModelObservation[] = [];
    setup(
      [
        [
          { configModelUpdate: "gemini-4-hydrogen" },
          { rpcError: { code: -32001, message: "429 rate limit exceeded" } },
        ],
      ],
      { model: "gemini-3.8-flash" },
    );
    await adapter.start(
      spec({
        model: "gemini-3.1-pro",
        onModelObserved: (obs) => observed.push(obs),
      }),
    );
    await waitFor(() => settledOf()[0], 10_000, "error settle");
    expect(settledOf()[0]!).toMatchObject({ outcome: "error", errorClass: "transient" });
    expect(observed.map((o) => ({ id: o.id, source: o.source }))).toEqual([
      { id: "gemini-3.1-pro", source: "state" },
      { id: "gemini-4-hydrogen", source: "session" },
    ]);
  });

  it("detects an ACP-capable `agy` binary and wires it in defaultAdapters", async () => {
    const { defaultAdapters } = await import("../src/connector-app.ts");
    const detected = detectAntigravity(FAKE_AGY());
    expect(detected).toEqual({ installed: true, version: "1.5.3 (Antigravity CLI)" });

    const missing = [process.execPath, join(dir, "missing-bin.mjs")];
    expect(detectAntigravity(missing).installed).toBe(false);

    // Binary without `acp --help` support is not advertised.
    const legacyBin = join(dir, "legacy-agy.mjs");
    writeFileSync(
      legacyBin,
      "if (process.argv.includes('--version')) { console.log('0.9.0'); process.exit(0); } process.exit(1);\n",
    );
    expect(detectAntigravity([process.execPath, legacyBin]).installed).toBe(false);

    const adapters = defaultAdapters(stateDir, missing, FAKE_AGY(), null, missing);
    expect(adapters.map((a) => a.kind)).toEqual(["pi", "antigravity"]);
    expect(adapters[1]!.version).toBe("1.5.3 (Antigravity CLI)");

    // When both Claude Code and Antigravity CLI are installed, both are advertised alongside pi.
    const fakeClaude = join(dir, "fake-claude-ver.mjs");
    writeFileSync(fakeClaude, "console.log('1.0.42 (Claude Code)');\n");
    const allThree = defaultAdapters(stateDir, [process.execPath, fakeClaude], FAKE_AGY(), null, missing);
    expect(allThree.map((a) => a.kind)).toEqual(["pi", "claude-code", "antigravity"]);
  });
});

describe("isolated GEMINI_API_KEY profile (`otto agy-key`) without overwriting `~/.gemini`", () => {
  it("writes isolated settings.json, passes --gemini-dir, authenticates proactively, and leaves HOME/.gemini untouched", async () => {
    const fakeHome = join(dir, "fake-user-home");
    const userSettingsDir = join(fakeHome, ".gemini", "antigravity-cli");
    mkdirSync(userSettingsDir, { recursive: true });
    const userSettingsFile = join(userSettingsDir, "settings.json");
    const originalUserJson = JSON.stringify({ colorScheme: "tokyo night" }, null, 2);
    writeFileSync(userSettingsFile, originalUserJson);

    const observed: AgentModelObservation[] = [];
    const testApiKey = "AIzaSyIsolatedTestKey0123456789abcdef";
    setup(
      [[{ text: "Ran on isolated free key" }]],
      { model: "gemini-3.1-pro" },
      {
        env: { HOME: fakeHome },
        apiKeyConfig: {
          apiKey: testApiKey,
          model: "Gemini 3.8 Flash",
        },
      },
    );

    await adapter.start(spec({ onModelObserved: (obs) => observed.push(obs) }));
    await waitFor(() => settledOf()[0], 10_000, "isolated apiKey settle");

    // 1. User's ~/.gemini/antigravity-cli/settings.json is 100% untouched.
    expect(readFileSync(userSettingsFile, "utf8")).toBe(originalUserJson);

    // 2. Isolated profile inside stateDir holds modelProvider=gemini + normalized model label.
    const isolatedDir = isolatedAgyGeminiDir(stateDir);
    const isolatedSettings = JSON.parse(
      readFileSync(join(isolatedDir, "antigravity-cli", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(isolatedSettings).toEqual({
      modelProvider: "gemini",
      model: "Gemini 3.8 Flash (Medium)",
      artifactReviewPolicy: "always-proceed",
    });

    // 3. `agy acp` received `--gemini-dir <isolatedDir>`.
    const argvs = readJsonLines(ARGV_LOG()) as unknown as string[][];
    expect(argvs[0]!.slice(2)).toEqual([
      "acp",
      "--log-file",
      join(stateDir, "logs", "agy-acp-w-agy-1.log"),
      "--gemini-dir",
      isolatedDir,
    ]);

    // 4. Proactively authenticated with `gemini-api-key` BEFORE `session/new` (bypassing any cached OAuth).
    const rpc = readJsonLines(RPC_LOG());
    const methods = rpc.filter((r) => r.direction === "in").map((r) => r.method);
    expect(methods.slice(0, 4)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/set_config_option",
    ]);
    const authReq = rpc.find((r) => r.method === "authenticate")!;
    expect(authReq.params).toEqual({
      methodId: "gemini-api-key",
      _meta: { "api-key": testApiKey },
    });

    // 5. Default model option matched "Gemini 3.8 Flash" -> "gemini-3.8-flash-medium" and updated observation.
    expect(observed.map((o) => o.id)).toEqual(["gemini-3.8-flash-medium"]);
  });

  it("persists and clears AntigravityApiKeyConfig in LocalStore, scrubs AIza keys, and resolves both transcript dirs", async () => {
    const { LocalStore } = await import("../src/store.ts");
    const { redactText } = await import("../src/redact.ts");
    const { antigravitySessionPath } = await import("../src/full-session-history.ts");

    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    try {
      expect(store.getAntigravityApiKeyConfig()).toBeNull();
      store.setAntigravityApiKeyConfig({ apiKey: "AIzaSyExampleKey1234567890abcdef", model: "" });
      expect(store.getAntigravityApiKeyConfig()).toEqual({
        apiKey: "AIzaSyExampleKey1234567890abcdef",
        model: "Gemini 4 Hydrogen (High)",
      });
      store.clearAntigravityApiKeyConfig();
      expect(store.getAntigravityApiKeyConfig()).toBeNull();
    } finally {
      store.close();
    }

    expect(redactText("Header key=AIzaSyExampleKey1234567890abcdef failed")).toBe(
      "Header key=[redacted] failed",
    );
    expect(redactText("Auth key=AQ.Ab8RN6LcGeBkzExampleToken0123456789abcdef failed")).toBe(
      "Auth key=[redacted] failed",
    );

    const isoDir = isolatedAgyGeminiDir(stateDir);
    const isoTranscript = join(isoDir, "antigravity-cli", "brain", "sess-iso-1", ".system_generated", "logs", "transcript.jsonl");
    mkdirSync(join(isoDir, "antigravity-cli", "brain", "sess-iso-1", ".system_generated", "logs"), { recursive: true });
    writeFileSync(isoTranscript, '{"ok":true}\n');
    expect(antigravitySessionPath("sess-iso-1", [isoDir, join(dir, "default-gemini")])).toBe(isoTranscript);

    // End-to-end CLI verification of `otto agy-key`, `--stdin`, `--model`, and `--clear`.
    const { spawnSync } = await import("node:child_process");
    const storeForCli = new LocalStore(join(stateDir, "connector.sqlite"));
    storeForCli.saveCredentials({ serverUrl: "http://localhost:18787", deviceId: "dev_1", token: "tok_secret_1234567890" });
    storeForCli.close();

    const cliBin = join(import.meta.dirname, "..", "bin", "otto.js");
    const runCli = (args: string[], input?: string) =>
      spawnSync(process.execPath, [cliBin, ...args], {
        env: { ...process.env, OTTO_HOME: stateDir },
        input,
        encoding: "utf8",
      });

    expect(runCli(["agy-key"]).stdout).toContain("agy-key: none");
    const setRes = runCli(["agy-key", "--stdin", "--model", "gemini-3.8-flash"], "AIzaSyTestFreeKey9876543210abcdef\n");
    expect(setRes.status).toBe(0);
    expect(setRes.stdout).toContain("AIzaSy…cdef");
    expect(setRes.stdout).toContain("model: Gemini 3.8 Flash (Medium)");
    expect(existsSync(join(isoDir, "antigravity-cli", "settings.json"))).toBe(true);

    const statusRes = runCli(["agy-key"]);
    expect(statusRes.stdout).toContain("agy-key: enabled");

    const clearRes = runCli(["agy-key", "--clear"]);
    expect(clearRes.status).toBe(0);
    expect(clearRes.stdout).toContain("agy-key: cleared");
    expect(existsSync(join(stateDir, "agy-apikey"))).toBe(false);
  });
});
