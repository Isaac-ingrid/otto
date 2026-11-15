// Connector protocol handling: hello/welcome handshake, command acks/results, event
// ingestion/reduction, and directory browsing/registration (protocol §4.2-4.3, §6.1-6.4,
// §6.6 directory, issues #8/#10/#12/#13/#15/#21/#27). Extracted from steward.ts as part of
// the progressive split (docs/plan/code-quality-and-reliability.md phase 5, sub-batch B).
//
// This module owns the connector-facing message handlers and the directory read state. The
// DO entry points (onMessage role fence, onConnect, onClose, revoke) stay in Steward and
// route parsed frames here. The outbox bottom (enqueue/deliver/resendUnacked/sweepIdle)
// also stays in Steward per the plan — this module calls into it via deps.
import type { Connection } from "agents";
import type { ServerKey } from "@isaac2ingrid/protocol";
import {
  CloseCode,
  CmdAckMessageSchema,
  CmdResultMessageSchema,
  DIRECTORY_BROWSE_TIMEOUT_MS,
  DirectoryListingMessageSchema,
  EventsMessageSchema,
  PROTOCOL_VERSION,
  RegisterRepoResultSchema,
  HelloMessageSchema,
  PingMessageSchema,
  mintToken,
  ulid,
  type CmdResult,
  type DirectoryBrowseResult,
  type DirectoryListing,
  type DirectoryListMessage,
  type EventsAckMessage,
  type ErrorMessage,
  type PongMessage,
  type ResyncMessage,
  type WelcomeMessage,
} from "@isaac2ingrid/protocol";
import { ambiguousWakeText, commandAttentionWakeText, escapeMarkers } from "./wake-text.ts";
import type { Ledger, OutboundDeliveryRow, WorkerRow } from "./ledger.ts";
import type { SqlExecutor } from "./schema.ts";
import type { ConnState, OutboxRow } from "./steward-types.ts";
import { WorkspaceError } from "./workspace.ts";
import type { MachineDirectoryBrowseInput, MachineDirectoryInput, MachineDirectoryResult } from "./workspace-api.ts";

type DirectoryReadResult = DirectoryBrowseResult | { ok: false; code: "machine_offline" | "browse_timeout" };

/** The pr_worker error codes (worker-manager.ts) → the failure card's stages (review
 *  finding 3): lets the failed-cmd_result path keep the stage-specific fix text even when it
 *  wins the race against the classified pr_failed event. */
const PR_ERROR_CODE_TO_STAGE: Readonly<Record<string, string>> = {
  gh_missing: "gh_missing",
  gh_auth: "auth",
  push_rejected: "push",
  pr_create_failed: "create",
};

/** A short, human-readable phrase for what a command asked the worker to do — used in the
 *  ambiguous/not-delivered/in-use notices (issue #15). Reads the stored args defensively. */
function commandInstruction(kind: string, payload: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    // unparsable payload: fall through to the generic label
  }
  if (kind === "send" || kind === "interrupt") {
    const thenText = (args.then as { text?: unknown } | undefined)?.text;
    const text = typeof args.text === "string" ? args.text : typeof thenText === "string" ? thenText : "";
    if (text) return text.slice(0, 60);
  }
  if (kind === "start_worker" && typeof args.prompt === "string") return args.prompt.slice(0, 60);
  if (kind === "resume") return "恢复运行";
  return kind;
}

function versionRangesOverlap(a: { min: number; max: number }, b: { min: number; max: number }): boolean {
  return a.min <= b.max && b.min <= a.max;
}

/** Dependencies the module borrows from the Steward Durable Object. */
export interface ConnectorProtocolDeps {
  sql: SqlExecutor;
  ledger: Ledger;
  serverKeys: () => Promise<ServerKey[]>;
  getConnections: (tag: string) => Iterable<Connection>;
  connFor: (deviceId: string) => Connection | undefined;
  sendError: (connection: Connection, code: ErrorMessage["code"], message: string, re?: string) => void;
  deliver: (cmdId: string, ackTimeoutMs?: number) => boolean;
  enqueue: (deviceId: string, kind: string, args: unknown, opts?: { workerId?: string; notAfter?: number | null; ackTimeoutMs?: number; cmdId?: string; held?: boolean }) => Promise<{ cmdId: string; cseq: number; state: string }>;
  relayWebCmd: (cmdId: string, payload: unknown, terminal: boolean) => void;
  logChannel: (reason: string, detail: string) => void;
  rearmNoticeDrain: () => void;
  drainNotifications: () => Promise<void>;
  drainWakes: () => Promise<void>;
  armWorkerSweeps: () => void;
  armQuestionFallback: () => Promise<void>;
  cancelDirectoryReadsForConnection: (connectionId: string, result: DirectoryReadResult) => void;
  cancelDirectoryReadsForDevice: (deviceId: string, result: DirectoryReadResult) => void;
}

