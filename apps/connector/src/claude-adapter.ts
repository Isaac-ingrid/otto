// ClaudeAdapter: the second AgentAdapter implementation (issue #17, ADR-0001 decision 3;
// connector-pi.md §15 item 8; spike-conclusions §2 "Claude Code headless"). Claude Code
// becomes a worker the steward can dispatch to: headless `claude -p` with stream-json
// output, an Otto MCP `report` tool, and the SAME outcome-adjudication path as pi.
//
// Where the agents differ, the capabilities say so honestly (§3) and the WorkerManager
// degrades: headless print mode has no control channel after stdin hits EOF, so there is no
// mid-run steer and no queued follow-up — a send that lands mid-run is deferred to run end
// and delivered as the next prompt. The process model also differs from pi: one `claude -p`
// per run, the process exits when the run ends (there is no idle-hot window), and the next
// prompt relaunches with `--resume <session uuid>`.
import type {
  AgentAdapter,
  AgentAuthStatus,
  AgentCapabilities,
  Delivery,
  InterruptResult,
  ProposalPayload,
  RawAdapterEvent,
  SessionUsage,
  StartSpec,
  WorkerHandle,
  WorkerLiveTelemetry,
} from "./agent.ts";
import {
  AgentModelObservationSchema,
  validateClaudeModelId,
  type AgentModelCatalog,
  type HistoryPage,
} from "@isaac2ingrid/protocol";
import { AdapterError } from "./agent.ts";
import { adjudicate, REWRITE_REPORT_PROMPT, type Adjudication, type RunWindow } from "./adjudication.ts";
import { claudeSessionPath } from "./full-session-history.ts";
import { childEnv, extractTarget, normalizeProposal, normalizeReport, RESUME_PROMPT } from "./pi-adapter.ts";
import { installClaudeAssets, WORKER_SYSTEM_PROMPT } from "./install.ts";
import { resolveExecutableLaunch, splitCommandLine, type LaunchResolution } from "./pi-launch.ts";
import {
  normalizeClaudeEntries,
  readClaudeSessionHistory,
  type ClaudeTranscriptRecord,
} from "./session-history.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { appendCapped } from "./logger.ts";
import { redactText } from "./redact.ts";

export const CLAUDE_COMMAND_ENV = "OTTO_CLAUDE_COMMAND";

