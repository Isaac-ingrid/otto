// History relay, thread subscriptions and web-direct worker commands (protocol §6.6,
// §6.8, issue #1/#23/#84, ADR-0011). Extracted from steward.ts as part of the progressive
// split (docs/plan/code-quality-and-reliability.md phase 5, sub-batch A).
//
// The DO is a pure pipe for history pulls: ids and byte meters in SQLite, content only ever
// in memory between the two sockets. Nothing here logs or persists entry text.
//
// Thread subscriptions (issue #1): browsers follow one Thread's timeline via a cursor on
// the connection state; `pushThreadSubscriptions` drains what is new to every watcher.
//
// Web-direct worker commands (issue #84, §6.8): mechanical send/interrupt through the
// Dispatcher, with a relay row so the real cmd_ack/cmd_result finds its way back.
import type { Connection } from "agents";
import {
  HISTORY_MAX_BYTES,
  HistoryAckMessageSchema,
  HistoryChunkMessageSchema,
  HistoryOpenMessageSchema,
  SubscribeMessageSchema,
  SubscribeThreadMessageSchema,
  UnsubscribeMessageSchema,
  UnsubscribeThreadMessageSchema,
  WorkerCmdMessageSchema,
  ulid,
  type ErrorMessage,
  type HistoryReqMessage,
  type MachineOfflineMessage,
} from "@isaac2ingrid/protocol";
import type { SendToWorkerInput, SendToWorkerOutcome, InterruptWorkerInput, InterruptWorkerOutcome } from "./dispatch.ts";
import type { Ledger, TimelineRow } from "./ledger.ts";
import type { SqlExecutor } from "./schema.ts";

/** Connection state shared between Steward and this module. Set on browser connections by
 *  `subscribe` / `subscribe_thread`; connector connections carry deviceId. */
export interface ConnState {
  /** Set on browser connections (the L3 stream and workspace consumers); connector connections carry deviceId. */
  role?: "web";
  /** Set on workspace connections: the session that opened them (signing out closes them). */
  sid?: string;
  expiresAt?: number;
  deviceId: string;
  epoch: number;
  /** Key that authenticated the connection (issue #27): ≠ primary ⇒ welcome rekeys. */
  keyId: string;
  connEpoch?: number;
  directoryBrowse?: boolean;
  workerDiff?: boolean;
  workerCheckpoint?: boolean;
  repoSkills?: boolean;
  worktreeAudit?: boolean;
  localProbes?: boolean;
  gitPrDiff?: boolean;
  /** Set on a browser connection by `subscribe` (issue #84, §6.8): the one worker session
   *  view it currently has open, and the only `workerId` it may send `worker_cmd` to. */
  viewingWorkerId?: string;
  /** Set by `subscribe_thread` (issue #1): the Thread whose timeline this connection follows,
   *  with the last `sh_timeline.id` it has been sent — the resume cursor. Both are dropped by
   *  `unsubscribe_thread`, and a re-subscribe rebuilds them from the watcher's `after`. */
  viewingThreadId?: string;
  threadCursor?: number;
  /** The last `thread_state` frame sent on this subscription: an unchanged state is not resent. */
  threadStateSig?: string;
}

const THREAD_PAGE = 200;

