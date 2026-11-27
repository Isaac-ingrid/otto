// CommandAdapter: Locally allowlisted CLI template adapter for `dsh` (DeepSeek Harness 0.2.2+),
// `zcode` (`zcode-app-cli` / ZCode Desktop CLI), and custom local CLI wrappers (`command`).
//
// Security & protocol invariants verified against `@deepseek-ai/dsh-headless` (`docs/cli-help.md`,
// `packages/bundle/headless/README.md`, `packages/bundle/headless/src/index.ts`),
// `KKKKhazix/agent-autoloop` (`docs/plugins.md`, `SECURITY.md`), and Otto ADR-0022:
// 1. Local-only allowlist: command templates live exclusively in `LocalStore` (`connector.sqlite`)
//    or local environment variables (`OTTO_DSH_COMMAND`, `OTTO_ZCODE_COMMAND`), NEVER in Steward
//    wire commands.
// 2. Single-pass callback placeholder substitution: `{prompt|model|effort|cwd|context|sessionId|reportFile}`
//    is substituted in one regex pass via a replacement callback on argv tokens (`shell: false`),
//    eliminating `$&` / `$'` replacement-pattern corruption and recursive `{cwd}` expansion.
// 3. `dsh` 0.2.2+ headless NDJSON contract (`dsh headless --json --permission-mode workspace-write|read-only --approval-policy never`):
//    - Grants `--add-dir <git-common-dir>` (physical absolute path) when running write tasks inside
//      a linked Git worktree so `git` staging/commits work without exposing the parent checkout;
//    - Omits `--model` / `--effort` flags (`dsh headless` configures model routing in its profile);
//    - Captures the opening `{ type: "session", sessionId: "session-..." }` identity before arming
//      `--session-id` continuation (never passing Otto's synthetic `workerId` to `--session-id`);
//    - Accumulates `step_end` token deltas (`usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`,
//      folding cache read/write back into `input` per `dsh` `mapUsage`; `dsh` reports tokens only, no USD cost);
//    - Evaluates terminal `{ type: "final", text, reason }` (`completed` vs `error` / `aborted` / `max-tokens`)
//      and requires `final` before treating an exit-0 `dsh-jsonl` stream as completed.
// 4. `zcode` headless JSON contract (`zcode -p {prompt} --mode edit|plan [--resume {sessionId}] --json`):
//    - Prepends `process.execPath` automatically when configured with a `.cjs`/`.mjs`/`.js` script
//      entry (e.g. Windows `resources\glm\zcode.cjs`);
//    - Captures `sessionId` (`sess_...`), assistant `response`, and per-turn `usage` (`inputTokens`,
//      `outputTokens`, `cacheReadTokens`), plus `stream-json` `session.updated` / `turn.failed` events.
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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

/** Prepends `process.execPath` when the command entry is a Node script (`.cjs`, `.mjs`, `.js`),
 *  such as ZCode Desktop's `resources\glm\zcode.cjs` on Windows. */
export function normalizeCommandExecutable(
  command: readonly string[],
  nodeExecPath: string = process.execPath,
): string[] {
  if (command.length === 0) return [];
  const head = command[0]!;
  if (/\.(?:cjs|mjs|js)$/i.test(head)) {
    return [nodeExecPath, ...command];
  }
  return [...command];
}

/** Resolves the shared physical `.git` common directory when `cwd` is a linked Git worktree
 *  (`<cwd>/.git` is a `gitdir:` file), or returns `null` for standard checkouts / plain dirs.
 *  Pure filesystem read — zero `git` subprocess overhead. */
export function resolveWorktreeGitCommonDir(cwd: string): string | null {
  try {
    const dotGit = join(cwd, ".git");
    if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return null;
    const pointer = readFileSync(dotGit, "utf8");
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) return null;
    const rawGitDir = match[1].trim();
    const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(cwd, rawGitDir);

    let commonDir: string | null = null;
    const commonDirFile = join(gitDir, "commondir");
    if (existsSync(commonDirFile)) {
      const rawCommon = readFileSync(commonDirFile, "utf8").trim();
      if (rawCommon) {
        commonDir = isAbsolute(rawCommon) ? rawCommon : resolve(gitDir, rawCommon);
      }
    } else if (basename(dirname(gitDir)) === "worktrees") {
      commonDir = dirname(dirname(gitDir));
    }
    if (!commonDir || !existsSync(commonDir)) return null;
    try {
      return realpathSync(commonDir);
    } catch {
      return commonDir;
    }
  } catch {
    return null;
  }
}

