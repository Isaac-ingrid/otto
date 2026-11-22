// Multi-day spend attribution, reconciliation, and Worker runtime telemetry (Direction D).
//
// Core invariants:
// 1. Dual-ledger isolation: Steward orchestrator model spend (`sh_usage_day` + `sh_usage_event`)
//    governs `DAILY_BUDGET_USD`; machine-side coding-agent usage (`sh_worker_usage`) is recorded
//    idempotently per `(workerId, seq)` and NEVER perturbs Steward's daily budget circuit breaker.
// 2. Reconciliation conservation: For every UTC day `d`, `sh_usage_day.costUsd` remains authoritative;
//    any historical or unattributed remainder lands in `unattributed = MAX(0, day.costUsd - sum(events))`
//    so stacked daily totals never drift, go negative, or drop pre-047 history.
// 3. Honest heterogeneous context telemetry: `contextPercent` is computed strictly when explicit or
//    when both `contextTokens >= 0` and `contextWindow > 0` are reported — never fabricated.
import { budgetDay, type BudgetConfig, type BudgetState } from "./budget.ts";
import type { LedgerDeps, LedgerSql } from "./ledger.ts";

export const SPEND_CATEGORIES = [
  "chat",
  "wake",
  "schedule",
  "pr_triage",
  "memory_skill",
  "unattributed",
] as const;

export type SpendCategory = (typeof SPEND_CATEGORIES)[number];
export type RecordedSpendCategory = Exclude<SpendCategory, "unattributed">;

export type SpendKind =
  | "user"
  | "verify"
  | "event"
  | "routine"
  | "followup"
  | "pr_ci"
  | "pr_review"
  | "checkpoint_distill"
  | "skill_triage"
  | "other";

export interface SpendAttribution {
  category: RecordedSpendCategory;
  kind: SpendKind;
  operationId?: string | null;
  threadId?: string | null;
  repoId?: string | null;
  workerId?: string | null;
  watchId?: string | null;
  provider?: string | null;
  modelId?: string | null;
}

export interface WorkerLiveTelemetry {
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  compactionCount: number | null;
  lastToolDurationMs: number | null;
}

export interface WorkerSettledUsageInput {
  workerId: string;
  seq: number;
  at: number;
  threadId: string;
  deviceId: string;
  repoId: string | null;
  agent: string;
  outcome: string;
  event: Record<string, unknown>;
}

export type TelemetryDays = 7 | 14 | 30;

export interface CategoryUsageBucket {
  costUsd: number;
  tokens: number;
}

export interface TelemetryDayPoint {
  day: string;
  totalCostUsd: number;
  totalTokens: number;
  skippedWakes: number;
  overLimit: boolean;
  byCategory: Record<SpendCategory, CategoryUsageBucket>;
  worker: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reportedCostUsd: number;
    settledRuns: number;
  };
}

export interface TelemetryThreadRankItem {
  threadId: string;
  title: string;
  archived: boolean;
  repos: string[];
  stewardCostUsd: number;
  stewardTokens: number;
  workerTokens: number;
  workerReportedCostUsd: number;
  lastActiveAt: number;
}

export interface TelemetryRepoRankItem {
  repoId: string;
  repoName: string;
  stewardCostUsd: number;
  stewardTokens: number;
  workerTokens: number;
  workerReportedCostUsd: number;
  workerRuns: number;
}

export interface WorkspaceTelemetryResponse {
  days: TelemetryDays;
  generatedAt: number;
  budget: {
    day: string;
    costUsd: number;
    tokens: number;
    limitUsd: number;
    over: boolean;
    skippedWakes: number;
    resetsAt: number;
  };
  totals: {
    stewardCostUsd: number;
    stewardTokens: number;
    skippedWakes: number;
    byCategory: Record<SpendCategory, CategoryUsageBucket>;
    workerTokens: number;
    workerReportedCostUsd: number;
    workerRuns: number;
  };
  series: TelemetryDayPoint[];
  topThreads: TelemetryThreadRankItem[];
  topRepos: TelemetryRepoRankItem[];
}

