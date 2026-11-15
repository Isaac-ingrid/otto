import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BodyTooLargeError, MAX_NODE_HTTP_BODY_BYTES, readBody, toRequest } from "../server.ts";

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
  it("rejects immediately when Content-Length exceeds the limit", async () => {
    const req = mockIncoming(
      [Buffer.from("small")],
      { "content-length": String(MAX_NODE_HTTP_BODY_BYTES + 1) },
    );
    await expect(readBody(req)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect((req as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it("aborts chunked streams mid-read without buffering the full oversized payload", async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const req = mockIncoming([chunk, chunk, chunk, chunk, chunk]);
    await expect(toRequest(req)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect((req as unknown as { destroyed: boolean }).destroyed).toBe(true);
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