export interface CommandPresetSpec {
  kind: CommandAgentKind;
  /** Base executable argv prefix (e.g. `["dsh"]`, `["C:\\...\\zcode.cjs"]`, or `[node, "fake.mjs"]`). */
  command: string[];
  /** Args appended after `command` for normal (`write`) launches. */
  argsTemplate: string[];
  /** Optional args template when continuing an existing `sessionId`. */
  resumeArgsTemplate?: string[];
  /** Optional args template for strict `readonly` launches; if omitted, `capabilities.readonly` is false. */
  readonlyArgsTemplate?: string[];
  /** Optional args template when continuing an existing `sessionId` in `readonly` mode. */
  readonlyResumeArgsTemplate?: string[];
  /** Extra model flag pair (e.g. `["--model", "{model}"]`) appended ONLY for CLIs that accept a
   *  launch-time model flag. Omitted for `dsh` and `zcode`, which manage model selection via
   *  their own profile / provider config. */
  modelArgsTemplate?: string[];
  /** When true (`dsh`), injects `--add-dir <git-common-dir>` on `write` runs inside a linked Git
   *  worktree so `git` commits/staging inside `workspace-write` can update shared `.git` metadata. */
  grantGitCommonDir?: boolean;
  outputFormat: CommandOutputFormat;
  defaultEffort?: string;
}

export interface StoredCommandAdapterConfig {
  enabled: boolean;
  command: string[];
  argsTemplate?: string[];
  resumeArgsTemplate?: string[];
  readonlyArgsTemplate?: string[];
  readonlyResumeArgsTemplate?: string[];
  modelArgsTemplate?: string[];
  grantGitCommonDir?: boolean;
  outputFormat?: CommandOutputFormat;
  defaultEffort?: string;
}

/** Official DeepSeek Harness (`@deepseek-ai/dsh` 0.2.2+) headless preset:
 *  - `dsh headless --json --permission-mode workspace-write|read-only --approval-policy never`
 *  - Resumes persisted sessions via `--session-id {sessionId}` (repeated permission & `--add-dir` grants)
 *  - No `--model` flag (`dsh headless` reads model selection from its profile). */
export function buildDshPreset(command: string[] = ["dsh"]): CommandPresetSpec {
  return {
    kind: "dsh",
    command,
    argsTemplate: [
      "headless",
      "--json",
      "--permission-mode",
      "workspace-write",
      "--approval-policy",
      "never",
      "{prompt}",
    ],
    resumeArgsTemplate: [
      "headless",
      "--json",
      "--permission-mode",
      "workspace-write",
      "--approval-policy",
      "never",
      "--session-id",
      "{sessionId}",
      "{prompt}",
    ],
    readonlyArgsTemplate: [
      "headless",
      "--json",
      "--permission-mode",
      "read-only",
      "--approval-policy",
      "never",
      "{prompt}",
    ],
    readonlyResumeArgsTemplate: [
      "headless",
      "--json",
      "--permission-mode",
      "read-only",
      "--approval-policy",
      "never",
      "--session-id",
      "{sessionId}",
      "{prompt}",
    ],
    grantGitCommonDir: true,
    outputFormat: "dsh-jsonl",
  };
}

/** Official ZCode CLI (`zcode` / `zcode.cjs`) headless preset:
 *  - Always passes explicit `--mode edit` (`write`) or `--mode plan` (`readonly`) because omitting
 *    `--mode` defaults ZCode `-p` to unrestricted `yolo`
 *  - Resumes persisted sessions (`sess_...`) via `--resume {sessionId}`
 *  - No `--model` flag by default (provider/model managed in `~/.zcode`). */
