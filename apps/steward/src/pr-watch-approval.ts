// The model can request a proposal, never apply it. Only a bound owner button applies it.
import type { Ledger } from './ledger.ts';
import type { SqlExecutor } from './schema.ts';
import { parsePrUrl, type PrEvidenceMode } from './pr-evidence.ts';
import type { PrWatchRow, PrWatchService } from './pr-watch.ts';

export type PrWatchRequest =
  | { action: 'create'; threadId: string; url: string; evidenceMode: PrEvidenceMode; expiresInMinutes?: number; intervalSeconds?: number }
  | { action: 'cancel'; watchId: string };
type Identity = Pick<PrWatchRow, 'id' | 'threadId' | 'url' | 'evidenceMode' | 'createdAt' | 'expiresAt' | 'intervalMs'>;
export type PrWatchDecision =
  | { action: 'create'; threadId: string; url: string; evidenceMode: PrEvidenceMode; expiresInMinutes: number; intervalSeconds: number }
  | { action: 'cancel' | 'reuse'; watch: Identity };
export interface PrWatchApproval {
  id: string; sourceRef: string; taskId: string; request: string; command: string;
  status: 'pending' | 'applied' | 'declined' | 'expired'; createdAt: number; expiresAt: number;
}
export interface ApprovalDeps {
  sql: SqlExecutor;
  tx<T>(fn: () => T): T;
  ledger: Ledger;
  // This backend MUST use tx: fn => fn(); decide() supplies the outer transaction.
  watches: Pick<PrWatchService, 'list' | 'create' | 'cancel'>;
  now?: () => number;
}
export const PR_WATCH_APPROVAL_FAILURE = '未确认执行成功（目标可能已变化或后端拒绝）；不会派 worker 或设置其他计划。请刷新后重试，或重新发起提案。';
const identity = (w: PrWatchRow): Identity => ({ id: w.id, threadId: w.threadId, url: w.url,
  evidenceMode: w.evidenceMode, createdAt: w.createdAt, expiresAt: w.expiresAt, intervalMs: w.intervalMs });
export const approvalThread = (c: PrWatchDecision): string => c.action === 'create' ? c.threadId : c.watch.threadId;
export function approvalText(c: PrWatchDecision): string {
  const target = c.action === 'create' ? c : c.watch;
  const scope = target.evidenceMode === 'statuses-only' ? '仅 commit statuses；未验证 Checks/Actions，不代表完整 CI 通过' : 'check runs + commit statuses；不代表需求验收';
  if (c.action === 'create') return `确认创建持续只读 PR 跟进？\nPR：${c.url}\nThread：${c.threadId}\n范围：${scope}\n间隔：${c.intervalSeconds} 秒\n期限：确认后 ${c.expiresInMinutes} 分钟\n确认前不会开始跟进。`;
  return `确认${c.action === 'cancel' ? '取消' : '复用并恢复调度（不延长期限）'} PR 跟进？\n编号：${c.watch.id}\nPR：${c.watch.url}\nThread：${c.watch.threadId}\n范围：${scope}\n间隔：${c.watch.intervalMs / 1000} 秒\n到期：${new Date(c.watch.expiresAt).toISOString()}\n${c.action === 'cancel' ? '只取消此 watch，不停止 worker、turn 或其他计划；已发送的消息不能撤回。' : '不会创建第二条 watch，也不会改变范围或期限。'}`;
}

