// PiAdapter: the first AgentAdapter implementation, docs/design/connector-pi.md §3–§7.
// Normalizes pi's raw event stream into coarse-grained adapter events and runs outcome
// adjudication on `agent_settled` (§5.2). Git facts are NOT collected here — the
// WorkerManager merges those after adjudication so they come from git, not the model.
import type {
  AgentAdapter,
  AgentCapabilities,
  CumulativeUsageCursor,
  Delivery,
  InterruptResult,
  RawAdapterEvent,
  ReportPayload,
  SessionUsage,
  StartSpec,
  WorkerHandle,
  WorkerLiveTelemetry,
} from "./agent.ts";
import { AdapterError, diffCumulativeSessionUsage, PartialInterruptError } from "./agent.ts";
import { adjudicate, REWRITE_REPORT_PROMPT, type Adjudication, type RunWindow } from "./adjudication.ts";
import { normalizeSessionEntries } from "./session-history.ts";
import { observeSession } from "./session-observation.ts";
import { installAssets, type InstalledAssets } from "./install.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PiProcess, RpcError } from "./pi-process.ts";
import { piCommandFromEnv, resolveExecutableLaunch, type LaunchResolution } from "./pi-launch.ts";
import {
  AgentModelObservationSchema,
  normalizeReportLabels,
  parseProposalPayload,
  type AgentModelCatalog,
  type HistoryPage,
  type ProposalPayload,
} from "@isaac2ingrid/protocol";
import { PiModelDiscovery } from './pi-model-discovery.ts';

/** Must match COMMAND_NAME in ./ext/otto-pi.ts (locked together by a test). */
const OTTO_COMMAND = "otto";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;

function resolveStartupTimeoutMs(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = Number(process.env.OTTO_PI_STARTUP_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1000) return Math.round(raw);
  return DEFAULT_STARTUP_TIMEOUT_MS;
}

export interface PiAdapterOptions {
  stateDir: string;
  /** argv prefix for the pi binary; default ["pi"]. Tests point this at fake-pi. */
  command?: string[];
  /** get_state must succeed within this window after spawn (§4.4: 5 seconds). */
  getStateTimeoutMs?: number;
  /** Extra env passed to the child (tests). The connector's own credentials never ride along. */
  env?: Record<string, string | undefined>;
  /** Where per-worker stderr tails are kept (§12); default <stateDir>/logs. Pass null to disable. */
  workerLogsDir?: string | null;
  /** A pre-resolved launch (pi-launch.ts), for embedders and tests that cannot exercise the
   *  platform's PATH themselves. A resolution carrying `error` is refused rather than spawned. */
  launch?: LaunchResolution;
  /** Controls the single-pass report-only rewrite when a run finishes cleanly without `report`:
   *  default `"on_work"` (runs when at least one non-report tool executed), `"always"`, or `false`. */
  rewriteUnreported?: "on_work" | "always" | false;
}

/** Env for the agent child (§4.2: "inherit the user's environment; the connector's own
 * credentials are not passed through", issue #27). The connector's state lives under
 * OTTO_* variables (the home setting locates the device-token store), and CLAUDE_CODE_* /
 * CLAUDECODE parent harness markers are stripped so nested agent CLI launches never collide. */
export function childEnv(
  source: Record<string, string | undefined> = process.env,
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("OTTO_") || key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE") continue;
    env[key] = value;
  }
  if (extra) Object.assign(env, extra);
  return env;
}

const PI_CAPABILITIES: AgentCapabilities = {
  steer: true,
  followUp: true,
  interrupt: true,
  resume: true,
  history: true,
  images: true,
  structuredReport: true,
  readonly: true,
};

/** The fixed resume prompt, connector-pi.md §9.2. */
export const RESUME_PROMPT =
  "Your previous process was interrupted (machine or process restart). First check the current " +
  "files and git status, confirm what is already done, then continue the task. Interrupted tool " +
  "calls may have been only partially executed.";

