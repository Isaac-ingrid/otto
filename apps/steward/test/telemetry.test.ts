// Stage 1 unit & DO integration tests for Direction D:
// - `047_telemetry_and_worker_context` migration & `sh_worker` live telemetry columns
// - Steward 5-category spend attribution (`chat`, `wake`, `schedule`, `pr_triage`, `memory_skill`)
// - Reconciliation conservation invariant (`unattributed` gap filling for pre-047 history)
// - Dual-ledger physical isolation (`sh_worker_usage` never trips `DAILY_BUDGET_USD`) & `(workerId, seq)` replay idempotency
// - `$0` free/unpriced Steward models & subscription-CLI (`costUsd: null`) Worker ranking + 90-day retention pruning
import { SELF, runInDurableObject } from "cloudflare:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { applyThreadState } from "../ui/thread-frames.js";
import { beforeEach, describe, expect, it } from "vitest";
import { budgetDay, resolveBudgetConfig } from "../src/budget.ts";
import type { Ledger, LedgerSql } from "../src/ledger.ts";
import { MIGRATIONS, runMigrations } from "../src/schema.ts";
import type { Steward } from "../src/steward.ts";
import {
  extractWorkerLiveTelemetry,
  parseTelemetryDays,
  pruneOldTelemetryRows,
  resolvePrAttribution,
  resolveRunAttribution,
} from "../src/telemetry.ts";
import {
  configureAndBind,
  connectWeb,
  messageEvent,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitForWorkerState,
  waitRunsSettled,
  webLogin,
} from "./helpers.ts";

const ghPrUrl = (owner: string, repo: string, num: number): string =>
  ["https:", "", "github.com", owner, repo, "pull", String(num)].join("/");

