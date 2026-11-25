// Durable, owner-authorized read-only commissions. No worker dispatch or GitHub writes;
// optional CI failure & review/conflict triage runs out-of-band via tool-less completion callbacks.
import type { SqlExecutor } from "./schema.ts";
import {
  parsePrUrl,
  readPrEvidence,
  type EvidenceResult,
  type PrEvidenceMode,
  type PrFailureSnapshot,
  type PrFeedbackSnapshot,
  type PrMergeState,
  type PrReviewDecision,
  type PrTarget,
  type PrWatchGoal,
} from "./pr-evidence.ts";
import {
  buildDeterministicPrDiagnosis,
  buildDeterministicPrFeedbackTriage,
  buildPrActionPrompt,
  buildPrRepairPrompt,
  formatPrFailureNoticeDetails,
  formatPrFeedbackNoticeDetails,
  hasActionablePrFeedback,
  type PrActionKind,
  type PrDiagnoseOutcome,
  type PrDiagnosisStatus,
  type PrFailureDiagnosis,
  type PrFeedbackTriage,
  type PrFeedbackTriageOutcome,
} from "./pr-failure-diagnoser.ts";

export const PR_WATCH_STUCK_THRESHOLD_MS = 2 * 3_600_000;

export interface PrWatchStuckAlert {
  watch: PrWatchRow;
  head: string;
  stalledMs: number;
  reason: string;
}

export interface PrWatchRow {
  id: string; threadId: string; url: string; status: "active" | "completed" | "cancelled" | "expired";
  createdAt: number; expiresAt: number; intervalMs: number; nextCheckAt: number; generation: number;
  head: string | null; observedState: string | null; checkedAt: number | null; lastError: string | null;
  checks: number; failed: number; pending: number; evidenceMode: PrEvidenceMode; watchGoal: PrWatchGoal;
  stateSince?: number | null; stuckNotifiedHead?: string | null; blindReviewStatus?: string | null;
}

export interface PrWatchDiagnosisRecord {
  watchId: string;
  head: string;
  snapshot: PrFailureSnapshot;
  diagnosis: PrFailureDiagnosis | null;
  diagnosisStatus: PrDiagnosisStatus;
  effectiveDiagnosis: PrFailureDiagnosis;
  repairPrompt: string;
  createdAt: number;
  updatedAt: number;
}

export interface PrWatchFeedbackRecord {
  watchId: string;
  head: string;
  baseRef: string | null;
  baseSha: string | null;
  headRef: string | null;
  mergeState: PrMergeState;
  reviewDecision: PrReviewDecision;
  reviewCursor: string;
  snapshot: PrFeedbackSnapshot;
  triage: PrFeedbackTriage | null;
  triageStatus: PrDiagnosisStatus;
  effectiveTriage: PrFeedbackTriage;
  updatedAt: number;
}

export interface PrWatchFailureBrief {
  hasFailureDetail: boolean;
  failureHeadline: string | null;
  diagnosisStatus: PrDiagnosisStatus | null;
  failedChecks?: string[];
  watchGoal: PrWatchGoal;
  mergeState: PrMergeState;
  reviewDecision: PrReviewDecision;
  hasActionableFeedback: boolean;
  attentionHeadline: string | null;
}

