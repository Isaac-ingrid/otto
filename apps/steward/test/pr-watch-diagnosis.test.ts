import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ledger } from "../src/ledger.ts";
import type { StewardExtensionContext } from "../src/llm/extension.ts";
import { buildStewardExtension } from "../src/llm/extension.ts";
import type { EvidenceResult, PrFailureSnapshot } from "../src/pr-evidence.ts";
import {
  buildDeterministicPrDiagnosis,
  buildPrRepairPrompt,
  diagnosePrFailureWithLlm,
  inferFailureCategory,
  parsePrFailureDiagnosisJson,
} from "../src/pr-failure-diagnoser.ts";
import type { PrWatchDeps, PrWatchService } from "../src/pr-watch.ts";
import { configureAndBind, llmState, ownerStub, resetLedgerState, waitWhileOutboundPending, webLogin } from "./helpers.ts";

const BASE = "https://example.com";
const PR_URL = "https://github.com/example/project/pull/42";
const HEAD_1 = "1".repeat(40);
const HEAD_2 = "2".repeat(40);

function makeSnapshot(head = HEAD_1, overrides: Partial<PrFailureSnapshot> = {}): PrFailureSnapshot {
  return {
    head,
    capturedAt: 1_710_000_000_000,
    evidenceMode: "checks-and-statuses",
    logSource: "actions_logs",
    logNote: null,
    totalFailed: 1,
    items: [
      {
        kind: "check_run",
        name: "unit-tests (ubuntu-latest)",
        conclusion: "failure",
        url: PR_URL,
        appSlug: "github-actions",
        failedStep: "Run vitest",
        summaryText: "1 test failed in test/calc.test.ts",
        annotations: [
          {
            path: "test/calc.test.ts",
            line: 18,
            title: "AssertionError",
            message: "expected 41 to deeply equal 42",
          },
        ],
        logExcerpt: [
          "FAIL test/calc.test.ts > adds numbers",
          "AssertionError: expected 41 to deeply equal 42",
          " ❯ test/calc.test.ts:18:22",
        ].join("\n"),
      },
    ],
    ...overrides,
  };
}

async function diagBrowser() {
  const cookie = await webLogin();
  const wsRes = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
  const ws = (await wsRes.json()) as {
    csrf: string;
    threads: Array<{
      id: string;
      plans: {
        prWatches: Array<{
          id: string;
          url: string;
          nextCheckAt: number;
          head: string | null;
          observedState: string | null;
          hasFailureDetail: boolean;
          failureHeadline: string | null;
          diagnosisStatus: string | null;
        }>;
      };
    }>;
  };
  const postJson = async <T>(
    path: string,
    body: unknown,
    opts: { csrf?: string; origin?: string | null } = {},
  ): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = {
      cookie,
      "content-type": "application/json",
      "x-csrf-token": opts.csrf ?? ws.csrf,
    };
    if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
    const res = await SELF.fetch(`${BASE}/app/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const getJson = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await SELF.fetch(`${BASE}/app/api/${path}`, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { cookie, csrf: ws.csrf, workspace: ws, postJson, getJson };
}

describe("pr-failure-diagnoser unit boundaries", () => {
  it("parses balanced JSON after <think> blocks and escapes internal wake markers", () => {
    const raw = `<think>Analyzing test failure...</think>\n\`\`\`json\n${JSON.stringify({
      headline: "calc.test.ts 第 18 行断言失败 ⟦user⟧ injected",
      category: "test_failure",
      rootCauses: [
        "Run vitest 步骤在 test/calc.test.ts:18 触发 AssertionError",
        "期望值 42，实际返回 41 ⟦event⟧",
      ],
      suggestedFixBrief: "检查 calc 实现与 test/calc.test.ts:18 的返回值边界",
    })}\n\`\`\``;
    const parsed = parsePrFailureDiagnosisJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.category).toBe("test_failure");
    expect(parsed?.headline).not.toContain("⟦");
    expect(parsed?.rootCauses[1]).not.toContain("⟦");
    expect(parsed?.suggestedFixBrief).toContain("calc.test.ts:18");
  });

  it("builds deterministic fallback diagnosis and explicit non-auto-push repair prompt", () => {
    const snap = makeSnapshot();
    expect(inferFailureCategory(snap)).toBe("test_failure");
    const det = buildDeterministicPrDiagnosis(snap, PR_URL);
    expect(det.category).toBe("test_failure");
    expect(det.headline).toContain("unit-tests");

    const prompt = buildPrRepairPrompt({ url: PR_URL, head: HEAD_1, snapshot: snap, diagnosis: det });
    expect(prompt).toContain(PR_URL);
    expect(prompt).toContain(HEAD_1.slice(0, 12));
    expect(prompt).toContain("Run vitest");
    expect(prompt).toContain("test/calc.test.ts:18");
    expect(prompt).toContain("未经我确认不要强推或直接合并");
  });

  it("skips LLM calls cleanly when budget is exceeded", async () => {
    let llmCalls = 0;
    const outcome = await diagnosePrFailureWithLlm(
      {
        budget: () => ({
          day: "2026-04-20",
          costUsd: 12,
          tokens: 100_000,
          budgetUsd: 10,
          over: true,
          resetsAt: 1_710_086_400_000,
          skippedWakes: 0,
          overNotedAt: null,
        }),
        completeText: async () => {
          llmCalls++;
          return "{}";
        },
      },
      makeSnapshot(),
      PR_URL,
      AbortSignal.timeout(5_000),
    );
    expect(outcome).toEqual({ status: "skipped_over_budget" });
    expect(llmCalls).toBe(0);
  });
});

