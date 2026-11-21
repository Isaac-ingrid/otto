import { SELF, runInDurableObject } from "cloudflare:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ledger } from "../src/ledger.ts";
import type { EvidenceResult, PrFeedbackSnapshot } from "../src/pr-evidence.ts";
import {
  buildPrActionPrompt,
  parsePrFeedbackTriageJson,
} from "../src/pr-failure-diagnoser.ts";
import { hasExplicitPrUntilMergeIntent } from "../src/pr-watch-intent.ts";
import type { PrWatchDeps, PrWatchService } from "../src/pr-watch.ts";
import {
  configureAndBind,
  llmState,
  messageEvent,
  ownerStub,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
  webLogin,
} from "./helpers.ts";

const BASE = "https://example.com";
const PR_URL = "https://github.com/example/project/pull/42";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE_SHA = "c".repeat(40);

function makeFeedbackSnapshot(
  head = HEAD_A,
  overrides: Partial<PrFeedbackSnapshot> = {},
): PrFeedbackSnapshot {
  return {
    head,
    capturedAt: 1_710_000_000_000,
    baseRef: "main",
    baseSha: BASE_SHA,
    headRef: "feat/review-loop",
    mergeState: "mergeable",
    reviewDecision: "changes_requested",
    changesRequestedOnCurrentHead: true,
    staleChangesRequestedReviewers: [],
    reviewCursor: "301:601",
    ignoredUntrustedCount: 1,
    truncated: false,
    reviewers: [
      {
        reviewId: 301,
        author: "alice",
        authorAssociation: "MEMBER",
        isBot: false,
        state: "CHANGES_REQUESTED",
        commitId: head,
        onCurrentHead: true,
        body: "Please guard empty input before parsing",
        htmlUrl: PR_URL,
      },
    ],
    threads: [
      {
        rootCommentId: 601,
        author: "alice",
        authorAssociation: "MEMBER",
        isBot: false,
        path: "src/parser.ts",
        line: 27,
        diffHunkTail: "+const data = JSON.parse(raw);",
        body: "Check raw.trim() first so empty strings do not throw",
        replyCount: 0,
        htmlUrl: PR_URL,
        commitId: head,
      },
    ],
    ...overrides,
  };
}