interface StoredDiagnosisRow {
  watchId: string;
  head: string;
  snapshotJson: string;
  diagnosisJson: string | null;
  diagnosisStatus: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredFeedbackRow {
  watchId: string;
  head: string;
  baseRef: string | null;
  baseSha: string | null;
  headRef: string | null;
  mergeState: string;
  reviewDecision: string;
  reviewCursor: string;
  snapshotJson: string;
  triageJson: string | null;
  triageStatus: string;
  updatedAt: number;
}

interface Notice { id: string; watchId: string; threadId: string; text: string }
export interface PrWatchDeps {
  sql: SqlExecutor;
  tx<T>(fn: () => T): T;
  threadExists(id: string): boolean;
  notify(input: Notice): Promise<void>;
  notifyStuck?(alert: PrWatchStuckAlert): Promise<void>;
  stuckThresholdMs?: number;
  record?(threadId: string, text: string, data: Record<string, unknown>): void;
  read?(target: PrTarget, mode: PrEvidenceMode): Promise<EvidenceResult>;
  readFailureDetail?(target: PrTarget, head: string, mode: PrEvidenceMode): Promise<PrFailureSnapshot | null>;
  diagnoseFailure?(snapshot: PrFailureSnapshot, url: string): Promise<PrDiagnoseOutcome>;
  readFeedbackDetail?(target: PrTarget, head: string): Promise<PrFeedbackSnapshot | null>;
  diagnoseFeedback?(snapshot: PrFeedbackSnapshot, url: string): Promise<PrFeedbackTriageOutcome>;
  now?: () => number;
}
export class PrWatchInputError extends Error {}
const DAY = 86_400_000;
const LEASE = 120_000;
const MAX_ACTIVE = 10;

function parseJsonSafe<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeDiagnosisStatus(raw: unknown): PrDiagnosisStatus {
  if (
    raw === "ready" ||
    raw === "skipped_over_budget" ||
    raw === "skipped_no_model" ||
    raw === "failed"
  ) {
    return raw;
  }
  return "none";
}

function normalizeMergeState(raw: unknown): PrMergeState {
  if (raw === "mergeable" || raw === "conflicted") return raw;
  return "unknown";
}

function normalizeReviewDecision(raw: unknown): PrReviewDecision {
  if (raw === "changes_requested" || raw === "approved" || raw === "commented") return raw;
  return "none";
}

export class PrWatchService {
  private running?: Promise<void>;
  private readonly deps: PrWatchDeps;
  private stuckThresholdOverrideMs?: number;
  constructor(deps: PrWatchDeps) { this.deps = deps; }
  private get sql(): SqlExecutor { return this.deps.sql; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  setStuckThresholdMsForTest(ms: number | undefined): void { this.stuckThresholdOverrideMs = ms; }
  private stuckThresholdMs(): number {
    return this.stuckThresholdOverrideMs ?? this.deps.stuckThresholdMs ?? PR_WATCH_STUCK_THRESHOLD_MS;
  }

  get(id: string): PrWatchRow | null {
    return this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${id}`[0] ?? null;
  }

  list(): PrWatchRow[] {
    return this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch ORDER BY (status = 'active') DESC, createdAt DESC LIMIT 100`;
  }

  private hydrateDiagnosis(watch: PrWatchRow, row: StoredDiagnosisRow): PrWatchDiagnosisRecord | null {
    const snapshot = parseJsonSafe<PrFailureSnapshot>(row.snapshotJson);
    if (!snapshot || !Array.isArray(snapshot.items)) return null;
    const diagnosis = parseJsonSafe<PrFailureDiagnosis>(row.diagnosisJson);
    const diagnosisStatus = normalizeDiagnosisStatus(row.diagnosisStatus);
    const effectiveDiagnosis = diagnosis ?? buildDeterministicPrDiagnosis(snapshot, watch.url);
    const repairPrompt = buildPrRepairPrompt({
      url: watch.url,
      head: row.head,
      snapshot,
      diagnosis,
    });
    return {
      watchId: row.watchId,
      head: row.head,
      snapshot,
      diagnosis,
      diagnosisStatus,
      effectiveDiagnosis,
      repairPrompt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private hydrateFeedback(watch: PrWatchRow, row: StoredFeedbackRow): PrWatchFeedbackRecord | null {
    const snapshot = parseJsonSafe<PrFeedbackSnapshot>(row.snapshotJson);
    if (!snapshot) return null;
    const triage = parseJsonSafe<PrFeedbackTriage>(row.triageJson);
    const triageStatus = normalizeDiagnosisStatus(row.triageStatus);
    const effectiveTriage = triage ?? buildDeterministicPrFeedbackTriage(snapshot, watch.url);
    return {
      watchId: row.watchId,
      head: row.head,
      baseRef: row.baseRef,
      baseSha: row.baseSha,
      headRef: row.headRef,
      mergeState: normalizeMergeState(row.mergeState),
      reviewDecision: normalizeReviewDecision(row.reviewDecision),
      reviewCursor: row.reviewCursor,
      snapshot,
      triage,
      triageStatus,
      effectiveTriage,
      updatedAt: row.updatedAt,
    };
  }

  getDiagnosis(watchId: string, head?: string | null): PrWatchDiagnosisRecord | null {
    const watch = this.get(watchId);
    if (!watch) return null;
    const targetHead = head ?? watch.head;
    if (!targetHead) return null;
    const row = this.sql<StoredDiagnosisRow>`
      SELECT * FROM sh_pr_watch_diagnosis WHERE watchId = ${watchId} AND head = ${targetHead}
    `[0];
    if (!row) return null;
    return this.hydrateDiagnosis(watch, row);
  }

  getFeedback(watchId: string): PrWatchFeedbackRecord | null {
    const watch = this.get(watchId);
    if (!watch) return null;
    const row = this.sql<StoredFeedbackRow>`
      SELECT * FROM sh_pr_watch_feedback WHERE watchId = ${watchId}
    `[0];
    if (!row) return null;
    return this.hydrateFeedback(watch, row);
  }

  buildCombinedAction(
    watch: PrWatchRow,
    targetHead?: string | null,
  ): { kind: PrActionKind | null; prompt: string | null } {
    const head = targetHead ?? watch.head;
    if (!head) return { kind: null, prompt: null };
    const diag =
      watch.observedState === "failure" || targetHead
        ? this.getDiagnosis(watch.id, head)
        : null;
    const fb = this.getFeedback(watch.id);
    const activeFb = fb && fb.head === head ? fb : null;
    const built = buildPrActionPrompt({
      url: watch.url,
      head,
      ciFailure: diag ? { snapshot: diag.snapshot, diagnosis: diag.diagnosis } : null,
      feedback: activeFb ? { snapshot: activeFb.snapshot, triage: activeFb.triage } : null,
    });
    return built ?? { kind: null, prompt: null };
  }

  summaryForWatch(watch: PrWatchRow): PrWatchFailureBrief {
    const watchGoal: PrWatchGoal = watch.watchGoal ?? "ci_pass";
    const diagRecord =
      watch.observedState === "failure" && watch.head
        ? this.getDiagnosis(watch.id, watch.head)
        : null;
    const fbRecord = this.getFeedback(watch.id);
    const currentFb = fbRecord && (!watch.head || fbRecord.head === watch.head) ? fbRecord : null;
    const mergeState: PrMergeState = currentFb?.mergeState ?? "unknown";
    const reviewDecision: PrReviewDecision = currentFb?.reviewDecision ?? "none";
    const fbActionable = currentFb ? hasActionablePrFeedback(currentFb.snapshot) : false;
    const hasFailureDetail = diagRecord !== null;
    const failureHeadline = diagRecord ? diagRecord.effectiveDiagnosis.headline : null;
    const hasActionableFeedback = hasFailureDetail || fbActionable;

    let attentionHeadline: string | null = null;
    if (mergeState === "conflicted" && currentFb) {
      attentionHeadline = failureHeadline
        ? `${currentFb.effectiveTriage.headline} · ${failureHeadline}`.slice(0, 140)
        : currentFb.effectiveTriage.headline;
    } else if (failureHeadline) {
      attentionHeadline = failureHeadline;
    } else if (fbActionable && currentFb) {
      attentionHeadline = currentFb.effectiveTriage.headline;
    }

    return {
      hasFailureDetail,
      failureHeadline,
      diagnosisStatus: diagRecord ? diagRecord.diagnosisStatus : null,
      ...(diagRecord
        ? {
            failedChecks: diagRecord.snapshot.items.map((it) =>
              it.failedStep ? `${it.name} (${it.failedStep})` : it.name,
            ),
          }
        : {}),
      watchGoal,
      mergeState,
      reviewDecision,
      hasActionableFeedback,
      attentionHeadline,
    };
  }

  async refreshDiagnosis(
    watchId: string,
    head?: string | null,
  ): Promise<
    | { ok: true; record: PrWatchDiagnosisRecord | null; feedback: PrWatchFeedbackRecord | null }
    | { ok: false; code: "not_found" | "no_snapshot" | "over_budget" | "no_model" | "failed" }
  > {
    const watch = this.get(watchId);
    if (!watch) return { ok: false, code: "not_found" };
    const existingDiag = this.getDiagnosis(watchId, head);
    const existingFb = this.getFeedback(watchId);
    const hasReviewContent =
      existingFb &&
      (!head || existingFb.head === head) &&
      (existingFb.snapshot.changesRequestedOnCurrentHead ||
        existingFb.snapshot.threads.length > 0 ||
        existingFb.snapshot.reviewers.some((r) => r.state === "COMMENTED" && Boolean(r.body)));

    if (!existingDiag && !hasReviewContent) {
      return { ok: false, code: "no_snapshot" };
    }
    if (!this.deps.diagnoseFailure && !this.deps.diagnoseFeedback) {
      return { ok: false, code: "no_model" };
    }

    const ts = this.now();
    let anyReady = false;
    let lastErrorCode: "over_budget" | "no_model" | "failed" = "failed";

    if (existingDiag && this.deps.diagnoseFailure) {
      let outcome: PrDiagnoseOutcome;
      try {
        outcome = await this.deps.diagnoseFailure(existingDiag.snapshot, watch.url);
      } catch {
        outcome = { status: "failed" };
      }
      if (outcome.status === "ready") {
        anyReady = true;
        this.deps.tx(() => {
          this.sql`
            UPDATE sh_pr_watch_diagnosis
            SET diagnosisJson = ${JSON.stringify(outcome.diagnosis)},
                diagnosisStatus = 'ready',
                updatedAt = ${ts}
            WHERE watchId = ${watchId} AND head = ${existingDiag.head}
          `;
        });
      } else {
        this.deps.tx(() => {
          this.sql`
            UPDATE sh_pr_watch_diagnosis
            SET diagnosisStatus = ${outcome.status},
                updatedAt = ${ts}
            WHERE watchId = ${watchId} AND head = ${existingDiag.head} AND diagnosisJson IS NULL
          `;
        });
        if (outcome.status === "skipped_over_budget") lastErrorCode = "over_budget";
        else if (outcome.status === "skipped_no_model") lastErrorCode = "no_model";
      }
    }

    if (hasReviewContent && existingFb && this.deps.diagnoseFeedback) {
      let fbOutcome: PrFeedbackTriageOutcome;
      try {
        fbOutcome = await this.deps.diagnoseFeedback(existingFb.snapshot, watch.url);
      } catch {
        fbOutcome = { status: "failed" };
      }
      if (fbOutcome.status === "ready") {
        anyReady = true;
        this.deps.tx(() => {
          this.sql`
            UPDATE sh_pr_watch_feedback
            SET triageJson = ${JSON.stringify(fbOutcome.triage)},
                triageStatus = 'ready',
                updatedAt = ${ts}
            WHERE watchId = ${watchId}
          `;
        });
      } else {
        this.deps.tx(() => {
          this.sql`
            UPDATE sh_pr_watch_feedback
            SET triageStatus = ${fbOutcome.status},
                updatedAt = ${ts}
            WHERE watchId = ${watchId} AND triageJson IS NULL
          `;
        });
        if (fbOutcome.status === "skipped_over_budget") lastErrorCode = "over_budget";
        else if (fbOutcome.status === "skipped_no_model") lastErrorCode = "no_model";
      }
    }

    if (!anyReady) return { ok: false, code: lastErrorCode };
    return {
      ok: true,
      record: existingDiag ? this.getDiagnosis(watchId, existingDiag.head) : null,
      feedback: this.getFeedback(watchId),
    };
  }

  targetsForThread(threadId: string): string[] {
    const rows = this.sql<{ url: string }>`SELECT url FROM sh_pr_watch WHERE threadId = ${threadId}
      UNION SELECT url FROM sh_pr_consent WHERE threadId = ${threadId} AND url IS NOT NULL`;
    return [...new Set(rows.flatMap(row => { const target = parsePrUrl(row.url); return target ? [target.url] : []; }))];
  }
  threadsForUrl(url: string): string[] {
    return this.sql<{ threadId: string }>`SELECT threadId FROM sh_pr_watch WHERE url = ${url} OR url = ${url + '/'}
      UNION SELECT threadId FROM sh_pr_consent WHERE url = ${url} OR url = ${url + '/'}`
      .map(row => row.threadId).filter(id => this.deps.threadExists(id));
  }
  hasWork(): boolean {
    return this.sql<{ n: number }>`SELECT (SELECT COUNT(*) FROM sh_pr_watch WHERE status = 'active') + (SELECT COUNT(*) FROM sh_pr_watch_notice WHERE deliveredAt IS NULL) AS n`[0]!.n > 0;
  }
  create(input: { id: unknown; threadId: unknown; url: unknown; expiresAt?: unknown; intervalSeconds?: unknown; evidenceMode?: unknown; watchGoal?: unknown }): PrWatchRow {
    const now = this.now();
    if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(input.id) || typeof input.threadId !== "string" || !this.deps.threadExists(input.threadId)) throw new PrWatchInputError("invalid_id_or_thread");
    const target = parsePrUrl(input.url);
    if (!target) throw new PrWatchInputError("invalid_github_pr_url");
    const intervalSeconds = input.intervalSeconds ?? 900;
    if (!Number.isInteger(intervalSeconds) || Number(intervalSeconds) < 60 || Number(intervalSeconds) > 3600) throw new PrWatchInputError("interval_must_be_60_to_3600_seconds");
    const intervalMs = Number(intervalSeconds) * 1000;
    const evidenceMode = input.evidenceMode ?? 'checks-and-statuses';
    if (evidenceMode !== 'checks-and-statuses' && evidenceMode !== 'statuses-only') throw new PrWatchInputError('invalid_evidence_mode');
    const watchGoal = input.watchGoal ?? 'ci_pass';
    if (watchGoal !== 'ci_pass' && watchGoal !== 'merged') throw new PrWatchInputError('invalid_watch_goal');
    const existing = this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${input.id}`[0];
    // Default expiration is chosen once, not recomputed on an idempotent retry.
    const expiresAt = input.expiresAt ?? existing?.expiresAt ?? now + DAY;
    if (existing) {
      if (existing.threadId !== input.threadId || existing.url !== target.url || existing.intervalMs !== intervalMs || existing.expiresAt !== expiresAt || existing.evidenceMode !== evidenceMode || (existing.watchGoal ?? 'ci_pass') !== watchGoal) throw new PrWatchInputError("id_conflict");
      return existing; // never resurrect completed/cancelled/expired commissions
    }
    if (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= now || Number(expiresAt) > now + 7 * DAY) throw new PrWatchInputError("expiry_must_be_within_seven_days");
    const { id, threadId } = input;
    return this.deps.tx(() => {
      if (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_pr_watch WHERE status = 'active'`[0]!.n >= MAX_ACTIVE) throw new PrWatchInputError("active_watch_limit");
      this.sql`INSERT INTO sh_pr_watch (id, threadId, url, status, createdAt, expiresAt, intervalMs, nextCheckAt, generation, checks, failed, pending, evidenceMode, watchGoal)
        VALUES (${id}, ${threadId}, ${target.url}, 'active', ${now}, ${Number(expiresAt)}, ${intervalMs}, ${now}, 0, 0, 0, 0, ${evidenceMode}, ${watchGoal})`;
      const modeSuffix = evidenceMode === 'statuses-only' ? '（仅 commit statuses，未验证 Checks/Actions）' : '';
      const goalSuffix = watchGoal === 'merged' ? '（持续跟进至 PR 合并或关闭）' : '';
      this.deps.record?.(threadId, `开始只读跟进 PR：${target.url}${modeSuffix}${goalSuffix}`, { watchId: id, expiresAt, intervalMs, evidenceMode, watchGoal });
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
  private noticeByKey(row: PrWatchRow, dedupeId: string, kind: string, text: string): void {
    if (this.sql`SELECT id FROM sh_pr_watch_notice WHERE id = ${dedupeId}`.length > 0) return;
    this.sql`INSERT OR IGNORE INTO sh_pr_watch_notice (id, watchId, threadId, text)
      VALUES (${dedupeId}, ${row.id}, ${row.threadId}, ${text})`;
    this.deps.record?.(row.threadId, text, { watchId: row.id, head: row.head, observation: kind, evidenceMode: row.evidenceMode });
  }
  private notice(row: PrWatchRow, kind: string, text: string): void {
    // Stable id by commission × head × observation kind; never a timestamp/random retry id.
    const id = `pr-watch:${row.id}:${row.head ?? 'none'}:${kind}`;
    this.noticeByKey(row, id, kind, text);
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
  private claimStillValid(claim: PrWatchRow): boolean {
    const row = this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${claim.id}`[0];
    return Boolean(row && row.status === "active" && row.generation === claim.generation && row.expiresAt > this.now());
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

      // 1. Bounded once-per-(watchId, head) CI failure detail & zero-tool diagnosis outside tx.
      let diagSnapshot: PrFailureSnapshot | null = null;
      let diagValue: PrFailureDiagnosis | null = null;
      let diagStatus: PrDiagnosisStatus = "none";
      let persistNewDiag = false;

      if (result.ok && result.evidence.state === "failure" && this.claimStillValid(claim)) {
        const existingDiag = this.getDiagnosis(claim.id, result.evidence.head);
        if (existingDiag) {
          diagSnapshot = existingDiag.snapshot;
          diagValue = existingDiag.diagnosis;
          diagStatus = existingDiag.diagnosisStatus;
        } else if (target && this.deps.readFailureDetail) {
          try {
            diagSnapshot = await this.deps.readFailureDetail(target, result.evidence.head, claim.evidenceMode);
          } catch {
            diagSnapshot = null;
          }
          if (diagSnapshot && this.claimStillValid(claim)) {
            persistNewDiag = true;
            if (this.deps.diagnoseFailure) {
              try {
                const outcome = await this.deps.diagnoseFailure(diagSnapshot, claim.url);
                if (outcome.status === "ready") {
                  diagValue = outcome.diagnosis;
                  diagStatus = "ready";
                } else {
                  diagStatus = outcome.status;
                }
              } catch {
                diagStatus = "failed";
              }
            } else {
              diagStatus = "skipped_no_model";
            }
          }
        }
      }

      // 2. Bounded PR review & merge-conflict detail collection outside tx (Direction B).
      const prevFeedback = this.getFeedback(claim.id);
      let fbSnapshot: PrFeedbackSnapshot | null = null;
      let fbTriage: PrFeedbackTriage | null = null;
      let fbTriageStatus: PrDiagnosisStatus = "none";
      let persistFeedback = false;

      if (
        result.ok &&
        result.evidence.state !== "closed" &&
        result.evidence.state !== "merged" &&
        this.claimStillValid(claim)
      ) {
        const watchGoal = claim.watchGoal ?? "ci_pass";
        const shouldFetchReviews =
          Boolean(target && this.deps.readFeedbackDetail) &&
          (result.evidence.state === "success" ||
            watchGoal === "merged" ||
            result.evidence.mergeState === "conflicted" ||
            prevFeedback !== null);

        if (shouldFetchReviews && target && this.deps.readFeedbackDetail) {
          try {
            fbSnapshot = await this.deps.readFeedbackDetail(target, result.evidence.head);
          } catch {
            fbSnapshot = null;
          }
        }

        // Synthesize lightweight merge-conflict snapshot from /pulls/{n} evidence if reviews were not fetched.
        if (!fbSnapshot && result.evidence.mergeState !== undefined) {
          fbSnapshot = {
            head: result.evidence.head,
            capturedAt: this.now(),
            baseRef: result.evidence.baseRef ?? null,
            baseSha: result.evidence.baseSha ?? null,
            headRef: result.evidence.headRef ?? null,
            mergeState: result.evidence.mergeState,
            reviewDecision:
              prevFeedback && prevFeedback.head === result.evidence.head
                ? prevFeedback.reviewDecision
                : "none",
            changesRequestedOnCurrentHead:
              prevFeedback && prevFeedback.head === result.evidence.head
                ? prevFeedback.snapshot.changesRequestedOnCurrentHead
                : false,
            staleChangesRequestedReviewers:
              prevFeedback && prevFeedback.head === result.evidence.head
                ? prevFeedback.snapshot.staleChangesRequestedReviewers
                : [],
            reviewCursor: prevFeedback?.reviewCursor ?? "0:0",
            ignoredUntrustedCount: 0,
            truncated: false,
            reviewers:
              prevFeedback && prevFeedback.head === result.evidence.head
                ? prevFeedback.snapshot.reviewers
                : [],
            threads:
              prevFeedback && prevFeedback.head === result.evidence.head
                ? prevFeedback.snapshot.threads
                : [],
          };
        }

        if (fbSnapshot && this.claimStillValid(claim)) {
          persistFeedback = true;
          const hasReviewItems =
            fbSnapshot.changesRequestedOnCurrentHead ||
            fbSnapshot.threads.length > 0 ||
            fbSnapshot.reviewers.some((r) => r.state === "COMMENTED" && Boolean(r.body));
          const sameCursor =
            prevFeedback !== null &&
            prevFeedback.reviewCursor === fbSnapshot.reviewCursor &&
            prevFeedback.mergeState === fbSnapshot.mergeState;

          if (sameCursor && prevFeedback) {
            fbTriage = prevFeedback.triage;
            fbTriageStatus = prevFeedback.triageStatus;
          } else if (hasReviewItems && this.deps.diagnoseFeedback) {
            try {
              const outcome = await this.deps.diagnoseFeedback(fbSnapshot, claim.url);
              if (outcome.status === "ready") {
                fbTriage = outcome.triage;
                fbTriageStatus = "ready";
              } else {
                fbTriageStatus = outcome.status;
              }
            } catch {
              fbTriageStatus = "failed";
            }
          } else if (hasReviewItems) {
            fbTriageStatus = "skipped_no_model";
          }
        }
      }

      let pendingStuckAlert: PrWatchStuckAlert | null = null;
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
        const tsNow = this.now();
        const watchGoal: PrWatchGoal = current.watchGoal ?? "ci_pass";
        const effectiveMergeState: PrMergeState =
          fbSnapshot?.mergeState ?? evidence.mergeState ?? "unknown";
        const mergeConflicted = effectiveMergeState === "conflicted";
        const blockedByCurrentReview = fbSnapshot?.changesRequestedOnCurrentHead === true;

        const terminal =
          evidence.state === "closed" ||
          evidence.state === "merged" ||
          (evidence.state === "success" &&
            watchGoal !== "merged" &&
            !mergeConflicted &&
            !blockedByCurrentReview);

        const sameObservation = current.head === evidence.head && current.observedState === evidence.state;
        const nextStateSince = sameObservation ? (current.stateSince ?? current.checkedAt ?? current.createdAt ?? tsNow) : tsNow;
        const isStalledState =
          !terminal &&
          (evidence.state === "waiting" || mergeConflicted || blockedByCurrentReview);
        const stalledMs = Math.max(0, tsNow - nextStateSince);
        const crossedStuckThreshold =
          isStalledState &&
          stalledMs >= this.stuckThresholdMs() &&
          current.stuckNotifiedHead !== evidence.head;
        const nextStuckNotifiedHead = crossedStuckThreshold
          ? evidence.head
          : current.head === evidence.head
            ? (current.stuckNotifiedHead ?? null)
            : null;

        this.sql`UPDATE sh_pr_watch SET head = ${evidence.head}, observedState = ${evidence.state}, checkedAt = ${tsNow}, lastError = NULL,
          checks = ${evidence.checks}, failed = ${evidence.failed}, pending = ${evidence.pending},
          stateSince = ${nextStateSince}, stuckNotifiedHead = ${nextStuckNotifiedHead},
          status = ${terminal ? 'completed' : 'active'}, nextCheckAt = ${tsNow + current.intervalMs} WHERE id = ${claim.id}`;

        if (crossedStuckThreshold) {
          const stuckReason = mergeConflicted
            ? "PR 合并冲突长时间未解除"
            : blockedByCurrentReview
              ? "PR 审阅人要求修改长时间未响应"
              : `CI 检查长时间处于等待状态（${evidence.pending} 项 pending）`;
          const updatedWatch: PrWatchRow = {
            ...current,
            head: evidence.head,
            observedState: evidence.state,
            checkedAt: tsNow,
            stateSince: nextStateSince,
            stuckNotifiedHead: evidence.head,
          };
          pendingStuckAlert = {
            watch: updatedWatch,
            head: evidence.head,
            stalledMs,
            reason: stuckReason,
          };
          this.deps.record?.(current.threadId, `PR 跟进停滞超过阈值（${Math.round(stalledMs / 60_000)} 分钟）：${stuckReason}`, {
            watchId: current.id,
            head: evidence.head,
            stalledMs,
            stuck: true,
          });
        }

        if (persistNewDiag && diagSnapshot) {
          this.sql`
            INSERT OR IGNORE INTO sh_pr_watch_diagnosis (
              watchId, head, snapshotJson, diagnosisJson, diagnosisStatus, createdAt, updatedAt
            )
            VALUES (
              ${claim.id},
              ${evidence.head},
              ${JSON.stringify(diagSnapshot)},
              ${diagValue ? JSON.stringify(diagValue) : null},
              ${diagStatus},
              ${tsNow},
              ${tsNow}
            )
          `;
        }

        if (persistFeedback && fbSnapshot) {
          this.sql`
            INSERT INTO sh_pr_watch_feedback (
              watchId, head, baseRef, baseSha, headRef, mergeState, reviewDecision, reviewCursor,
              snapshotJson, triageJson, triageStatus, updatedAt
            )
            VALUES (
              ${claim.id},
              ${fbSnapshot.head},
              ${fbSnapshot.baseRef},
              ${fbSnapshot.baseSha},
              ${fbSnapshot.headRef},
              ${fbSnapshot.mergeState},
              ${fbSnapshot.reviewDecision},
              ${fbSnapshot.reviewCursor},
              ${JSON.stringify(fbSnapshot)},
              ${fbTriage ? JSON.stringify(fbTriage) : null},
              ${fbTriageStatus},
              ${tsNow}
            )
            ON CONFLICT (watchId) DO UPDATE SET
              head = excluded.head,
              baseRef = excluded.baseRef,
              baseSha = excluded.baseSha,
              headRef = excluded.headRef,
              mergeState = excluded.mergeState,
              reviewDecision = excluded.reviewDecision,
              reviewCursor = excluded.reviewCursor,
              snapshotJson = excluded.snapshotJson,
              triageJson = excluded.triageJson,
              triageStatus = excluded.triageStatus,
              updatedAt = excluded.updatedAt
          `;
        }

        const limited = current.evidenceMode === 'statuses-only';
        const subject = limited ? 'commit statuses' : 'CI 检查';
        const limitedFooter = limited ? '\n仅验证 commit statuses；未验证 Checks/Actions，不代表完整 CI 通过。' : '';
        const watchRowWithHead = { ...current, head: evidence.head };

        // A) Merge conflict notification (breaks silent waiting & blocks premature completion)
        if (mergeConflicted && fbSnapshot) {
          const baseKey = (fbSnapshot.baseSha ?? fbSnapshot.baseRef ?? "base").slice(0, 12);
          const conflictNoticeId = `pr-watch:${claim.id}:${evidence.head}:conflict:${baseKey}`;
          const ciNote =
            evidence.state === "waiting"
              ? "（冲突可能阻断 PR 检查工作流启动，继续只读跟进）"
              : evidence.state === "success"
                ? `（${subject}已通过，但因合并冲突保持跟进）`
                : "";
          const fbDetail = formatPrFeedbackNoticeDetails({
            snapshot: fbSnapshot,
            triage: fbTriage,
            triageStatus: fbTriageStatus,
            url: current.url,
          });
          this.noticeByKey(
            watchRowWithHead,
            conflictNoticeId,
            "conflict",
            `PR 存在合并冲突${ciNote}\n${fbDetail}${limitedFooter}\n${current.url}\n提交 ${evidence.head}\n仅检查外部状态；未修改、重跑或合并。`,
          );
        }

        // B) Cursor-deduplicated review feedback notification (never re-alerts stale review on fix push)
        const hasNewReviewCursor =
          fbSnapshot !== null &&
          fbSnapshot.reviewCursor !== "0:0" &&
          fbSnapshot.reviewCursor !== (prevFeedback?.reviewCursor ?? "0:0");
        const shouldNotifyReview =
          hasNewReviewCursor &&
          fbSnapshot !== null &&
          (fbSnapshot.changesRequestedOnCurrentHead ||
            (watchGoal === "merged" &&
              (fbSnapshot.reviewDecision === "changes_requested" || fbSnapshot.reviewDecision === "commented")));

        if (shouldNotifyReview && fbSnapshot) {
          const reviewNoticeId = `pr-watch:${claim.id}:review:${fbSnapshot.reviewCursor}`;
          const fbDetail = formatPrFeedbackNoticeDetails({
            snapshot: fbSnapshot,
            triage: fbTriage,
            triageStatus: fbTriageStatus,
            url: current.url,
          });
          const header = fbSnapshot.changesRequestedOnCurrentHead
            ? "PR 审阅人要求修改代码，继续只读跟进"
            : "PR 收到新的代码评审意见，继续只读跟进";
          this.noticeByKey(
            watchRowWithHead,
            reviewNoticeId,
            "review",
            `${header}\n${fbDetail}${limitedFooter}\n${current.url}\n提交 ${evidence.head}\n仅检查外部状态；未修改、重跑或合并。`,
          );
        }

        // C) Standard CI / closed / merged state transition notification
        const suppressGreenForBlocker =
          evidence.state === "success" && (mergeConflicted || blockedByCurrentReview);
        if (
          evidence.state !== 'waiting' &&
          !suppressGreenForBlocker &&
          (current.head !== evidence.head || current.observedState !== evidence.state)
        ) {
          const label =
            evidence.state === 'success'
              ? watchGoal === "merged"
                ? `已观察到 ${subject}通过，继续只读跟进评审与合并状态（不代表需求验收通过）`
                : `已观察到 ${subject}通过（不代表需求验收通过）`
              : evidence.state === 'failure'
                ? `${subject}失败：${evidence.failed} 项失败、${evidence.pending} 项等待，继续只读跟进`
                : evidence.state === 'merged'
                  ? 'PR 已被合并，跟进结束'
                  : 'PR 已关闭，跟进结束';
          const detailBlock =
            evidence.state === 'failure' && diagSnapshot
              ? `\n${formatPrFailureNoticeDetails({
                  snapshot: diagSnapshot,
                  diagnosis: diagValue,
                  diagnosisStatus: diagStatus,
                  url: current.url,
                })}`
              : '';
          const staleReviewNote =
            evidence.state === 'success' &&
            fbSnapshot &&
            fbSnapshot.staleChangesRequestedReviewers.length > 0
              ? `\n审阅状态：等待 ${fbSnapshot.staleChangesRequestedReviewers.map((a) => `@${a}`).join('、')} 复审（上次要求修改针对旧提交）`
              : '';
          this.notice(
            watchRowWithHead,
            evidence.state,
            `${label}${detailBlock}${staleReviewNote}${limitedFooter}\n${current.url}\n提交 ${evidence.head}\n仅检查外部状态；未修改、重跑或合并。`,
          );
        }
      });
      if (pendingStuckAlert && this.deps.notifyStuck) {
        try {
          await this.deps.notifyStuck(pendingStuckAlert);
        } catch {
          // Stuck alert failure must not break read-only watch polling.
        }
      }
    }
    await this.deliver();
  }
  private async deliver(): Promise<void> {
    for (const notice of this.sql<Notice>`SELECT * FROM sh_pr_watch_notice WHERE deliveredAt IS NULL ORDER BY id LIMIT 20`) {
      const row = this.sql<PrWatchRow>`SELECT * FROM sh_pr_watch WHERE id = ${notice.watchId}`[0];
      if (!row || row.status === 'cancelled' || !this.deps.threadExists(row.threadId)) {
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
