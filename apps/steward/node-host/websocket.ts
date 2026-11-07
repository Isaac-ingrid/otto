/**
 * `WebSocketPair` / hibernatable WebSocket surface.
 *
 * workerd hands the runtime one end of a `WebSocketPair` from an upgrade `Response`
 * (`{ status: 101, webSocket: pair[0] }`) and the application the other end
 * (`ctx.acceptWebSocket(pair[1])`). Here the runtime is either our HTTP server (the client end
 * is bridged to a real socket) or the in-process test harness (the two ends are wired to each
 * other), so each end carries its own outbound hook instead of sharing one transport.
 *
 * Hibernation is emulated by keeping accepted sockets in memory for the life of the process; a
 * restart closes them and connectors reconnect (the protocol already treats a dropped socket as
 * normal — `apps/connector/src/client.ts` retries).
 *
 * Inbound events are delivered immediately when someone is listening, and held until a
 * listener appears otherwise: workerd delivers asynchronously, so code that calls
 * `ws.send(...)` and only then attaches a `message` listener still sees the reply.
 */

export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

export type SocketData = string | ArrayBuffer | ArrayBufferView;

export interface Transport {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

type Event = { type: "message"; data: unknown } | { type: "close"; code: number; reason: string; wasClean: boolean };
type Listener = { callback: (event: never) => void; once: boolean };

const attachments = new WeakMap<object, unknown>();
const peers = new WeakMap<HostSocket, HostSocket>();

function toBytes(data: SocketData): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

interface PairState {
  closed: boolean;
}

/** One end of a `WebSocketPair`. */
export class HostSocket {
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #state: PairState;
  readonly #inbound: Event[] = [];
  #outbound: ((data: string | Uint8Array) => void) | undefined;
  #outboundQueue: (string | Uint8Array)[] = [];
  #closeHook: ((code: number, reason: string) => void) | undefined;
  #pendingClose: { code: number; reason: string } | undefined;
  #flushScheduled = false;
  readyState: number = SOCKET_OPEN;
  protocol = "";
  readonly url: string;

  constructor(state: PairState, url: string) {
    this.#state = state;
    this.url = url;
  }

  // -- EventTarget subset -------------------------------------------------------------

  addEventListener(type: string, callback: (event: never) => void, options?: { once?: boolean }): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add({ callback, once: options?.once ?? false });
    this.#flush();
  }

  removeEventListener(type: string, callback: (event: never) => void): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    for (const listener of set) if (listener.callback === callback) set.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    const set = this.#listeners.get(event.type);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) {
      if (listener.once) set.delete(listener);
      (listener.callback as (value: Event) => void)(event);
    }
    return true;
  }

  // -- socket ------------------------------------------------------------------------

  /** workerd's `accept()` on a server end; here the socket is usable as soon as it exists. */
  accept(): void {
    this.readyState = SOCKET_OPEN;
  }

  send(data: SocketData): void {
    if (this.readyState !== SOCKET_OPEN) throw new Error("WebSocket is not open");
    const payload = typeof data === "string" ? data : toBytes(data);
    if (this.#outbound) this.#outbound(payload);
    else this.#outboundQueue.push(payload);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === SOCKET_CLOSING || this.readyState === SOCKET_CLOSED) return;
    this.readyState = SOCKET_CLOSED;
    this.#state.closed = true;
    this.#pendingClose = { code, reason };
    this.#closeHook?.(code, reason);
  }

  serializeAttachment(value: unknown): void {
    attachments.set(this, value);
  }

  deserializeAttachment(): unknown {
    return attachments.get(this) ?? null;
  }

  // -- runtime side (not part of the platform API) -------------------------------------

  /** Deliver an inbound frame now if anyone is listening, otherwise hold it. */
  __deliver(data: unknown): void {
    this.#inbound.push({ type: "message", data });
    this.#pump();
  }

  __deliverClose(code: number, reason: string, wasClean: boolean): void {
    this.readyState = SOCKET_CLOSED;
    this.#inbound.push({ type: "close", code, reason, wasClean });
    this.#pump();
  }

  /** Bind where `send()` goes; flushes anything sent before the binding existed. */
  __bindOutbound(outbound: (data: string | Uint8Array) => void): void {
    this.#outbound = outbound;
    const queued = this.#outboundQueue;
    this.#outboundQueue = [];
    for (const payload of queued) outbound(payload);
  }

  /**
   * Bind what `close()` does on this end. A socket can be closed before the binding exists —
   * the application may reject the connection inside the upgrade request, before the runtime
   * has wired the transport — so replay that close now instead of losing it.
   */
  __bindClose(hook: (code: number, reason: string) => void): void {
    this.#closeHook = hook;
    if (this.#pendingClose) hook(this.#pendingClose.code, this.#pendingClose.reason);
  }

  /** Flush what can be flushed, then leave the rest for a listener to pick up. */
  #pump(): void {
    this.#flush();
    if (this.#inbound.length > 0) this.#schedule();
  }

  #schedule(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    setTimeout(() => {
      this.#flushScheduled = false;
      this.#flush();
    }, 0);
  }

  /** Dispatch queued events while someone is listening; keep them otherwise. */
  #flush(): void {
    while (this.#inbound.length > 0) {
      const event = this.#inbound[0]!;
      if (!this.dispatchEvent(event)) return;
      this.#inbound.shift();
    }
  }
}