/**
 * Connector protocol handling: the hello/welcome handshake, command acks/results, event
 * ingestion and reduction, and directory browsing/registration. Owns the in-flight directory
 * read map and the browse timeout.
 */
export class ConnectorProtocol {
  private directoryBrowseTimeoutMs = DIRECTORY_BROWSE_TIMEOUT_MS;
  private readonly directoryReads = new Map<string, {
    deviceId: string;
    connectionId: string;
    finish(result: DirectoryReadResult): void;
  }>();

  constructor(private readonly deps: ConnectorProtocolDeps) {}

  private get sql(): SqlExecutor { return this.deps.sql; }

  // Tests shrink the browse timeout.
  setDirectoryBrowseTimeoutForTest(ms: number): void { this.directoryBrowseTimeoutMs = ms; }

  handlePing(connection: Connection, raw: unknown): void {
    const parsed = PingMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    connection.send(JSON.stringify({ t: "pong", re: parsed.data.id } satisfies PongMessage));
  }

  async handleHello(connection: Connection, raw: unknown): Promise<void> {
    const parsedHello = HelloMessageSchema.safeParse(raw);
    if (!parsedHello.success) {
      this.deps.sendError(connection, "bad_request", "invalid hello");
      return;
    }
    const hello = parsedHello.data;
    if (!versionRangesOverlap(hello.protocol, PROTOCOL_VERSION)) {
      connection.close(CloseCode.VERSION_MISMATCH, `supported ${PROTOCOL_VERSION.min}-${PROTOCOL_VERSION.max}`);
      return;
    }
    const auth = connection.state as unknown as ConnState | null;
    if (!auth?.deviceId || auth.deviceId !== hello.deviceId) {
      connection.close(CloseCode.UNAUTHORIZED, "device mismatch");
      return;
    }
    for (const other of this.deps.getConnections(`dev:${auth.deviceId}`)) {
      if (other.id === connection.id) continue;
      const otherEpoch = (other.state as unknown as ConnState | null)?.connEpoch ?? -1;
      if (hello.connEpoch <= otherEpoch) {
        connection.close(CloseCode.SUPERSEDED, "superseded by an existing connection");
        return;
      }
      other.close(CloseCode.SUPERSEDED, "superseded by a newer connection");
      this.deps.cancelDirectoryReadsForConnection(other.id, { ok: false, code: "machine_offline" });
    }
    connection.setState({ deviceId: auth.deviceId, epoch: auth.epoch, keyId: auth.keyId, connEpoch: hello.connEpoch, directoryBrowse: hello.capabilities?.directoryBrowse === true } satisfies ConnState);
    // hello is the machine/repo snapshot's source of truth (protocol §6.1, steward.md §2.2):
    // name, agents, limits, and the full repo list — removals included — land in the ledger.
    this.deps.ledger.machines.upsertFromHello(hello);
    this.deps.rearmNoticeDrain();
    const acks = Object.fromEntries(
      this.sql<{ workerId: string; upTo: number }>`SELECT workerId, upTo FROM worker_ack`.map((row) => [row.workerId, row.upTo]),
    );
    // SERVER_KEY rotation (issue #27): the connection authenticated with a non-primary key —
    // hand the connector a fresh primary-key token so it can rekey without re-pairing. The
    // connector persists it for reconnects; once every machine has reconnected once, the
    // operator can drop SERVER_KEY_PREVIOUS.
    const [primary] = await this.deps.serverKeys();
    const rotatedToken = primary && auth.keyId !== primary.id ? await mintToken(primary, auth.deviceId, auth.epoch) : undefined;
    const welcome: WelcomeMessage = {
      t: "welcome",
      re: hello.id,
      protocol: PROTOCOL_VERSION.max,
      serverTime: Date.now(),
      sessionId: ulid(),
      acks,
      limits: { maxMessageBytes: 262144, batchMs: 250, batchEvents: 50 },
      ...(rotatedToken ? { token: rotatedToken } : {}),
    };
    connection.send(JSON.stringify(welcome));
    // Reconciliation (protocol §6.1): the connector reports the states of commands that never
    // settled (e.g. `ambiguous` after a crash mid-sending). Settle the matching outbox rows;
    // ambiguous rows are never re-delivered (§4.2) — the steward is woken to ask (issue #15).
    for (const pending of hello.pendingAcks) {
      const command = this.sql<{ deviceId: string }>`SELECT deviceId FROM outbox WHERE cmdId = ${pending.cmdId}`[0];
      if (command?.deviceId !== auth.deviceId) continue;
      if (pending.state === "ambiguous") {
        // pr_worker rows route to the consent gate's own deterministic answer inside
        // (issue #21); every other kind gets #15's wake-to-ask.
        this.markCommandAmbiguous(pending.cmdId, "hello.pendingAcks");
      } else if (pending.state === "done" || pending.state === "failed") {
        // The connector resolved the command from session-tail evidence before connecting:
        // settle the row from the snapshot (its stored result rode hello as a duplicate-ack
        // payload; here the state is what matters). A recovered not_delivered surfaces like
        // any delivery failure — except start_worker, whose worker-break event (emitted by
        // the connector's own §9.1 reconciliation) already tells the user.
        this.sql`
          UPDATE outbox SET state = ${pending.state}
          WHERE cmdId = ${pending.cmdId} AND state NOT IN ('done', 'failed', 'expired', 'ambiguous')
        `;
        const changed = this.sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
        if (changed && pending.state === "failed" && pending.code === "not_delivered") {
          const row = this.sql<{ workerId: string | null; kind: string }>`
            SELECT workerId, kind FROM outbox WHERE cmdId = ${pending.cmdId}
          `[0];
          if (row?.workerId && row.kind !== "start_worker") {
            this.noteCommandAttention(pending.cmdId, "not_delivered", "connector restarted before the command reached the agent");
          }
        }
      }
    }
    // protocol §6.1: hello re-delivers every queued/sent command; "waited" start_workers
    // (their notAfter cleared by the owner's wait) are queued for exactly this moment.
    const before = new Set(
      this.sql<{ cmdId: string }>`
        SELECT cmdId FROM outbox WHERE deviceId = ${auth.deviceId} AND state = 'queued' AND kind = 'start_worker' AND held = 0 AND notAfter IS NULL
      `.map((r) => r.cmdId),
    );
    this.redeliverOutbox(auth.deviceId);
    this.queueWaitedStartNotices(auth.deviceId, before);
    // A reconnect is also the natural catch-up point for events persisted but not yet reduced
    // (crash between the events_ack and the reducer, protocol §4.3): drain, then notify.
    this.applyLedgerEvents();
    // Reconciliation against hello.workers (issue #12, connector-pi.md §9.1 step 4): with the
    // pending events drained first, the gate inside (lastSeq <= processedUpTo) means this only
    // fires for workers whose event stream cannot tell the story anymore. Timeline, no push.
    this.deps.ledger.workers.reconcileFromSnapshot(auth.deviceId, hello.workers);
    // Review finding 4 (issue #10): a snapshot-only broken verdict (a caught-up inbox — the
    // exact case reconciliation exists for) queues a failure push and a wake that the
    // applied>0-gated drains above never see. Reconcile-side effects drain unconditionally.
    void this.deps.drainNotifications();
    void this.deps.drainWakes();
    // The machine is back (or fresh workers appeared): the maintenance alarm must be live
    // for whatever is running now (issue #13).
    this.deps.armWorkerSweeps();
  }