export class PrWatchApprovals {
  private readonly deps: ApprovalDeps;
  constructor(deps: ApprovalDeps) { this.deps = deps; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  get(id: string): PrWatchApproval | null { return this.deps.sql<PrWatchApproval>`SELECT * FROM sh_pr_watch_approval WHERE id = ${id}`[0] ?? null; }
  private normalize(input: PrWatchRequest): PrWatchDecision {
    if (input.action === 'cancel') {
      const watch = this.deps.watches.list().find(w => w.id === input.watchId);
      if (!watch || watch.status !== 'active') throw new Error('watch_not_active');
      return { action: 'cancel', watch: identity(watch) };
    }
    const parsed = parsePrUrl(input.url);
    if (!parsed || !this.deps.ledger.threads.get(input.threadId)) throw new Error('invalid_target');
    if (!['checks-and-statuses', 'statuses-only'].includes(input.evidenceMode)) throw new Error('invalid_scope');
    const intervalSeconds = input.intervalSeconds ?? 900, expiresInMinutes = input.expiresInMinutes ?? 1440;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 3600 ||
      !Number.isFinite(expiresInMinutes) || expiresInMinutes <= 0 || expiresInMinutes > 10080 || !Number.isSafeInteger(expiresInMinutes * 60000)) throw new Error('invalid_interval_or_expiry');
    const active = this.deps.watches.list().filter(w => w.status === 'active' && w.threadId === input.threadId && w.url === parsed.url);
    if (active.length) {
      if (active.length !== 1 || active[0]!.evidenceMode !== input.evidenceMode || input.expiresInMinutes !== undefined || (input.intervalSeconds !== undefined && intervalSeconds * 1000 !== active[0]!.intervalMs)) throw new Error('active_watch_conflict');
      return { action: 'reuse', watch: identity(active[0]!) };
    }
    return { action: 'create', threadId: input.threadId, url: parsed.url, evidenceMode: input.evidenceMode, expiresInMinutes, intervalSeconds };
  }
  propose(input: PrWatchRequest, sourceRef: string, taskId: string): PrWatchApproval {
    if (!sourceRef.startsWith('user:') || !taskId) throw new Error('owner_turn_required');
    const request = JSON.stringify(input.action === 'cancel' ? { action: 'cancel', watchId: input.watchId } : {
      action: 'create', threadId: input.threadId, url: parsePrUrl(input.url)?.url ?? input.url, evidenceMode: input.evidenceMode,
      expiresInMinutes: input.expiresInMinutes ?? null, intervalSeconds: input.intervalSeconds ?? null,
    });
    const now = this.now();
    return this.deps.tx(() => {
      const previous = this.deps.sql<PrWatchApproval>`SELECT * FROM sh_pr_watch_approval WHERE sourceRef = ${sourceRef}`[0];
      if (previous) {
        // Replays cannot edit an already presented decision or mint a fresh lifetime.
        if (previous.request !== request) throw new Error('proposal_conflict');
        if (previous.status === 'pending' && previous.expiresAt <= now) {
          this.deps.sql`UPDATE sh_pr_watch_approval SET status = 'expired' WHERE id = ${previous.id}`;
          this.deps.ledger.questions.close(previous.id, '确认已过期');
          return this.get(previous.id)!;
        }
        return previous;
      }
      const command = JSON.stringify(this.normalize(input));
      if (this.deps.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_pr_watch_approval WHERE status = 'pending' AND expiresAt > ${now}`[0]!.n >= 20) throw new Error('pending_approval_limit');
      const id = `q_pwa_${crypto.randomUUID()}`;
      this.deps.sql`INSERT INTO sh_pr_watch_approval (id, sourceRef, taskId, request, command, status, createdAt, expiresAt)
        VALUES (${id}, ${sourceRef}, ${taskId}, ${request}, ${command}, 'pending', ${now}, ${now + 600000})`;
      this.deps.ledger.questions.insert({ qid: id, threadId: null, workerId: null, text: approvalText(JSON.parse(command)), options: ['确认执行', '不执行'] });
      return this.get(id)!;
    });
  }
  decide(id: string, confirm: boolean, ownerRef: string): { status: PrWatchApproval['status']; command: PrWatchDecision; watch?: PrWatchRow; appliedNow?: true } {
    if (!ownerRef.startsWith('user:')) throw new Error('owner_action_required');
    return this.deps.tx(() => {
      const row = this.get(id); if (!row) throw new Error('proposal_not_found');
      const command = JSON.parse(row.command) as PrWatchDecision;
      if (row.status !== 'pending') return { status: row.status, command,
        watch: row.status === 'applied' ? this.deps.watches.list().find(w => w.id === (command.action === 'create' ? `pw_${id.slice(6)}` : command.watch.id)) : undefined };
      if (row.expiresAt <= this.now() || this.deps.ledger.questions.get(id)?.status !== 'open') {
        this.deps.sql`UPDATE sh_pr_watch_approval SET status = 'expired' WHERE id = ${id}`;
        this.deps.ledger.questions.close(id, '确认已过期');
        return { status: 'expired', command };
      }
      if (!confirm) {
        this.deps.sql`UPDATE sh_pr_watch_approval SET status = 'declined', decidedBy = ${ownerRef}, decidedAt = ${this.now()} WHERE id = ${id}`;
        this.deps.ledger.questions.close(id, '不执行');
        return { status: 'declined', command };
      }
      let watch: PrWatchRow;
      if (command.action === 'create') {
        if (!this.deps.ledger.threads.get(command.threadId) || this.deps.watches.list().some(w => w.status === 'active' && w.threadId === command.threadId && w.url === command.url)) throw new Error('target_changed');
        watch = this.deps.watches.create({ id: `pw_${id.slice(6)}`, threadId: command.threadId, url: command.url,
          evidenceMode: command.evidenceMode, intervalSeconds: command.intervalSeconds, expiresAt: this.now() + command.expiresInMinutes * 60000 });
        if (watch.status !== 'active') throw new Error('target_changed');
      } else {
        const current = this.deps.watches.list().find(w => w.id === command.watch.id);
        if (!current || current.status !== 'active' || current.expiresAt <= this.now() || JSON.stringify(identity(current)) !== JSON.stringify(command.watch) || !this.deps.ledger.threads.get(current.threadId)) throw new Error('target_changed');
        if (command.action === 'cancel') this.deps.watches.cancel(current.id);
        watch = this.deps.watches.list().find(w => w.id === current.id)!;
      }
      this.deps.sql`UPDATE sh_pr_watch_approval SET status = 'applied', decidedBy = ${ownerRef}, decidedAt = ${this.now()} WHERE id = ${id}`;
      this.deps.ledger.questions.close(id, '已确认执行');
      return { status: 'applied', command, watch, appliedNow: true };
    });
  }
}