interface WorkerRuntime {
  workerId: string;
  process: PiProcess;
  cwd: string;
  /** Set when the connector itself is stopping the process; makes exits "expected". */
  stopping: boolean;
  turn: number;
  window: RunWindow & { open: boolean };
  /** At most one forced report-only rewrite is attempted per user turn. */
  reReportAttempted: boolean;
  /** True while the forced report-only rewrite pass is in flight; non-report tools abort immediately. */
  rewritingReport: boolean;
  savedLastText?: string;
  compactionCount: number;
  activeTools: Map<string, number>;
  lastToolMs: number | null;
  lastStatsProbeAt: number;
  latestContextUsage?: SessionUsage["contextUsage"];
  settledCursor?: CumulativeUsageCursor;
  /**
   * Events are buffered from spawn until start() resolves: a fast agent can begin streaming
   * (agent_start …) before the caller has emitted its `started` event, which must come first
   * on the wire (§11.1). The flush rides a macrotask, so the caller's `await` continuation —
   * which emits `started` — deterministically runs first.
   */
  buffered: RawAdapterEvent[] | null;
}

export class PiAdapter implements AgentAdapter {
  readonly kind = "pi" as const;
  readonly capabilities = PI_CAPABILITIES;
  private readonly modelDiscovery: PiModelDiscovery;
  get modelCatalog(): AgentModelCatalog { return this.modelDiscovery.catalog; }
  refreshModels(): Promise<AgentModelCatalog> { return this.modelDiscovery.refresh(); }
  stopDiscovery(): void { this.modelDiscovery.stop(); }
  validateModel(model: string): boolean { return model.includes('/') && !model.endsWith('/'); }

  private readonly options: PiAdapterOptions;
  private readonly workerLogsDir: string | null;
  private readonly runtimes = new Map<string, WorkerRuntime>();
  private readonly listeners: ((e: RawAdapterEvent) => void)[] = [];
  private assets?: InstalledAssets;
  private launch?: LaunchResolution;

  constructor(options: PiAdapterOptions) {
    this.options = options;
    this.modelDiscovery = new PiModelDiscovery({ stateDir: options.stateDir, launch: () => this.launchResolution,
      env: () => childEnv(process.env, options.env), timeoutMs: resolveStartupTimeoutMs(options.getStateTimeoutMs) });
    this.workerLogsDir = options.workerLogsDir === null ? null : (options.workerLogsDir ?? join(options.stateDir, "logs"));
  }