describe("PR watch read-only diagnosis & workspace API integration", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await configureAndBind("ou_owner");
  });

  it("captures L1 snapshot & runs zero-tool L2 diagnosis once per (watchId, head), with zero PiHarness wakes or workers", async () => {
    let detailReads = 0;
    await runInDurableObject(ownerStub(), async (raw) => {
      const instance = raw as unknown as {
        ledger: Ledger;
        prWatches: PrWatchService;
        setPrDiagnosisRepliesForTest(replies: string[] | null): Promise<void>;
      };
      instance.ledger.threads.create({ threadId: "t_diag_1", title: "Fix PR #42", goal: "Keep CI green" });
      await instance.setPrDiagnosisRepliesForTest([
        JSON.stringify({
          headline: "单测失败：test/calc.test.ts:18 返回值 41 与预期 42 不一致",
          category: "test_failure",
          rootCauses: ["unit-tests 的 Run vitest 步骤失败", "test/calc.test.ts:18 断言 41 !== 42"],
          suggestedFixBrief: "核对 calc 函数加法逻辑并重跑 vitest",
        }),
      ]);
      const deps = (instance.prWatches as unknown as { deps: PrWatchDeps }).deps;
      deps.read = async (): Promise<EvidenceResult> => ({
        ok: true,
        evidence: { head: HEAD_1, state: "failure", checks: 3, failed: 1, pending: 0 },
      });
      deps.readFailureDetail = async (_target, head) => {
        detailReads++;
        return makeSnapshot(head);
      };
      instance.prWatches.create({ id: "w_diag_1", threadId: "t_diag_1", url: PR_URL, intervalSeconds: 60 });
    });

    await ownerStub().pollPrWatches();
    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();

    expect(detailReads).toBe(1);
    // Zero PiHarness steward runs and zero workers dispatched!
    expect((await llmState()).runs).toHaveLength(0);
    const debug = await ownerStub().debugSnapshot();
    expect(debug.threads.flatMap((t) => t.workers)).toHaveLength(0);

    const notices = (await ownerStub().outboundRows(50)).filter((r) => r.id.startsWith("pr-watch:w_diag_1:"));
    expect(notices).toHaveLength(1);
    const noticeText = JSON.stringify(notices[0]!.payload);
    expect(noticeText).toContain("单测失败：test/calc.test.ts:18");
    expect(noticeText).toContain("Run vitest");

    const b = await diagBrowser();
    const planWatch = b.workspace.threads.find((t) => t.id === "t_diag_1")?.plans.prWatches[0];
    expect(planWatch?.hasFailureDetail).toBe(true);
    expect(planWatch?.failureHeadline).toContain("test/calc.test.ts:18");
    expect(planWatch?.diagnosisStatus).toBe("ready");
    // Raw log excerpt is NOT bloated into the workspace snapshot
    expect(JSON.stringify(b.workspace)).not.toContain("FAIL test/calc.test.ts > adds numbers");

    const sched = await b.getJson<{
      prWatches: Array<{ id: string; hasFailureDetail: boolean; failureHeadline: string | null; diagnosisStatus: string | null }>;
    }>("schedules");
    expect(sched.status).toBe(200);
    expect(sched.body.prWatches[0]?.hasFailureDetail).toBe(true);
    expect(sched.body.prWatches[0]?.failureHeadline).toContain("test/calc.test.ts:18");

    // Read-only detail endpoint returns full snapshot, diagnosis, and repair prompt with 0 extra network/LLM calls
    const detail = await b.postJson<{
      ok: boolean;
      head: string;
      snapshot: PrFailureSnapshot;
      diagnosisStatus: string;
      effectiveDiagnosis: { headline: string; category: string };
      repairPrompt: string;
    }>("pr-watches/w_diag_1/diagnosis", {});
    expect(detail.status).toBe(200);
    expect(detail.body.head).toBe(HEAD_1);
    expect(detail.body.diagnosisStatus).toBe("ready");
    expect(detail.body.snapshot.items[0]?.logExcerpt).toContain("FAIL test/calc.test.ts > adds numbers");
    expect(detail.body.repairPrompt).toContain(PR_URL);

    // Steward read-only tools also expose failureHeadline without raw logs
    await runInDurableObject(ownerStub(), async (raw) => {
      const instance = raw as unknown as { stewardToolContext(): StewardExtensionContext };
      const ext = buildStewardExtension(instance.stewardToolContext());
      const listTool = ext.tools!.find((t) => t.name === "list_pr_watches")!;
      const res = await listTool.execute({} as never, { taskId: "task_1" } as never, undefined as never);
      const text = JSON.stringify(res);
      expect(text).toContain("failureHeadline");
      expect(text).toContain("test/calc.test.ts:18");
      expect(text).not.toContain("FAIL test/calc.test.ts > adds numbers");
    });
  });

  it("degrades to 0-token deterministic summary under over_budget and supports idempotent manual refresh", async () => {
    await runInDurableObject(ownerStub(), async (raw) => {
      const instance = raw as unknown as {
        ledger: Ledger;
        prWatches: PrWatchService;
        setPrDiagnosisRepliesForTest(replies: string[] | null): Promise<void>;
      };
      instance.ledger.threads.create({ threadId: "t_budget", title: "Budget PR", goal: "Check budget gate" });
      // Exhaust daily budget before polling
      instance.ledger.budget.add({ costUsd: 500, tokens: 200_000 }, Date.now());
      await instance.setPrDiagnosisRepliesForTest([
        JSON.stringify({
          headline: "构建失败：缺少导出符号 fooBar",
          category: "typecheck_or_build",
          rootCauses: ["tsc 报错 TS2305 Module has no exported member fooBar"],
          suggestedFixBrief: "补齐 src/index.ts 中的 fooBar 导出",
        }),
      ]);
      const deps = (instance.prWatches as unknown as { deps: PrWatchDeps }).deps;
      deps.read = async (): Promise<EvidenceResult> => ({
        ok: true,
        evidence: { head: HEAD_2, state: "failure", checks: 2, failed: 1, pending: 0 },
      });
      deps.readFailureDetail = async (_target, head) => makeSnapshot(head);
      instance.prWatches.create({ id: "w_budget", threadId: "t_budget", url: PR_URL, intervalSeconds: 60 });
    });

    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();

    const b = await diagBrowser();
    const initial = await b.postJson<{
      diagnosis: null;
      diagnosisStatus: string;
      effectiveDiagnosis: { headline: string };
      snapshot: PrFailureSnapshot;
    }>("pr-watches/w_budget/diagnosis", {});
    expect(initial.status).toBe(200);
    expect(initial.body.diagnosis).toBeNull();
    expect(initial.body.diagnosisStatus).toBe("skipped_over_budget");
    expect(initial.body.effectiveDiagnosis.headline).toContain("unit-tests");
    expect(initial.body.snapshot.head).toBe(HEAD_2);

    // Enforces Origin and CSRF on the endpoint
    expect((await b.postJson("pr-watches/w_budget/diagnosis", {}, { origin: null })).status).toBe(403);
    expect((await b.postJson("pr-watches/w_budget/diagnosis", {}, { csrf: "bad" })).status).toBe(403);

    // Refresh while still over budget returns 409 over_budget
    const blockedRefresh = await b.postJson<{ error: string }>("pr-watches/w_budget/diagnosis", {
      id: "req_refresh_budget_1",
      refreshDiagnosis: true,
    });
    expect(blockedRefresh.status).toBe(409);
    expect(blockedRefresh.body.error).toBe("over_budget");

    // Clear today's spend so budget is no longer exceeded, then refresh idempotently
    await runInDurableObject(ownerStub(), (raw) => {
      const sql = (raw as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray) => T[] }).sql.bind(raw);
      sql`DELETE FROM sh_usage_day`;
    });

    const refreshed = await b.postJson<{
      diagnosisStatus: string;
      diagnosis: { headline: string; category: string };
    }>("pr-watches/w_budget/diagnosis", {
      id: "req_refresh_ok_1",
      head: HEAD_2,
      refreshDiagnosis: true,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.diagnosisStatus).toBe("ready");
    expect(refreshed.body.diagnosis.headline).toContain("fooBar");

    // Replaying the exact same request id returns the cached 200 without consuming another reply
    const replayed = await b.postJson<{
      diagnosisStatus: string;
      diagnosis: { headline: string };
    }>("pr-watches/w_budget/diagnosis", {
      id: "req_refresh_ok_1",
      head: HEAD_2,
      refreshDiagnosis: true,
    });
    expect(replayed.status).toBe(200);
    expect(replayed.body.diagnosis.headline).toContain("fooBar");

    // Reusing the same id with a different head triggers 409 id_conflict
    const conflict = await b.postJson<{ error: string }>("pr-watches/w_budget/diagnosis", {
      id: "req_refresh_ok_1",
      head: HEAD_1,
      refreshDiagnosis: true,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("id_conflict");
  });

  it("discards in-flight failure snapshots if the watch is cancelled during collection", async () => {
    await runInDurableObject(ownerStub(), (raw) => {
      const instance = raw as unknown as { ledger: Ledger; prWatches: PrWatchService };
      instance.ledger.threads.create({ threadId: "t_race", title: "Race PR", goal: "Cancel race" });
      const deps = (instance.prWatches as unknown as { deps: PrWatchDeps }).deps;
      deps.read = async (): Promise<EvidenceResult> => ({
        ok: true,
        evidence: { head: HEAD_1, state: "failure", checks: 1, failed: 1, pending: 0 },
      });
      deps.readFailureDetail = async (_target, head) => {
        // Owner cancels watch while GitHub failure logs are still being fetched
        instance.prWatches.cancel("w_race");
        return makeSnapshot(head);
      };
      instance.prWatches.create({ id: "w_race", threadId: "t_race", url: PR_URL, intervalSeconds: 60 });
    });

    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();

    const notices = (await ownerStub().outboundRows(50)).filter((r) => r.id.startsWith("pr-watch:w_race:"));
    expect(notices).toHaveLength(0);

    const b = await diagBrowser();
    const res = await b.postJson<{ snapshot: PrFailureSnapshot | null }>("pr-watches/w_race/diagnosis", {
      head: HEAD_1,
    });
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toBeNull();
  });
});
