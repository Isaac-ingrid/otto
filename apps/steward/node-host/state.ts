/**
 * `DurableObjectState` for the Node host.
 *
 * Only the surface the Agents SDK and the steward actually use is implemented:
 * `id`, `storage`, `acceptWebSocket`/`getWebSockets`/`getTags`, `blockConcurrencyWhile`,
 * `waitUntil` and `abort`.
 *
 * `blockConcurrencyWhile` keeps workerd's ordering guarantee: the platform does not deliver
 * the next event until the callback settles. Our server calls `__drain()` before every
 * request, alarm and socket frame, which is the same barrier without an input gate.
 */
import type { NodeDurableObjectStorage } from "./storage.ts";
import { HostSocket } from "./websocket.ts";

export interface DurableObjectIdLike {
  readonly name?: string;
  toString(): string;
  equals(other: DurableObjectIdLike): boolean;
}

/** Which state accepted a socket — the runtime uses it to route frames to the right instance. */
const socketOwners = new WeakMap<HostSocket, NodeDurableObjectState>();

export function socketOwner(socket: HostSocket): NodeDurableObjectState | undefined {
  return socketOwners.get(socket);
}

export class NodeDurableObjectId implements DurableObjectIdLike {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  toString(): string {
    return this.name;
  }

  equals(other: DurableObjectIdLike): boolean {
    return other?.toString() === this.name;
  }
}

export class NodeDurableObjectState {
  readonly id: NodeDurableObjectId;
  readonly storage: NodeDurableObjectStorage;
  readonly props: unknown;
  readonly #sockets = new Set<HostSocket>();
  readonly #tags = new WeakMap<HostSocket, string[]>();
  #pending = new Set<Promise<unknown>>();
  #aborted = false;

  constructor(id: NodeDurableObjectId, storage: NodeDurableObjectStorage, props?: unknown) {
    this.id = id;
    this.storage = storage;
    this.props = props;
  }

  // -- hibernatable websockets -------------------------------------------------------

  acceptWebSocket(ws: HostSocket, tags: string[] = []): void {
    ws.accept();
    this.#sockets.add(ws);
    socketOwners.set(ws, this);
    this.#tags.set(ws, [...tags]);
    ws.addEventListener("close", () => {
      this.#sockets.delete(ws);
    });
  }

  getWebSockets(tag?: string): HostSocket[] {
    const sockets = [...this.#sockets];
    if (tag === undefined) return sockets;
    return sockets.filter((socket) => this.#tags.get(socket)?.includes(tag) ?? false);
  }

  getTags(ws: HostSocket): string[] {
    return [...(this.#tags.get(ws) ?? [])];
  }

  // -- platform lifecycle ------------------------------------------------------------

  blockConcurrencyWhile<T>(callback: () => Promise<T> | T): Promise<T> {
    const promise = Promise.resolve().then(callback);
    this.#pending.add(promise);
    void promise.catch(() => {}).finally(() => this.#pending.delete(promise));
    return promise;
  }

  waitUntil(promise: Promise<unknown>): void {
    void promise.catch((error) => console.error("[node-host] waitUntil rejected", error));
  }

  abort(reason?: unknown): void {
    this.#aborted = true;
    console.error("[node-host] Durable Object aborted", reason);
    for (const socket of this.#sockets) socket.close(1011, "aborted");
  }

  /** Wait for every in-flight `blockConcurrencyWhile` callback (workerd's input gate). */
  async __drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
    if (this.#aborted) throw new Error("Durable Object aborted");
  }
}