  /** The argv the connector will spawn for pi, resolved once (Windows shim resolution lives
   *  in pi-launch.ts). OTTO_PI_COMMAND wins over the default `pi`; an explicit `command`
   *  option (tests, embedders) wins over both and is never rewritten. */
  get launchResolution(): LaunchResolution {
    this.launch = this.launch ?? this.options.launch ?? resolveExecutableLaunch(this.options.command ?? piCommandFromEnv() ?? ["pi"]);
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

  private flushBuffered(runtime: WorkerRuntime): void {
    const buffered = runtime.buffered;
    runtime.buffered = null;
    if (!buffered) return;
    for (const event of buffered) {
      for (const fn of this.listeners) fn(event);
    }
  }

  /** Builds the startup command line (§4.2). */
  buildArgs(spec: StartSpec, assets: InstalledAssets): string[] {
    const args = [
      "--mode",
      "rpc",
      "--session-id",
      spec.workerId,
      "--extension",
      assets.extensionPath,
      "--append-system-prompt",
      assets.promptPath,
      // §13: --no-approve unless the repo is locally approved (approveProject is a
      // connector-local per-repo setting, never taken from a command).
      spec.approveProject === true ? "--approve" : "--no-approve",
    ];
    if (spec.mode === "readonly") args.push("--tools", "read,grep,find,ls,report");
    if (spec.model) args.push("--model", spec.model);
    return args;
  }

  async start(spec: StartSpec): Promise<WorkerHandle> {
    // In-memory half of the one-file-one-process invariant (§4.3); the lock file is the
    // WorkerManager's half.
    if (this.runtimes.has(spec.workerId)) {
      throw new AdapterError("lock_held", `a pi process for ${spec.workerId} is already running`);
    }
    // A resolution that refused to produce an argv (a Windows shim with no readable JS entry)
    // must fail here, with its reason, instead of spawning a bare name that cannot start.
    const launch = this.launchResolution;
    if (launch.error) throw new AdapterError("launch_unresolved", launch.error);
    this.assets = this.assets ?? installAssets(this.options.stateDir);
    if (this.workerLogsDir) mkdirSync(this.workerLogsDir, { recursive: true });

    let runtime!: WorkerRuntime;
    const proc = new PiProcess({
      command: launch.argv,
      args: this.buildArgs(spec, this.assets),
      cwd: spec.cwd,
      env: childEnv(process.env, this.options.env),
      stderrFile: this.workerLogsDir ? join(this.workerLogsDir, `pi-${spec.workerId}.log`) : undefined,
      onEvent: (record) => this.onPiEvent(runtime, record),
      onExit: (info) => this.onPiExit(runtime, info),
    });
    runtime = {
      workerId: spec.workerId,
      process: proc,
      cwd: spec.cwd,
      stopping: false,
      turn: 0,
      window: { open: false, aborted: false },
      reReportAttempted: false,
      rewritingReport: false,
      compactionCount: 0,
      activeTools: new Map(),
      lastToolMs: null,
      lastStatsProbeAt: 0,
      buffered: [],
    };
    this.runtimes.set(spec.workerId, runtime);
    proc.spawn();

    try {
      // §4.4 step 4: get_state must succeed within the timeout and sessionId must match.
      // Default 20s tolerates cold startup with user global extensions/MCP under launchd.
      const timeout = resolveStartupTimeoutMs(this.options.getStateTimeoutMs);
      const state = await proc.rpc({ type: "get_state" }, timeout);
      if (state.sessionId !== spec.workerId) {
        throw new AdapterError(
          "startup_failed",
          `sessionId mismatch: expected ${spec.workerId}, got ${String(state.sessionId)}`,
        );
      }
      const observed = state.model && typeof state.model === 'object' ? state.model as Record<string, unknown> : null;
      if (observed && typeof observed.provider === 'string' && typeof observed.id === 'string') {
        const observation = AgentModelObservationSchema.safeParse({ id: `${observed.provider}/${observed.id}`, source: 'state', observedAt: Date.now() });
        if (observation.success) {
          if (spec.model && observation.data.id !== spec.model) throw new AdapterError('model_mismatch', 'pi did not select the requested provider/model');
          spec.onModelObserved?.(observation.data);
        }
      }
      const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : null;
      // §6.3/§10: the session file and its current tail are on record BEFORE the prompt is
      // sent, so a crash anywhere past this point leaves decidable evidence (the marker
      // entry for this command, and the external-activity baseline it is diffed against).
      // Fires even with no session file: the write-ahead must precede the prompt regardless.
      const observation = sessionFile ? observeSession(sessionFile) : null;
      try {
        spec.onSession?.(sessionFile, observation?.lastEntryId ?? null);
      } catch {
        // observation bookkeeping must never fail a launch
      }
      const handle: WorkerHandle = {
        workerId: spec.workerId,
        sessionId: String(state.sessionId),
        sessionFile: sessionFile ?? undefined,
        cwd: spec.cwd,
      };

      // §4.4 step 5: send the prompt, wrapped for the extension's commandId marker
      // (ADR-0001). The `/otto` extension command consumes it, so the response's
      // disposition must be "handled".
      const message = wrapPrompt(spec.commandId, spec.prompt);
      const response = await proc.rpc(
        { type: "prompt", message, images: spec.images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) },
        timeout,
      );
      const disposition = String(response.disposition ?? "");
      if (disposition !== "handled") {
        throw new AdapterError(
          "startup_failed",
          `otto extension did not consume the prompt (disposition: ${disposition || "missing"}); ` +
            `is ~/.otto/ext loadable?`,
        );
      }
      try {
        spec.onPromptAccepted?.();
      } catch {
        // bookkeeping must never fail launch
      }
      this.pendingResumeSpecs.set(spec.workerId, spec);
      setImmediate(() => this.flushBuffered(runtime));
      return handle;
    } catch (err) {
      // Startup failed → broken (§5.1); clean up the process and rethrow.
      runtime.buffered = null; // nothing started, so nothing to replay
      this.runtimes.delete(spec.workerId);
      runtime.stopping = true;
      await proc.close().catch(() => proc.kill());
      if (err instanceof AdapterError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      const cmdSuffix = err instanceof RpcError && err.command ? ` [rpc=${err.command}]` : "";
      const stderr = proc.getStderrTail().trim();
      const stderrSuffix = stderr ? `; stderr: ${stderr.slice(-400)}` : "";
      throw new AdapterError("startup_failed", `pi startup failed: ${reason}${cmdSuffix}${stderrSuffix}`);
    }
  }

  async send(
    id: string,
    input: { text: string; images?: { data: string; mimeType: string }[]; commandId?: string },
    how: Delivery,
  ): Promise<{ effect?: string }> {
    const runtime = this.require(id);
    const images = input.images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    if (how === "prompt") {
      runtime.reReportAttempted = false;
      runtime.rewritingReport = false;
      runtime.savedLastText = undefined;
      // A prompt-path send goes through the same `/otto` wrapper as the initial prompt,
      // so the commandId marker lands in the session (ADR-0001: ambiguous-command detection).
      const message = input.commandId ? wrapPrompt(input.commandId, input.text) : input.text;
      await runtime.process.rpc({ type: "prompt", message, images });
      return {};
    }
    // §6.3: a queued steer/follow_up cannot carry the `/otto` wrapper (pi forbids
    // extension commands there), so the commandId travels as an input preamble. pi's input
    // handler runs before queueing: it strips the preamble and appends the custom entry, so
    // the marker is on disk from the moment pi ACCEPTS the message into its queue.
    const type = how === "steer" ? "steer" : "follow_up";
    const message = input.commandId ? markerPreamble(input.commandId, input.text) : input.text;
    await runtime.process.rpc({ type, message, images });
    // §6.2: steer takes effect after the current tool batch finishes.
    return { effect: how === "steer" ? "after_current_tools" : undefined };
  }

  /** §6.2: `clear_queue` first — the returned texts ride the `queue_returned` event so the
   *  steward can decide whether to resend — then `abort`. If `abort` fails after
   *  `clear_queue` already emptied pi's queue, the retrieved texts ride a
   *  PartialInterruptError so the manager can still surface them (R2-3: pi has no copy). */
  async interrupt(id: string): Promise<InterruptResult> {
    const runtime = this.require(id);
    runtime.rewritingReport = false;
    runtime.savedLastText = undefined;
    const queue = (await runtime.process.rpc({ type: "clear_queue" })) as {
      steering?: unknown;
      followUp?: unknown;
    };
    const returned = [...queueTexts(queue.steering), ...queueTexts(queue.followUp)];
    try {
      await runtime.process.rpc({ type: "abort" });
    } catch (err) {
      throw new PartialInterruptError(returned, err instanceof Error ? err : new Error(String(err)));
    }
    return { returned };
  }

  async resume(id: string, reason: string, options: { commandId?: string } = {}): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.process.hasExited) {
      runtime.reReportAttempted = false;
      runtime.rewritingReport = false;
      runtime.savedLastText = undefined;
      // §6.3: the resume prompt on a live process carries the marker like any other prompt,
      // so a crash mid-`sending` is decidable from the session tail.
      const commandId = options.commandId ?? `resume-${Date.now()}`;
      await runtime.process.rpc({ type: "prompt", message: wrapPrompt(commandId, `${RESUME_PROMPT}\n\nReason: ${reason}`) });
      return;
    }
    // Relaunch with the same session id and send the fixed resume prompt (§9.2).
    const existing = this.pendingResumeSpecs.get(id);
    if (!existing) throw new AdapterError("not_found", `no known spec to resume worker ${id}`);
    await this.start({ ...existing, prompt: RESUME_PROMPT, commandId: options.commandId ?? `resume-${Date.now()}` });
  }

  /** Remembered so `resume` can relaunch a dead worker (§9.2). */
  private readonly pendingResumeSpecs = new Map<string, StartSpec>();

  async stopProcess(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.stopping = true;
    this.runtimes.delete(id);
    await runtime.process.close();
  }

  isRunning(id: string): boolean {
    const runtime = this.runtimes.get(id);
    return !!runtime && !runtime.process.hasExited;
  }

  isStreaming(id: string): boolean {
    const runtime = this.runtimes.get(id);
    return !!runtime && !runtime.process.hasExited && (runtime.window.open || runtime.rewritingReport);
  }

  /** Live worker pids for the descendant-snapshot loop (connector-pi.md §9.3). */
  workerPids(): Array<{ workerId: string; pid: number }> {
    const out: Array<{ workerId: string; pid: number }> = [];
    for (const [workerId, runtime] of this.runtimes) {
      const pid = runtime.process.pid;
      if (!runtime.process.hasExited && pid !== undefined) out.push({ workerId, pid });
    }
    return out;
  }

  /** §11.4 live path: `get_entries{since}` is pi's only incremental read (research §3). */
  async history(id: string, since: string | undefined, maxBytes: number): Promise<HistoryPage> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.process.hasExited) {
      throw new AdapterError("not_running", `no live pi process for worker ${id}`);
    }
    const response = await runtime.process.rpc(
      { type: "get_entries", ...(since ? { since } : {}) },
      10_000,
    );
    const entries = Array.isArray(response.entries) ? (response.entries as Record<string, unknown>[]) : [];
    // `since` filtering already happened inside pi; the normalizer only budgets the bytes.
    return normalizeSessionEntries(entries, { maxBytes });
  }

  /** Live processes with their last stdout time — the stall watchdog's inputs (issue #13). */
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

  /** Test support: emulate a connector crash — every child is SIGKILLed with no graceful
   * stop, lock files are left on disk exactly as a real crash leaves them, and exit events
   * are marked "expected" so a still-listening manager takes no recovery action. */
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
      throw new AdapterError("not_running", `no live pi process for worker ${id}`);
    }
    return runtime;
  }

  // --- Event normalization (§11.1 sources) ------------------------------------------------

  private onPiEvent(runtime: WorkerRuntime, record: Record<string, unknown>): void {
    switch (record.type) {
      case "agent_start": {
        // Run window = from the FIRST agent_start after a command is accepted to the next
        // agent_settled (§5.2); retries re-entering agent_start stay inside the window.
        if (!runtime.window.open) {
          runtime.window = { open: true, aborted: false };
        }
        return;
      }
      case "turn_start": {
        runtime.turn += 1;
        if (Date.now() - runtime.lastStatsProbeAt >= 15_000) {
          void this.probeLiveStats(runtime, false);
        }
        const telemetry = this.snapshotTelemetry(runtime);
        this.emit({
          type: "progress",
          workerId: runtime.workerId,
          phase: "thinking",
          turn: runtime.turn,
          ...(telemetry ? { telemetry } : {}),
        });
        return;
      }
      case "tool_execution_start": {
        const tool = String(record.toolName ?? "unknown");
        if (runtime.rewritingReport && tool !== "report") {
          // Guardrail: a report-only rewrite pass must NEVER run file/shell tools.
          void runtime.process.rpc({ type: "abort" }, 2000).catch(() => undefined);
          return;
        }
        const callKey = String(record.toolCallId ?? record.id ?? tool);
        runtime.activeTools.set(callKey, Date.now());
        if (tool === "report") {
          const report = normalizeReport(record.args);
          if (report) runtime.window.report = report;
        } else {
          runtime.window.hadWork = true;
          if (tool === "propose") {
            const proposal = normalizeProposal(record.args);
            if (proposal) {
              this.emit({
                type: "proposal",
                workerId: runtime.workerId,
                proposal,
              });
            }
          }
        }
        const telemetry = this.snapshotTelemetry(runtime);
        this.emit({
          type: "progress",
          workerId: runtime.workerId,
          phase: "tool",
          tool,
          target: extractTarget(record.args),
          turn: runtime.turn,
          ...(telemetry ? { telemetry } : {}),
        });
        return;
      }
      case "tool_execution_end": {
        const tool = String(record.toolName ?? "unknown");
        const callKey = String(record.toolCallId ?? record.id ?? tool);
        const startedAt = runtime.activeTools.get(callKey);
        if (startedAt !== undefined) {
          runtime.activeTools.delete(callKey);
          runtime.lastToolMs = Math.max(0, Date.now() - startedAt);
        }
        return;
      }
      case "auto_compaction_start":
      case "compaction_start": {
        const telemetry = this.snapshotTelemetry(runtime);
        this.emit({
          type: "progress",
          workerId: runtime.workerId,
          phase: "compacting",
          turn: Math.max(1, runtime.turn),
          ...(telemetry ? { telemetry } : {}),
        });
        return;
      }
      case "auto_compaction_end":
      case "compaction_end":
      case "compaction": {
        runtime.compactionCount += 1;
        void this.probeLiveStats(runtime, true);
        const telemetry = this.snapshotTelemetry(runtime);
        this.emit({
          type: "progress",
          workerId: runtime.workerId,
          phase: "thinking",
          turn: Math.max(1, runtime.turn),
          ...(telemetry ? { telemetry } : {}),
        });
        return;
      }
      case "message_end": {
        const message = record.message as Record<string, unknown> | undefined;
        if (message?.role === "assistant") {
          runtime.window.lastAssistant = {
            stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
            errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
            text: extractText(message.content),
          };
        }
        return;
      }
      case "auto_retry_end": {
        runtime.window.lastRetry = {
          success: record.success === true,
          finalError: typeof record.finalError === "string" ? record.finalError : undefined,
        };
        return;
      }
      case "agent_settled": {
        if (!runtime.window.open) return;
        runtime.window.aborted = record.aborted === true;
        void this.settle(runtime);
        return;
      }
      default:
        return;
    }
  }

  private snapshotTelemetry(
    runtime: WorkerRuntime,
    cuOverride?: SessionUsage["contextUsage"],
  ): WorkerLiveTelemetry | undefined {
    const cu = cuOverride ?? runtime.latestContextUsage;
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
      } else if (out.contextTokens != null && out.contextWindow != null && out.contextWindow > 0) {
        out.contextPercent = Math.round((out.contextTokens / out.contextWindow) * 100);
      }
    }
    if (runtime.compactionCount > 0) out.compactionCount = runtime.compactionCount;
    if (runtime.lastToolMs !== null) out.lastToolMs = runtime.lastToolMs;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private async probeLiveStats(runtime: WorkerRuntime, emitAfter: boolean): Promise<void> {
    if (runtime.process.hasExited) return;
    runtime.lastStatsProbeAt = Date.now();
    const stats = (await runtime.process.rpc({ type: "get_session_stats" }, 1500).catch(() => undefined)) as SessionUsage | undefined;
    if (!stats?.contextUsage || !runtime.window.open) return;
    runtime.latestContextUsage = stats.contextUsage;
    if (emitAfter) {
      const telemetry = this.snapshotTelemetry(runtime);
      if (telemetry) {
        this.emit({
          type: "progress",
          workerId: runtime.workerId,
          phase: "thinking",
          turn: Math.max(1, runtime.turn),
          telemetry,
        });
      }
    }
  }

  private async settle(runtime: WorkerRuntime): Promise<void> {
    const facts = runtime.window;
    let adjudicated: Adjudication = adjudicate(facts);
    runtime.window = { open: false, aborted: false };
    runtime.turn = 0;
    runtime.activeTools.clear();

    if (runtime.rewritingReport) {
      const fallbackText = runtime.savedLastText;
      runtime.rewritingReport = false;
      runtime.savedLastText = undefined;
      // If the rewrite pass tripped the non-report tool guardrail (aborted) or still omitted
      // `report`, fall back cleanly to `unreported` with the original turn's assistant text.
      if (adjudicated.outcome === "aborted" || adjudicated.outcome === "unreported") {
        adjudicated = {
          outcome: "unreported",
          lastText: fallbackText || adjudicated.lastText,
        };
      }
    } else {
      const rewriteMode = this.options.rewriteUnreported ?? "on_work";
      const shouldRewrite =
        rewriteMode !== false &&
        adjudicated.outcome === "unreported" &&
        (rewriteMode === "always" || facts.hadWork === true) &&
        !runtime.reReportAttempted &&
        !runtime.stopping &&
        !runtime.process.hasExited;
      if (shouldRewrite) {
        runtime.reReportAttempted = true;
        runtime.rewritingReport = true;
        runtime.savedLastText = adjudicated.lastText;
        try {
          await runtime.process.rpc({ type: "prompt", message: REWRITE_REPORT_PROMPT }, 5000);
          return;
        } catch {
          runtime.rewritingReport = false;
          runtime.savedLastText = undefined;
        }
      }
    }

    // usage from get_session_stats at settlement (§11.2).
    let usage: SessionUsage | undefined;
    if (!runtime.process.hasExited) {
      usage = (await runtime.process.rpc({ type: "get_session_stats" }, 2000).catch(() => undefined)) as SessionUsage | undefined;
    }
    if (usage?.contextUsage) runtime.latestContextUsage = usage.contextUsage;
    const { turnUsage, nextCursor } = diffCumulativeSessionUsage(runtime.settledCursor, usage);
    runtime.settledCursor = nextCursor;
    const telemetry = this.snapshotTelemetry(runtime, usage?.contextUsage);
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
      usage,
      ...(turnUsage ? { turnUsage } : {}),
      ...(telemetry ? { telemetry } : {}),
    });
  }

  private onPiExit(runtime: WorkerRuntime, info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.runtimes.get(runtime.workerId) === runtime) this.runtimes.delete(runtime.workerId);
    this.emit({
      type: "process_exit",
      workerId: runtime.workerId,
      code: info.code,
      signal: info.signal,
      // An exit while still buffering (start() has not resolved) is reported through
      // start()'s own rejection — an `unexpected` process_exit here would race the
      // startup-failure handling in the WorkerManager.
      unexpected: !runtime.stopping && runtime.buffered === null,
    });
  }
}