function jsonByteLength(value: unknown): number {
  // JSON.stringify of a string value includes the quotes; for a raw WS frame the connector
  // already sent, that is the on-the-wire body size (§6.6 byte metering).
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

/** Dependencies the module borrows from the Steward Durable Object. */
export interface HistorySubscriptionDeps {
  sql: SqlExecutor;
  ledger: Ledger;
  getConnection: (id: string) => Connection | undefined;
  getConnections: (tag: string) => Iterable<Connection>;
  connFor: (deviceId: string) => Connection | undefined;
  webConnectionAlive: (connection: Connection) => boolean;
  sendError: (connection: Connection, code: ErrorMessage["code"], message: string, re?: string) => void;
  schedule: (delayS: number, callback: string) => void;
  historyRelayTtlMs: () => number;
  notifyWorkspaces: () => void;
  sendToWorker: (input: SendToWorkerInput) => Promise<SendToWorkerOutcome>;
  interruptWorker: (input: InterruptWorkerInput) => Promise<InterruptWorkerOutcome>;
}

/**
 * History relay (§6.6), thread subscriptions (issue #1) and web-direct worker commands
 * (§6.8). All relay state (history_relay, web_cmd_relay) is in SQLite; this module owns the
 * `relaySweepAt` memo that deduplicates alarm scheduling.
 */
export class HistorySubscriptions {
  private relaySweepAt = 0;

  constructor(private readonly deps: HistorySubscriptionDeps) {}

  private get sql(): SqlExecutor { return this.deps.sql; }

  // ---- History relay (protocol §6.6, issue #23) ---------------------------------------------------

  private armRelaySweep(): void {
    const delayS = Math.max(1, Math.ceil(this.deps.historyRelayTtlMs() / 1000));
    const fireAt = Date.now() + delayS * 1000;
    if (this.relaySweepAt !== 0 && this.relaySweepAt <= fireAt) return; // an earlier sweep is already coming
    this.relaySweepAt = fireAt;
    void this.deps.schedule(delayS, "sweepHistoryRelays");
  }

  /** browser → DO: resolve the worker, refuse offline machines, then ask the connector. */
  handleHistoryOpen(connection: Connection, raw: unknown): void {
    const parsed = HistoryOpenMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.sendError(connection, "bad_request", "invalid history_open");
      return;
    }
    const open = parsed.data;
    const worker = this.deps.ledger.workers.get(open.workerId);
    if (!worker) {
      this.deps.sendError(connection, "not_found", `worker ${open.workerId} is unknown`, open.id);
      return;
    }
    const deviceConn = this.deps.connFor(worker.deviceId);
    if (!deviceConn) {
      // §6.6: offline is answered directly — the transcript lives on that machine only.
      connection.send(JSON.stringify({ t: "machine_offline", re: open.id } satisfies MachineOfflineMessage));
      return;
    }
    const reqId = ulid();
    const maxBytes = Math.min(open.maxBytes ?? HISTORY_MAX_BYTES, HISTORY_MAX_BYTES);
    const now = Date.now();
    // One live stream per browser connection — a re-open supersedes the previous one.
    this.sql`DELETE FROM history_relay WHERE webConnId = ${connection.id}`;
    this.sql`
      INSERT INTO history_relay (reqId, webConnId, workerId, deviceId, maxBytes, sentBytes, expiresAt, createdAt)
      VALUES (${reqId}, ${connection.id}, ${open.workerId}, ${worker.deviceId}, ${maxBytes}, 0, ${now + this.deps.historyRelayTtlMs()}, ${now})
    `;
    this.armRelaySweep();
    const req: HistoryReqMessage = {
      t: "history_req",
      id: reqId,
      workerId: open.workerId,
      maxBytes,
      ...(open.since ? { since: open.since } : {}),
      ...(open.format ? { format: open.format } : {}),
    };
    deviceConn.send(JSON.stringify(req));
  }

  /** browser → DO → connector: the ack that slides the connector's window (§6.6 step 4). */
  handleHistoryAck(connection: Connection, raw: unknown): void {
    const parsed = HistoryAckMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const relay = this.sql<{ webConnId: string; deviceId: string }>`
      SELECT webConnId, deviceId FROM history_relay WHERE reqId = ${parsed.data.re}
    `[0];
    // Unknown reqId (stream already finished) or another connection's stream: drop.
    if (!relay || relay.webConnId !== connection.id) return;
    this.deps.connFor(relay.deviceId)?.send(JSON.stringify(parsed.data));
  }

  /** connector → DO → browser: forward one chunk, meter the bytes, end finished streams. */
  handleHistoryChunk(connection: Connection, raw: unknown): void {
    const parsed = HistoryChunkMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const chunk = parsed.data;
    const relay = this.sql<{ webConnId: string; deviceId: string; maxBytes: number; sentBytes: number; cursor: string | null; expiresAt: number }>`
      SELECT webConnId, deviceId, maxBytes, sentBytes, cursor, expiresAt FROM history_relay WHERE reqId = ${chunk.re}
    `[0];
    if (!relay) return; // swept/timed out/done: nothing is waiting for this chunk
    // The relay belongs to one machine: only its connection's chunks travel on. reqIds are
    // unguessable ULIDs, so this is defense in depth against a confused connector, not auth.
    if ((connection.state as unknown as ConnState | null)?.deviceId !== relay.deviceId) return;
    if (relay.expiresAt <= Date.now()) {
      this.sql`DELETE FROM history_relay WHERE reqId = ${chunk.re}`;
      return;
    }
    const webConn = this.deps.getConnection(relay.webConnId);
    if (!webConn || !this.deps.webConnectionAlive(webConn)) {
      this.sql`DELETE FROM history_relay WHERE reqId = ${chunk.re}`;
      return;
    }
    const bytes = jsonByteLength(raw);
    if (relay.sentBytes + bytes > relay.maxBytes) {
      // Defense in depth (the connector budgets maxBytes first): cut the stream here rather
      // than forward past the cap, and tell the browser it ended — continuing from the last
      // FORWARDED cursor, never the dropped chunk's (the browser never saw its entries).
      webConn.send(
        JSON.stringify({ t: "history_chunk", re: chunk.re, n: chunk.n, entries: [], cursor: relay.cursor, done: true, truncated: true }),
      );
      this.sql`DELETE FROM history_relay WHERE reqId = ${chunk.re}`;
      return;
    }
    webConn.send(JSON.stringify(chunk));
    if (chunk.done) {
      this.sql`DELETE FROM history_relay WHERE reqId = ${chunk.re}`;
    } else {
      this.sql`
        UPDATE history_relay SET sentBytes = ${relay.sentBytes + bytes}, cursor = ${chunk.cursor ?? null}
        WHERE reqId = ${chunk.re}
      `;
    }
  }

  /** A connector `error` replying to a history_req: forward the reason, end the stream. */
  relayHistoryError(connection: Connection, raw: unknown): void {
    const re = (raw as { re?: unknown }).re;
    if (typeof re !== "string") return;
    const relay = this.sql<{ webConnId: string; deviceId: string }>`
      SELECT webConnId, deviceId FROM history_relay WHERE reqId = ${re}
    `[0];
    if (!relay) return; // not a history reply; nothing else to do with connector errors today
    if ((connection.state as unknown as ConnState | null)?.deviceId !== relay.deviceId) return;
    this.sql`DELETE FROM history_relay WHERE reqId = ${re}`;
    this.deps.getConnection(relay.webConnId)?.send(JSON.stringify(raw));
  }

  /** Alarm-driven §6.6 termination: relays older than the TTL disappear, browser or not. */
  sweepHistoryRelays(): void {
    this.relaySweepAt = 0;
    this.sql`DELETE FROM history_relay WHERE expiresAt <= ${Date.now()}`;
    const next = this.sql<{ m: number | null }>`SELECT MIN(expiresAt) AS m FROM history_relay`[0]?.m;
    if (typeof next === "number") {
      const delayS = Math.max(1, Math.ceil((next - Date.now()) / 1000));
      this.relaySweepAt = Date.now() + delayS * 1000;
      void this.deps.schedule(delayS, "sweepHistoryRelays");
    }
  }

  // ---- Direct worker chat from an open session view (issue #84, ADR-0011, protocol §6.8) ----

  /** browser → DO: this connection is now watching `workerId`'s session view. */
  handleSubscribe(connection: Connection, raw: unknown): void {
    const parsed = SubscribeMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.sendError(connection, "bad_request", "invalid subscribe");
      return;
    }
    if (!this.deps.ledger.workers.get(parsed.data.workerId)) {
      this.deps.sendError(connection, "not_found", `worker ${parsed.data.workerId} is unknown`);
      return;
    }
    const state = connection.state as unknown as ConnState | null;
    connection.setState({
      role: "web",
      sid: state?.sid,
      expiresAt: state?.expiresAt,
      deviceId: state?.deviceId ?? "",
      epoch: state?.epoch ?? 0,
      keyId: state?.keyId ?? "",
      connEpoch: state?.connEpoch,
      viewingWorkerId: parsed.data.workerId,
    } satisfies ConnState);
  }

  /** browser → DO: the session view closed, or is about to subscribe to a different worker. */
  handleUnsubscribe(connection: Connection): void {
    const state = connection.state as unknown as ConnState | null;
    if (!state) return;
    const { viewingWorkerId: _drop, ...rest } = state;
    connection.setState(rest as ConnState);
  }

  // ---- thread subscription (issue #1, P4) ------------------------------------------------------

  /** Rows of one Thread after a cursor — the only read the subscription does per tick, and it
   *  rides the `(threadId, id)` index. */
  private threadRowsAfter(threadId: string, after: number, limit: number): TimelineRow[] {
    return this.sql<TimelineRow>`
      SELECT id, threadId, ts, kind, text FROM sh_timeline
      WHERE threadId = ${threadId} AND id > ${after} ORDER BY id LIMIT ${limit}
    `;
  }

  /** One `thread_events` frame, oldest first; returns whether the page was capped. Nothing is
   *  ever dropped: the capped remainder follows on the next push (see `pushThreadSubscriptions`). */
  private sendThreadRows(connection: Connection, threadId: string, rows: readonly TimelineRow[]): boolean {
    if (rows.length === 0) return false;
    const more = this.threadRowsAfter(threadId, rows[rows.length - 1]!.id, 1).length > 0;
    const events = rows.map(({ id, ts, kind, text }) => ({ id, ts, kind, text }));
    connection.send(JSON.stringify({ t: "thread_events", threadId, events, ...(more ? { more: true as const } : {}) }));
    return more;
  }

  /** The part of a Thread a watcher cannot read off the timeline: its state, its workers, and how
   *  many questions are open. Sent when it changes (and once on subscribe) — never per row. */
  private sendThreadState(connection: Connection, threadId: string, state: ConnState | null): void {
    const thread = this.deps.ledger.threads.get(threadId);
    if (thread === null) return;
    const workers = this.sql<{
      workerId: string;
      state: string;
      contextPercent: number | null;
      contextTokens: number | null;
      contextWindow: number | null;
      compactionCount: number;
      lastToolDurationMs: number | null;
    }>`
      SELECT workerId, state, contextPercent, contextTokens, contextWindow, compactionCount, lastToolDurationMs
      FROM sh_worker WHERE threadId = ${threadId} ORDER BY workerId`;
    const openQuestions = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sh_question WHERE threadId = ${threadId} AND status = 'open'`[0]!.n;
    const frame = JSON.stringify({ t: "thread_state", threadId, state: thread.state, workers, openQuestions });
    if (state?.threadStateSig === frame) return;
    if (state !== null) connection.setState({ ...state, threadStateSig: frame });
    connection.send(frame);
  }

  /** browser → DO: follow one Thread's timeline instead of polling `GET /api/messages` (issue #1).
   *  Nothing is trusted from the message: the Thread must exist, and the cursor lives on the
   *  connection — a reconnecting watcher asks for the gap, not the whole history. */
  handleSubscribeThread(connection: Connection, raw: unknown): void {
    const parsed = SubscribeThreadMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.sendError(connection, "bad_request", "invalid subscribe_thread");
      return;
    }
    const { threadId, after } = parsed.data;
    if (this.deps.ledger.threads.get(threadId) === null) {
      this.deps.sendError(connection, "not_found", `thread ${threadId} does not exist`);
      return;
    }
    const previous = connection.state as unknown as ConnState | null;
    // A fresh watcher gets the Thread's most recent page; a reconnecting one gets only the gap.
    let rows = after === undefined ? this.deps.ledger.timeline.recent(threadId, THREAD_PAGE) : this.threadRowsAfter(threadId, after, THREAD_PAGE);
    // A long gap is drained in pages rather than truncated; the cap only bounds one message.
    for (let pages = 1; ; pages += 1) {
      const cursor = rows.at(-1)?.id ?? after ?? 0;
      connection.setState({ ...previous, viewingThreadId: threadId, threadStateSig: undefined, threadCursor: cursor } as ConnState);
      const more = this.sendThreadRows(connection, threadId, rows);
      if (!more || pages >= 5) break;
      rows = this.threadRowsAfter(threadId, cursor, THREAD_PAGE);
    }
    this.sendThreadState(connection, threadId, connection.state as unknown as ConnState | null);
  }

  /** Stops the frames at once; the cursor goes with the subscription, so a later re-subscribe
   *  without `after` starts from the Thread's recent page again. */
  handleUnsubscribeThread(connection: Connection, raw: unknown): void {
    if (!UnsubscribeThreadMessageSchema.safeParse(raw).success) {
      this.deps.sendError(connection, "bad_request", "invalid unsubscribe_thread");
      return;
    }
    const state = connection.state as unknown as ConnState | null;
    if (!state) return;
    const { viewingThreadId: _thread, threadCursor: _cursor, threadStateSig: _sig, ...rest } = state;
    connection.setState(rest as ConnState);
  }

  /** Pushes what is new to every watcher (issue #1). Driven by the same ledger-write nudge as the
   *  workspace refetch, so a burst collapses into one pass and no write path can forget to notify;
   *  a watcher that fell further behind than five pages re-arms the nudge instead of stalling. */
  pushThreadSubscriptions(): void {
    let behind = false;
    for (const connection of this.deps.getConnections("web")) {
      const state = connection.state as ConnState | null;
      const threadId = state?.viewingThreadId;
      if (!threadId) continue;
      if (!this.deps.webConnectionAlive(connection)) continue;
      let cursor = state.threadCursor ?? 0;
      for (let pages = 0; pages < 5; pages += 1) {
        const rows = this.threadRowsAfter(threadId, cursor, THREAD_PAGE);
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1]!.id;
        connection.setState({ ...state, threadCursor: cursor });
        if (!this.sendThreadRows(connection, threadId, rows)) break;
        if (pages === 4) behind = true;
      }
      this.sendThreadState(connection, threadId, { ...state, threadCursor: cursor });
    }
    if (behind) this.deps.notifyWorkspaces();
  }

  /** browser → DO → connector: §6.8. Dispatches through the ordinary Dispatcher path (same
   *  outbox write, same Thread timeline entry a steward tool call would produce) and registers
   *  a relay row so the real cmd_ack/cmd_result — never fabricated — finds its way back. */
  async handleWorkerCmd(connection: Connection, raw: unknown): Promise<void> {
    const parsed = WorkerCmdMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.sendError(connection, "bad_request", "invalid worker_cmd");
      return;
    }
    const cmd = parsed.data;
    const state = connection.state as unknown as ConnState | null;
    if (state?.viewingWorkerId !== cmd.workerId) {
      this.deps.sendError(connection, "forbidden", `subscribe to ${cmd.workerId} before sending worker_cmd`, cmd.id);
      return;
    }
    this.sql`INSERT OR REPLACE INTO web_cmd_relay (cmdId, webConnId, createdAt) VALUES (${cmd.id}, ${connection.id}, ${Date.now()})`;
    const outcome =
      cmd.kind === "send"
        ? await this.deps.sendToWorker({
            workerId: cmd.workerId,
            text: cmd.args?.text ?? "",
            intent: cmd.args?.intent ?? "auto",
            provenance: "web_direct",
            cmdId: cmd.id,
          })
        : await this.deps.interruptWorker({
            workerId: cmd.workerId,
            ...(cmd.args?.then !== undefined ? { then: cmd.args.then } : {}),
            provenance: "web_direct",
            cmdId: cmd.id,
          });
    if (outcome.kind === "refused") {
      // Never reached `outbox` (unknown/broken worker, empty text): no cmd_ack is ever
      // coming, so answer directly instead of leaving the browser waiting.
      this.sql`DELETE FROM web_cmd_relay WHERE cmdId = ${cmd.id}`;
      this.deps.sendError(connection, "bad_request", outcome.reason, cmd.id);
    }
  }

  /** Forwards a real cmd_ack/cmd_result to the browser that issued a web-direct worker_cmd, if
   *  any is waiting; `terminal` clears the relay row (the command will not answer again). */
  relayWebCmd(cmdId: string, payload: unknown, terminal: boolean): void {
    const relay = this.sql<{ webConnId: string }>`SELECT webConnId FROM web_cmd_relay WHERE cmdId = ${cmdId}`[0];
    if (!relay) return;
    this.deps.getConnection(relay.webConnId)?.send(JSON.stringify(payload));
    if (terminal) this.sql`DELETE FROM web_cmd_relay WHERE cmdId = ${cmdId}`;
  }

  // ---- Connection lifecycle cleanup hooks --------------------------------------------------------

  /** §6.6/§6.8 termination: the browser closing its connection ends every stream it opened and
   *  drops the bookkeeping that would forward cmd answers to this now-gone socket. */
  cleanupWebConnection(connectionId: string): void {
    this.sql`DELETE FROM history_relay WHERE webConnId = ${connectionId}`;
    this.sql`DELETE FROM web_cmd_relay WHERE webConnId = ${connectionId}`;
  }

  /** The machine went offline: every relay through it dies with the connection, and each browser
   *  hears why (§6.6 machine_offline) instead of waiting out its own timeout. Returns the
   *  orphaned relay rows so the caller can decide whether further cleanup is needed. */
  notifyDeviceOfflineRelays(deviceId: string): void {
    const orphaned = this.sql<{ reqId: string; webConnId: string }>`
      SELECT reqId, webConnId FROM history_relay WHERE deviceId = ${deviceId}
    `;
    for (const relay of orphaned) {
      this.sql`DELETE FROM history_relay WHERE reqId = ${relay.reqId}`;
      this.deps.getConnection(relay.webConnId)?.send(JSON.stringify({ t: "machine_offline", re: relay.reqId } satisfies MachineOfflineMessage));
    }
  }
}
