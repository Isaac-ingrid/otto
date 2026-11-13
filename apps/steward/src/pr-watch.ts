// Durable, owner-authorized read-only commissions. No LLM, worker dispatch or GitHub writes.
import type { SqlExecutor } from "./schema.ts";
import { parsePrUrl, readPrEvidence, type EvidenceResult, type PrTarget, type PrEvidenceMode } from "./pr-evidence.ts";

export interface PrWatchRow {
  id: string; threadId: string; url: string; status: "active" | "completed" | "cancelled" | "expired";
  createdAt: number; expiresAt: number; intervalMs: number; nextCheckAt: number; generation: number;
  head: string | null; observedState: string | null; checkedAt: number | null; lastError: string | null;
  checks: number; failed: number; pending: number; evidenceMode: PrEvidenceMode;
}
interface Notice { id: string; watchId: string; threadId: string; text: string }
export interface PrWatchDeps {
  sql: SqlExecutor;
  tx<T>(fn: () => T): T;
  threadExists(id: string): boolean;
  notify(input: Notice): Promise<void>;
  record?(threadId: string, text: string, data: Record<string, unknown>): void;
  read?(target: PrTarget, mode: PrEvidenceMode): Promise<EvidenceResult>;
  now?: () => number;
}
export class PrWatchInputError extends Error {}
const DAY = 86_400_000;
const LEASE = 120_000;
const MAX_ACTIVE = 10;