export function claudeCommandFromEnv(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env[CLAUDE_COMMAND_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const argv = splitCommandLine(raw).filter((part) => part.length > 0);
  return argv.length > 0 ? argv : undefined;
}

/** Claude Code requires a UUID session id (§4.2's workerId shape does not qualify). */
const OTTO_NAMESPACE = "e5f0a7c1-3b9d-4e8a-9f2b-6c4d1a7e8b3f";

/** Deterministic UUID (RFC 4122 shape, v5-style construction) for a workerId: the session id
 *  is a pure function of the worker, so relaunches — in this process or after a connector
 *  restart — always land on the same Claude Code session without extra state. */
export function claudeSessionId(workerId: string): string {
  const namespace = OTTO_NAMESPACE.replace(/-/g, "");
  const hash = createHash("sha1");
  for (let i = 0; i < 16; i += 1) {
    hash.update(Buffer.from([Number.parseInt(namespace.slice(i * 2, i * 2 + 2), 16)]));
  }
  hash.update(workerId, "utf8");
  const bytes = hash.digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read-only tool whitelist paired with `--permission-mode plan` for `mode: "readonly"`. */
export const CLAUDE_READONLY_TOOLS = "Read,Grep,Glob,LS,mcp__otto__report,mcp__otto__propose";

/** Report-only tool whitelist used on the single-pass unreported recovery resume. */
export const CLAUDE_REPORT_ONLY_TOOLS = "mcp__otto__report";

/** stop_reason mapping (spike-conclusions §2): end_turn→stop, tool_use→tool_use,
 *  max_tokens→length — pi's vocabulary, so §5.2 adjudication reads both agents alike. */
export function mapStopReason(stopReason: unknown): string | undefined {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "length";
    case null:
    case undefined:
      return undefined;
    default:
      return typeof stopReason === "string" ? stopReason : undefined;
  }
}

/** MCP tool calls arrive namespaced (`mcp__otto__report`): never match the bare name
 *  `report` — suffix-match instead (spike-conclusions §2). */
export function isReportTool(name: string): boolean {
  return name.endsWith("__report");
}

/** MCP `propose` tool calls arrive namespaced (`mcp__otto__propose`): suffix-match. */
export function isProposalTool(name: string): boolean {
  return name.endsWith("__propose");
}

/** Honest capability set (connector-pi.md §3): what headless Claude Code can and cannot do. */
const CLAUDE_CAPABILITIES: AgentCapabilities = {
  // No control channel after stdin EOF: a mid-run steer or queued follow-up is impossible.
  steer: false,
  followUp: false,
  // SIGKILL + a synthetic settled{aborted}; the session file is append-only, so --resume
  // still works and the fixed resume prompt covers half-finished tool calls (§9.2).
  interrupt: true,
  resume: true,
  // Transcripts live at `<claudeConfig>/projects/<cwd-slug>/<sessionUuid>.jsonl` (with live
  // stream fallback before the first disk flush).
  history: true,
  // -p reads the prompt from stdin as text; there is no image channel.
  images: false,
  structuredReport: true,
  // Enforced via `--permission-mode plan` + read-only `--allowedTools` without permission bypass.
  readonly: true,
};

export interface ClaudeAdapterOptions {
  stateDir: string;
  /** argv prefix for the claude binary; default ["claude"]. Tests point this at fake-claude. */
  command?: string[];
  /** Extra env for the child (tests). OTTO_* & CLAUDE_CODE_* are always stripped. */
  env?: Record<string, string | undefined>;
  /** Per-worker stderr tails (§12); default <stateDir>/logs. Pass null to disable. */
  workerLogsDir?: string | null;
  /** hello.agents version string (the detected `claude --version` output). */
  version?: string;
  /** Optional auth status detected at startup (`ready` | `unauthenticated` | `unknown`). */
  authStatus?: AgentAuthStatus;
  /** system/init must arrive within this window after spawn (default 30 s — the CLI cold
   *  start is slower than pi's ~350 ms). */
  initTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL on stop (default 3 s, §4.4). */
  stopGraceMs?: number;
  /** A pre-resolved launch (pi-launch.ts); see PiAdapterOptions.launch. */
  launch?: LaunchResolution;
  /** Controls the single-pass `--resume` report-only rewrite when a run finishes without `report`. */
  rewriteUnreported?: "on_work" | "always" | false;
}

interface WorkerRuntime {
  workerId: string;
  spec: StartSpec;
  process: ClaudeProcess;
  cwd: string;
  sessionId: string;
  configPath: string;
  reportFile: string;
  proposalsFile: string;
  emittedProposalKeys: Set<string>;
  /** In-flight transcript fallback while running before/without disk flush. */
  liveEntries: ClaudeTranscriptRecord[];
  /** Set when the connector itself ends this process; makes exits "expected". */
  stopping: boolean;
  /** Suppresses `process_exit` emission on pass 1 while a single-pass report-only rewrite spawns. */
  suppressExitEvent: boolean;
  /** True on the single-pass `--resume` report-only rewrite process. */
  isRewritePass: boolean;
  /** Guardrail flag when a rewrite pass tried to invoke a non-report tool and was killed. */
  rewriteGuardAborted: boolean;
  savedLastText?: string;
  priorUsage?: SessionUsage;
  /** An interrupt killed this run before its `result`; the exit settles it as aborted. */
  interrupting: boolean;
  /** The `result` event arrived: the run settled, the exit that follows is expected. */
  resultSeen: boolean;
  turn: number;
  window: RunWindow & { open: boolean };
  observedModelWindow: number | null;
  lastContextTokens: number | null;
  toolStartedAt: number | null;
  lastToolMs: number | null;
  /** Assistant text accumulated for the message currently being streamed. */
  pendingText: string;
  /** Buffer from spawn until start() resolves — `started` must precede streamed events (§11.1). */
  buffered: RawAdapterEvent[] | null;
}

export const CLAUDE_SUGGESTED_MODELS = [
  { id: "sonnet", name: "sonnet" },
  { id: "opus", name: "opus" },
  { id: "haiku", name: "haiku" },
  { id: "opusplan", name: "opusplan" },
] as const;

function extractClaudeRateLimitReset(record: Record<string, unknown>): number | string | undefined {
  for (const key of ["resetsAt", "resets_at", "reset_at"]) {
    const val = record[key];
    if (typeof val === "number" || typeof val === "string") return val;
  }
  const info = record.rate_limit_info;
  if (typeof info === "object" && info !== null) {
    const infoObj = info as Record<string, unknown>;
    for (const key of ["resetsAt", "resets_at", "reset_at"]) {
      const val = infoObj[key];
      if (typeof val === "number" || typeof val === "string") return val;
    }
  }
  return undefined;
}

function mergeUsage(first: SessionUsage | undefined, second: SessionUsage | undefined): SessionUsage | undefined {
  if (!first) return second;
  if (!second) return first;
  const in1 = first.tokens?.input ?? 0;
  const out1 = first.tokens?.output ?? 0;
  const cache1 = first.tokens?.cachedInputTokens ?? 0;
  const in2 = second.tokens?.input ?? 0;
  const out2 = second.tokens?.output ?? 0;
  const cache2 = second.tokens?.cachedInputTokens ?? 0;
  const totalIn = in1 + in2;
  const totalOut = out1 + out2;
  const totalCached = cache1 + cache2;
  const cost =
    typeof first.cost === "number" || typeof second.cost === "number"
      ? Math.round(((first.cost ?? 0) + (second.cost ?? 0)) * 1e8) / 1e8
      : undefined;
  return {
    ...(totalIn > 0 || totalOut > 0
      ? {
          tokens: {
            input: totalIn,
            output: totalOut,
            totalTokens: totalIn + totalOut,
            ...(totalCached > 0 ? { cachedInputTokens: totalCached } : {}),
          },
        }
      : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(second.contextUsage ?? first.contextUsage ? { contextUsage: second.contextUsage ?? first.contextUsage } : {}),
  };
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude-code" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
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
    models: CLAUDE_SUGGESTED_MODELS.map((m) => ({ ...m })),
  } satisfies AgentModelCatalog;

  validateModel(model: string): boolean {
    return validateClaudeModelId(model);
  }

  /** Effective Claude config directory (`options.env.CLAUDE_CONFIG_DIR` -> `process.env.CLAUDE_CONFIG_DIR` -> `~/.claude`). */
  claudeConfigDir(): string {
    const envDir = this.options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
    return typeof envDir === "string" && envDir.length > 0 ? envDir : join(homedir(), ".claude");
  }

  /** Locates `<claudeConfig>/projects/.../<sessionId>.jsonl` for this adapter's config root. */
  resolveSessionPath(cwd: string | null | undefined, sessionId: string | null | undefined): string | null {
    if (!sessionId) return null;
    return claudeSessionPath(cwd, sessionId, this.claudeConfigDir());
  }

  private readonly options: ClaudeAdapterOptions;
  private readonly workerLogsDir: string | null;
  private readonly runtimes = new Map<string, WorkerRuntime>();
  private readonly listeners: ((e: RawAdapterEvent) => void)[] = [];
  /** The last StartSpec per worker: a prompt-path send relaunches from it with --resume. */
  private readonly lastSpecs = new Map<string, StartSpec>();
  private readonly compactionCounts = new Map<string, number>();
  private launch?: LaunchResolution;

  constructor(options: ClaudeAdapterOptions) {
    this.options = options;
    this.workerLogsDir = options.workerLogsDir === null ? null : (options.workerLogsDir ?? join(options.stateDir, "logs"));
  }

  get launchResolution(): LaunchResolution {
    this.launch =
      this.launch ??
      this.options.launch ??
      resolveExecutableLaunch(this.options.command ?? claudeCommandFromEnv() ?? ["claude"]);
    return this.launch;
  }

  get version(): string | undefined {
    return this.options.version;
  }

  get authStatus(): AgentAuthStatus | undefined {
    return this.options.authStatus;
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

  /** Builds the headless invocation:
   *  - `mode === "write"` uses `--dangerously-skip-permissions`.
   *  - `mode === "readonly"` uses `--permission-mode plan` + read-only `--allowedTools` (never skip-permissions).
   *  - `rewriteReportOnly` uses `--permission-mode plan` + `--allowedTools mcp__otto__report` with `--resume`. */
  buildArgs(spec: StartSpec, mcpConfigPath: string, options?: { rewriteReportOnly?: boolean }): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcpConfigPath,
      "--append-system-prompt",
      WORKER_SYSTEM_PROMPT,
    ];
    if (options?.rewriteReportOnly) {
      args.push("--permission-mode", "plan", "--allowedTools", CLAUDE_REPORT_ONLY_TOOLS);
    } else if (spec.mode === "readonly") {
      args.push("--permission-mode", "plan", "--allowedTools", CLAUDE_READONLY_TOOLS);
    } else {
      args.push("--dangerously-skip-permissions");
    }
    const sessionId = spec.resumeSessionId ?? claudeSessionId(spec.workerId);
    const useResume = options?.rewriteReportOnly === true || Boolean(spec.resumeSessionId);
    args.push(useResume ? "--resume" : "--session-id", sessionId);
    if (spec.model) args.push("--model", spec.model);
    return args;
  }

  /** The per-worker mcp-config: Claude Code spawns our report server as an MCP child. */
  private writeMcpConfig(workerId: string, serverPath: string): {
    configPath: string;
    reportFile: string;
    proposalsFile: string;
  } {
    const mcpDir = join(this.options.stateDir, "mcp");
    const configPath = join(mcpDir, `config-${workerId}.json`);
    const reportFile = join(mcpDir, "reports", `${workerId}.json`);
    const proposalsFile = join(mcpDir, "proposals", `proposals-${workerId}.jsonl`);
    rmSync(reportFile, { force: true });
    rmSync(proposalsFile, { force: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          otto: { type: "stdio", command: process.execPath, args: [serverPath, reportFile, proposalsFile], env: {} },
        },
      }),
    );
    return { configPath, reportFile, proposalsFile };
  }

  async start(spec: StartSpec): Promise<WorkerHandle> {
    if (this.runtimes.has(spec.workerId)) {
      throw new AdapterError("lock_held", `a claude process for ${spec.workerId} is already running`);
    }
    const launch = this.launchResolution;
    if (launch.error) throw new AdapterError("launch_unresolved", launch.error);
    const assets = installClaudeAssets(this.options.stateDir);
    const serverPath = assets.serverPath;
    if (this.workerLogsDir) mkdirSync(this.workerLogsDir, { recursive: true });
    const sessionId = spec.resumeSessionId ?? claudeSessionId(spec.workerId);
    const { configPath, reportFile, proposalsFile } = this.writeMcpConfig(spec.workerId, serverPath);

    let runtime!: WorkerRuntime;
    const proc = new ClaudeProcess({
      command: launch.argv,
      args: this.buildArgs(spec, configPath),
      cwd: spec.cwd,
      env: childEnv(process.env, this.options.env),
      stderrFile: this.workerLogsDir ? join(this.workerLogsDir, `claude-${spec.workerId}.log`) : undefined,
      onEvent: (record) => this.onStreamEvent(runtime, record),
      onExit: (info) => this.onExit(runtime, info),
    });
    runtime = {
      workerId: spec.workerId,
      spec,
      process: proc,
      cwd: spec.cwd,
      sessionId,
      configPath,
      reportFile,
      proposalsFile,
      emittedProposalKeys: new Set(),
      liveEntries: [
        {
          type: "user",
          uuid: `live-user-${spec.commandId || sessionId}`,
          message: { role: "user", content: spec.prompt },
        },
      ],
      stopping: false,
      suppressExitEvent: false,
      isRewritePass: false,
      rewriteGuardAborted: false,
      interrupting: false,
      resultSeen: false,
      turn: 0,
      window: { open: false, aborted: false },
      observedModelWindow: spec.model ? inferClaudeContextWindow(spec.model) : null,
      lastContextTokens: null,
      toolStartedAt: null,
      lastToolMs: null,
      pendingText: "",
      buffered: [],
    };
    this.runtimes.set(spec.workerId, runtime);
    this.lastSpecs.set(spec.workerId, spec);
    proc.spawn();
    proc.writePrompt(spec.prompt);

    try {
      const init = await proc.waitForInit(this.options.initTimeoutMs ?? 30_000);
      const seen = typeof init.session_id === "string" ? init.session_id : "";
      if (!UUID_RE.test(sessionId) || (seen !== "" && seen !== sessionId)) {
        throw new AdapterError(
          "startup_failed",
          `session id mismatch: expected ${sessionId}, got ${seen || "(none)"} — is this Claude Code?`,
        );
      }
      const mcp = Array.isArray(init.mcp_servers)
        ? (init.mcp_servers as Array<Record<string, unknown>>).find((s) => s.name === "otto")
        : undefined;
      if (mcp && typeof mcp.status === "string" && mcp.status !== "connected") {
        throw new AdapterError(
          "startup_failed",
          `otto MCP server status '${mcp.status}': the report tool is not available; refusing to run unreported`,
        );
      }
      try {
        spec.onPromptAccepted?.();
      } catch {
        // bookkeeping must never fail launch
      }
      if (typeof init.model === "string") {
        const observation = AgentModelObservationSchema.safeParse({
          id: init.model,
          source: "init",
          observedAt: Date.now(),
        });
        if (observation.success) {
          spec.onModelObserved?.(observation.data);
        }
      }
      const handle: WorkerHandle = { workerId: spec.workerId, sessionId, cwd: spec.cwd };
      setImmediate(() => this.flushBuffered(runtime));
      return handle;
    } catch (err) {
      runtime.buffered = null;
      this.runtimes.delete(spec.workerId);
      runtime.stopping = true;
      proc.kill();
      if (err instanceof AdapterError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new AdapterError("startup_failed", `claude startup failed: ${reason}`);
    }
  }

  async send(
    id: string,
    input: { text: string; images?: { data: string; mimeType: string }[]; commandId?: string },
    how: Delivery,
  ): Promise<{ effect?: string }> {
    if (how !== "prompt") {
      throw new AdapterError("unsupported", `claude-code cannot ${how} mid-run (no control channel after stdin EOF)`);
    }
    const previous = this.runtimes.get(id);
    if (previous && !previous.process.hasExited) {
      previous.stopping = true;
      this.runtimes.delete(id);
      await previous.process.close(2000);
    }
    const spec = this.lastSpecs.get(id);
    if (!spec) throw new AdapterError("not_found", `no known spec to continue worker ${id}`);
    await this.start({
      ...spec,
      prompt: input.text,
      commandId: input.commandId ?? spec.commandId,
      resumeSessionId: claudeSessionId(id),
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
        "claude-code cannot resume while a run is in flight; interrupt it or wait for the run to end",
      );
    }
    const spec = this.lastSpecs.get(id);
    if (!spec) throw new AdapterError("not_found", `no known spec to resume worker ${id}`);
    await this.start({ ...spec, prompt: `${RESUME_PROMPT}\n\nReason: ${reason}`, resumeSessionId: claudeSessionId(id) });
  }

  async stopProcess(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.stopping = true;
    this.runtimes.delete(id);
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

  async history(id: string, since: string | undefined, maxBytes: number): Promise<HistoryPage> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.process.hasExited) {
      throw new AdapterError("not_running", `no live claude process for worker ${id}`);
    }
    const diskPath = this.resolveSessionPath(runtime.cwd, runtime.sessionId);
    if (diskPath) {
      return readClaudeSessionHistory(diskPath, { since, maxBytes });
    }
    return normalizeClaudeEntries(runtime.liveEntries, { since, maxBytes });
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
      throw new AdapterError("not_running", `no live claude process for worker ${id}`);
    }
    return runtime;
  }

  // --- stream-json → RawAdapterEvent (spike-conclusions §2) ---------------------------------

  private onStreamEvent(runtime: WorkerRuntime, record: Record<string, unknown>): void {
    switch (record.type) {
      case "system": {
        if (record.subtype === "init") {
          runtime.window = { open: true, aborted: false };
          if (typeof record.model === "string") {
            runtime.observedModelWindow = inferClaudeContextWindow(record.model) ?? runtime.observedModelWindow;
          }
        } else if (record.subtype === "compact_boundary") {
          const nextCount = (this.compactionCounts.get(runtime.workerId) ?? 0) + 1;
          this.compactionCounts.set(runtime.workerId, nextCount);
          const telemetry = this.snapshotTelemetry(runtime);
          this.emit({
            type: "progress",
            workerId: runtime.workerId,
            phase: "compacting",
            turn: Math.max(1, runtime.turn),
            ...(telemetry ? { telemetry } : {}),
          });
        }
        return;
      }
      case "rate_limit_event": {
        const resetAt = extractClaudeRateLimitReset(record);
        if (resetAt !== undefined) runtime.window.rateLimitResetAt = resetAt;
        return;
      }
      case "assistant": {
        const message = record.message as Record<string, unknown> | undefined;
        if (!message) return;
        runtime.turn += 1;
        const msgUsage = typeof message.usage === "object" && message.usage !== null
          ? (message.usage as Record<string, unknown>)
          : null;
        if (msgUsage) {
          const ctxTok =
            (typeof msgUsage.input_tokens === "number" ? msgUsage.input_tokens : 0) +
            (typeof msgUsage.cache_creation_input_tokens === "number" ? msgUsage.cache_creation_input_tokens : 0) +
            (typeof msgUsage.cache_read_input_tokens === "number" ? msgUsage.cache_read_input_tokens : 0) +
            (typeof msgUsage.output_tokens === "number" ? msgUsage.output_tokens : 0);
          if (ctxTok > 0) runtime.lastContextTokens = Math.round(ctxTok);
        }
        const liveEntryId =
          typeof record.uuid === "string" && record.uuid.length > 0
            ? record.uuid
            : typeof message.id === "string" && message.id.length > 0
              ? message.id
              : `live-assistant-${runtime.turn}`;
        runtime.liveEntries.push({
          type: "assistant",
          uuid: liveEntryId,
          message: {
            role: "assistant",
            content: message.content,
          },
        });
        runtime.pendingText = "";
        const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
        let emittedToolProgress = false;
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            runtime.pendingText += block.text;
            continue;
          }
          if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "unknown";
            const input = block.input;
            if (runtime.isRewritePass && !isReportTool(name)) {
              // Guardrail: rewrite pass must only call `__report`.
              runtime.rewriteGuardAborted = true;
              runtime.process.kill();
              return;
            }
            runtime.toolStartedAt = Date.now();
            if (isReportTool(name)) {
              const report = normalizeReport(input);
              if (report) runtime.window.report = report;
            } else {
              runtime.window.hadWork = true;
              if (isProposalTool(name)) {
                const proposal = normalizeProposal(input);
                if (proposal) this.emitProposalOnce(runtime, proposal);
              }
            }
            const telemetry = this.snapshotTelemetry(runtime);
            this.emit({
              type: "progress",
              workerId: runtime.workerId,
              phase: "tool",
              tool: isReportTool(name) ? "report" : isProposalTool(name) ? "propose" : name,
              target: extractTarget(input),
              turn: runtime.turn,
              ...(telemetry ? { telemetry } : {}),
            });
            emittedToolProgress = true;
          }
        }
        if (!emittedToolProgress) {
          const telemetry = this.snapshotTelemetry(runtime);
          this.emit({
            type: "progress",
            workerId: runtime.workerId,
            phase: "thinking",
            turn: runtime.turn,
            ...(telemetry ? { telemetry } : {}),
          });
        }
        runtime.window.lastAssistant = {
          stopReason: mapStopReason(message.stop_reason),
          text: runtime.pendingText,
        };
        return;
      }
      case "user": {
        if (runtime.toolStartedAt !== null) {
          runtime.lastToolMs = Math.max(0, Date.now() - runtime.toolStartedAt);
          runtime.toolStartedAt = null;
        }
        return;
      }
      case "result": {
        if (!runtime.window.open) return;
        const resetAt = extractClaudeRateLimitReset(record);
        if (resetAt !== undefined && runtime.window.rateLimitResetAt === undefined) {
          runtime.window.rateLimitResetAt = resetAt;
        }
        const errored =
          record.is_error === true || (typeof record.subtype === "string" && record.subtype.startsWith("error"));
        if (errored) {
          const errorsList = Array.isArray(record.errors)
            ? record.errors.filter((e): e is string => typeof e === "string" && e.trim().length > 0).join("; ")
            : "";
          const detail =
            typeof record.result === "string" && record.result.length > 0
              ? record.result
              : errorsList || runtime.window.lastAssistant?.text?.trim() || String(record.subtype ?? "error during execution");
          runtime.window.lastAssistant = {
            stopReason: "error",
            errorMessage: detail,
            text: runtime.window.lastAssistant?.text ?? "",
          };
        }
        runtime.resultSeen = true;
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

  private extractResultUsage(runtime: WorkerRuntime, result: Record<string, unknown>): SessionUsage {
    const usage: SessionUsage = {};
    const rawUsage = result.usage as Record<string, unknown> | undefined;
    if (rawUsage && typeof rawUsage.input_tokens === "number") {
      // Claude `input_tokens` excludes prompt-cache read & creation tokens; add both back so
      // `input` reflects true context consumption and surface `cachedInputTokens` separately.
      const cacheRead = typeof rawUsage.cache_read_input_tokens === "number" ? rawUsage.cache_read_input_tokens : 0;
      const cacheCreate =
        typeof rawUsage.cache_creation_input_tokens === "number" ? rawUsage.cache_creation_input_tokens : 0;
      const cached = Math.max(0, cacheRead + cacheCreate);
      const input = rawUsage.input_tokens + cached;
      const output = typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0;
      usage.tokens = {
        input,
        output,
        totalTokens: input + output,
        ...(cached > 0 ? { cachedInputTokens: cached } : {}),
      };
    }
    if (typeof result.total_cost_usd === "number") usage.cost = result.total_cost_usd;

    const modelUsage = typeof result.modelUsage === "object" && result.modelUsage !== null
      ? (result.modelUsage as Record<string, unknown>)
      : null;
    if (modelUsage) {
      for (const entry of Object.values(modelUsage)) {
        if (typeof entry === "object" && entry !== null) {
          const cw = (entry as Record<string, unknown>).contextWindow;
          if (typeof cw === "number" && Number.isFinite(cw) && cw > 0) {
            runtime.observedModelWindow = Math.round(cw);
            break;
          }
        }
      }
    }
    if (runtime.lastContextTokens !== null) {
      usage.contextUsage = {
        tokens: runtime.lastContextTokens,
        ...(runtime.observedModelWindow !== null ? { contextWindow: runtime.observedModelWindow } : {}),
        percent:
          runtime.observedModelWindow !== null && runtime.observedModelWindow > 0
            ? Math.round((runtime.lastContextTokens / runtime.observedModelWindow) * 100)
            : null,
      };
    }
    return usage;
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
    let adjudicated: Adjudication = adjudicate(facts);
    runtime.window = { open: false, aborted: false };
    runtime.turn = 0;

    const passUsage = this.extractResultUsage(runtime, result);
    const combinedUsage = mergeUsage(runtime.priorUsage, passUsage);

    if (runtime.isRewritePass) {
      if (adjudicated.outcome === "unreported" || adjudicated.outcome === "aborted") {
        adjudicated = {
          outcome: "unreported",
          lastText: runtime.savedLastText || adjudicated.lastText,
        };
      }
    } else {
      const rewriteMode = this.options.rewriteUnreported ?? "on_work";
      const shouldRewrite =
        rewriteMode !== false &&
        adjudicated.outcome === "unreported" &&
        (rewriteMode === "always" || facts.hadWork === true) &&
        !runtime.stopping &&
        !runtime.interrupting;
      if (shouldRewrite) {
        const launched = await this.launchRewritePass(runtime, adjudicated.lastText, combinedUsage);
        if (launched) return;
      }
    }

    const telemetry = this.snapshotTelemetry(runtime);
    runtime.lastToolMs = null;
    const hasUsage = Boolean(combinedUsage?.tokens || combinedUsage?.cost !== undefined || combinedUsage?.contextUsage);

    this.emit({
      type: "settled",
      workerId: runtime.workerId,
      outcome: adjudicated.outcome,
      errorClass: adjudicated.errorClass,
      limitedUntil: adjudicated.limitedUntil,
      errorMessage: adjudicated.errorMessage,
      lastText: adjudicated.lastText?.slice(0, 4000),
      report: adjudicated.report,
      ...(hasUsage && combinedUsage ? { usage: combinedUsage } : {}),
      ...(telemetry ? { telemetry } : {}),
    });
  }

  /** Spawns at most one `--resume` report-only pass (`--permission-mode plan`) in place so
   *  `WorkerManager` keeps its lock and active worktree context until the final settle. */
  private async launchRewritePass(
    prevRuntime: WorkerRuntime,
    savedLastText: string | undefined,
    priorUsage: SessionUsage | undefined,
  ): Promise<boolean> {
    const launch = this.launchResolution;
    if (launch.error) return false;
    prevRuntime.suppressExitEvent = true;
    await prevRuntime.process.close(1500).catch(() => undefined);
    if (prevRuntime.stopping || prevRuntime.interrupting) return false;

    rmSync(prevRuntime.reportFile, { force: true });
    let rewriteRuntime!: WorkerRuntime;
    const proc = new ClaudeProcess({
      command: launch.argv,
      args: this.buildArgs(prevRuntime.spec, prevRuntime.configPath, { rewriteReportOnly: true }),
      cwd: prevRuntime.cwd,
      env: childEnv(process.env, this.options.env),
      stderrFile: this.workerLogsDir ? join(this.workerLogsDir, `claude-${prevRuntime.workerId}.log`) : undefined,
      onEvent: (record) => this.onStreamEvent(rewriteRuntime, record),
      onExit: (info) => this.onExit(rewriteRuntime, info),
    });
    rewriteRuntime = {
      ...prevRuntime,
      process: proc,
      suppressExitEvent: false,
      isRewritePass: true,
      rewriteGuardAborted: false,
      savedLastText,
      priorUsage,
      interrupting: false,
      resultSeen: false,
      turn: 0,
      window: { open: false, aborted: false },
      toolStartedAt: null,
      lastToolMs: null,
      pendingText: "",
      buffered: null,
    };
    this.runtimes.set(prevRuntime.workerId, rewriteRuntime);
    proc.spawn();
    proc.writePrompt(REWRITE_REPORT_PROMPT);
    try {
      await proc.waitForInit(this.options.initTimeoutMs ?? 15_000);
      return true;
    } catch {
      rewriteRuntime.suppressExitEvent = true;
      rewriteRuntime.stopping = true;
      this.runtimes.delete(prevRuntime.workerId);
      proc.kill();
      // Restore normal exit notification after fallback settle emits in caller.
      queueMicrotask(() => {
        this.emit({
          type: "process_exit",
          workerId: prevRuntime.workerId,
          code: 0,
          signal: null,
          unexpected: false,
        });
      });
      return false;
    }
  }

  private snapshotTelemetry(runtime: WorkerRuntime): WorkerLiveTelemetry | undefined {
    const out: WorkerLiveTelemetry = {};
    if (runtime.lastContextTokens !== null) {
      out.contextTokens = runtime.lastContextTokens;
      if (runtime.observedModelWindow !== null && runtime.observedModelWindow > 0) {
        out.contextWindow = runtime.observedModelWindow;
        out.contextPercent = Math.round((runtime.lastContextTokens / runtime.observedModelWindow) * 100);
      }
    }
    const compactions = this.compactionCounts.get(runtime.workerId) ?? 0;
    if (compactions > 0) out.compactionCount = compactions;
    if (runtime.lastToolMs !== null) out.lastToolMs = runtime.lastToolMs;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private onExit(runtime: WorkerRuntime, info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (runtime.suppressExitEvent) return;
    if (this.runtimes.get(runtime.workerId) === runtime) this.runtimes.delete(runtime.workerId);
    if (runtime.rewriteGuardAborted && !runtime.resultSeen) {
      runtime.resultSeen = true;
      runtime.window = { open: false, aborted: false };
      this.emit({
        type: "settled",
        workerId: runtime.workerId,
        outcome: "unreported",
        lastText: runtime.savedLastText?.slice(0, 4000),
        ...(runtime.priorUsage ? { usage: runtime.priorUsage } : {}),
      });
    } else if (runtime.interrupting && !runtime.resultSeen && runtime.window.open) {
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

export class ClaudeProcess {
  private readonly options: ClaudeProcessOptions;
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

  constructor(options: ClaudeProcessOptions) {
    this.options = options;
  }

  spawn(): void {
    if (this.child) throw new Error("ClaudeProcess already spawned");
    const child = spawn(this.options.command[0]!, [...this.options.command.slice(1), ...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error("claude process is not piped");
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
    if (!this.child || this.exited || !stdin) throw new Error("claude process is not running");
    stdin.write(prompt, () => {
      // stdin may already be destroyed (a fast crash); the exit event still arrives.
    });
    stdin.end();
  }

  waitForInit(timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child) {
        const detail = redactText(this.preInitError || this.stderrTail.slice(-2000));
        reject(new Error(`claude process exited before init; detail:\n${detail}`));
        return;
      }
      const timer = setTimeout(() => {
        this.initWaiter = null;
        const detail = redactText(this.preInitError || this.stderrTail.slice(-2000));
        reject(new Error(`no system/init within ${timeoutMs}ms; detail:\n${detail}`));
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
      if (record.type === "system" && record.subtype === "init" && this.initWaiter) {
        const waiter = this.initWaiter;
        this.initWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      } else if (
        this.initWaiter &&
        record.type === "result" &&
        (record.is_error === true || (typeof record.subtype === "string" && record.subtype.startsWith("error")))
      ) {
        const errorsList = Array.isArray(record.errors)
          ? record.errors.filter((e): e is string => typeof e === "string" && e.trim().length > 0).join("; ")
          : "";
        this.preInitError =
          typeof record.result === "string" && record.result.length > 0
            ? record.result
            : errorsList || String(record.subtype ?? "error before init");
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
      waiter.reject(new Error(`claude process exited (code=${code} signal=${signal}); stderr tail:\n${detail}`));
    }
    this.options.onExit({ code, signal });
    for (const waiter of this.exitWaiters) waiter();
    this.exitWaiters = [];
  }
}

export interface ClaudeProcessOptions {
  command: string[];
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  onEvent: (event: Record<string, unknown>) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  stderrFile?: string;
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
        // skip malformed JSONL line
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function probeClaudeAuthStatus(
  resolvedArgv: string[],
  timeoutMs = 3000,
  execFn: typeof spawnSync = spawnSync,
): AgentAuthStatus {
  if (!resolvedArgv[0]) return "unknown";
  try {
    const [file, ...rest] = resolvedArgv;
    const res = execFn(file, [...rest, "auth", "status"], { timeout: timeoutMs, encoding: "utf8" });
    const combined = `${String(res.stdout ?? "")}\n${String(res.stderr ?? "")}`.toLowerCase();
    if (/"loggedin"\s*:\s*true|\blogged in\b/.test(combined) && !/"loggedin"\s*:\s*false|\bnot logged in\b/.test(combined)) {
      return "ready";
    }
    if (/"loggedin"\s*:\s*false|\bnot logged in\b|\bunauthenticated\b|\blogin required\b/.test(combined)) {
      return "unauthenticated";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function detectClaude(
  command: string[] = claudeCommandFromEnv() ?? ["claude"],
  timeoutMs = 5000,
): { installed: boolean; version?: string; authStatus?: AgentAuthStatus } {
  try {
    const resolved = resolveExecutableLaunch(command);
    if (resolved.error || !resolved.argv[0]) return { installed: false };
    const [file, ...rest] = resolved.argv;
    const result = spawnSync(file, [...rest, "--version"], { timeout: timeoutMs, encoding: "utf8" });
    if (result.status !== 0 || result.error) return { installed: false };
    const version = String(result.stdout ?? "").trim().split("\n")[0] ?? "";
    const authStatus = probeClaudeAuthStatus(resolved.argv, Math.min(timeoutMs, 3000));
    return {
      installed: true,
      version: version.length > 0 ? version : undefined,
      ...(authStatus !== "unknown" ? { authStatus } : {}),
    };
  } catch {
    return { installed: false };
  }
}

/** Returns known context window ONLY for recognized standard Anthropic Claude models; unknown custom/gateway IDs stay null. */
export function inferClaudeContextWindow(modelId: string): number | null {
  const m = modelId.trim().toLowerCase();
  if (!m) return null;
  if (m.includes("[1m]") || m.endsWith("-1m")) return 1_000_000;
  if (
    m === "sonnet" ||
    m === "opus" ||
    m === "haiku" ||
    m === "opusplan" ||
    /(?:^|[/:.-])claude-(?:3|sonnet-4|opus-4|haiku-4)/.test(m)
  ) {
    return 200_000;
  }
  return null;
}