  // protocol §4.2 + ADR-0001 (spike bug 10): hello redelivers queued, sent, AND
  // ack-timeout-failed commands — a silently-dead downlink must not permanently lose a
  // command just because its ack deadline happened to expire before the reconnect.
  private redeliverOutbox(deviceId: string): void {
    this.sql`
      UPDATE outbox SET state = 'queued', attempts = 0, failReason = NULL
      WHERE deviceId = ${deviceId} AND state = 'failed' AND failReason = 'ack_timeout'
    `;
    const pending = this.sql<{ cmdId: string }>`
      SELECT cmdId FROM outbox WHERE deviceId = ${deviceId} AND state IN ('queued', 'sent') ORDER BY cseq
    `;
    for (const row of pending) this.deps.deliver(row.cmdId);
  }

  /** The "runs on reconnect with a notice" half of protocol §7.3: a start_worker whose
   *  notAfter the owner's wait cleared was queued only for the machine's return — its
   *  delivery at this hello is exactly the promised moment, so the notice follows it out. */
  private queueWaitedStartNotices(deviceId: string, before: Set<string>): void {
    const delivered = this.sql<{ cmdId: string; workerId: string }>`
      SELECT cmdId, workerId FROM outbox WHERE deviceId = ${deviceId} AND state = 'sent' AND kind = 'start_worker' AND held = 0
    `;
    for (const row of delivered) {
      if (!before.has(row.cmdId)) continue;
      const worker = this.deps.ledger.workers.get(row.workerId);
      if (!worker || worker.state !== "starting") continue;
      this.deps.ledger.notifications.queue(`waited:${row.cmdId}`, "waited_started", worker.threadId, worker.workerId);
    }
    void this.deps.drainNotifications();
  }

