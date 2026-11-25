import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PrWatchService, type PrWatchDeps, type PrWatchStuckAlert } from "../src/pr-watch.ts";
import type { EvidenceResult } from "../src/pr-evidence.ts";
import type { SqlExecutor } from "../src/schema.ts";
import type { Steward } from "../src/steward.ts";
import {
  buildAuthorIsolatedBlindReviewPrompt,
  selectBlindReviewerAgent,
} from "../src/pr-blind-review.ts";
import { CARD_LINK_TTL_MS, renderFeishuCardV2 } from "../src/channel/feishu-card-v2.ts";
import {
  buildOutboundWebhookRequest,
  validateWebhookTargetUrl,
} from "../src/channel/webhooks.ts";
import {
  configureAndBind,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  waitWhileOutboundPending,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

const SAMPLE_HEAD = "a".repeat(40);
const SAMPLE_NEXT_HEAD = "b".repeat(40);
const SAMPLE_PR_URL = ["https:", "", "github.com", "example", "project", "pull", "42"].join("/");

describe("052_pr_watch_stuck_and_review — Stage 4 PR Watch Stuck Card & Blind Review", () => {
  it("selects a cross-engine blind reviewer when available and strips author reasoning", () => {
    expect(selectBlindReviewerAgent("claude-code", ["claude-code", "codex"])).toEqual({
      agent: "codex",
      crossEngine: true,
    });
    expect(selectBlindReviewerAgent("codex", ["codex", "claude-code", "pi"])).toEqual({
      agent: "claude-code",
      crossEngine: true,
    });
    // Single-engine fallback uses a clean readonly session (`crossEngine: false`)
    expect(selectBlindReviewerAgent("pi", ["pi"])).toEqual({
      agent: "pi",
      crossEngine: false,
    });
    expect(selectBlindReviewerAgent("pi", [])).toBeNull();

    const prompt = buildAuthorIsolatedBlindReviewPrompt({
      prUrl: SAMPLE_PR_URL,
      prNumber: 42,
      diff: {
        headSha: SAMPLE_HEAD,
        baseSha: "c".repeat(40),
        parentCount: 1,
        filesChanged: 1,
        changedFiles: ["src/auth.ts"],
        patch: "@@ -1,2 +1,3 @@\n+export const check = true;",
        truncated: false,
      },
    });
    expect(prompt).toContain("零上下文 PR 盲审");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("+export const check = true;");
  });

  it("emits at most one stuck consent card per (watchId, head) after threshold without auto-merging, and resets on new head", async () => {
    const alerts: PrWatchStuckAlert[] = [];
    await runInDurableObject(ownerStub(), async (raw) => {
      const instance = raw as unknown as Steward & {
        sql: SqlExecutor;
        ctx: { storage: { transactionSync<T>(fn: () => T): T } };
      };
      const sql = instance.sql.bind(instance);
      let nowMs = 1_000_000;
      let currentEvidence: EvidenceResult = {
        ok: true,
        evidence: { head: SAMPLE_HEAD, state: "waiting", checks: 2, failed: 0, pending: 2 },
      };

      const deps: PrWatchDeps = {
        sql,
        tx: (fn) => instance.ctx.storage.transactionSync(fn),
        now: () => nowMs,
        threadExists: (id) => id === "t_stuck_1",
        read: async () => currentEvidence,
        notify: async () => {},
        notifyStuck: async (alert) => {
          alerts.push(alert);
        },
        stuckThresholdMs: 2 * 3_600_000,
      };
      const service = new PrWatchService(deps);
      service.create({ id: "w_stuck_1", threadId: "t_stuck_1", url: SAMPLE_PR_URL });

      // 1. Initial check at t=0 -> stateSince recorded, not stuck yet
      await service.tick();
      expect(alerts).toHaveLength(0);

      // 2. +1 hour -> still below 2h threshold
      nowMs += 3_600_000;
      await service.tick();
      expect(alerts).toHaveLength(0);

      // 3. +2h 5m -> crosses 2h threshold -> emits stuck alert ONCE
      nowMs += 3_900_000;
      await service.tick();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.head).toBe(SAMPLE_HEAD);
      expect(alerts[0]!.reason).toContain("pending");

      // 4. +3h on same head -> deduplicated (`stuckNotifiedHead === SAMPLE_HEAD`)
      nowMs += 3_600_000;
      await service.tick();
      expect(alerts).toHaveLength(1);

      // 5. New commit pushed (`SAMPLE_NEXT_HEAD`) resets `stateSince` and `stuckNotifiedHead`
      currentEvidence = {
        ok: true,
        evidence: { head: SAMPLE_NEXT_HEAD, state: "waiting", checks: 2, failed: 0, pending: 2 },
      };
      nowMs += 900_000;
      await service.tick();
      expect(alerts).toHaveLength(1);

      nowMs += 2 * 3_600_000 + 60_000;
      await service.tick();
      expect(alerts).toHaveLength(2);
      expect(alerts[1]!.head).toBe(SAMPLE_NEXT_HEAD);
    });
  });

  it("handles stuck consent card probe/cancel taps and refuses octopus merges during zero-checkout blind review", async () => {
    const connector = await pairFakeConnector("mac-studio", {
      repos: [{ repoId: "/srv/repo-a", name: "repo-a" }],
      agents: ["claude-code", "codex"],
      autorun: false,
    });
    connector.gitPrDiff = true;
    let simulateOctopus = true;
    connector.gitPrDiffResponder = () =>
      simulateOctopus
        ? { ok: false, code: "octopus_merge_refused", message: "PR commit has 3 parents" }
        : {
            ok: true,
            diff: {
              headSha: SAMPLE_HEAD,
              baseSha: "d".repeat(40),
              parentCount: 2,
              filesChanged: 2,
              changedFiles: ["src/core.ts", "test/core.test.ts"],
              patch: "@@ -10,2 +10,4 @@\n+export function safeCheck() { return 1; }",
              truncated: false,
            },
          };
    await connector.connect();

    // Dispatch an initial author worker on `claude-code` so the Thread has repo + authorAgent context
    const d = await ownerStub().dispatchForTest({
      prompt: "Author PR work",
      repoRef: "repo-a",
      newTitle: "Auth Refactor PR",
      agent: "claude-code",
    });
    expect(d.kind).toBe("dispatched");
    if (d.kind !== "dispatched") throw new Error("expected dispatch");
    const [authorCmd] = await connector.waitForCmds(1);
    const authorWorkerId = String((authorCmd!.args as Record<string, unknown>).workerId);
    connector.send({ t: "cmd_ack", re: authorCmd!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: authorCmd!.id, ok: true, data: { sessionId: authorWorkerId } });
    await connector.emit("started", authorWorkerId, { sessionId: authorWorkerId });
    await connector.emit("report", authorWorkerId, {
      type: "report",
      status: "done",
      summary: "Author claims everything is fine",
    });
    await connector.emit("settled", authorWorkerId, { type: "settled", outcome: "reported" });

    // Create a PR watch on that thread and test octopus merge refusal first
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const watches = (instance as unknown as { prWatches: PrWatchService }).prWatches;
      watches.create({
        id: "pw_blind_1",
        threadId: d.threadId,
        url: SAMPLE_PR_URL,
      });
    });

    const octoOutcome = await runInDurableObject(ownerStub(), (instance: Steward) =>
      instance.runBlindPrReviewForWatch("pw_blind_1"),
    );
    expect(octoOutcome.ok).toBe(false);
    if (!octoOutcome.ok) {
      expect(octoOutcome.code).toBe("octopus_merge_refused");
    }

    // Now switch responder to normal 2-parent PR, emit stuck card, and tap `prstuck:pw_blind_1:probe`!
    simulateOctopus = false;
    const cardMsgId = "prstuck:pw_blind_1:" + SAMPLE_HEAD;
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      await (instance as unknown as {
        enqueueOutbound: (arg: Record<string, unknown>) => Promise<unknown>;
      }).enqueueOutbound({
        id: cardMsgId,
        kind: "card",
        to: "owner",
        threadId: d.threadId,
        urgency: "push",
        card: {
          text: "PR stalled",
          buttons: [
            { label: "派发只读探针诊断", action: "prstuck:pw_blind_1:probe", primary: true },
            { label: "取消此 PR 跟进", action: "prstuck:pw_blind_1:cancel" },
          ],
        },
      });
    });
    await waitWhileOutboundPending();

    const probeTapRes = await postEvent({
      cardMsgId,
      action: "prstuck:pw_blind_1:probe",
    });
    expect(probeTapRes.status).toBe(200);

    // Connector receives a cross-engine (`codex`, NOT `claude-code`) readonly sibling `start_worker`
    // whose prompt contains the diff and does NOT contain `"Author claims everything is fine"`!
    const cmds = await connector.waitForCmds(2);
    const reviewCmd = cmds[1]!;
    const reviewArgs = reviewCmd.args as Record<string, unknown>;
    expect(reviewArgs.agent).toBe("codex");
    expect(reviewArgs.mode).toBe("readonly");
    expect(String(reviewArgs.prompt)).toContain("src/core.ts");
    expect(String(reviewArgs.prompt)).not.toContain("Author claims everything is fine");

    // Tapping cancel cancels the watch deterministically
    const cancelTapRes = await postEvent({
      cardMsgId,
      action: "prstuck:pw_blind_1:cancel",
    });
    expect(cancelTapRes.status).toBe(200);
    const finalWatchStatus = await runInDurableObject(ownerStub(), (instance: Steward) =>
      (instance as unknown as { prWatches: PrWatchService }).prWatches.get("pw_blind_1")?.status,
    );
    expect(finalWatchStatus).toBe("cancelled");
    connector.close();
  });
});