const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const USD_EPSILON = 1e-9;

function cleanUsd(value: number): number {
  if (!Number.isFinite(value) || value <= USD_EPSILON) return 0;
  return Math.round(value * 1e8) / 1e8;
}

function nonNegInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function posInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

export function emptyCategoryMap(): Record<SpendCategory, CategoryUsageBucket> {
  return {
    chat: { costUsd: 0, tokens: 0 },
    wake: { costUsd: 0, tokens: 0 },
    schedule: { costUsd: 0, tokens: 0 },
    pr_triage: { costUsd: 0, tokens: 0 },
    memory_skill: { costUsd: 0, tokens: 0 },
    unattributed: { costUsd: 0, tokens: 0 },
  };
}

export function parseTelemetryDays(raw: unknown): TelemetryDays | null {
  if (raw === undefined || raw === null || raw === "") return 7;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (n === 7 || n === 14 || n === 30) return n;
  return null;
}

export function utcDayRange(endAt: number, days: TelemetryDays): string[] {
  const endDayStr = budgetDay(endAt);
  const endMidnight = Date.parse(`${endDayStr}T00:00:00Z`);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(budgetDay(endMidnight - i * DAY_MS));
  }
  return out;
}

export function cutoffUtcDay(at: number, retentionDays = RETENTION_DAYS): string {
  const dayMidnight = Date.parse(`${budgetDay(at)}T00:00:00Z`);
  return budgetDay(dayMidnight - retentionDays * DAY_MS);
}

export function categoryForRunKind(runKind: string): { category: RecordedSpendCategory; kind: SpendKind } {
  switch (runKind) {
    case "user":
      return { category: "chat", kind: "user" };
    case "verify":
      return { category: "chat", kind: "verify" };
    case "event":
      return { category: "wake", kind: "event" };
    case "routine":
      return { category: "schedule", kind: "routine" };
    case "followup":
      return { category: "schedule", kind: "followup" };
    default:
      return { category: "wake", kind: "other" };
  }
}

function singleBoundRepoForThread(sql: LedgerSql, threadId: string | null): string | null {
  if (!threadId) return null;
  const rows = sql<{ repoId: string }>`
    SELECT repoId FROM sh_thread_repo WHERE threadId = ${threadId} LIMIT 2
  `;
  return rows.length === 1 ? rows[0]!.repoId : null;
}

/** Resolves category, threadId, and repoId for a settling `sh_run` row (including no-tool wakes). */
export function resolveRunAttribution(
  sql: LedgerSql,
  run: { operationId: string; kind: string; routedThreadId: string | null },
  model?: { provider?: string | null; modelId?: string | null },
): SpendAttribution {
  const mapped = categoryForRunKind(run.kind);
  let threadId: string | null = run.routedThreadId ?? null;
  let repoId: string | null = null;
  let workerId: string | null = null;

  if (run.kind === "routine") {
    const routine = sql<{ threadId: string | null; repoId: string | null }>`
      SELECT threadId, repoId FROM sh_routine WHERE lastFireKey = ${run.operationId} LIMIT 1
    `[0];
    if (routine) {
      threadId ??= routine.threadId;
      repoId ??= routine.repoId;
    }
  } else if (run.kind === "followup" && run.operationId.startsWith("followup:")) {
    const followupId = run.operationId.split(":")[1] ?? "";
    if (followupId) {
      const followup = sql<{ threadId: string | null }>`
        SELECT threadId FROM sh_followup WHERE followupId = ${followupId} LIMIT 1
      `[0];
      if (followup) threadId ??= followup.threadId;
    }
  } else if (run.kind === "event" && !threadId) {
    const wake = sql<{ dedupeKey: string }>`
      SELECT dedupeKey FROM sh_wake WHERE operationId = ${run.operationId} LIMIT 1
    `[0];
    const dedupe = wake?.dedupeKey ?? "";
    const workerMatch = /^(?:report|settled|proposal):([^:]+):/.exec(dedupe);
    if (workerMatch?.[1]) {
      const w = sql<{ workerId: string; threadId: string; repoId: string | null }>`
        SELECT workerId, threadId, repoId FROM sh_worker WHERE workerId = ${workerMatch[1]} LIMIT 1
      `[0];
      if (w) {
        workerId = w.workerId;
        threadId = w.threadId;
        repoId = w.repoId;
      }
    } else if (dedupe.startsWith("question:")) {
      const qid = dedupe.slice("question:".length);
      const q = sql<{ threadId: string | null; workerId: string | null }>`
        SELECT threadId, workerId FROM sh_question WHERE qid = ${qid} LIMIT 1
      `[0];
      if (q) {
        threadId = q.threadId;
        workerId = q.workerId;
      }
    }
  }

  repoId ??= singleBoundRepoForThread(sql, threadId);

  return {
    category: mapped.category,
    kind: mapped.kind,
    operationId: run.operationId,
    threadId,
    repoId,
    workerId,
    provider: model?.provider ?? null,
    modelId: model?.modelId ?? null,
  };
}