  handleCmdAck(deviceId: string | undefined, raw: unknown): void {
    const parsed = CmdAckMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const ack = parsed.data;
    const row = this.sql<OutboxRow>`SELECT * FROM outbox WHERE cmdId = ${ack.re}`[0];
    if (!row || row.deviceId !== deviceId) return;
    if (ack.status === "accepted") {
      this.sql`UPDATE outbox SET state = 'accepted' WHERE cmdId = ${ack.re} AND state IN ('sent', 'queued')`;
      this.deps.relayWebCmd(ack.re, ack, false);
    } else if (ack.status === "duplicate") {
      if (ack.result) {
        if (row.kind === "register_repo") return this.settleDirectoryRegistration(row, ack.result);
        this.sql`
          UPDATE outbox SET state = ${ack.result.ok ? "done" : "failed"}, result = ${JSON.stringify(ack.result)}
          WHERE cmdId = ${ack.re}
        `;
        this.deps.relayWebCmd(ack.re, ack, true);
      } else {
        this.sql`UPDATE outbox SET state = 'accepted' WHERE cmdId = ${ack.re} AND state IN ('sent', 'queued')`;
        this.deps.relayWebCmd(ack.re, ack, false);
      }
    } else if (ack.status === "rejected") {
      if (row.kind === "register_repo") return this.settleDirectoryRegistration(row, { ok: false, error: { code: ack.code ?? "registration_failed" } });
      this.sql`
        UPDATE outbox SET state = 'failed', failReason = 'rejected', result = ${JSON.stringify({ code: ack.code ?? null })}
        WHERE cmdId = ${ack.re}
      `;
      this.noteCommandFailure(ack.re, `连接器拒绝（${ack.code ?? "未知原因"}）`);
      this.deps.relayWebCmd(ack.re, ack, true);
    } else if (ack.status === "ambiguous") {
      // protocol §4.2: a crash during `sending`, undecidable — no automatic re-send. The row
      // is marked ambiguous; #15 wakes the steward to ask, except pr_worker rows, which the
      // consent gate answers deterministically (issue #21).
      this.markCommandAmbiguous(ack.re, "cmd_ack");
      this.deps.relayWebCmd(ack.re, ack, true);
    }
  }

