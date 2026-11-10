// Turn lifecycle, owner side (issue #2, ADR-0017): messages that arrive while a turn is running
// queue behind it and each still gets its own reply, in order — and the debug button that stops
// the turn a person is watching actually stops it, without turning the withdrawal into the
// failure path the model gets blamed for.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { TURN_STOPPED_NOTICE } from "../src/owner-notices.ts";
import {
  configureAndBind,
  llmState,
  ownerStub,
  resetLedgerState,
  scriptModel,
  streamRepliesAt,
  webLogin,
  waitRunsSettled,
} from "./helpers.ts";

const BASE = "https://example.com";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
  await streamRepliesAt(undefined);
});

async function browser() {
  const cookie = await webLogin();
  const snapshot = async () =>
    (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json() as Promise<{
      busy: boolean;
      csrf: string;
      messages: Array<{ id: string; role: string; text?: string }>;
    }>;
  const { csrf } = await snapshot();
  const post = (path: string, body: unknown) =>
    SELF.fetch(`${BASE}/app/api/${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
  return { cookie, csrf, snapshot, post };
}

/** Every text the outbound queue holds (sent or not), oldest first. */
async function sentTexts(): Promise<Array<{ id: string; text: string }>> {
  const rows = await ownerStub().outboundRows(50);
  return rows
    .filter((row) => row.kind === "text")
    .map((row) => ({ id: row.id, text: String((JSON.parse(row.payload as string) as { text?: string }).text ?? "") }));
}

/** Polls a condition until it holds (the alarm paths run every 2 s in production). */
async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`never became true: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const runOf = async (operationId: string) => (await llmState()).runs.find((run) => run.operationId === operationId);

describe("a turn that is already running", () => {
  it("queues the next message behind it and answers both, in order, under their own ids", async () => {
    await streamRepliesAt(60); // word by word: the first turn is still live when the second lands
    const first = "a long enough reply to still be streaming when the next message arrives";
    await scriptModel(fauxAssistantMessage([fauxText(first)]), fauxAssistantMessage([fauxText("second")]));
    const { post } = await browser();

    expect((await post("messages", { id: "turn-aaaa", text: "first question" })).status).toBe(202);
    await until(async () => (await runOf("user:web:turn-aaaa"))?.status === "open", "the first turn is open");
    expect((await post("messages", { id: "turn-bbbb", text: "second question" })).status).toBe(202);
    await waitRunsSettled(30_000);

    // One run per intent, both settled — never a second copy of the first turn.
    expect((await llmState()).runs.filter((run) => run.kind === "user").map((run) => run.operationId).sort())
      .toEqual(["user:web:turn-aaaa", "user:web:turn-bbbb"]);
    // Two replies, in submission order, each keyed to the message that asked for it.
    expect(await sentTexts()).toEqual([
      { id: "reply:user:web:turn-aaaa", text: first },
      { id: "reply:user:web:turn-bbbb", text: "second" },
    ]);
  });
});

describe("stopping a turn", () => {
  it("cancels the live run and answers with the stopped notice, not a failure", async () => {
    await streamRepliesAt(20);
    const reply = "this reply is long enough that the stop lands while it is still being written";
    await scriptModel(fauxAssistantMessage([fauxText(reply)]));
    const { post } = await browser();
    expect((await post("messages", { id: "turn-stop1", text: "say something long" })).status).toBe(202);
    await until(async () => (await runOf("user:web:turn-stop1"))?.status === "open", "the turn is open");

    const response = await post("turn/stop", { id: "stop-request-0001" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stopped: "running", cancelled: ["user:web:turn-stop1"] });
    await waitRunsSettled();

    const run = await runOf("user:web:turn-stop1");
    expect(run?.status).toBe("cancelled");
    expect(run?.resultReason).toBe("aborted");
    // Exactly one message went out, and it says the turn was stopped — the half-written reply
    // and the "the model could not answer" notice must both stay unsent.
    expect(await sentTexts()).toEqual([{ id: "reply:user:web:turn-stop1", text: TURN_STOPPED_NOTICE }]);
  });

  it("cancels queued turns too, and says so", async () => {
    await streamRepliesAt(20);
    await scriptModel(fauxAssistantMessage([fauxText("one two three four five six seven eight nine ten eleven twelve")]));
    const { post } = await browser();
    await post("messages", { id: "turn-queue1", text: "first" });
    await until(async () => (await runOf("user:web:turn-queue1"))?.status === "open", "the first turn is open");
    await post("messages", { id: "turn-queue2", text: "second" });
    await until(async () => (await runOf("user:web:turn-queue2"))?.status === "open", "the second turn is queued");

    const answer = (await (await post("turn/stop", { id: "stop-request-0002" })).json()) as { stopped: string; cancelled: string[] };
    expect(answer.stopped).toBe("running");
    expect(answer.cancelled.sort()).toEqual(["user:web:turn-queue1", "user:web:turn-queue2"]);
    await waitRunsSettled();
    expect((await llmState()).runs.map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("answers 'none' when nothing is running, and replays that answer for the same request id", async () => {
    const { post } = await browser();
    const first = await post("turn/stop", { id: "stop-request-0003" });
    expect(await first.json()).toEqual({ stopped: "none", cancelled: [] });
    const again = await post("turn/stop", { id: "stop-request-0003" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ stopped: "none", cancelled: [] });
    expect(await sentTexts()).toEqual([]);
  });

  it("refuses a stop that is not a real request, before anything is aborted", async () => {
    const { post } = await browser();
    expect((await post("turn/stop", { id: "" })).status).toBe(400);
    expect((await post("turn/stop", {})).status).toBe(400);
    const cookie = await webLogin();
    const noCsrf = await SELF.fetch(`${BASE}/app/api/turn/stop`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "stop-request-0004" }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it("hides the stop control from the snapshot once the turn is gone", async () => {
    const { post, snapshot } = await browser();
    expect((await snapshot()).busy).toBe(false);
    await streamRepliesAt(20);
    await scriptModel(fauxAssistantMessage([fauxText("still writing this one, word by word, slowly")]));
    await post("messages", { id: "turn-busy1", text: "long answer please" });
    await until(async () => (await snapshot()).busy, "the snapshot is busy");
    await post("turn/stop", { id: "stop-request-0005" });
    await until(async () => !(await snapshot()).busy, "the snapshot is idle again");
  });
});
