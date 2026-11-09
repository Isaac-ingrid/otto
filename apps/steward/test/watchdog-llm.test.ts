// Issue #3, DO side: the LLM half of the §8.4 stall alarm. When a run goes silent the core
// already notifies the owner deterministically; with WATCHDOG_LLM=1 it ALSO gives the model
// one look at the same silence, so a stuck run can be re-planned before it is lost. The
// verdict itself never moves: 45 minutes of silence still ends the run, whether the model
// answered, re-planned, or never ran at all (that is the whole point of the boundary, and
// each test below pins one side of it).
import { runInDurableObject } from "cloudflare:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  configureAndBind,
  llmState,
  messageEvent,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
  type FakeConnector,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

const MIN = 60_000;
const ORIGIN_MSG = "om_watchdog_origin";

/** Flips the ask on inside the isolate (the env var's production equivalent). */
async function enableWatchdog(on = true): Promise<void> {
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    (instance as unknown as { watchdogLlm?: boolean }).watchdogLlm = on;
  });
}

/** Backdates the worker's lastEventAt — the stall alarm's clock. */
async function backdate(workerId: string, minutes: number): Promise<void> {
  await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE sh_worker SET lastEventAt = ${Date.now() - minutes * MIN} WHERE workerId = '${workerId}'`);
  });
}

function sweep(): Promise<{ stalled: number; reaped: number }> {
  return ownerStub().sweepWorkers();
}

async function watchdogWakes() {
  return (await ownerStub().debugSnapshot()).wakes.filter((w) => w.kind === "watchdog");
}

/** Polls the snapshot until pred holds (wakes, workers and runs land asynchronously). */
async function waitFor<T>(get: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (pred(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not reached: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * One running worker dispatched through the LLM tool path, so the Thread carries the user
 * message that authorized it (the watchdog wake offers it as the re-plan's provenance).
 */
async function dispatchedRunningWorker(prompt = "修复登录 bug"): Promise<{ fake: FakeConnector; workerId: string; threadId: string }> {
  const fake = await pairFakeConnector("mac-studio", { repoId: "/srv/repo-a", run: null, autorun: false });
  await fake.connect();
  await scriptModel(
    fauxAssistantMessage([fauxToolCall("start_worker", { prompt, repoRef: "repo-a", newTitle: prompt, basis: "user_explicit" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("已派发。")]),
  );
  await postEvent(messageEvent({ msgId: ORIGIN_MSG, text: `请处理：${prompt}` }));
  const [cmd] = await fake.waitForCmds(1);
  const args = cmd!.args as Record<string, unknown>;
  const workerId = String(args.workerId);
  const threadId = String(args.threadId);
  fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
  fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: workerId, branch: "otto/x-1" } });
  await fake.emit("started", workerId, { sessionId: workerId, cwd: "/srv/repo-a", branch: "otto/x-1" });
  await waitRunsSettled();
  await waitFor(
    () => ownerStub().debugSnapshot(),
    (snap) => snap.threads.some((t) => t.workers.some((w) => w.workerId === workerId && w.state === "running")),
  );
  return { fake, workerId, threadId };
}

describe("the ⟦watchdog⟧ ask (issue #3, steward.md §8.4)", () => {
  it("is off by default: the stall alarm behaves exactly as before", async () => {
    const { fake, workerId } = await dispatchedRunningWorker();

    await backdate(workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });
    await waitWhileOutboundPending();

    // The deterministic notice still goes out — and no model input was created for it.
    const cards = (await ownerStub().outboundRows(30)).filter((r) => r.kind === "card" && r.status === "sent");
    expect(JSON.stringify(cards)).toContain("没有任何动静");
    expect(await watchdogWakes()).toEqual([]);
    expect((await llmState()).runs.filter((r) => r.kind === "watchdog")).toEqual([]);
    fake.close();
  }, 30_000);

  it("asks once per silent stretch, with the re-plan's provenance and the core's deadline", async () => {
    await enableWatchdog();
    const { fake, workerId } = await dispatchedRunningWorker();

    await backdate(workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });

    const wakes = await waitFor(
      () => watchdogWakes(),
      (rows) => rows.length === 1,
    );
    const text = wakes[0]!.text;
    expect(text.startsWith("⟦watchdog⟧")).toBe(true);
    expect(text).toContain(workerId);
    expect(text).toContain(`user:${ORIGIN_MSG}`); // the provenanceRef the model must pass
    expect(text).toContain("24 分钟后"); // 45 − 21: the core's deadline, quoted verbatim
    expect(text).toContain("已发送给用户的通知：是");
    // The model's own answer cannot extend the deadline — the wake says so, and the sweep
    // below proves it.

    // One ask per stretch: the same silence never asks twice.
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 });
    expect((await watchdogWakes()).length).toBe(1);

    // A real event starts a new stretch, so the next silence is a new question.
    await fake.emit("progress", workerId, { phase: "tool", tool: "edit", target: "src/a.ts", turn: 2 });
    await backdate(workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });
    await waitFor(() => watchdogWakes(), (rows) => rows.length === 2);
    fake.close();
  }, 30_000);

  it("the verdict stays deterministic: silence past 45 min is still reaped", async () => {
    await enableWatchdog();
    const { fake, workerId } = await dispatchedRunningWorker();

    // Long silence: the stall alarm's window is already behind us, so this pass is the
    // reap's — the queued ask is not consulted and not waited for.
    await backdate(workerId, 46);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });
    await waitWhileOutboundPending();
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.threads.some((t) => t.workers.some((w) => w.workerId === workerId && w.state === "lost")),
    );
    const worker = snap.threads.flatMap((t) => t.workers).find((w) => w.workerId === workerId);
    expect(worker!.state).toBe("lost");
    fake.close();
  }, 30_000);

  it("re-plans the run when the model decides to (start_worker with provenanceRef)", async () => {
    await enableWatchdog();
    const { fake, workerId, threadId } = await dispatchedRunningWorker();

    // What the model sees: the ⟦watchdog⟧ input. Its answer: a rewritten brief in the same
    // Thread, authorized by the very message that authorized the original dispatch.
    await scriptModel(
      fauxAssistantMessage(
        [
          fauxToolCall("start_worker", {
            prompt: "换成先加日志再定位，别再整体重写",
            repoRef: "repo-a",
            threadId,
            basis: "user_explicit",
            provenanceRef: `user:${ORIGIN_MSG}`,
            // Attaching to an existing Thread without an explicit mention needs the routing
            // gate's confidence (the same rule every non-explicit attach passes).
            routing: { confidence: "high", reason: "watchdog 复审决定在同一 Thread 上改派" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("已改派一份更小的任务。")]),
    );

    await backdate(workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });

    // The re-plan really dispatched: the same session is resumed with the rewritten brief
    // (a resume, not a second worker — the dispatch rules keep one session per Thread while
    // the agent and machine stay the same), and the dispatch restarts the stall clock.
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) =>
        s.threads.some(
          (t) => t.threadId === threadId && t.timeline.some((e) => e.kind === "dispatch" && e.text.includes("换成先加日志")),
        ),
    );
    const thread = snap.threads.find((t) => t.threadId === threadId)!;
    expect(thread.workers.map((w) => w.workerId)).toContain(workerId);
    // The stuck worker is not force-closed by the re-plan: only the 45-min verdict or a real
    // event may end it, so a run that was merely slow keeps its chance to come back.
    const worker = thread.workers.find((w) => w.workerId === workerId)!;
    expect(worker.state).toBe("running");
    expect(worker.lastEventAt!).toBeGreaterThan(Date.now() - 5 * MIN); // silence over
    // The ask is auditable: kind=watchdog, and the dispatch is on the run's record.
    const runs = (await llmState()).runs.filter((r) => r.kind === "watchdog");
    expect(runs.length).toBe(1);
    expect(runs[0]!.dispatchCount).toBe(1);
    fake.close();
  }, 30_000);

  it("over budget: the ask is skipped and only the deterministic half runs (§12)", async () => {
    await enableWatchdog();
    const { fake, workerId } = await dispatchedRunningWorker();

    await ownerStub().setBudgetForTest(0.5);
    await ownerStub().spendForTest(0.5);
    await backdate(workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });

    // The wake row settles as 'skipped' — the gate is the existing one, no new path.
    const wakes = await waitFor(
      () => watchdogWakes(),
      (rows) => rows.length === 1 && rows[0]!.status !== "pending",
    );
    expect(wakes[0]!.status).toBe("skipped");
    await waitWhileOutboundPending();
    // The owner's notice is not taken with it (the wake already claimed "已发送…是").
    const cards = (await ownerStub().outboundRows(30)).filter((r) => r.kind === "card" && r.status === "sent");
    expect(JSON.stringify(cards)).toContain("没有任何动静");
    // And the verdict is untouched: 45 minutes is still the end.
    await backdate(workerId, 46);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });
    await ownerStub().setBudgetForTest(undefined);
    fake.close();
  }, 30_000);

  it("a Thread with no user message behind it offers no re-plan", async () => {
    await enableWatchdog();
    // dispatchForTest bypasses the LLM path, so the Thread has no createdFromMsg.
    const fake = await pairFakeConnector("mac-studio", { repoId: "/srv/repo-a", run: null, autorun: false });
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({ prompt: "卡在启动", repoRef: "repo-a", newTitle: "卡在启动" });
    if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${outcome.kind}`);
    const [cmd] = await fake.waitForCmds(1);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: outcome.workerId } });
    await fake.emit("started", outcome.workerId, { sessionId: outcome.workerId, cwd: "/srv/repo-a" });
    // The frame's effect is applied asynchronously — backdating before `running` lands would
    // race the event's own lastEventAt write.
    await waitFor(
      () => ownerStub().debugSnapshot(),
      (snap) => snap.threads.some((t) => t.workers.some((w) => w.workerId === outcome.workerId && w.state === "running")),
    );

    await backdate(outcome.workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });
    const wakes = await waitFor(
      () => watchdogWakes(),
      (rows) => rows.length === 1,
    );
    expect(wakes[0]!.text).toContain("重规划（不可用");
    expect(wakes[0]!.text).not.toContain("provenanceRef=user:");
    fake.close();
  }, 30_000);
});
