import { request, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BodyTooLargeError, MAX_NODE_HTTP_BODY_BYTES, readBody, startServer, toRequest } from "../server.ts";

function mockIncoming(
  chunks: Buffer[],
  headers: Record<string, string> = {},
  method = "POST",
): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  stream.method = method;
  stream.url = "/api/messages";
  stream.headers = headers;
  (stream as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };
  queueMicrotask(() => {
    for (const chunk of chunks) {
      if ((stream as unknown as { destroyed: boolean }).destroyed) break;
      (stream as unknown as PassThrough).write(chunk);
    }
    if (!(stream as unknown as { destroyed: boolean }).destroyed) {
      (stream as unknown as PassThrough).end();
    }
  });
  return stream;
}

describe("Node host HTTP body limit", () => {
  it.each([false, true])("returns a complete 413 over a real socket (chunked=%s)", async (chunked) => {
    let handled = 0;
    const server = await startServer({
      runtime: {} as never,
      handler: async () => { handled++; return new Response("ok"); },
      port: 0,
      hostname: "127.0.0.1",
      maxBodyBytes: 16,
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing TCP address");
      const result = await new Promise<{ status: number | undefined; body: string; connection: string | undefined }>((resolve, reject) => {
        const req = request({
          hostname: "127.0.0.1", port: address.port, method: "POST", path: "/api/messages",
          headers: chunked ? { "transfer-encoding": "chunked" } : { "content-length": "32" },
        }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode, body, connection: res.headers.connection }));
        });
        req.on("error", reject);
        req.setTimeout(3000, () => req.destroy(new Error("request timed out")));
        req.end("x".repeat(32));
      });
      expect(result).toEqual({ status: 413, body: JSON.stringify({ error: "too_large" }), connection: "close" });
      expect(handled).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects immediately when Content-Length exceeds the limit", async () => {
    const req = mockIncoming(
      [Buffer.from("small")],
      { "content-length": String(MAX_NODE_HTTP_BODY_BYTES + 1) },
    );
    await expect(readBody(req)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(req.destroyed).toBe(false);
    expect(req.isPaused()).toBe(true);
  });

  it("stops chunked streams mid-read while retaining the socket for the 413 response", async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const req = mockIncoming([chunk, chunk, chunk, chunk, chunk]);
    await expect(toRequest(req)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(req.destroyed).toBe(false);
    expect(req.isPaused()).toBe(true);
  });

  it("counts UTF-8 bytes rather than character length for multibyte payloads", async () => {
    // 100,000 Chinese characters = 300,000 UTF-8 bytes (> 256 KiB).
    const utf8 = Buffer.from("中".repeat(100_000), "utf8");
    const req = mockIncoming([utf8.subarray(0, 150_000), utf8.subarray(150_000)]);
    await expect(readBody(req)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("reads valid bodies within the limit", async () => {
    const payload = Buffer.from(JSON.stringify({ text: "你好 Otto" }), "utf8");
    const req = mockIncoming([payload], { "content-type": "application/json" });
    const parsed = await toRequest(req);
    expect(await parsed.json()).toEqual({ text: "你好 Otto" });
  });
});