/** Resolves threadId, repoId, and watchId for out-of-band PR CI or review triage LLM calls. */
export function resolvePrAttribution(
  sql: LedgerSql,
  prUrl: string,
  kind: "pr_ci" | "pr_review",
): SpendAttribution {
  const watch = sql<{ id: string; threadId: string | null }>`
    SELECT id, threadId FROM sh_pr_watch
    WHERE url = ${prUrl}
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, createdAt DESC
    LIMIT 1
  `[0];
  const threadId = watch?.threadId ?? null;
  const repoId = singleBoundRepoForThread(sql, threadId);
  return {
    category: "pr_triage",
    kind,
    threadId,
    repoId,
    watchId: watch?.id ?? null,
  };
}

/** Extracts validated context-window, compaction, and tool timing metrics from a `progress` or `settled` event. */
export function extractWorkerLiveTelemetry(event: Record<string, unknown>): WorkerLiveTelemetry {
  const rawTel =
    typeof event.telemetry === "object" && event.telemetry !== null && !Array.isArray(event.telemetry)
      ? (event.telemetry as Record<string, unknown>)
      : null;
  const rawUsage =
    typeof event.usage === "object" && event.usage !== null && !Array.isArray(event.usage)
      ? (event.usage as Record<string, unknown>)
      : null;
  const rawCu =
    rawUsage && typeof rawUsage.contextUsage === "object" && rawUsage.contextUsage !== null && !Array.isArray(rawUsage.contextUsage)
      ? (rawUsage.contextUsage as Record<string, unknown>)
      : null;

  const contextTokens = nonNegInt(rawTel?.contextTokens) ?? nonNegInt(rawCu?.tokens);
  const contextWindow = posInt(rawTel?.contextWindow) ?? posInt(rawCu?.contextWindow);

  let rawPercent: number | null = null;
  if (typeof rawTel?.contextPercent === "number" && Number.isFinite(rawTel.contextPercent) && rawTel.contextPercent >= 0) {
    rawPercent = rawTel.contextPercent;
  } else if (typeof rawCu?.percent === "number" && Number.isFinite(rawCu.percent) && rawCu.percent >= 0) {
    rawPercent = rawCu.percent;
  } else if (contextTokens !== null && contextWindow !== null && contextWindow > 0) {
    rawPercent = (contextTokens / contextWindow) * 100;
  }

  const contextPercent = rawPercent !== null ? Math.max(0, Math.min(100, Math.round(rawPercent))) : null;
  const compactionCount = nonNegInt(rawTel?.compactionCount);
  const lastToolDurationMs = nonNegInt(rawTel?.lastToolMs ?? rawTel?.lastToolDurationMs);

  return {
    contextTokens,
    contextWindow,
    contextPercent,
    compactionCount,
    lastToolDurationMs,
  };
}