  handleCmdResult(deviceId: string | undefined, raw: unknown): void {
    const parsed = CmdResultMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const result = parsed.data;
    const command = this.sql<OutboxRow>`SELECT * FROM outbox WHERE cmdId = ${result.re}`[0];
    if (!command || command.deviceId !== deviceId) return;
    if (command.kind === "register_repo") return this.settleDirectoryRegistration(command, result);
    const wasFailed = this.sql<{ state: string }>`SELECT state FROM outbox WHERE cmdId = ${result.re}`[0]?.state === "failed";
    this.sql`
      UPDATE outbox SET state = ${result.ok ? "done" : "failed"}, result = ${JSON.stringify(result.ok ? result.data ?? null : result.error ?? null)}
      WHERE cmdId = ${result.re}
    `;
    this.deps.relayWebCmd(result.re, result, true);
    if (result.ok) {
      // Review finding 4 (#57): a pr_worker settles with the URL even when its pr_created
      // event was lost (the connector's emit raced a shutdown). This backstop delivers the
      // card from the command result; idempotent against the event path — whichever lands
      // first wins, the other no-ops on the already-set url (so redeliveries are free).
      const row = this.sql<{ workerId: string | null; kind: string }>`
        SELECT workerId, kind FROM outbox WHERE cmdId = ${result.re}
      `[0];
      const data = (result.data ?? {}) as { url?: unknown; branch?: unknown };
      if (row?.kind === "pr_worker" && row.workerId && typeof data.url === "string" && data.url !== "") {
        if (this.deps.ledger.prConsent.settleFromCommand(result.re, data.url, typeof data.branch === "string" ? data.branch : "")) {
          void this.deps.drainNotifications();
        }
      }
      return;
    }
    if (!wasFailed) {
      const error = (result.error ?? {}) as { code?: unknown; message?: unknown };
      const reason = [typeof error.code === "string" ? error.code : null, typeof error.message === "string" ? error.message : null]
        .filter((part): part is string => part !== null)
        .join("：") || "未知原因";
      this.noteCommandFailure(result.re, reason);
      // Issue #15: two failure classes carry their own user-facing story — a session the
      // owner is using at the keyboard (§10), and an instruction the connector provably
      // never delivered (§6.3 recovery). Both land on the timeline and wake the steward;
      // the ordinary tool says the delivery happened, so silence would mislead.
      const code = typeof error.code === "string" ? error.code : null;
      if (code === "session_in_use" || code === "not_delivered") {
        this.noteCommandAttention(result.re, code, typeof error.message === "string" ? error.message : "");
      }
    }
  }

  private settleDirectoryRegistration(row: OutboxRow, result: CmdResult): void {
    if (row.state === "done" || row.state === "expired" || row.state === "ambiguous" || (row.state === "failed" && row.failReason !== "ack_timeout")) return;
    const parsed = RegisterRepoResultSchema.safeParse(result.data);
    if (result.ok && parsed.success) {
      this.deps.ledger.repos.recordRegistration(row.deviceId, parsed.data.repo);
      this.sql`UPDATE outbox SET state = 'done', result = ${JSON.stringify(parsed.data)}, failReason = NULL WHERE cmdId = ${row.cmdId}`;
    } else {
      const error = result.error;
      const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "registration_failed";
      this.sql`UPDATE outbox SET state = 'failed', result = ${JSON.stringify({ code })}, failReason = 'registration_failed' WHERE cmdId = ${row.cmdId}`;
    }
  }

  /** A delivery-class failure the user should hear about even without the LLM's help: a
   *  deterministic timeline note plus a wake (the steward relays/asks). Idempotent on the
   *  cmdId through the wake's dedupeKey. */
  private noteCommandAttention(cmdId: string, code: string, message: string): void {
    const row = this.sql<{ workerId: string | null; kind: string; payload: string }>`
      SELECT workerId, kind, payload FROM outbox WHERE cmdId = ${cmdId}
    `[0];
    if (!row || !row.workerId) return;
    const worker = this.deps.ledger.workers.get(row.workerId);
    if (!worker) return;
    const instruction = commandInstruction(row.kind, row.payload);
    // The instruction is model- or user-authored text: marker-escape it everywhere it is
    // embedded (the ⟦…⟧ policy every wake builder follows — review #48 finding 5).
    const safe = escapeMarkers(instruction);
    const text =
      code === "session_in_use"
        ? `「${safe}」没有送达：这个会话此刻正被机器上的另一个 pi 进程使用（可能是本人在键盘上继续）。`
        : `「${safe}」没有送达：连接器在投递前重启了，worker 从未收到这条指令。`;
    this.deps.ledger.timeline.add(worker.threadId, "note", text, { cmdId, workerId: row.workerId, code });
    this.deps.ledger.wakes.queue(
      "event",
      `attention:${cmdId}`,
      commandAttentionWakeText({
        threadId: worker.threadId,
        workerId: worker.workerId,
        kind: row.kind,
        instruction: safe,
        code,
        detail: text,
      }),
      { priority: "high" },
    );
    void this.deps.drainWakes();
  }

