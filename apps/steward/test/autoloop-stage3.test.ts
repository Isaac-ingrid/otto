import { runInDurableObject } from "cloudflare:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import type { Ledger } from "../src/ledger.ts";
import type { RoutineService } from "../src/routines.ts";
import {
  normalizeGitHubWebhook,
  normalizeGitLabWebhook,
  verifyGitHubSignature256,
  verifyGitLabToken,
} from "../src/inbound-sources.ts";
import { followupWakeText } from "../src/wake-text.ts";
import {
  configureAndBind,
  messageEvent,
  modelRequests,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

function routinesOf(instance: Steward): RoutineService {
  return (instance as unknown as { routineService: RoutineService }).routineService;
}

function ledgerOf(instance: Steward): Ledger {
  return (instance as unknown as { ledger: Ledger }).ledger;
}

describe("051_probes_autohops_and_replay — Stage 3 Steward capabilities", () => {
  it("runs approved local probes at zero LLM cost when untriggered, wakes Steward on trigger, and honors pausedUntil snooze", async () => {
    const connector = await pairFakeConnector("mac-studio", {
      repos: [{ repoId: "/srv/repo-a", name: "repo-a" }],
    });
    connector.localProbes = true;
    connector.approvedProbes = ["release-watch"];
    let shouldTrigger = false;
    connector.probeResponder = () => ({
      ok: true,
      probeName: "release-watch",
      output: shouldTrigger
        ? { triggered: true, summary: "Upstream v3.1.0 released", data: { tag: "v3.1.0" } }
        : { triggered: false, summary: "still v3.0.9" },
      durationMs: 14,
    });
    await connector.connect();

    await scriptModel(fauxAssistantMessage([fauxText("好的。")]));
    await postEvent(messageEvent({ msgId: "msg_prov_1", text: "准备配置本地探针" }));
    await waitRunsSettled();
    const baselineRequests = (await modelRequests()).length;

    const rejectedUnapproved = await runInDurableObject(ownerStub(), (instance: Steward) =>
      routinesOf(instance).create({
        routineId: "r_bad_probe",
        createdFromMsg: "msg_prov_1",
        kind: "probe",
        probeName: "unapproved-script",
        deviceId: connector.deviceId,
        onceAt: Date.now() + 3600_000,
        instruction: "有新版本时提醒我",
      }),
    );
    expect(rejectedUnapproved.ok).toBe(false);

    const created = await runInDurableObject(ownerStub(), (instance: Steward) =>
      routinesOf(instance).create({
        routineId: "r_release_probe",
        createdFromMsg: "msg_prov_1",
        kind: "probe",
        probeName: "release-watch",
        deviceId: connector.deviceId,
        repoId: "/srv/repo-a",
        cron: "0 9 * * 1-5",
        instruction: "发现新版本后通知我评估升级",
      }),
    );
    expect(created.ok).toBe(true);

    // 1. Fire when `triggered === false` -> ZERO Steward LLM requests!
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      await routinesOf(instance).fire("r_release_probe", { time: 1001 });
    });
    expect(connector.probeRequests).toHaveLength(1);
    expect((await modelRequests()).length).toBe(baselineRequests);

    const outcomeAfterSilent = await runInDurableObject(ownerStub(), (instance: Steward) =>
      ledgerOf(instance).routines.get("r_release_probe")?.lastResult,
    );
    expect(outcomeAfterSilent).toBe("silent:probe_untriggered");

    // 2. Snooze via `pausedUntil` -> skips probe execution completely until window expires
    const futureUntil = Date.now() + 60_000;
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const snooze = routinesOf(instance).pauseUntil("r_release_probe", futureUntil);
      expect(snooze.ok).toBe(true);
      await routinesOf(instance).fire("r_release_probe", { time: 1002 });
    });
    expect(connector.probeRequests).toHaveLength(1);

    // 3. Clear snooze (`null`) and fire with `triggered === true` -> wakes Steward LLM!
    shouldTrigger = true;
    await scriptModel(fauxAssistantMessage([fauxText("收到探针通知：上游已发布 v3.1.0。")]));
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      routinesOf(instance).pauseUntil("r_release_probe", null);
      await routinesOf(instance).fire("r_release_probe", { time: 1003 });
    });
    await waitRunsSettled();
    await waitWhileOutboundPending();

    expect(connector.probeRequests).toHaveLength(2);
    expect((await modelRequests()).length).toBeGreaterThan(baselineRequests);
    connector.close();
  });

  it("trips the autoHops > 8 circuit breaker on autonomous wakes and resets autoHops on owner input", async () => {
    const baselineRequests = (await modelRequests()).length;

    const threadId = await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const ledger = ledgerOf(instance);
      const t = ledger.threads.create({ title: "Hop Limit Check", goal: "Verify autoHops breaker" });
      ledger.threads.setAutoHops(t.threadId, 8);
      ledger.wakes.queue(
        "followup",
        "followup:f_hop_9",
        followupWakeText("f_hop_9", "check status again", {
          thread: { threadId: t.threadId, title: t.title },
          createdBy: "steward",
        }),
        {
          operationId: "followup:f_hop_9",
          autoHops: 9,
          dueAt: Date.now() - 10,
        },
      );
      await instance.drainWakes();
      return t.threadId;
    });

    await waitWhileOutboundPending();
    expect((await modelRequests()).length).toBe(baselineRequests);

    const snap = await ownerStub().debugSnapshot();
    expect(snap.wakes.find((w) => w.operationId === "followup:f_hop_9")?.status).toBe("skipped");
    const threadView = snap.threads.find((t) => t.threadId === threadId);
    expect(threadView?.timeline.some((e) => e.text.includes("自动推进熔断"))).toBe(true);

    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = ledgerOf(instance);
      ledger.threads.resetAutoHops(threadId);
      expect(ledger.threads.get(threadId)?.autoHops).toBe(0);
    });
  });

  it("normalizes GitHub & GitLab webhooks, records skipped events during pausedUntil, and replays once without duplicates", async () => {
    expect(verifyGitLabToken("alpha-check-value", "alpha-check-value")).toBe(true);
    expect(verifyGitLabToken("alpha-check-value", "mismatch-value")).toBe(false);
    expect(await verifyGitHubSignature256("alpha-check-value", "{}", null)).toBe(false);

    const payloadObj = {
      action: "opened",
      number: 42,
      repository: { full_name: "acme/otto" },
      pull_request: {
        number: 42,
        title: "feat: zero-token probe check",
        head: { sha: "abcdef123456" },
      },
    };
    const normGh = normalizeGitHubWebhook("pull_request", "deliv-42", payloadObj);
    expect(normGh.actionable).toBe(true);

    const normGl = normalizeGitLabWebhook("Pipeline Hook", {
      object_kind: "pipeline",
      project: { path_with_namespace: "acme/core" },
      object_attributes: { id: 991, status: "failed", sha: "123456abcdef" },
    });
    expect(normGl.actionable).toBe(true);

    const pausedUntil = Date.now() + 120_000;
    const baselineRequests = (await modelRequests()).length;
    const recOutcome = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = ledgerOf(instance);
      instance.configureInboundSource("github", "inbound-hook-phrase", pausedUntil);
      const first = ledger.skippedEvents.record({
        source: "github",
        eventKey: normGh.eventKey,
        summary: normGh.summary,
        payloadJson: JSON.stringify(normGh.payloadSummary),
      });
      const second = ledger.skippedEvents.record({
        source: "github",
        eventKey: normGh.eventKey,
        summary: normGh.summary,
        payloadJson: JSON.stringify(normGh.payloadSummary),
      });
      return { first, second };
    });
    expect(recOutcome.first.duplicate).toBe(false);
    expect(recOutcome.second.duplicate).toBe(true);
    expect((await modelRequests()).length).toBe(baselineRequests);

    await scriptModel(fauxAssistantMessage([fauxText("已处理暂停期间积压的 PR #42 事件。")]));
    const replay1 = await runInDurableObject(ownerStub(), async (instance: Steward) => {
      instance.pauseInboundSource("github", null);
      return instance.replaySkippedEvents({ source: "github" });
    });
    expect(replay1.replayed).toBe(1);
    await waitRunsSettled();

    const replay2 = await runInDurableObject(ownerStub(), (instance: Steward) =>
      instance.replaySkippedEvents({ source: "github" }),
    );
    expect(replay2.replayed).toBe(0);
  });
});
