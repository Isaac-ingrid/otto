/**
 * The Durable Object "platform": event delivery, the alarm timer and the socket bridge.
 *
 * workerd's contract, in the order the steward depends on it:
 *
 *  1. events never overlap — a new request/alarm/socket frame waits for in-flight
 *     `blockConcurrencyWhile` work (`state.__drain()`, the input gate);
 *  2. the alarm is persisted and fires once, then re-arms from whatever the app sets;
 *  3. an upgrade returns a 101 `Response` carrying one end of a `WebSocketPair`, and frames
 *     from the other end arrive as `webSocketMessage` calls.
 */
import { peerOf, type HostSocket, type SocketData } from "./websocket.ts";
import type { NodeDurableObjectState } from "./state.ts";

export interface DurableObjectHost {
  fetch(request: Request): Promise<Response>;
  alarm?(): Promise<void> | void;
  webSocketMessage?(socket: HostSocket, data: SocketData): Promise<void> | void;
  webSocketClose?(socket: HostSocket, code: number, reason: string, wasClean: boolean): Promise<void> | void;
  webSocketError?(socket: HostSocket, error: unknown): void;
}

const TICK_MS = 250;

export class HostRuntime<H extends DurableObjectHost> {
  readonly #state: NodeDurableObjectState;
  readonly #instance: H;
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;
  #messages: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(state: NodeDurableObjectState, instance: H) {
    this.#state = state;
    this.#instance = instance;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#state.__drain().catch(() => {});
  }

  async handleRequest(request: Request): Promise<Response> {
    await this.#state.__drain();
    return this.#instance.fetch(request);
  }

  /** One alarm pass: workerd clears the alarm before invoking `alarm()`. */
  async tick(now = Date.now()): Promise<void> {
    if (this.#closed || this.#ticking) return;
    if (this.#state.storage.takeDueAlarm(now) === null) return;
    this.#ticking = true;
    try {
      await this.#state.__drain();
      await this.#instance.alarm?.();
    } catch (error) {
      console.error("[node-host] alarm failed", error);
    } finally {
      this.#ticking = false;
    }
  }

  /** A frame arrived from the network on the accepted end of a pair. */
  deliverMessage(socket: HostSocket, data: SocketData): void {
    this.#messages = this.#messages
      .then(async () => {
        await this.#state.__drain();
        await this.#instance.webSocketMessage?.(socket, data);
      })
      .catch((error) => {
        console.error("[node-host] webSocketMessage failed", error);
      });
  }

  deliverClose(socket: HostSocket, code: number, reason: string, wasClean: boolean): void {
    this.#messages = this.#messages
      .then(async () => {
        await this.#state.__drain();
        await this.#instance.webSocketClose?.(socket, code, reason, wasClean);
      })
      .catch((error) => {
        console.error("[node-host] webSocketClose failed", error);
      });
  }

  deliverError(socket: HostSocket, error: unknown): void {
    this.#instance.webSocketError?.(socket, error);
  }
}

/** Bind a real socket to the upgrade `Response`'s client end. */
export function connectTransport(clientEnd: HostSocket, transport: { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void }): HostSocket {
  const serverEnd = peerOf(clientEnd);
  if (!serverEnd) throw new Error("Upgrade response carried a socket that is not part of a pair");
  clientEnd.__attachTransport(transport);
  return serverEnd;
}
