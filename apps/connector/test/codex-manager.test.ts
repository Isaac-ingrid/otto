// WorkerManager × CodexAdapter contract tests: readonly sandbox, images on start & send,
// explicit model selection & cold SQLite reopen, mid-run send deferral, interrupt/stop,
// and on-demand normalized + full session history reading.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/codex-adapter.ts";
import { LocalStore } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import { WorkerManager, type StartWorkerArgs } from "../src/worker-manager.ts";
import { fakePiAdapter, makeGitRepo, tmpDir, waitFor, writeScenario } from "./helpers.ts";

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
let manager: WorkerManager;

const CODEX_PROMPT_LOG = () => join(dir, "codex-prompts.log");
const CODEX_HOME = () => join(dir, "codex-home");

function fakeCodexAdapter(
  adapterStateDir: string,
  scenarioPath: string,
  extraEnv: Record<string, string | undefined> = {},
): CodexAdapter {
  return new CodexAdapter({
    stateDir: adapterStateDir,
    command: [process.execPath, join(import.meta.dirname, "fake-codex.mjs")],
    env: {
      FAKE_CODEX_SCRIPT: scenarioPath,
      FAKE_CODEX_LOG: CODEX_PROMPT_LOG(),
      CODEX_HOME: CODEX_HOME(),
      ...extraEnv,
    },
    initTimeoutMs: 10_000,
  });
}

function writeCodexScenario(
  name: string,
  runs: Array<Array<Record<string, unknown>>>,
  startup?: Record<string, unknown>,
): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ runs, startup }));
  return path;
}

function codexReportSteps(report: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    {
      emit: {
        type: "item.completed",
        item: {
          id: "rep_1",
          type: "mcp_tool_call",
          server: "otto",
          tool: "report",
          status: "completed",
          arguments: report,
        },
      },
    },
  ];
}

beforeEach(async () => {
  dir = tmpDir("otto-codex-manager-test");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  eventLog = new EventLog(store.database);
  events = [];
  store.addRepo({
    repoId: repo,
    name: "repo-a",
    path: repo,
    capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null },
  });
});

