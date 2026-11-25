// CommandAdapter: Locally allowlisted CLI template adapter for `dsh` (DeepSeek Harness 0.2.2+),
// `zcode`, and custom local CLI wrappers (`command`).
//
// Security & protocol invariants adapted from `KKKKhazix/agent-autoloop` (`plugins/dsh/agent.ts`,
// `plugins/command/agent.ts`, `SECURITY.md`) and Otto ADR-0022:
// 1. Local-only allowlist: command templates live exclusively in `LocalStore` (`connector.sqlite`)
//    or local environment variables, NEVER in Steward wire commands.
// 2. Single-pass callback placeholder substitution: `{prompt|model|effort|cwd|context|sessionId|reportFile}`
//    is substituted in one regex pass via a replacement callback on argv tokens (`shell: false`),
//    eliminating `$&` / `$'` replacement-pattern corruption and recursive `{cwd}` expansion.
// 3. `dsh` 0.2.2+ JSONL streaming: accumulates `step_end` token & USD cost deltas across multi-step
//    turns, captures `sessionID` for `--session` continuation, and supports `OTTO_REPORT_FILE` +
//    structured JSON report extraction.
import type {
  AgentAdapter,
  AgentAuthStatus,
  AgentCapabilities,
  Delivery,
  InterruptResult,
  RawAdapterEvent,
  ReportPayload,
  SessionUsage,
  StartSpec,
  WorkerHandle,
} from "./agent.ts";
import { AdapterError } from "./agent.ts";
import { adjudicate, inspectRateLimitReset, type RunWindow } from "./adjudication.ts";
import { childEnv, extractTarget, normalizeProposal, normalizeReport, RESUME_PROMPT } from "./pi-adapter.ts";
import { WORKER_SYSTEM_PROMPT } from "./install.ts";
import { resolveExecutableLaunch, splitCommandLine, type LaunchResolution } from "./pi-launch.ts";
import type { AgentModelCatalog } from "@isaac2ingrid/protocol";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { appendCapped } from "./logger.ts";

export type CommandAgentKind = "dsh" | "zcode" | "command";
export type CommandOutputFormat = "dsh-jsonl" | "json" | "text";

export const DSH_COMMAND_ENV = "OTTO_DSH_COMMAND";
export const ZCODE_COMMAND_ENV = "OTTO_ZCODE_COMMAND";

export interface CommandTemplateValues {
  prompt: string;
  model: string;
  effort: string;
  cwd: string;
  context: string;
  sessionId: string;
  reportFile: string;
}

const PLACEHOLDER_RE = /\{(prompt|model|effort|cwd|context|sessionId|reportFile)\}/g;

/** Substitutes `{prompt|model|effort|cwd|context|sessionId|reportFile}` across argv tokens in
 *  a single regex pass with a function callback so `$&` / `$'` / `$$` inside prompts are
 *  preserved verbatim and prompt text containing `{cwd}` is never expanded a second time. */
export function substituteCommandArgv(
  template: readonly string[],
  values: Partial<CommandTemplateValues>,
): string[] {
  return template.map((token) =>
    token.replace(PLACEHOLDER_RE, (_match, key: keyof CommandTemplateValues) => {
      const val = values[key];
      return typeof val === "string" ? val : "";
    }),
  );
}

export interface CommandPresetSpec {
  kind: CommandAgentKind;
  /** Base executable argv prefix (e.g. `["dsh"]` or `[node, "fake-dsh.mjs"]`). */
  command: string[];
  /** Args appended after `command` for normal (`write`) launches. */
  argsTemplate: string[];
  /** Optional args template when continuing an existing `sessionId`. */
  resumeArgsTemplate?: string[];
  /** Optional args template for strict `readonly` launches; if omitted, `capabilities.readonly` is false. */
  readonlyArgsTemplate?: string[];
  /** Optional args template when continuing an existing `sessionId` in `readonly` mode. */
  readonlyResumeArgsTemplate?: string[];
  /** Extra model flag pair (e.g. `["--model", "{model}"]`) appended when `spec.model` is set
   *  and `{model}` does not already appear in the selected template. */
  modelArgsTemplate?: string[];
  outputFormat: CommandOutputFormat;
  defaultEffort?: string;
}