export function buildZcodePreset(command: string[] = ["zcode"]): CommandPresetSpec {
  return {
    kind: "zcode",
    command,
    argsTemplate: ["-p", "{prompt}", "--mode", "edit", "--json"],
    resumeArgsTemplate: ["-p", "{prompt}", "--mode", "edit", "--resume", "{sessionId}", "--json"],
    readonlyArgsTemplate: ["-p", "{prompt}", "--mode", "plan", "--json"],
    readonlyResumeArgsTemplate: ["-p", "{prompt}", "--mode", "plan", "--resume", "{sessionId}", "--json"],
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
  spec: StartSpec;
  child: ChildProcess;
  cwd: string;
  /** Real CLI session id once observed from stdout or supplied via `spec.resumeSessionId`;
   *  `null` until then so Otto's synthetic `workerId` is never passed to `--session-id` / `--resume`. */
  sessionId: string | null;
  promptAcceptedNotified: boolean;
  finalSeen: boolean;
  parsedStructuredCount: number;
  lastToolError?: string;
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

function presetSupportsModelSelection(preset: CommandPresetSpec): boolean {
  if (preset.modelArgsTemplate && preset.modelArgsTemplate.length > 0) return true;
  const templates = [
    preset.argsTemplate,
    preset.resumeArgsTemplate,
    preset.readonlyArgsTemplate,
    preset.readonlyResumeArgsTemplate,
  ];
  return templates.some((tpl) => tpl?.some((tok) => tok.includes("{model}")));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class CommandAdapter implements AgentAdapter {
  readonly kind: CommandAgentKind;
  readonly capabilities: AgentCapabilities;
  readonly modelCatalog: AgentModelCatalog;

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
    const supportsModel = presetSupportsModelSelection(options.preset);
    this.modelCatalog = {
      capabilities: {
        selection: supportsModel ? "launch" : "none",
        discovery: "none",
        customModelInput: supportsModel,
        actualModelObservation: false,
        thinkingSelection: false,
      },
      status: "ready",
      models: [],
    };
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
    this.launch =
      this.launch ??
      this.options.launch ??
      resolveExecutableLaunch(normalizeCommandExecutable(this.preset.command));
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
    const resumeId = spec.resumeSessionId?.trim() ? spec.resumeSessionId.trim() : undefined;
    const isResume = Boolean(resumeId);
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

    if (spec.mode === "write" && this.preset.grantGitCommonDir && !template.includes("--add-dir")) {
      const gitCommonDir = resolveWorktreeGitCommonDir(spec.cwd);
      if (gitCommonDir) {
        const promptIdx = template.findIndex((tok) => tok.includes("{prompt}"));
        const insertAt = promptIdx >= 0 ? promptIdx : template.length;
        template.splice(insertAt, 0, "--add-dir", gitCommonDir);
      }
    }

    if (spec.model && this.preset.modelArgsTemplate && !template.some((t) => t.includes("{model}"))) {
      const subcmdOffset = template[0] && !template[0].startsWith("-") ? 1 : 0;
      template.splice(subcmdOffset, 0, ...this.preset.modelArgsTemplate);
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
      sessionId: resumeId ?? "",
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

    const knownSid = spec.resumeSessionId?.trim() || this.sessionIds.get(spec.workerId) || null;
    const effectiveSpec: StartSpec =
      spec.resumeSessionId?.trim() ? { ...spec, resumeSessionId: spec.resumeSessionId.trim() } : { ...spec, resumeSessionId: undefined };

    const cmdArgs = this.buildCommandArgs(effectiveSpec, reportFile);

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

    const acceptOnSpawn = this.preset.outputFormat === "text" || Boolean(effectiveSpec.resumeSessionId);
    const runtime: CommandWorkerRuntime = {
      workerId: spec.workerId,
      spec,
      child,
      cwd: spec.cwd,
      sessionId: knownSid,
      promptAcceptedNotified: acceptOnSpawn,
      finalSeen: false,
      parsedStructuredCount: 0,
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
    if (knownSid) {
      this.sessionIds.set(spec.workerId, knownSid);
    }

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
      if (acceptOnSpawn) {
        spec.onPromptAccepted?.();
      }
    } catch {
      // bookkeeping must never fail launch
    }

    this.emit({ type: "progress", workerId: spec.workerId, phase: "thinking", turn: 1 });
    const handle: WorkerHandle = {
      workerId: spec.workerId,
      sessionId: runtime.sessionId ?? "",
      cwd: spec.cwd,
    };
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
    const resumeSessionId = this.capabilities.resume
      ? (this.sessionIds.get(id) ?? (spec.resumeSessionId?.trim() || undefined))
      : undefined;
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
    const resumeSessionId = this.sessionIds.get(id) ?? (spec?.resumeSessionId?.trim() || undefined);
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

  private recordObservedSessionId(runtime: CommandWorkerRuntime, rawSid: unknown): void {
    if (typeof rawSid !== "string" || rawSid.trim().length === 0) return;
    const sid = rawSid.trim();
    const changed = runtime.sessionId !== sid;
    runtime.sessionId = sid;
    this.sessionIds.set(runtime.workerId, sid);
    if (changed) {
      try {
        runtime.spec.onSessionId?.(sid);
      } catch {
        // bookkeeping must never break stream parsing
      }
    }
    if (!runtime.promptAcceptedNotified) {
      runtime.promptAcceptedNotified = true;
      try {
        runtime.spec.onPromptAccepted?.();
      } catch {
        // bookkeeping must never break stream parsing
      }
    }
  }

  private markPromptAccepted(runtime: CommandWorkerRuntime): void {
    if (runtime.promptAcceptedNotified) return;
    runtime.promptAcceptedNotified = true;
    try {
      runtime.spec.onPromptAccepted?.();
    } catch {
      // bookkeeping must never break stream parsing
    }
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
      const parsed = asRecord(JSON.parse(line));
      if (!parsed) return;
      record = parsed;
    } catch {
      return;
    }
    runtime.parsedStructuredCount += 1;

    // Capture persisted session identifier (`dsh` opening `{ type: "session", sessionId }` and
    // `zcode` `{ sessionId }` / `{ session_id }`; also tolerates legacy `sessionID`).
    const observedSid = record.sessionId ?? record.session_id ?? record.sessionID;
    this.recordObservedSessionId(runtime, observedSid);

    const type = typeof record.type === "string" ? record.type : "";

    if (type === "session") {
      this.markPromptAccepted(runtime);
      return;
    }

    if (type === "thinking") {
      this.markPromptAccepted(runtime);
      this.emit({ type: "progress", workerId: runtime.workerId, phase: "thinking", turn: runtime.turn });
      return;
    }

    // `dsh` 0.2.2+ `step_end` token accumulation across steps:
    // `@deepseek-ai/dsh-headless` emits `usage: { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens? }`,
    // where `inputTokens` excludes cached tokens (`dsh` reports tokens only, no USD cost).
    // Also tolerates optional `costUsd` or nested `part.tokens` shapes from custom wrappers.
    if (type === "step_end" || type === "step_finish") {
      this.markPromptAccepted(runtime);
      const part = asRecord(record.part);
      const usageObj = asRecord(record.usage) ?? asRecord(part?.usage) ?? asRecord(part?.tokens);
      if (usageObj) {
        const baseIn = finiteNonNeg(usageObj.inputTokens) ?? finiteNonNeg(usageObj.input) ?? 0;
        const cacheObj = asRecord(usageObj.cache);
        const cacheRead =
          finiteNonNeg(usageObj.cacheReadTokens) ??
          finiteNonNeg(usageObj.cacheRead) ??
          finiteNonNeg(cacheObj?.read) ??
          0;
        const cacheWrite =
          finiteNonNeg(usageObj.cacheWriteTokens) ??
          finiteNonNeg(usageObj.cacheWrite) ??
          finiteNonNeg(cacheObj?.write) ??
          0;
        const outTok =
          (finiteNonNeg(usageObj.outputTokens) ?? finiteNonNeg(usageObj.output) ?? 0) +
          (finiteNonNeg(usageObj.reasoningTokens) ?? finiteNonNeg(usageObj.reasoning) ?? 0);
        const stepInput = baseIn + cacheRead + cacheWrite;
        runtime.dshUsage.inputTokens += stepInput;
        runtime.dshUsage.outputTokens += outTok;
        runtime.dshUsage.cachedInputTokens += cacheRead + cacheWrite;
        runtime.dshUsage.lastStepTokens = stepInput + outTok;
        runtime.dshUsage.hasTokens = true;

        const explicitCost =
          finiteNonNeg(usageObj.costUsd) ??
          finiteNonNeg(part?.costUsd) ??
          finiteNonNeg(part?.cost) ??
          finiteNonNeg(record.costUsd) ??
          finiteNonNeg(record.cost);
        if (explicitCost !== undefined) {
          runtime.dshUsage.costUsd = Math.round((runtime.dshUsage.costUsd + explicitCost) * 1e8) / 1e8;
          runtime.dshUsage.hasCost = true;
        }
      }
      const ctxWin = finiteNonNeg(part?.contextWindow) ?? finiteNonNeg(record.contextWindow);
      if (ctxWin && ctxWin > 0) {
        runtime.dshUsage.contextWindow = ctxWin;
      }
      runtime.turn += 1;
      this.emit({ type: "progress", workerId: runtime.workerId, phase: "thinking", turn: runtime.turn });
      return;
    }

    if (type === "tool_call" || type === "tool_use" || type === "tool_start") {
      this.markPromptAccepted(runtime);
      runtime.window.hadWork = true;
      const toolName =
        typeof record.name === "string"
          ? record.name
          : typeof record.tool === "string"
            ? record.tool
            : "tool";
      const args = record.arguments ?? record.args ?? record.input;
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

    if (type === "tool_result") {
      this.markPromptAccepted(runtime);
      const errObj = asRecord(record.error);
      if (errObj) {
        const code = typeof errObj.code === "string" ? errObj.code : undefined;
        const reason =
          typeof errObj.reason === "string"
            ? errObj.reason
            : typeof errObj.message === "string"
              ? errObj.message
              : typeof errObj.name === "string"
                ? errObj.name
                : undefined;
        const explicitReset = extractResetTimestampFromRecord(errObj);
        if (explicitReset !== undefined) runtime.explicitResetAt = explicitReset;
        if (code || reason) {
          runtime.lastToolError = code && reason ? `${code}: ${reason}` : (code ?? reason);
        }
      }
      return;
    }

    // `dsh` terminal `final` event: `{ type: "final", sessionId, text, reason }`.
    // In-turn failures emit `final` with `reason.kind !== "completed"` and NO separate `error` event.
    if (type === "final") {
      this.markPromptAccepted(runtime);
      runtime.finalSeen = true;
      const finalText =
        typeof record.text === "string" ? record.text : (runtime.window.lastAssistant?.text ?? "");
      const reasonObj = asRecord(record.reason);
      const reasonKind =
        typeof reasonObj?.kind === "string"
          ? reasonObj.kind
          : typeof record.reason === "string"
            ? record.reason
            : record.reason === null
              ? "null"
              : "completed";

      if (reasonKind === "completed") {
        runtime.window.lastAssistant = {
          stopReason: "stop",
          text: finalText,
        };
        const embedded = tryParseInlineReport(finalText);
        if (embedded) runtime.window.report = embedded;
      } else if (reasonKind === "aborted" || reasonKind === "interrupted") {
        runtime.aborted = true;
      } else if (reasonKind === "max-tokens") {
        runtime.window.lastAssistant = {
          stopReason: "length",
          text: finalText,
        };
      } else {
        const errObj = asRecord(reasonObj?.error);
        const explicitReset =
          (errObj ? extractResetTimestampFromRecord(errObj) : undefined) ??
          (reasonObj ? extractResetTimestampFromRecord(reasonObj) : undefined) ??
          extractResetTimestampFromRecord(record);
        if (explicitReset !== undefined) runtime.explicitResetAt = explicitReset;
        const errCode = typeof errObj?.code === "string" ? errObj.code : undefined;
        const errMsg =
          typeof errObj?.message === "string"
            ? errObj.message
            : typeof reasonObj?.reason === "string"
              ? reasonObj.reason
              : runtime.lastToolError ?? `dsh turn ended with reason '${reasonKind}'`;
        const formatted = errCode ? `${errCode}: ${errMsg}` : errMsg;
        runtime.window.lastAssistant = {
          stopReason: "error",
          errorMessage: formatted,
          text: finalText,
        };
      }
      return;
    }

    // ZCode `stream-json` events (`turn.failed` & `session.updated`).
    if (type === "turn.failed") {
      const payload = asRecord(record.payload) ?? record;
      const errObj = asRecord(payload.error);
      const explicitReset =
        (errObj ? extractResetTimestampFromRecord(errObj) : undefined) ??
        extractResetTimestampFromRecord(payload) ??
        extractResetTimestampFromRecord(record);
      if (explicitReset !== undefined) runtime.explicitResetAt = explicitReset;
      const errMsg =
        typeof errObj?.message === "string"
          ? errObj.message
          : typeof payload.message === "string"
            ? payload.message
            : `${this.kind} turn failed`;
      runtime.window.lastAssistant = {
        stopReason: "error",
        errorMessage: errMsg,
        text: runtime.window.lastAssistant?.text ?? "",
      };
      return;
    }

    if (type === "session.updated") {
      this.markPromptAccepted(runtime);
      const payload = asRecord(record.payload);
      if (payload) {
        if (typeof payload.content === "string" && payload.content.length > 0) {
          runtime.window.lastAssistant = {
            stopReason: "stop",
            text: payload.content,
          };
          const embedded = tryParseInlineReport(payload.content);
          if (embedded) runtime.window.report = embedded;
        }
        const usageObj = asRecord(payload.usage);
        if (usageObj) {
          runtime.jsonUsage = parseSingleTurnJsonUsage(usageObj, payload);
        }
      }
      return;
    }

    if (type === "error" || record.is_error === true) {
      const errObj = asRecord(record.error);
      const errMsg =
        typeof record.message === "string"
          ? record.message
          : typeof errObj?.message === "string"
            ? errObj.message
            : typeof record.error === "string"
              ? record.error
              : typeof record.response === "string" && record.response.length > 0
                ? record.response
                : typeof record.result === "string"
                  ? record.result
                  : `${this.kind} command reported an error`;
      const explicitReset =
        (errObj ? extractResetTimestampFromRecord(errObj) : undefined) ?? extractResetTimestampFromRecord(record);
      if (explicitReset !== undefined) runtime.explicitResetAt = explicitReset;
      runtime.window.lastAssistant = {
        stopReason: "error",
        errorMessage: errMsg,
        text: runtime.window.lastAssistant?.text ?? "",
      };
      return;
    }

    // Assistant text / single-JSON result extraction:
    // - `dsh` `text` events carry committed step messages (`text` is replaced by later steps / `final.text`;
    //   `text_delta` appends incremental chunks).
    // - `zcode -p ... --json` prints `{ sessionId, response, usage: { inputTokens, outputTokens, cacheReadTokens } }`.
    const partObj = asRecord(record.part);
    const textCandidate =
      typeof record.response === "string"
        ? record.response
        : typeof record.text === "string"
          ? record.text
          : typeof record.result === "string"
            ? record.result
            : typeof partObj?.text === "string"
              ? partObj.text
              : undefined;
    if (textCandidate !== undefined) {
      this.markPromptAccepted(runtime);
      const prev = type === "text_delta" ? (runtime.window.lastAssistant?.text ?? "") : "";
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

    const topUsage = asRecord(record.usage);
    if (topUsage) {
      this.markPromptAccepted(runtime);
      runtime.jsonUsage = parseSingleTurnJsonUsage(topUsage, record);
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
      const remaining = runtime.stdoutBuffer.trim();
      runtime.stdoutBuffer = "";
      for (const line of remaining.split("\n")) {
        if (line.trim()) this.consumeStructuredLine(runtime, line.trim());
      }
    }
    // `zcode -p ... --json` may pretty-print a single JSON object across multiple lines (so each
    // individual line failed `JSON.parse` during streaming). Fall back to parsing the full JSON
    // object from `rawStdout` when no single-line JSON record succeeded.
    if (this.preset.outputFormat === "json" && runtime.parsedStructuredCount === 0 && runtime.rawStdout.trim()) {
      const full = runtime.rawStdout.trim();
      const firstBrace = full.indexOf("{");
      const lastBrace = full.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        this.consumeStructuredLine(runtime, full.slice(firstBrace, lastBrace + 1));
      }
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
    } else if (
      this.preset.outputFormat === "dsh-jsonl" &&
      !runtime.finalSeen &&
      !runtime.window.report &&
      runtime.window.lastAssistant?.stopReason !== "error"
    ) {
      // `dsh headless --json` contract: a completed run MUST emit a terminal `final` event
      // AND exit 0; ending without `final` indicates a pre-turn/driver failure or truncated run.
      const detail =
        (runtime.stderrTail.trim() || runtime.lastToolError || runtime.rawStdout.trim()).slice(-600) ||
        `dsh exited (code ${code ?? "null"}${signal ? `, ${signal}` : ""}) before emitting a final event`;
      runtime.window.lastAssistant = {
        stopReason: "error",
        errorMessage: detail,
        text: runtime.window.lastAssistant?.text ?? "",
      };
    } else if (code !== 0 && !runtime.window.report && runtime.window.lastAssistant?.stopReason !== "error") {
      const detail =
        (runtime.stderrTail.trim() || runtime.lastToolError || runtime.rawStdout.trim()).slice(-600) ||
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
      ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
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

function parseSingleTurnJsonUsage(
  u: Record<string, unknown>,
  envelope: Record<string, unknown>,
): SessionUsage | undefined {
  const rawIn = finiteNonNeg(u.inputTokens) ?? finiteNonNeg(u.input_tokens);
  const outTok = finiteNonNeg(u.outputTokens) ?? finiteNonNeg(u.output_tokens) ?? 0;
  const cacheRead =
    finiteNonNeg(u.cacheReadTokens) ??
    finiteNonNeg(u.cache_read_input_tokens) ??
    finiteNonNeg(u.cached_input_tokens) ??
    0;
  const cacheWrite =
    finiteNonNeg(u.cacheWriteTokens) ??
    finiteNonNeg(u.cache_creation_input_tokens) ??
    0;
  const cached = cacheRead + cacheWrite;
  const explicitTotal = finiteNonNeg(u.totalTokens) ?? finiteNonNeg(u.total_tokens);
  let input: number | undefined = rawIn;
  if (rawIn !== undefined) {
    // If `totalTokens` exceeds `inputTokens + outputTokens` (or `inputTokens < cached`),
    // `inputTokens` was reported uncached and needs `cached` folded in; otherwise (`zcode`)
    // `inputTokens` already includes cached prompt tokens.
    if (explicitTotal !== undefined && explicitTotal > rawIn + outTok) {
      input = Math.max(rawIn + cached, explicitTotal - outTok);
    } else if (rawIn < cached) {
      input = rawIn + cached;
    }
  }
  const cost =
    finiteNonNeg(envelope.cost_usd) ??
    finiteNonNeg(envelope.costUsd) ??
    finiteNonNeg(envelope.cost) ??
    finiteNonNeg(u.costUsd) ??
    finiteNonNeg(u.cost);

  if (input === undefined && cost === undefined) return undefined;
  return {
    ...(input !== undefined
      ? {
          tokens: {
            input,
            output: outTok,
            totalTokens: input + outTok,
            ...(cached > 0 ? { cachedInputTokens: cached } : {}),
          },
        }
      : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
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
    const resolved = resolveExecutableLaunch(normalizeCommandExecutable(command));
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
      ...(stored.readonlyResumeArgsTemplate ? { readonlyResumeArgsTemplate: stored.readonlyResumeArgsTemplate } : {}),
      ...(stored.modelArgsTemplate ? { modelArgsTemplate: stored.modelArgsTemplate } : {}),
      ...(stored.grantGitCommonDir !== undefined ? { grantGitCommonDir: stored.grantGitCommonDir } : {}),
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
      ...(stored.readonlyResumeArgsTemplate ? { readonlyResumeArgsTemplate: stored.readonlyResumeArgsTemplate } : {}),
      ...(stored.modelArgsTemplate ? { modelArgsTemplate: stored.modelArgsTemplate } : {}),
      ...(stored.grantGitCommonDir !== undefined ? { grantGitCommonDir: stored.grantGitCommonDir } : {}),
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
    ...(stored.readonlyResumeArgsTemplate ? { readonlyResumeArgsTemplate: stored.readonlyResumeArgsTemplate } : {}),
    ...(stored.modelArgsTemplate ? { modelArgsTemplate: stored.modelArgsTemplate } : {}),
    ...(stored.grantGitCommonDir !== undefined ? { grantGitCommonDir: stored.grantGitCommonDir } : {}),
    outputFormat: stored.outputFormat ?? "text",
    ...(stored.defaultEffort ? { defaultEffort: stored.defaultEffort } : {}),
  };
}
