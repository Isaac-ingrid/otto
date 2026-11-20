// End-to-end tests for Direction 1: Three-Way Explicit Stop & Inline Interrupt Loop.
// Verifies strict orthogonality across:
//   1. Steward Turn Stop (`POST /app/api/turn/stop`)
//   2. Worker Stop / Pre-Flight Withdrawal (`POST /app/api/workers/:workerId/stop`)
//   3. Thread-Scoped Multi-Worker Stop, Pending Plan Sweep & Archive Anti-Zombie Cleanup
//      (`POST /app/api/threads/:threadId/stop` & `POST /app/api/threads/:threadId/archive`)
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  configureAndBind,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitForWorkerState,
  waitWhileOutboundPending,
  webLogin,
} from "./helpers.ts";

const ORIGIN = "https://example.com";

async function openBrowser() {
  const cookie = await webLogin();
  const getWorkspace = async (includeArchived = false) => {
    const res = await SELF.fetch(
      `${ORIGIN}/app/api/workspace${includeArchived ? "?includeArchived=1" : ""}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      csrf: string;
      threads: Array<{
        id: string;
        state: string;
        archived: boolean;
        plans: {
          followups: Array<{ id: string; dueAt: number; reason: string }>;
          prWatches: Array<{ id: string; url: string; nextCheckAt: number }>;
          routines: Array<{
            id: string;
            kind: string;
            scheduleKind: string;
            cron: string | null;
            onceAt: number | null;
            instruction: string;
          }>;
        };
        workers: Array<{
          id: string;
          state: string;
          worktreeStatus: string;
          workerRelation?: "relay" | "sibling";
        }>;
      }>;
    };
  };
  const snap = await getWorkspace();
  const postJson = async <T>(
    path: string,
    body: unknown,
    opts: { csrf?: string; origin?: string | null; unauthenticated?: boolean } = {},
  ): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-csrf-token": opts.csrf ?? snap.csrf,
    };
    if (!opts.unauthenticated) headers.cookie = cookie;
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    const res = await SELF.fetch(`${ORIGIN}/app/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // plain text 401/403
    }
    return { status: res.status, body: parsed as T };
  };
  return { cookie, csrf: snap.csrf, getWorkspace, postJson };
}

