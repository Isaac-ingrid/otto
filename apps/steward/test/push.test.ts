import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PushService, quietNow, retryDelayMs, validEndpoint, validSubscription } from "../src/push.ts";
import type { SqlExecutor } from "../src/schema.ts";
import type { Steward } from "../src/steward.ts";
import { configureAndBind, ownerStub, resetLedgerState, webLogin } from "./helpers.ts";

const endpoint = "https://web.push.apple.com/abcdef";
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decoded = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));

async function keys() {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", signing.privateKey);
  const client = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = b64(new Uint8Array(await crypto.subtle.exportKey("raw", client.publicKey)));
  return {
    config: { publicKey: b64(new Uint8Array([4, ...decoded(jwk.x!), ...decoded(jwk.y!)])), privateKey: jwk.d!, subject: "mailto:owner@example.com" },
    subscription: { endpoint, expirationTime: null, keys: { p256dh, auth: b64(crypto.getRandomValues(new Uint8Array(16))) } },
  };
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance) as SqlExecutor;
    sql`DELETE FROM sh_push_job`;
    sql`DELETE FROM sh_push_sub`;
  });
});

describe("opt-in Web Push", () => {
  it("rejects arbitrary endpoints, loopback, credentials and malformed keys; observes local quiet hours", () => {
    for (const bad of ["http://web.push.apple.com/path", "https://127.0.0.1/x", "https://web.push.apple.com.evil.test/x", "https://user@web.push.apple.com/x", "https://web.push.apple.com:444/x"]) {
      expect(validEndpoint(bad)).toBe(false);
    }
    expect(validEndpoint(endpoint)).toBe(true);
    expect(validSubscription({ endpoint, expirationTime: null, keys: { auth: "bad", p256dh: "bad" } })).toBe(false);
    expect(quietNow("Asia/Shanghai", Date.parse("2026-11-12T15:00:00Z"))).toBe(true);
    expect(quietNow("Asia/Shanghai", Date.parse("2026-11-12T01:00:00Z"))).toBe(false);
  });

  it("does not expose the service worker or accept cross-site/CSRF subscription writes", async () => {
    const base = "https://example.com";
    expect((await SELF.fetch(`${base}/app/push-sw.js`)).status).toBe(401);
    expect((await SELF.fetch(`${base}/app/manifest.webmanifest`)).status).toBe(401);
    const cookie = await webLogin();
    const sw = await SELF.fetch(`${base}/app/push-sw.js`, { headers: { cookie } });
    expect(sw.status).toBe(200);
    expect(sw.headers.get("service-worker-allowed")).toBe("/app/");
    expect((await SELF.fetch(`${base}/app/manifest.webmanifest`, { headers: { cookie } })).status).toBe(200);
    const { subscription } = await keys();
    const body = JSON.stringify({ subscription, timeZone: "UTC", quiet: true });
    const headers = { cookie, "content-type": "application/json", origin: base };
    expect((await SELF.fetch(`${base}/app/api/push/subscribe`, { method: "POST", headers, body })).status).toBe(403);
    const snapshot = await (await SELF.fetch(`${base}/app/api/workspace`, { headers: { cookie } })).json() as { csrf: string };
    expect((await SELF.fetch(`${base}/app/api/push/subscribe`, { method: "POST", headers: { ...headers, origin: "https://evil.test", "x-csrf-token": snapshot.csrf }, body })).status).toBe(403);
    // A deployment with no VAPID key is disabled, not silently subscribed.
    expect((await SELF.fetch(`${base}/app/api/push/subscribe`, { method: "POST", headers: { ...headers, "x-csrf-token": snapshot.csrf }, body })).status).toBe(400);
    expect((await SELF.fetch(`${base}/app/api/push/test`, { method: "POST", headers: { ...headers, "x-csrf-token": snapshot.csrf }, body: JSON.stringify({ endpoint }) })).status).toBe(400);
  });

  it("sends an explicit test only to a registered device, at most once per minute", async () => {
    const { config, subscription } = await keys();
    const sends = vi.fn(async () => new Response(null, { status: 201 }));
    const ok = await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance) as SqlExecutor;
      const service = new PushService(sql, config, async () => {}, sends as typeof fetch);
      expect(service.queueTest(endpoint)).toBe(false);
      service.subscribe(subscription, "UTC", true);
      service.queueTest(endpoint);
      service.queueTest(endpoint);
      await service.drain(); // A direct owner tap bypasses quiet hours.
      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_push_job WHERE kind = 'test'`[0]!.n;
    });
    expect(ok).toBe(1);
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("relays only FCM ciphertext; never sends VAPID private key or arbitrary endpoints to the relay", async () => {
    const { config, subscription } = await keys();
    const fcm = "https://fcm.googleapis.com/fcm/send/test-token";
    const relayUrl = "https://otto-relay.pages.dev/push";
    const relayToken = b64(crypto.getRandomValues(new Uint8Array(32)));
    const sends = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 201 }));
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance) as SqlExecutor;
      const service = new PushService(sql, { ...config, relayUrl, relayToken }, async () => {}, sends as typeof fetch);
      expect(service.subscribe({ ...subscription, endpoint: fcm }, "UTC", false)).toBe(true);
      service.queueTest(fcm);
      await service.drain();
      expect(service.subscribe(subscription, "UTC", false)).toBe(true);
      service.queueTest(endpoint);
      await service.drain();
    });
    expect(sends).toHaveBeenCalledTimes(2);
    const [url, options] = sends.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(relayUrl);
    expect(options.headers).toMatchObject({ "x-otto-push-relay-token": relayToken });
    const request = JSON.parse(options.body as string) as { endpoint: string; body: string; headers: Record<string, string> };
    expect(request.endpoint).toBe(fcm);
    expect(request.body.length).toBeGreaterThan(5000);
    expect(JSON.stringify(request)).not.toContain(config.privateKey!);
    expect(Object.keys(request.headers).sort()).toEqual(["authorization", "ttl", "content-encoding", "content-type"].sort());
    expect(sends.mock.calls[1]![0]).toBe(endpoint);
  });

  it("recovers a settled report after a crash without replaying a delivered alert", async () => {
    const { config, subscription } = await keys();
    const sends = vi.fn(async () => new Response(null, { status: 201 }));
    const result = await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance) as SqlExecutor;
      const service = new PushService(sql, config, async () => {}, sends as typeof fetch);
      expect(service.subscribe(subscription, "UTC", false)).toBe(true);
      const now = Date.now();
      sql`INSERT INTO sh_outbound (id, channel, kind, receiveId, payload, urgency, status, nextAttemptAt, createdAt, sentAt)
        VALUES (${"notify:report:crash"}, ${"local"}, ${"card"}, ${"owner"}, ${"{}"}, ${"quiet"}, ${"sent"}, ${now}, ${now}, ${now})`;
      service.reconcile();
      service.reconcile();
      await service.drain();
      service.reconcile();
      await service.drain();
      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_push_job WHERE sentAt IS NOT NULL`[0]!.n;
    });
    expect(result).toBe(1);
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("queues once per outbound id, encrypts generic content and retires an expired endpoint", async () => {
    const { config, subscription } = await keys();
    const sends = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as Uint8Array;
      expect(body.byteLength).toBeGreaterThan(4000);
      expect(new TextDecoder().decode(body)).not.toContain("private task");
      return new Response(null, { status: 201 });
    });
    const result = await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance) as SqlExecutor;
      const scheduled = vi.fn(async () => {});
      const service = new PushService(sql, config, scheduled, sends as typeof fetch);
      const valid = service.subscribe(subscription, "UTC", false);
      service.queue("notify:report:private task", "done");
      service.queue("notify:report:private task", "done");
      await service.drain();
      await service.drain();
      const afterSuccess = sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_push_job WHERE sentAt IS NULL`[0]!.n;
      const gone = new PushService(sql, config, scheduled, async () => new Response(null, { status: 410 }));
      gone.queue("notify:report:next", "done");
      await gone.drain();
      return { valid, afterSuccess, remaining: sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_push_sub`[0]!.n };
    });
    expect(result).toEqual({ valid: true, afterSuccess: 0, remaining: 0 });
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("retries a blocked push service in seconds and says why without logging the subscription", async () => {
    const { config, subscription } = await keys();
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(6)).toBe(300_000);
    expect(retryDelayMs(9)).toBe(300_000);
    const logged: unknown[][] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args); });
    const blocked = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    try {
      const delays = await runInDurableObject(ownerStub(), async (instance: Steward) => {
        const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance) as SqlExecutor;
        const service = new PushService(sql, config, async () => {}, (async () => { throw blocked; }) as unknown as typeof fetch);
        expect(service.subscribe(subscription, "UTC", false)).toBe(true);
        service.queue("notify:report:blocked", "done");
        const measured: number[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          sql`UPDATE sh_push_job SET dueAt = ${Date.now()} WHERE sentAt IS NULL`;
          await service.drain();
          measured.push(sql<{ delay: number }>`SELECT dueAt - ${Date.now()} AS delay FROM sh_push_job WHERE sentAt IS NULL`[0]!.delay);
        }
        return measured;
      });
      // Each retry is seconds away, not the minutes an exponential backoff would spend.
      expect(delays[0]).toBeGreaterThan(3_000);
      expect(delays[0]).toBeLessThan(6_000);
      expect(delays[1]).toBeGreaterThan(13_000);
      expect(delays[1]).toBeLessThan(16_000);
      expect(delays[2]).toBeGreaterThan(43_000);
    } finally { errors.mockRestore(); }
    expect(logged).toHaveLength(3);
    expect(String(logged[0]![0])).toContain("reason=ETIMEDOUT");
    expect(String(logged[0]![0])).toContain("kind=done");
    const written = JSON.stringify(logged);
    expect(written).not.toContain(subscription.keys.auth);
    expect(written).not.toContain(subscription.keys.p256dh);
    expect(written).not.toContain(subscription.endpoint);
  });
});
