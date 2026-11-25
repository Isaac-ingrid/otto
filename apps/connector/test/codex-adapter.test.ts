// CodexAdapter contract tests: headless `codex exec --json` / `codex exec resume --json`,
// `-c mcp_servers.otto.*` injection, `--sandbox read-only` vs bypass, `-i <file>` images,
// `-m <model>`, `mcp_tool_call` (`report` & `propose`), error propagation, and `history()`.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter, isCodexProposalTool, isCodexReportTool } from "../src/codex-adapter.ts";
import type { RawAdapterEvent, StartSpec } from "../src/agent.ts";
import { tmpDir, waitFor } from "./helpers.ts";

let dir: string;
let stateDir: string;
let adapter: CodexAdapter;
let events: RawAdapterEvent[];

const LOG = () => join(dir, "codex-prompt.log");
const ARGV_LOG = () => join(dir, "codex-argv.log");

beforeEach(() => {
  dir = tmpDir("otto-codex-test");
  stateDir = join(dir, "state");
  events = [];
});

afterEach(async () => {
  await adapter?.stopProcess("w-codex-1").catch(() => undefined);
  await adapter?.stopProcess("w-codex-ro").catch(() => undefined);
  await adapter?.stopProcess("w-codex-img").catch(() => undefined);
  await adapter?.stopProcess("w-codex-hist").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function setup(runs: Array<Array<Record<string, unknown>>>, startup?: Record<string, unknown>): void {
  const scenario = join(dir, "codex-scenario.json");
  writeFileSync(scenario, JSON.stringify({ runs, startup }));
  adapter = new CodexAdapter({
    stateDir,
    command: [process.execPath, join(import.meta.dirname, "fake-codex.mjs")],
    env: {
      FAKE_CODEX_SCRIPT: scenario,
      FAKE_CODEX_LOG: LOG(),
      FAKE_CODEX_ARGV_LOG: ARGV_LOG(),
      CODEX_HOME: join(dir, "codex-home"),
    },
    initTimeoutMs: 10_000,
  });
  adapter.on("worker-event", (event) => events.push(event));
}

function readLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function spec(overrides: Partial<StartSpec> = {}): StartSpec {
  return {
    workerId: "w-codex-1",
    threadId: "t-codex-1",
    cwd: dir,
    mode: "write",
    prompt: "Implement the thing",
    commandId: "cmd-1",
    ...overrides,
  };
}

const settledOf = (workerId = "w-codex-1") =>
  events.filter((e) => e.type === "settled" && e.workerId === workerId) as Array<{
    type: "settled";
    outcome: string;
    errorClass?: string;
    errorMessage?: string;
    lastText?: string;
    report?: Record<string, unknown>;
    usage?: Record<string, unknown>;
  }>;

describe("CodexAdapter invocation and capabilities", () => {
  it("declares honest capabilities including readonly=true, images=true, history=true, steer=false", () => {
    setup([]);
    expect(adapter.kind).toBe("codex");
    expect(adapter.capabilities).toEqual({
      steer: false,
      followUp: false,
      interrupt: true,
      resume: true,
      history: true,
      images: true,
      structuredReport: true,
      readonly: true,
    });
    expect(adapter.modelCatalog.capabilities).toMatchObject({
      selection: "launch",
      discovery: "suggested",
      customModelInput: true,
      actualModelObservation: true,
      idFormat: "opaque",
    });
  });

  it("runs `codex exec --json` with bypass permissions in write mode and injects mcp_servers.otto", async () => {
    setup([
      [
        {
          emit: {
            type: "item.completed",
            item: {
              id: "item_1",
              type: "mcp_tool_call",
              server: "otto",
              tool: "report",
              status: "completed",
              arguments: { status: "done", summary: "codex finished" },
            },
          },
        },
        {
          emit: {
            type: "item.completed",
            item: { id: "item_2", type: "agent_message", text: "All done." },
          },
        },
      ],
    ], { rolloutModel: "gpt-5.3-codex-2026-11" });

    const observedModels: string[] = [];
    const handle = await adapter.start(
      spec({
        model: "gpt-5.3-codex",
        onModelObserved: (obs) => observedModels.push(obs.id),
      }),
    );
    await waitFor(() => settledOf()[0], 10_000, "codex settle");

    expect(handle.sessionId).toBe("019a0000-0000-7000-8000-000000000001");
    expect(handle.sessionFile).toBeUndefined();
    expect(observedModels).toEqual(["gpt-5.3-codex-2026-11"]);
    const argv = readLog(ARGV_LOG())[0] as unknown as string[];
    expect(argv.slice(0, 4)).toEqual(["exec", "--json", "--skip-git-repo-check", "-C"]);
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).toContain("-m");
    expect(argv).toContain("gpt-5.3-codex");
    expect(argv.some((a) => a.startsWith("mcp_servers.otto.command="))).toBe(true);
    expect(argv.some((a) => a.startsWith("developer_instructions="))).toBe(true);
    expect(argv[argv.length - 1]).toBe("-");

    const promptLog = readLog(LOG())[0]!;
    expect(promptLog.stdinEnded).toBe(true);
    expect(promptLog.prompt).toBe("Implement the thing");

    const settled = settledOf()[0]!;
    expect(settled.outcome).toBe("reported");
    expect(settled.report).toMatchObject({ status: "done", summary: "codex finished" });
    expect(settled.usage).toMatchObject({ tokens: { input: 420, output: 80, totalTokens: 500 } });
  });

  it("enforces `-s read-only` and `approval_policy=\"never\"` in readonly mode", async () => {
    setup([
      [
        {
          emit: {
            type: "item.completed",
            item: { id: "item_1", type: "agent_message", text: "Readonly review complete." },
          },
        },
      ],
    ]);

    await adapter.start(spec({ workerId: "w-codex-ro", mode: "readonly" }));
    await waitFor(() => settledOf("w-codex-ro")[0], 10_000, "readonly settle");

    const argv = readLog(ARGV_LOG())[0] as unknown as string[];
    expect(argv).toContain("-s");
    expect(argv).toContain("read-only");
    expect(argv).toContain('sandbox_mode="read-only"');
    expect(argv).toContain('approval_policy="never"');
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(settledOf("w-codex-ro")[0]!.outcome).toBe("unreported");
    expect(settledOf("w-codex-ro")[0]!.lastText).toBe("Readonly review complete.");
  });

  it("writes image attachments to temp files and passes `-i <path>`", async () => {
    setup([
      [
        {
          emit: {
            type: "item.completed",
            item: { id: "item_1", type: "agent_message", text: "Saw image." },
          },
        },
      ],
    ]);

    await adapter.start(
      spec({
        workerId: "w-codex-img",
        images: [{ data: Buffer.from("fake-png-bytes").toString("base64"), mimeType: "image/png" }],
      }),
    );
    await waitFor(() => settledOf("w-codex-img")[0], 10_000, "image settle");

    const promptEntry = readLog(LOG())[0] as { imagePaths: Array<{ path: string; exists: boolean }> };
    expect(promptEntry.imagePaths).toHaveLength(1);
    expect(promptEntry.imagePaths[0]!.path.endsWith(".png")).toBe(true);
    expect(promptEntry.imagePaths[0]!.exists).toBe(true);
  });

  it("emits proposal events before settled on `propose` MCP calls and resumes via `exec resume --json`", async () => {
    setup([
      [
        {
          emit: {
            type: "item.completed",
            item: {
              id: "item_1",
              type: "mcp_tool_call",
              server: "otto",
              tool: "propose",
              status: "completed",
              arguments: {
                kind: "readonly_probe",
                targetRepoRef: "shared-lib",
                prompt: "Check types",
                reason: "Verify API",
                proposalKey: "codex-probe-1",
              },
            },
          },
        },
        {
          emit: {
            type: "item.completed",
            item: {
              id: "item_2",
              type: "mcp_tool_call",
              server: "otto",
              tool: "report",
              status: "completed",
              arguments: { status: "done", summary: "leg 1" },
            },
          },
        },
      ],
      [
        {
          emit: {
            type: "item.completed",
            item: {
              id: "item_3",
              type: "mcp_tool_call",
              server: "otto",
              tool: "report",
              status: "completed",
              arguments: { status: "done", summary: "leg 2" },
            },
          },
        },
      ],
    ]);

    const handle = await adapter.start(spec());
    await waitFor(() => settledOf()[0], 10_000, "run 1 settle");
    await adapter.send("w-codex-1", { text: "Continue work" }, "prompt");
    await waitFor(() => settledOf()[1], 10_000, "run 2 settle");

    const proposal = events.find((e) => e.type === "proposal");
    expect(proposal).toMatchObject({
      type: "proposal",
      workerId: "w-codex-1",
      proposal: { kind: "readonly_probe", proposalKey: "codex-probe-1" },
    });

    const argvs = readLog(ARGV_LOG()) as unknown as string[][];
    expect(argvs[1]!.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(argvs[1]).toContain(handle.sessionId);
    expect(settledOf()[1]!.report).toMatchObject({ summary: "leg 2" });
    expect(isCodexReportTool("otto", "report")).toBe(true);
    expect(isCodexProposalTool("otto", "propose")).toBe(true);
  });

  it("propagates turn.failed errors and pre-init failures", async () => {
    setup([
      [
        {
          emit: {
            type: "turn.failed",
            error: { message: "Codex error: The usage limit has been reached" },
          },
        },
      ],
    ]);

    await adapter.start(spec());
    await waitFor(() => settledOf()[0], 10_000, "error settle");
    expect(settledOf()[0]!.outcome).toBe("error");
    expect(settledOf()[0]!.errorClass).toBe("rate_limited");
    expect(typeof (settledOf()[0] as unknown as { limitedUntil?: number }).limitedUntil).toBe("number");
    expect(settledOf()[0]!.errorMessage).toContain("usage limit");
  });

  it("serves live history while running and detects installed codex binary", async () => {
    const { detectCodex } = await import("../src/codex-adapter.ts");
    const { defaultAdapters } = await import("../src/connector-app.ts");
    const fakeBin = join(dir, "fake-codex-bin.mjs");
    writeFileSync(fakeBin, "console.log('codex-cli 0.170.0');\n");
    const missing = [process.execPath, join(dir, "no-such-codex.mjs")];

    expect(detectCodex([process.execPath, fakeBin])).toMatchObject({
      installed: true,
      version: "codex-cli 0.170.0",
    });
    expect(detectCodex(missing).installed).toBe(false);
    const adapters = defaultAdapters(stateDir, missing, missing, null, [process.execPath, fakeBin]);
    expect(adapters.map((a) => a.kind)).toEqual(["pi", "codex"]);

    setup([
      [
        {
          emit: {
            type: "item.started",
            item: { id: "cmd_1", type: "command_execution", command: "pnpm test" },
          },
        },
        {
          emit: {
            type: "item.completed",
            item: { id: "cmd_1", type: "command_execution", command: "pnpm test", status: "completed" },
          },
        },
        { delayMs: 600 },
        {
          emit: {
            type: "item.completed",
            item: {
              id: "rep_1",
              type: "mcp_tool_call",
              server: "otto",
              tool: "report",
              status: "completed",
              arguments: { status: "done", summary: "hist done" },
            },
          },
        },
      ],
    ]);

    await adapter.start(spec({ workerId: "w-codex-hist", prompt: "Run tests" }));
    await waitFor(() => events.some((e) => e.type === "progress" && e.tool === "Bash"), 5_000, "tool progress");
    const page = await adapter.history("w-codex-hist", undefined, 1024 * 1024);
    expect(page.done).toBe(true);
    expect(page.entries[0]).toMatchObject({ role: "user", text: "Run tests" });
    await adapter.stopProcess("w-codex-hist");
  });
});
