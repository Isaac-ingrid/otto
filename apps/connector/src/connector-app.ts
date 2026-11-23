// Composition root: LocalStore + WorkerManager + ConnectorClient. Commands arriving on the
// authenticated connection drive the WorkerManager through the client's handleCommand hook
// (CommandLog dedup happens there); worker events flow back via client.emit — persisted to
// the durable EventLog before the wire (connector-pi.md §11.3, connector-do-protocol.md §7.1).
// On boot the §9.1 reconciliation runs BEFORE the first hello, so the hello.workers snapshot
// the DO reconciles against already reflects the crash (issue #12).
import os from "node:os";
import { isAbsolute, join } from "node:path";
import { ConnectorClient, type ClientOptions } from "./client.ts";
import { CommandLog, type CommandResult } from "./commands.ts";
import { RegisterRepoArgsSchema, type CmdMessage } from "@isaac2ingrid/protocol";
import { registerRepository } from "./repository.ts";
import { EventLog } from "./events.ts";
import { repoHookCapabilitySummary } from "./hooks.ts";
import { scanRepoSkillBriefsSync } from "./repo-skills.ts";
import type { LocalStore, AntigravityApiKeyConfig } from "./store.ts";
import type { StallWatchdogOptions } from "./watchdog.ts";
import { CommandError, WorkerManager, type RecoveryOptions } from "./worker-manager.ts";
import type { AgentAdapter } from "./agent.ts";
import { PiAdapter } from "./pi-adapter.ts";
import { ClaudeAdapter, claudeCommandFromEnv, detectClaude } from "./claude-adapter.ts";
import { CodexAdapter, codexCommandFromEnv, detectCodex } from "./codex-adapter.ts";
import { AntigravityAdapter, agyCommandFromEnv, detectAntigravity } from "./antigravity-adapter.ts";
import { VERSION } from "./version.ts";
import type { PrExec } from "./pr.ts";

export interface ConnectorAppOptions {
  store: LocalStore;
  stateDir: string;
  machineName?: string;
  WebSocketImpl?: ClientOptions["WebSocketImpl"];
  /** Per-URL `ws` proxy agent (issue #68), forwarded to the client. */
  wsAgent?: ClientOptions["wsAgent"];
  /** Every agent to drive (issue #17); defaults to pi plus Claude Code when installed.
   *  Overrides `adapter` when both are given. */
  adapters?: AgentAdapter[];
  /** Single-adapter override (tests inject fake-pi). */
  adapter?: import("./agent.ts").AgentAdapter;
  /** The claude argv prefix for the default adapter set (issue #17); tests point it at
   *  fake-claude. Ignored when `adapters`/`adapter` is given. */
  claudeCommand?: string[];
  /** The codex argv prefix for the default adapter set; tests point it at fake-codex. */
  codexCommand?: string[];
  /** The agy argv prefix for the default adapter set; tests point it at fake-agy. */
  agyCommand?: string[];
  /** Optional isolated Antigravity Gemini API key profile (`otto agy-key`). */
  agyApiKeyConfig?: AntigravityApiKeyConfig | null;
  /** §9 recovery knobs (tests shrink timers and inject process I/O). */
  recovery?: RecoveryOptions;
  /** Stall-watchdog knobs (tests shrink timers and inject CPU samples). */
  watchdog?: StallWatchdogOptions;
  /** pr_worker knobs (issue #21): the exec seam scripts gh/git in tests. */
  pr?: { exec?: PrExec; timeoutMs?: number };
  /** Coarse lifecycle logging (daemon): event names and ids only, never session content. */
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Connection lifecycle hooks, forwarded to the client (the daemon logs these). */
  onWelcome?: ClientOptions["onWelcome"];
  onClose?: ClientOptions["onClose"];
}

/** §12: clamp(floor(0.5 × total memory MB / 250 MB), 1, 8), configurable later. */
export function maxWorkersFromMemory(): number {
  return Math.min(8, Math.max(1, Math.floor(0.5 * (os.totalmem() / 1_000_000) / 250)));
}

/** Issue #17: the connector's default agent set — pi always, plus Claude Code, Codex, and
 *  Antigravity CLI when their binaries are installed on the machine. */
export function defaultAdapters(
  stateDir: string,
  claudeCommand: string[] = claudeCommandFromEnv() ?? ["claude"],
  agyCommand: string[] = agyCommandFromEnv() ?? ["agy"],
  agyApiKeyConfig?: AntigravityApiKeyConfig | null,
  codexCommand: string[] = codexCommandFromEnv() ?? ["codex"],
): AgentAdapter[] {
  const adapters: AgentAdapter[] = [new PiAdapter({ stateDir })];
  const claude = detectClaude(claudeCommand);
  if (claude.installed) {
    adapters.push(new ClaudeAdapter({ stateDir, command: claudeCommand, version: claude.version }));
  }
  const codex = detectCodex(codexCommand);
  if (codex.installed) {
    adapters.push(new CodexAdapter({ stateDir, command: codexCommand, version: codex.version }));
  }
  const agy = detectAntigravity(agyCommand);
  if (agy.installed) {
    adapters.push(
      new AntigravityAdapter({
        stateDir,
        command: agyCommand,
        version: agy.version,
        ...(agyApiKeyConfig ? { apiKeyConfig: agyApiKeyConfig } : {}),
      }),
    );
  }
  return adapters;
}