export interface StoredCommandAdapterConfig {
  enabled: boolean;
  command: string[];
  argsTemplate?: string[];
  resumeArgsTemplate?: string[];
  readonlyArgsTemplate?: string[];
  outputFormat?: CommandOutputFormat;
  defaultEffort?: string;
}

export function buildDshPreset(command: string[] = ["dsh"]): CommandPresetSpec {
  return {
    kind: "dsh",
    command,
    argsTemplate: ["run", "--format", "json", "{prompt}"],
    resumeArgsTemplate: ["run", "--format", "json", "--session", "{sessionId}", "{prompt}"],
    readonlyArgsTemplate: ["run", "--format", "json", "--readonly", "{prompt}"],
    readonlyResumeArgsTemplate: ["run", "--format", "json", "--readonly", "--session", "{sessionId}", "{prompt}"],
    modelArgsTemplate: ["--model", "{model}"],
    outputFormat: "dsh-jsonl",
  };
}

export function buildZcodePreset(command: string[] = ["zcode"]): CommandPresetSpec {
  return {
    kind: "zcode",
    command,
    argsTemplate: ["run", "--output-format", "json", "{prompt}"],
    resumeArgsTemplate: ["run", "--output-format", "json", "--resume", "{sessionId}", "{prompt}"],
    readonlyArgsTemplate: ["run", "--output-format", "json", "--readonly", "{prompt}"],
    readonlyResumeArgsTemplate: ["run", "--output-format", "json", "--readonly", "--resume", "{sessionId}", "{prompt}"],
    modelArgsTemplate: ["--model", "{model}"],
    outputFormat: "json",
  };
}