describe("053_outbound_webhooks — Stage 5 Feishu Schema 2.0 Cards & Signed Outbound Webhooks", () => {
  it("renders Feishu Schema 2.0 cards with semantic header colors, collapsible panels, and 7-day link buttons", async () => {
    expect(CARD_LINK_TTL_MS).toBe(7 * 86_400_000);

    const longDetails = Array.from({ length: 30 }, (_, i) => `Detail paragraph ${i + 1}: verified module output and metrics.`).join("\n\n");
    const sampleUrl = ["https:", "", "otto.example", "link", "wl1.sample"].join("/");
    const v2 = renderFeishuCardV2({
      card: {
        text: `✅ 已完成跨引擎盲审\n\n${longDetails}`,
        buttons: [
          { label: "批准只读探针", action: "proposal:prop_1:approve", primary: true },
          { label: "查看 PR", url: SAMPLE_PR_URL },
        ],
      },
      title: "PR #42 盲审完成",
      workspaceUrl: sampleUrl,
    });

    expect(v2.schema).toBe("2.0");
    expect(v2.header.template).toBe("green");
    expect(v2.body.elements.some((el) => el.tag === "collapsible_panel")).toBe(true);
    const colSet = v2.body.elements.find((el) => el.tag === "column_set") as unknown as {
      columns: Array<{ elements: Array<{ behaviors: Array<{ default_url: string }> }> }>;
    };
    expect(colSet.columns).toHaveLength(2);
    expect(colSet.columns[0]!.elements[0]!.behaviors[0]!.default_url).toBe(sampleUrl);
    expect(colSet.columns[1]!.elements[0]!.behaviors[0]!.default_url).toBe(SAMPLE_PR_URL);

    // Signed Feishu V2 request includes `timestamp` and `sign`
    const feishuEndpoint = ["https:", "", "open.feishu.cn", "open-apis", "bot", "v2", "hook", "demo"].join("/");
    const built = await buildOutboundWebhookRequest(
      { kind: "feishu", url: feishuEndpoint, secretEnc: "feishu-bot-signing-word" },
      {
        id: "out_1",
        eventType: "worker_report",
        threadId: "t_1",
        card: { text: "⚠️ 等待主人确认" },
        workspaceUrl: sampleUrl,
        timestampMs: 1_700_000_000_000,
      },
    );
    const parsedBody = JSON.parse(built.body) as {
      msg_type: string;
      timestamp: string;
      sign: string;
      card: { schema: string; header: { template: string } };
    };
    expect(parsedBody.msg_type).toBe("interactive");
    expect(parsedBody.timestamp).toBe("1700000000");
    expect(typeof parsedBody.sign).toBe("string");
    expect(parsedBody.sign.length).toBeGreaterThan(10);
    expect(parsedBody.card.schema).toBe("2.0");
    expect(parsedBody.card.header.template).toBe("orange");
  });

  it("blocks SSRF private/loopback webhook targets and fans out signed webhooks with 7-day link tokens on outbound delivery", async () => {
    const httpUrl = ["http:", "", "hooks.public.example", "hook"].join("/");
    const loopbackUrl = ["https:", "", "127.0.0.1", "hook"].join("/");
    const metadataUrl = ["https:", "", "169.254.169.254", "latest"].join("/");
    const rfc1918Url = ["https:", "", "192.168.1.20", "hook"].join("/");
    const publicFeishuUrl = ["https:", "", "hooks.public.example", "feishu-v2"].join("/");
    const publicGenericUrl = ["https:", "", "hooks.public.example", "generic-hmac"].join("/");

    expect(validateWebhookTargetUrl(httpUrl).ok).toBe(false);
    expect(validateWebhookTargetUrl(loopbackUrl).ok).toBe(false);
    expect(validateWebhookTargetUrl(metadataUrl).ok).toBe(false);
    expect(validateWebhookTargetUrl(rfc1918Url).ok).toBe(false);
    expect(validateWebhookTargetUrl(publicFeishuUrl).ok).toBe(true);

    const capturedDeliveries: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      instance.setOutboundWebhookFetchForTest((async (input: RequestInfo | URL, init?: RequestInit) => {
        const headersObj: Record<string, string> = {};
        if (init?.headers && typeof init.headers === "object") {
          for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
            headersObj[k.toLowerCase()] = String(v);
          }
        }
        capturedDeliveries.push({
          url: String(input),
          headers: headersObj,
          body: String(init?.body ?? ""),
        });
        return new Response("ok", { status: 200 });
      }) as typeof fetch);

      const r1 = instance.outboundWebhooks.upsert({
        id: "wh_feishu",
        kind: "feishu",
        url: publicFeishuUrl,
        secret: "feishu-signing-phrase",
        events: ["worker_report"],
      });
      const r2 = instance.outboundWebhooks.upsert({
        id: "wh_generic",
        kind: "generic",
        url: publicGenericUrl,
        secret: "generic-signing-phrase",
        events: ["*"],
      });
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      const ledger = (instance as unknown as { ledger: import("../src/ledger.ts").Ledger }).ledger;
      const t = ledger.threads.create({ title: "Stage 5 Outbound Fanout", goal: "Verify webhook fanout" });
      await (instance as unknown as {
        enqueueOutbound: (arg: Record<string, unknown>) => Promise<unknown>;
      }).enqueueOutbound({
        id: "notify:report:w_stage5",
        kind: "card",
        to: "owner",
        threadId: t.threadId,
        urgency: "push",
        card: {
          text: "✅ 部署验证通过\n\n做了什么：\n- 完成全部单测",
          buttons: [{ label: "同意创建 PR", action: "pr_approve", primary: true }],
        },
      });
    });

    await waitWhileOutboundPending();

    expect(capturedDeliveries).toHaveLength(2);
    const feishuReq = capturedDeliveries.find((d) => d.url === publicFeishuUrl)!;
    const genericReq = capturedDeliveries.find((d) => d.url === publicGenericUrl)!;
    expect(feishuReq).toBeTruthy();
    expect(genericReq).toBeTruthy();

    const feishuPayload = JSON.parse(feishuReq.body) as {
      msg_type: string;
      sign: string;
      card: { schema: string };
    };
    expect(feishuPayload.msg_type).toBe("interactive");
    expect(feishuPayload.card.schema).toBe("2.0");
    expect(feishuPayload.sign).toBeTruthy();

    expect(genericReq.headers["x-otto-event"]).toBe("worker_report");
    expect(genericReq.headers["x-otto-signature-256"]?.startsWith("sha256=")).toBe(true);
    const genericPayload = JSON.parse(genericReq.body) as { workspaceUrl: string };
    expect(genericPayload.workspaceUrl).toContain("/link/wl1.");

    // Verify the minted link token in `workspaceUrl` has ~7-day expiry (`expiresAt - now > 6.9 days`)
    // AND opening it exchanges for a live session redirecting straight to the Thread (`303`), while a 2nd tap is rejected (`410`)!
    const tokenPart = genericPayload.workspaceUrl.split("/link/")[1]!;
    const expiresAtMs = Number(tokenPart.split(".")[2]);
    expect(expiresAtMs - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    const open1 = await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const res = await instance.fetch(new Request(genericPayload.workspaceUrl, { redirect: "manual" }));
      return {
        status: res.status,
        location: res.headers.get("location"),
        hasCookie: Boolean(res.headers.get("set-cookie")?.includes("otto_session=")),
      };
    });
    expect(open1.status).toBe(303);
    expect(open1.location?.startsWith("/app/threads/t_")).toBe(true);
    expect(open1.hasCookie).toBe(true);

    const open2Status = await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const res = await instance.fetch(new Request(genericPayload.workspaceUrl, { redirect: "manual" }));
      return res.status;
    });
    expect(open2Status).toBe(410);
  });
});