/** Extracts single-turn incremental Worker token and dollar usage at settlement (`turnUsage` preferred over `usage`). */
export function extractWorkerSettledUsage(event: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  hasAny: boolean;
} {
  const source =
    (typeof event.turnUsage === "object" && event.turnUsage !== null && !Array.isArray(event.turnUsage)
      ? (event.turnUsage as Record<string, unknown>)
      : null) ??
    (typeof event.usage === "object" && event.usage !== null && !Array.isArray(event.usage)
      ? (event.usage as Record<string, unknown>)
      : null);

  if (!source) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null, hasAny: false };
  }

  const tokensObj =
    typeof source.tokens === "object" && source.tokens !== null && !Array.isArray(source.tokens)
      ? (source.tokens as Record<string, unknown>)
      : null;

  const inputTokens = nonNegInt(tokensObj?.input) ?? 0;
  const outputTokens = nonNegInt(tokensObj?.output) ?? 0;
  const explicitTotal = nonNegInt(tokensObj?.totalTokens);
  const totalTokens = explicitTotal !== null ? Math.max(explicitTotal, inputTokens + outputTokens) : inputTokens + outputTokens;

  let costUsd: number | null = null;
  if (typeof source.cost === "number" && Number.isFinite(source.cost) && source.cost >= 0) {
    costUsd = cleanUsd(source.cost);
  } else if (
    typeof source.cost === "object" &&
    source.cost !== null &&
    typeof (source.cost as Record<string, unknown>).total === "number"
  ) {
    const nested = (source.cost as Record<string, unknown>).total as number;
    if (Number.isFinite(nested) && nested >= 0) costUsd = cleanUsd(nested);
  }

  const hasAny = totalTokens > 0 || inputTokens > 0 || outputTokens > 0 || costUsd !== null;
  return { inputTokens, outputTokens, totalTokens, costUsd, hasAny };
}

/** Applies non-null live context/compaction/tool-duration telemetry onto `sh_worker`. */
export function updateWorkerTelemetryColumns(sql: LedgerSql, workerId: string, tel: WorkerLiveTelemetry): void {
  if (
    tel.contextPercent === null &&
    tel.contextTokens === null &&
    tel.contextWindow === null &&
    tel.compactionCount === null &&
    tel.lastToolDurationMs === null
  ) {
    return;
  }
  sql`
    UPDATE sh_worker
    SET contextPercent = COALESCE(${tel.contextPercent}, contextPercent),
        contextTokens = COALESCE(${tel.contextTokens}, contextTokens),
        contextWindow = COALESCE(${tel.contextWindow}, contextWindow),
        compactionCount = CASE
          WHEN ${tel.compactionCount} IS NULL THEN compactionCount
          WHEN ${tel.compactionCount} > compactionCount THEN ${tel.compactionCount}
          ELSE compactionCount
        END,
        lastToolDurationMs = COALESCE(${tel.lastToolDurationMs}, lastToolDurationMs)
    WHERE workerId = ${workerId}
  `;
}

export function insertUsageEvent(
  sql: LedgerSql,
  delta: { costUsd: number; tokens: number },
  at: number,
  attribution: SpendAttribution,
): void {
  const costUsd = cleanUsd(delta.costUsd);
  const tokens = Math.max(0, Math.round(delta.tokens));
  if (!(costUsd > 0) && !(tokens > 0)) return;
  const day = budgetDay(at);
  sql`
    INSERT INTO sh_usage_event (
      day, at, category, kind, operationId, threadId, repoId, workerId, watchId, provider, modelId, costUsd, tokens
    ) VALUES (
      ${day},
      ${at},
      ${attribution.category},
      ${attribution.kind},
      ${attribution.operationId ?? null},
      ${attribution.threadId ?? null},
      ${attribution.repoId ?? null},
      ${attribution.workerId ?? null},
      ${attribution.watchId ?? null},
      ${attribution.provider ?? null},
      ${attribution.modelId ?? null},
      ${costUsd},
      ${tokens}
    )
  `;
}