export class PrWatchService {
  private running?: Promise<void>;
  constructor(private readonly deps: PrWatchDeps) {}
  private get sql(): SqlExecutor { return this.deps.sql; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  list(): PrWatchRow[] { return this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch ORDER BY (status = 'active') DESC, createdAt DESC LIMIT 100`; }
  hasWork(): boolean {
    return this.sql<{ n: number }>`SELECT (SELECT COUNT(*) FROM sh_pr_watch WHERE status = 'active') + (SELECT COUNT(*) FROM sh_pr_watch_notice WHERE deliveredAt IS NULL) AS n`[0]!.n > 0;
  }
  create(input: { id: unknown; threadId: unknown; url: unknown; expiresAt?: unknown; intervalSeconds?: unknown; evidenceMode?: unknown }): PrWatchRow {
    const now = this.now();
    if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(input.id) || typeof input.threadId !== "string" || !this.deps.threadExists(input.threadId)) throw new PrWatchInputError("invalid_id_or_thread");
    const target = parsePrUrl(input.url);
    if (!target) throw new PrWatchInputError("invalid_github_pr_url");
    const intervalSeconds = input.intervalSeconds ?? 900;
    if (!Number.isInteger(intervalSeconds) || Number(intervalSeconds) < 60 || Number(intervalSeconds) > 3600) throw new PrWatchInputError("interval_must_be_60_to_3600_seconds");
    const intervalMs = Number(intervalSeconds) * 1000;
    const evidenceMode = input.evidenceMode ?? 'checks-and-statuses';
    if (evidenceMode !== 'checks-and-statuses' && evidenceMode !== 'statuses-only') throw new PrWatchInputError('invalid_evidence_mode');
    const existing = this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${input.id}`[0];
    // Default expiration is chosen once, not recomputed on an idempotent retry.
    const expiresAt = input.expiresAt ?? existing?.expiresAt ?? now + DAY;
    if (existing) {
      if (existing.threadId !== input.threadId || existing.url !== target.url || existing.intervalMs !== intervalMs || existing.expiresAt !== expiresAt || existing.evidenceMode !== evidenceMode) throw new PrWatchInputError("id_conflict");
      return existing; // never resurrect completed/cancelled/expired commissions
    }
    if (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= now || Number(expiresAt) > now + 7 * DAY) throw new PrWatchInputError("expiry_must_be_within_seven_days");
    const { id, threadId } = input;
    return this.deps.tx(() => {
      if (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_pr_watch WHERE status = 'active'`[0]!.n >= MAX_ACTIVE) throw new PrWatchInputError("active_watch_limit");
      this.sql`INSERT INTO sh_pr_watch (id, threadId, url, status, createdAt, expiresAt, intervalMs, nextCheckAt, generation, checks, failed, pending, evidenceMode)
        VALUES (${id}, ${threadId}, ${target.url}, 'active', ${now}, ${Number(expiresAt)}, ${intervalMs}, ${now}, 0, 0, 0, 0, ${evidenceMode})`;
      this.deps.record?.(threadId, `开始只读跟进 PR：${target.url}${evidenceMode === 'statuses-only' ? '（仅 commit statuses，未验证 Checks/Actions）' : ''}`, { watchId: id, expiresAt, intervalMs, evidenceMode });
      return this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${id}`[0]!;
    });
  }
  cancel(id: string): boolean {
    return this.deps.tx(() => {
      const row = this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${id}`[0];
      if (!row) return false;
      this.sql`UPDATE sh_pr_watch SET status = 'cancelled', generation = generation + 1 WHERE id = ${id} AND status = 'active'`;
      this.sql`DELETE FROM sh_pr_watch_notice WHERE watchId = ${id}`;
      if (row.status === 'active') this.deps.record?.(row.threadId, `已取消 PR 跟进：${row.url}`, { watchId: id });
      return true;
    });
  }
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const run = this.pass();
    this.running = run;
    try { await run; } finally { if (this.running === run) this.running = undefined; }
  }
  private notice(row: PrWatchRow, kind: string, text: string): void {
    // Stable id by commission × head × observation kind; never a timestamp/random retry id.
    const id = `pr-watch:${row.id}:${row.head ?? 'none'}:${kind}`;
    if (this.sql`SELECT id FROM sh_pr_watch_notice WHERE id = ${id}`.length > 0) return;
    this.sql`INSERT OR IGNORE INTO sh_pr_watch_notice (id, watchId, threadId, text)
      VALUES (${id}, ${row.id}, ${row.threadId}, ${text})`;
    this.deps.record?.(row.threadId, text, { watchId: row.id, head: row.head, observation: kind, evidenceMode: row.evidenceMode });
  }
  private expire(): void {
    this.deps.tx(() => {
      for (const row of this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE status = 'active' AND expiresAt <= ${this.now()}`) {
        this.sql`UPDATE sh_pr_watch SET status = 'expired', generation = generation + 1 WHERE id = ${row.id}`;
        this.sql`DELETE FROM sh_pr_watch_notice WHERE watchId = ${row.id}`;
        this.notice(row, "expired", `PR 跟进已到期：${row.url}\n${row.evidenceMode === 'statuses-only' ? '未确认 commit statuses 通过；未验证 Checks/Actions' : '未确认 CI 通过'}；未重跑检查或修改代码。`);
      }
    });
  }
  private async pass(): Promise<void> {
    this.expire();
    await this.deliver();
    // Bound network work per callback. Lease expiry recovers a process that died mid-read.
    for (const candidate of this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE status = 'active' AND nextCheckAt <= ${this.now()} ORDER BY nextCheckAt, id LIMIT 2`) {
      const claim = this.deps.tx(() => {
        const row = this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${candidate.id}`[0];
        if (!row || row.status !== 'active' || row.nextCheckAt > this.now()) return null;
        if (!this.deps.threadExists(row.threadId)) {
          this.sql`UPDATE sh_pr_watch SET status = 'cancelled', generation = generation + 1 WHERE id = ${row.id}`;
          this.sql`DELETE FROM sh_pr_watch_notice WHERE watchId = ${row.id}`;
          return null;
        }
        this.sql`UPDATE sh_pr_watch SET generation = generation + 1, nextCheckAt = ${this.now() + LEASE} WHERE id = ${row.id}`;
        return { ...row, generation: row.generation + 1 };
      });
      if (!claim) continue;
      const target = parsePrUrl(claim.url);
      let result: EvidenceResult;
      try { result = target ? await (this.deps.read ? this.deps.read(target, claim.evidenceMode) : readPrEvidence(target, { mode: claim.evidenceMode })) : { ok: false, reason: 'invalid_target' }; }
      catch { result = { ok: false, reason: 'github_unavailable' }; }
      this.expire();
      this.deps.tx(() => {
        const current = this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${claim.id}`[0];
        // Owner cancellation/expiry or a newer lease wins over late external observations.
        if (!current || current.status !== 'active' || current.generation !== claim.generation) return;
        if (!result.ok) {
          // Reason codes only: never persist provider error text, logs or credentials.
          const reason = /^[a-z0-9_]{1,80}$/.test(result.reason) ? result.reason : 'github_unavailable';
          this.sql`UPDATE sh_pr_watch SET lastError = ${reason}, nextCheckAt = ${this.now() + Math.max(current.intervalMs, 300_000)} WHERE id = ${claim.id}`;
          return; // no evidence is not a failed build, and does not justify buzzing the owner
        }
        const evidence = result.evidence;
        const terminal = ['success', 'closed', 'merged'].includes(evidence.state);
        this.sql`UPDATE sh_pr_watch SET head = ${evidence.head}, observedState = ${evidence.state}, checkedAt = ${this.now()}, lastError = NULL,
          checks = ${evidence.checks}, failed = ${evidence.failed}, pending = ${evidence.pending},
          status = ${terminal ? 'completed' : 'active'}, nextCheckAt = ${this.now() + current.intervalMs} WHERE id = ${claim.id}`;
        if (evidence.state !== 'waiting' && (current.head !== evidence.head || current.observedState !== evidence.state)) {
          const limited = current.evidenceMode === 'statuses-only';
          const subject = limited ? 'commit statuses' : 'CI 检查';
          const label = evidence.state === 'success' ? `已观察到 ${subject}通过（不代表需求验收通过）`
            : evidence.state === 'failure' ? `${subject}失败：${evidence.failed} 项失败、${evidence.pending} 项等待，继续只读跟进`
            : evidence.state === 'merged' ? 'PR 已被合并，跟进结束' : 'PR 已关闭，跟进结束';
          this.notice({ ...current, head: evidence.head }, evidence.state,
            `${label}${limited ? '\n仅验证 commit statuses；未验证 Checks/Actions，不代表完整 CI 通过。' : ''}\n${current.url}\n提交 ${evidence.head}\n仅检查外部状态；未修改、重跑或合并。`);
        }
      });
    }
    await this.deliver();
  }
  private async deliver(): Promise<void> {
    for (const notice of this.sql<Notice>`SELECT * FROM sh_pr_watch_notice WHERE deliveredAt IS NULL ORDER BY id LIMIT 20`) {
      const row = this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${notice.watchId}`[0];
      if (!row || row.status === 'cancelled' || !this.deps.threadExists(notice.threadId)) {
        this.sql`DELETE FROM sh_pr_watch_notice WHERE id = ${notice.id}`;
        continue;
      }
      await this.deps.notify(notice); // durable outbound dedups by notice.id
      // Keep a receipt: push jobs expire, but the same head/kind must not become a new
      // notification merely because a transport's dedupe retention window elapsed.
      this.sql`UPDATE sh_pr_watch_notice SET deliveredAt = ${this.now()} WHERE id = ${notice.id}`;
    }
  }
}