export class ConnectorApp {
  private readonly store: LocalStore;
  private readonly stateDir: string;
  private readonly log?: (event: string, fields?: Record<string, unknown>) => void;
  readonly manager: WorkerManager;
  readonly client: ConnectorClient;
  private commandLog: CommandLog;
  private stopped = false;

  constructor(options: ConnectorAppOptions) {
    this.store = options.store;
    this.stateDir = options.stateDir;
    this.log = options.log;
    const events = new EventLog(options.store.database);
    this.commandLog = new CommandLog(options.store.database);
    const adapters =
      options.adapters ??
      (options.adapter
        ? [options.adapter]
        : defaultAdapters(
            options.stateDir,
            options.claudeCommand,
            options.agyCommand,
            options.agyApiKeyConfig ?? options.store.getAntigravityApiKeyConfig(),
            options.codexCommand,
          ));
    this.manager = new WorkerManager({
      store: options.store,
      stateDir: options.stateDir,
      adapters,
      recovery: options.recovery,
      // Detection failures must surface in the daemon log, never as an unhandled rejection
      // (Node's default would crash the connector over its own watchdog). A caller-supplied
      // onError runs FIRST and unconditionally — it may be the only sink wired (PR #46
      // review finding 2: the spread used to let the log overwrite it).
      watchdog: {
        ...options.watchdog,
        onError: (err) => {
          options.watchdog?.onError?.(err);
          this.log?.("watchdog_error", { error: err instanceof Error ? err.message : String(err) });
        },
      },
      pr: options.pr,
      emit: (workerId, fields) => {
        this.log?.("worker_event", { workerId, type: fields.type });
        this.client.emit(workerId, fields);
      },
      onExpectMarker: (cmdId, meta) => this.commandLog.expectMarker(cmdId, meta),
    });

    this.client = new ConnectorClient({
      store: options.store,
      machineName: options.machineName,
      WebSocketImpl: options.WebSocketImpl,
      wsAgent: options.wsAgent,
      handleCommand: (cmd: CmdMessage) => this.runCommand(cmd),
      snapshot: () => this.snapshot(),
      workersSnapshot: () => this.workersSnapshot(),
      discoverModels: agent => this.manager.refreshAgentModels(agent),
      diffWorker: (request) => {
        this.log?.("worker_diff_requested", { workerId: request.workerId, hasFilePath: Boolean(request.filePath) });
        return this.manager.diffWorker(request);
      },
      checkpointWorker: (request) => {
        this.log?.("worker_checkpoint_requested", { workerId: request.workerId });
        return this.manager.checkpointWorker(request);
      },
      repoSkillOp: (op) => {
        this.log?.("repo_skill_op_requested", { action: op.action, repoId: op.scope.repoId });
        return this.manager.repoSkillOp(op);
      },
      auditWorktrees: (args) => {
        this.log?.("worktree_audit_requested", { repoId: args.repoId ?? null });
        return this.manager.auditWorktrees(args);
      },
      cleanupWorktrees: (op) => {
        this.log?.("worktree_cleanup_requested", { targetCount: op.targets.length, pruneCount: op.pruneRepoIds?.length ?? 0 });
        return this.manager.cleanupWorktrees(op);
      },
      // L3 raw-history reads (§11.4): live get_entries while the process runs, the session
      // JSONL along the current branch otherwise. Logged at lifecycle level only — the
      // transcript itself never reaches the log.
      loadHistory: (workerId, since, maxBytes, format) => {
        this.log?.("history_requested", { workerId, since: since ?? null, maxBytes, format: format ?? "summary" });
        return this.manager.history(workerId, since, maxBytes, format);
      },
      onWelcome: options.onWelcome,
      onClose: options.onClose,
    });
  }

  /**
   * Reconcile first (§9.1: orphan cleanup, stale locks, session-tail checks, resume
   * scheduling), then connect — the first hello's workers snapshot and bootId let the DO
   * reconcile against post-crash reality instead of stale pre-crash states. Reconciliation
   * is local disk I/O and process cleanup only, so this returns quickly; callers that don't
   * care (the daemon) may fire-and-forget, but awaiting keeps startup failures visible.
   */
  async start(): Promise<void> {
    await this.manager.reconcileStartup();
    for (const agent of this.manager.agents) {
      if (!this.stopped && agent.modelCatalog?.refreshable) {
        try { await this.manager.refreshAgentModels(agent.kind); }
        catch { this.log?.('model_discovery_failed', { agent: agent.kind }); }
      }
    }
    if (!this.stopped) this.client.start();
  }

