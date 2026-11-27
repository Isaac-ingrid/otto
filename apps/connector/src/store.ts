// LocalStore (ADR-0001 decision 13): device credentials, the connEpoch counter, the command
// dedup log (connector-pi.md §6.3), and the persistent event log with per-worker seq counters —
// all in node:sqlite so they survive connector restarts (the spike's seqs.json bug: the DO
// dedups on (workerId, seq), so a restart that renumbers events silently drops them all).
// The worker-pi slice adds the repo whitelist (§8.1) and worker lifecycle rows (§5.1); command
// and event persistence live in CommandLog/EventLog over the same database. Issue #12 adds
// the §9 recovery tables: descendant snapshots for orphan cleanup (§9.3) and the per-worker
// auto-resume budget (§9.2), both read at startup before the first hello. Issue #16 adds the
// §8.2/§13 per-repo local settings — workspace mode and approveProject, CLI-settable only —
// plus the serial-mode write queue.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentModelObservation, GitCapability, PlainCapability, RepoCapability } from "@isaac2ingrid/protocol";
import type { ProcRef } from "./descendants.ts";
import type { RepoHooksConfig } from "./hooks.ts";
import { normalizeProxyConfig, type ProxyConfig } from "./proxy.ts";
import {
  DEFAULT_GIT_WRITE_POLICY,
  DEFAULT_PLAIN_WRITE_POLICY,
  type Concurrency,
  type InPlacePolicy,
  type Isolation,
  type WritePolicy,
} from "./write-policy.ts";

export interface Credentials {
  serverUrl: string;
  deviceId: string;
  token: string;
  connEpoch: number;
}

export class WritePolicyError extends Error {}