export function pruneOldTelemetryRows(sql: LedgerSql, at: number): void {
  const cutoff = cutoffUtcDay(at, RETENTION_DAYS);
  sql`DELETE FROM sh_usage_event WHERE day < ${cutoff}`;
  sql`DELETE FROM sh_worker_usage WHERE day < ${cutoff}`;
}

export function createTelemetry({
  sql,
  now = Date.now,
}: Pick<LedgerDeps, "sql" | "now">) {
  let lastPrunedDay = "";

  const maybePrune = (at: number): void => {
    const today = budgetDay(at);
    if (today === lastPrunedDay) return;
    lastPrunedDay = today;
    pruneOldTelemetryRows(sql, at);
  };

  return {
    resolveRunAttribution(
      run: { operationId: string; kind: string; routedThreadId: string | null },
      model?: { provider?: string | null; modelId?: string | null },
    ): SpendAttribution {
      return resolveRunAttribution(sql, run, model);
    },

    resolvePrAttribution(prUrl: string, kind: "pr_ci" | "pr_review"): SpendAttribution {
      return resolvePrAttribution(sql, prUrl, kind);
    },

    recordWorkerSettled(input: WorkerSettledUsageInput): void {
      const tel = extractWorkerLiveTelemetry(input.event);
      updateWorkerTelemetryColumns(sql, input.workerId, tel);

      const parsed = extractWorkerSettledUsage(input.event);
      if (!parsed.hasAny) return;

      maybePrune(input.at);
      const resolvedRepoId = input.repoId ?? singleBoundRepoForThread(sql, input.threadId);
      sql`
        INSERT OR IGNORE INTO sh_worker_usage (
          workerId, seq, day, at, threadId, deviceId, repoId, agent, outcome,
          inputTokens, outputTokens, totalTokens, costUsd
        ) VALUES (
          ${input.workerId},
          ${input.seq},
          ${budgetDay(input.at)},
          ${input.at},
          ${input.threadId},
          ${input.deviceId},
          ${resolvedRepoId},
          ${input.agent},
          ${input.outcome},
          ${parsed.inputTokens},
          ${parsed.outputTokens},
          ${parsed.totalTokens},
          ${parsed.costUsd}
        )
      `;
    },

    query(options: {
      days?: TelemetryDays;
      budgetState: BudgetState;
      budgetConfig?: BudgetConfig;
      at?: number;
    }): WorkspaceTelemetryResponse {
      const days: TelemetryDays = options.days ?? 7;
      const generatedAt = options.at ?? now();
      const dayKeys = utcDayRange(generatedAt, days);
      const startDay = dayKeys[0]!;
      const endDay = dayKeys[dayKeys.length - 1]!;
      const limitUsd = options.budgetConfig?.usd ?? options.budgetState.budgetUsd;

      const dayRows = new Map(
        sql<{ day: string; costUsd: number; tokens: number; skippedWakes: number }>`
          SELECT day, costUsd, tokens, skippedWakes
          FROM sh_usage_day
          WHERE day >= ${startDay} AND day <= ${endDay}
        `.map((r) => [r.day, r]),
      );

      const eventBuckets = sql<{
        day: string;
        category: string;
        costUsd: number;
        tokens: number;
      }>`
        SELECT day, category, COALESCE(SUM(costUsd), 0) AS costUsd, COALESCE(SUM(tokens), 0) AS tokens
        FROM sh_usage_event
        WHERE day >= ${startDay} AND day <= ${endDay}
        GROUP BY day, category
      `;

      const workerDayRows = new Map(
        sql<{
          day: string;
          totalTokens: number;
          inputTokens: number;
          outputTokens: number;
          reportedCostUsd: number;
          settledRuns: number;
        }>`
          SELECT
            day,
            COALESCE(SUM(totalTokens), 0) AS totalTokens,
            COALESCE(SUM(inputTokens), 0) AS inputTokens,
            COALESCE(SUM(outputTokens), 0) AS outputTokens,
            COALESCE(SUM(COALESCE(costUsd, 0)), 0) AS reportedCostUsd,
            COUNT(*) AS settledRuns
          FROM sh_worker_usage
          WHERE day >= ${startDay} AND day <= ${endDay}
          GROUP BY day
        `.map((r) => [r.day, r]),
      );

      const perDayCats = new Map<string, Record<SpendCategory, CategoryUsageBucket>>();
      for (const d of dayKeys) perDayCats.set(d, emptyCategoryMap());

      const validRecorded = new Set<string>(["chat", "wake", "schedule", "pr_triage", "memory_skill"]);
      for (const row of eventBuckets) {
        const map = perDayCats.get(row.day);
        if (!map) continue;
        const cat: SpendCategory = validRecorded.has(row.category)
          ? (row.category as RecordedSpendCategory)
          : "unattributed";
        map[cat].costUsd = cleanUsd(map[cat].costUsd + row.costUsd);
        map[cat].tokens += Math.max(0, Math.round(row.tokens));
      }

      const totalsByCategory = emptyCategoryMap();
      let stewardCostUsd = 0;
      let stewardTokens = 0;
      let totalSkippedWakes = 0;
      let totalWorkerTokens = 0;
      let totalWorkerReportedCostUsd = 0;
      let totalWorkerRuns = 0;

      const series: TelemetryDayPoint[] = dayKeys.map((day) => {
        const byCategory = perDayCats.get(day)!;
        const dayRow = dayRows.get(day);

        let attributedCost = 0;
        let attributedTokens = 0;
        for (const cat of SPEND_CATEGORIES) {
          attributedCost += byCategory[cat].costUsd;
          attributedTokens += byCategory[cat].tokens;
        }
        attributedCost = cleanUsd(attributedCost);

        const rawDayCost = cleanUsd(dayRow?.costUsd ?? 0);
        const rawDayTokens = Math.max(0, Math.round(dayRow?.tokens ?? 0));

        // Reconciliation invariant: fill any gap between `sh_usage_day` and `sh_usage_event`
        // into `unattributed` so pre-047 history or unattributed cursor syncs stay exact.
        const gapCost = cleanUsd(rawDayCost - attributedCost);
        const gapTokens = Math.max(0, rawDayTokens - attributedTokens);
        if (gapCost > 0 || gapTokens > 0) {
          byCategory.unattributed.costUsd = cleanUsd(byCategory.unattributed.costUsd + gapCost);
          byCategory.unattributed.tokens += gapTokens;
        }

        const pointTotalCost = cleanUsd(Math.max(rawDayCost, attributedCost));
        const pointTotalTokens = Math.max(rawDayTokens, attributedTokens);
        const skippedWakes = Math.max(0, Math.round(dayRow?.skippedWakes ?? 0));

        for (const cat of SPEND_CATEGORIES) {
          totalsByCategory[cat].costUsd = cleanUsd(totalsByCategory[cat].costUsd + byCategory[cat].costUsd);
          totalsByCategory[cat].tokens += byCategory[cat].tokens;
        }
        stewardCostUsd = cleanUsd(stewardCostUsd + pointTotalCost);
        stewardTokens += pointTotalTokens;
        totalSkippedWakes += skippedWakes;

        const w = workerDayRows.get(day);
        const worker = {
          totalTokens: Math.max(0, Math.round(w?.totalTokens ?? 0)),
          inputTokens: Math.max(0, Math.round(w?.inputTokens ?? 0)),
          outputTokens: Math.max(0, Math.round(w?.outputTokens ?? 0)),
          reportedCostUsd: cleanUsd(w?.reportedCostUsd ?? 0),
          settledRuns: Math.max(0, Math.round(w?.settledRuns ?? 0)),
        };
        totalWorkerTokens += worker.totalTokens;
        totalWorkerReportedCostUsd = cleanUsd(totalWorkerReportedCostUsd + worker.reportedCostUsd);
        totalWorkerRuns += worker.settledRuns;

        return {
          day,
          totalCostUsd: pointTotalCost,
          totalTokens: pointTotalTokens,
          skippedWakes,
          overLimit: pointTotalCost >= limitUsd,
          byCategory,
          worker,
        };
      });

      // Aggregate Top 10 Threads across Steward spend events & Worker usage within [startDay..endDay].
      const stewardByThread = sql<{
        threadId: string;
        costUsd: number;
        tokens: number;
        lastAt: number;
      }>`
        SELECT
          threadId,
          COALESCE(SUM(costUsd), 0) AS costUsd,
          COALESCE(SUM(tokens), 0) AS tokens,
          COALESCE(MAX(at), 0) AS lastAt
        FROM sh_usage_event
        WHERE day >= ${startDay} AND day <= ${endDay} AND threadId IS NOT NULL
        GROUP BY threadId
      `;

      const workerByThread = sql<{
        threadId: string;
        tokens: number;
        costUsd: number;
        lastAt: number;
      }>`
        SELECT
          threadId,
          COALESCE(SUM(totalTokens), 0) AS tokens,
          COALESCE(SUM(COALESCE(costUsd, 0)), 0) AS costUsd,
          COALESCE(MAX(at), 0) AS lastAt
        FROM sh_worker_usage
        WHERE day >= ${startDay} AND day <= ${endDay}
        GROUP BY threadId
      `;

      const threadAgg = new Map<string, {
        stewardCostUsd: number;
        stewardTokens: number;
        workerTokens: number;
        workerReportedCostUsd: number;
        lastActiveAt: number;
      }>();

      for (const r of stewardByThread) {
        threadAgg.set(r.threadId, {
          stewardCostUsd: cleanUsd(r.costUsd),
          stewardTokens: Math.max(0, Math.round(r.tokens)),
          workerTokens: 0,
          workerReportedCostUsd: 0,
          lastActiveAt: r.lastAt,
        });
      }
      for (const r of workerByThread) {
        const cur = threadAgg.get(r.threadId) ?? {
          stewardCostUsd: 0,
          stewardTokens: 0,
          workerTokens: 0,
          workerReportedCostUsd: 0,
          lastActiveAt: 0,
        };
        cur.workerTokens += Math.max(0, Math.round(r.tokens));
        cur.workerReportedCostUsd = cleanUsd(cur.workerReportedCostUsd + r.costUsd);
        if (r.lastAt > cur.lastActiveAt) cur.lastActiveAt = r.lastAt;
        threadAgg.set(r.threadId, cur);
      }

      const sortedThreadIds = [...threadAgg.entries()]
        .sort(([, a], [, b]) =>
          b.stewardCostUsd - a.stewardCostUsd ||
          b.workerTokens - a.workerTokens ||
          b.stewardTokens - a.stewardTokens ||
          b.lastActiveAt - a.lastActiveAt,
        )
        .slice(0, 10);

      const topThreads: TelemetryThreadRankItem[] = sortedThreadIds.map(([threadId, agg]) => {
        const meta = sql<{ title: string; archived: number }>`
          SELECT title, archived FROM sh_thread WHERE threadId = ${threadId} LIMIT 1
        `[0];
        const repos = sql<{ name: string }>`
          SELECT DISTINCT COALESCE(r.name, tr.repoId) AS name
          FROM sh_thread_repo tr
          LEFT JOIN sh_repo r ON r.repoId = tr.repoId
          WHERE tr.threadId = ${threadId}
          ORDER BY name
        `.map((row) => row.name);

        return {
          threadId,
          title: meta?.title ?? threadId,
          archived: Boolean(meta?.archived),
          repos,
          stewardCostUsd: agg.stewardCostUsd,
          stewardTokens: agg.stewardTokens,
          workerTokens: agg.workerTokens,
          workerReportedCostUsd: agg.workerReportedCostUsd,
          lastActiveAt: agg.lastActiveAt,
        };
      });

      // Aggregate Top 10 Repos across Steward spend events & Worker usage within [startDay..endDay].
      const stewardByRepo = sql<{ repoId: string; costUsd: number; tokens: number }>`
        SELECT
          repoId,
          COALESCE(SUM(costUsd), 0) AS costUsd,
          COALESCE(SUM(tokens), 0) AS tokens
        FROM sh_usage_event
        WHERE day >= ${startDay} AND day <= ${endDay} AND repoId IS NOT NULL
        GROUP BY repoId
      `;

      const workerByRepo = sql<{ repoId: string; tokens: number; costUsd: number; runs: number }>`
        SELECT
          repoId,
          COALESCE(SUM(totalTokens), 0) AS tokens,
          COALESCE(SUM(COALESCE(costUsd, 0)), 0) AS costUsd,
          COUNT(*) AS runs
        FROM sh_worker_usage
        WHERE day >= ${startDay} AND day <= ${endDay} AND repoId IS NOT NULL
        GROUP BY repoId
      `;

      const repoAgg = new Map<string, {
        stewardCostUsd: number;
        stewardTokens: number;
        workerTokens: number;
        workerReportedCostUsd: number;
        workerRuns: number;
      }>();

      for (const r of stewardByRepo) {
        repoAgg.set(r.repoId, {
          stewardCostUsd: cleanUsd(r.costUsd),
          stewardTokens: Math.max(0, Math.round(r.tokens)),
          workerTokens: 0,
          workerReportedCostUsd: 0,
          workerRuns: 0,
        });
      }
      for (const r of workerByRepo) {
        const cur = repoAgg.get(r.repoId) ?? {
          stewardCostUsd: 0,
          stewardTokens: 0,
          workerTokens: 0,
          workerReportedCostUsd: 0,
          workerRuns: 0,
        };
        cur.workerTokens += Math.max(0, Math.round(r.tokens));
        cur.workerReportedCostUsd = cleanUsd(cur.workerReportedCostUsd + r.costUsd);
        cur.workerRuns += Math.max(0, Math.round(r.runs));
        repoAgg.set(r.repoId, cur);
      }

      const sortedRepos = [...repoAgg.entries()]
        .sort(([idA, a], [idB, b]) =>
          b.workerTokens - a.workerTokens ||
          b.stewardCostUsd - a.stewardCostUsd ||
          b.workerReportedCostUsd - a.workerReportedCostUsd ||
          b.stewardTokens - a.stewardTokens ||
          idA.localeCompare(idB),
        )
        .slice(0, 10);

      const topRepos: TelemetryRepoRankItem[] = sortedRepos.map(([repoId, agg]) => {
        const repoRow = sql<{ name: string }>`
          SELECT name FROM sh_repo WHERE repoId = ${repoId} LIMIT 1
        `[0];
        const fallbackName = repoId.split("/").filter(Boolean).pop() ?? repoId;
        return {
          repoId,
          repoName: repoRow?.name ?? fallbackName,
          stewardCostUsd: agg.stewardCostUsd,
          stewardTokens: agg.stewardTokens,
          workerTokens: agg.workerTokens,
          workerReportedCostUsd: agg.workerReportedCostUsd,
          workerRuns: agg.workerRuns,
        };
      });

      return {
        days,
        generatedAt,
        budget: {
          day: options.budgetState.day,
          costUsd: cleanUsd(options.budgetState.costUsd),
          tokens: Math.max(0, Math.round(options.budgetState.tokens)),
          limitUsd,
          over: options.budgetState.over,
          skippedWakes: options.budgetState.skippedWakes,
          resetsAt: options.budgetState.resetsAt,
        },
        totals: {
          stewardCostUsd,
          stewardTokens,
          skippedWakes: totalSkippedWakes,
          byCategory: totalsByCategory,
          workerTokens: totalWorkerTokens,
          workerReportedCostUsd: totalWorkerReportedCostUsd,
          workerRuns: totalWorkerRuns,
        },
        series,
        topThreads,
        topRepos,
      };
    },
  };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
