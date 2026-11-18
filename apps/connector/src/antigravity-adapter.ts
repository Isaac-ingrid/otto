// AntigravityAdapter: AgentAdapter implementation over `agy acp` (Agent Client Protocol,
// JSON-RPC 2.0 over stdio). Keeps one resident `agy acp` child process per active/idle-hot
// worker session, injects Otto's stdio MCP `report` server via ACP `mcpServers`, enforces
// cooperative cancellation (`session/cancel` + cancelling open permission requests), and
// resumes crashed/cold sessions via `session/resume` or `session/load`.
import type {
  AgentAdapter,
  AgentCapabilities,
  Delivery,
  InterruptResult,
  ProposalPayload,
  RawAdapterEvent,
  ReportPayload,
  SessionUsage,
  StartSpec,
  WorkerHandle,
  WorkerMode,
} from "./agent.ts";
import { AdapterError } from "./agent.ts";
import { adjudicate, type RunWindow } from "./adjudication.ts";
import { childEnv, extractTarget, normalizeProposal, normalizeReport, RESUME_PROMPT } from "./pi-adapter.ts";
import { installClaudeAssets, OTTO_VERSION, WORKER_SYSTEM_PROMPT } from "./install.ts";
import { resolveExecutableLaunch, splitCommandLine, type LaunchResolution } from "./pi-launch.ts";
import { AgentModelObservationSchema, type AgentModelCatalog } from "@isaac2ingrid/protocol";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { appendCapped } from "./logger.ts";
import { redactText } from "./redact.ts";

/** Escape hatch for Antigravity CLI installs outside PATH; stripped from child env via OTTO_*. */
export const AGY_COMMAND_ENV = "OTTO_AGY_COMMAND";

/** Default Free-Tier-eligible `/model` selector label in `agy` 1.5.8+ when using GEMINI_API_KEY.
 *  Note: `settings.json` stores the full picker label including default thinking tier (`(High)` /
 *  `(Medium)`), whereas bare names fall back to `gemini-3.1-pro` (`limit: 0` on Free Tier). */
export const DEFAULT_AGY_API_KEY_MODEL = "Gemini 4 Hydrogen (High)";

const AGY_MODEL_LABELS: Record<string, string> = {
  "gemini-4-hydrogen": "Gemini 4 Hydrogen (High)",
  "gemini 4 hydrogen": "Gemini 4 Hydrogen (High)",
  "gemini-4-hydrogen-high": "Gemini 4 Hydrogen (High)",
  "gemini-4-hydrogen-medium": "Gemini 4 Hydrogen (Medium)",
  "gemini-4-hydrogen-low": "Gemini 4 Hydrogen (Low)",
  "gemini-4-hydrogen-xhigh": "Gemini 4 Hydrogen (Extra)",
  "gemini-4-hydrogen-extra": "Gemini 4 Hydrogen (Extra)",
  "gemini-3.8-flash": "Gemini 3.8 Flash (Medium)",
  "gemini 3.8 flash": "Gemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-high": "Gemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)",
  "gemini-3.6-flash": "Gemini 3.6 Flash (Medium)",
  "gemini 3.6 flash": "Gemini 3.6 Flash (Medium)",
  "gemini-3.6-flash-high": "Gemini 3.6 Flash (High)",
  "gemini-3.6-flash-medium": "Gemini 3.6 Flash (Medium)",
  "gemini-3.6-flash-low": "Gemini 3.6 Flash (Low)",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini 3.5 flash-lite": "Gemini 3.5 Flash-Lite",
};

export function normalizeAgySettingsModel(model?: string): string {
  const trimmed = model?.trim() ?? "";
  if (!trimmed) return DEFAULT_AGY_API_KEY_MODEL;
  return AGY_MODEL_LABELS[trimmed.toLowerCase()] ?? trimmed;
}

/** Isolated `--gemini-dir` inside Otto's state directory so API-key runs never overwrite `~/.gemini`. */
export function isolatedAgyGeminiDir(stateDir: string): string {
  return join(stateDir, "agy-apikey", ".gemini");
}

