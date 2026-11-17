// WorkerManager × AntigravityAdapter integration tests: side-by-side operation with pi,
// honest capability gating (readonly refused, ADR-0021 model selection gated, images allowed),
// resident hot follow-up sends vs idle-reclaimed cold relaunches, mid-run send deferral,
// cooperative `interrupt` with `then` without killing the ACP process, connector crash
// reconciliation (`session/load` auto-resume + GitFacts), and native full-history reads.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerManager, type StartWorkerArgs } from "../src/worker-manager.ts";
import { AntigravityAdapter } from "../src/antigravity-adapter.ts";
import { LocalStore } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import {
  fakePiAdapter,
  makeGitRepo,
  reportRun,
  type ScenarioStep,
  tmpDir,
  waitFor,
  writeScenario,
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
let manager: WorkerManager;

const FAKE_AGY = () => [process.execPath, join(import.meta.dirname, "fake-agy.mjs")];
const AGY_LOG = () => join(dir, "agy-manager.log");
const AGY_ARGV_LOG = () => join(dir, "agy-manager-argv.log");

beforeEach(async () => {
  dir = tmpDir("otto-agy-manager-test");
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
  for (const workerId of ["w-agy-m1", "w-agy-m2"]) {
    await manager?.stopProcess(workerId).catch(() => undefined);
  }
  manager?.stop();
  await new Promise((resolve) => setTimeout(resolve, 80));
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function makeAgyAdapter(runs: Array<Array<Record<string, unknown>>>, startup?: Record<string, unknown>): AntigravityAdapter {
  const scenarioPath = join(dir, `agy-${Math.random().toString(36).slice(2, 7)}.json`);
  writeFileSync(scenarioPath, JSON.stringify({ ...(startup ? { startup } : {}), runs }));
  return new AntigravityAdapter({
    stateDir,
    command: FAKE_AGY(),
    env: {
      FAKE_AGY_SCRIPT: scenarioPath,
      FAKE_AGY_LOG: AGY_LOG(),
      FAKE_AGY_ARGV_LOG: AGY_ARGV_LOG(),
    },
    initTimeoutMs: 10_000,
  });
}

function setup(piRuns: ScenarioStep[][], agyRuns: Array<Array<Record<string, unknown>>>): void {
  const piScenario = writeScenario(dir, "pi-scenario", piRuns);
  manager = new WorkerManager({
    store,
    stateDir,
    adapters: [fakePiAdapter(stateDir, piScenario), makeAgyAdapter(agyRuns)],
    emit: (workerId, fields) => {
      const stored = eventLog.append(workerId, fields);
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
  });
}

function args(overrides: Partial<StartWorkerArgs> = {}): StartWorkerArgs {
  return {
    workerId: "w-agy-m1",
    threadId: "thread-agy",
    repoId: repo,
    mode: "write",
    prompt: "Implement feature with Antigravity",
    agent: "antigravity",
    ...overrides,
  };
}

function cmdArgs(a: StartWorkerArgs): Record<string, unknown> {
  return { ...a } as Record<string, unknown>;
}

const eventsOf = (workerId: string, type: string) => events.filter((e) => e.workerId === workerId && e.type === type);

describe("capability gates & mixed-fleet dispatch", () => {
  it("advertises antigravity, refuses readonly and explicit model overrides (ADR-0021), and accepts images", async () => {
    setup([], [[{ callMcpReport: { status: "done", summary: "with screenshot" } }]]);
    expect(manager.agents.map((a) => a.kind)).toEqual(["pi", "antigravity"]);

    await expect(
      manager.handleCommand("c1", "start_worker", { ...args(), mode: "readonly" }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });

    await expect(
      manager.handleCommand("c2", "start_worker", { ...args(), model: "gemini-3.1-pro" }),
    ).rejects.toMatchObject({ code: "unsupported_model" });

    await manager.handleCommand("c3", "start_worker", {
      ...args(),
      images: [{ data: "aGk=", mimeType: "image/png" }],
    });
    await waitFor(() => eventsOf("w-agy-m1", "settled").length > 0, 15_000, "settle");
    expect(store.getWorker("w-agy-m1")!.agent).toBe("antigravity");
    expect(eventsOf("w-agy-m1", "report")[0]).toMatchObject({ summary: "with screenshot" });
  });

  it("runs pi and antigravity workers concurrently and merges real GitFacts on report", async () => {
    setup(
      [[...reportRun({ status: "done", summary: "pi finished" })]],
      [
        [
          { shell: "echo 'export const x = 1;' > added.ts && git add added.ts && git commit -m 'feat: add x'" },
          { callMcpReport: { status: "done", summary: "agy committed change" } },
        ],
      ],
    );
    await manager.handleCommand("c4", "start_worker", cmdArgs(args()));
    await manager.handleCommand("c5", "start_worker", cmdArgs({ ...args(), workerId: "w-agy-m2", agent: undefined }));

    await waitFor(() => eventsOf("w-agy-m1", "settled").length > 0, 15_000, "agy settle");
    await waitFor(() => eventsOf("w-agy-m2", "settled").length > 0, 15_000, "pi settle");

    const agyReport = eventsOf("w-agy-m1", "report")[0] as unknown as {
      summary: string;
      git?: { ahead: number; changedFiles: string[] };
    };
    expect(agyReport.summary).toBe("agy committed change");
    expect(agyReport.git?.ahead).toBe(1);
    expect(agyReport.git?.changedFiles).toContain("added.ts");
  });
});

describe("hot resident sends, mid-run deferral, and cooperative interrupt + then", () => {
  it("delivers mid-run sends onto the resident ACP process after turn end without respawning", async () => {
    setup(
      [],
      [
        [{ delayMs: 800 }, { callMcpReport: { status: "done", summary: "turn 1" } }],
        [{ callMcpReport: { status: "done", summary: "turn 2" } }],
      ],
    );
    await manager.handleCommand("d1", "start_worker", cmdArgs(args()));
    const sendRes = (await manager.handleCommand("d2", "send", {
      workerId: "w-agy-m1",
      text: "Follow up on same resident ACP server",
      intent: "now",
    })) as { delivery: string; effect?: string };
    expect(sendRes).toMatchObject({ delivery: "queued", effect: "after_run_end" });

    await waitFor(() => eventsOf("w-agy-m1", "settled").length >= 2, 20_000, "both turns settle");
    // Only ONE `agy acp` process was ever spawned across both turns!
    const spawns = readFileSync(AGY_ARGV_LOG(), "utf8").trim().split("\n");
    expect(spawns).toHaveLength(1);
  });

  it("cooperatively cancels via session/cancel and runs `interrupt.then` on the same live ACP session", async () => {
    setup(
      [],
      [
        [{ delayMs: 60_000 }],
        [{ callMcpReport: { status: "done", summary: "pivoted cleanly" } }],
      ],
    );
    await manager.handleCommand("i1", "start_worker", cmdArgs(args()));
    await manager.handleCommand("i2", "send", { workerId: "w-agy-m1", text: "stale queued send", intent: "auto" });

    const outcome = (await manager.handleCommand("i3", "interrupt", {
      workerId: "w-agy-m1",
      then: { text: "Pivot to plan B" },
    })) as { aborted: boolean; queueReturned: number; then?: { delivery: string } };

    expect(outcome.aborted).toBe(true);
    expect(outcome.queueReturned).toBe(1);
    expect(outcome.then?.delivery).toBe("prompt");

    await waitFor(
      () => eventsOf("w-agy-m1", "report").some((r) => r.summary === "pivoted cleanly"),
      15_000,
      "then turn report",
    );
    const spawns = readFileSync(AGY_ARGV_LOG(), "utf8").trim().split("\n");
    expect(spawns).toHaveLength(1);
  });
});

describe("crash reconciliation and native full-session history", () => {
  it("marks crashed antigravity workers lost on reboot and auto-resumes via session/load", async () => {
    manager = new WorkerManager({
      store,
      stateDir,
      adapters: [makeAgyAdapter([[{ delayMs: 60_000 }]])],
      emit: (workerId, fields) => {
        events.push(JSON.parse(eventLog.append(workerId, fields).payload) as EmittedEvent);
      },
    });
    const started = (await manager.handleCommand("r1", "start_worker", cmdArgs(args()))) as { sessionId: string };
    expect(started.sessionId).toBe("agy-sess-1");
    manager.simulateCrash();

    const managerB = new WorkerManager({
      store,
      stateDir,
      adapters: [makeAgyAdapter([[{ callMcpReport: { status: "done", summary: "recovered via ACP session/load" } }]])],
      recovery: { autoResumeBackoffMs: 200 },
      emit: (workerId, fields) => {
        events.push(JSON.parse(eventLog.append(workerId, fields).payload) as EmittedEvent);
      },
    });
    await managerB.reconcileStartup();
    await waitFor(() => eventsOf("w-agy-m1", "lost").length > 0, 10_000, "lost");
    await waitFor(() => eventsOf("w-agy-m1", "resumed").length > 0, 10_000, "resumed");
    await waitFor(() => eventsOf("w-agy-m1", "settled").length > 0, 15_000, "settled");

    expect(store.getWorker("w-agy-m1")).toMatchObject({
      state: "idle",
      sessionId: "agy-sess-1",
      lastOutcome: "reported",
    });

    // Verify full-fidelity session history reads Antigravity's native transcript.jsonl when present.
    const agyConfigDir = join(dir, "gemini-home");
    const transcriptDir = join(agyConfigDir, "antigravity-cli", "brain", "agy-sess-1", ".system_generated", "logs");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, "transcript.jsonl"), JSON.stringify({ step: 1, role: "user", text: "hi" }) + "\n");
    process.env.AGY_CONFIG_DIR = agyConfigDir;
    try {
      const page = await managerB.history("w-agy-m1", undefined, 16 * 1024, "full");
      expect(page.format).toBe("full");
      expect(page.entries.length).toBe(1);
      expect(page.entries[0]!.fragment?.data).toContain("hi");
    } finally {
      delete process.env.AGY_CONFIG_DIR;
      await managerB.stopProcess("w-agy-m1").catch(() => undefined);
      managerB.stop();
    }
  }, 60_000);
});