export class LocalStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      serverUrl TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      token TEXT NOT NULL,
      connEpoch INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS command (
      cmdId TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      result TEXT,
      createdAt INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS event (
      workerId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (workerId, seq)
    )`);
    // Transport failures retain their original payload locally, even after the bounded
    // failure notice is acknowledged. Never delete an oversized event to skip its seq.
    this.db.exec(`CREATE TABLE IF NOT EXISTS event_oversize (
      workerId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (workerId, seq)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_seq (
      workerId TEXT PRIMARY KEY,
      nextSeq INTEGER NOT NULL DEFAULT 1,
      ackedUpTo INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS repo (
      repoId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'git',
      defaultBranch TEXT,
      remote TEXT,
      addedAt INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker (
      workerId TEXT PRIMARY KEY,
      threadId TEXT NOT NULL,
      repoId TEXT NOT NULL,
      mode TEXT NOT NULL,
      state TEXT NOT NULL,
      sessionId TEXT,
      sessionFile TEXT,
      branch TEXT,
      worktree TEXT,
      lastOutcome TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )`);
    // Issue #17: which AgentAdapter owns the worker — set at start, immutable afterwards.
    this.addColumnIfMissing("worker", "agent", "TEXT NOT NULL DEFAULT 'pi'");
    this.addColumnIfMissing('worker', 'requestedModel', 'TEXT');
    this.addColumnIfMissing('worker', 'modelSource', "TEXT NOT NULL DEFAULT 'agent-default'");
    this.addColumnIfMissing('worker', 'launchObservedModel', 'TEXT');
    this.addColumnIfMissing('worker', 'lastObservedModel', 'TEXT');
    // The worktree base (§8.2) persisted so a restarted connector can still collect git
    // facts for a retroactive report (§9.1) — spikes kept it only in memory.
    this.addColumnIfMissing("worker", "base", "TEXT");
    // Issue #15, §6.3/§10: crash-window evidence — the command's recovery context and the
    // session-entry watermark a pre-launch comparison starts from.
    this.addColumnIfMissing("worker", "lastKnownEntryId", "TEXT");
    this.addColumnIfMissing("worker", "promptAccepted", "INTEGER NOT NULL DEFAULT 0");
    for (const column of ["workerId", "kind", "sessionFile", "afterEntryId"]) {
      this.addColumnIfMissing("command", column, "TEXT");
    }
    this.addColumnIfMissing("command", "markerExpected", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("command", "recovered", "INTEGER NOT NULL DEFAULT 0");
    // §8.2/§13 (issue #16): per-repo local settings. All are CLI-only — a command from the
    // steward gets their effects but can never set them.
    this.addColumnIfMissing("repo", "kind", "TEXT NOT NULL DEFAULT 'git'"); // 'git' | 'plain' — correct backfill, every pre-existing row was necessarily Git-backed
    this.addColumnIfMissing("repo", "approved", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("repo", "isolation", "TEXT NOT NULL DEFAULT 'worktree'");
    this.addColumnIfMissing("repo", "concurrency", "TEXT NOT NULL DEFAULT 'parallel'");
    // ADR-0022 Stage 2 (Plan B): locally approved worktree lifecycle hooks (CLI-only).
    this.addColumnIfMissing("repo", "setupHook", "TEXT");
    this.addColumnIfMissing("repo", "archiveHook", "TEXT");
    this.addColumnIfMissing("repo", "hookApprovedSha256", "TEXT");
    this.addColumnIfMissing("repo", "hookApprovedAt", "INTEGER");
    // Backfill from the legacy `workspace` column, if it still exists on this database, into the
    // new isolation/concurrency pair — exact mapping, not best-effort, since only 3 legacy values
    // ever existed. Then drop the legacy column; nothing reads it after this point (local SQLite
    // file, single connector binary, no cross-version reader to protect, unlike the wire schema).
    const repoColumns = this.db.prepare(`PRAGMA table_info(repo)`).all() as Array<{ name: string }>;
    if (repoColumns.some((c) => c.name === "workspace")) {
      this.db.exec(`UPDATE repo SET isolation = 'worktree', concurrency = 'parallel' WHERE workspace = 'worktree'`);
      this.db.exec(`UPDATE repo SET isolation = 'worktree', concurrency = 'serial'   WHERE workspace = 'serial'`);
      this.db.exec(`UPDATE repo SET isolation = 'in-place', concurrency = 'parallel' WHERE workspace = 'main'`);
      this.db.exec(`ALTER TABLE repo DROP COLUMN workspace`);
    }
    // Review finding 5 (PR #43): marks a worktree removed by cleanup_worktree, so a later
    // manual resume can be refused instead of silently running write-mode in the checkout.
    // A NULL worktree alone cannot carry that meaning — synthetic/legacy rows have it NULL.
    this.addColumnIfMissing("worker", "worktreeCleanedAt", "INTEGER");
    // §9.3: the latest 5-second descendant snapshot per running worker.
    this.db.exec(`CREATE TABLE IF NOT EXISTS orphan_snapshot (
      workerId TEXT PRIMARY KEY,
      refs TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    )`);
    // §9.2: auto-resume attempts; the ≤2/hour budget is computed over these rows.
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_resume (
      workerId TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS worker_resume_worker_at ON worker_resume (workerId, at)`);
    // §8.2 serial mode (issue #16): the start_worker args of write workers waiting for the
    // repo's serial slot, so a connector restart re-arms the queue instead of stranding the
    // Thread at `starting` forever (the command result already went out with queued:true).
    this.db.exec(`CREATE TABLE IF NOT EXISTS queued_start (
      workerId TEXT PRIMARY KEY,
      commandId TEXT NOT NULL,
      args TEXT NOT NULL,
      queuedAt INTEGER NOT NULL
    )`);
    // Issue #68: machine-local proxy config (key "proxy"). Stored here — not in the service
    // unit's environment — so the background daemon reads it at boot and both its channels
    // (fetch, ws) plus every child (git, pi workers via childEnv) follow it.
    this.db.exec(`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    chmodSync(path, 0o600);
  }

  /** Idempotent ALTER for databases created before a column existed (spike bug 2 pattern). */
  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  // Shared with CommandLog / EventLog, which own their own tables' logic.
  get database(): DatabaseSync {
    return this.db;
  }

  saveCredentials(credentials: Omit<Credentials, "connEpoch">): void {
    this.db.exec("DELETE FROM credentials");
    this.db
      .prepare("INSERT INTO credentials (id, serverUrl, deviceId, token, connEpoch) VALUES (0, ?, ?, ?, 0)")
      .run(credentials.serverUrl, credentials.deviceId, credentials.token);
  }

  getCredentials(): Credentials | null {
    const row = this.db.prepare("SELECT serverUrl, deviceId, token, connEpoch FROM credentials WHERE id = 0").get() as
      | Credentials
      | undefined;
    return row ?? null;
  }

  // Increments and persists connEpoch, then returns the new value. Called once per connection
  // attempt (protocol §3.4): the DO supersedes any live connection with a lower connEpoch.
  nextConnEpoch(): number {
    const row = this.db.prepare("SELECT connEpoch FROM credentials WHERE id = 0").get() as { connEpoch: number } | undefined;
    if (!row) throw new Error("no credentials saved");
    const next = row.connEpoch + 1;
    this.db.prepare("UPDATE credentials SET connEpoch = ? WHERE id = 0").run(next);
    return next;
  }

  /** Replaces just the token — SERVER_KEY rotation (issue #27): the steward hands the
   * connector a rekeyed token on welcome; serverUrl/deviceId/epoch are unchanged. */
  updateToken(token: string): void {
    this.db.prepare("UPDATE credentials SET token = ? WHERE id = 0").run(token);
  }

  clearCredentials(): void {
    this.db.exec("DELETE FROM credentials");
  }

  // --- Machine-local config (issue #68) -------------------------------------------------------

  /** The stored proxy config, or null. A row that no longer parses is treated as absent
   *  (hand-edited or from a future format) rather than failing the daemon's boot. */
  getProxyConfig(): ProxyConfig | null {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'proxy'").get() as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as { url?: unknown; noProxy?: unknown };
      if (typeof parsed.url !== "string") return null;
      return normalizeProxyConfig(parsed.url, typeof parsed.noProxy === "string" ? parsed.noProxy : undefined);
    } catch {
      return null;
    }
  }

  setProxyConfig(config: ProxyConfig): void {
    this.db
      .prepare("INSERT INTO config (key, value) VALUES ('proxy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(config));
  }

  clearProxyConfig(): void {
    this.db.prepare("DELETE FROM config WHERE key = 'proxy'").run();
  }

  /** Machine-local allowlist for `CommandAdapter` (`dsh`, `zcode`, `command`). Never mutable
   *  via Steward wire commands (ADR-0022). */
  getCommandAdaptersConfig(): Partial<Record<import("./command-adapter.ts").CommandAgentKind, import("./command-adapter.ts").StoredCommandAdapterConfig>> {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'command_adapters'").get() as
      | { value: string }
      | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.value);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Partial<Record<import("./command-adapter.ts").CommandAgentKind, import("./command-adapter.ts").StoredCommandAdapterConfig>>;
    } catch {
      return {};
    }
  }

  setCommandAdapterConfig(
    kind: import("./command-adapter.ts").CommandAgentKind,
    config: import("./command-adapter.ts").StoredCommandAdapterConfig | null,
  ): void {
    const current = this.getCommandAdaptersConfig();
    if (config === null) {
      delete current[kind];
    } else {
      current[kind] = config;
    }
    if (Object.keys(current).length === 0) {
      this.db.prepare("DELETE FROM config WHERE key = 'command_adapters'").run();
      return;
    }
    this.db
      .prepare(
        "INSERT INTO config (key, value) VALUES ('command_adapters', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(current));
  }

  /** Stage 3 local-only probes (`~/.otto/probes/<script>`), keyed by `probeName`. */
  getProbesConfig(): Record<string, import("./probes.ts").StoredProbeConfig> {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'local_probes'").get() as
      | { value: string }
      | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.value);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, import("./probes.ts").StoredProbeConfig>;
    } catch {
      return {};
    }
  }

  getProbeConfig(probeName: string): import("./probes.ts").StoredProbeConfig | null {
    const all = this.getProbesConfig();
    return Object.hasOwn(all, probeName) ? (all[probeName] ?? null) : null;
  }

  setProbeConfig(probeName: string, config: import("./probes.ts").StoredProbeConfig | null): void {
    const all = this.getProbesConfig();
    if (config === null) delete all[probeName];
    else all[probeName] = config;
    if (Object.keys(all).length === 0) {
      this.db.prepare("DELETE FROM config WHERE key = 'local_probes'").run();
      return;
    }
    this.db
      .prepare(
        "INSERT INTO config (key, value) VALUES ('local_probes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(all));
  }

  /** Stage 5 machine-local desktop notifications toggle (CLI-only). */
  getDesktopNotifyEnabled(): boolean {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'desktop_notify'").get() as
      | { value: string }
      | undefined;
    return row?.value === "1" || row?.value === "true";
  }

  setDesktopNotifyEnabled(enabled: boolean): void {
    if (!enabled) {
      this.db.prepare("DELETE FROM config WHERE key = 'desktop_notify'").run();
      return;
    }
    this.db
      .prepare(
        "INSERT INTO config (key, value) VALUES ('desktop_notify', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
      )
      .run();
  }

  close(): void {
    this.db.close();
  }

  // --- Repositories (connector-pi.md §8.1; issue #88 git-as-capability) -----------------

  /** Registers a directory's identity + detected capability. A fresh row gets the write
   *  policy default for its capability (worktree/parallel for Git, in-place/serial for
   *  plain); re-registering an existing `repoId` only refreshes identity/capability fields —
   *  the ON CONFLICT clause must never touch isolation/concurrency/approved, or a repo's
   *  local settings would reset every time the connector reconnects and re-registers it. */
  addRepo(repo: { repoId: string; name: string; path: string; capability: RepoCapability }): void {
    const defaultBranch = repo.capability.kind === "git" ? repo.capability.defaultBranch : null;
    const remote = repo.capability.kind === "git" ? repo.capability.remote : null;
    const writePolicy = repo.capability.kind === "git" ? DEFAULT_GIT_WRITE_POLICY : DEFAULT_PLAIN_WRITE_POLICY;
    this.db
      .prepare(
        `INSERT INTO repo (repoId, name, path, kind, defaultBranch, remote, isolation, concurrency, addedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repoId) DO UPDATE SET name = excluded.name, path = excluded.path,
           kind = excluded.kind, defaultBranch = excluded.defaultBranch, remote = excluded.remote`,
      )
      .run(repo.repoId, repo.name, repo.path, repo.capability.kind, defaultBranch, remote, writePolicy.isolation, writePolicy.concurrency, Date.now());
  }

  private toRegisteredRepo(row: RepoRow): RegisteredRepo {
    const hooks: RepoHooksConfig = {
      setupHook: row.setupHook ?? null,
      archiveHook: row.archiveHook ?? null,
      hookApprovedSha256: row.hookApprovedSha256 ?? null,
      hookApprovedAt: row.hookApprovedAt ?? null,
    };
    const base = { repoId: row.repoId, name: row.name, path: row.path, approved: row.approved === 1, hooks };
    const concurrency = row.concurrency as Concurrency; // validated at the one write boundary, setWritePolicy; trusted here
    if (row.kind === "git") {
      return {
        ...base,
        capability: { kind: "git", gitRoot: row.path, defaultBranch: row.defaultBranch, remote: row.remote },
        writePolicy: { isolation: row.isolation as Isolation, concurrency },
      };
    }
    return { ...base, capability: { kind: "plain" }, writePolicy: { isolation: "in-place", concurrency } };
  }

  getRepo(repoId: string): RegisteredRepo | null {
    const row = this.db
      .prepare(
        `SELECT repoId, name, path, kind, defaultBranch, remote, isolation, concurrency, approved,
                setupHook, archiveHook, hookApprovedSha256, hookApprovedAt
         FROM repo WHERE repoId = ?`,
      )
      .get(repoId) as RepoRow | undefined;
    return row ? this.toRegisteredRepo(row) : null;
  }

  listRepos(): RegisteredRepo[] {
    return (
      this.db
        .prepare(
          `SELECT repoId, name, path, kind, defaultBranch, remote, isolation, concurrency, approved,
                  setupHook, archiveHook, hookApprovedSha256, hookApprovedAt
           FROM repo ORDER BY repoId`,
        )
        .all() as unknown as RepoRow[]
    ).map((row) => this.toRegisteredRepo(row));
  }

  /** Updates the local-only write policy (§8.2/§13). False when the repo is unknown; throws
   *  `WritePolicyError` when the requested isolation is `worktree` on a plain (non-Git)
   *  repo — there is no git mechanism to isolate into. */
  setWritePolicy(repoId: string, patch: { isolation?: Isolation; concurrency?: Concurrency }): boolean {
    const repo = this.getRepo(repoId);
    if (!repo) return false;
    const isolation = patch.isolation ?? repo.writePolicy.isolation;
    const concurrency = patch.concurrency ?? repo.writePolicy.concurrency;
    if (isolation === "worktree" && repo.capability.kind !== "git") {
      throw new WritePolicyError(`'${repo.name}' is a plain workspace (no Git); worktree isolation is not available.`);
    }
    this.db.prepare("UPDATE repo SET isolation = ?, concurrency = ? WHERE repoId = ?").run(isolation, concurrency, repoId);
    return true;
  }

  /** Updates the local-only approveProject setting (§13). False when the repo is unknown. */
  setApproved(repoId: string, approved: boolean): boolean {
    if (!this.getRepo(repoId)) return false;
    this.db.prepare("UPDATE repo SET approved = ? WHERE repoId = ?").run(approved ? 1 : 0, repoId);
    return true;
  }

  /** Updates local-only worktree hooks (ADR-0022 Stage 2). Any change to setupHook or
   *  archiveHook clears hookApprovedSha256/hookApprovedAt until `--approve-hooks` runs. */
  setRepoHooks(repoId: string, patch: { setupHook?: string | null; archiveHook?: string | null }): boolean {
    const repo = this.getRepo(repoId);
    if (!repo) return false;
    const setupHook = patch.setupHook !== undefined ? patch.setupHook : repo.hooks.setupHook;
    const archiveHook = patch.archiveHook !== undefined ? patch.archiveHook : repo.hooks.archiveHook;
    if ((setupHook !== null || archiveHook !== null) && repo.capability.kind !== "git") {
      throw new WritePolicyError(`'${repo.name}' is a plain workspace (no Git); worktree hooks are not available.`);
    }
    const changed = setupHook !== repo.hooks.setupHook || archiveHook !== repo.hooks.archiveHook;
    if (changed) {
      this.db
        .prepare(
          "UPDATE repo SET setupHook = ?, archiveHook = ?, hookApprovedSha256 = NULL, hookApprovedAt = NULL WHERE repoId = ?",
        )
        .run(setupHook, archiveHook, repoId);
    }
    return true;
  }

  /** Binds the computed SHA-256 digest of the configured hooks + script bytes. */
  approveRepoHooks(repoId: string, sha256: string, approvedAt = Date.now()): boolean {
    const repo = this.getRepo(repoId);
    if (!repo) return false;
    if (repo.capability.kind !== "git") {
      throw new WritePolicyError(`'${repo.name}' is a plain workspace (no Git); worktree hooks are not available.`);
    }
    if (!repo.hooks.setupHook && !repo.hooks.archiveHook) {
      throw new WritePolicyError(`'${repo.name}' has no worktree hooks configured to approve.`);
    }
    this.db
      .prepare("UPDATE repo SET hookApprovedSha256 = ?, hookApprovedAt = ? WHERE repoId = ?")
      .run(sha256, approvedAt, repoId);
    return true;
  }

  /** Removes all configured worktree hooks and approval state for a repository. */
  clearRepoHooks(repoId: string): boolean {
    if (!this.getRepo(repoId)) return false;
    this.db
      .prepare(
        "UPDATE repo SET setupHook = NULL, archiveHook = NULL, hookApprovedSha256 = NULL, hookApprovedAt = NULL WHERE repoId = ?",
      )
      .run(repoId);
    return true;
  }

  // --- Workers (connector-pi.md §5.1) ----------------------------------------------------

  upsertWorker(worker: WorkerRow): void {
    this.db
      .prepare(
        `INSERT INTO worker (workerId, threadId, repoId, mode, state, sessionId, sessionFile, lastKnownEntryId, branch, worktree, base, agent, lastOutcome, createdAt, updatedAt, requestedModel, modelSource)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET state = excluded.state, sessionId = excluded.sessionId,
           sessionFile = excluded.sessionFile, lastKnownEntryId = excluded.lastKnownEntryId,
           branch = excluded.branch, worktree = excluded.worktree,
           base = excluded.base, lastOutcome = excluded.lastOutcome, updatedAt = excluded.updatedAt`,
      )
      .run(
        worker.workerId,
        worker.threadId,
        worker.repoId,
        worker.mode,
        worker.state,
        worker.sessionId ?? null,
        worker.sessionFile ?? null,
        worker.lastKnownEntryId ?? null,
        worker.branch ?? null,
        worker.worktree ?? null,
        worker.base ?? null,
        worker.agent ?? "pi",
        worker.lastOutcome ?? null,
        worker.createdAt ?? Date.now(),
        Date.now(),
        worker.requestedModel ?? null,
        worker.modelSource ?? 'agent-default',
      );
  }

  getWorker(workerId: string): WorkerRow | null {
    return (
      (this.db
        .prepare(
          `SELECT workerId, threadId, repoId, mode, state, sessionId, sessionFile, lastKnownEntryId, promptAccepted, branch, worktree, base, worktreeCleanedAt, agent, lastOutcome, createdAt, updatedAt, requestedModel, modelSource, launchObservedModel, lastObservedModel
           FROM worker WHERE workerId = ?`,
        )
        .get(workerId) as WorkerRow | undefined) ?? null
    );
  }

  setPromptAccepted(workerId: string, accepted = true): void {
    this.db
      .prepare("UPDATE worker SET promptAccepted = ?, updatedAt = ? WHERE workerId = ?")
      .run(accepted ? 1 : 0, Date.now(), workerId);
  }

  setWorkerSessionId(workerId: string, sessionId: string): void {
    this.db
      .prepare("UPDATE worker SET sessionId = ?, updatedAt = ? WHERE workerId = ?")
      .run(sessionId, Date.now(), workerId);
  }

  setModelObservation(workerId: string, observation: AgentModelObservation, initialLaunch = false): void {
    const json = JSON.stringify(observation);
    this.db.prepare('UPDATE worker SET launchObservedModel = CASE WHEN ? THEN COALESCE(launchObservedModel, ?) ELSE launchObservedModel END, lastObservedModel = ?, updatedAt = ? WHERE workerId = ?').run(initialLaunch ? 1 : 0, json, json, Date.now(), workerId);
  }

  /** §10: refresh the worker's session file and external-activity baseline. */
  setSessionObservation(workerId: string, sessionFile: string, lastKnownEntryId: string | null): void {
    this.db
      .prepare("UPDATE worker SET sessionFile = ?, lastKnownEntryId = ?, updatedAt = ? WHERE workerId = ?")
      .run(sessionFile, lastKnownEntryId, Date.now(), workerId);
  }

  setWorkerState(workerId: string, state: string, lastOutcome?: string): void {
    this.db
      .prepare("UPDATE worker SET state = ?, lastOutcome = COALESCE(?, lastOutcome), updatedAt = ? WHERE workerId = ?")
      .run(state, lastOutcome ?? null, Date.now(), workerId);
  }

  listWorkers(): WorkerRow[] {
    // Creation order (workerId as tiebreak): the serial write queue drains FIFO on it.
    return this.db
      .prepare(
        `SELECT workerId, threadId, repoId, mode, state, sessionId, sessionFile, lastKnownEntryId, promptAccepted, branch, worktree, base, worktreeCleanedAt, agent, lastOutcome, createdAt, updatedAt, requestedModel, modelSource, launchObservedModel, lastObservedModel
         FROM worker ORDER BY createdAt, workerId`,
      )
      .all() as unknown as WorkerRow[];
  }

  /** Drops the worktree/branch columns after cleanup_worktree removed the directory. */
  clearWorkerWorktree(workerId: string): void {
    this.db
      .prepare(
        "UPDATE worker SET worktree = NULL, branch = NULL, base = NULL, worktreeCleanedAt = ?, updatedAt = ? WHERE workerId = ?",
      )
      .run(Date.now(), Date.now(), workerId);
  }

  /** Backfills the worktree columns on a row whose launch aborted around the spawn (PR #43
   * review N3: the stop's settle already wrote state/lastOutcome — this must touch ONLY the
   * worktree columns, never state, or the stop's bookkeeping gets clobbered). */
  setWorkerWorktree(
    workerId: string,
    fields: { worktree: string; branch: string | null; base: string | null },
  ): void {
    this.db
      .prepare(
        "UPDATE worker SET worktree = ?, branch = ?, base = ?, worktreeCleanedAt = NULL, updatedAt = ? WHERE workerId = ?",
      )
      .run(fields.worktree, fields.branch, fields.base, Date.now(), workerId);
  }

  // --- Serial write queue (connector-pi.md §8.2, issue #16) ----------------------------

  saveQueuedStart(workerId: string, commandId: string, args: unknown): void {
    this.db
      .prepare(
        `INSERT INTO queued_start (workerId, commandId, args, queuedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET commandId = excluded.commandId, args = excluded.args, queuedAt = excluded.queuedAt`,
      )
      .run(workerId, commandId, JSON.stringify(args), Date.now());
  }

  getQueuedStart(workerId: string): { commandId: string; args: unknown } | null {
    const row = this.db.prepare("SELECT commandId, args FROM queued_start WHERE workerId = ?").get(workerId) as
      | { commandId: string; args: string }
      | undefined;
    if (!row) return null;
    try {
      return { commandId: row.commandId, args: JSON.parse(row.args) };
    } catch {
      return null;
    }
  }

  deleteQueuedStart(workerId: string): void {
    this.db.prepare("DELETE FROM queued_start WHERE workerId = ?").run(workerId);
  }

  // --- Recovery (connector-pi.md §9) -----------------------------------------------------

  setOrphanSnapshot(workerId: string, refs: ProcRef[]): void {
    this.db
      .prepare(
        `INSERT INTO orphan_snapshot (workerId, refs, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET refs = excluded.refs, updatedAt = excluded.updatedAt`,
      )
      .run(workerId, JSON.stringify(refs), Date.now());
  }

  getOrphanSnapshot(workerId: string): ProcRef[] | null {
    const row = this.db.prepare("SELECT refs FROM orphan_snapshot WHERE workerId = ?").get(workerId) as
      | { refs: string }
      | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.refs) as ProcRef[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  listOrphanSnapshots(): string[] {
    return (this.db.prepare("SELECT workerId FROM orphan_snapshot").all() as Array<{ workerId: string }>).map(
      (r) => r.workerId,
    );
  }

  deleteOrphanSnapshot(workerId: string): void {
    this.db.prepare("DELETE FROM orphan_snapshot WHERE workerId = ?").run(workerId);
  }

  /** Records one resume attempt at `now` and returns the count inside the window, this
   * attempt included — the ≤2/hour budget of §9.2, persisted so a crash mid-recovery
   * (a connector killed between two attempts) cannot reset it. */
  recordResume(workerId: string, windowMs = 3_600_000): number {
    this.db.prepare("INSERT INTO worker_resume (workerId, at) VALUES (?, ?)").run(workerId, Date.now());
    return this.countResumes(workerId, windowMs);
  }

  countResumes(workerId: string, windowMs = 3_600_000): number {
    const { n } = this.db
      .prepare("SELECT COUNT(*) AS n FROM worker_resume WHERE workerId = ? AND at > ?")
      .get(workerId, Date.now() - windowMs) as { n: number };
    return n;
  }

}

/** The raw `repo` table row shape shared by `getRepo`/`listRepos`'s SELECTs. */
interface RepoRow {
  repoId: string;
  name: string;
  path: string;
  kind: string;
  defaultBranch: string | null;
  remote: string | null;
  isolation: string;
  concurrency: string;
  approved: number;
  setupHook: string | null;
  archiveHook: string | null;
  hookApprovedSha256: string | null;
  hookApprovedAt: number | null;
}

interface RegisteredRepoBase {
  readonly repoId: string;
  readonly name: string;
  readonly path: string;
  /** approveProject (§13): run pi with --approve in this repo. Set on the machine only. */
  readonly approved: boolean;
  /** Worktree lifecycle hooks (ADR-0022 Stage 2): local-only, SHA-256 approved. */
  readonly hooks: RepoHooksConfig;
}

/** A registered directory's identity plus its detected Git capability and write policy
 *  (issue #88: Git is optional, detected — not a registration requirement). Narrowing on
 *  `capability.kind` also narrows `writePolicy`'s type: a plain repo can only ever be
 *  `in-place`, so there is no `worktree`+`plain` combination to handle at call sites. */
export type RegisteredRepo =
  | (RegisteredRepoBase & { capability: GitCapability; writePolicy: WritePolicy })
  | (RegisteredRepoBase & { capability: PlainCapability; writePolicy: InPlacePolicy });

export interface WorkerRow {
  workerId: string;
  threadId: string;
  repoId: string;
  mode: string;
  state: string;
  /** Which agent owns the worker (issue #17); 'pi' for rows predating Claude Code. */
  agent?: string | null;
  requestedModel?: string | null;
  modelSource?: 'agent-default' | 'task-default' | 'override';
  /** JSON-encoded trusted CLI observations; never filled from requestedModel. */
  launchObservedModel?: string | null;
  lastObservedModel?: string | null;
  sessionId?: string | null;
  sessionFile?: string | null;
  /** §10: the last session entry id the connector saw (pre-launch external-change baseline). */
  lastKnownEntryId?: string | null;
  /** 1 once at least one prompt was accepted by the underlying CLI/RPC for this workerId. */
  promptAccepted?: number;
  branch?: string | null;
  worktree?: string | null;
  /** The commit-ish the worktree branch started from (§8.2); git-facts input after a restart. */
  base?: string | null;
  /** Set by cleanup_worktree (review finding 5): the worktree is gone on purpose. */
  worktreeCleanedAt?: number | null;
  lastOutcome?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

