// AcpAdapter: Generic Agent Client Protocol (ACP v1, JSON-RPC 2.0 over stdio) adapter for
// external ACP agents (`opencode acp`, `agentica acp`), driving Otto's `AcpProcess` JSON-RPC
// transport and stdio MCP `report` / `propose` server.
//
// Key invariants adapted from `KKKKhazix/agent-autoloop` (`plugins/acp/agent.ts`):
// 1. Session continuation: prefers `session/resume` when advertised; falls back to
//    `session/load` while keeping `window.open = false` during load so replayed history
//    `session/update` notifications are ignored until `session/prompt` opens the turn.
// 2. Lock contention: ACP `-32000` with `thread_active_writer` / `in use` / `already active`
//    maps to retriable `AdapterError("session_in_use", ..., true)` instead of `auth_required`.
// 3. Worktree `realpath` permission confinement: `session/request_permission` verifies target
//    paths stay inside `realpathSync(cwd)` and selects `allow_once` (never `allow_always`) or
//    `reject_once` when outside the worktree or violating `readonly` mode.
import type {
  AgentAdapter,
  AgentAuthStatus,
  AgentCapabilities,
  CumulativeUsageCursor,
  Delivery,
  InterruptResult,
  ProposalPayload,
  RawAdapterEvent,
  ReportPayload,
  SessionUsage,
  StartSpec,
  WorkerHandle,
  WorkerLiveTelemetry,
  WorkerMode,
} from "./agent.ts";
import { AdapterError, diffCumulativeSessionUsage } from "./agent.ts";
import { adjudicate, type RunWindow } from "./adjudication.ts";
import { childEnv, extractTarget, normalizeProposal, normalizeReport, RESUME_PROMPT } from "./pi-adapter.ts";
import { installClaudeAssets, OTTO_VERSION, WORKER_SYSTEM_PROMPT } from "./install.ts";
import { appendCapped } from "./logger.ts";
import { resolveExecutableLaunch, splitCommandLine, type LaunchResolution } from "./pi-launch.ts";
import { redactText } from "./redact.ts";
import { AgentModelObservationSchema, type AgentModelCatalog } from "@isaac2ingrid/protocol";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type AcpAgentKind = "opencode" | "agentica";

export const OPENCODE_COMMAND_ENV = "OTTO_OPENCODE_COMMAND";
export const AGENTICA_COMMAND_ENV = "OTTO_AGENTICA_COMMAND";

const SAFE_READONLY_TOOL_KINDS = new Set(["read", "search", "think"]);
const WRITE_OR_EXEC_TOOL_NAME_RE = /\b(write|edit|patch|delete|remove|rm|mv|bash|sh|shell|exec|terminal|command|run)\b/i;