  // A start_worker the connector could not run: the worker lands `broken`, the failure reaches
  // the timeline + the user deterministically (there is no LLM to relay it in M1). Idempotent
  // on the cmdId — cmd_result redeliveries re-run this handler. `stageHint` (issue #21) lets
  // callers without a settled result pick the pr_failed card's stage (the idle sweep's
  // timeout is a *delivery* failure, not an execution one).
  noteCommandFailure(cmdId: string, reason: string, stageHint?: string): void {
    const row = this.sql<{ workerId: string | null; kind: string }>`
      SELECT workerId, kind FROM outbox WHERE cmdId = ${cmdId}
    `[0];
    if (!row || !row.workerId) return;
    // A failed resume send (issue #8): revert the resume-pending `starting` back to idle —
    // the session itself is intact — and push the failure to the user.
    if (row.kind === "send" && this.deps.ledger.workers.markResumeFailed(row.workerId, cmdId, reason)) {
      void this.deps.drainNotifications();
      return;
    }
    // A pr_worker that never succeeded (issue #21): the connector's own failures arrive as
    // pr_failed events (which call the same sink — the first one wins, no double card); this
    // path covers rejections at the door and results the event stream already reported.
    if (row.kind === "pr_worker") {
      // Review finding 3: the result's error code carries the connector's classification —
      // map it back so the card keeps the stage-specific fix even when this path wins the
      // race against the pr_failed event (fail() dedupes whichever lands second).
      const resultRaw = this.sql<{ result: string | null }>`SELECT result FROM outbox WHERE cmdId = ${cmdId}`[0]?.result;
      let code: string | null = null;
      let message: string | null = null;
      try {
        const parsed = resultRaw ? (JSON.parse(resultRaw) as { code?: unknown; message?: unknown }) : null;
        if (typeof parsed?.code === "string") code = parsed.code;
        if (typeof parsed?.message === "string" && parsed.message !== "") message = parsed.message;
      } catch {
        // result unreadable — the generic reason stands
      }
      const stage = stageHint ?? PR_ERROR_CODE_TO_STAGE[code ?? ""] ?? "command";
      if (this.deps.ledger.prConsent.fail({ workerId: row.workerId, cmdId, stage, message: message ?? reason })) {
        void this.deps.drainNotifications();
      }
      return;
    }
    if (row.kind !== "start_worker") return;
    if (this.deps.ledger.workers.markStartFailed(row.workerId, cmdId, reason)) {
      void this.deps.drainNotifications();
    }
  }

  /** Issue #15 / protocol §4.2: the connector reported a command `ambiguous` (a crash during
   *  `sending` — delivery unknowable). Mark the outbox row ambiguous (never re-sent) and wake
   *  the steward to ask the user; idempotent on the cmdId via the wake's dedupeKey.
   *  Exception: a pr_worker routes to the consent gate's own deterministic answer (issue #21,
   *  review finding 2) — an "ask the user" wake would only second-guess the card that already
   *  tells them exactly what to do (check the repo, re-tap to retry). */
  markCommandAmbiguous(cmdId: string, via: string): void {
    // Idempotency gate: the wake/note fire only when this call actually transitioned the
    // row (duplicate cmd_acks and repeated hellos find it already ambiguous).
    this.sql`
      UPDATE outbox SET state = 'ambiguous' WHERE cmdId = ${cmdId} AND state NOT IN ('done', 'failed', 'expired', 'ambiguous')
    `;
    const changed = this.sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    if (!changed) return;
    const row = this.sql<{ workerId: string | null; kind: string; payload: string }>`
      SELECT workerId, kind, payload FROM outbox WHERE cmdId = ${cmdId}
    `[0];
    if (!row || !row.workerId) return;
    if (row.kind === "pr_worker") {
      this.markPrWorkerAmbiguous(row.workerId, cmdId);
      return;
    }
    const worker = this.deps.ledger.workers.get(row.workerId);
    if (!worker) return;
    const instruction = escapeMarkers(commandInstruction(row.kind, row.payload));
    this.deps.ledger.timeline.add(
      worker.threadId,
      "note",
      `命令结果不确定（${via}）：连接器在投递「${instruction}」时崩溃，无法判断 worker 是否已收到。不会自动重发。`,
      { cmdId, workerId: row.workerId, ambiguous: true },
    );
    this.deps.ledger.wakes.queue(
      "event",
      `ambiguous:${cmdId}`,
      ambiguousWakeText({ thread: this.deps.ledger.threads.get(worker.threadId), worker, cmdId, kind: row.kind, instruction }),
      { priority: "high" },
    );
    void this.deps.drainWakes();
  }