export function dshCommandFromEnv(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env[DSH_COMMAND_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const argv = splitCommandLine(raw).filter(Boolean);
  return argv.length > 0 ? argv : undefined;
}

export function zcodeCommandFromEnv(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env[ZCODE_COMMAND_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const argv = splitCommandLine(raw).filter(Boolean);
  return argv.length > 0 ? argv : undefined;
}

export interface CommandAdapterOptions {
  stateDir: string;
  preset: CommandPresetSpec;
  env?: Record<string, string | undefined>;
  workerLogsDir?: string | null;
  version?: string;
  authStatus?: AgentAuthStatus;
  stopGraceMs?: number;
  launch?: LaunchResolution;
}

interface DshStepAccumulator {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  hasTokens: boolean;
  hasCost: boolean;
  contextWindow?: number;
  lastStepTokens?: number;
}

interface CommandWorkerRuntime {
  workerId: string;
  child: ChildProcess;
  cwd: string;
  sessionId: string;
  reportFile: string;
  proposalsFile: string;
  emittedProposalKeys: Set<string>;
  stopping: boolean;
  aborted: boolean;
  exited: boolean;
  exitWaiters: (() => void)[];
  lastOutputAt: number;
  stdoutBuffer: string;
  rawStdout: string;
  stderrTail: string;
  decoder: StringDecoder;
  turn: number;
  window: RunWindow & { open: boolean };
  dshUsage: DshStepAccumulator;
  jsonUsage?: SessionUsage;
  explicitResetAt?: number;
  buffered: RawAdapterEvent[] | null;
}

export class CommandAdapter implements AgentAdapter {
  readonly kind: CommandAgentKind;
  readonly capabilities: AgentCapabilities;
  readonly modelCatalog: AgentModelCatalog = {
    capabilities: {
      selection: "launch",
      discovery: "none",
      customModelInput: true,
      actualModelObservation: false,
      thinkingSelection: false,
    },
    status: "ready",
    models: [],
  };

  private readonly options: CommandAdapterOptions;
  private readonly preset: CommandPresetSpec;
  private readonly workerLogsDir: string | null;
  private readonly runtimes = new Map<string, CommandWorkerRuntime>();
  private readonly listeners: ((e: RawAdapterEvent) => void)[] = [];
  private readonly lastSpecs = new Map<string, StartSpec>();
  private readonly sessionIds = new Map<string, string>();
  private launch?: LaunchResolution;

  constructor(options: CommandAdapterOptions) {
    this.options = options;
    this.preset = options.preset;
    this.kind = options.preset.kind;
    this.capabilities = {
      steer: false,
      followUp: false,
      interrupt: true,
      resume: Boolean(options.preset.resumeArgsTemplate),
      history: false,
      images: false,
      structuredReport: true,
      readonly: Boolean(options.preset.readonlyArgsTemplate),
    };
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
    this.launch = this.launch ?? this.options.launch ?? resolveExecutableLaunch(this.preset.command);
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

  private flushBuffered(runtime: CommandWorkerRuntime): void {
    const buffered = runtime.buffered;
    runtime.buffered = null;
    if (!buffered) return;
    for (const event of buffered) {
      for (const fn of this.listeners) fn(event);
    }
  }

  buildCommandArgs(spec: StartSpec, reportFile: string): string[] {
    const isResume = Boolean(spec.resumeSessionId);
    let template: string[];
    if (spec.mode === "readonly") {
      if (!this.preset.readonlyArgsTemplate) {
        throw new AdapterError("readonly_unsupported", `agent '${this.kind}' has no readonlyArgsTemplate configured`);
      }
      template =
        isResume && this.preset.readonlyResumeArgsTemplate
          ? [...this.preset.readonlyResumeArgsTemplate]
          : [...this.preset.readonlyArgsTemplate];
    } else {
      template =
        isResume && this.preset.resumeArgsTemplate
          ? [...this.preset.resumeArgsTemplate]
          : [...this.preset.argsTemplate];
    }

    if (spec.model && this.preset.modelArgsTemplate && !template.some((t) => t.includes("{model}"))) {
      template = [...this.preset.modelArgsTemplate, ...template];
    }

    const reportInstruction =
      `\n\n[Otto Report Contract]: When finished, write a single JSON object matching ` +
      `{"status":"done"|"blocked"|"needs_decision","summary":"...","changes":[...],"answer":"..."} ` +
      `to the file path in env OTTO_REPORT_FILE (${reportFile}), or include a final JSON block with "otto_report".`;

    const fullPrompt = isResume
      ? `${spec.prompt}${reportInstruction}`
      : `${WORKER_SYSTEM_PROMPT}\n\n${spec.prompt}${reportInstruction}`;

    return substituteCommandArgv(template, {
      prompt: fullPrompt,
      model: spec.model ?? "",
      effort: this.preset.defaultEffort ?? "high",
      cwd: spec.cwd,
      context: spec.threadId,
      sessionId: spec.resumeSessionId ?? spec.workerId,
      reportFile,
    });
  }

  async start(spec: StartSpec): Promise<WorkerHandle> {
    if (this.runtimes.has(spec.workerId)) {
      throw new AdapterError("lock_held", `a ${this.kind} process for ${spec.workerId} is already running`);
    }
    const launch = this.launchResolution;
    if (launch.error || !launch.argv[0]) {
      throw new AdapterError("launch_unresolved", launch.error ?? `cannot resolve ${this.kind} binary`);
    }

    const reportDir = join(this.options.stateDir, "mcp", "reports");
    const proposalsDir = join(this.options.stateDir, "mcp", "proposals");
    mkdirSync(reportDir, { recursive: true });
    mkdirSync(proposalsDir, { recursive: true });
    if (this.workerLogsDir) mkdirSync(this.workerLogsDir, { recursive: true });

    const reportFile = join(reportDir, `${spec.workerId}.json`);
    const proposalsFile = join(proposalsDir, `proposals-${spec.workerId}.jsonl`);
    rmSync(reportFile, { force: true });
    rmSync(proposalsFile, { force: true });

    const cmdArgs = this.buildCommandArgs(spec, reportFile);

    const env = childEnv(process.env, {
      ...this.options.env,
      // Note: `childEnv` strips incoming `OTTO_*` from `process.env` first, then applies `extra`,
      // so `OTTO_REPORT_FILE` is safe and contains no Connector credentials.
      OTTO_REPORT_FILE: reportFile,
      OTTO_PROPOSALS_FILE: proposalsFile,
    });
    if (!env.HOME) env.HOME = homedir();

    const child = spawn(launch.argv[0], [...launch.argv.slice(1), ...cmdArgs], {
      cwd: spec.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    child.stdin?.end();

    const initialSessionId = spec.resumeSessionId ?? this.sessionIds.get(spec.workerId) ?? spec.workerId;
    const runtime: CommandWorkerRuntime = {
      workerId: spec.workerId,
      child,
      cwd: spec.cwd,
      sessionId: initialSessionId,
      reportFile,
      proposalsFile,
      emittedProposalKeys: new Set(),
      stopping: false,
      aborted: false,
      exited: false,
      exitWaiters: [],
      lastOutputAt: Date.now(),
      stdoutBuffer: "",
      rawStdout: "",
      stderrTail: "",
      decoder: new StringDecoder("utf8"),
      turn: 1,
      window: { open: true, aborted: false },
      dshUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
        hasTokens: false,
        hasCost: false,
      },
      buffered: [],
    };
    this.runtimes.set(spec.workerId, runtime);
    this.lastSpecs.set(spec.workerId, spec);
    this.sessionIds.set(spec.workerId, initialSessionId);

    const stderrFile = this.workerLogsDir ? join(this.workerLogsDir, `${this.kind}-${spec.workerId}.log`) : undefined;
    child.stdout?.on("data", (chunk: Buffer) => this.onStdoutChunk(runtime, chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      runtime.stderrTail = (runtime.stderrTail + text).slice(-65_536);
      if (stderrFile) appendCapped(stderrFile, text, 65_536);
    });
    child.on("error", (err) => {
      runtime.stderrTail = (runtime.stderrTail + `\n[otto] spawn error: ${err.message}\n`).slice(-65_536);
      this.onExit(runtime, null, null);
    });
    child.on("exit", (code, signal) => this.onExit(runtime, code, signal));

    try {
      spec.onSession?.(null, null);
      spec.onPromptAccepted?.();
    } catch {
      // bookkeeping must never fail launch
    }

    this.emit({ type: "progress", workerId: spec.workerId, phase: "thinking", turn: 1 });
    const handle: WorkerHandle = { workerId: spec.workerId, sessionId: runtime.sessionId, cwd: spec.cwd };
    setImmediate(() => this.flushBuffered(runtime));
    return handle;
  }

  async send(
    id: string,
    input: { text: string; images?: { data: string; mimeType: string }[]; commandId?: string },
    how: Delivery,
  ): Promise<{ effect?: string }> {
    if (how !== "prompt") {
      throw new AdapterError("unsupported", `${this.kind} cannot ${how} mid-run`);
    }
    if (this.isRunning(id)) {
      throw new AdapterError("busy", `${this.kind} worker ${id} is currently running`);
    }
    const spec = this.lastSpecs.get(id);
    if (!spec) {
      throw new AdapterError("not_found", `no known spec to continue ${this.kind} worker ${id}`);
    }
    const resumeSessionId = this.capabilities.resume ? (this.sessionIds.get(id) ?? spec.resumeSessionId) : undefined;
    await this.start({
      ...spec,
      prompt: input.text,
      commandId: input.commandId ?? spec.commandId,
      resumeSessionId,
    });
    return {};
  }

  async interrupt(id: string): Promise<InterruptResult> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.exited) {
      return { returned: [], alreadySettled: true };
    }
    runtime.aborted = true;
    await this.terminateRuntime(runtime);
    return { returned: [] };
  }

  async resume(id: string, reason: string, options: { commandId?: string } = {}): Promise<void> {
    if (!this.capabilities.resume) {
      throw new AdapterError("unsupported", `${this.kind} does not support session resume`);
    }
    const spec = this.lastSpecs.get(id);
    const resumeSessionId = this.sessionIds.get(id) ?? spec?.resumeSessionId;
    if (!spec || !resumeSessionId) {
      throw new AdapterError("not_found", `no known session to resume ${this.kind} worker ${id}`);
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
    await this.terminateRuntime(runtime);
  }

  isRunning(id: string): boolean {
    const runtime = this.runtimes.get(id);
    return !!runtime && !runtime.exited;
  }

  isStreaming(id: string): boolean {
    return this.isRunning(id);
  }

  workerPids(): Array<{ workerId: string; pid: number }> {
    const out: Array<{ workerId: string; pid: number }> = [];
    for (const [workerId, runtime] of this.runtimes) {
      if (!runtime.exited && runtime.child.pid !== undefined) {
        out.push({ workerId, pid: runtime.child.pid });
      }
    }
    return out;
  }

  workerActivity(): Array<{ workerId: string; pid: number; lastOutputAt: number }> {
    const out: Array<{ workerId: string; pid: number; lastOutputAt: number }> = [];
    for (const [workerId, runtime] of this.runtimes) {
      if (!runtime.exited && runtime.child.pid !== undefined) {
        out.push({ workerId, pid: runtime.child.pid, lastOutputAt: runtime.lastOutputAt });
      }
    }
    return out;
  }

  simulateCrash(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.stopping = true;
      try {
        runtime.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    this.runtimes.clear();
  }

  private async terminateRuntime(runtime: CommandWorkerRuntime): Promise<void> {
    if (runtime.exited) return;
    const wait = new Promise<void>((r) => runtime.exitWaiters.push(r));
    try {
      runtime.child.kill("SIGTERM");
    } catch {
      // already gone
    }
    const timer = setTimeout(() => {
      if (!runtime.exited) {
        try {
          runtime.child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, this.options.stopGraceMs ?? 2_000);
    timer.unref?.();
    await wait;
    clearTimeout(timer);
  }

  private onStdoutChunk(runtime: CommandWorkerRuntime, chunk: Buffer): void {
    runtime.lastOutputAt = Date.now();
    const decoded = runtime.decoder.write(chunk);
    runtime.rawStdout = (runtime.rawStdout + decoded).slice(-256_000);
    if (this.preset.outputFormat === "text") return;

    runtime.stdoutBuffer += decoded;
    let nl: number;
    while ((nl = runtime.stdoutBuffer.indexOf("\n")) !== -1) {
      let line = runtime.stdoutBuffer.slice(0, nl);
      runtime.stdoutBuffer = runtime.stdoutBuffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this.consumeStructuredLine(runtime, line.trim());
    }
  }

  private consumeStructuredLine(runtime: CommandWorkerRuntime, line: string): void {
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      record = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    // Capture session identifier (`dsh` uses `sessionID`, `zcode`/others use `session_id` or `sessionId`).
    const observedSid =
      typeof record.sessionID === "string"
        ? record.sessionID
        : typeof record.session_id === "string"
          ? record.session_id
          : typeof record.sessionId === "string"
            ? record.sessionId
            : undefined;
    if (observedSid && observedSid.trim().length > 0) {
      runtime.sessionId = observedSid.trim();
      this.sessionIds.set(runtime.workerId, runtime.sessionId);
    }

    const type = typeof record.type === "string" ? record.type : "";

    // `dsh` 0.2.2+ `step_end` token & USD cost accumulation across steps.
    if (type === "step_end" || type === "step_finish") {
      const part =
        typeof record.part === "object" && record.part !== null ? (record.part as Record<string, unknown>) : record;
      const tokens =
        typeof part.tokens === "object" && part.tokens !== null ? (part.tokens as Record<string, unknown>) : null;
      if (tokens) {
        const baseIn = typeof tokens.input === "number" ? tokens.input : 0;
        const cacheRead =
          typeof tokens.cacheRead === "number"
            ? tokens.cacheRead
            : typeof (tokens.cache as Record<string, unknown> | undefined)?.read === "number"
              ? ((tokens.cache as Record<string, unknown>).read as number)
              : 0;
        const cacheWrite =
          typeof tokens.cacheWrite === "number"
            ? tokens.cacheWrite
            : typeof (tokens.cache as Record<string, unknown> | undefined)?.write === "number"
              ? ((tokens.cache as Record<string, unknown>).write as number)
              : 0;
        const outTok =
          (typeof tokens.output === "number" ? tokens.output : 0) +
          (typeof tokens.reasoning === "number" ? tokens.reasoning : 0);
        const stepInput = baseIn + cacheRead + cacheWrite;
        runtime.dshUsage.inputTokens += stepInput;
        runtime.dshUsage.outputTokens += outTok;
        runtime.dshUsage.cachedInputTokens += cacheRead + cacheWrite;
        runtime.dshUsage.lastStepTokens = stepInput + outTok;
        runtime.dshUsage.hasTokens = true;
      }
      const costVal = typeof part.cost === "number" ? part.cost : typeof record.cost === "number" ? record.cost : undefined;
      if (costVal !== undefined && Number.isFinite(costVal) && costVal >= 0) {
        runtime.dshUsage.costUsd = Math.round((runtime.dshUsage.costUsd + costVal) * 1e8) / 1e8;
        runtime.dshUsage.hasCost = true;
      }
      if (typeof part.contextWindow === "number" && part.contextWindow > 0) {
        runtime.dshUsage.contextWindow = part.contextWindow;
      }
      runtime.turn += 1;
      this.emit({ type: "progress", workerId: runtime.workerId, phase: "thinking", turn: runtime.turn });
      return;
    }

    if (type === "tool_call" || type === "tool_use" || type === "tool_start") {
      runtime.window.hadWork = true;
      const toolName =
        typeof record.tool === "string"
          ? record.tool
          : typeof record.name === "string"
            ? record.name
            : "tool";
      const args = record.input ?? record.args ?? record.arguments;
      if (toolName === "report" || toolName.endsWith("__report")) {
        const rep = normalizeReport(args);
        if (rep) runtime.window.report = rep;
      } else if (toolName === "propose" || toolName.endsWith("__propose")) {
        const prop = normalizeProposal(args);
        if (prop && !runtime.emittedProposalKeys.has(prop.proposalKey)) {
          runtime.emittedProposalKeys.add(prop.proposalKey);
          this.emit({ type: "proposal", workerId: runtime.workerId, proposal: prop });
        }
      }
      this.emit({
        type: "progress",
        workerId: runtime.workerId,
        phase: "tool",
        tool: toolName,
        target: extractTarget(args),
        turn: runtime.turn,
      });
      return;
    }

    if (type === "error" || record.is_error === true) {
      const errMsg =
        typeof record.message === "string"
          ? record.message
          : typeof record.error === "string"
            ? record.error
            : typeof record.result === "string"
              ? record.result
              : `${this.kind} command reported an error`;
      const explicitReset = extractResetTimestampFromRecord(record);
      if (explicitReset !== undefined) runtime.explicitResetAt = explicitReset;
      runtime.window.lastAssistant = {
        stopReason: "error",
        errorMessage: errMsg,
        text: runtime.window.lastAssistant?.text ?? "",
      };
      return;
    }

    // Text / final JSON result extraction (`dsh` `text` events or `zcode` single JSON result).
    const textCandidate =
      typeof record.text === "string"
        ? record.text
        : typeof record.result === "string"
          ? record.result
          : typeof (record.part as Record<string, unknown> | undefined)?.text === "string"
            ? ((record.part as Record<string, unknown>).text as string)
            : undefined;
    if (textCandidate !== undefined) {
      const prev = type === "text" || type === "text_delta" ? (runtime.window.lastAssistant?.text ?? "") : "";
      const combined = prev + textCandidate;
      runtime.window.lastAssistant = {
        stopReason: "stop",
        text: combined,
      };
      const embedded = tryParseInlineReport(combined);
      if (embedded) runtime.window.report = embedded;
    }

    if (record.otto_report) {
      const rep = normalizeReport(record.otto_report);
      if (rep) runtime.window.report = rep;
    } else if (record.report) {
      const rep = normalizeReport(record.report);
      if (rep) runtime.window.report = rep;
    }

    if (typeof record.usage === "object" && record.usage !== null) {
      const u = record.usage as Record<string, unknown>;
      const inTok = typeof u.input_tokens === "number" ? u.input_tokens : typeof u.inputTokens === "number" ? u.inputTokens : undefined;
      const outTok = typeof u.output_tokens === "number" ? u.output_tokens : typeof u.outputTokens === "number" ? u.outputTokens : 0;
      const cost = typeof record.cost_usd === "number" ? record.cost_usd : typeof record.cost === "number" ? record.cost : undefined;
      runtime.jsonUsage = {
        ...(inTok !== undefined ? { tokens: { input: inTok, output: outTok, totalTokens: inTok + outTok } } : {}),
        ...(cost !== undefined ? { cost } : {}),
      };
    }
  }

  private onExit(runtime: CommandWorkerRuntime, code: number | null, signal: NodeJS.Signals | null): void {
    if (runtime.exited) return;
    runtime.exited = true;
    const tail = runtime.decoder.end();
    if (tail) {
      runtime.rawStdout = (runtime.rawStdout + tail).slice(-256_000);
      runtime.stdoutBuffer += tail;
    }
    if (this.preset.outputFormat !== "text" && runtime.stdoutBuffer.trim()) {
      for (const line of runtime.stdoutBuffer.split("\n")) {
        if (line.trim()) this.consumeStructuredLine(runtime, line.trim());
      }
      runtime.stdoutBuffer = "";
    }

    if (this.runtimes.get(runtime.workerId) === runtime) {
      this.runtimes.delete(runtime.workerId);
    }

    if (!runtime.stopping && runtime.window.open) {
      this.settleRuntime(runtime, code, signal);
    }

    this.emit({
      type: "process_exit",
      workerId: runtime.workerId,
      code,
      signal,
      unexpected: false,
    });

    const waiters = runtime.exitWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private settleRuntime(runtime: CommandWorkerRuntime, code: number | null, signal: NodeJS.Signals | null): void {
    // 1. Out-of-band `OTTO_REPORT_FILE` / `OTTO_PROPOSALS_FILE` written by the CLI or tool.
    if (existsSync(runtime.proposalsFile)) {
      try {
        for (const line of readFileSync(runtime.proposalsFile, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const p = normalizeProposal(JSON.parse(line));
          if (p && !runtime.emittedProposalKeys.has(p.proposalKey)) {
            runtime.emittedProposalKeys.add(p.proposalKey);
            this.emit({ type: "proposal", workerId: runtime.workerId, proposal: p });
          }
        }
      } catch {
        // ignore malformed proposal lines
      }
    }

    if (existsSync(runtime.reportFile)) {
      try {
        const rep = normalizeReport(JSON.parse(readFileSync(runtime.reportFile, "utf8").trim()));
        if (rep) runtime.window.report = rep;
      } catch {
        // ignore malformed report file
      }
    }

    // 2. Plain-text fallback / inline JSON block extraction.
    if (this.preset.outputFormat === "text" && runtime.rawStdout.trim()) {
      const trimmed = runtime.rawStdout.trim();
      runtime.window.lastAssistant = { stopReason: "stop", text: trimmed };
      if (!runtime.window.report) {
        const rep = tryParseInlineReport(trimmed);
        if (rep) runtime.window.report = rep;
      }
    }

    if (runtime.aborted) {
      runtime.window.aborted = true;
    } else if (code !== 0 && !runtime.window.report && runtime.window.lastAssistant?.stopReason !== "error") {
      const detail =
        (runtime.stderrTail.trim() || runtime.rawStdout.trim()).slice(-600) ||
        `${this.kind} exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
      runtime.window.lastAssistant = {
        stopReason: "error",
        errorMessage: detail,
        text: runtime.window.lastAssistant?.text ?? "",
      };
    }

    if (runtime.explicitResetAt !== undefined) {
      runtime.window.rateLimitResetAt = runtime.explicitResetAt;
    }

    const adjudicated = adjudicate(runtime.window);
    runtime.window = { open: false, aborted: false };

    let usage: SessionUsage | undefined = runtime.jsonUsage;
    if (runtime.dshUsage.hasTokens || runtime.dshUsage.hasCost) {
      const total = runtime.dshUsage.inputTokens + runtime.dshUsage.outputTokens;
      usage = {
        ...(runtime.dshUsage.hasTokens
          ? {
              tokens: {
                input: runtime.dshUsage.inputTokens,
                output: runtime.dshUsage.outputTokens,
                totalTokens: total,
                ...(runtime.dshUsage.cachedInputTokens > 0
                  ? { cachedInputTokens: runtime.dshUsage.cachedInputTokens }
                  : {}),
              },
            }
          : {}),
        ...(runtime.dshUsage.hasCost ? { cost: runtime.dshUsage.costUsd } : {}),
        ...(runtime.dshUsage.lastStepTokens !== undefined
          ? {
              contextUsage: {
                tokens: runtime.dshUsage.lastStepTokens,
                ...(runtime.dshUsage.contextWindow ? { contextWindow: runtime.dshUsage.contextWindow } : {}),
                percent:
                  runtime.dshUsage.contextWindow && runtime.dshUsage.contextWindow > 0
                    ? Math.round((runtime.dshUsage.lastStepTokens / runtime.dshUsage.contextWindow) * 1000) / 10
                    : null,
              },
            }
          : {}),
      };
    }

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
      ...(usage ? { turnUsage: usage } : {}),
    });
  }
}

function extractResetTimestampFromRecord(record: Record<string, unknown>): number | undefined {
  for (const key of ["resetsAt", "reset_at", "resets_at", "retryAfter", "retry_after_seconds"]) {
    const val = record[key];
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      if (key === "retry_after_seconds" || val < 100_000_000) {
        return Date.now() + Math.round(val * 1000);
      }
      return val < 10_000_000_000 ? Math.round(val * 1000) : Math.round(val);
    }
    if (typeof val === "string" && val.trim()) {
      const parsed = Date.parse(val.trim());
      if (!Number.isNaN(parsed)) return parsed;
      const inspected = inspectRateLimitReset(val, Date.now());
      if (inspected.limitedUntil) return inspected.limitedUntil;
    }
  }
  return undefined;
}

function tryParseInlineReport(text: string): ReportPayload | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      return normalizeReport(obj.otto_report ?? obj);
    } catch {
      // fall through
    }
  }
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    try {
      const obj = JSON.parse(fenceMatch[1].trim()) as Record<string, unknown>;
      return normalizeReport(obj.otto_report ?? obj);
    } catch {
      return null;
    }
  }
  return null;
}

export function detectCommandBinary(
  command: string[],
  timeoutMs = 4_000,
): { installed: boolean; version?: string; authStatus?: AgentAuthStatus } {
  try {
    const resolved = resolveExecutableLaunch(command);
    if (resolved.error || !resolved.argv[0]) return { installed: false };
    const [file, ...rest] = resolved.argv;
    const ver = spawnSync(file, [...rest, "--version"], { timeout: timeoutMs, encoding: "utf8" });
    if (ver.status !== 0 || ver.error) return { installed: false };
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

export function presetFromStoredConfig(
  kind: CommandAgentKind,
  stored: StoredCommandAdapterConfig,
): CommandPresetSpec {
  if (kind === "dsh") {
    const base = buildDshPreset(stored.command);
    return {
      ...base,
      ...(stored.argsTemplate ? { argsTemplate: stored.argsTemplate } : {}),
      ...(stored.resumeArgsTemplate ? { resumeArgsTemplate: stored.resumeArgsTemplate } : {}),
      ...(stored.readonlyArgsTemplate ? { readonlyArgsTemplate: stored.readonlyArgsTemplate } : {}),
      ...(stored.outputFormat ? { outputFormat: stored.outputFormat } : {}),
      ...(stored.defaultEffort ? { defaultEffort: stored.defaultEffort } : {}),
    };
  }
  if (kind === "zcode") {
    const base = buildZcodePreset(stored.command);
    return {
      ...base,
      ...(stored.argsTemplate ? { argsTemplate: stored.argsTemplate } : {}),
      ...(stored.resumeArgsTemplate ? { resumeArgsTemplate: stored.resumeArgsTemplate } : {}),
      ...(stored.readonlyArgsTemplate ? { readonlyArgsTemplate: stored.readonlyArgsTemplate } : {}),
      ...(stored.outputFormat ? { outputFormat: stored.outputFormat } : {}),
      ...(stored.defaultEffort ? { defaultEffort: stored.defaultEffort } : {}),
    };
  }
  return {
    kind: "command",
    command: stored.command,
    argsTemplate: stored.argsTemplate ?? ["{prompt}"],
    ...(stored.resumeArgsTemplate ? { resumeArgsTemplate: stored.resumeArgsTemplate } : {}),
    ...(stored.readonlyArgsTemplate ? { readonlyArgsTemplate: stored.readonlyArgsTemplate } : {}),
    outputFormat: stored.outputFormat ?? "text",
    ...(stored.defaultEffort ? { defaultEffort: stored.defaultEffort } : {}),
  };
}
