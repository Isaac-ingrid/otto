// Stage 2 Connector telemetry tests:
// - `diffCumulativeSessionUsage`: prevents double-counting tokens/cost across multi-turn `pi`/ACP continuations
// - `inferClaudeContextWindow`: maps known Anthropic Claude models/1M suffixes and leaves custom/gateway IDs null
// - `WorkerManager`: retains `telemetry` emitted inside a `ProgressThrottle` suppression window and flushes it on the next allowed frame or `settled`
// - `CodexAdapter`: measures `lastToolMs`, increments `compactionCount`, and keeps `contextPercent` absent when `model_context_window` is unknown
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffCumulativeSessionUsage,
  type AgentAdapter,
  type RawAdapterEvent,
  type StartSpec,
  type WorkerHandle,
} from "../src/agent.ts";
import { inferClaudeContextWindow } from "../src/claude-adapter.ts";
import { CodexAdapter } from "../src/codex-adapter.ts";
import { EventLog } from "../src/events.ts";
import { LocalStore } from "../src/store.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { makeGitRepo, tmpDir, waitFor } from "./helpers.ts";

describe("diffCumulativeSessionUsage (multi-turn delta cursor)", () => {
  it("emits exact per-turn incremental tokens and cost across resumed turns without repeating prior turns", () => {
    // Turn 1: cumulative 1,200 tokens ($0.012)
    const t1 = diffCumulativeSessionUsage(undefined, {
      tokens: { input: 1_000, output: 200, totalTokens: 1_200 },
      cost: 0.012,
      contextUsage: { tokens: 24_000, contextWindow: 200_000, percent: 12 },
    });
    expect(t1.turnUsage).toEqual({
      tokens: { input: 1_000, output: 200, totalTokens: 1_200 },
      cost: 0.012,
      contextUsage: { tokens: 24_000, contextWindow: 200_000, percent: 12 },
    });

    // Turn 2 (`send` continuation): cumulative grows to 3,000 tokens ($0.030) -> turn delta must be 1,800 tokens ($0.018)!
    const t2 = diffCumulativeSessionUsage(t1.nextCursor, {
      tokens: { input: 2_500, output: 500, totalTokens: 3_000 },
      cost: 0.03,
      contextUsage: { tokens: 68_000, contextWindow: 200_000, percent: 34 },
    });
    expect(t2.turnUsage).toEqual({
      tokens: { input: 1_500, output: 300, totalTokens: 1_800 },
      cost: 0.018,
      contextUsage: { tokens: 68_000, contextWindow: 200_000, percent: 34 },
    });

    // Stale/identical cumulative reading adds 0 tokens and $0 cost (never negative, never repeated).
    const t3 = diffCumulativeSessionUsage(t2.nextCursor, {
      tokens: { input: 2_500, output: 500, totalTokens: 3_000 },
      cost: 0.03,
      contextUsage: { tokens: 68_000, contextWindow: 200_000, percent: 34 },
    });
    expect(t3.turnUsage?.tokens).toBeUndefined();
    expect(t3.turnUsage?.cost).toBe(0);
  });
});

describe("inferClaudeContextWindow", () => {
  it("resolves standard Claude models and [1m] variants while leaving unknown custom IDs null", () => {
    expect(inferClaudeContextWindow("sonnet")).toBe(200_000);
    expect(inferClaudeContextWindow("claude-sonnet-4-20250514")).toBe(200_000);
    expect(inferClaudeContextWindow("sonnet[1m]")).toBe(1_000_000);
    expect(inferClaudeContextWindow("my-gateway/deepseek-coder")).toBeNull();
  });
});

