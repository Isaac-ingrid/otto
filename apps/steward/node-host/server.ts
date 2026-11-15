/**
 * HTTP + WebSocket front end for the Node host.
 *
 * `src/index.ts` is a Worker: `fetch(request, env)` plus `routeAgentRequest` handing the owner
 * socket to the Durable Object. That is exactly what this server calls, so the routing,
 * session gate and upgrade handling stay in one place and are identical to production.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { clientIp } from "./client-ip.ts";
import { bindPair, peerOf, type HostSocket } from "./websocket.ts";
import type { HostRuntime } from "./runtime.ts";

/** Hard ceiling on Node HTTP request bodies before routing/auth (route-specific limits stay stricter). */
export const MAX_NODE_HTTP_BODY_BYTES = 256 * 1024;
/** Matches welcome.limits.maxMessageBytes (protocol §3.6 / §6.6). */
export const MAX_NODE_WS_PAYLOAD_BYTES = 262_144;

export class BodyTooLargeError extends Error {
  readonly status = 413;
  constructor(message = "request body too large") {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

export interface HostServerOptions {
  runtime: HostRuntime<never>;
  handler: (request: Request) => Promise<Response>;
  port: number;
  hostname?: string;
  maxBodyBytes?: number;
  maxWsPayloadBytes?: number;
}

function baseUrl(request: IncomingMessage): string {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(",")[0]?.trim() || "http";
  const host = request.headers.host ?? "127.0.0.1";
  return `${proto}://${host}`;
}

function toHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

export async function readBody(request: IncomingMessage, maxBytes = MAX_NODE_HTTP_BODY_BYTES): Promise<Buffer | undefined> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    request.destroy();
    throw new BodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      request.destroy();
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

export async function toRequest(request: IncomingMessage, maxBytes = MAX_NODE_HTTP_BODY_BYTES): Promise<Request> {
  const method = request.method ?? "GET";
  const headers = toHeaders(request);
  // `index.ts` buckets the auth throttles on this header. workerd fills it in; here it has to be
  // derived or every client shares one `unknown` bucket (see client-ip.ts).
  headers.set(
    "cf-connecting-ip",
    clientIp({ remoteAddress: request.socket.remoteAddress, forwardedFor: request.headers["x-forwarded-for"] }),
  );
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request, maxBytes);
  return new Request(`${baseUrl(request)}${request.url ?? "/"}`, {
    method,
    headers,
    body: body && body.byteLength > 0 ? new Uint8Array(body) : undefined,
  });
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) outgoing.setHeader(name, value);
  if (!response.body) {
    outgoing.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    stream.on("error", reject);
    outgoing.on("close", () => stream.destroy());
    stream.pipe(outgoing).on("finish", resolve).on("error", reject);
  });
}

function frameData(data: unknown, isBinary: boolean): string | Uint8Array {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data as Buffer[])
      : Buffer.from(data as ArrayBuffer);
  if (isBinary) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return buffer.toString("utf8");
}

export function startServer(options: HostServerOptions): Promise<Server> {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_NODE_HTTP_BODY_BYTES;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxWsPayloadBytes ?? MAX_NODE_WS_PAYLOAD_BYTES,
  });

  const server = createHttpServer((incoming, outgoing) => {
    void (async () => {
      try {
        const response = await options.handler(await toRequest(incoming, maxBodyBytes));
        await writeResponse(response, outgoing);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          if (!outgoing.headersSent) {
            outgoing.writeHead(413, { "content-type": "application/json", connection: "close", "cache-control": "no-store" });
          }
          outgoing.end(JSON.stringify({ error: "too_large" }));
          return;
        }
        console.error("[node-host] request failed", error);
        if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "text/plain" });
        outgoing.end("internal error");
      }
    })();
  });

  server.on("upgrade", (incoming, socket, head) => {
    void (async () => {
      try {
        const response = await options.handler(await toRequest(incoming, maxBodyBytes));
        const clientEnd = (response as { webSocket?: HostSocket | null }).webSocket ?? undefined;
        if (!clientEnd) {
          socket.write(`HTTP/1.1 ${response.status} ${response.statusText || "Error"}\r\nconnection: close\r\n\r\n`);
          socket.destroy();
          return;
        }
        const serverEnd = peerOf(clientEnd);
        if (!serverEnd) {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(incoming, socket, head, (ws) => attach(ws, serverEnd, options.runtime, clientEnd));
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          socket.write("HTTP/1.1 413 Payload Too Large\r\nconnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        console.error("[node-host] upgrade failed", error);
        socket.destroy();
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname ?? "0.0.0.0", () => resolve(server));
  });
}

function attach(ws: WebSocket, serverEnd: HostSocket, runtime: HostRuntime<never>, clientEnd: HostSocket): void {
  bindPair(clientEnd, serverEnd, {
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code ?? 1000, reason ?? "");
    },
  });
  ws.on("message", (data, isBinary) => {
    runtime.deliverMessage(serverEnd, frameData(data, isBinary));
  });
  ws.on("close", (code, reason) => {
    runtime.deliverClose(serverEnd, code, reason.toString(), code === 1000 || code === 1001);
  });
  ws.on("error", (error) => {
    runtime.deliverError(serverEnd, error);
  });
}