/** Writes `<stateDir>/agy-apikey/.gemini/antigravity-cli/settings.json` (0600) with `modelProvider: "gemini"`. */
export function writeIsolatedAgySettings(stateDir: string, model?: string): string {
  const geminiDir = isolatedAgyGeminiDir(stateDir);
  const cliDir = join(geminiDir, "antigravity-cli");
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  const settingsPath = join(cliDir, "settings.json");
  const normalizedModel = normalizeAgySettingsModel(model);
  // `artifactReviewPolicy: "always-proceed"` prevents autonomous background workers from
  // stalling indefinitely when Antigravity generates an implementation plan artifact.
  const payload =
    JSON.stringify(
      {
        modelProvider: "gemini",
        model: normalizedModel,
        artifactReviewPolicy: "always-proceed",
      },
      null,
      2,
    ) + "\n";
  writeFileSync(settingsPath, payload, { mode: 0o600 });
  try {
    chmodSync(settingsPath, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
  return geminiDir;
}

export function agyCommandFromEnv(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env[AGY_COMMAND_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const argv = splitCommandLine(raw).filter((part) => part.length > 0);
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

/** Honest capability set (connector-pi.md §3) for `agy acp`:
 *  - No mid-turn `steer` or `followUp` RPC exists in ACP v1; WorkerManager parks mid-run sends
 *    (`after_run_end`) and delivers them onto the resident hot session once the turn settles.
 *  - Cooperative `interrupt` via `session/cancel` + immediate cancellation of pending
 *    `session/request_permission` requests keeps the ACP session alive across interrupts.
 *  - `readonly` stays false: Antigravity's `plan` mode is behavioral rather than hard tool
 *    removal when user settings enable `accept-edits`/`auto`, so unisolated readonly runs in
 *    the owner's main checkout are refused; `handlePermissionRequest` still rejects non-read
 *    permission prompts as defense in depth. */
const ANTIGRAVITY_CAPABILITIES: AgentCapabilities = {
  steer: false,
  followUp: false,
  interrupt: true,
  resume: true,
  history: false,
  images: true,
  structuredReport: true,
  readonly: false,
};

const SAFE_READONLY_TOOL_KINDS = new Set(["read", "search", "think"]);

export interface AntigravityAdapterOptions {
  stateDir: string;
  /** argv prefix for the `agy` binary; default `OTTO_AGY_COMMAND` or `["agy"]`. */
  command?: string[];
  /** Extra CLI flags appended after `acp` (default `[]`). */
  acpArgs?: string[];
  /** Extra env for the child (tests). `OTTO_*` is always stripped. */
  env?: Record<string, string | undefined>;
  /** Per-worker stderr tails (§12); default `<stateDir>/logs`. Pass null to disable. */
  workerLogsDir?: string | null;
  /** `hello.agents` version string (detected `agy --version` output). */
  version?: string;
  /** Timeout for `initialize` + session creation/loading (default 30 s). */
  initTimeoutMs?: number;
  /** Cooperative `session/cancel` grace before escalating to process kill (default 3 s). */
  cancelGraceMs?: number;
  /** Grace between stdin close / SIGTERM and SIGKILL on `stopProcess` (default 3 s). */
  stopGraceMs?: number;
  /** Optional explicit ACP auth method override (e.g. `"oauth-personal"` or `"gemini-api-key"`). */
  authMethodId?: string;
  /** Optional standalone Gemini API key profile (`otto agy-key`). Isolates `agy acp` into
   *  `<stateDir>/agy-apikey/.gemini` without touching `~/.gemini` or Keychain OAuth state. */
  apiKeyConfig?: {
    apiKey: string;
    model?: string;
    geminiDir?: string;
  };
  /** Optional async permission decision hook (returns selected `optionId` or `"cancelled"`). */
  onPermissionRequest?: (req: {
    workerId: string;
    sessionId: string;
    mode: WorkerMode;
    toolCall: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
  }) => Promise<string | "cancelled">;
  /** Pre-resolved executable launch (tests / Windows shim checks). */
  launch?: LaunchResolution;
}

interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  sessionCapabilities?: {
    resume?: Record<string, unknown> | null;
    close?: Record<string, unknown> | null;
    systemPrompt?: {
      mode?: { override?: Record<string, unknown> | null } | null;
    } | null;
  } | null;
  _meta?: {
    antigravity?: {
      systemPrompt?: Record<string, unknown> | null;
    } | null;
  } | null;
}

interface AcpAuthMethod {
  id: string;
  name?: string;
  type?: string;
}

interface TrackedToolCall {
  name?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  target?: string;
  emittedProgress?: boolean;
  emittedProposal?: boolean;
}

interface PendingPermission {
  requestId: string | number;
}

interface WorkerRuntime {
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
  /** True when the connector itself stops the process; makes process_exit expected. */
  stopping: boolean;
  /** True when `interrupt` had to escalate to SIGKILL after `session/cancel` timed out. */
  interruptingKill: boolean;
  /** True while `session/cancel` is draining the active prompt turn. */
  cancelling: boolean;
  /** Monotonic token identifying the active `session/prompt` turn. */
  turnSeq: number;
  promptInFlight: boolean;
  promptDoneWaiters: (() => void)[];
  turn: number;
  window: RunWindow & { open: boolean };
  currentMessageId: string | null;
  currentMessageText: string;
  toolCalls: Map<string, TrackedToolCall>;
  pendingPermissions: Map<string, PendingPermission>;
  latestUsage?: SessionUsage;
  /** Events buffered until `start()` / `send()` / `resume()` returns so `started`/`resumed`
   *  always precedes streamed worker events on the wire (§11.1). */
  buffered: RawAdapterEvent[] | null;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly kind = "antigravity" as const;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  readonly modelCatalog = {
    // ADR-0021: keep explicit model selection gated (`selection: 'none'`) until live CLI
    // acceptance, while reporting trusted ACP model observations (`actualModelObservation`).
    capabilities: {
      selection: "none",
      discovery: "suggested",
      customModelInput: false,
      actualModelObservation: true,
      thinkingSelection: false,
    },
    status: "ready",
    models: [
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    ],
  } satisfies AgentModelCatalog;

  private readonly options: AntigravityAdapterOptions;
  private readonly workerLogsDir: string | null;
  private readonly runtimes = new Map<string, WorkerRuntime>();
  private readonly listeners: ((e: RawAdapterEvent) => void)[] = [];
  /** Retained per worker so direct `send`/`resume` calls after process exit can cold-relaunch. */
  private readonly lastSpecs = new Map<string, StartSpec>();
  private readonly sessionIds = new Map<string, string>();
  private launch?: LaunchResolution;

  constructor(options: AntigravityAdapterOptions) {
    this.options = options;
    this.workerLogsDir =
      options.workerLogsDir === null ? null : (options.workerLogsDir ?? join(options.stateDir, "logs"));
  }

  get launchResolution(): LaunchResolution {
    this.launch =
      this.launch ??
      this.options.launch ??
      resolveExecutableLaunch(this.options.command ?? agyCommandFromEnv() ?? ["agy"]);
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

  /** Builds the ACP subcommand arguments (`agy acp ...`). */
  buildArgs(acpLogFile?: string, geminiDir?: string): string[] {
    return [
      "acp",
      ...(acpLogFile ? ["--log-file", acpLogFile] : []),
      ...(geminiDir ? ["--gemini-dir", geminiDir] : []),
      ...(this.options.acpArgs ?? []),
    ];
  }

  /** ACP stdio MCP server entry pointing `agy acp` at Otto's `report-server.mjs`. */
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
      throw new AdapterError("lock_held", `an antigravity process for ${spec.workerId} is already running`);
    }
    const launch = this.launchResolution;
    if (launch.error) throw new AdapterError("launch_unresolved", launch.error);

    const assets = installClaudeAssets(this.options.stateDir);
    if (this.workerLogsDir) mkdirSync(this.workerLogsDir, { recursive: true });
    const acpLogFile = this.workerLogsDir ? join(this.workerLogsDir, `agy-acp-${spec.workerId}.log`) : undefined;
    const reportFile = join(this.options.stateDir, "mcp", "reports", `${spec.workerId}.json`);
    const proposalsFile = join(this.options.stateDir, "mcp", "proposals", `proposals-${spec.workerId}.jsonl`);
    rmSync(reportFile, { force: true });
    rmSync(proposalsFile, { force: true });

    const apiKeyConfig = this.options.apiKeyConfig;
    const isolatedGeminiDir = apiKeyConfig
      ? (apiKeyConfig.geminiDir ?? writeIsolatedAgySettings(this.options.stateDir, apiKeyConfig.model))
      : undefined;
    const env = childEnv(process.env, {
      ...(apiKeyConfig ? { GEMINI_API_KEY: apiKeyConfig.apiKey } : {}),
      ...this.options.env,
    });
    if (apiKeyConfig && this.options.env?.GOOGLE_API_KEY === undefined) {
      // GOOGLE_API_KEY takes precedence over GEMINI_API_KEY in Gemini SDKs; clear any ambient
      // GOOGLE_API_KEY so the isolated `otto agy-key` credential is always authoritative.
      delete env.GOOGLE_API_KEY;
    }
    if (!env.HOME) env.HOME = homedir();
    const redactSecrets = apiKeyConfig?.apiKey ? [apiKeyConfig.apiKey] : [];
    let runtime!: WorkerRuntime;
    const proc = new AcpProcess({
      command: launch.argv,
      args: this.buildArgs(acpLogFile, isolatedGeminiDir),
      cwd: spec.cwd,
      env,
      redactSecrets,
      stderrFile: this.workerLogsDir ? join(this.workerLogsDir, `agy-${spec.workerId}.log`) : undefined,
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
      runtime.systemPromptSupported = Boolean(
        agentCapabilities.sessionCapabilities?.systemPrompt ||
          agentCapabilities._meta?.antigravity?.systemPrompt,
      );

      if (spec.images && spec.images.length > 0 && agentCapabilities.promptCapabilities?.image === false) {
        throw new AdapterError(
          "unsupported_capability",
          "antigravity ACP server reported promptCapabilities.image=false",
        );
      }

      const authMethods = Array.isArray(initRes.authMethods) ? (initRes.authMethods as AcpAuthMethod[]) : [];
      if (this.options.authMethodId) {
        await this.authenticate(proc, this.options.authMethodId, env, initTimeout);
      } else if (apiKeyConfig && authMethods.some((m) => m.id === "gemini-api-key" && m.type !== "terminal")) {
        await this.authenticate(proc, "gemini-api-key", env, initTimeout);
      }

      const mcpServers = this.buildMcpServers(assets.serverPath, reportFile, proposalsFile);
      const sessionRes = await this.openOrResumeSession(proc, runtime, spec, mcpServers, authMethods, env, initTimeout);
      const sessionId =
        typeof sessionRes.sessionId === "string" && sessionRes.sessionId.length > 0
          ? sessionRes.sessionId
          : spec.resumeSessionId ?? "";
      if (!sessionId) {
        throw new AdapterError("startup_failed", "agy acp session setup returned an empty sessionId");
      }
      runtime.sessionId = sessionId;
      this.sessionIds.set(spec.workerId, sessionId);
      this.lastSpecs.set(spec.workerId, spec);

      // Optional model selection + trusted model observation (ADR-0021).
      await this.applyAndObserveModel(proc, runtime, sessionRes, spec.model, initTimeout);

      // Write-ahead hook (§6.3/§10): fires after session readiness and BEFORE the prompt is sent.
      try {
        spec.onSession?.(null, null);
      } catch {
        // bookkeeping must never abort a launch
      }

      const includeFallbackSystemPrompt = !runtime.systemPromptSupported && !spec.resumeSessionId;
      const promptBlocks = buildPromptBlocks(spec.prompt, spec.images, includeFallbackSystemPrompt);
      this.beginPromptTurn(runtime, promptBlocks);

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
      const diag = summarizeAcpLogErrors(acpLogFile, proc.getStderrTail(), redactSecrets);
      throw new AdapterError(
        "startup_failed",
        `antigravity acp startup failed: ${reason}${diag ? ` [${diag}]` : ""}`,
      );
    }
  }

  private async openOrResumeSession(
    proc: AcpProcess,
    runtime: WorkerRuntime,
    spec: StartSpec,
    mcpServers: Array<Record<string, unknown>>,
    authMethods: AcpAuthMethod[],
    env: Record<string, string | undefined>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const systemPrompt = runtime.systemPromptSupported
      ? { mode: "append", content: [{ type: "text", text: WORKER_SYSTEM_PROMPT }] }
      : undefined;

    const attempt = async (): Promise<Record<string, unknown>> => {
      if (!spec.resumeSessionId) {
        return proc.rpc(
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
        return proc.rpc(
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
        return proc.rpc(
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
        `agy acp cannot resume session ${spec.resumeSessionId}: neither session/resume nor loadSession is advertised`,
      );
    };

    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof JsonRpcError) || err.code !== -32000) throw err;
      // ACP `-32000` (`auth_required`): try GEMINI_API_KEY first when present, else cached
      // personal OAuth (`oauth-personal`), then retry session setup once.
      const method = pickAuthMethod(authMethods, env);
      if (!method) {
        throw new AdapterError(
          "auth_required",
          "Antigravity CLI requires sign-in on this machine: run `agy acp --login` (or `agy`) interactively, or set GEMINI_API_KEY.",
        );
      }
      await this.authenticate(proc, method, env, timeoutMs);
      return attempt();
    }
  }

  private async authenticate(
    proc: AcpProcess,
    methodId: string,
    env: Record<string, string | undefined>,
    timeoutMs: number,
  ): Promise<void> {
    const apiKey = env.GEMINI_API_KEY;
    const params: Record<string, unknown> = {
      methodId,
      ...(methodId === "gemini-api-key" && typeof apiKey === "string" && apiKey.length > 0
        ? { _meta: { "api-key": apiKey } }
        : {}),
    };
    try {
      await proc.rpc("authenticate", params, timeoutMs);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AdapterError(
        "auth_required",
        `Antigravity ACP authentication (${methodId}) failed: ${detail}. Run 'agy acp --login' on this machine or check GEMINI_API_KEY.`,
      );
    }
  }

  private async applyAndObserveModel(
    proc: AcpProcess,
    runtime: WorkerRuntime,
    sessionRes: Record<string, unknown>,
    requestedModel: string | undefined,
    timeoutMs: number,
  ): Promise<void> {
    let latestPayload = sessionRes;
    const modelOption = findModelConfigOption(sessionRes.configOptions);
    const legacyModels = findLegacyModelsCatalog(sessionRes.models);
    const avoidPaidDefault = Boolean(this.options.apiKeyConfig);

    if (requestedModel && modelOption && modelOption.currentValue !== requestedModel) {
      latestPayload = await proc.rpc(
        "session/set_config_option",
        {
          sessionId: runtime.sessionId,
          configId: modelOption.id,
          value: requestedModel,
        },
        timeoutMs,
      );
    } else if (!requestedModel && this.options.apiKeyConfig) {
      const desired = this.options.apiKeyConfig.model || DEFAULT_AGY_API_KEY_MODEL;
      if (modelOption) {
        const matchedValue = resolveConfigOptionValue(
          modelOption.options,
          desired,
          modelOption.currentValue,
          avoidPaidDefault,
        );
        if (matchedValue && modelOption.currentValue !== matchedValue) {
          try {
            latestPayload = await proc.rpc(
              "session/set_config_option",
              {
                sessionId: runtime.sessionId,
                configId: modelOption.id,
                value: matchedValue,
              },
              timeoutMs,
            );
          } catch {
            // Best-effort default model switch: isolated settings.json also carries `model`.
          }
        }
      } else if (legacyModels) {
        const matchedModelId = resolveConfigOptionValue(
          legacyModels.options,
          desired,
          legacyModels.currentValue,
          avoidPaidDefault,
        );
        if (matchedModelId && legacyModels.currentValue !== matchedModelId) {
          try {
            const setRes = await proc.rpc(
              "session/set_model",
              {
                sessionId: runtime.sessionId,
                modelId: matchedModelId,
              },
              timeoutMs,
            );
            latestPayload = {
              ...sessionRes,
              ...setRes,
              models: {
                ...(typeof sessionRes.models === "object" && sessionRes.models !== null
                  ? (sessionRes.models as Record<string, unknown>)
                  : {}),
                currentModelId: matchedModelId,
              },
            };
          } catch {
            // Best-effort `session/set_model` fallback.
          }
        }
      }
    }
    const observedId = extractObservedModelId(latestPayload);
    if (observedId) {
      const parsed = AgentModelObservationSchema.safeParse({
        id: observedId,
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
      throw new AdapterError("unsupported", `antigravity cannot ${how} mid-run over ACP v1`);
    }
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.process.hasExited) {
      if (runtime.promptInFlight) {
        throw new AdapterError("busy", `antigravity worker ${id} already has a prompt turn in flight`);
      }
      if (input.images && input.images.length > 0 && runtime.agentCapabilities.promptCapabilities?.image === false) {
        throw new AdapterError(
          "unsupported_capability",
          "antigravity ACP server reported promptCapabilities.image=false",
        );
      }
      runtime.buffered = [];
      this.beginPromptTurn(runtime, buildPromptBlocks(input.text, input.images, false));
      setImmediate(() => this.flushBuffered(runtime));
      return {};
    }
    // Cold fallback when invoked directly after the process exited.
    const spec = this.lastSpecs.get(id);
    const resumeSessionId = this.sessionIds.get(id) ?? spec?.resumeSessionId;
    if (!spec || !resumeSessionId) {
      throw new AdapterError("not_found", `no known session to continue antigravity worker ${id}`);
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
    // ACP v1 Cancellation: every open `session/request_permission` MUST receive `{ outcome: "cancelled" }`.
    for (const pending of runtime.pendingPermissions.values()) {
      runtime.process.respond(pending.requestId, { outcome: { outcome: "cancelled" } });
    }
    runtime.pendingPermissions.clear();
    runtime.process.notify("session/cancel", { sessionId: runtime.sessionId });

    const settledGracefully = await this.waitForPromptTurnDone(runtime, this.options.cancelGraceMs ?? 3_000);
    if (!settledGracefully && !runtime.process.hasExited) {
      // Cooperative cancel timed out: force-terminate the wedged child and settle aborted in onExit.
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
        throw new AdapterError(
          "not_idle",
          "antigravity cannot resume while a prompt turn is in flight; interrupt it or wait for it to settle",
        );
      }
      runtime.buffered = [];
      this.beginPromptTurn(runtime, buildPromptBlocks(`${RESUME_PROMPT}\n\nReason: ${reason}`, undefined, false));
      setImmediate(() => this.flushBuffered(runtime));
      return;
    }
    const spec = this.lastSpecs.get(id);
    const resumeSessionId = this.sessionIds.get(id) ?? spec?.resumeSessionId;
    if (!spec || !resumeSessionId) {
      throw new AdapterError("not_found", `no known spec to resume antigravity worker ${id}`);
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

  stderrTail(id: string): string {
    return this.runtimes.get(id)?.process.getStderrTail() ?? "";
  }

  private require(id: string): WorkerRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.process.hasExited) {
      throw new AdapterError("not_running", `no live antigravity process for worker ${id}`);
    }
    return runtime;
  }

  // --- Prompt turn lifecycle & ACP event normalization --------------------------------------

  private emitProposalOnce(runtime: WorkerRuntime, proposal: ProposalPayload): void {
    if (runtime.emittedProposalKeys.has(proposal.proposalKey)) return;
    runtime.emittedProposalKeys.add(proposal.proposalKey);
    this.emit({
      type: "proposal",
      workerId: runtime.workerId,
      proposal,
    });
  }

  private beginPromptTurn(runtime: WorkerRuntime, promptBlocks: Array<Record<string, unknown>>): void {
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

  private waitForPromptTurnDone(runtime: WorkerRuntime, timeoutMs: number): Promise<boolean> {
    if (!runtime.promptInFlight) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const idx = runtime.promptDoneWaiters.indexOf(waiter);
        if (idx !== -1) runtime.promptDoneWaiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      runtime.promptDoneWaiters.push(waiter);
    });
  }

  private notifyPromptTurnDone(runtime: WorkerRuntime): void {
    runtime.promptInFlight = false;
    const waiters = runtime.promptDoneWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private onNotification(runtime: WorkerRuntime, method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const update =
      typeof params.update === "object" && params.update !== null
        ? (params.update as Record<string, unknown>)
        : undefined;
    if (!update || typeof update.sessionUpdate !== "string") return;

    // Model configuration updates can arrive inside or outside an active prompt window.
    if (update.sessionUpdate === "config_option_update") {
      const observedId = extractObservedModelId(update);
      if (observedId) {
        const parsed = AgentModelObservationSchema.safeParse({
          id: observedId,
          source: "session",
          observedAt: Date.now(),
        });
        if (parsed.success) runtime.onModelObserved?.(parsed.data);
      }
      return;
    }

    // Ignore replayed history updates during `session/load` before a prompt window opens.
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
        if (typeof update.name === "string" && update.name.length > 0) existing.name = update.name;
        if (typeof update.title === "string" && update.title.length > 0) existing.title = update.title;
        if (typeof update.kind === "string" && update.kind.length > 0) existing.kind = update.kind;
        if (typeof update.rawInput === "object" && update.rawInput !== null) existing.rawInput = update.rawInput;
        const locTarget = extractAcpLocationTarget(update.locations);
        const rawTarget = extractTarget(existing.rawInput);
        if (locTarget ?? rawTarget) existing.target = locTarget ?? rawTarget;
        runtime.toolCalls.set(toolCallId, existing);

        const isReport = isAcpReportTool(existing.name, existing.title);
        const isProposal = isAcpProposalTool(existing.name, existing.title);
        if (isReport && existing.rawInput !== undefined) {
          const normalized = normalizeReport(existing.rawInput);
          if (normalized) runtime.window.report = normalized;
        } else if (isProposal && existing.rawInput !== undefined && !existing.emittedProposal) {
          const normalized = normalizeProposal(existing.rawInput);
          if (normalized) {
            existing.emittedProposal = true;
            this.emitProposalOnce(runtime, normalized);
          }
        }

        if (!existing.emittedProgress) {
          existing.emittedProgress = true;
          runtime.turn += 1;
          // A new tool step starts a fresh post-tool message accumulator if no explicit messageId is used.
          if (runtime.currentMessageId === null) runtime.currentMessageText = "";
          const label = isReport
            ? "report"
            : isProposal
              ? "propose"
              : existing.name ?? existing.kind ?? (existing.title ? existing.title.slice(0, 40) : "tool");
          this.emit({
            type: "progress",
            workerId: runtime.workerId,
            phase: "tool",
            tool: label,
            target: existing.target,
            turn: runtime.turn,
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
    runtime: WorkerRuntime,
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "session/request_permission") {
      this.handlePermissionRequest(runtime, id, params);
      return;
    }
    if (method === "elicitation/create") {
      // Autonomous worker runs have no interactive form modal; decline cleanly so stdio never blocks.
      runtime.process.respond(id, { action: "decline" });
      return;
    }
    runtime.process.respondError(id, -32601, `method not supported by otto connector: ${method}`);
  }

  private handlePermissionRequest(runtime: WorkerRuntime, id: string | number, params: Record<string, unknown>): void {
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

    if (this.options.onPermissionRequest && !isReport && !isProposal) {
      const key = String(id);
      const seq = runtime.turnSeq;
      runtime.pendingPermissions.set(key, { requestId: id });
      this.options
        .onPermissionRequest({
          workerId: runtime.workerId,
          sessionId: runtime.sessionId,
          mode: runtime.mode,
          toolCall,
          options,
        })
        .then(
          (choice) => {
            // Already cancelled and replied by `interrupt()` or `stopProcess()`.
            if (!runtime.pendingPermissions.delete(key)) return;
            if (runtime.cancelling || runtime.stopping || seq !== runtime.turnSeq || !choice || choice === "cancelled") {
              runtime.process.respond(id, { outcome: { outcome: "cancelled" } });
              return;
            }
            runtime.process.respond(id, { outcome: { outcome: "selected", optionId: choice } });
          },
          () => {
            if (!runtime.pendingPermissions.delete(key)) return;
            runtime.process.respond(id, { outcome: { outcome: "cancelled" } });
          },
        );
      return;
    }

    const kind = typeof toolCall.kind === "string" ? toolCall.kind : undefined;
    const allow =
      isReport ||
      isProposal ||
      runtime.mode === "write" ||
      (kind !== undefined && SAFE_READONLY_TOOL_KINDS.has(kind));

    const picked = pickPermissionOption(options, allow);
    if (!picked) {
      runtime.process.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    runtime.process.respond(id, {
      outcome: { outcome: "selected", optionId: picked },
    });
  }

  private onPromptResponse(runtime: WorkerRuntime, seq: number, res: Record<string, unknown>): void {
    if (seq !== runtime.turnSeq || !runtime.window.open) return;
    const stopReason = mapAcpStopReason(res.stopReason);
    if (stopReason === "aborted" || runtime.cancelling) {
      runtime.window.aborted = true;
    } else if (stopReason === "error") {
      runtime.window.lastAssistant = {
        stopReason: "error",
        errorMessage: runtime.currentMessageText || "Antigravity refused or aborted the turn",
        text: runtime.currentMessageText,
      };
    } else if (runtime.window.lastAssistant) {
      runtime.window.lastAssistant.stopReason = stopReason ?? "stop";
    } else {
      runtime.window.lastAssistant = { stopReason: stopReason ?? "stop", text: runtime.currentMessageText };
    }
    this.settleTurn(runtime, res);
  }

  private onPromptError(runtime: WorkerRuntime, seq: number, err: unknown): void {
    if (seq !== runtime.turnSeq || !runtime.window.open) return;
    // If the child process crashed or was killed, `onExit` owns the verdict (aborted on
    // interrupt kill, expected exit on stopProcess, or unexpected exit → §9.1 lost/resume).
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

  private settleTurn(runtime: WorkerRuntime, promptResult: Record<string, unknown>): void {
    // Recover any validated MCP `propose` calls whose `rawInput` was omitted by the ACP server
    // BEFORE emitting `settled`, preserving causal order while keeping `reportFile` separate.
    for (const proposal of readProposalsAuditFile(runtime.proposalsFile)) {
      this.emitProposalOnce(runtime, proposal);
    }
    // Check the out-of-band MCP report file written by `report-server.mjs`: real ACP servers
    // may omit MCP `rawInput` in `session/update`, whereas `report-server.mjs` always persists
    // validated report arguments directly to `runtime.reportFile`.
    const fileReport = readReportAuditFile(runtime.reportFile);
    if (fileReport) runtime.window.report = fileReport;

    const adjudicated = adjudicate(runtime.window);
    runtime.window = { open: false, aborted: false };
    runtime.cancelling = false;
    runtime.turn = 0;
    this.notifyPromptTurnDone(runtime);

    const usage = mergePromptUsage(runtime.latestUsage, promptResult);
    this.emit({
      type: "settled",
      workerId: runtime.workerId,
      outcome: adjudicated.outcome,
      errorClass: adjudicated.errorClass,
      errorMessage: adjudicated.errorMessage,
      lastText: adjudicated.lastText?.slice(0, 4000),
      report: adjudicated.report,
      ...(usage ? { usage } : {}),
    });
  }

  private onExit(runtime: WorkerRuntime, info: { code: number | null; signal: NodeJS.Signals | null }): void {
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
      // An exit while idle-hot is harmless (cold relaunch resumes on the next send); an exit
      // mid-turn without Connector stop/interrupt is a crash for §9.1 lost/auto-resume.
      unexpected: wasInFlight && !runtime.stopping && !runtime.interruptingKill && runtime.buffered === null,
    });
  }
}

// --- JSON-RPC 2.0 stdio transport for `agy acp` ---------------------------------------------

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
      throw new Error("agy acp process is not piped");
    }
    this.child = child;
    this.lastOutputAtMs = Date.now();
    child.stdout.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    child.on("error", (err) => this.handleExit(null, null, err));
    child.on("exit", (code, signal) => this.handleExit(code, signal));
  }

  rpc(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child?.stdin) {
        reject(new Error(`agy acp exited before '${method}'; stderr tail:\n${this.stderrTail.slice(-2000)}`));
        return;
      }
      const id = this.nextId++;
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`agy acp '${method}' timed out after ${timeoutMs}ms; stderr tail:\n${this.stderrTail.slice(-2000)}`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { method, resolve, reject, timer });
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
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.stderrTail += `\n[otto] unparseable agy acp stdout line: ${line.slice(0, 200)}\n`;
        continue;
      }
      this.dispatchMessage(msg);
    }
  }

  private dispatchMessage(msg: Record<string, unknown>): void {
    const hasMethod = typeof msg.method === "string";
    const hasId = typeof msg.id === "number" || typeof msg.id === "string";

    // 1. Response to one of our requests (`id` present, `method` absent).
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

    // 2. Agent → Client request (`id` and `method` both present, e.g. `session/request_permission`).
    if (hasId && hasMethod) {
      const params =
        typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
      this.options.onRequest(msg.id as string | number, msg.method as string, params);
      return;
    }

    // 3. Agent → Client notification (`method` present, `id` absent, e.g. `session/update`).
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
          `agy acp exited during '${entry.method}' (code=${code} signal=${signal}); stderr tail:\n${this.stderrTail.slice(-2000)}`,
        ),
      );
    }
    this.options.onExit({ code, signal });
    for (const waiter of this.exitWaiters) waiter();
    this.exitWaiters = [];
  }
}