/** The other end of a pair: the server walks from the upgrade `Response` to the app's socket. */
export function peerOf(socket: HostSocket): HostSocket | undefined {
  return peers.get(socket);
}

/** `new WebSocketPair()` — index 0 is the client end, index 1 the server end. */
export class HostWebSocketPair {
  readonly 0: HostSocket;
  readonly 1: HostSocket;

  constructor(url = "") {
    const state: PairState = { closed: false };
    this[0] = new HostSocket(state, url);
    this[1] = new HostSocket(state, url);
    peers.set(this[0], this[1]);
    peers.set(this[1], this[0]);
  }
}

/**
 * Wire a pair to a shared transport: both ends write to it, and `close()` on either end closes
 * it. This is the real-socket case (`node-host/server.ts`).
 */
export function bindPair(clientEnd: HostSocket, serverEnd: HostSocket, transport: Transport): void {
  clientEnd.__bindOutbound((data) => transport.send(data));
  serverEnd.__bindOutbound((data) => transport.send(data));
  clientEnd.__bindClose((code, reason) => transport.close(code, reason));
  serverEnd.__bindClose((code, reason) => transport.close(code, reason));
}

/**
 * Wire a pair to itself: the client end's frames become the server end's events and vice
 * versa. This is the in-process test harness — no socket, same semantics.
 */
export function bindLoopback(
  clientEnd: HostSocket,
  serverEnd: HostSocket,
  hooks: {
    message(socket: HostSocket, data: string | Uint8Array): void;
    close(socket: HostSocket, code: number, reason: string): void;
  },
): void {
  clientEnd.__bindOutbound((data) => hooks.message(serverEnd, data));
  serverEnd.__bindOutbound((data) => clientEnd.__deliver(data));
  clientEnd.__bindClose((code, reason) => hooks.close(serverEnd, code, reason));
  serverEnd.__bindClose((code, reason) => clientEnd.__deliverClose(code, reason, true));
}

/** Patch the global `WebSocket` the SDK calls through (`WebSocket.prototype.serializeAttachment`). */
export function installAttachmentSupport(global: typeof globalThis): void {
  const ctor = (global as { WebSocket?: { prototype: object } }).WebSocket;
  if (!ctor) return;
  const proto = ctor.prototype as { serializeAttachment?: unknown; deserializeAttachment?: unknown };
  if (typeof proto.serializeAttachment === "function") return;
  Object.defineProperty(proto, "serializeAttachment", {
    configurable: true,
    writable: true,
    value(this: object, value: unknown) {
      attachments.set(this, value);
    },
  });
  Object.defineProperty(proto, "deserializeAttachment", {
    configurable: true,
    writable: true,
    value(this: object) {
      return attachments.get(this) ?? null;
    },
  });
}
