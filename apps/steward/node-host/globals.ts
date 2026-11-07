/**
 * The two globals the Cloudflare runtime provides that Node does not:
 * `WebSocketPair`, and a `Response` that can carry a 101 upgrade.
 */
import { HostSocket, HostWebSocketPair, installAttachmentSupport } from "./websocket.ts";

type ResponseInitWithSocket = ResponseInit & { webSocket?: HostSocket };

/** `new Response(null, { status: 101, webSocket })` — rejected by undici's status range. */
function installResponse(global: typeof globalThis): void {
  const Base = global.Response;
  if ((Base as { __sigHostPatched?: boolean }).__sigHostPatched) return;

  class HostResponse extends Base {
    // workerd types this as `WebSocket | null`; the runtime end of a pair is a HostSocket,
    // which only our own server reads (see server.ts `upgrade`).
    declare webSocket: WebSocket | null;

    // Plain `Response` objects (undici's) must still satisfy `instanceof Response`: the SDK
    // discriminates on it in several places.
    static [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof Base;
    }

    constructor(body?: BodyInit | null, init?: ResponseInitWithSocket) {
      if (init && (init as ResponseInit).status === 101) {
        super(null, { status: 200, headers: init.headers, statusText: init.statusText });
        Object.defineProperty(this, "status", { value: 101, enumerable: true, configurable: true });
        Object.defineProperty(this, "ok", { value: false, enumerable: true, configurable: true });
        if (init.webSocket) this.webSocket = init.webSocket as unknown as WebSocket;
      } else {
        super(body, init);
      }
    }
  }

  Object.defineProperty(HostResponse, "__sigHostPatched", { value: true });
  global.Response = HostResponse as unknown as typeof Response;
}

export function installGlobals(global: typeof globalThis = globalThis): void {
  const target = global as { WebSocketPair?: unknown };
  if (!target.WebSocketPair) target.WebSocketPair = HostWebSocketPair;
  installAttachmentSupport(global);
  installResponse(global);
}