  stop(): void {
    this.stopped = true;
    this.manager.stop();
    this.client.stop();
  }

  /** Test support: emulate a connector crash (issue #12 fault injection). */
  simulateCrash(): void {
    this.manager.simulateCrash();
    this.client.stop();
  }

  private async runCommand(cmd: CmdMessage): Promise<CommandResult> {
    this.log?.("command_received", { cmdId: cmd.id, kind: cmd.kind });
    try {
      let data: unknown;
      if (cmd.kind === "reconcile") {
        // protocol §6.2: a fresh hello.workers snapshot on demand.
        data = { workers: this.workersSnapshot() };
      } else if (cmd.kind === "register_repo") {
        const parsed = RegisterRepoArgsSchema.safeParse(cmd.args);
        if (!parsed.success) throw new CommandError("invalid_directory", "A directory path is required.");
        const requested = parsed.data.path;
        const path = requested === "~" ? os.homedir() : requested.startsWith("~/") ? join(os.homedir(), requested.slice(2)) : requested;
        if (!isAbsolute(path)) throw new CommandError("invalid_directory", "Use an absolute path or ~/path on this machine.");
        data = { repo: await registerRepository({ store: this.store, path, stateDir: this.stateDir }) };
      } else {
        data = await this.manager.handleCommand(cmd.id, cmd.kind, cmd.args ?? {}, cmd.workerId);
      }
      this.log?.("command_settled", { cmdId: cmd.id, kind: cmd.kind, ok: true });
      return { ok: true, data };
    } catch (err) {
      if (err instanceof CommandError) {
        this.log?.("command_settled", { cmdId: cmd.id, kind: cmd.kind, ok: false, code: err.code });
        return { ok: false, error: { code: err.code, message: err.message, retriable: err.retriable } };
      }
      const code = (err as { code?: string }).code ?? "internal";
      const message = err instanceof Error ? err.message : String(err);
      this.log?.("command_settled", { cmdId: cmd.id, kind: cmd.kind, ok: false, code });
      return { ok: false, error: { code, message, retriable: false } };
    }
  }

  /** The hello.workers snapshot (protocol §6.1): every worker from the connector's point of
   * view — the DO's reconciliation input. `lastSeq` lets the DO skip workers whose event
   * stream is still in flight. */
  workersSnapshot(): Array<Record<string, unknown>> {
    const events = new EventLog(this.store.database);
    return this.store.listWorkers().map((w) => ({
      workerId: w.workerId,
      agent: w.agent ?? "pi",
      state: w.state,
      lastSeq: events.nextSeq(w.workerId) - 1,
      sessionId: w.sessionId ?? "",
      lastOutcome: w.lastOutcome ?? "",
      hasWorktree: Boolean(w.worktree),
      requestedModel: w.requestedModel ?? null,
      launchObservedModel: w.launchObservedModel ? JSON.parse(w.launchObservedModel) : null,
      lastObservedModel: w.lastObservedModel ? JSON.parse(w.lastObservedModel) : null,
    }));
  }

  /** Honest hello snapshot (protocol §6.1): agents, repos, limits. */
  private snapshot() {
    const workers = this.store.listWorkers();
    return {
      agents: this.manager.agents.map((a) => ({
        kind: a.kind,
        version: a.version ?? VERSION,
        capabilities: a.capabilities,
        ...(a.modelCatalog ? { modelCatalog: a.modelCatalog } : {}),
      })),
      repos: this.store.listRepos().map((r) => {
        const hookSummary = repoHookCapabilitySummary(r, this.stateDir);
        const skills = scanRepoSkillBriefsSync(r.path);
        return {
          repoId: r.repoId,
          name: r.name,
          path: r.path,
          defaultBranch: r.capability.kind === "git" ? r.capability.defaultBranch ?? "" : "",
          remote: r.capability.kind === "git" ? r.capability.remote ?? "" : "",
          capability: r.capability,
          capabilityKind: hookSummary.capabilityKind,
          hasSetupHook: hookSummary.hasSetupHook,
          hasArchiveHook: hookSummary.hasArchiveHook,
          approved: hookSummary.approved,
          projectApproved: r.approved === true,
          writePolicy: r.writePolicy,
          ...(skills.length > 0 ? { skills } : {}),
        };
      }),
      limits: {
        maxWorkers: maxWorkersFromMemory(),
        running: workers.filter((w) => w.state === "running" || w.state === "starting").length,
      },
    };
  }
}