// --- Helpers --------------------------------------------------------------------------------

function buildPromptBlocks(
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

function pickAuthMethod(authMethods: AcpAuthMethod[], env: Record<string, string | undefined>): string | null {
  const hasApiKey = typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim().length > 0;
  if (hasApiKey && authMethods.some((m) => m.id === "gemini-api-key" && m.type !== "terminal")) {
    return "gemini-api-key";
  }
  const personal = authMethods.find((m) => m.id === "oauth-personal" && m.type !== "terminal");
  if (personal) return personal.id;
  const firstAgentMethod = authMethods.find((m) => typeof m.id === "string" && m.type !== "terminal");
  return firstAgentMethod?.id ?? null;
}

/** Prefers `allow_once` over `allow_always` so Otto never mutates the user's persistent
 *  Antigravity permission settings on disk (`~/.gemini/antigravity-cli/settings.json`). */
function pickPermissionOption(options: Array<Record<string, unknown>>, allow: boolean): string | null {
  const getOptionId = (o: Record<string, unknown>): string | null =>
    typeof o.optionId === "string"
      ? o.optionId
      : typeof o.id === "string"
        ? o.id
        : null;
  const normalizeKind = (k: unknown): string =>
    typeof k === "string" ? k.trim().toLowerCase().replace(/-/g, "_") : "";
  const preferredKinds = allow
    ? ["allow_once", "allow_always", "allow"]
    : ["reject_once", "reject_always", "reject"];
  for (const targetKind of preferredKinds) {
    for (const o of options) {
      if (normalizeKind(o.kind) === targetKind) {
        const id = getOptionId(o);
        if (id) return id;
      }
    }
  }
  if (allow && options.length > 0) {
    const fallback = options.find((o) => !normalizeKind(o.kind).startsWith("reject"));
    if (fallback) return getOptionId(fallback);
  }
  return null;
}

function extractAcpLocationTarget(locations: unknown): string | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined;
  const first = locations[0];
  if (typeof first !== "object" || first === null) return undefined;
  const path = (first as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path.slice(0, 80) : undefined;
}

function findModelConfigOption(
  configOptions: unknown,
): { id: string; currentValue: string; options?: unknown[] } | null {
  if (!Array.isArray(configOptions)) return null;
  for (const raw of configOptions) {
    if (typeof raw !== "object" || raw === null) continue;
    const opt = raw as Record<string, unknown>;
    const isModel = opt.category === "model" || opt.id === "model";
    if (isModel && typeof opt.id === "string" && typeof opt.currentValue === "string") {
      return {
        id: opt.id,
        currentValue: opt.currentValue,
        ...(Array.isArray(opt.options) ? { options: opt.options } : {}),
      };
    }
  }
  return null;
}

function findLegacyModelsCatalog(
  modelsRaw: unknown,
): { currentValue: string; options: Array<Record<string, unknown>> } | null {
  if (typeof modelsRaw !== "object" || modelsRaw === null) return null;
  const models = modelsRaw as Record<string, unknown>;
  const available = Array.isArray(models.availableModels)
    ? (models.availableModels as Array<Record<string, unknown>>)
    : undefined;
  if (!available || available.length === 0) return null;
  const currentValue = typeof models.currentModelId === "string" ? models.currentModelId : "";
  return { currentValue, options: available };
}

interface FlattenedModelCandidate {
  value: string;
  valLower: string;
  nameLower: string;
  labelLower: string;
  baseSlug: string;
  effort: string | null;
}

function parseModelSlugAndEffort(raw: string): { baseSlug: string; effort: string | null } {
  let s = raw.trim().toLowerCase();
  let effort: string | null = null;
  const paren = s.match(/\s*\((low|medium|high|extra|xhigh|max)\)\s*$/);
  if (paren) {
    effort = paren[1] === "extra" ? "xhigh" : paren[1]!;
    s = s.slice(0, paren.index).trim();
  } else {
    const suffix = s.match(/-(low|medium|high|extra|xhigh|max)$/);
    if (suffix) {
      effort = suffix[1] === "extra" ? "xhigh" : suffix[1]!;
      s = s.slice(0, suffix.index).trim();
    }
  }
  return { baseSlug: s.replace(/\s+/g, "-"), effort };
}

function flattenModelCandidates(options: unknown[] | undefined): FlattenedModelCandidate[] {
  if (!options || options.length === 0) return [];
  const out: FlattenedModelCandidate[] = [];
  const visit = (items: unknown[]) => {
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      if (Array.isArray(entry.options)) {
        visit(entry.options);
        continue;
      }
      const value =
        typeof entry.value === "string"
          ? entry.value
          : typeof entry.id === "string"
            ? entry.id
            : typeof entry.modelId === "string"
              ? entry.modelId
              : undefined;
      if (!value) continue;
      const nameLower = typeof entry.name === "string" ? entry.name.toLowerCase() : "";
      const labelLower = typeof entry.label === "string" ? entry.label.toLowerCase() : "";
      const parsed = parseModelSlugAndEffort(value);
      const parsedLabel = nameLower ? parseModelSlugAndEffort(nameLower) : parsed;
      out.push({
        value,
        valLower: value.toLowerCase(),
        nameLower,
        labelLower,
        baseSlug: parsed.baseSlug,
        effort: parsed.effort ?? parsedLabel.effort,
      });
    }
  };
  visit(options);
  return out;
}

