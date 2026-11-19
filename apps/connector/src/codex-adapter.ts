// CodexAdapter: AgentAdapter implementation for OpenAI Codex CLI (`codex exec --json` /
// `codex exec resume --json`). Speaks LF-delimited JSONL over stdout with prompt delivery
// via stdin EOF, injects Otto's stdio MCP server (`report` & `propose`) via `-c` TOML
// overrides (never mutating ~/.codex/config.toml), supports `--sandbox read-only` for
// readonly tasks and `-i <file>` image attachments, and shares the same adjudication path.
import type {
  AgentAdapter,
  AgentCapabilities,
  Delivery,
  InterruptResult,
  ProposalPayload,
  RawAdapterEvent,
  SessionUsage,
  StartSpec,
  WorkerHandle,
} from "./agent.ts";
import {
  AgentModelObservationSchema,
  AgentModelIdSchema,
  type AgentModelCatalog,
  type HistoryPage,
} from "@isaac2ingrid/protocol";
import { AdapterError } from "./agent.ts";
import { adjudicate, type RunWindow } from "./adjudication.ts";
import { codexSessionPath } from "./full-session-history.ts";
import { installClaudeAssets, WORKER_SYSTEM_PROMPT } from "./install.ts";
import { appendCapped } from "./logger.ts";
import { childEnv, extractTarget, normalizeProposal, normalizeReport, RESUME_PROMPT } from "./pi-adapter.ts";
import { resolveExecutableLaunch, splitCommandLine, type LaunchResolution } from "./pi-launch.ts";
import { redactText } from "./redact.ts";
import {
  normalizeCodexEntries,
  readCodexSessionHistory,
  type CodexTranscriptRecord,
} from "./session-history.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const CODEX_COMMAND_ENV = "OTTO_CODEX_COMMAND";