export function opencodeCommandFromEnv(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env[OPENCODE_COMMAND_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const argv = splitCommandLine(raw).filter((p) => p.length > 0);
  return argv.length > 0 ? argv : undefined;
}

export function agenticaCommandFromEnv(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env[AGENTICA_COMMAND_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const argv = splitCommandLine(raw).filter((p) => p.length > 0);
  return argv.length > 0 ? argv : undefined;
}

/** Matches Otto's MCP `report` tool across ACP naming conventions (`mcp__otto__report`,
 *  `otto__report`, `otto/report`, `otto:report`), never a bare unrelated `report` tool unless
 *  its ACP title explicitly identifies the `otto` MCP server. */
export function isAcpReportTool(name: unknown, title?: unknown): boolean {
  if (typeof name === "string" && /(?:^mcp__|__|\/|:|\.)report$/i.test(name)) return true;
  if (name === "report" && typeof title === "string" && /\botto\b/i.test(title)) return true;
  return false;
}

/** Matches Otto's MCP `propose` tool across ACP naming conventions (`mcp__otto__propose`,
 *  `otto__propose`, `otto/propose`, `otto:propose`), never a bare unrelated `propose` tool
 *  unless its ACP title explicitly identifies the `otto` MCP server. */
export function isAcpProposalTool(name: unknown, title?: unknown): boolean {
  if (typeof name === "string" && /(?:^mcp__|__|\/|:|\.)propose$/i.test(name)) return true;
  if (name === "propose" && typeof title === "string" && /\botto\b/i.test(title)) return true;
  return false;
}

/** Maps ACP v1 `StopReason` values into Otto's shared adjudication vocabulary. */
export function mapAcpStopReason(stopReason: unknown): string | undefined {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "refusal":
      return "error";
    case "cancelled":
      return "aborted";
    case null:
    case undefined:
      return undefined;
    default:
      return typeof stopReason === "string" ? stopReason : undefined;
  }
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(data !== undefined ? `${message} (${typeof data === "string" ? data : JSON.stringify(data)})` : message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export interface AcpProcessOptions {
  command: string[];
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  redactSecrets?: string[];
  stderrFile?: string;
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onRequest: (id: string | number, method: string, params: Record<string, unknown>) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

interface PendingRpc {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class AcpProcess {
  private readonly options: AcpProcessOptions;
  private child?: ChildProcess;
  private stdoutBuffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private stderrTail = "";
  private readonly stderrLimit = 64 * 1024;
  private exited = false;
  private exitWaiters: (() => void)[] = [];
  private lastOutputAtMs = 0;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRpc>();

  constructor(options: AcpProcessOptions) {
    this.options = options;
  }

  spawn(): void {
    if (this.child) throw new Error("AcpProcess already spawned");
    const child = spawn(this.options.command[0]!, [...this.options.command.slice(1), ...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error("acp process is not piped");
    }
    this.child = child;
    this.lastOutputAtMs = Date.now();
    child.stdout.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    child.on("error", (err) => this.handleExit(null, null, err));
    child.on("exit", (code, signal) => this.handleExit(code, signal));
  }

  rpc(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    return new Promise((resolveRpc, rejectRpc) => {
      if (this.exited || !this.child?.stdin) {
        rejectRpc(new Error(`acp exited before '${method}'; stderr tail:\n${this.stderrTail.slice(-2000)}`));
        return;
      }
      const id = this.nextId++;
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          rejectRpc(new Error(`acp '${method}' timed out after ${timeoutMs}ms; stderr tail:\n${this.stderrTail.slice(-2000)}`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { method, resolve: resolveRpc, reject: rejectRpc, timer });
      this.writeJson({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.exited || !this.child?.stdin) return;
    this.writeJson({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: Record<string, unknown>): void {
    if (this.exited || !this.child?.stdin) return;
    this.writeJson({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    if (this.exited || !this.child?.stdin) return;
    this.writeJson({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private writeJson(payload: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || this.exited) return;
    try {
      stdin.write(JSON.stringify(payload) + "\n");
    } catch {
      // broken pipe; exit handler cleans up
    }
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

  async close(graceMs = 3_000): Promise<void> {
    if (this.exited || !this.child) return;
    const exited = this.waitExit();
    try {
      this.child.stdin?.end();
    } catch {
      // already closed
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // already gone
    }
    const killer = setTimeout(() => this.kill(), graceMs);
    killer.unref?.();
    await exited;
    clearTimeout(killer);
  }

  waitExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolveExit) => this.exitWaiters.push(resolveExit));
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
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.stderrTail += `\n[otto] unparseable acp stdout line: ${line.slice(0, 200)}\n`;
        continue;
      }
      this.dispatchMessage(msg);
    }
  }

  private dispatchMessage(msg: Record<string, unknown>): void {
    const hasMethod = typeof msg.method === "string";
    const hasId = typeof msg.id === "number" || typeof msg.id === "string";

    if (hasId && !hasMethod) {
      const entry = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!entry) return;
      this.pending.delete(msg.id as number);
      if (entry.timer) clearTimeout(entry.timer);
      if ("error" in msg && typeof msg.error === "object" && msg.error !== null) {
        const errObj = msg.error as Record<string, unknown>;
        const code = typeof errObj.code === "number" ? errObj.code : -32603;
        const message = typeof errObj.message === "string" ? errObj.message : `JSON-RPC error ${code}`;
        entry.reject(new JsonRpcError(code, message, errObj.data));
        return;
      }
      const result =
        typeof msg.result === "object" && msg.result !== null ? (msg.result as Record<string, unknown>) : {};
      entry.resolve(result);
      return;
    }

    if (hasId && hasMethod) {
      const params =
        typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
      this.options.onRequest(msg.id as string | number, msg.method as string, params);
      return;
    }

    if (hasMethod) {
      const params =
        typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
      this.options.onNotification(msg.method as string, params);
    }
  }

  private appendStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    const scrubbed = redactText(text, this.options.redactSecrets);
    this.stderrTail = (this.stderrTail + scrubbed).slice(-this.stderrLimit);
    if (this.options.stderrFile) {
      appendCapped(this.options.stderrFile, scrubbed, this.stderrLimit);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    if (error) this.appendStderr(Buffer.from(`\n[otto] spawn error: ${error.message}\n`));
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pendingEntries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(
        new Error(
          `acp exited during '${entry.method}' (code=${code} signal=${signal}); stderr tail:\n${this.stderrTail.slice(-2000)}`,
        ),
      );
    }
    this.options.onExit({ code, signal });
    for (const waiter of this.exitWaiters) waiter();
    this.exitWaiters = [];
  }
}


/** Checks whether a candidate path stays strictly inside `worktreeRoot` after resolving
 *  existing ancestor symlinks via `realpathSync`. */
export function isPathInsideWorktree(candidatePath: string, worktreeRoot: string): boolean {
  if (!candidatePath || candidatePath.includes("\0")) return false;
  let realWorktree: string;
  try {
    realWorktree = realpathSync(resolve(worktreeRoot));
  } catch {
    realWorktree = resolve(worktreeRoot);
  }
  const resolvedCandidate = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(realWorktree, candidatePath);

  // Resolve the deepest existing ancestor so newly-to-be-created files inside a symlinked
  // directory cannot escape `realWorktree`.
  let probe = resolvedCandidate;
  const tailSegments: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tailSegments.unshift(basename(probe));
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = existsSync(probe) ? realpathSync(probe) : probe;
  } catch {
    return false;
  }
  const canonicalTarget = tailSegments.length > 0 ? join(realProbe, ...tailSegments) : realProbe;
  const rel = relative(realWorktree, canonicalTarget);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\")) {
    return false;
  }
  return true;
}

function collectPermissionPaths(toolCall: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (Array.isArray(toolCall.locations)) {
    for (const loc of toolCall.locations) {
      if (typeof loc === "object" && loc !== null) {
        const p = (loc as { path?: unknown }).path;
        if (typeof p === "string" && p.trim().length > 0) paths.push(p.trim());
      }
    }
  }
  const rawInput =
    typeof toolCall.rawInput === "object" && toolCall.rawInput !== null
      ? (toolCall.rawInput as Record<string, unknown>)
      : null;
  if (rawInput) {
    for (const key of ["file_path", "filePath", "path", "filename", "cwd", "directory", "target_file"]) {
      const val = rawInput[key];
      if (typeof val === "string" && val.trim().length > 0) paths.push(val.trim());
    }
  }
  return paths;
}

export interface AcpAdapterOptions {
  kind: AcpAgentKind;
  stateDir: string;
  /** argv prefix for the binary; defaults to `OTTO_OPENCODE_COMMAND` / `["opencode"]` or `["agentica"]`. */
  command?: string[];
  /** Subcommand & extra flags appended on launch; default `["acp"]`. */
  acpArgs?: string[];
  env?: Record<string, string | undefined>;
  workerLogsDir?: string | null;
  version?: string;
  authStatus?: AgentAuthStatus;
  initTimeoutMs?: number;
  cancelGraceMs?: number;
  stopGraceMs?: number;
  launch?: LaunchResolution;
}

interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
  };
  sessionCapabilities?: {
    resume?: Record<string, unknown> | null;
    close?: Record<string, unknown> | null;
    systemPrompt?: Record<string, unknown> | null;
  } | null;
}

interface TrackedToolCall {
  name?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  target?: string;
  startedAt?: number;
  completed?: boolean;
  emittedProgress?: boolean;
  emittedProposal?: boolean;
}

interface AcpWorkerRuntime {
  workerId: string;
  process: AcpProcess;
  cwd: string;
  mode: WorkerMode;
  sessionId: string;
  reportFile: string;
  proposalsFile: string;
  emittedProposalKeys: Set<string>;
  agentCapabilities: AcpAgentCapabilities;
  systemPromptSupported: boolean;
  onModelObserved?: StartSpec["onModelObserved"];
  stopping: boolean;
  interruptingKill: boolean;
  cancelling: boolean;
  turnSeq: number;
  promptInFlight: boolean;
  promptDoneWaiters: (() => void)[];
  turn: number;
  window: RunWindow & { open: boolean };
  currentMessageId: string | null;
  currentMessageText: string;
  toolCalls: Map<string, TrackedToolCall>;
  pendingPermissions: Map<string, { requestId: string | number }>;
  latestUsage?: SessionUsage;
  compactionCount: number;
  lastToolMs: number | null;
  settledCursor?: CumulativeUsageCursor;
  buffered: RawAdapterEvent[] | null;
}

export class AcpAdapter implements AgentAdapter {
  readonly kind: AcpAgentKind;
  readonly capabilities: AgentCapabilities = {
    steer: false,
    followUp: false,
    interrupt: true,
    resume: true,
    history: false,
    images: true,
    structuredReport: true,
    readonly: true,
  };
  readonly modelCatalog: AgentModelCatalog = {
    capabilities: {
      selection: "launch",
      discovery: "none",
      customModelInput: true,
      actualModelObservation: true,
      thinkingSelection: false,
    },
    status: "ready",
    models: [],
  };

  private readonly options: AcpAdapterOptions;
  private readonly workerLogsDir: string | null;
  private readonly runtimes = new Map<string, AcpWorkerRuntime>();
  private readonly listeners: ((e: RawAdapterEvent) => void)[] = [];
  private readonly lastSpecs = new Map<string, StartSpec>();
  private readonly sessionIds = new Map<string, string>();
  private launch?: LaunchResolution;

  constructor(options: AcpAdapterOptions) {
    this.kind = options.kind;
    this.options = options;
    this.workerLogsDir =
      options.workerLogsDir === null ? null : (options.workerLogsDir ?? join(options.stateDir, "logs"));
  }

  get version(): string | undefined {
    return this.options.version;
  }

  get authStatus(): AgentAuthStatus | undefined {
    return this.options.authStatus;
  }

  get launchResolution(): LaunchResolution {
    if (!this.launch) {
      const defaultCmd =
        this.kind === "opencode"
          ? (opencodeCommandFromEnv() ?? ["opencode"])
          : (agenticaCommandFromEnv() ?? ["agentica"]);
      this.launch = this.options.launch ?? resolveExecutableLaunch(this.options.command ?? defaultCmd);
    }
    return this.launch;
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

  private flushBuffered(runtime: AcpWorkerRuntime): void {
    const buffered = runtime.buffered;
    runtime.buffered = null;
    if (!buffered) return;
    for (const event of buffered) {
      for (const fn of this.listeners) fn(event);
    }
  }

  buildArgs(): string[] {
    return [...(this.options.acpArgs ?? ["acp"])];
  }

  private buildMcpServers(
    serverPath: string,
    reportFile: string,
    proposalsFile: string,
  ): Array<Record<string, unknown>> {
    return [
      {
        name: "otto",
        command: process.execPath,
        args: [serverPath, reportFile, proposalsFile],
        env: [],
      },
    ];
  }

  async start(spec: StartSpec): Promise<WorkerHandle> {
    if (this.runtimes.has(spec.workerId)) {
      throw new AdapterError("lock_held", `an ${this.kind} ACP process for ${spec.workerId} is already running`);
    }
    const launch = this.launchResolution;
    if (launch.error) throw new AdapterError("launch_unresolved", launch.error);
    const args = this.buildArgs();

    const assets = installClaudeAssets(this.options.stateDir);
    if (this.workerLogsDir) mkdirSync(this.workerLogsDir, { recursive: true });
    mkdirSync(join(this.options.stateDir, "mcp", "reports"), { recursive: true });
    mkdirSync(join(this.options.stateDir, "mcp", "proposals"), { recursive: true });
    const reportFile = join(this.options.stateDir, "mcp", "reports", `${spec.workerId}.json`);
    const proposalsFile = join(this.options.stateDir, "mcp", "proposals", `proposals-${spec.workerId}.jsonl`);
    rmSync(reportFile, { force: true });
    rmSync(proposalsFile, { force: true });

    const env = childEnv(process.env, this.options.env);
    if (!env.HOME) env.HOME = homedir();

    let runtime!: AcpWorkerRuntime;
    const proc = new AcpProcess({
      command: launch.argv,
      args,
      cwd: spec.cwd,
      env,
      stderrFile: this.workerLogsDir ? join(this.workerLogsDir, `${this.kind}-${spec.workerId}.log`) : undefined,
      onNotification: (method, params) => this.onNotification(runtime, method, params),
      onRequest: (id, method, params) => this.onAgentRequest(runtime, id, method, params),
      onExit: (info) => this.onExit(runtime, info),
    });

    runtime = {
      workerId: spec.workerId,
      process: proc,
      cwd: spec.cwd,
      mode: spec.mode,
      sessionId: spec.resumeSessionId ?? "",
      reportFile,
      proposalsFile,
      emittedProposalKeys: new Set(),
      agentCapabilities: {},
      systemPromptSupported: false,
      onModelObserved: spec.onModelObserved,
      stopping: false,
      interruptingKill: false,
      cancelling: false,
      turnSeq: 0,
      promptInFlight: false,
      promptDoneWaiters: [],
      turn: 0,
      window: { open: false, aborted: false },
      currentMessageId: null,
      currentMessageText: "",
      toolCalls: new Map(),
      pendingPermissions: new Map(),
      compactionCount: 0,
      lastToolMs: null,
      buffered: [],
    };
    this.runtimes.set(spec.workerId, runtime);
    proc.spawn();

    const initTimeout = this.options.initTimeoutMs ?? 30_000;
    try {
      const initRes = await proc.rpc(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "otto-connector", title: "Otto Connector", version: OTTO_VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            auth: { terminal: false },
          },
        },
        initTimeout,
      );

      const agentCapabilities =
        typeof initRes.agentCapabilities === "object" && initRes.agentCapabilities !== null
          ? (initRes.agentCapabilities as AcpAgentCapabilities)
          : {};
      runtime.agentCapabilities = agentCapabilities;
      runtime.systemPromptSupported = Boolean(agentCapabilities.sessionCapabilities?.systemPrompt);

      if (spec.images && spec.images.length > 0 && agentCapabilities.promptCapabilities?.image === false) {
        throw new AdapterError(
          "unsupported_capability",
          `${this.kind} ACP server reported promptCapabilities.image=false`,
        );
      }

      const mcpServers = this.buildMcpServers(assets.serverPath, reportFile, proposalsFile);
      const sessionRes = await this.openOrContinueSession(proc, runtime, spec, mcpServers, initTimeout);
      const sessionId =
        typeof sessionRes.sessionId === "string" && sessionRes.sessionId.length > 0
          ? sessionRes.sessionId
          : spec.resumeSessionId ?? "";
      if (!sessionId) {
        throw new AdapterError("startup_failed", `${this.kind} ACP session setup returned an empty sessionId`);
      }
      runtime.sessionId = sessionId;
      this.sessionIds.set(spec.workerId, sessionId);
      this.lastSpecs.set(spec.workerId, spec);

      await this.applyAndObserveModel(proc, runtime, sessionRes, spec.model, initTimeout);

      try {
        spec.onSession?.(null, null);
      } catch {
        // bookkeeping must never abort launch
      }

      const includeSystemPrompt = !runtime.systemPromptSupported && !spec.resumeSessionId;
      const readonlyNotice =
        spec.mode === "readonly"
          ? "\n\n[READ-ONLY MODE]: Do not modify, create, or delete any files or run mutating shell commands. Inspect only and submit findings via the `report` tool."
          : "";
      const promptBlocks = buildAcpPromptBlocks(`${spec.prompt}${readonlyNotice}`, spec.images, includeSystemPrompt);
      this.beginPromptTurn(runtime, promptBlocks);
      try {
        spec.onPromptAccepted?.();
      } catch {
        // bookkeeping must never abort launch
      }

      const handle: WorkerHandle = { workerId: spec.workerId, sessionId, cwd: spec.cwd };
      setImmediate(() => this.flushBuffered(runtime));
      return handle;
    } catch (err) {
      runtime.buffered = null;
      this.runtimes.delete(spec.workerId);
      runtime.stopping = true;
      await proc.close(500).catch(() => proc.kill());
      if (err instanceof AdapterError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      const stderr = proc.getStderrTail().trim();
      throw new AdapterError(
        "startup_failed",
        `${this.kind} acp startup failed: ${reason}${stderr ? ` [${stderr.slice(-300)}]` : ""}`,
      );
    }
  }

  private async openOrContinueSession(
    proc: AcpProcess,
    runtime: AcpWorkerRuntime,
    spec: StartSpec,
    mcpServers: Array<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const systemPrompt = runtime.systemPromptSupported
      ? { mode: "append", content: [{ type: "text", text: WORKER_SYSTEM_PROMPT }] }
      : undefined;

    try {
      if (!spec.resumeSessionId) {
        return await proc.rpc(
          "session/new",
          {
            cwd: spec.cwd,
            mcpServers,
            ...(systemPrompt ? { systemPrompt } : {}),
          },
          timeoutMs,
        );
      }
      if (runtime.agentCapabilities.sessionCapabilities?.resume) {
        return await proc.rpc(
          "session/resume",
          {
            sessionId: spec.resumeSessionId,
            cwd: spec.cwd,
            mcpServers,
            ...(systemPrompt ? { systemPrompt } : {}),
          },
          timeoutMs,
        );
      }
      if (runtime.agentCapabilities.loadSession === true) {
        // `window.open` stays false throughout `session/load` so replayed historical
        // `session/update` chunks are discarded cleanly before `beginPromptTurn`.
        return await proc.rpc(
          "session/load",
          {
            sessionId: spec.resumeSessionId,
            cwd: spec.cwd,
            mcpServers,
            ...(systemPrompt ? { systemPrompt } : {}),
          },
          timeoutMs,
        );
      }
      throw new AdapterError(
        "startup_failed",
        `${this.kind} acp cannot resume session ${spec.resumeSessionId}: neither session/resume nor loadSession is advertised`,
      );
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if (err instanceof JsonRpcError && err.code === -32000) {
        const text = `${err.message} ${typeof err.data === "string" ? err.data : JSON.stringify(err.data ?? "")}`;
        if (/(thread_active_writer|session_in_use|already[_\s-]?active|in[_\s-]?use|session.*locked|busy)/i.test(text)) {
          throw new AdapterError(
            "session_in_use",
            `${this.kind} session ${spec.resumeSessionId ?? spec.workerId} is currently held by another active writer: ${err.message}`,
            true,
          );
        }
        throw new AdapterError(
          "auth_required",
          `${this.kind} ACP requires local sign-in or provider API credentials: ${err.message}`,
        );
      }
      throw err;
    }
  }

  private async applyAndObserveModel(
    proc: AcpProcess,
    runtime: AcpWorkerRuntime,
    sessionRes: Record<string, unknown>,
    requestedModel: string | undefined,
    timeoutMs: number,
  ): Promise<void> {
    let latest = sessionRes;
    const configOptions = Array.isArray(sessionRes.configOptions)
      ? (sessionRes.configOptions as Array<Record<string, unknown>>)
      : [];
    const modelOpt = configOptions.find(
      (o) => (o.category === "model" || o.id === "model") && typeof o.id === "string",
    );
    if (requestedModel) {
      if (modelOpt && typeof modelOpt.id === "string" && modelOpt.currentValue !== requestedModel) {
        latest = await proc.rpc(
          "session/set_config_option",
          { sessionId: runtime.sessionId, configId: modelOpt.id, value: requestedModel },
          timeoutMs,
        );
      } else if (!modelOpt) {
        await proc
          .rpc("session/set_model", { sessionId: runtime.sessionId, modelId: requestedModel }, timeoutMs)
          .then((r) => {
            latest = { ...sessionRes, ...r, models: { currentModelId: requestedModel } };
          })
          .catch(() => undefined);
      }
    }
    const observed = extractObservedModel(latest);
    if (observed) {
      const parsed = AgentModelObservationSchema.safeParse({
        id: observed,
        source: "state",
        observedAt: Date.now(),
      });
      if (parsed.success) runtime.onModelObserved?.(parsed.data);
    }
  }

  async send(
    id: string,
    input: { text: string; images?: { data: string; mimeType: string }[]; commandId?: string },
    how: Delivery,
  ): Promise<{ effect?: string }> {
    if (how !== "prompt") {
      throw new AdapterError("unsupported", `${this.kind} cannot ${how} mid-run over ACP v1`);
    }
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.process.hasExited) {
      if (runtime.promptInFlight) {
        throw new AdapterError("busy", `${this.kind} worker ${id} already has a prompt turn in flight`);
      }
      if (input.images && input.images.length > 0 && runtime.agentCapabilities.promptCapabilities?.image === false) {
        throw new AdapterError(
          "unsupported_capability",
          `${this.kind} ACP server reported promptCapabilities.image=false`,
        );
      }
      runtime.buffered = [];
      this.beginPromptTurn(runtime, buildAcpPromptBlocks(input.text, input.images, false));
      setImmediate(() => this.flushBuffered(runtime));
      return {};
    }
    const spec = this.lastSpecs.get(id);
    const resumeSessionId = this.sessionIds.get(id) ?? spec?.resumeSessionId;
    if (!spec || !resumeSessionId) {
      throw new AdapterError("not_found", `no known session to continue ${this.kind} worker ${id}`);
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
    if (!runtime.promptInFlight || !runtime.window.open) {
      return { returned: [], alreadySettled: true };
    }
    runtime.cancelling = true;
    for (const pending of runtime.pendingPermissions.values()) {
      runtime.process.respond(pending.requestId, { outcome: { outcome: "cancelled" } });
    }
    runtime.pendingPermissions.clear();
    runtime.process.notify("session/cancel", { sessionId: runtime.sessionId });

    const settledGracefully = await this.waitForPromptTurnDone(runtime, this.options.cancelGraceMs ?? 3_000);
    if (!settledGracefully && !runtime.process.hasExited) {
      runtime.interruptingKill = true;
      runtime.process.kill();
      await runtime.process.waitExit();
    }
    return { returned: [] };
  }

  async resume(id: string, reason: string, options: { commandId?: string } = {}): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.process.hasExited) {
      if (runtime.promptInFlight) {
        throw new AdapterError("not_idle", `${this.kind} cannot resume while a prompt turn is in flight`);
      }
      runtime.buffered = [];
      this.beginPromptTurn(runtime, buildAcpPromptBlocks(`${RESUME_PROMPT}\n\nReason: ${reason}`, undefined, false));
      setImmediate(() => this.flushBuffered(runtime));
      return;
    }
    const spec = this.lastSpecs.get(id);
    const resumeSessionId = this.sessionIds.get(id) ?? spec?.resumeSessionId;
    if (!spec || !resumeSessionId) {
      throw new AdapterError("not_found", `no known spec to resume ${this.kind} worker ${id}`);
    }
    await this.start({
      ...spec,
      prompt: `${RESUME_PROMPT}\n\nReason: ${reason}`,
      commandId: options.commandId ?? spec.commandId,
      resumeSessionId,
    });
  }

  async stopProcess(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.stopping = true;
    this.runtimes.delete(id);
    for (const pending of runtime.pendingPermissions.values()) {
      runtime.process.respond(pending.requestId, { outcome: { outcome: "cancelled" } });
    }
    runtime.pendingPermissions.clear();
    if (runtime.agentCapabilities.sessionCapabilities?.close && runtime.sessionId && !runtime.process.hasExited) {
      await runtime.process.rpc("session/close", { sessionId: runtime.sessionId }, 1_000).catch(() => undefined);
    }
    await runtime.process.close(this.options.stopGraceMs);
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

  private require(id: string): AcpWorkerRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.process.hasExited) {
      throw new AdapterError("not_running", `no live ${this.kind} process for worker ${id}`);
    }
    return runtime;
  }

  private emitProposalOnce(runtime: AcpWorkerRuntime, proposal: ProposalPayload): void {
    if (runtime.emittedProposalKeys.has(proposal.proposalKey)) return;
    runtime.emittedProposalKeys.add(proposal.proposalKey);
    this.emit({ type: "proposal", workerId: runtime.workerId, proposal });
  }

  private beginPromptTurn(runtime: AcpWorkerRuntime, promptBlocks: Array<Record<string, unknown>>): void {
    rmSync(runtime.reportFile, { force: true });
    rmSync(runtime.proposalsFile, { force: true });
    runtime.emittedProposalKeys.clear();
    runtime.turnSeq += 1;
    const seq = runtime.turnSeq;
    runtime.promptInFlight = true;
    runtime.cancelling = false;
    runtime.turn = 1;
    runtime.window = { open: true, aborted: false };
    runtime.currentMessageId = null;
    runtime.currentMessageText = "";
    runtime.toolCalls.clear();
    runtime.pendingPermissions.clear();

    this.emit({ type: "progress", workerId: runtime.workerId, phase: "thinking", turn: runtime.turn });

    runtime.process
      .rpc("session/prompt", { sessionId: runtime.sessionId, prompt: promptBlocks })
      .then(
        (res) => this.onPromptResponse(runtime, seq, res),
        (err) => this.onPromptError(runtime, seq, err),
      );
  }

  private waitForPromptTurnDone(runtime: AcpWorkerRuntime, timeoutMs: number): Promise<boolean> {
    if (!runtime.promptInFlight) return Promise.resolve(true);
    return new Promise((resolveDone) => {
      const waiter = () => {
        clearTimeout(timer);
        resolveDone(true);
      };
      const timer = setTimeout(() => {
        const idx = runtime.promptDoneWaiters.indexOf(waiter);
        if (idx !== -1) runtime.promptDoneWaiters.splice(idx, 1);
        resolveDone(false);
      }, timeoutMs);
      timer.unref?.();
      runtime.promptDoneWaiters.push(waiter);
    });
  }

  private notifyPromptTurnDone(runtime: AcpWorkerRuntime): void {
    runtime.promptInFlight = false;
    const waiters = runtime.promptDoneWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private onNotification(runtime: AcpWorkerRuntime, method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const update =
      typeof params.update === "object" && params.update !== null
        ? (params.update as Record<string, unknown>)
        : undefined;
    if (!update || typeof update.sessionUpdate !== "string") return;

    if (update.sessionUpdate === "config_option_update") {
      const observed = extractObservedModel(update);
      if (observed) {
        const parsed = AgentModelObservationSchema.safeParse({
          id: observed,
          source: "session",
          observedAt: Date.now(),
        });
        if (parsed.success) runtime.onModelObserved?.(parsed.data);
      }
      return;
    }

    // Critical `session/load` rule: ignore replayed history notifications before `window.open`.
    if (!runtime.window.open) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content =
          typeof update.content === "object" && update.content !== null
            ? (update.content as Record<string, unknown>)
            : undefined;
        const messageId = typeof update.messageId === "string" ? update.messageId : null;
        if (messageId !== null && runtime.currentMessageId !== null && messageId !== runtime.currentMessageId) {
          runtime.currentMessageText = "";
        }
        if (messageId !== null) runtime.currentMessageId = messageId;
        if (content?.type === "text" && typeof content.text === "string") {
          runtime.currentMessageText += content.text;
          runtime.window.lastAssistant = {
            stopReason: "stop",
            text: runtime.currentMessageText,
          };
        }
        this.emit({ type: "progress", workerId: runtime.workerId, phase: "thinking", turn: runtime.turn });
        return;
      }
      case "agent_thought_chunk": {
        this.emit({ type: "progress", workerId: runtime.workerId, phase: "thinking", turn: runtime.turn });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : `call-${runtime.toolCalls.size}`;
        const existing = runtime.toolCalls.get(toolCallId) ?? {};
        if (existing.startedAt === undefined) existing.startedAt = Date.now();
        if (typeof update.name === "string" && update.name.length > 0) existing.name = update.name;
        if (typeof update.title === "string" && update.title.length > 0) existing.title = update.title;
        if (typeof update.kind === "string" && update.kind.length > 0) existing.kind = update.kind;
        if (typeof update.rawInput === "object" && update.rawInput !== null) existing.rawInput = update.rawInput;
        const rawTarget = extractTarget(existing.rawInput);
        if (rawTarget) existing.target = rawTarget;
        if ((update.status === "completed" || update.status === "failed") && !existing.completed && existing.startedAt !== undefined) {
          existing.completed = true;
          runtime.lastToolMs = Math.max(0, Date.now() - existing.startedAt);
        }
        runtime.toolCalls.set(toolCallId, existing);

        const isReport = isAcpReportTool(existing.name, existing.title);
        const isProposal = isAcpProposalTool(existing.name, existing.title);
        if (isReport && existing.rawInput !== undefined) {
          const normalized = normalizeReport(existing.rawInput);
          if (normalized) runtime.window.report = normalized;
        } else {
          runtime.window.hadWork = true;
          if (isProposal && existing.rawInput !== undefined && !existing.emittedProposal) {
            const normalized = normalizeProposal(existing.rawInput);
            if (normalized) {
              existing.emittedProposal = true;
              this.emitProposalOnce(runtime, normalized);
            }
          }
        }

        if (!existing.emittedProgress) {
          existing.emittedProgress = true;
          runtime.turn += 1;
          if (runtime.currentMessageId === null) runtime.currentMessageText = "";
          const label = isReport
            ? "report"
            : isProposal
              ? "propose"
              : existing.name ?? existing.kind ?? (existing.title ? existing.title.slice(0, 40) : "tool");
          const telemetry = this.snapshotTelemetry(runtime);
          this.emit({
            type: "progress",
            workerId: runtime.workerId,
            phase: "tool",
            tool: label,
            target: existing.target,
            turn: runtime.turn,
            ...(telemetry ? { telemetry } : {}),
          });
        }
        return;
      }
      case "usage_update": {
        const used = typeof update.used === "number" ? update.used : undefined;
        const size = typeof update.size === "number" ? update.size : undefined;
        const costObj =
          typeof update.cost === "object" && update.cost !== null ? (update.cost as Record<string, unknown>) : null;
        const usage: SessionUsage = { ...(runtime.latestUsage ?? {}) };
        if (used !== undefined || size !== undefined) {
          usage.contextUsage = {
            tokens: used ?? null,
            ...(size !== undefined ? { contextWindow: size } : {}),
            percent:
              used !== undefined && size !== undefined && size > 0
                ? Math.round((used / size) * 1000) / 10
                : null,
          };
        }
        if (costObj && typeof costObj.amount === "number" && costObj.currency === "USD") {
          usage.cost = costObj.amount;
        }
        runtime.latestUsage = usage;
        return;
      }
      default:
        return;
    }
  }

  private onAgentRequest(
    runtime: AcpWorkerRuntime,
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "session/request_permission") {
      this.handlePermissionRequest(runtime, id, params);
      return;
    }
    if (method === "elicitation/create") {
      runtime.process.respond(id, { action: "decline" });
      return;
    }
    runtime.process.respondError(id, -32601, `method not supported by otto connector: ${method}`);
  }

  private handlePermissionRequest(
    runtime: AcpWorkerRuntime,
    id: string | number,
    params: Record<string, unknown>,
  ): void {
    if (runtime.cancelling || runtime.stopping) {
      runtime.process.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const options = Array.isArray(params.options) ? (params.options as Array<Record<string, unknown>>) : [];
    const toolCall =
      typeof params.toolCall === "object" && params.toolCall !== null
        ? (params.toolCall as Record<string, unknown>)
        : {};
    const isReport = isAcpReportTool(toolCall.name, toolCall.title);
    const isProposal = isAcpProposalTool(toolCall.name, toolCall.title);
    if (isReport && toolCall.rawInput !== undefined) {
      const normalized = normalizeReport(toolCall.rawInput);
      if (normalized) runtime.window.report = normalized;
    } else if (isProposal && toolCall.rawInput !== undefined) {
      const normalized = normalizeProposal(toolCall.rawInput);
      if (normalized) this.emitProposalOnce(runtime, normalized);
    }

    const candidatePaths = collectPermissionPaths(toolCall);
    const confinedToWorktree = candidatePaths.every((p) => isPathInsideWorktree(p, runtime.cwd));

    const kind = typeof toolCall.kind === "string" ? toolCall.kind.toLowerCase() : undefined;
    const nameOrTitle = `${typeof toolCall.name === "string" ? toolCall.name : ""} ${typeof toolCall.title === "string" ? toolCall.title : ""}`;
    const looksMutating = WRITE_OR_EXEC_TOOL_NAME_RE.test(nameOrTitle);
    const allowInMode =
      isReport ||
      isProposal ||
      (runtime.mode === "write"
        ? true
        : (kind !== undefined && SAFE_READONLY_TOOL_KINDS.has(kind)) || (!kind && !looksMutating));

    const allow = (isReport || isProposal) ? true : (confinedToWorktree && allowInMode);
    const picked = pickOnceOption(options, allow);
    if (!picked) {
      runtime.process.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    runtime.process.respond(id, { outcome: { outcome: "selected", optionId: picked } });
  }

  private onPromptResponse(runtime: AcpWorkerRuntime, seq: number, res: Record<string, unknown>): void {
    if (seq !== runtime.turnSeq || !runtime.window.open) return;
    const stopReason = mapAcpStopReason(res.stopReason);
    if (stopReason === "aborted" || runtime.cancelling) {
      runtime.window.aborted = true;
    } else if (stopReason === "error") {
      runtime.window.lastAssistant = {
        stopReason: "error",
        errorMessage: runtime.currentMessageText || `${this.kind} refused or aborted the turn`,
        text: runtime.currentMessageText,
      };
    } else if (runtime.window.lastAssistant) {
      runtime.window.lastAssistant.stopReason = stopReason ?? "stop";
    } else {
      runtime.window.lastAssistant = { stopReason: stopReason ?? "stop", text: runtime.currentMessageText };
    }
    this.settleTurn(runtime, res);
  }

  private onPromptError(runtime: AcpWorkerRuntime, seq: number, err: unknown): void {
    if (seq !== runtime.turnSeq || !runtime.window.open) return;
    if (runtime.process.hasExited || runtime.stopping || runtime.interruptingKill) {
      this.notifyPromptTurnDone(runtime);
      return;
    }
    if (runtime.cancelling || (err instanceof JsonRpcError && err.code === -32800)) {
      runtime.window.aborted = true;
      this.settleTurn(runtime, {});
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    runtime.window.lastAssistant = {
      stopReason: "error",
      errorMessage: detail,
      text: runtime.currentMessageText,
    };
    this.settleTurn(runtime, {});
  }

  private settleTurn(runtime: AcpWorkerRuntime, promptResult: Record<string, unknown>): void {
    for (const proposal of readProposalsFile(runtime.proposalsFile)) {
      this.emitProposalOnce(runtime, proposal);
    }
    const fileReport = readReportFile(runtime.reportFile);
    if (fileReport) runtime.window.report = fileReport;

    const adjudicated = adjudicate(runtime.window);
    runtime.window = { open: false, aborted: false };
    runtime.cancelling = false;
    runtime.turn = 0;
    this.notifyPromptTurnDone(runtime);

    const usage = mergeAcpPromptUsage(runtime.latestUsage, promptResult);
    const { turnUsage, nextCursor } = diffCumulativeSessionUsage(runtime.settledCursor, usage);
    runtime.settledCursor = nextCursor;
    const telemetry = this.snapshotTelemetry(runtime);
    runtime.lastToolMs = null;

    this.emit({
      type: "settled",
      workerId: runtime.workerId,
      outcome: adjudicated.outcome,
      errorClass: adjudicated.errorClass,
      limitedUntil: adjudicated.limitedUntil,
      errorMessage: adjudicated.errorMessage,
      lastText: adjudicated.lastText?.slice(0, 4000),
      report: adjudicated.report,
      ...(usage ? { usage } : {}),
      ...(turnUsage ? { turnUsage } : {}),
      ...(telemetry ? { telemetry } : {}),
    });
  }

  private snapshotTelemetry(runtime: AcpWorkerRuntime): WorkerLiveTelemetry | undefined {
    const cu = runtime.latestUsage?.contextUsage;
    const out: WorkerLiveTelemetry = {};
    if (cu) {
      if (typeof cu.tokens === "number" && Number.isFinite(cu.tokens) && cu.tokens >= 0) {
        out.contextTokens = Math.round(cu.tokens);
      }
      if (typeof cu.contextWindow === "number" && Number.isFinite(cu.contextWindow) && cu.contextWindow > 0) {
        out.contextWindow = Math.round(cu.contextWindow);
      }
      if (typeof cu.percent === "number" && Number.isFinite(cu.percent) && cu.percent >= 0) {
        out.contextPercent = Math.round(cu.percent);
      }
    }
    if (runtime.compactionCount > 0) out.compactionCount = runtime.compactionCount;
    if (runtime.lastToolMs !== null) out.lastToolMs = runtime.lastToolMs;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private onExit(runtime: AcpWorkerRuntime, info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.runtimes.get(runtime.workerId) === runtime) this.runtimes.delete(runtime.workerId);
    const wasInFlight = runtime.window.open;
    if (runtime.interruptingKill && runtime.window.open) {
      runtime.window.aborted = true;
      runtime.window = { open: false, aborted: false };
      this.notifyPromptTurnDone(runtime);
      this.emit({ type: "settled", workerId: runtime.workerId, outcome: "aborted" });
    } else {
      runtime.window = { open: false, aborted: false };
      this.notifyPromptTurnDone(runtime);
    }
    this.emit({
      type: "process_exit",
      workerId: runtime.workerId,
      code: info.code,
      signal: info.signal,
      unexpected: wasInFlight && !runtime.stopping && !runtime.interruptingKill && runtime.buffered === null,
    });
  }
}

function buildAcpPromptBlocks(
  text: string,
  images: StartSpec["images"],
  prependWorkerSystemPrompt: boolean,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (prependWorkerSystemPrompt) {
    blocks.push({ type: "text", text: WORKER_SYSTEM_PROMPT });
  }
  blocks.push({ type: "text", text });
  for (const img of images ?? []) {
    blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  return blocks;
}

/** Never selects `allow_always` when `allow_once` exists so persistent CLI configs stay untouched. */
function pickOnceOption(options: Array<Record<string, unknown>>, allow: boolean): string | null {
  const getId = (o: Record<string, unknown>): string | null =>
    typeof o.optionId === "string" ? o.optionId : typeof o.id === "string" ? o.id : null;
  const norm = (k: unknown): string => (typeof k === "string" ? k.trim().toLowerCase().replace(/-/g, "_") : "");
  const targets = allow ? ["allow_once", "allow", "allow_always"] : ["reject_once", "reject", "reject_always"];
  for (const target of targets) {
    for (const o of options) {
      if (norm(o.kind) === target) {
        const id = getId(o);
        if (id) return id;
      }
    }
  }
  return null;
}

function extractObservedModel(payload: Record<string, unknown>): string | null {
  if (Array.isArray(payload.configOptions)) {
    for (const raw of payload.configOptions) {
      if (typeof raw !== "object" || raw === null) continue;
      const opt = raw as Record<string, unknown>;
      if ((opt.category === "model" || opt.id === "model") && typeof opt.currentValue === "string" && opt.currentValue) {
        return opt.currentValue;
      }
    }
  }
  const models =
    typeof payload.models === "object" && payload.models !== null ? (payload.models as Record<string, unknown>) : null;
  if (models && typeof models.currentModelId === "string" && models.currentModelId) {
    return models.currentModelId;
  }
  return null;
}

function readReportFile(path: string): ReportPayload | null {
  if (!existsSync(path)) return null;
  try {
    return normalizeReport(JSON.parse(readFileSync(path, "utf8").trim()));
  } catch {
    return null;
  }
}

function readProposalsFile(path: string): ProposalPayload[] {
  if (!existsSync(path)) return [];
  try {
    const out: ProposalPayload[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const p = normalizeProposal(JSON.parse(trimmed));
        if (p) out.push(p);
      } catch {
        // ignore malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function mergeAcpPromptUsage(
  latestUsage: SessionUsage | undefined,
  promptResult: Record<string, unknown>,
): SessionUsage | undefined {
  const meta =
    typeof promptResult._meta === "object" && promptResult._meta !== null
      ? (promptResult._meta as Record<string, unknown>)
      : undefined;
  const rawUsage =
    (typeof promptResult.usage === "object" && promptResult.usage !== null
      ? (promptResult.usage as Record<string, unknown>)
      : undefined) ??
    (meta && typeof meta.usage === "object" && meta.usage !== null
      ? (meta.usage as Record<string, unknown>)
      : undefined);
  if (!latestUsage && !rawUsage) return undefined;
  const out: SessionUsage = { ...(latestUsage ?? {}) };
  if (rawUsage) {
    const baseIn =
      typeof rawUsage.input_tokens === "number"
        ? rawUsage.input_tokens
        : typeof rawUsage.inputTokens === "number"
          ? rawUsage.inputTokens
          : undefined;
    const cachedIn =
      (typeof rawUsage.cache_read_input_tokens === "number" ? rawUsage.cache_read_input_tokens : 0) +
      (typeof rawUsage.cache_creation_input_tokens === "number" ? rawUsage.cache_creation_input_tokens : 0) +
      (typeof rawUsage.cachedInputTokens === "number" ? rawUsage.cachedInputTokens : 0);
    const input = baseIn !== undefined ? baseIn + cachedIn : undefined;
    const output =
      typeof rawUsage.output_tokens === "number"
        ? rawUsage.output_tokens
        : typeof rawUsage.outputTokens === "number"
          ? rawUsage.outputTokens
          : 0;
    const total =
      typeof rawUsage.total_tokens === "number"
        ? rawUsage.total_tokens
        : typeof rawUsage.totalTokens === "number"
          ? rawUsage.totalTokens
          : input !== undefined
            ? input + output
            : undefined;
    if (input !== undefined || total !== undefined) {
      out.tokens = {
        ...(input !== undefined ? { input } : {}),
        ...(input !== undefined ? { output } : {}),
        ...(total !== undefined ? { totalTokens: total } : {}),
        ...(cachedIn > 0 ? { cachedInputTokens: cachedIn } : {}),
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function detectAcpBinary(
  command: string[],
  timeoutMs = 5_000,
): { installed: boolean; version?: string; authStatus?: AgentAuthStatus } {
  try {
    const resolved = resolveExecutableLaunch(command);
    if (resolved.error) return { installed: false };
    const [file, ...rest] = resolved.argv;
    if (!file) return { installed: false };
    const ver = spawnSync(file, [...rest, "--version"], { timeout: timeoutMs, encoding: "utf8" });
    if (ver.status !== 0 || ver.error) return { installed: false };
    const acp = spawnSync(file, [...rest, "acp", "--help"], { timeout: timeoutMs, encoding: "utf8" });
    if (acp.status !== 0 || acp.error) return { installed: false };
    const version = String(ver.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
    return {
      installed: true,
      version: version.length > 0 ? version : undefined,
      authStatus: "unknown",
    };
  } catch {
    return { installed: false };
  }
}

export function detectOpenCode(
  command: string[] = opencodeCommandFromEnv() ?? ["opencode"],
  timeoutMs = 5_000,
): { installed: boolean; version?: string; authStatus?: AgentAuthStatus } {
  return detectAcpBinary(command, timeoutMs);
}

export function detectAgentica(
  command: string[] = agenticaCommandFromEnv() ?? ["agentica"],
  timeoutMs = 5_000,
): { installed: boolean; version?: string; authStatus?: AgentAuthStatus } {
  return detectAcpBinary(command, timeoutMs);
}
