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

export interface HostServerOptions {
  runtime: HostRuntime<never>;
  handler: (request: Request) => Promise<Response>;
  port: number;
  hostname?: string;
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

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function toRequest(request: IncomingMessage): Promise<Request> {
  const method = request.method ?? "GET";
  const headers = toHeaders(request);
  // `index.ts` buckets the auth throttles on this header. workerd fills it in; here it has to be
  // derived or every client shares one `unknown` bucket (see client-ip.ts).
  headers.set(
    "cf-connecting-ip",
    clientIp({ remoteAddress: request.socket.remoteAddress, forwardedFor: request.headers["x-forwarded-for"] }),
  );
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
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
  const sockets = new WebSocketServer({ noServer: true });

  const server = createHttpServer((incoming, outgoing) => {
    void (async () => {
      try {
        const response = await options.handler(await toRequest(incoming));
        await writeResponse(response, outgoing);
      } catch (error) {
        console.error("[node-host] request failed", error);
        if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "text/plain" });
        outgoing.end("internal error");
      }
    })();
  });

  server.on("upgrade", (incoming, socket, head) => {
    void (async () => {
      try {
        const response = await options.handler(await toRequest(incoming));
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