export function codexCommandFromEnv(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env[CODEX_COMMAND_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const argv = splitCommandLine(raw).filter((part) => part.length > 0);
  return argv.length > 0 ? argv : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((v) => tomlString(v)).join(", ")}]`;
}

/** Matches Otto's MCP `report` tool across Codex `mcp_tool_call` shapes (`server: "otto", tool: "report"` or namespaced). */
export function isCodexReportTool(server: unknown, tool: unknown): boolean {
  if (typeof tool !== "string") return false;
  if (server === "otto" && tool === "report") return true;
  return tool.endsWith("__report");
}

/** Matches Otto's MCP `propose` tool across Codex `mcp_tool_call` shapes. */
export function isCodexProposalTool(server: unknown, tool: unknown): boolean {
  if (typeof tool !== "string") return false;
  if (server === "otto" && tool === "propose") return true;
  return tool.endsWith("__propose");
}

const CODEX_CAPABILITIES: AgentCapabilities = {
  // No control channel after stdin EOF in `codex exec`: mid-run steer/follow_up defer to run end.
  steer: false,
  followUp: false,
  interrupt: true,
  resume: true,
  history: true,
  images: true,
  structuredReport: true,
  readonly: true,
};

export const CODEX_SUGGESTED_MODELS = [
  { id: "gpt-5.4", name: "gpt-5.4" },
  { id: "gpt-5.3-codex", name: "gpt-5.3-codex" },
  { id: "gpt-5.2-codex", name: "gpt-5.2-codex" },
  { id: "o3", name: "o3" },
] as const;

export interface CodexAdapterOptions {
  stateDir: string;
  /** argv prefix for the codex binary; default ["codex"]. Tests point this at fake-codex. */
  command?: string[];
  /** Extra env for the child (tests). OTTO_* is always stripped. */
  env?: Record<string, string | undefined>;
  /** Per-worker stderr tails; default <stateDir>/logs. Pass null to disable. */
  workerLogsDir?: string | null;
  /** hello.agents version string (detected `codex --version` output). */
  version?: string;
  /** `thread.started` must arrive within this window after spawn (default 30 s). */
  initTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL on stop (default 3 s). */
  stopGraceMs?: number;
  /** A pre-resolved launch (pi-launch.ts). */
  launch?: LaunchResolution;
}

interface WorkerRuntime {
  workerId: string;
  process: CodexProcess;
  cwd: string;
  sessionId: string | null;
  observedModel: string | null;
  reportFile: string;
  proposalsFile: string;
  imageTempDir: string;
  emittedProposalKeys: Set<string>;
  liveEntries: CodexTranscriptRecord[];
  stopping: boolean;
  interrupting: boolean;
  resultSeen: boolean;
  turn: number;
  window: RunWindow & { open: boolean };
  pendingText: string;
  buffered: RawAdapterEvent[] | null;
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;
  readonly modelCatalog = {
    capabilities: {
      selection: "launch",
      discovery: "suggested",
      customModelInput: true,
      actualModelObservation: true,
      thinkingSelection: false,
      idFormat: "opaque",
    },
    status: "ready",
    models: CODEX_SUGGESTED_MODELS.map((m) => ({ ...m })),
  } satisfies AgentModelCatalog;

  validateModel(model: string): boolean {
    if (!AgentModelIdSchema.safeParse(model).success) return false;
    if (model.includes("..") || model.includes("//")) return false;
    return !/[/:@.]$/.test(model);
  }

  /** Effective Codex home directory (`options.env.CODEX_HOME` -> `process.env.CODEX_HOME` -> `~/.codex`). */
  codexHomeDir(): string {
    const envDir = this.options.env?.CODEX_HOME ?? process.env.CODEX_HOME;
    return typeof envDir === "string" && envDir.length > 0 ? envDir : join(homedir(), ".codex");
  }

  /** Locates `<codexHome>/sessions/<yyyy>/<mm>/<dd>/rollout-*-<sessionId>.jsonl`. */
  resolveSessionPath(sessionId: string | null | undefined): string | null {
    if (!sessionId) return null;
    return codexSessionPath(sessionId, this.codexHomeDir());
  }

  private readonly options: CodexAdapterOptions;
  private readonly workerLogsDir: string | null;
  private readonly runtimes = new Map<string, WorkerRuntime>();
  private readonly listeners: ((e: RawAdapterEvent) => void)[] = [];
  private readonly lastSpecs = new Map<string, StartSpec>();
  private readonly knownSessionIds = new Map<string, string>();
  private launch?: LaunchResolution;

  constructor(options: CodexAdapterOptions) {
    this.options = options;
    this.workerLogsDir = options.workerLogsDir === null ? null : (options.workerLogsDir ?? join(options.stateDir, "logs"));
  }

  get launchResolution(): LaunchResolution {
    this.launch =
      this.launch ??
      this.options.launch ??
      resolveExecutableLaunch(this.options.command ?? codexCommandFromEnv() ?? ["codex"]);
    return this.launch;
  }

  get version(): string | undefined {
    return this.options.version;
  }

  on(event: "worker-event", fn: (e: RawAdapterEvent) => void): void {
    if (event !== "worker-event") throw new Error(`unknown event: ${event}`);
    this.listeners.push(fn);
  }

  private emit(e: RawAdapterEvent): void {
    const runtime = this.runtimes.get(e.workerId);
    if (runtime?.buffered) {
      runtime.buffered.push(e);
      return;
    }
    for (const fn of this.listeners) fn(e);
  }

  private flushBuffered(runtime: WorkerRuntime): void {
    const buffered = runtime.buffered;
    runtime.buffered = null;
    if (!buffered) return;
    for (const event of buffered) {
      for (const fn of this.listeners) fn(event);
    }
  }

  /**
   * Builds headless `codex exec --json` or `codex exec resume --json` arguments:
   * - Injects Otto's stdio MCP server via `-c mcp_servers.otto.*` (no global config edit).
   * - Enforces `--sandbox read-only` + `approval_policy="never"` for `readonly` mode,
   *   and `--dangerously-bypass-approvals-and-sandbox` for `write` mode.
   * - Attaches `-i <path>` image files and `-m <model>` when provided, reading prompt via `-`.
   */
  buildArgs(
    spec: StartSpec,
    mcp: { serverPath: string; reportFile: string; proposalsFile: string },
    imagePaths: string[],
  ): string[] {
    const resumeId = spec.resumeSessionId ?? this.knownSessionIds.get(spec.workerId);
    const args: string[] = resumeId
      ? ["exec", "resume", "--json", "--skip-git-repo-check"]
      : ["exec", "--json", "--skip-git-repo-check", "-C", spec.cwd];

    if (spec.mode === "readonly") {
      if (!resumeId) args.push("-s", "read-only");
      args.push("-c", `sandbox_mode=${tomlString("read-only")}`, "-c", `approval_policy=${tomlString("never")}`);
    } else {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }

    args.push(
      "-c",
      `mcp_servers.otto.command=${tomlString(process.execPath)}`,
      "-c",
      `mcp_servers.otto.args=${tomlStringArray([mcp.serverPath, mcp.reportFile, mcp.proposalsFile])}`,
      "-c",
      "mcp_servers.otto.enabled=true",
      "-c",
      `developer_instructions=${tomlString(WORKER_SYSTEM_PROMPT)}`,
    );

    if (spec.model) args.push("-m", spec.model);
    for (const imagePath of imagePaths) args.push("-i", imagePath);
    if (resumeId) args.push(resumeId);
    args.push("-");
    return args;
  }

  private prepareMcpFiles(workerId: string, serverPath: string): {
    serverPath: string;
    reportFile: string;
    proposalsFile: string;
  } {
    const mcpDir = join(this.options.stateDir, "mcp");
    const reportFile = join(mcpDir, "reports", `codex-${workerId}.json`);
    const proposalsFile = join(mcpDir, "proposals", `proposals-codex-${workerId}.jsonl`);
    rmSync(reportFile, { force: true });
    rmSync(proposalsFile, { force: true });
    return { serverPath, reportFile, proposalsFile };
  }

  private writeTempImages(workerId: string, images: StartSpec["images"]): { tempDir: string; paths: string[] } {
    const tempDir = join(this.options.stateDir, "tmp-images", `codex-${workerId}`);
    rmSync(tempDir, { recursive: true, force: true });
    if (!images || images.length === 0) return { tempDir, paths: [] };
    mkdirSync(tempDir, { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i]!;
      const ext = IMAGE_EXT_BY_MIME[img.mimeType.toLowerCase()] ?? ".png";
      const filePath = join(tempDir, `image-${i}${ext}`);
      writeFileSync(filePath, Buffer.from(img.data, "base64"));
      paths.push(filePath);
    }
    return { tempDir, paths };
  }

  async start(spec: StartSpec): Promise<WorkerHandle> {
    if (this.runtimes.has(spec.workerId)) {
      throw new AdapterError("lock_held", `a codex process for ${spec.workerId} is already running`);
    }
    const launch = this.launchResolution;
    if (launch.error) throw new AdapterError("launch_unresolved", launch.error);
    const assets = installClaudeAssets(this.options.stateDir);
    if (this.workerLogsDir) mkdirSync(this.workerLogsDir, { recursive: true });
    const mcp = this.prepareMcpFiles(spec.workerId, assets.serverPath);
    const { tempDir: imageTempDir, paths: imagePaths } = this.writeTempImages(spec.workerId, spec.images);

    let runtime!: WorkerRuntime;
    const proc = new CodexProcess({
      command: launch.argv,
      args: this.buildArgs(spec, mcp, imagePaths),
      cwd: spec.cwd,
      env: childEnv(process.env, this.options.env),
      stderrFile: this.workerLogsDir ? join(this.workerLogsDir, `codex-${spec.workerId}.log`) : undefined,
      onEvent: (record) => this.onStreamEvent(runtime, spec, record),
      onExit: (info) => this.onExit(runtime, info),
    });

    const initialSessionId = spec.resumeSessionId ?? this.knownSessionIds.get(spec.workerId) ?? null;
    runtime = {
      workerId: spec.workerId,
      process: proc,
      cwd: spec.cwd,
      sessionId: initialSessionId,
      observedModel: null,
      reportFile: mcp.reportFile,
      proposalsFile: mcp.proposalsFile,
      imageTempDir,
      emittedProposalKeys: new Set(),
      liveEntries: [
        {
          id: `live-user-${spec.commandId || spec.workerId}`,
          role: "user",
          text: spec.prompt,
        },
      ],
      stopping: false,
      interrupting: false,
      resultSeen: false,
      turn: 0,
      window: { open: false, aborted: false },
      pendingText: "",
      buffered: [],
    };
    this.runtimes.set(spec.workerId, runtime);
    this.lastSpecs.set(spec.workerId, spec);
    proc.spawn();
    proc.writePrompt(spec.prompt);

    try {
      const started = await proc.waitForThreadStarted(this.options.initTimeoutMs ?? 30_000);
      const threadId = typeof started.thread_id === "string" ? started.thread_id : "";
      if (!threadId || (initialSessionId && UUID_RE.test(initialSessionId) && threadId !== initialSessionId && !spec.resumeSessionId)) {
        // Accept any non-empty thread_id returned by Codex; if resuming, prefer the returned or existing id.
      }
      const sessionId = threadId || initialSessionId;
      if (!sessionId) {
        throw new AdapterError("startup_failed", "codex thread.started event did not provide a thread_id");
      }
      runtime.sessionId = sessionId;
      this.knownSessionIds.set(spec.workerId, sessionId);
      // Keep `sessionFile` unset on WorkerHandle (matching ClaudeAdapter / AntigravityAdapter):
      // `WorkerManager` reserves `worker.sessionFile` for pi's tree-structured session tail
      // inspector (`inspectSessionTail`), whereas Codex manages its own rollout JSONL under
      // `<codexHome>/sessions/...` addressed by `sessionId` via `resolveSessionPath`.
      const handle: WorkerHandle = {
        workerId: spec.workerId,
        sessionId,
        cwd: spec.cwd,
      };
      this.observeModelFromRollout(runtime, spec);
      setImmediate(() => this.flushBuffered(runtime));
      return handle;
    } catch (err) {
      runtime.buffered = null;
      this.runtimes.delete(spec.workerId);
      runtime.stopping = true;
      proc.kill();
      rmSync(imageTempDir, { recursive: true, force: true });
      if (err instanceof AdapterError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new AdapterError("startup_failed", `codex startup failed: ${reason}`);
    }
  }

  async send(
    id: string,
    input: { text: string; images?: { data: string; mimeType: string }[]; commandId?: string },
    how: Delivery,
  ): Promise<{ effect?: string }> {
    if (how !== "prompt") {
      throw new AdapterError("unsupported", `codex cannot ${how} mid-run (no control channel after stdin EOF)`);
    }
    const previous = this.runtimes.get(id);
    if (previous && !previous.process.hasExited) {
      previous.stopping = true;
      this.runtimes.delete(id);
      await previous.process.close(2000);
    }
    const spec = this.lastSpecs.get(id);
    if (!spec) throw new AdapterError("not_found", `no known spec to continue worker ${id}`);
    const resumeSessionId = spec.resumeSessionId ?? this.knownSessionIds.get(id);
    if (!resumeSessionId) {
      throw new AdapterError("not_found", `no known session id to resume codex worker ${id}`);
    }
    await this.start({
      ...spec,
      prompt: input.text,
      commandId: input.commandId ?? spec.commandId,
      resumeSessionId,
      images: input.images,
    });
    return {};
  }

  async interrupt(id: string): Promise<InterruptResult> {
    const runtime = this.require(id);
    if (runtime.resultSeen) {
      runtime.stopping = true;
      this.runtimes.delete(id);
      await runtime.process.close(2000);
      return { returned: [], alreadySettled: true };
    }
    runtime.interrupting = true;
    runtime.process.kill();
    await runtime.process.waitExit();
    return { returned: [] };
  }

  async resume(id: string, reason: string, _options: { commandId?: string } = {}): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.process.hasExited) {
      throw new AdapterError(
        "not_idle",
        "codex cannot resume while a run is in flight; interrupt it or wait for the run to end",
      );
    }
    const spec = this.lastSpecs.get(id);
    if (!spec) throw new AdapterError("not_found", `no known spec to resume worker ${id}`);
    const resumeSessionId = spec.resumeSessionId ?? this.knownSessionIds.get(id);
    if (!resumeSessionId) {
      throw new AdapterError("not_found", `no known session id to resume codex worker ${id}`);
    }
    await this.start({
      ...spec,
      prompt: `${RESUME_PROMPT}\n\nReason: ${reason}`,
      resumeSessionId,
      images: undefined,
    });
  }

  async stopProcess(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.stopping = true;
    this.runtimes.delete(id);
    await runtime.process.close(this.options.stopGraceMs);
    rmSync(runtime.imageTempDir, { recursive: true, force: true });
  }

  isRunning(id: string): boolean {
    const runtime = this.runtimes.get(id);
    return !!runtime && !runtime.process.hasExited;
  }

  isStreaming(id: string): boolean {
    const runtime = this.runtimes.get(id);
    return !!runtime && !runtime.process.hasExited && runtime.window.open;
  }

  workerPids(): Array<{ workerId: string; pid: number }> {
    const out: Array<{ workerId: string; pid: number }> = [];
    for (const [workerId, runtime] of this.runtimes) {
      const pid = runtime.process.pid;
      if (!runtime.process.hasExited && pid !== undefined) out.push({ workerId, pid });
    }
    return out;
  }

  async history(id: string, since: string | undefined, maxBytes: number): Promise<HistoryPage> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.process.hasExited) {
      throw new AdapterError("not_running", `no live codex process for worker ${id}`);
    }
    const diskPath = this.resolveSessionPath(runtime.sessionId);
    if (diskPath) {
      const diskPage = readCodexSessionHistory(diskPath, { since, maxBytes });
      if (diskPage.entries.length > 0 || since) return diskPage;
    }
    return normalizeCodexEntries(runtime.liveEntries, { since, maxBytes });
  }

  workerActivity(): Array<{ workerId: string; pid: number; lastOutputAt: number }> {
    const out: Array<{ workerId: string; pid: number; lastOutputAt: number }> = [];
    for (const [workerId, runtime] of this.runtimes) {
      const pid = runtime.process.pid;
      if (!runtime.process.hasExited && pid !== undefined) {
        out.push({ workerId, pid, lastOutputAt: runtime.process.lastOutputAt });
      }
    }
    return out;
  }

  simulateCrash(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.stopping = true;
      try {
        runtime.process.kill();
      } catch {
        // already gone
      }
    }
    this.runtimes.clear();
  }

  stderrTail(id: string): string {
    return this.runtimes.get(id)?.process.getStderrTail() ?? "";
  }

  private require(id: string): WorkerRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.process.hasExited) {
      throw new AdapterError("not_running", `no live codex process for worker ${id}`);
    }
    return runtime;
  }

  private observeModel(runtime: WorkerRuntime, spec: StartSpec, modelId: unknown): void {
    if (typeof modelId !== "string" || modelId.trim() === "" || runtime.observedModel === modelId) return;
    const observation = AgentModelObservationSchema.safeParse({ id: modelId, source: "init", observedAt: Date.now() });
    if (observation.success) {
      runtime.observedModel = modelId;
      spec.onModelObserved?.(observation.data);
    }
  }

  private observeModelFromRollout(runtime: WorkerRuntime, spec: StartSpec): void {
    if (runtime.observedModel) return;
    const rolloutPath = this.resolveSessionPath(runtime.sessionId);
    if (!rolloutPath || !existsSync(rolloutPath)) return;
    try {
      const lines = readFileSync(rolloutPath, "utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const trimmed = lines[i]?.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { type?: unknown; payload?: Record<string, unknown> | null };
          if ((parsed.type === "turn_context" || parsed.type === "session_meta") && parsed.payload && typeof parsed.payload.model === "string") {
            this.observeModel(runtime, spec, parsed.payload.model);
            return;
          }
        } catch {
          // ignore partial line
        }
      }
    } catch {
      // best-effort rollout observation
    }
  }

  // --- codex exec --json JSONL → RawAdapterEvent --------------------------------------------

  private onStreamEvent(runtime: WorkerRuntime, spec: StartSpec, record: Record<string, unknown>): void {
    switch (record.type) {
      case "thread.started": {
        runtime.window = { open: true, aborted: false };
        if (typeof record.thread_id === "string" && record.thread_id.length > 0) {
          runtime.sessionId = record.thread_id;
          this.knownSessionIds.set(runtime.workerId, record.thread_id);
        }
        this.observeModel(runtime, spec, record.model);
        return;
      }
      case "turn.started": {
        if (!runtime.window.open) runtime.window = { open: true, aborted: false };
        runtime.turn += 1;
        runtime.pendingText = "";
        this.observeModel(runtime, spec, record.model);
        this.observeModelFromRollout(runtime, spec);
        this.emit({ type: "progress", workerId: runtime.workerId, phase: "thinking", turn: runtime.turn });
        return;
      }
      case "item.started": {
        const item = record.item as Record<string, unknown> | undefined;
        if (!item) return;
        const itemType = typeof item.type === "string" ? item.type : "";
        if (itemType === "command_execution") {
          this.emit({
            type: "progress",
            workerId: runtime.workerId,
            phase: "tool",
            tool: "Bash",
            target: typeof item.command === "string" ? item.command.slice(0, 80) : undefined,
            turn: Math.max(1, runtime.turn),
          });
        } else if (itemType === "mcp_tool_call") {
          const toolName = typeof item.tool === "string" ? item.tool : "mcp";
          const displayTool = isCodexReportTool(item.server, item.tool)
            ? "report"
            : isCodexProposalTool(item.server, item.tool)
              ? "propose"
              : toolName;
          this.emit({
            type: "progress",
            workerId: runtime.workerId,
            phase: "tool",
            tool: displayTool,
            target: extractTarget(item.arguments),
            turn: Math.max(1, runtime.turn),
          });
        }
        return;
      }
      case "item.completed": {
        const item = record.item as Record<string, unknown> | undefined;
        if (!item) return;
        const itemType = typeof item.type === "string" ? item.type : "";
        const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : `codex-item-${runtime.turn}-${runtime.liveEntries.length}`;
        if (itemType === "agent_message" && typeof item.text === "string") {
          runtime.pendingText = runtime.pendingText ? `${runtime.pendingText}\n${item.text}` : item.text;
          runtime.liveEntries.push({ id: itemId, role: "assistant", text: item.text });
          runtime.window.lastAssistant = { stopReason: "stop", text: runtime.pendingText };
          this.emit({ type: "progress", workerId: runtime.workerId, phase: "thinking", turn: Math.max(1, runtime.turn) });
          return;
        }
        if (itemType === "command_execution") {
          const cmd = typeof item.command === "string" ? item.command : "";
          runtime.liveEntries.push({
            id: itemId,
            role: "assistant",
            text: "",
            tools: [{ name: "Bash", ...(cmd ? { args: cmd.slice(0, 80) } : {}) }],
          });
          return;
        }
        if (itemType === "file_change") {
          const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
          const firstPath = typeof changes[0]?.path === "string" ? changes[0].path : undefined;
          runtime.liveEntries.push({
            id: itemId,
            role: "assistant",
            text: "",
            tools: [{ name: "Edit", ...(firstPath ? { args: firstPath.slice(0, 80) } : {}) }],
          });
          this.emit({
            type: "progress",
            workerId: runtime.workerId,
            phase: "tool",
            tool: "Edit",
            target: firstPath?.slice(0, 80),
            turn: Math.max(1, runtime.turn),
          });
          return;
        }
        if (itemType === "web_search") {
          const query = typeof item.query === "string" ? item.query : undefined;
          this.emit({
            type: "progress",
            workerId: runtime.workerId,
            phase: "tool",
            tool: "WebSearch",
            target: query?.slice(0, 80),
            turn: Math.max(1, runtime.turn),
          });
          return;
        }
        if (itemType === "mcp_tool_call") {
          const server = item.server;
          const tool = item.tool;
          const args = item.arguments;
          const failed = item.status === "failed";
          if (!failed && isCodexReportTool(server, tool)) {
            const report = normalizeReport(args);
            if (report) runtime.window.report = report;
          } else if (!failed && isCodexProposalTool(server, tool)) {
            const proposal = normalizeProposal(args);
            if (proposal) this.emitProposalOnce(runtime, proposal);
          }
          const displayTool = isCodexReportTool(server, tool)
            ? "report"
            : isCodexProposalTool(server, tool)
              ? "propose"
              : typeof tool === "string"
                ? tool
                : "mcp";
          runtime.liveEntries.push({
            id: itemId,
            role: "assistant",
            text: "",
            tools: [{ name: displayTool, ...(extractTarget(args) ? { args: extractTarget(args) } : {}) }],
          });
          return;
        }
        if (itemType === "error" && typeof item.message === "string") {
          runtime.window.lastAssistant = {
            stopReason: "error",
            errorMessage: item.message,
            text: runtime.pendingText,
          };
        }
        return;
      }
      case "turn.completed": {
        if (!runtime.window.open) return;
        if (!runtime.window.lastAssistant) {
          runtime.window.lastAssistant = { stopReason: "stop", text: runtime.pendingText };
        }
        runtime.resultSeen = true;
        this.observeModelFromRollout(runtime, spec);
        void this.settle(runtime, record);
        return;
      }
      case "turn.failed":
      case "error": {
        if (typeof record.message === "string" && record.message.startsWith("Reconnecting")) {
          // Transient reconnect notice in codex exec --json; turn continues.
          return;
        }
        if (!runtime.window.open) return;
        const errObj = record.error as Record<string, unknown> | undefined;
        const detail =
          (typeof errObj?.message === "string" && errObj.message) ||
          (typeof record.message === "string" && record.message) ||
          runtime.window.lastAssistant?.text?.trim() ||
          "codex turn failed";
        runtime.window.lastAssistant = {
          stopReason: "error",
          errorMessage: detail,
          text: runtime.pendingText,
        };
        runtime.resultSeen = true;
        this.observeModelFromRollout(runtime, spec);
        void this.settle(runtime, record);
        return;
      }
      default:
        return;
    }
  }

  private emitProposalOnce(runtime: WorkerRuntime, proposal: ProposalPayload): void {
    if (runtime.emittedProposalKeys.has(proposal.proposalKey)) return;
    runtime.emittedProposalKeys.add(proposal.proposalKey);
    this.emit({
      type: "proposal",
      workerId: runtime.workerId,
      proposal,
    });
  }

  private async settle(runtime: WorkerRuntime, result: Record<string, unknown>): Promise<void> {
    if (!runtime.window.report && existsSync(runtime.reportFile)) {
      try {
        const report = normalizeReport(JSON.parse(readFileSync(runtime.reportFile, "utf8")));
        if (report) runtime.window.report = report;
      } catch {
        // best-effort fallback
      }
    }
    for (const proposal of readProposalsAuditFile(runtime.proposalsFile)) {
      this.emitProposalOnce(runtime, proposal);
    }
    const facts = runtime.window;
    const adjudicated = adjudicate(facts);
    runtime.window = { open: false, aborted: false };
    runtime.turn = 0;

    const usage: SessionUsage = {};
    const rawUsage = result.usage as Record<string, unknown> | undefined;
    if (rawUsage && typeof rawUsage.input_tokens === "number") {
      const input = rawUsage.input_tokens;
      const output = typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0;
      usage.tokens = { input, output, totalTokens: input + output };
    }

    this.emit({
      type: "settled",
      workerId: runtime.workerId,
      outcome: adjudicated.outcome,
      errorClass: adjudicated.errorClass,
      errorMessage: adjudicated.errorMessage,
      lastText: adjudicated.lastText?.slice(0, 4000),
      report: adjudicated.report,
      ...(usage.tokens ? { usage } : {}),
    });
  }

  private onExit(runtime: WorkerRuntime, info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.runtimes.get(runtime.workerId) === runtime) this.runtimes.delete(runtime.workerId);
    rmSync(runtime.imageTempDir, { recursive: true, force: true });
    if (runtime.interrupting && !runtime.resultSeen && runtime.window.open) {
      runtime.window.aborted = true;
      runtime.window = { open: false, aborted: false };
      this.emit({ type: "settled", workerId: runtime.workerId, outcome: "aborted" });
    }
    this.emit({
      type: "process_exit",
      workerId: runtime.workerId,
      code: info.code,
      signal: info.signal,
      unexpected: !runtime.stopping && !runtime.interrupting && !runtime.resultSeen,
    });
  }
}

export interface CodexProcessOptions {
  command: string[];
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  onEvent: (event: Record<string, unknown>) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  stderrFile?: string;
}

export class CodexProcess {
  private readonly options: CodexProcessOptions;
  private child?: ChildProcess;
  private stdoutBuffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private stderrTail = "";
  private preInitError = "";
  private readonly stderrLimit = 64 * 1024;
  private exited = false;
  private exitWaiters: (() => void)[] = [];
  private lastOutputAtMs = 0;
  private initWaiter:
    | { resolve: (init: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
    | null = null;

  constructor(options: CodexProcessOptions) {
    this.options = options;
  }

  spawn(): void {
    if (this.child) throw new Error("CodexProcess already spawned");
    const child = spawn(this.options.command[0]!, [...this.options.command.slice(1), ...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error("codex process is not piped");
    }
    this.child = child;
    this.lastOutputAtMs = Date.now();
    child.stdout.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    child.on("error", (err) => this.handleExit(null, null, err));
    child.on("exit", (code, signal) => this.handleExit(code, signal));
  }

  writePrompt(prompt: string): void {
    const stdin = this.child?.stdin;
    if (!this.child || this.exited || !stdin) throw new Error("codex process is not running");
    stdin.write(prompt, () => {
      // ignore if stream already closed on fast crash
    });
    stdin.end();
  }

  waitForThreadStarted(timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child) {
        const detail = redactText(this.preInitError || this.stderrTail.slice(-2000));
        reject(new Error(`codex process exited before thread.started; detail:\n${detail}`));
        return;
      }
      const timer = setTimeout(() => {
        this.initWaiter = null;
        const detail = redactText(this.preInitError || this.stderrTail.slice(-2000));
        reject(new Error(`no thread.started within ${timeoutMs}ms; detail:\n${detail}`));
      }, timeoutMs);
      timer.unref?.();
      this.initWaiter = { resolve, reject, timer };
    });
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get lastOutputAt(): number {
    return this.lastOutputAtMs;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  kill(): void {
    if (this.exited || !this.child) return;
    this.child.kill("SIGKILL");
  }

  async close(graceMs = 3000): Promise<void> {
    if (this.exited || !this.child) return;
    const exited = this.waitExit();
    try {
      this.child.stdin?.end();
    } catch {
      // already destroyed
    }
    const killer = setTimeout(() => this.kill(), graceMs);
    killer.unref?.();
    await exited;
    clearTimeout(killer);
  }

  waitExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  private onStdoutChunk(chunk: Buffer): void {
    this.lastOutputAtMs = Date.now();
    this.stdoutBuffer += this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
      let line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.stderrTail += `\n[otto] unparseable stdout line: ${line.slice(0, 200)}\n`;
        continue;
      }
      if (record.type === "thread.started" && this.initWaiter) {
        const waiter = this.initWaiter;
        this.initWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      } else if (this.initWaiter && (record.type === "error" || record.type === "turn.failed")) {
        const errObj = record.error as Record<string, unknown> | undefined;
        const msg =
          (typeof errObj?.message === "string" && errObj.message) ||
          (typeof record.message === "string" && record.message) ||
          "";
        if (msg && !msg.startsWith("Reconnecting")) this.preInitError = msg;
      }
      this.options.onEvent(record);
    }
  }

  private appendStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    this.stderrTail = (this.stderrTail + text).slice(-this.stderrLimit);
    if (this.options.stderrFile) {
      appendCapped(this.options.stderrFile, redactText(text), this.stderrLimit);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.exited) return;
    const trailing = this.decoder.end();
    if (trailing || this.stdoutBuffer.length > 0) {
      this.onStdoutChunk(Buffer.from(`${trailing}\n`, "utf8"));
    }
    this.exited = true;
    if (error) this.appendStderr(Buffer.from(`\n[otto] spawn error: ${error.message}\n`));
    if (this.initWaiter) {
      const waiter = this.initWaiter;
      this.initWaiter = null;
      clearTimeout(waiter.timer);
      const detail = redactText([this.preInitError, this.stderrTail.slice(-2000)].filter(Boolean).join("\n"));
      waiter.reject(new Error(`codex process exited (code=${code} signal=${signal}); stderr tail:\n${detail}`));
    }
    this.options.onExit({ code, signal });
    for (const waiter of this.exitWaiters) waiter();
    this.exitWaiters = [];
  }
}

function readProposalsAuditFile(path: string): ProposalPayload[] {
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const out: ProposalPayload[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = normalizeProposal(JSON.parse(trimmed));
        if (parsed) out.push(parsed);
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function detectCodex(
  command: string[] = codexCommandFromEnv() ?? ["codex"],
  timeoutMs = 5000,
): { installed: boolean; version?: string } {
  try {
    const resolved = resolveExecutableLaunch(command);
    if (resolved.error || !resolved.argv[0]) return { installed: false };
    const [file, ...rest] = resolved.argv;
    const result = spawnSync(file, [...rest, "--version"], { timeout: timeoutMs, encoding: "utf8" });
    if (result.status !== 0 || result.error) return { installed: false };
    const version = String(result.stdout ?? "").trim().split("\n")[0] ?? "";
    return { installed: true, version: version.length > 0 ? version : undefined };
  } catch {
    return { installed: false };
  }
}
