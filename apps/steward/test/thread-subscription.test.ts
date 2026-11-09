// Thread subscription (issue #1, P4): a watcher follows one Thread instead of polling
// `GET /api/messages` and diffing it. Frames carry the `sh_timeline` rows themselves, the cursor
// is the row id, and a reconnect asks for the gap. Nothing is trusted from the message: the
// Thread must exist and the cursor lives on the connection.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  FakeConnector,
  MessageReader,
  configureAndBind,
  connectWeb,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitForWorkerState,
  webLogin,
} from "./helpers.ts";

/** The Thread a dispatch creates, with the timeline rows it writes. */
async function dispatchThread(fake: FakeConnector, prompt = "修复登录 bug", title = "修复登录 bug"): Promise<{ threadId: string; workerId: string }> {
  await fake.connect();
  await ownerStub().dispatchForTest({ prompt, repoRef: "repo-a", newTitle: title });
  return waitForWorkerState("idle");
}

/** Writes one timeline row straight through the ledger — the same path every steward decision uses. */
async function addTimelineRow(threadId: string, text: string): Promise<number> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const ledger = (instance as unknown as { ledger: { timeline: { add(t: string | null, k: string, text: string, refs: Record<string, unknown> | null): void } } }).ledger;
    ledger.timeline.add(threadId, "note", text, null);
    const sql = (instance as unknown as { sql: <T>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql.bind(instance);
    return sql<{ id: number }>`SELECT MAX(id) AS id FROM sh_timeline WHERE threadId = ${threadId}`[0]!.id;
  });
}