afterEach(async () => {
  for (const workerId of ["w-codex-m1", "w-codex-ro", "w-codex-hist"]) {
    await manager?.stopProcess(workerId).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function setup(codexRuns: Array<Array<Record<string, unknown>>>): void {
  const piScenario = writeScenario(dir, "pi-scenario", []);
  const codexScenario = writeCodexScenario("codex-scenario", codexRuns);
  manager = new WorkerManager({
    store,
    stateDir,
    adapters: [fakePiAdapter(stateDir, piScenario), fakeCodexAdapter(stateDir, codexScenario)],
    emit: (workerId, fields) => {
      const stored = eventLog.append(workerId, fields);
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
  });
}

function args(overrides: Partial<StartWorkerArgs> = {}): StartWorkerArgs {
  return {
    workerId: "w-codex-m1",
    threadId: "t-codex",
    repoId: repo,
    mode: "write",
    prompt: "Implement the feature",
    agent: "codex",
    ...overrides,
  };
}

const eventsOf = (workerId: string, type: string) => events.filter((e) => e.workerId === workerId && e.type === type);

describe("WorkerManager × CodexAdapter", () => {
  it("supports readonly tasks and image attachments on start_worker", async () => {
    setup([
      [...codexReportSteps({ status: "done", summary: "readonly ok" })],
    ]);

    await manager.handleCommand("c-ro", "start_worker", {
      ...args({
        workerId: "w-codex-ro",
        mode: "readonly",
        images: [{ data: Buffer.from("img-bytes").toString("base64"), mimeType: "image/png" }],
      }),
    });
    await waitFor(() => eventsOf("w-codex-ro", "settled").length > 0, 15_000, "codex readonly settle");

    expect(store.getWorker("w-codex-ro")).toMatchObject({ agent: "codex", mode: "readonly", lastOutcome: "reported" });
    const records = readFileSync(CODEX_PROMPT_LOG(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; imagePaths: Array<{ exists: boolean }> });
    expect(records[0]!.argv).toContain("-s");
    expect(records[0]!.argv).toContain("read-only");
    expect(records[0]!.imagePaths).toHaveLength(1);
    expect(records[0]!.imagePaths[0]!.exists).toBe(true);
  });

  it("preserves explicit --model across deferred mid-run send and cold SQLite reopen", async () => {
    const piScenario = writeScenario(dir, "pi-model", []);
    const codexScenario = writeCodexScenario("codex-model", [
      [{ delayMs: 800 }, ...codexReportSteps({ status: "done", summary: "run 1" })],
      [...codexReportSteps({ status: "done", summary: "run 2 deferred" })],
      [...codexReportSteps({ status: "done", summary: "run 3 cold reopen" })],
    ]);
    manager = new WorkerManager({
      store,
      stateDir,
      adapters: [fakePiAdapter(stateDir, piScenario), fakeCodexAdapter(stateDir, codexScenario)],
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });

    await manager.handleCommand("c-bad", "start_worker", { ...args(), model: "bad..model" }).then(
      () => { throw new Error("expected rejection"); },
      (err) => expect(err).toMatchObject({ code: "unsupported_model" }),
    );

    await manager.handleCommand("c-start", "start_worker", {
      ...args(),
      model: "gpt-5.3-codex",
      modelSource: "task-default",
    });
    await manager.handleCommand("c-defer", "send", {
      workerId: "w-codex-m1",
      text: "follow up",
      intent: "now",
    });

    await waitFor(() => eventsOf("w-codex-m1", "settled").length >= 2, 15_000, "deferred codex settle");
    expect(store.getWorker("w-codex-m1")).toMatchObject({ requestedModel: "gpt-5.3-codex", modelSource: "task-default" });

    await manager.stopProcess("w-codex-m1");
    manager.stop();
    store.close();

    store = new LocalStore(join(stateDir, "connector.sqlite"));
    eventLog = new EventLog(store.database);
    manager = new WorkerManager({
      store,
      stateDir,
      adapters: [fakePiAdapter(stateDir, piScenario), fakeCodexAdapter(stateDir, codexScenario)],
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });

    const cold = await manager.handleCommand("c-cold", "send", {
      workerId: "w-codex-m1",
      text: "continue cold",
      intent: "auto",
    });
    expect(cold).toMatchObject({ relaunched: true });
    await waitFor(() => eventsOf("w-codex-m1", "settled").length >= 3, 15_000, "cold codex settle");

    const promptRecords = readFileSync(CODEX_PROMPT_LOG(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[] });
    expect(promptRecords).toHaveLength(3);
    expect(promptRecords[0]!.argv).toEqual(expect.arrayContaining(["exec", "--json", "-m", "gpt-5.3-codex"]));
    expect(promptRecords[1]!.argv).toEqual(expect.arrayContaining(["exec", "resume", "--json", "-m", "gpt-5.3-codex"]));
    expect(promptRecords[2]!.argv).toEqual(expect.arrayContaining(["exec", "resume", "--json", "-m", "gpt-5.3-codex"]));
  });

  it("reads normalized and full session history from Codex rollout files after exit", async () => {
    setup([
      [
        { emit: { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Checked repo" } } },
        ...codexReportSteps({ status: "done", summary: "hist ok" }),
      ],
    ]);

    await manager.handleCommand("c-hist", "start_worker", {
      ...args({ workerId: "w-codex-hist", prompt: "Inspect codebase" }),
    });
    await waitFor(() => eventsOf("w-codex-hist", "settled").length > 0, 15_000, "hist settle");
    await manager.stopProcess("w-codex-hist");

    const norm = await manager.history("w-codex-hist", undefined, 1024 * 1024);
    expect(norm.done).toBe(true);
    expect(norm.entries.some((e) => e.role === "user" && e.text === "Inspect codebase")).toBe(true);
    expect(norm.entries.some((e) => e.role === "assistant" && e.text === "Checked repo")).toBe(true);

    const full = await manager.history("w-codex-hist", undefined, 1024 * 1024, "full");
    expect(full.format).toBe("full");
    expect(full.done).toBe(true);
    expect(full.entries.length).toBeGreaterThan(0);
  });
});