describe("Three-way explicit stop & inline interrupt loop", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await configureAndBind("ou_owner");
  });

  it("enforces session, Origin, CSRF, validation, 404s, request-id idempotency, and works while over_budget", async () => {
    const b = await openBrowser();

    // Unauthenticated -> 401
    expect(
      (await b.postJson("workers/w_missing/stop", { id: "req_auth_0001" }, { unauthenticated: true })).status,
    ).toBe(401);
    expect(
      (await b.postJson("threads/t_missing/stop", { id: "req_auth_0002", stopWorkers: true }, { unauthenticated: true })).status,
    ).toBe(401);

    // Missing Origin / wrong CSRF -> 403
    expect(
      (await b.postJson("workers/w_missing/stop", { id: "req_csrf_0001" }, { origin: null })).status,
    ).toBe(403);
    expect(
      (await b.postJson("threads/t_missing/stop", { id: "req_csrf_0002" }, { csrf: "wrong-token" })).status,
    ).toBe(403);

    // Invalid body -> 400
    expect(
      (await b.postJson<{ error: string }>("workers/w_missing/stop", { id: "short" })).status,
    ).toBe(400);
    expect(
      (await b.postJson<{ error: string }>("threads/t_missing/stop", { id: "req_bad_flag_1", stopWorkers: "yes" })).status,
    ).toBe(400);

    // Missing targets -> 404
    const missWorker = await b.postJson<{ error: string }>("workers/w_missing/stop", { id: "req_404_worker" });
    expect(missWorker.status).toBe(404);
    expect(missWorker.body.error).toBe("worker_not_found");

    const missThread = await b.postJson<{ error: string }>("threads/t_missing/stop", {
      id: "req_404_thread",
      stopWorkers: true,
    });
    expect(missThread.status).toBe(404);
    expect(missThread.body.error).toBe("thread_not_found");

    // Over-budget zero-token determinism + idempotency + 409 id_conflict
    const connector = await pairFakeConnector("mac-stop-sec", { autorun: false });
    await connector.connect();
    await ownerStub().spendForTest(999, 250_000);
    expect((await ownerStub().budgetStatus()).over).toBe(true);

    const d = await ownerStub().dispatchForTest({
      prompt: "long running build",
      repoRef: "repo-a",
      newTitle: "安全与幂等停止",
    });
    expect(d.kind).toBe("dispatched");
    const workerId = d.kind === "dispatched" ? d.workerId : "";
    const threadId = d.kind === "dispatched" ? d.threadId : "";
    const [startCmd] = await connector.waitForCmds(1);
    connector.send({ t: "cmd_ack", re: startCmd!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: startCmd!.id, ok: true, data: { sessionId: workerId, branch: "otto/sec-1" } });
    await connector.emit("started", workerId, { sessionId: workerId, branch: "otto/sec-1" });

    const firstStop = await b.postJson<{
      ok: boolean;
      id: string;
      workerId: string;
      threadId: string;
      outcome: string;
    }>(`workers/${workerId}/stop`, { id: "req_idem_wstop_1" });
    expect(firstStop.status).toBe(200);
    expect(firstStop.body).toEqual({
      ok: true,
      id: "req_idem_wstop_1",
      workerId,
      threadId,
      outcome: "interrupt_sent",
    });

    const [, interruptCmd] = await connector.waitForCmds(2);
    expect(interruptCmd).toMatchObject({
      kind: "interrupt",
      id: "wstop:req_idem_wstop_1",
      workerId,
      args: { workerId },
    });

    // Replay with identical request id returns exact cached payload without enqueueing a 3rd command
    const replayStop = await b.postJson<typeof firstStop.body>(`workers/${workerId}/stop`, {
      id: "req_idem_wstop_1",
    });
    expect(replayStop.status).toBe(200);
    expect(replayStop.body).toEqual(firstStop.body);
    await new Promise((r) => setTimeout(r, 40));
    expect(connector.cmds).toHaveLength(2);

    // Reusing the same request id on a different workerId rejects with 409 id_conflict
    const conflictStop = await b.postJson<{ error: string }>("workers/w_other_target/stop", {
      id: "req_idem_wstop_1",
    });
    expect(conflictStop.status).toBe(409);
    expect(conflictStop.body.error).toBe("id_conflict");

    connector.close();
  });

  it("withdraws pre-flight offline start_worker and queued resume commands atomically without stranding the Thread", async () => {
    const connector = await pairFakeConnector("mac-offline-withdraw", { autorun: false });
    await connector.connect();
    await new Promise((r) => setTimeout(r, 60));
    connector.close();
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.machines.every((m) => !m.online)) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Case A: brand-new offline dispatch (`asked_offline` -> held `start_worker` + open `offline:` ask)
    const asked = await ownerStub().dispatchForTest({
      prompt: "offline task",
      repoRef: "repo-a",
      newTitle: "离线待撤回任务",
    });
    expect(asked.kind).toBe("asked_offline");
    await waitWhileOutboundPending();

    const snapBefore = await ownerStub().debugSnapshot();
    const offlineThread = snapBefore.threads[0]!;
    const offlineWorker = offlineThread.workers[0]!;
    expect(offlineWorker.state).toBe("starting");
    expect(snapBefore.offlineDispatches[0]?.status).toBe("offered");

    const b = await openBrowser();
    // Before stopping: archiving rejects with 409 thread_active
    const blockedArchive = await b.postJson<{ error: string }>(
      `threads/${offlineThread.threadId}/archive`,
      { id: "req_arch_blocked_offline", archived: true },
    );
    expect(blockedArchive.status).toBe(409);
    expect(blockedArchive.body.error).toBe("thread_active");

    // Pre-flight stop withdraws the queued start_worker, closes the offline card, and frees the Thread!
    const withdrawnStart = await b.postJson<{
      ok: boolean;
      outcome: string;
      workerId: string;
      threadId: string;
    }>(`workers/${offlineWorker.workerId}/stop`, { id: "req_withdraw_start_01" });
    expect(withdrawnStart.status).toBe(200);
    expect(withdrawnStart.body.outcome).toBe("withdrawn");

    const cmdAfter = await ownerStub().outboxRow(offlineWorker.cmdId!);
    expect(cmdAfter?.state).toBe("expired");
    const snapAfterWithdraw = await ownerStub().debugSnapshot();
    const settledThread = snapAfterWithdraw.threads.find((t) => t.threadId === offlineThread.threadId)!;
    expect(settledThread.state).toBe("idle");
    expect(settledThread.workers[0]).toMatchObject({
      state: "idle",
      lastOutcome: "cancelled",
      worktreeStatus: "none",
    });
    expect(snapAfterWithdraw.offlineDispatches[0]?.status).toBe("cancelled");
    expect(snapAfterWithdraw.questions.find((q) => q.qid === `offline:${offlineWorker.cmdId!}`)?.status).toBe("answered");

    // Immediately archivable with zero cleanup_worktree commands queued!
    const okArchive = await b.postJson<{
      archived: boolean;
      cleanedWorkers: string[];
      queuedWorkers: string[];
    }>(`threads/${offlineThread.threadId}/archive`, { id: "req_arch_after_withdraw", archived: true });
    expect(okArchive.status).toBe(200);
    expect(okArchive.body).toMatchObject({
      archived: true,
      cleanedWorkers: [],
      queuedWorkers: [],
    });

    // Case B: settled session (`sessionId !== null`) gets an offline continuation (`send`), then withdrawn -> reverts to `idle` preserving `sessionId`!
    await connector.connect();
    const d2 = await ownerStub().dispatchForTest({
      prompt: "leg 1 online",
      repoRef: "repo-a",
      newTitle: "会话接续撤回",
    });
    expect(d2.kind).toBe("dispatched");
    const w2 = d2.kind === "dispatched" ? d2.workerId : "";
    const t2 = d2.kind === "dispatched" ? d2.threadId : "";
    const [cmd2] = await connector.waitForCmds(1);
    connector.send({ t: "cmd_ack", re: cmd2!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: cmd2!.id, ok: true, data: { sessionId: "sess_keep_1", branch: "otto/keep-1" } });
    await connector.emit("started", w2, { sessionId: "sess_keep_1", branch: "otto/keep-1" });
    await connector.emit("report", w2, {
      status: "done",
      summary: "第一棒完成",
      git: { branch: "otto/keep-1", base: "main", ahead: 1, dirty: 0, filesChanged: 1, insertions: 3, deletions: 0, pushed: true },
    });
    await connector.emit("settled", w2, { outcome: "reported" });
    await waitForWorkerState("idle");

    // Take machine offline and trigger a resume continuation (parks `send` in outbox, flips worker to `starting`)
    connector.close();
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.machines.every((m) => !m.online)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const resumeAsk = await ownerStub().dispatchForTest({
      prompt: "leg 2 while offline",
      repoRef: "repo-a",
      threadId: t2,
    });
    expect(resumeAsk.kind).toBe("asked_offline");

    const withdrawnResume = await b.postJson<{ outcome: string }>(`workers/${w2}/stop`, {
      id: "req_withdraw_resume_01",
    });
    expect(withdrawnResume.status).toBe(200);
    expect(withdrawnResume.body.outcome).toBe("withdrawn");

    const snapResumeAfter = await ownerStub().debugSnapshot();
    const thread2After = snapResumeAfter.threads.find((t) => t.threadId === t2)!;
    expect(thread2After.state).toBe("idle");
    expect(thread2After.workers[0]).toMatchObject({
      workerId: w2,
      state: "idle",
      sessionId: "sess_keep_1",
      branch: "otto/keep-1",
    });
  });

  it("handles all 5 worker stop outcomes and preserves pending followups/watches when stopping only a worker", async () => {
    const connector = await pairFakeConnector("mac-five-states", { autorun: false });
    await connector.connect();

    const d = await ownerStub().dispatchForTest({
      prompt: "investigate flaky test",
      repoRef: "repo-a",
      newTitle: "五态裁决与三态正交",
    });
    expect(d.kind).toBe("dispatched");
    const workerId = d.kind === "dispatched" ? d.workerId : "";
    const threadId = d.kind === "dispatched" ? d.threadId : "";
    const [startCmd] = await connector.waitForCmds(1);
    connector.send({ t: "cmd_ack", re: startCmd!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: startCmd!.id, ok: true, data: { sessionId: workerId, branch: "otto/orth-1" } });
    await connector.emit("started", workerId, { sessionId: workerId, branch: "otto/orth-1" });

    // Seed an open followup and an active PR watch on the exact same Thread
    const prUrl = ["https://github.com", "example", "repo-a", "pull", "88"].join("/");
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const internal = instance as unknown as {
        routineService: { setFollowup(input: Record<string, unknown>): Promise<unknown> };
        prWatches: { create(input: Record<string, unknown>): unknown };
      };
      await internal.routineService.setFollowup({
        followupId: "f_orth_1",
        threadId,
        afterMinutes: 45,
        reason: "回看回归测试结果",
        createdBy: "user",
        sourceRef: "user:seed_orth",
      });
      internal.prWatches.create({
        id: "w_orth_1",
        threadId,
        url: prUrl,
        intervalSeconds: 300,
      });
    });

    const b = await openBrowser();

    // 1. Offline running worker -> interrupt_queued_offline
    connector.close();
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.machines.every((m) => !m.online)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const queuedOffline = await b.postJson<{ outcome: string }>(`workers/${workerId}/stop`, {
      id: "req_wstop_offline_1",
    });
    expect(queuedOffline.status).toBe(200);
    expect(queuedOffline.body.outcome).toBe("interrupt_queued_offline");
    expect((await ownerStub().outboxRow("wstop:req_wstop_offline_1"))?.state).toBe("queued");

    // Reconnect delivers the queued interrupt; connector settles worker as aborted -> idle
    connector.workers = [
      { workerId, agent: "pi", state: "running", lastSeq: 1, sessionId: workerId, lastOutcome: "", hasWorktree: true },
    ];
    await connector.connect();
    const [, deliveredInterrupt] = await connector.waitForCmds(2);
    expect(deliveredInterrupt).toMatchObject({ kind: "interrupt", id: "wstop:req_wstop_offline_1", workerId });
    connector.send({ t: "cmd_ack", re: deliveredInterrupt!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: deliveredInterrupt!.id, ok: true, data: {} });
    await connector.emit("settled", workerId, { outcome: "aborted" });
    await waitForWorkerState("idle");

    // Strict Three-Way Orthogonality: stopping the worker NEVER cancelled the Thread's followup or PR watch,
    // and NEVER emitted cleanup_worktree!
    expect(connector.cmds.some((c) => c.kind === "cleanup_worktree")).toBe(false);
    const wsAfterAbort = await b.getWorkspace();
    const threadView = wsAfterAbort.threads.find((t) => t.id === threadId)!;
    expect(threadView.plans.followups.map((f) => f.id)).toEqual(["f_orth_1"]);
    expect(threadView.plans.prWatches.map((w) => w.id)).toEqual(["w_orth_1"]);

    // 2. Idle worker -> already_stopped (zero extra outbox commands)
    const idleStop = await b.postJson<{ outcome: string }>(`workers/${workerId}/stop`, {
      id: "req_wstop_idle_1",
    });
    expect(idleStop.status).toBe(200);
    expect(idleStop.body.outcome).toBe("already_stopped");
    expect(await ownerStub().outboxRow("wstop:req_wstop_idle_1")).toBeNull();

    // 3. Broken worker -> already_stopped
    await ownerStub().setWorkerStateForTest(workerId, "broken", "error:auth");
    const brokenStop = await b.postJson<{ outcome: string }>(`workers/${workerId}/stop`, {
      id: "req_wstop_broken_1",
    });
    expect(brokenStop.status).toBe(200);
    expect(brokenStop.body.outcome).toBe("already_stopped");
    expect(await ownerStub().outboxRow("wstop:req_wstop_broken_1")).toBeNull();

    // 4. Lost worker -> unreachable
    await ownerStub().setWorkerStateForTest(workerId, "lost", "reaped");
    const lostStop = await b.postJson<{ outcome: string }>(`workers/${workerId}/stop`, {
      id: "req_wstop_lost_1",
    });
    expect(lostStop.status).toBe(200);
    expect(lostStop.body.outcome).toBe("unreachable");
    expect(await ownerStub().outboxRow("wstop:req_wstop_lost_1")).toBeNull();

    connector.close();
  });

  it("stops multi-worker threads (relay + sibling), sweeps one-off plans while preserving routines, and cleans residual plans on archive", async () => {
    const macA = await pairFakeConnector("mac-primary", {
      autorun: false,
      agents: ["pi"],
      repos: [
        { repoId: "repo-a", name: "repo-a" },
        { repoId: "/srv/local-shared", name: "local-shared" },
      ],
    });
    const macB = await pairFakeConnector("mac-remote", {
      autorun: false,
      agents: ["pi"],
      repos: [{ repoId: "/srv/remote-docs", name: "remote-docs" }],
    });
    await macA.connect();
    await macB.connect();

    // Start primary relay worker on macA
    const d1 = await ownerStub().dispatchForTest({
      prompt: "main feature implementation",
      repoRef: "repo-a",
      newTitle: "多会话与挂起计划收口",
      machineHint: "mac-primary",
    });
    expect(d1.kind).toBe("dispatched");
    const threadId = d1.kind === "dispatched" ? d1.threadId : "";
    const relayWorkerId = d1.kind === "dispatched" ? d1.workerId : "";
    const [relayStart] = await macA.waitForCmds(1);
    macA.send({ t: "cmd_ack", re: relayStart!.id, status: "accepted" });
    macA.send({ t: "cmd_result", re: relayStart!.id, ok: true, data: { sessionId: relayWorkerId, branch: "otto/multi-1" } });
    await macA.emit("started", relayWorkerId, { sessionId: relayWorkerId, branch: "otto/multi-1" });

    // Emit two proposals from relayWorker:
    //  1) same-machine readonly probe on repo-a -> auto-approved & dispatched (`siblingWorkerId`)
    //  2) cross-machine readonly probe on remote-docs -> `pending_owner` (`pendingProposalId`)
    await macA.emit("proposal", relayWorkerId, {
      kind: "readonly_probe",
      proposalKey: "probe_same_1",
      targetRepoRef: "local-shared",
      prompt: "inspect auth types",
      reason: "核对本地认证类型定义",
    });
    await macA.emit("proposal", relayWorkerId, {
      kind: "readonly_probe",
      proposalKey: "probe_cross_1",
      targetRepoRef: "remote-docs",
      prompt: "inspect remote API spec",
      reason: "核对远端接口契约",
    });

    const [, siblingStart] = await macA.waitForCmds(2);
    expect(siblingStart!.kind).toBe("start_worker");
    const siblingWorkerId = String((siblingStart!.args as Record<string, unknown>).workerId);
    macA.send({ t: "cmd_ack", re: siblingStart!.id, status: "accepted" });
    macA.send({ t: "cmd_result", re: siblingStart!.id, ok: true, data: { sessionId: siblingWorkerId } });
    await macA.emit("started", siblingWorkerId, { sessionId: siblingWorkerId });

    // Seed followup + PR watch + bound recurring routine on `threadId`
    const prUrl1 = ["https://github.com", "example", "repo-a", "pull", "101"].join("/");
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const internal = instance as unknown as {
        routineService: {
          create(input: Record<string, unknown>): Promise<unknown>;
          setFollowup(input: Record<string, unknown>): Promise<unknown>;
        };
        prWatches: { create(input: Record<string, unknown>): unknown };
      };
      await internal.routineService.setFollowup({
        followupId: "f_sweep_1",
        threadId,
        afterMinutes: 30,
        reason: "跟进联调状态",
        createdBy: "user",
        sourceRef: "user:seed_sweep",
      });
      internal.prWatches.create({
        id: "w_sweep_1",
        threadId,
        url: prUrl1,
        intervalSeconds: 300,
      });
      await internal.routineService.create({
        routineId: "r_sweep_1",
        kind: "instruction",
        scheduleKind: "cron",
        cron: "0 10 * * *",
        instruction: "每日检查回归状态",
        createdFromMsg: "user:seed_sweep",
        threadId,
      });
    });

    const b = await openBrowser();
    const ws1 = await b.getWorkspace();
    const tView1 = ws1.threads.find((t) => t.id === threadId)!;
    expect(tView1.plans.followups.map((f) => f.id)).toEqual(["f_sweep_1"]);
    expect(tView1.plans.prWatches.map((w) => w.id)).toEqual(["w_sweep_1"]);
    expect(tView1.plans.routines.map((r) => r.id)).toEqual(["r_sweep_1"]);
    expect(tView1.workers.find((w) => w.id === relayWorkerId)?.workerRelation).toBe("relay");
    expect(tView1.workers.find((w) => w.id === siblingWorkerId)?.workerRelation).toBe("sibling");

    // Step 1: Stop all active workers on the Thread (`stopWorkers: true` only)
    const stopWorkersRes = await b.postJson<{
      ok: boolean;
      workers: Array<{ workerId: string; outcome: string }>;
      cancelledFollowups: string[];
      cancelledPrWatches: string[];
      expiredProposals: string[];
      pausedRoutines: string[];
    }>(`threads/${threadId}/stop`, {
      id: "req_tstop_workers_01",
      stopWorkers: true,
    });
    expect(stopWorkersRes.status).toBe(200);
    expect(stopWorkersRes.body.workers).toEqual([
      { workerId: relayWorkerId, outcome: "interrupt_sent" },
      { workerId: siblingWorkerId, outcome: "interrupt_sent" },
    ]);
    expect(stopWorkersRes.body.cancelledFollowups).toEqual([]);
    expect(stopWorkersRes.body.cancelledPrWatches).toEqual([]);
    expect(stopWorkersRes.body.pausedRoutines).toEqual([]);

    const cmdsAfterStopWorkers = await macA.waitForCmds(4);
    expect(cmdsAfterStopWorkers.slice(2).map((c) => ({ kind: c.kind, workerId: c.workerId }))).toEqual([
      { kind: "interrupt", workerId: relayWorkerId },
      { kind: "interrupt", workerId: siblingWorkerId },
    ]);

    // Plans are still intact after stopping workers!
    const wsAfterWorkers = await b.getWorkspace();
    const tView2 = wsAfterWorkers.threads.find((t) => t.id === threadId)!;
    expect(tView2.plans.followups).toHaveLength(1);
    expect(tView2.plans.prWatches).toHaveLength(1);
    expect(tView2.plans.routines).toHaveLength(1);

    // Step 2: Cancel one-off plans (`cancelFollowups + cancelPrWatches + expireProposals`), preserving `r_sweep_1`!
    const sweepPlansRes = await b.postJson<{
      cancelledFollowups: string[];
      cancelledPrWatches: string[];
      expiredProposals: string[];
      pausedRoutines: string[];
    }>(`threads/${threadId}/stop`, {
      id: "req_tstop_plans_01",
      cancelFollowups: true,
      cancelPrWatches: true,
      expireProposals: true,
    });
    expect(sweepPlansRes.status).toBe(200);
    expect(sweepPlansRes.body.cancelledFollowups).toEqual(["f_sweep_1"]);
    expect(sweepPlansRes.body.cancelledPrWatches).toEqual(["w_sweep_1"]);
    expect(sweepPlansRes.body.expiredProposals).toHaveLength(1);
    expect(sweepPlansRes.body.pausedRoutines).toEqual([]);

    const wsAfterSweep = await b.getWorkspace();
    const tView3 = wsAfterSweep.threads.find((t) => t.id === threadId)!;
    expect(tView3.plans.followups).toEqual([]);
    expect(tView3.plans.prWatches).toEqual([]);
    // Recurring routine stays active until explicitly paused!
    expect(tView3.plans.routines.map((r) => r.id)).toEqual(["r_sweep_1"]);

    // Step 3: Explicit `pauseRoutines: true` pauses the bound routine
    const pauseRoutineRes = await b.postJson<{ pausedRoutines: string[] }>(`threads/${threadId}/stop`, {
      id: "req_tstop_routines_01",
      pauseRoutines: true,
    });
    expect(pauseRoutineRes.status).toBe(200);
    expect(pauseRoutineRes.body.pausedRoutines).toEqual(["r_sweep_1"]);
    expect((await b.getWorkspace()).threads.find((t) => t.id === threadId)!.plans.routines).toEqual([]);

    // Step 4: Archive anti-zombie cleanup — archiving an idle Thread automatically cancels residual
    // one-off followups & PR watches so an archived Thread never wakes Steward later, while preserving routines!
    let archiveThreadId = "";
    const prUrl2 = ["https://github.com", "example", "repo-a", "pull", "202"].join("/");
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const internal = instance as unknown as {
        ledger: Steward["ledger"];
        routineService: {
          create(input: Record<string, unknown>): Promise<unknown>;
          setFollowup(input: Record<string, unknown>): Promise<unknown>;
        };
        prWatches: { create(input: Record<string, unknown>): unknown };
      };
      const tArch = internal.ledger.threads.create({ title: "归档防诈尸验证", goal: "验证归档自动清理一次性计划" });
      archiveThreadId = tArch.threadId;
      await internal.routineService.setFollowup({
        followupId: "f_arch_zombie_1",
        threadId: archiveThreadId,
        afterMinutes: 15,
        reason: "归档前残留跟进",
        createdBy: "steward",
        sourceRef: "user:seed_arch",
      });
      internal.prWatches.create({
        id: "w_arch_zombie_1",
        threadId: archiveThreadId,
        url: prUrl2,
        intervalSeconds: 300,
      });
      await internal.routineService.create({
        routineId: "r_arch_keep_1",
        kind: "digest",
        scheduleKind: "cron",
        cron: "0 9 * * 1",
        instruction: "每周一晨报",
        createdFromMsg: "user:seed_arch",
        threadId: archiveThreadId,
      });
    });

    const archRes = await b.postJson<{
      archived: boolean;
      cancelledFollowups: string[];
      cancelledPrWatches: string[];
      expiredProposals: string[];
    }>(`threads/${archiveThreadId}/archive`, {
      id: "req_arch_anti_zombie_01",
      archived: true,
    });
    expect(archRes.status).toBe(200);
    expect(archRes.body).toMatchObject({
      archived: true,
      cancelledFollowups: ["f_arch_zombie_1"],
      cancelledPrWatches: ["w_arch_zombie_1"],
    });
    expect(archRes.body.expiredProposals).toBeUndefined();

    const finalSnap = await ownerStub().debugSnapshot();
    expect(finalSnap.followups.find((f) => f.followupId === "f_arch_zombie_1")?.status).toBe("cancelled");
    expect(finalSnap.routines.find((r) => r.routineId === "r_arch_keep_1")?.status).toBe("active");

    macA.close();
    macB.close();
  });
});
