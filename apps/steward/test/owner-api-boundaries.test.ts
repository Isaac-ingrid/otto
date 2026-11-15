import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MAX_BODY_BYTES, MAX_MESSAGE_CHARS } from "../src/workspace-api.ts";
import { configureAndBind, connectWeb, llmState, ownerStub, resetLedgerState, scriptModel, streamRepliesAt, webLogin } from "./helpers.ts";

const BASE = "https://example.com";
const AUTH = {
  Authorization: "Bearer test-server-key-not-a-secret",
  "content-type": "application/json",
};

function postMessage(body: unknown, raw?: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/messages`, {
    method: "POST",
    headers: AUTH,
    body: raw ?? JSON.stringify(body),
  });
}

describe("Owner API /api/messages input boundaries and queue admission", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await configureAndBind("ou_owner");
    await streamRepliesAt(undefined);
  });

  it("rejects malformed shapes, invalid fields, oversized chars, and oversized byte payloads", async () => {
    for (const bad of [null, [], "hello", 123, {}, { text: "   " }, { text: 42 }, { id: "short", text: "hi" }, { text: "hi", replyTo: "bad id with spaces" }]) {
      expect((await postMessage(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await postMessage(null, "{not-json")).status).toBe(400);

    const tooManyChars = await postMessage({
      id: "owner-msg-too-long",
      text: "x".repeat(MAX_MESSAGE_CHARS + 1),
    });
    expect(tooManyChars.status).toBe(400);

    const tooManyBytes = await postMessage({
      id: "owner-msg-too-many-bytes",
      text: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(tooManyBytes.status).toBe(413);
  });

  it("returns 409 when reusing the same message id with different text or replyTo", async () => {
    const first = await postMessage({ id: "owner-msg-conflict", text: "first text", replyTo: "card-1" });
    expect(first.status).toBe(200);

    const same = await postMessage({ id: "owner-msg-conflict", text: "first text", replyTo: "card-1" });
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ id: "owner-msg-conflict", deduped: true });

    const diffText = await postMessage({ id: "owner-msg-conflict", text: "different text", replyTo: "card-1" });
    expect(diffText.status).toBe(409);

    const diffReplyTo = await postMessage({ id: "owner-msg-conflict", text: "first text", replyTo: "card-2" });
    expect(diffReplyTo.status).toBe(409);
  });

  it("shares the 10-open-user-run queue limit with workspace, allows deterministic commands, and does not poison retries on 429", async () => {
    await streamRepliesAt(25);
    await scriptModel(fauxAssistantMessage([fauxText("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen")]));
    const cookie = await webLogin();
    const wsRes = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
    const { csrf } = (await wsRes.json()) as { csrf: string };

    // Fill 5 slots from workspace and 5 slots from Owner API = 10 open user runs.
    for (let i = 0; i < 5; i += 1) {
      const r = await SELF.fetch(`${BASE}/app/api/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ id: `ws-queue-item-${i}`, text: `ws message ${i}` }),
      });
      expect(r.status).toBe(202);
    }
    for (let i = 0; i < 5; i += 1) {
      const r = await postMessage({ id: `owner-queue-${i}`, text: `api message ${i}` });
      expect(r.status).toBe(200);
    }

    // 11th message from either entry is rejected with 429.
    const apiOverflow = await postMessage({ id: "owner-queue-overflow", text: "11th message" });
    expect(apiOverflow.status).toBe(429);
    const wsOverflow = await SELF.fetch(`${BASE}/app/api/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ id: "ws-queue-overflow", text: "11th ws message" }),
    });
    expect(wsOverflow.status).toBe(429);

    // Duplicate of an already-admitted message does not get rejected by queue_full.
    const dup = await postMessage({ id: "owner-queue-0", text: "api message 0" });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ id: "owner-queue-0", deduped: true });

    // Deterministic spend command is not blocked by the user-turn queue limit.
    const spend = await postMessage({ id: "owner-cmd-spend", text: "/花费" });
    expect(spend.status).toBe(200);

    // Cancel one open run to free a slot, then retry the previously 429-rejected id:
    // it must succeed (not swallowed as deduped).
    const runs = (await llmState()).runs.filter((r) => r.status === "open");
    expect(runs).toHaveLength(10);
    await ownerStub().stopTurn({ id: "stop-one-turn" }).catch(() => undefined);
    // Re-open 9 runs? stopTurn aborts all open runs, leaving 0 open runs.
    const retried = await postMessage({ id: "owner-queue-overflow", text: "11th message" });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ id: "owner-queue-overflow" });
  });

  it("rejects WebSocket frames exceeding maxMessageBytes", async () => {
    const cookie = await webLogin();
    const { ws, reader } = await connectWeb(cookie);
    try {
      const oversized = JSON.stringify({ t: "subscribe", workerId: "w_" + "a".repeat(270_000) });
      ws.send(oversized);
      const err = await reader.nextWhere((m) => m.t === "error");
      expect(err).toMatchObject({ t: "error", code: "bad_request", message: "message too large" });
    } finally {
      ws.close();
    }
  });
});