describe("WorkerManager telemetry retention across ProgressThrottle", () => {
  let dir: string;
  let store: LocalStore;

  beforeEach(() => {
    dir = tmpDir("otto-wm-tel");
    store = new LocalStore(join(dir, "state", "connector.sqlite"));
  });

  afterEach(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  it("retains suppressed telemetry inside a 5s throttle window and flushes it on the next allowed progress or settled frame", async () => {
    const repo = await makeGitRepo(dir);
    store.addRepo({
      repoId: repo,
      name: "repo",
      path: repo,
      capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null },
    });

    let clock = 10_000;
    const listeners: Array<(e: RawAdapterEvent) => void> = [];
    const mockAdapter: AgentAdapter = {
      kind: "pi",
      capabilities: {
        steer: true,
        followUp: true,
        interrupt: true,
        resume: true,
        history: false,
        images: false,
        structuredReport: true,
        readonly: true,
      },
      on(_ev, fn) {
        listeners.push(fn);
      },
      async start(spec: StartSpec): Promise<WorkerHandle> {
        return { workerId: spec.workerId, sessionId: spec.workerId, cwd: spec.cwd };
      },
      async send() {
        return {};
      },
      async interrupt() {
        return { returned: [] };
      },
      async resume() {},
      async stopProcess() {},
      isRunning() {
        return true;
      },
    };

    const eventLog = new EventLog(store.database);
    const emitted: Array<Record<string, unknown>> = [];
    const manager = new WorkerManager({
      store,
      stateDir: join(dir, "state"),
      adapter: mockAdapter,
      now: () => clock,
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        emitted.push(JSON.parse(stored.payload) as Record<string, unknown>);
      },
    });

    await manager.startWorker("cmd-tel-1", {
      workerId: "w-tel-1",
      threadId: "t-tel-1",
      repoId: repo,
      mode: "readonly",
      prompt: "check telemetry",
    });

    const fire = (ev: RawAdapterEvent) => {
      for (const fn of listeners) fn(ev);
    };

    // t=10_000: first progress passes immediately
    fire({ type: "progress", workerId: "w-tel-1", phase: "thinking", turn: 1 });
    await new Promise((r) => setTimeout(r, 15));

    // t=12_000 (< 5s absolute cap): suppressed by ProgressThrottle, BUT carries compactionCount + contextTokens!
    clock = 12_000;
    fire({
      type: "progress",
      workerId: "w-tel-1",
      phase: "compacting",
      turn: 1,
      telemetry: { contextTokens: 150_000, contextWindow: 200_000, contextPercent: 75, compactionCount: 2 },
    });
    // t=13_000 (< 5s absolute cap): also suppressed, carries lastToolMs!
    clock = 13_000;
    fire({
      type: "progress",
      workerId: "w-tel-1",
      phase: "tool",
      tool: "Bash",
      turn: 1,
      telemetry: { compactionCount: 1, lastToolMs: 3_100 },
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(emitted.filter((e) => e.type === "progress")).toHaveLength(1);

    // t=15_500 (>= 5s cap, tool phase): allowed! Must carry the merged telemetry (compactionCount=2, lastToolMs=3100)!
    clock = 15_500;
    fire({ type: "progress", workerId: "w-tel-1", phase: "tool", tool: "Read", target: "a.ts", turn: 2 });
    await waitFor(() => emitted.filter((e) => e.type === "progress").length >= 2, 2_000);

    const secondProgress = emitted.filter((e) => e.type === "progress")[1]!;
    expect(secondProgress.telemetry).toEqual({
      contextTokens: 150_000,
      contextWindow: 200_000,
      contextPercent: 75,
      compactionCount: 2,
      lastToolMs: 3_100,
    });

    // Suppressed telemetry right before `settled` flushes onto `settled` alongside `turnUsage`!
    clock = 16_000;
    fire({
      type: "progress",
      workerId: "w-tel-1",
      phase: "thinking",
      turn: 2,
      telemetry: { contextTokens: 172_000, contextWindow: 200_000, contextPercent: 86 },
    });
    fire({
      type: "settled",
      workerId: "w-tel-1",
      outcome: "reported",
      report: { status: "done", summary: "ok" },
      turnUsage: { tokens: { input: 500, output: 100, totalTokens: 600 }, cost: 0.005 },
    });
    await waitFor(() => emitted.some((e) => e.type === "settled"), 2_000);

    const settledEv = emitted.find((e) => e.type === "settled")!;
    expect(settledEv.turnUsage).toEqual({
      tokens: { input: 500, output: 100, totalTokens: 600 },
      cost: 0.005,
    });
    expect(settledEv.telemetry).toEqual({
      contextTokens: 172_000,
      contextWindow: 200_000,
      contextPercent: 86,
    });
  });
});

describe("CodexAdapter honest windowless telemetry", () => {
  let dir: string;
  let adapter: CodexAdapter;

  beforeEach(() => {
    dir = tmpDir("otto-codex-tel");
  });

  afterEach(async () => {
    await adapter?.stopProcess("w-codex-tel").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  it("reports contextTokens, compactionCount, and lastToolMs while keeping contextPercent null when model_context_window is absent", async () => {
    const scenarioPath = join(dir, "codex-scenario.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        runs: [
          [
            { emit: { type: "turn.started" } },
            { emit: { type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "npm test" } } },
            { delayMs: 25 },
            { emit: { type: "item.completed", item: { id: "cmd_1", type: "command_execution", command: "npm test" } } },
            { emit: { type: "context_compacted" } },
            { emit: { type: "token_count", info: { last_token_usage: { total_tokens: 64_200 } } } },
            {
              emit: {
                type: "item.completed",
                item: {
                  id: "rep_1",
                  type: "mcp_tool_call",
                  server: "otto",
                  tool: "report",
                  status: "completed",
                  arguments: { status: "done", summary: "Codex 遥测验证" },
                },
              },
            },
            {
              emit: {
                type: "turn.completed",
                usage: { input_tokens: 50_000, cached_input_tokens: 10_000, output_tokens: 4_200 },
              },
            },
          ],
        ],
      }),
    );

    const events: RawAdapterEvent[] = [];
    adapter = new CodexAdapter({
      stateDir: join(dir, "state"),
      command: [process.execPath, join(import.meta.dirname, "fake-codex.mjs")],
      env: {
        FAKE_CODEX_SCRIPT: scenarioPath,
        CODEX_HOME: join(dir, "codex-home"),
      },
      initTimeoutMs: 10_000,
    });
    adapter.on("worker-event", (ev) => events.push(ev));

    await adapter.start({
      workerId: "w-codex-tel",
      threadId: "t-codex-tel",
      commandId: "cmd-cx-1",
      cwd: dir,
      mode: "readonly",
      prompt: "run codex telemetry test",
    });

    await waitFor(() => events.some((e) => e.type === "settled"), 5_000);
    const settled = events.find((e) => e.type === "settled");
    expect(settled?.type).toBe("settled");
    if (settled?.type === "settled") {
      expect(settled.usage?.contextUsage).toEqual({
        tokens: 64_200,
        percent: null,
      });
      expect(settled.telemetry?.contextTokens).toBe(64_200);
      expect(settled.telemetry?.contextWindow).toBeUndefined();
      expect(settled.telemetry?.contextPercent).toBeUndefined();
      expect(settled.telemetry?.compactionCount).toBe(1);
      expect(typeof settled.telemetry?.lastToolMs).toBe("number");
      expect(settled.telemetry!.lastToolMs!).toBeGreaterThanOrEqual(0);
    }
  });
});