function eventsOf(frame: Record<string, unknown>): Array<{ id: number; text: string }> {
  expect(frame.t).toBe("thread_events");
  return frame.events as Array<{ id: number; text: string }>;
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

describe("thread subscription (issue #1)", () => {
  it("backfills the Thread's recent page on subscribe, then pushes new rows", async () => {
    const fake = await pairFakeConnector("mac-studio");
    const { threadId } = await dispatchThread(fake);

    const { ws, reader } = await connectWeb(await webLogin());
    ws.send(JSON.stringify({ t: "subscribe_thread", threadId }));

    const backfill = await reader.nextWhere((m) => m.t === "thread_events");
    expect(backfill.threadId).toBe(threadId);
    const backfilled = eventsOf(backfill);
    expect(backfilled.length).toBeGreaterThan(0);
    // The dispatch is on the timeline, so a fresh watcher sees it without asking.
    expect(backfilled.map((e) => e.text).join("\n")).toContain("修复登录 bug");
    // And the state it cannot read off the timeline follows the same subscription.
    const state = await reader.nextWhere((m) => m.t === "thread_state");
    expect(state.threadId).toBe(threadId);
    expect(state.state).toBeDefined();
    expect(Array.isArray(state.workers)).toBe(true);

    const id = await addTimelineRow(threadId, "订阅之后新写的一条");
    const pushed = await reader.nextWhere((m) => m.t === "thread_events" && (m.events as Array<{ id: number }>).some((e) => e.id === id));
    expect(eventsOf(pushed).map((e) => e.id)).toEqual([id]);
    ws.close();
  });

  it("resumes from `after`: a reconnecting watcher gets the gap, not the whole history", async () => {
    const fake = await pairFakeConnector("mac-studio");
    const { threadId } = await dispatchThread(fake);
    const first = await addTimelineRow(threadId, "断线前的一条");
    const second = await addTimelineRow(threadId, "断线后的一条");

    const { ws, reader } = await connectWeb(await webLogin());
    ws.send(JSON.stringify({ t: "subscribe_thread", threadId, after: first }));

    const frame = await reader.nextWhere((m) => m.t === "thread_events");
    expect(eventsOf(frame).map((e) => e.id)).toEqual([second]);
    ws.close();
  });

  it("pushes thread_state when a worker's state changes, and not when nothing changed", async () => {
    const fake = await pairFakeConnector("mac-studio");
    const { threadId, workerId } = await dispatchThread(fake);

    const { ws, reader } = await connectWeb(await webLogin());
    ws.send(JSON.stringify({ t: "subscribe_thread", threadId }));
    const initial = await reader.nextWhere((m) => m.t === "thread_state");
    const workerState = (frame: Record<string, unknown>) =>
      (frame.workers as Array<{ workerId: string; state: string }>).find((w) => w.workerId === workerId)?.state;
    expect(workerState(initial)).toBe("idle");

    await ownerStub().setWorkerStateForTest(workerId, "running", "running");
    const changed = await reader.nextWhere((m) => m.t === "thread_state");
    expect(workerState(changed)).toBe("running");

    // An unrelated write must not re-send the same state: the signature is what gates it.
    await addTimelineRow(threadId, "只多一条时间线");
    await reader.nextWhere((m) => m.t === "thread_events");
    expect(reader.has((m) => m.t === "thread_state")).toBe(false);
    ws.close();
  });

  it("filters by Thread: another Thread's rows are never sent", async () => {
    const fake = await pairFakeConnector("mac-studio");
    const { threadId } = await dispatchThread(fake);
    await ownerStub().dispatchForTest({ prompt: "另一个 bug", repoRef: "repo-a", newTitle: "另一个 bug" });
    const other = (await ownerStub().debugSnapshot()).threads.find((t) => t.title === "另一个 bug")!;

    const { ws, reader } = await connectWeb(await webLogin());
    ws.send(JSON.stringify({ t: "subscribe_thread", threadId }));
    await reader.nextWhere((m) => m.t === "thread_events");

    const otherId = await addTimelineRow(other.threadId, "别的 Thread 的事");
    const mine = await addTimelineRow(threadId, "本 Thread 的事");
    const frame = await reader.nextWhere((m) => m.t === "thread_events");
    const ids = eventsOf(frame).map((e) => e.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(otherId);
    ws.close();
  });

  it("answers not_found for an unknown Thread and bad_request for a malformed one", async () => {
    const { ws, reader } = await connectWeb(await webLogin());
    ws.send(JSON.stringify({ t: "subscribe_thread", threadId: "th_does_not_exist" }));
    const unknown = await reader.nextWhere((m) => m.t === "error");
    expect(unknown.code).toBe("not_found");

    ws.send(JSON.stringify({ t: "subscribe_thread", threadId: "th_x", after: -5 }));
    const bad = await reader.nextWhere((m) => m.t === "error");
    expect(bad.code).toBe("bad_request");
    ws.close();
  });

  it("stops sending after unsubscribe_thread", async () => {
    const fake = await pairFakeConnector("mac-studio");
    const { threadId } = await dispatchThread(fake);

    const { ws, reader } = await connectWeb(await webLogin());
    ws.send(JSON.stringify({ t: "subscribe_thread", threadId }));
    await reader.nextWhere((m) => m.t === "thread_events");

    const before = await addTimelineRow(threadId, "退订前的一条");
    await reader.nextWhere((m) => m.t === "thread_events" && (m.events as Array<{ id: number }>).some((e) => e.id === before));

    ws.send(JSON.stringify({ t: "unsubscribe_thread" }));
    const after = await addTimelineRow(threadId, "退订后的一条");
    // Give the nudge a chance to fire: the frame that would carry `after` must never arrive.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reader.has((m) => m.t === "thread_events" && (m.events as Array<{ id: number }>).some((e) => e.id === after))).toBe(false);
    ws.close();
  });

  it("is browser-only: a connector connection is refused with forbidden (§5.3)", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    fake.ws!.send(JSON.stringify({ t: "subscribe_thread", threadId: "th_x" }));
    const deadline = Date.now() + 8000;
    while (fake.errors.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fake.errors.at(-1)?.code).toBe("forbidden");
    expect(String(fake.errors.at(-1)?.message)).toContain("subscribe_thread");
  });
});

/** The workspace connection (tag `web` + `workspace`) is the one the page uses; it must accept
 *  the same subscription without a second code path. */
describe("thread subscription on the workspace socket", () => {
  it("backfills there too", async () => {
    const fake = await pairFakeConnector("mac-studio");
    const { threadId } = await dispatchThread(fake);
    const cookie = await webLogin();
    const res = await SELF.fetch("https://example.com/agents/steward/owner?role=web&view=workspace", {
      headers: { Upgrade: "websocket", cookie },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const reader = new MessageReader(ws);
    ws.send(JSON.stringify({ t: "subscribe_thread", threadId }));
    const frame = await reader.nextWhere((m) => m.t === "thread_events");
    expect(eventsOf(frame).length).toBeGreaterThan(0);
    ws.close();
  });
});