async function fbBrowser() {
  const cookie = await webLogin();
  const wsRes = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
  const ws = (await wsRes.json()) as {
    csrf: string;
    threads: Array<{
      id: string;
      plans: {
        prWatches: Array<{
          id: string;
          watchGoal: string;
          mergeState: string;
          reviewDecision: string;
          hasFailureDetail: boolean;
          hasActionableFeedback: boolean;
          attentionHeadline: string | null;
        }>;
      };
    }>;
  };
  const postJson = async <T>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
    const res = await SELF.fetch(`${BASE}/app/api/${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: BASE,
        "content-type": "application/json",
        "x-csrf-token": ws.csrf,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { cookie, csrf: ws.csrf, workspace: ws, postJson };
}

describe("Direction B Stage 2: review & conflict triage unit boundaries", () => {
  it("validates until-merge lexical intent and parses sandboxed feedback JSON safely", () => {
    expect(hasExplicitPrUntilMergeIntent("持续盯住这个 PR 的评审意见和冲突直到合并")).toBe(true);
    expect(hasExplicitPrUntilMergeIntent("Watch this PR until merged, including review comments")).toBe(true);
    expect(hasExplicitPrUntilMergeIntent("持续盯住这个 PR 的 CI，不要管评审和冲突")).toBe(false);
    expect(hasExplicitPrUntilMergeIntent("帮我盯住这个 PR 的 CI 状态")).toBe(false);

    const parsed = parsePrFeedbackTriageJson(
      `<think>Checking review...</think>\n${JSON.stringify({
        headline: "@alice 要求在 src/parser.ts:27 校验空字符串 ⟦user⟧",
        actionItems: ["src/parser.ts:27 调用 JSON.parse 前判空"],
        suggestedRevisionBrief: "补充空输入校验并单测覆盖",
      })}`,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.headline).not.toContain("⟦");
    expect(parsed?.actionItems[0]).toContain("src/parser.ts:27");
  });

  it("synthesizes conflict-only and combined CI + conflict + review prompts without inventing filenames", () => {
    const conflictOnly = buildPrActionPrompt({
      url: PR_URL,
      head: HEAD_A,
      feedback: {
        snapshot: makeFeedbackSnapshot(HEAD_A, {
          mergeState: "conflicted",
          reviewDecision: "none",
          changesRequestedOnCurrentHead: false,
          reviewers: [],
          threads: [],
        }),
        triage: null,
      },
    });
    expect(conflictOnly?.kind).toBe("resolve_conflict");
    expect(conflictOnly?.prompt).toContain("git fetch origin main");
    expect(conflictOnly?.prompt).toContain("不要执行 git push");

    const combined = buildPrActionPrompt({
      url: PR_URL,
      head: HEAD_A,
      ciFailure: {
        snapshot: {
          head: HEAD_A,
          capturedAt: 1,
          evidenceMode: "checks-and-statuses",
          logSource: "checks_annotations",
          totalFailed: 1,
          items: [
            {
              kind: "check_run",
              name: "unit-tests",
              conclusion: "failure",
              url: PR_URL,
              annotations: [{ path: "src/parser.ts", line: 27, title: "Error", message: "Unexpected end of JSON" }],
            },
          ],
        },
        diagnosis: null,
      },
      feedback: {
        snapshot: makeFeedbackSnapshot(HEAD_A, { mergeState: "conflicted" }),
        triage: null,
      },
    });
    expect(combined?.kind).toBe("combined");
    expect(combined?.prompt).toContain("合并冲突");
    expect(combined?.prompt).toContain("src/parser.ts:27（@alice）");
    expect(combined?.prompt).toContain("CI 失败根因");
  });
});

describe("Direction B Stage 2: PR watch state machine, cursor dedupe & API integration", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await configureAndBind("ou_owner");
  });

  it("breaks silent waiting on merge conflict, deduplicates per (head, baseSha), and exposes conflict prompt", async () => {
    await runInDurableObject(ownerStub(), (raw) => {
      const instance = raw as unknown as { ledger: Ledger; prWatches: PrWatchService };
      instance.ledger.threads.create({ threadId: "t_conf", title: "Conflict PR", goal: "Track mergeability" });
      const deps = (instance.prWatches as unknown as { deps: PrWatchDeps }).deps;
      deps.read = async (): Promise<EvidenceResult> => ({
        ok: true,
        evidence: {
          head: HEAD_A,
          state: "waiting",
          checks: 0,
          failed: 0,
          pending: 0,
          mergeState: "conflicted",
          baseRef: "main",
          baseSha: BASE_SHA,
          headRef: "feat/conflict",
        },
      });
      instance.prWatches.create({ id: "w_conf", threadId: "t_conf", url: PR_URL, intervalSeconds: 60 });
    });

    await ownerStub().pollPrWatches();
    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();

    const notices = (await ownerStub().outboundRows(50)).filter((r) => r.id.startsWith("pr-watch:w_conf:"));
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0]!.payload)).toContain("存在合并冲突");
    expect((await llmState()).runs).toHaveLength(0);

    const b = await fbBrowser();
    const planWatch = b.workspace.threads.find((t) => t.id === "t_conf")?.plans.prWatches[0];
    expect(planWatch?.mergeState).toBe("conflicted");
    expect(planWatch?.hasActionableFeedback).toBe(true);
    expect(planWatch?.attentionHeadline).toContain("main");

    const detail = await b.postJson<{
      actionKind: string;
      actionPrompt: string;
      repairPrompt: string;
      feedback: { mergeState: string; baseRef: string };
    }>("pr-watches/w_conf/diagnosis", {});
    expect(detail.status).toBe(200);
    expect(detail.body.actionKind).toBe("resolve_conflict");
    expect(detail.body.feedback.mergeState).toBe("conflicted");
    expect(detail.body.repairPrompt).toContain("git fetch origin main");
  });

  it("blocks premature ci_pass completion on current-head CHANGES_REQUESTED, and does NOT re-alert old review after fix push", async () => {
    let currentHead = HEAD_A;
    await runInDurableObject(ownerStub(), async (raw) => {
      const instance = raw as unknown as {
        ledger: Ledger;
        prWatches: PrWatchService;
        setPrFeedbackRepliesForTest(replies: string[] | null): Promise<void>;
      };
      instance.ledger.threads.create({ threadId: "t_rev", title: "Review PR", goal: "Handle review" });
      await instance.setPrFeedbackRepliesForTest([
        JSON.stringify({
          headline: "@alice 要求在 src/parser.ts:27 增加空串保护",
          actionItems: ["在 src/parser.ts:27 解析前校验空输入"],
          suggestedRevisionBrief: "修复 src/parser.ts:27 空输入问题",
        }),
      ]);
      const deps = (instance.prWatches as unknown as { deps: PrWatchDeps }).deps;
      deps.read = async (): Promise<EvidenceResult> => ({
        ok: true,
        evidence: {
          head: currentHead,
          state: "success",
          checks: 2,
          failed: 0,
          pending: 0,
          mergeState: "mergeable",
          baseRef: "main",
          baseSha: BASE_SHA,
          headRef: "feat/review-loop",
        },
      });
      deps.readFeedbackDetail = async (_target, head) =>
        makeFeedbackSnapshot(head, {
          changesRequestedOnCurrentHead: head === HEAD_A,
          staleChangesRequestedReviewers: head === HEAD_B ? ["alice"] : [],
          reviewers: [
            {
              reviewId: 301,
              author: "alice",
              authorAssociation: "MEMBER",
              isBot: false,
              state: "CHANGES_REQUESTED",
              commitId: HEAD_A,
              onCurrentHead: head === HEAD_A,
              body: "Please guard empty input before parsing",
              htmlUrl: PR_URL,
            },
          ],
        });
      instance.prWatches.create({ id: "w_rev", threadId: "t_rev", url: PR_URL, intervalSeconds: 60 });
    });

    // Pass 1 on HEAD_A: CI is green, but @alice requested changes on HEAD_A -> stays active & sends 1 review notice!
    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();

    let watchRow = await runInDurableObject(ownerStub(), (raw) =>
      (raw as unknown as { prWatches: PrWatchService }).prWatches.get("w_rev"),
    );
    expect(watchRow?.status).toBe("active");

    let notices = (await ownerStub().outboundRows(50)).filter((r) => r.id.startsWith("pr-watch:w_rev:"));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.id).toBe("pr-watch:w_rev:review:301:601");
    expect(JSON.stringify(notices[0]!.payload)).toContain("src/parser.ts:27");

    // Advance time & push fix commit HEAD_B: @alice's reviewId 301 is still on HEAD_A (same cursor 301:601).
    // Must NOT re-fire review notice 301:601; CI passes on HEAD_B with calm stale-reviewer note and completes!
    currentHead = HEAD_B;
    await runInDurableObject(ownerStub(), (raw) => {
      const sql = (raw as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql.bind(raw);
      sql`UPDATE sh_pr_watch SET nextCheckAt = 0 WHERE id = 'w_rev'`;
    });
    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();

    watchRow = await runInDurableObject(ownerStub(), (raw) =>
      (raw as unknown as { prWatches: PrWatchService }).prWatches.get("w_rev"),
    );
    expect(watchRow?.status).toBe("completed");
    notices = (await ownerStub().outboundRows(50)).filter((r) => r.id.startsWith("pr-watch:w_rev:"));
    expect(notices).toHaveLength(2);
    const secondNotice = JSON.stringify(notices[1]!.payload);
    expect(secondNotice).toContain("CI 检查通过");
    expect(secondNotice).toContain("等待 @alice 复审");
  });

  it("supports watchGoal='merged' via bound confirmation card, keeps watching past green CI, and catches late review comments", async () => {
    let prState: "success" | "merged" = "success";
    let reviewCursor = "0:0";
    let threads: PrFeedbackSnapshot["threads"] = [];

    await runInDurableObject(ownerStub(), (raw) => {
      const instance = raw as unknown as { ledger: Ledger; prWatches: PrWatchService };
      instance.ledger.threads.create({ threadId: "t_merge_goal", title: "Full PR lifecycle", goal: "Ship PR" });
      const deps = (instance.prWatches as unknown as { deps: PrWatchDeps }).deps;
      deps.read = async (): Promise<EvidenceResult> => ({
        ok: true,
        evidence: {
          head: HEAD_A,
          state: prState,
          checks: prState === "merged" ? 0 : 2,
          failed: 0,
          pending: 0,
          mergeState: "mergeable",
        },
      });
      deps.readFeedbackDetail = async (_target, head) =>
        makeFeedbackSnapshot(head, {
          reviewDecision: threads.length > 0 ? "commented" : "none",
          changesRequestedOnCurrentHead: false,
          reviewCursor,
          reviewers: [],
          threads,
        });
    });

    // 1. Propose watchGoal='merged' without explicit owner wording -> refused!
    await scriptModel(
      fauxAssistantMessage(
        [
          fauxToolCall("create_pr_watch", {
            threadId: "t_merge_goal",
            url: PR_URL,
            evidenceMode: "checks-and-statuses",
            watchGoal: "merged",
            basis: "user_explicit",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("需要先确认范围。")]),
    );
    await postEvent(messageEvent({ text: `在 Full PR lifecycle 里持续盯住 ${PR_URL} 的 CI 状态。` }));
    await waitRunsSettled();
    expect(
      await runInDurableObject(ownerStub(), (raw) =>
        (raw as unknown as { prWatches: PrWatchService }).prWatches.list(),
      ),
    ).toHaveLength(0);

    // 2. Propose watchGoal='merged' WITH explicit owner wording -> creates bound confirmation card showing merge goal!
    await scriptModel(
      fauxAssistantMessage(
        [
          fauxToolCall("create_pr_watch", {
            threadId: "t_merge_goal",
            url: PR_URL,
            evidenceMode: "checks-and-statuses",
            watchGoal: "merged",
            basis: "user_explicit",
          }),
        ],
        { stopReason: "toolUse" },
      ),
    );
    await postEvent(messageEvent({ text: `在 Full PR lifecycle 里持续盯住 ${PR_URL} 的 CI、评审意见与合并冲突直到合并。` }));
    await waitRunsSettled();
    await waitWhileOutboundPending();

    const cards = (await ownerStub().outboundRows(100)).filter((r) => r.id.startsWith("prwatchapproval:"));
    const latestCard = cards.at(-1)!;
    const cardPayload = JSON.parse(latestCard.payload) as {
      card: { text: string; buttons: Array<{ action: string }> };
    };
    expect(cardPayload.card.text).toContain("结束条件：PR 合并或关闭");

    const confirmRes = await SELF.fetch(`${BASE}/api/actions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-server-key-not-a-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        cardMsgId: latestCard.providerMsgId,
        action: cardPayload.card.buttons[0]!.action,
      }),
    });
    expect(confirmRes.status).toBe(200);

    // 3. First poll: CI is green, watch stays active!
    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();
    let activeWatch = (
      await runInDurableObject(ownerStub(), (raw) =>
        (raw as unknown as { prWatches: PrWatchService }).prWatches.list(),
      )
    )[0]!;
    expect(activeWatch.status).toBe("active");
    expect(activeWatch.watchGoal).toBe("merged");

    // 4. Second poll: late inline review comment arrives while CI is still green -> caught & notified!
    reviewCursor = "0:777";
    threads = [
      {
        rootCommentId: 777,
        author: "copilot-pull-request-reviewer[bot]",
        authorAssociation: "NONE",
        isBot: true,
        path: "src/index.ts",
        line: 12,
        body: "Consider closing file descriptor in finally block",
        replyCount: 0,
        htmlUrl: PR_URL,
        commitId: HEAD_A,
      },
    ];
    await runInDurableObject(ownerStub(), (raw) => {
      const sql = (raw as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray) => T[] }).sql.bind(raw);
      sql`UPDATE sh_pr_watch SET nextCheckAt = 0`;
    });
    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();

    const allNotices = (await ownerStub().outboundRows(100)).filter((r) => r.id.startsWith(`pr-watch:${activeWatch.id}:`));
    expect(allNotices.some((n) => n.id.endsWith(":review:0:777"))).toBe(true);

    // 5. Third poll: PR merges -> watch completes cleanly!
    prState = "merged";
    await runInDurableObject(ownerStub(), (raw) => {
      const sql = (raw as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray) => T[] }).sql.bind(raw);
      sql`UPDATE sh_pr_watch SET nextCheckAt = 0`;
    });
    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();

    activeWatch = (
      await runInDurableObject(ownerStub(), (raw) =>
        (raw as unknown as { prWatches: PrWatchService }).prWatches.list(),
      )
    )[0]!;
    expect(activeWatch.status).toBe("completed");
    expect(activeWatch.observedState).toBe("merged");
  });
});