async function waitWorkerPredicate(
  workerId: string,
  pred: (w: NonNullable<ReturnType<Ledger["workers"]["get"]>>) => boolean,
  timeoutMs = 5_000,
): Promise<NonNullable<ReturnType<Ledger["workers"]["get"]>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const w = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      return ledger.workers.get(workerId);
    });
    if (w && pred(w)) return w;
    if (Date.now() > deadline) throw new Error(`worker predicate timed out: ${JSON.stringify(w)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
  await ownerStub().setBudgetForTest(undefined);
  await ownerStub().resetBudgetForTest();
});

describe("047_telemetry_and_worker_context migration and live Worker telemetry", () => {
  it("applies 047 idempotently and updates live context/compaction/tool-duration on progress without fabricating missing windows", async () => {
    const fake = await pairFakeConnector("mac-studio", { autorun: false });
    await fake.connect();

    await ownerStub().dispatchForTest({
      prompt: "排查慢查询并重构索引",
      repoRef: "repo-a",
      newTitle: "慢查询重构",
    });
    const [startCmd] = await fake.waitForCmds(1);
    const workerId = String((startCmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: startCmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: startCmd!.id, ok: true, data: { sessionId: workerId, cwd: "/srv/repo-a" } });
    await fake.emit("started", workerId, { sessionId: workerId, cwd: "/srv/repo-a" });
    await waitForWorkerState("running");

    // 1) Progress with tokens ONLY and no contextWindow (e.g. Codex CLI): contextPercent must stay null!
    await fake.emit("progress", workerId, {
      phase: "tool",
      tool: "Bash",
      target: "vitest run",
      turn: 1,
      telemetry: {
        contextTokens: 48_000,
        compactionCount: 1,
        lastToolMs: 4250,
      },
    });

    const w1 = await waitWorkerPredicate(workerId, (w) => w.contextTokens === 48_000);
    expect(w1.state).toBe("running");
    expect(w1.contextWindow).toBeNull();
    expect(w1.contextPercent).toBeNull();
    expect(w1.compactionCount).toBe(1);
    expect(w1.lastToolDurationMs).toBe(4250);

    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: LedgerSql }).sql.bind(instance);
      expect(() => runMigrations(sql, MIGRATIONS)).not.toThrow();
    });

    // 2) Next progress reports full window + higher compactionCount; stale lower compactionCount never regresses.
    await fake.emit("progress", workerId, {
      phase: "thinking",
      turn: 2,
      telemetry: {
        contextTokens: 170_000,
        contextWindow: 200_000,
        compactionCount: 2,
      },
    });
    await fake.emit("progress", workerId, {
      phase: "tool",
      tool: "Read",
      target: "src/index.ts",
      turn: 2,
      telemetry: {
        compactionCount: 1,
        lastToolMs: 810,
      },
    });

    const w2 = await waitWorkerPredicate(workerId, (w) => w.lastToolDurationMs === 810);
    expect(w2.contextTokens).toBe(170_000);
    expect(w2.contextWindow).toBe(200_000);
    expect(w2.contextPercent).toBe(85);
    expect(w2.compactionCount).toBe(2);

    expect(extractWorkerLiveTelemetry({ telemetry: { contextPercent: 142 } }).contextPercent).toBe(100);
    expect(parseTelemetryDays(undefined)).toBe(7);
    expect(parseTelemetryDays("14")).toBe(14);
    expect(parseTelemetryDays(30)).toBe(30);
    expect(parseTelemetryDays(9)).toBeNull();

    fake.close();
  });
});

describe("Steward 5-category spend attribution and reconciliation conservation", () => {
  it("attributes chat, wake, schedule, pr_triage, and memory_skill accurately and reconciles pre-047 unattributed gaps", async () => {
    // Exercise a real end-to-end Steward LLM turn (`faux` reports tokens > 0, $0 cost) through pollRuns.
    await scriptModel(fauxAssistantMessage([fauxText("当前一切正常。")]));
    await postEvent(messageEvent({ msgId: "om_tel_user_1", text: "汇报一下当前状态" }));
    await waitRunsSettled();

    const baseNow = Date.parse("2026-11-22T12:00:00Z");
    const dayMinus3 = Date.parse("2026-11-19T08:00:00Z");
    const dayMinus1 = Date.parse("2026-11-21T15:00:00Z");

    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: LedgerSql }).sql.bind(instance);
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const prUrl = ghPrUrl("acme", "otto", 108);

      // Verify the live faux user turn recorded a `chat` (`kind = 'user'`) event with >0 tokens.
      const liveChatEvents = sql<{ category: string; kind: string; tokens: number }>`
        SELECT category, kind, tokens FROM sh_usage_event WHERE kind = 'user'
      `;
      expect(liveChatEvents.length).toBeGreaterThanOrEqual(1);
      expect(liveChatEvents[0]!.category).toBe("chat");
      expect(liveChatEvents[0]!.tokens).toBeGreaterThan(0);

      // Reset to a deterministic baseline at `baseNow` to verify multi-day math and all 5 categories.
      await instance.resetBudgetForTest();

      // Seed repos, threads, worker, routine, followup, wake, and PR watch for attribution resolution.
      sql`INSERT INTO sh_repo (repoId, deviceId, name, path, defaultBranch, updatedAt) VALUES ('/srv/repo-core', 'dev_1', 'repo-core', '/srv/repo-core', 'main', ${baseNow})`;
      const tMain = ledger.threads.create({ title: "重构核心账本", goal: "遥测闭环", repoIds: ["/srv/repo-core"] });
      const tSched = ledger.threads.create({ title: "每日巡检", goal: "例行构建检查", repoIds: ["/srv/repo-core"] });
      sql`
        INSERT INTO sh_worker (workerId, threadId, deviceId, repoId, agent, mode, state, createdAt, updatedAt)
        VALUES ('w_core_1', ${tMain.threadId}, 'dev_1', '/srv/repo-core', 'pi', 'write', 'idle', ${baseNow}, ${baseNow})
      `;
      sql`
        INSERT INTO sh_wake (operationId, kind, dedupeKey, text, priority, status, dueAt, createdAt)
        VALUES ('wake:evt_1', 'event', 'report:w_core_1:1', 'worker reported', 'normal', 'submitted', ${baseNow}, ${baseNow})
      `;
      ledger.routines.create({
        routineId: "rt_daily",
        kind: "instruction",
        createdFromMsg: "om_1",
        scheduleKind: "cron",
        cron: "0 9 * * *",
        instruction: "检查 CI",
        threadId: tSched.threadId,
        repoId: "/srv/repo-core",
      });
      ledger.routines.beginFire("rt_daily", "routine:rt_daily:100", "running");
      sql`
        INSERT INTO sh_followup (followupId, threadId, createdBy, sourceRef, dueAt, reason, status, createdAt)
        VALUES ('fu_1', ${tSched.threadId}, 'steward', 'om_1', ${baseNow}, '复查部署', 'fired', ${baseNow})
      `;
      sql`
        INSERT INTO sh_pr_watch (id, threadId, url, status, createdAt, expiresAt, intervalMs, nextCheckAt)
        VALUES ('pw_108', ${tMain.threadId}, ${prUrl}, 'active', ${baseNow}, ${baseNow + 86_400_000}, 60000, ${baseNow + 60000})
      `;

      // 1) Pre-047 historical day (`dayMinus3`): raw `sh_usage_day` spend with ZERO `sh_usage_event` rows.
      ledger.budget.add({ costUsd: 0.42, tokens: 12_000 }, dayMinus3);

      // 2) Mixed day (`dayMinus1`): $0.30 raw unattributed + $0.15 `pr_triage` + $0.10 `memory_skill` = $0.55 total.
      ledger.budget.add({ costUsd: 0.30, tokens: 8_000 }, dayMinus1);
      ledger.budget.add(
        { costUsd: 0.15, tokens: 4_500 },
        dayMinus1,
        resolvePrAttribution(sql, prUrl, "pr_ci"),
      );
      ledger.budget.add(
        { costUsd: 0.10, tokens: 3_000 },
        dayMinus1,
        {
          category: "memory_skill",
          kind: "checkpoint_distill",
          threadId: tMain.threadId,
          repoId: "/srv/repo-core",
          workerId: "w_core_1",
        },
      );

      // 3) Today (`baseNow`): cumulative `pi.usage` observations for `chat`, `wake`, `schedule` (`routine` + `followup`).
      ledger.budget.observe(
        { costUsd: 0.12, tokens: 3_200 },
        baseNow,
        resolveRunAttribution(sql, { operationId: "user:msg_1", kind: "user", routedThreadId: tMain.threadId }),
      );
      ledger.budget.observe(
        { costUsd: 0.20, tokens: 5_200 },
        baseNow,
        resolveRunAttribution(sql, { operationId: "wake:evt_1", kind: "event", routedThreadId: null }),
      );
      ledger.budget.observe(
        { costUsd: 0.27, tokens: 7_000 },
        baseNow,
        resolveRunAttribution(sql, { operationId: "routine:rt_daily:100", kind: "routine", routedThreadId: null }),
      );
      ledger.budget.observe(
        { costUsd: 0.31, tokens: 8_100 },
        baseNow,
        resolveRunAttribution(sql, { operationId: "followup:fu_1:200", kind: "followup", routedThreadId: null }),
      );

      const budgetConfig = resolveBudgetConfig(1.0);
      const budgetState = ledger.budget.state(budgetConfig, baseNow);
      const report = ledger.telemetry.query({
        days: 7,
        budgetState,
        budgetConfig,
        at: baseNow,
      });

      expect(report.series).toHaveLength(7);
      expect(report.series.map((p) => p.day)).toEqual([
        "2026-11-16",
        "2026-11-17",
        "2026-11-18",
        "2026-11-19",
        "2026-11-20",
        "2026-11-21",
        "2026-11-22",
      ]);

      // Day -3 (`2026-11-19`): 100% conserved in `unattributed`.
      const pMinus3 = report.series.find((p) => p.day === budgetDay(dayMinus3))!;
      expect(pMinus3.totalCostUsd).toBeCloseTo(0.42, 6);
      expect(pMinus3.byCategory.unattributed.costUsd).toBeCloseTo(0.42, 6);
      expect(pMinus3.byCategory.unattributed.tokens).toBe(12_000);

      // Day -1 (`2026-11-21`): $0.30 unattributed + $0.15 pr_triage + $0.10 memory_skill === $0.55.
      const pMinus1 = report.series.find((p) => p.day === budgetDay(dayMinus1))!;
      expect(pMinus1.totalCostUsd).toBeCloseTo(0.55, 6);
      expect(pMinus1.byCategory.unattributed.costUsd).toBeCloseTo(0.30, 6);
      expect(pMinus1.byCategory.pr_triage.costUsd).toBeCloseTo(0.15, 6);
      expect(pMinus1.byCategory.memory_skill.costUsd).toBeCloseTo(0.10, 6);

      // Today (`2026-11-22`): $0.12 chat + $0.08 wake + $0.11 schedule ($0.07 routine + $0.04 followup) === $0.31, 0 unattributed!
      const pToday = report.series.find((p) => p.day === budgetDay(baseNow))!;
      expect(pToday.totalCostUsd).toBeCloseTo(0.31, 6);
      expect(pToday.byCategory.chat.costUsd).toBeCloseTo(0.12, 6);
      expect(pToday.byCategory.wake.costUsd).toBeCloseTo(0.08, 6);
      expect(pToday.byCategory.schedule.costUsd).toBeCloseTo(0.11, 6);
      expect(pToday.byCategory.unattributed.costUsd).toBe(0);

      // Every day satisfies sum(byCategory) === totalCostUsd with zero negative buckets.
      for (const point of report.series) {
        const catSum = Object.values(point.byCategory).reduce((acc, b) => acc + b.costUsd, 0);
        expect(catSum).toBeCloseTo(point.totalCostUsd, 6);
        for (const bucket of Object.values(point.byCategory)) {
          expect(bucket.costUsd).toBeGreaterThanOrEqual(0);
          expect(bucket.tokens).toBeGreaterThanOrEqual(0);
        }
      }

      // Thread & Repo attribution resolved across all no-tool wakes and background calls:
      expect(report.topThreads.map((t) => t.threadId)).toEqual([tMain.threadId, tSched.threadId]);
      // tMain: $0.15 (pr_ci) + $0.10 (distill) + $0.12 (chat) + $0.08 (event wake via w_core_1) = $0.45
      expect(report.topThreads[0]!.stewardCostUsd).toBeCloseTo(0.45, 6);
      expect(report.topThreads[0]!.repos).toEqual(["repo-core"]);
      // tSched: $0.07 (routine) + $0.04 (followup) = $0.11
      expect(report.topThreads[1]!.stewardCostUsd).toBeCloseTo(0.11, 6);

      expect(report.topRepos).toHaveLength(1);
      expect(report.topRepos[0]!.repoName).toBe("repo-core");
      expect(report.topRepos[0]!.stewardCostUsd).toBeCloseTo(0.56, 6);
    });
  });
});

describe("Worker execution ledger isolation, replay idempotency, and $0 subscription mode", () => {
  it("deduplicates replayed (workerId, seq) settles, survives resume progress overwrites, and never trips DAILY_BUDGET_USD", async () => {
    const fake = await pairFakeConnector("mac-studio", { autorun: false });
    await fake.connect();

    await ownerStub().setBudgetForTest(1.0);
    await ownerStub().dispatchForTest({
      prompt: "实现遥测聚合",
      repoRef: "repo-a",
      newTitle: "遥测聚合实现",
    });
    const [startCmd] = await fake.waitForCmds(1);
    const workerId = String((startCmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: startCmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: startCmd!.id, ok: true, data: { sessionId: workerId, cwd: "/srv/repo-a" } });
    await fake.emit("started", workerId, { sessionId: workerId, cwd: "/srv/repo-a" });
    await waitForWorkerState("running");

    // Turn 1 settles with $8.50 Worker API cost (far above Steward's $1.00 daily cap) and 90k tokens.
    await fake.emit("report", workerId, { status: "done", summary: "第一轮完成" });
    await fake.emit("settled", workerId, {
      outcome: "reported",
      usage: {
        cost: 8.5,
        tokens: { input: 70_000, output: 20_000, totalTokens: 90_000 },
        contextUsage: { tokens: 90_000, contextWindow: 200_000 },
      },
    });
    await waitForWorkerState("idle");

    // Resume the same worker: wait for `resumed` to flip `idle` -> `running` first (`fake.emit` only
    // queues WS frames, so polling `idle` immediately after Turn 1 can match Turn 1's stale `idle`).
    await fake.emit("resumed", workerId, { reason: "follow-up" });
    await waitForWorkerState("running");
    await fake.emit("progress", workerId, { phase: "tool", tool: "Edit", target: "src/b.ts", turn: 1 });
    await fake.emit("report", workerId, { status: "done", summary: "第二轮完成" });
    await fake.emit("settled", workerId, {
      outcome: "reported",
      // Cumulative `usage` is 120k, while `turnUsage` carries the 30k incremental delta:
      usage: {
        cost: 8.5,
        tokens: { input: 95_000, output: 25_000, totalTokens: 120_000 },
        contextUsage: { tokens: 120_000, contextWindow: 200_000 },
      },
      turnUsage: {
        tokens: { input: 25_000, output: 5_000, totalTokens: 30_000 },
      },
    });
    await waitWorkerPredicate(workerId, (w) => w.state === "idle" && w.contextTokens === 120_000);

    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: LedgerSql }).sql.bind(instance);
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const w = ledger.workers.get(workerId)!;
      expect(w.contextPercent).toBe(60);
      expect(w.contextTokens).toBe(120_000);
      expect(w.contextWindow).toBe(200_000);

      // Replay seq=3 (Turn 1 settle) directly against `recordWorkerSettled` — must be ignored by PK (workerId, seq)!
      ledger.telemetry.recordWorkerSettled({
        workerId,
        seq: 3,
        at: Date.now(),
        threadId: w.threadId,
        deviceId: w.deviceId,
        repoId: w.repoId,
        agent: w.agent,
        outcome: "reported",
        event: {
          usage: {
            cost: 8.5,
            tokens: { input: 70_000, output: 20_000, totalTokens: 90_000 },
          },
        },
      });

      // Steward's own $1.00 daily budget MUST remain $0 / NOT over!
      const budgetConfig = resolveBudgetConfig(1.0);
      const budgetState = ledger.budget.state(budgetConfig);
      expect(budgetState.costUsd).toBe(0);
      expect(budgetState.over).toBe(false);

      const report = ledger.telemetry.query({
        days: 7,
        budgetState,
        budgetConfig,
      });

      // Turn 1 (90k, $8.50) + Turn 2 (30k, null cost) = 120k tokens, $8.50 reported cost, 2 settled runs.
      expect(report.totals.workerTokens).toBe(120_000);
      expect(report.totals.workerReportedCostUsd).toBeCloseTo(8.5, 6);
      expect(report.totals.workerRuns).toBe(2);
      expect(report.totals.stewardCostUsd).toBe(0);

      // Even with $0 Steward spend, `topThreads` and `topRepos` surface pure-token / Worker-driven activity!
      expect(report.topThreads).toHaveLength(1);
      expect(report.topThreads[0]!.threadId).toBe(w.threadId);
      expect(report.topThreads[0]!.workerTokens).toBe(120_000);
      expect(report.topRepos).toHaveLength(1);
      expect(report.topRepos[0]!.repoName).toBe("repo-a");
      expect(report.topRepos[0]!.workerTokens).toBe(120_000);

      // Verify 90-day retention pruning removes ancient rows while keeping current window rows intact.
      const ancientAt = Date.now() - 120 * 86_400_000;
      sql`
        INSERT INTO sh_usage_event (day, at, category, kind, costUsd, tokens)
        VALUES (${budgetDay(ancientAt)}, ${ancientAt}, 'chat', 'user', 0.5, 1000)
      `;
      sql`
        INSERT INTO sh_worker_usage (workerId, seq, day, at, threadId, deviceId, agent, outcome, totalTokens)
        VALUES ('w_old', 1, ${budgetDay(ancientAt)}, ${ancientAt}, ${w.threadId}, 'dev_1', 'pi', 'reported', 5000)
      `;
      pruneOldTelemetryRows(sql, Date.now());

      const remainingOldEvents = sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sh_usage_event WHERE day = ${budgetDay(ancientAt)}
      `[0]!.n;
      const remainingOldWorker = sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sh_worker_usage WHERE workerId = 'w_old'
      `[0]!.n;
      expect(remainingOldEvents).toBe(0);
      expect(remainingOldWorker).toBe(0);
      expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_worker_usage`[0]!.n).toBe(2);
    });

    fake.close();
  });
});