  /**
   * The consent gate's ambiguous answer (issue #21, review finding 2 of #57): an ambiguous
   * pr_worker must not wedge the consent row in "in flight" forever. The outcome is
   * undecidable — the PR may or may not exist — which is itself an answer the owner needs;
   * a later replayed pr_created (persist-first §11.3) heals the row with the URL. fail() is
   * idempotent, so the duplicate hello/pendingAck redeliveries are free.
   */
  private markPrWorkerAmbiguous(workerId: string, cmdId: string): void {
    if (
      this.deps.ledger.prConsent.fail({
        workerId,
        cmdId,
        stage: "ambiguous",
        message: "连接器在执行中途失联，PR 是否已创建无法确定",
      })
    ) {
      void this.deps.drainNotifications();
    }
  }

  handleEvents(connection: Connection, raw: unknown): void {
    const parsed = EventsMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.sendError(connection, "bad_request", "invalid events");
      return;
    }
    const touched = new Set<string>();
    for (const event of parsed.data.batch) {
      const exists = this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${event.workerId} AND seq = ${event.seq}
      `[0]!.n;
      if (!exists) {
        this.sql`
          INSERT INTO event_inbox (workerId, seq, payload, receivedAt) VALUES (${event.workerId}, ${event.seq}, ${JSON.stringify(event)}, ${Date.now()})
        `;
      }
      touched.add(event.workerId);
    }
    for (const workerId of touched) {
      this.sql`INSERT OR IGNORE INTO worker_ack (workerId, upTo) VALUES (${workerId}, 0)`;
      // advance the cumulative ack through every contiguous seq already received
      for (;;) {
        const upTo = this.sql<{ upTo: number }>`SELECT upTo FROM worker_ack WHERE workerId = ${workerId}`[0]!.upTo;
        const hasNext = this.sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId} AND seq = ${upTo + 1}
        `[0]!.n;
        if (!hasNext) break;
        this.sql`UPDATE worker_ack SET upTo = ${upTo + 1} WHERE workerId = ${workerId}`;
      }
      const upTo = this.sql<{ upTo: number }>`SELECT upTo FROM worker_ack WHERE workerId = ${workerId}`[0]!.upTo;
      connection.send(JSON.stringify({ t: "events_ack", workerId, upTo } satisfies EventsAckMessage));
      const gapCount = this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId} AND seq > ${upTo + 1}
      `[0]!.n;
      if (gapCount > 0) {
        connection.send(JSON.stringify({ t: "resync", workerId, from: upTo + 1 } satisfies ResyncMessage));
      }
    }
    // Persisted and acked above; now reduce into the ledger (protocol §4.3 keeps the two
    // decoupled — a crash here leaves the rows pending for the next wake's catch-up).
    this.applyLedgerEvents();
  }

  /** Reduces everything pending, then turns notification intents into outbound cards (§5.1). */
  applyLedgerEvents(): void {
    try {
      const { applied } = this.deps.ledger.applyPendingEvents();
      if (applied > 0) {
        // Events catching up can release a parked hello-snapshot verdict for a reaped
        // worker (issue #13 review finding 2) — resolve before anything reads the state.
        this.deps.ledger.workers.resolveReapPending();
        // Any applied event can start a run (started/resumed) or end one (settled/lost) —
        // the maintenance alarm follows suit (issue #13).
        this.deps.armWorkerSweeps();
        // And a question window may have opened (§5.3, issue #10): the fallback alarm
        // follows the deadlines the reducer just wrote.
        void this.deps.armQuestionFallback();
        void this.deps.drainNotifications();
        // The reducer may have queued wake_requests (§5.1 step 4): drain what is already due
        // (the 3-second merge window keeps fresh rows waiting for their siblings) and arm the
        // alarm for the rest.
        void this.deps.drainWakes();
      }
    } catch (err) {
      this.deps.logChannel("ledger_apply_failed", err instanceof Error ? err.message : String(err));
    }
  }

  // ---- Directory browsing and registration (§6.6 directory) -------------------------------------

  browseMachineDirectory(input: MachineDirectoryBrowseInput, signal: AbortSignal): Promise<DirectoryListing> {
    const device = this.sql<{ revoked: number }>`SELECT revoked FROM device WHERE deviceId = ${input.deviceId}`[0];
    if (!device || device.revoked) throw new WorkspaceError("not_found", 404);
    const connection = this.deps.connFor(input.deviceId);
    if (!connection) throw new WorkspaceError("machine_offline", 409);
    const connectionState = connection.state as ConnState | null;
    if (!connectionState?.directoryBrowse) throw new WorkspaceError("unsupported", 409);
    if (this.directoryReads.size >= 32) throw new WorkspaceError("busy", 429);
    const id = ulid();
    return new Promise((resolve, reject) => {
      const finish = (result: DirectoryReadResult) => {
        if (!this.directoryReads.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (result.ok) resolve(result.listing);
        else {
          const status = { not_found: 404, forbidden: 403, invalid_directory: 400, unsupported: 409, machine_offline: 409, busy: 429, browse_timeout: 504, browse_failed: 502 }[result.code];
          reject(new WorkspaceError(result.code, status));
        }
      };
      const abort = () => finish({ ok: false, code: "browse_failed" });
      const timer = setTimeout(() => finish({ ok: false, code: "browse_timeout" }), this.directoryBrowseTimeoutMs);
      this.directoryReads.set(id, { deviceId: input.deviceId, connectionId: connection.id, finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      const { deviceId: _, ...args } = input;
      try {
        connection.send(JSON.stringify({ t: "directory_list", id, ...args } satisfies DirectoryListMessage));
      } catch {
        finish({ ok: false, code: "machine_offline" });
      }
    });
  }

  handleDirectoryListing(connection: Connection, raw: unknown): void {
    if (raw === null || typeof raw !== "object" || !("re" in raw) || typeof raw.re !== "string") return;
    const pending = this.directoryReads.get(raw.re);
    const state = connection.state as ConnState | null;
    if (!pending || pending.connectionId !== connection.id || pending.deviceId !== state?.deviceId) return;
    const parsed = DirectoryListingMessageSchema.safeParse(raw);
    pending.finish(parsed.success ? parsed.data : { ok: false, code: "browse_failed" });
  }

  async addMachineDirectory(input: MachineDirectoryInput): Promise<MachineDirectoryResult> {
    const cmdId = `web-directory:${input.id}`;
    const payload = JSON.stringify({ path: input.path });
    const previous = this.sql<OutboxRow>`SELECT * FROM outbox WHERE cmdId = ${cmdId}`[0];
    if (previous && (previous.deviceId !== input.deviceId || previous.kind !== "register_repo" || previous.payload !== payload)) {
      throw new WorkspaceError("id_conflict", 409);
    }
    const device = this.sql<{ revoked: number }>`SELECT revoked FROM device WHERE deviceId = ${input.deviceId}`[0];
    if (!device || device.revoked) throw new WorkspaceError("not_found", 404);
    if (!previous) {
      if (!this.deps.connFor(input.deviceId)) throw new WorkspaceError("machine_offline", 409);
      await this.deps.enqueue(input.deviceId, "register_repo", { path: input.path }, { cmdId, notAfter: Date.now() + 120_000 });
      this.deps.logChannel("web_directory_requested", input.deviceId);
    }
    const row = this.sql<OutboxRow>`SELECT * FROM outbox WHERE cmdId = ${cmdId}`[0]!;
    const stored: unknown = row.result ? JSON.parse(row.result) : null;
    if (row.state === "done") {
      const parsed = RegisterRepoResultSchema.safeParse(stored);
      return parsed.success ? { state: "done", id: input.id, repo: parsed.data.repo } : { state: "failed", id: input.id, code: "registration_failed" };
    }
    if (row.failReason === "not_after") return { state: "failed", id: input.id, code: "outcome_unknown" };
    if (row.state === "failed" && row.failReason !== "ack_timeout") {
      const code = stored !== null && typeof stored === "object" && "code" in stored && typeof stored.code === "string" ? stored.code : "registration_failed";
      return { state: "failed", id: input.id, code };
    }
    if (row.state === "ambiguous" || row.state === "expired" || (row.notAfter !== null && row.notAfter <= Date.now())) {
      return { state: "failed", id: input.id, code: "outcome_unknown" };
    }
    return { state: "pending", id: input.id };
  }

  // ---- Connection lifecycle cleanup hooks --------------------------------------------------------

  /** Cancel directory reads whose connection is closing or device is going offline. */
  cancelReadsForConnection(connectionId: string, result: DirectoryReadResult): void {
    for (const pending of this.directoryReads.values()) {
      if (pending.connectionId === connectionId) pending.finish(result);
    }
  }

  cancelReadsForDevice(deviceId: string, result: DirectoryReadResult): void {
    for (const pending of this.directoryReads.values()) {
      if (pending.deviceId === deviceId) pending.finish(result);
    }
  }
}
