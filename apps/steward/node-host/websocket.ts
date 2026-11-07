/**
 * `WebSocketPair` / hibernatable WebSocket surface.
 *
 * workerd hands the runtime one end of a `WebSocketPair` from an upgrade `Response`
 * (`{ status: 101, webSocket: pair[0] }`) and the application the other end
 * (`ctx.acceptWebSocket(pair[1])`). Here the "runtime" is our HTTP server, so the client end
 * carries a `Transport` — the real socket from the `ws` package — and the server end is what
 * the Agents SDK sees as a connection.
 *
 * Hibernation is emulated by keeping the accepted sockets in memory for the life of the
 * process; a restart simply closes them, and connectors reconnect (the protocol already
 * treats a dropped socket as normal — `apps/connector/src/client.ts` retries).
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

type Listener = (event: { type: string; data?: unknown; code?: number; reason?: string; wasClean?: boolean }) => void;

const attachments = new WeakMap<object, unknown>();

interface PairState {
  transport?: Transport;
  queue: Uint8Array[];
  closed: boolean;
}

function toBytes(data: SocketData): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** One end of a `WebSocketPair`. */
export class HostSocket {
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #state: PairState;
  readyState: number = SOCKET_OPEN;
  protocol = "";
  readonly url: string;

  constructor(state: PairState, url: string) {
    this.#state = state;
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type: string; [key: string]: unknown }): boolean {
    for (const listener of [...(this.#listeners.get(event.type) ?? [])]) listener(event as never);
    return true;
  }

  /** workerd's `accept()` on a server end; here the socket is usable as soon as it exists. */
  accept(): void {
    this.readyState = SOCKET_OPEN;
  }

  send(data: SocketData): void {
    if (this.readyState !== SOCKET_OPEN) throw new Error("WebSocket is not open");
    const bytes = toBytes(data);
    if (this.#state.transport) this.#state.transport.send(bytes);
    else this.#state.queue.push(bytes);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === SOCKET_CLOSING || this.readyState === SOCKET_CLOSED) return;
    this.readyState = SOCKET_CLOSED;
    this.#state.closed = true;
    this.#state.transport?.close(code, reason);
  }

  serializeAttachment(value: unknown): void {
    attachments.set(this, value);
  }

  deserializeAttachment(): unknown {
    return attachments.get(this) ?? null;
  }

  /** Deliver an inbound frame to this end's listeners. */
  __deliver(data: Uint8Array): void {
    this.dispatchEvent({ type: "message", data });
  }

  /** Deliver the close notification to this end's listeners. */
  __deliverClose(code: number, reason: string, wasClean: boolean): void {
    this.readyState = SOCKET_CLOSED;
    this.dispatchEvent({ type: "close", code, reason, wasClean });
  }

  /** Bind the real network socket to the pair; flushes anything sent during setup. */
  __attachTransport(transport: Transport): void {
    this.#state.transport = transport;
    const queue = this.#state.queue.splice(0, this.#state.queue.length);
    for (const frame of queue) transport.send(frame);
    if (this.#state.closed) transport.close(1000, "");
  }
}

const peers = new WeakMap<HostSocket, HostSocket>();

/** The other end of a pair: the server walks from the upgrade `Response` to the app's socket. */
export function peerOf(socket: HostSocket): HostSocket | undefined {
  return peers.get(socket);
}

/** `new WebSocketPair()` — index 0 is the client end, index 1 the server end. */
export class HostWebSocketPair {
  readonly 0: HostSocket;
  readonly 1: HostSocket;

  constructor(url = "") {
    const state: PairState = { queue: [], closed: false };
    this[0] = new HostSocket(state, url);
    this[1] = new HostSocket(state, url);
    peers.set(this[0], this[1]);
    peers.set(this[1], this[0]);
  }
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