describe("Stage 2: GET /app/api/telemetry and Workspace live context projection", () => {
  const appUrl = (path: string): string => ["https:", "", `example.com${path}`].join("/");

  it("serves 7/14/30-day telemetry over HTTP, rejects invalid days or methods, and projects live context into Workspace & thread_state", async () => {
    const fake = await pairFakeConnector("mac-studio", { autorun: false });
    await fake.connect();

    await ownerStub().spendForTest(0.24, 6_400);
    await ownerStub().dispatchForTest({
      prompt: "压测实时上下文投影",
      repoRef: "repo-a",
      newTitle: "上下文投影验证",
    });
    const [startCmd] = await fake.waitForCmds(1);
    const workerId = String((startCmd!.args as Record<string, unknown>).workerId);
    const threadId = String((startCmd!.args as Record<string, unknown>).threadId);
    fake.send({ t: "cmd_ack", re: startCmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: startCmd!.id, ok: true, data: { sessionId: workerId, cwd: "/srv/repo-a" } });
    await fake.emit("started", workerId, { sessionId: workerId, cwd: "/srv/repo-a" });
    await waitForWorkerState("running");

    const cookie = await webLogin();
    const { ws, reader } = await connectWeb(cookie);
    ws.send(JSON.stringify({ t: "subscribe_thread", threadId }));
    await reader.nextWhere((m) => m.t === "thread_state");

    await fake.emit("progress", workerId, {
      phase: "compacting",
      turn: 3,
      telemetry: {
        contextTokens: 164_000,
        contextWindow: 200_000,
        compactionCount: 2,
        lastToolMs: 5_400,
      },
    });

    const pushedState = await reader.nextWhere(
      (m) =>
        m.t === "thread_state" &&
        Array.isArray(m.workers) &&
        (m.workers as Array<{ contextPercent?: number }>).some((w) => w.contextPercent === 82),
    );

    const snapRes = await SELF.fetch(appUrl("/app/api/workspace"), { headers: { cookie } });
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      threads: Array<{
        id: string;
        state: string;
        openQuestions?: number;
        workers: Array<{
          id: string;
          state: string;
          contextPercent: number | null;
          contextTokens: number | null;
          contextWindow: number | null;
          compactionCount: number;
          lastToolDurationMs: number | null;
        }>;
      }>;
    };
    const snapThread = snap.threads.find((t) => t.id === threadId)!;
    expect(snapThread.workers[0]).toMatchObject({
      id: workerId,
      state: "running",
      contextPercent: 82,
      contextTokens: 164_000,
      contextWindow: 200_000,
      compactionCount: 2,
      lastToolDurationMs: 5_400,
    });

    // Verify `applyThreadState` merges live telemetry onto an existing client thread snapshot.
    const staleClientThread = {
      ...snapThread,
      workers: snapThread.workers.map((w) => ({ ...w, contextPercent: null, contextTokens: null, compactionCount: 0 })),
    };
    const merged = applyThreadState(staleClientThread, pushedState);
    expect(merged.unknownWorkers).toBe(false);
    expect(merged.thread.workers[0]).toMatchObject({
      contextPercent: 82,
      contextTokens: 164_000,
      contextWindow: 200_000,
      compactionCount: 2,
      lastToolDurationMs: 5_400,
    });

    // Default days=7
    const tel7Res = await SELF.fetch(appUrl("/app/api/telemetry"), { headers: { cookie } });
    expect(tel7Res.status).toBe(200);
    const tel7 = (await tel7Res.json()) as { days: number; series: unknown[]; budget: { costUsd: number } };
    expect(tel7.days).toBe(7);
    expect(tel7.series).toHaveLength(7);
    expect(tel7.budget.costUsd).toBeCloseTo(0.24, 6);

    // Explicit days=30
    const tel30Res = await SELF.fetch(appUrl("/app/api/telemetry?days=30"), { headers: { cookie } });
    expect(tel30Res.status).toBe(200);
    const tel30 = (await tel30Res.json()) as { days: number; series: unknown[] };
    expect(tel30.days).toBe(30);
    expect(tel30.series).toHaveLength(30);

    // Invalid days -> 400 invalid_days
    const badDays = await SELF.fetch(appUrl("/app/api/telemetry?days=9"), { headers: { cookie } });
    expect(badDays.status).toBe(400);
    expect(await badDays.json()).toEqual({ error: "invalid_days" });

    // Non-GET -> 405 method_not_allowed
    const postRes = await SELF.fetch(
      new Request(appUrl("/app/api/telemetry"), { method: "POST", headers: { cookie } }),
    );
    expect(postRes.status).toBe(405);

    ws.close();
    fake.close();
  });
});