function resolveConfigOptionValue(
  options: unknown[] | undefined,
  desired: string,
  currentValue = "",
  avoidPaidDefault = false,
): string | null {
  const candidates = flattenModelCandidates(options);
  if (candidates.length === 0) return null;
  const needle = desired.trim().toLowerCase();
  const normalizedLabel = normalizeAgySettingsModel(desired).toLowerCase();

  // 1. Exact value/name/label match.
  for (const c of candidates) {
    if (
      c.valLower === needle ||
      c.nameLower === needle ||
      c.labelLower === needle ||
      c.nameLower === normalizedLabel ||
      c.labelLower === normalizedLabel
    ) {
      return c.value;
    }
  }

  // 2. Family base-slug match across thinking tiers (e.g. `Gemini 4 Hydrogen` <-> `gemini-4-hydrogen-high`).
  const target = parseModelSlugAndEffort(desired);
  if (target.baseSlug) {
    const family = candidates.filter(
      (c) =>
        c.baseSlug === target.baseSlug ||
        (c.nameLower && parseModelSlugAndEffort(c.nameLower).baseSlug === target.baseSlug),
    );
    if (family.length > 0) {
      const preferredEffort =
        target.effort ?? (target.baseSlug.includes("hydrogen") ? "high" : "medium");
      const exactEffort = family.find((c) => c.effort === preferredEffort);
      if (exactEffort) return exactEffort.value;
      const bare = family.find((c) => c.effort === null);
      return (bare ?? family[0]!).value;
    }
  }

  // 3. Free-Tier guard: never leave an API-key session stranded on `gemini-3.1-pro*` (`limit: 0`).
  if (avoidPaidDefault && currentValue.toLowerCase().startsWith("gemini-3.1-pro")) {
    for (const freeBase of [
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
    ]) {
      const fallback = candidates.find((c) => c.baseSlug === freeBase);
      if (fallback) return fallback.value;
    }
  }
  return null;
}

