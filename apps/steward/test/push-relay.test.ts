import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-ignore TS6059: Pages entrypoint intentionally lives outside the steward package.
import relay from "../../../deploy/push-relay/_worker.js";

const token = "a".repeat(43);
const endpoint = "https://fcm.googleapis.com/fcm/send/test-token";
const headers = {
  authorization: `vapid t=${"x".repeat(8)}.${"y".repeat(8)}.${"z".repeat(8)}, k=${"a".repeat(87)}`,
  ttl: "3600", "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
};
const body = btoa(String.fromCharCode(...new Uint8Array(160).fill(7))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const env = { RELAY_TOKEN: token };

function request(data: object, bearer = token): Request {
  return new Request("https://otto-relay.pages.dev/push", {
    method: "POST", headers: { "content-type": "application/json", "x-otto-push-relay-token": bearer },
    body: JSON.stringify(data),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("optional Cloudflare Pages FCM relay", () => {
  it("rejects unauthenticated, wrong host, redirect targets, malformed headers and oversized requests", async () => {
    const send = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", send);
    const good = { endpoint, headers, body };
    expect((await relay.fetch(request(good, "bad"), env)).status).toBe(403);
    expect((await relay.fetch(new Request("https://otto-relay.pages.dev/"), env)).status).toBe(404);
    for (const url of ["https://fcm.googleapis.com.evil.test/fcm/send/x", "https://127.0.0.1/fcm/send/x",
      "https://fcm.googleapis.com:444/fcm/send/x", "https://fcm.googleapis.com/fcm/send/../private",
      "https://fcm.googleapis.com/fcm/send/x?to=evil", "https://web.push.apple.com/x"]) {
      expect((await relay.fetch(request({ ...good, endpoint: url }), env)).status).toBe(400);
    }
    expect((await relay.fetch(request({ ...good, headers: { ...headers, "x-secret": "oops" } }), env)).status).toBe(400);
    expect((await relay.fetch(request({ ...good, body: "A".repeat(13_000) }), env)).status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  it("forwards only the signed ciphertext to FCM and reflects status, never following redirects", async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("private upstream error", { status: 201 }));
    vi.stubGlobal("fetch", send);
    const response = await relay.fetch(request({ endpoint, headers, body }), env);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("");
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(init.redirect).toBe("manual");
    expect(init.headers).toEqual(headers);
    expect((init.body as Uint8Array).byteLength).toBe(160);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } })));
    expect((await relay.fetch(request({ endpoint, headers, body }), env)).status).toBe(502);
  });
});