/** `/otto <commandId>\n<text>` — the extension unwraps it and writes the marker (ADR-0001). */
export function wrapPrompt(commandId: string, text: string): string {
  return `/${OTTO_COMMAND} ${commandId}\n${text}`;
}

/** The §6.3 marker for deliveries pi will not accept extension commands on (steer/
 *  follow_up): a one-line preamble that is part of the message itself, so pi persists it
 *  together with the user message exactly when the message is delivered. */
export function markerPreamble(commandId: string, text: string): string {
  return `[otto:command ${commandId}]\n${text}`;
}

export interface NormalizeReportOptions {
  onDiagnostic?: (message: string) => void;
}

/** Validates and normalizes `report` tool args into the §7.2 payload; null when invalid. */
export function normalizeReport(args: unknown, options?: NormalizeReportOptions): ReportPayload | null {
  if (typeof args !== "object" || args === null) return null;
  const raw = args as Record<string, unknown>;
  const status = raw.status;
  if (status !== "done" && status !== "blocked" && status !== "needs_decision") return null;
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  const stringList = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
  const payload: ReportPayload = { status, summary };
  const changes = stringList(raw.changes);
  if (changes) payload.changes = changes;
  const decisions = stringList(raw.decisions);
  if (decisions) payload.decisions = decisions;
  const leftovers = stringList(raw.leftovers);
  if (leftovers) payload.leftovers = leftovers;
  const normalizedLabels = normalizeReportLabels(raw.labels);
  if (normalizedLabels.labels !== undefined) payload.labels = normalizedLabels.labels;
  if (normalizedLabels.dropped.length > 0) {
    const diag = `report.labels dropped invalid/excess entries: ${normalizedLabels.dropped.join(", ")}`;
    if (options?.onDiagnostic) options.onDiagnostic(diag);
    else process.stderr.write(`[otto] ${diag}\n`);
  }
  if (typeof raw.question === "string") payload.question = raw.question;
  if (typeof raw.next === "string") payload.next = raw.next;
  if (typeof raw.answer === "string") payload.answer = raw.answer;
  if (typeof raw.tests === "object" && raw.tests !== null) {
    const tests = raw.tests as Record<string, unknown>;
    payload.tests = {
      ran: tests.ran === true,
      passed: typeof tests.passed === "boolean" ? tests.passed : undefined,
      note: typeof tests.note === "string" ? tests.note : undefined,
    };
  }
  return payload;
}

/** Strictly validates `propose` tool args into ProposalPayload; null when invalid. */
export function normalizeProposal(args: unknown): ProposalPayload | null {
  return parseProposalPayload(args);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .join("");
}

export { extractText as extractAssistantText };

/** `clear_queue` hands back the queued messages (real pi queues plain strings); tolerate
 *  message-shaped items too so a future pi change cannot silently drop texts. */
function queueTexts(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) =>
      typeof item === "string" ? item : extractText((item as { content?: unknown } | null)?.content),
    )
    .filter((text) => text.length > 0);
}

/** First 80 chars of a path or command — never file contents or command output (§11.2). */
export function extractTarget(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const raw = args as Record<string, unknown>;
  for (const key of ["file_path", "path", "filename", "command", "pattern", "query", "url", "targetRepoRef"]) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 80);
  }
  return undefined;
}