function extractObservedModelId(payload: Record<string, unknown>): string | null {
  const fromConfig = findModelConfigOption(payload.configOptions);
  if (fromConfig && fromConfig.currentValue.length > 0) return fromConfig.currentValue;
  const models =
    typeof payload.models === "object" && payload.models !== null
      ? (payload.models as Record<string, unknown>)
      : null;
  if (models && typeof models.currentModelId === "string" && models.currentModelId.length > 0) {
    return models.currentModelId;
  }
  return null;
}

function readReportAuditFile(path: string): ReportPayload | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8").trim());
    return normalizeReport(raw);
  } catch {
    return null;
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
        // skip malformed JSONL line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function summarizeAcpLogErrors(acpLogFile: string | undefined, stderrTail: string, secrets: string[] = []): string {
  const lines: string[] = [];
  if (acpLogFile && existsSync(acpLogFile)) {
    try {
      const raw = readFileSync(acpLogFile, "utf8");
      const errs = raw
        .split("\n")
        .filter((l) => /^[EF]\d{4}\s/.test(l) && !l.includes('Failed to resolve GeminiDir ".gemini"'))
        .slice(-2)
        .map((l) => l.replace(/^[EF]\d{4}\s+[\d:.]+\s+\d+\s+/, "").trim());
      lines.push(...errs);
    } catch {
      // best-effort diagnostic
    }
  }
  if (lines.length === 0 && stderrTail.trim()) {
    lines.push(stderrTail.trim().split("\n").slice(-2).join(" | "));
  }
  return redactText(lines.join(" | "), secrets).slice(0, 400);
}

function mergePromptUsage(latestUsage: SessionUsage | undefined, promptResult: Record<string, unknown>): SessionUsage | undefined {
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
    const input =
      typeof rawUsage.input_tokens === "number"
        ? rawUsage.input_tokens
        : typeof rawUsage.inputTokens === "number"
          ? rawUsage.inputTokens
          : undefined;
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
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Boot-time probe: `agy --version` and `agy acp --help` must both exit 0 so `hello.agents`
 *  advertises `antigravity` only when an ACP-capable Antigravity CLI is installed. */
export function detectAntigravity(
  command: string[] = agyCommandFromEnv() ?? ["agy"],
  timeoutMs = 5_000,
): { installed: boolean; version?: string } {
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
    return { installed: true, version: version.length > 0 ? version : undefined };
  } catch {
    return { installed: false };
  }
}
