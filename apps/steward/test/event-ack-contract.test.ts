// Code anchor for formal/AckBeforePersist.cfg: a failed durable inbox write MUST
// prevent an ack. This is a fault-injection contract test, not a browser journey.
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import { configureAndBind, connectAndHello, ownerStub, pairDevice, resetLedgerState } from "./helpers.ts";

beforeEach(async () => { await resetLedgerState(); await configureAndBind("ou_owner"); });

describe("event durability before ack (TLA+ code anchor)", () => {
  it("does not ack a failed inbox write; retry persists and reduces the event exactly once", async () => {
    const { deviceId, token } = await pairDevice("ack-contract");
    const { ws, reader } = await connectAndHello(deviceId, token, 1, {
      repos: [{ repoId: "/srv/repo-a", name: "repo-a", path: "/srv/repo-a", defaultBranch: "main", remote: "git@example:repo-a.git" }],
      agents: [{ kind: "pi", version: "test", capabilities: { steer: true } }],
      limits: { maxWorkers: 1, running: 0 },
    });
    try {
      expect((await ownerStub().dispatchForTest({ prompt: "verify durable ack", repoRef: "repo-a", newTitle: "durable ack" })).kind).toBe("dispatched");
      const command = await reader.nextWhere(frame => frame.t === "cmd");
      const workerId = String((command.args as Record<string, unknown>).workerId);
      await runInDurableObject(ownerStub(), async (instance: Steward, state) => {
        const frames: Array<Record<string, unknown>> = [];
        const connection = { state: { deviceId }, send: (frame: string) => frames.push(JSON.parse(frame)) };
        const message = JSON.stringify({ t: "events", id: "ack-contract", batch: [{ workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId }] });
        state.storage.sql.exec("CREATE TRIGGER refuse_event BEFORE INSERT ON event_inbox BEGIN SELECT RAISE(ABORT, 'injected inbox failure'); END");
        try {
          await expect(instance.onMessage(connection as never, message)).rejects.toThrow("injected inbox failure");
          expect(frames.filter(frame => frame.t === "events_ack")).toEqual([]);
          expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM event_inbox").toArray()[0]).toEqual({ n: 0 });
        } finally {
          state.storage.sql.exec("DROP TRIGGER refuse_event");
        }
        await instance.onMessage(connection as never, message);
        await instance.onMessage(connection as never, message);
        expect(frames.filter(frame => frame.t === "events_ack")).toEqual([
          { t: "events_ack", workerId, upTo: 1 }, { t: "events_ack", workerId, upTo: 1 },
        ]);
        expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ?", workerId).toArray()[0]).toEqual({ n: 1 });
        expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM sh_timeline WHERE kind = 'started'").toArray()[0]).toEqual({ n: 1 });
      });
    } finally {
      ws.close();
    }
  });
});
