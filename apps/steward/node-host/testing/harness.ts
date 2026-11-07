/**
 * In-process test harness for the Node host.
 *
 * The workerd suite (`pnpm test`) is the semantic baseline. This harness lets *the same test
 * files* run against the Node host with no server, no sockets and in-memory databases, by
 * providing the three exports the suite actually imports from `cloudflare:test`: `env`,
 * `SELF` and `runInDurableObject`.
 *
 * Every `idFromName(...)` gets its own instance and its own in-memory database, because several
 * suites build "old" Durable Objects by hand (`env.Steward.idFromName(\`test-…-${uuid}\`)`) and
 * rely on that storage being empty. A real deployment only ever uses the one `owner` instance.
 *
 * The bindings mirror `vitest.config.ts` (explicit-key) and `vitest.generated-auth.config.ts`
 * (generated-key). Keep them in sync when the workerd configs change.
 */
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

import { installGlobals } from "../globals.ts";
import { createAssets, createRateLimiter } from "../env.ts";
import { createNamespace, INSTANCE_NAME } from "../namespace.ts";
import { HostRuntime } from "../runtime.ts";
import { NodeDurableObjectId, NodeDurableObjectState, socketOwner } from "../state.ts";
import { NodeDurableObjectStorage } from "../storage.ts";
import { bindLoopback, peerOf, type HostSocket, type SocketData } from "../websocket.ts";

export type TestProfile = "explicit" | "generated";

const STEWARD_MODEL = JSON.stringify({ provider: "faux", modelId: "faux-1" });

const PROFILES: Record<TestProfile, Record<string, string>> = {
  explicit: {
    SERVER_KEY: "test-server-key-not-a-secret",
    SERVER_KEY_PREVIOUS: "test-previous-server-key-not-a-secret",
    LOGIN_PASSWORD: "",
    MODEL_KEY: "test-model-key-not-a-secret",
    STEWARD_MODEL,
  },
  generated: {
    LOGIN_PASSWORD: "correct horse battery staple 47!",
    MODEL_KEY: "test-model-key-not-a-secret",
    STEWARD_MODEL,
  },
};

interface Instance {
  db: DatabaseSync;
  state: NodeDurableObjectState;
  /** The instance as the namespace hands it out: async entry points first run a due alarm. */
  steward: { fetch(request: Request): Promise<Response> };
  /** The bare instance, for `runInDurableObject` (same contract as workerd's raw object). */
  raw: { fetch(request: Request): Promise<Response> };
  runtime: HostRuntime<never>;
}

export interface TestingHarness {
  readonly env: Record<string, unknown>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  runInDurableObject<T>(stub: unknown, callback: (instance: never, state: NodeDurableObjectState) => T | Promise<T>): Promise<T>;
  /** Run one alarm pass the way the platform would (workerd's `runDurableObjectAlarm`). */
  runDurableObjectAlarm(): Promise<void>;
  dispose(): void;
}

function profileFromEnv(): TestProfile {
  return process.env.SIG_TEST_PROFILE === "generated" ? "generated" : "explicit";
}

export async function createHarness(profile: TestProfile = profileFromEnv()): Promise<TestingHarness> {
  installGlobals();

  // Loaded after `installGlobals()` so the Agents SDK's module graph sees the platform shims.
  const { default: worker } = await import("../../src/index.ts");
  const { Steward } = await import("../../src/steward.ts");

  const env: Record<string, unknown> = {
    ...PROFILES[profile],
    ASSETS: createAssets(resolve(import.meta.dirname, "../../ui")),
    LOGIN_RATE_LIMITER: createRateLimiter(),
  };

  const instances = new Map<string, Instance>();
  const byState = new Map<NodeDurableObjectState, Instance>();
  const open: Instance[] = [];

  function instance(name: string): Instance {
    const existing = instances.get(name);
    if (existing) return existing;
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const state = new NodeDurableObjectState(new NodeDurableObjectId(name), new NodeDurableObjectStorage(db));
    // biome-ignore lint/suspicious/noExplicitAny: the SDK constructor's type is not exported.
    const steward = new (Steward as any)(state, env) as Instance["steward"];
    // A tighter poll than the deployed 250ms: the suite treats "the alarm has fired" as
    // immediate (workerd wakes the object on time), so waiting on wall-clock tick budget would
    // make assertions race for no reason.
    const runtime = new HostRuntime(state, steward as never, { tickMs: 10 });
    runtime.start();
    /**
     * A stub call is a real round trip in workerd: while the caller's next request is in
     * flight the isolate keeps running fire-and-forget work (`void this.drainNotifications()`).
     * In-process RPC resolves in a microtask, so give that work the event-loop turns a network
     * hop would — without forcing a due alarm, which workerd would only run at its own time.
     */
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      // A hop also costs a millisecond of wall clock, and some observations are durations
      // (`sh_machine.reliability.onlineMs`): an in-process connect/drop cycle would measure 0.
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const guarded = new Proxy(steward, {
      get(target, property) {
        const value = Reflect.get(target as object, property, target);
        if (typeof value !== "function" || (value as { constructor?: { name?: string } }).constructor?.name !== "AsyncFunction") return value;
        return (...args: unknown[]) => settle().then(() => (value as (...a: unknown[]) => unknown).apply(target, args));
      },
    });
    const created: Instance = { db, state, steward: guarded, raw: steward, runtime };
    instances.set(name, created);
    byState.set(state, created);
    open.push(created);
    return created;
  }

  env.Steward = createNamespace("Steward", (idName) => instance(idName).steward);

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await new Promise((resolve) => setTimeout(resolve, 1)); // the hop to the edge
    const request = input instanceof Request && !init ? input : new Request(input as string, init);
    // A real hop (workerd's SELF.fetch) carries a content-length; the steward's body-size guard
    // reads it, so synthesise it here rather than through a socket.
    if (typeof init?.body === "string" && !request.headers.has("content-length")) {
      request.headers.set("content-length", String(new TextEncoder().encode(init.body).byteLength));
    }
    const response = await worker.fetch(request, env as never);
    const clientEnd = (response as { webSocket?: HostSocket | null }).webSocket ?? undefined;
    const owner = clientEnd ? peerOf(clientEnd) : undefined;
    const target = owner ? socketOwner(owner) : undefined;
    const host = target ? byState.get(target) : undefined;
    if (clientEnd && owner && host) {
      bindLoopback(clientEnd, owner, {
        message: (socket: HostSocket, data: SocketData) => host.runtime.deliverMessage(socket, data),
        close: (socket: HostSocket, code: number, reason: string) => host.runtime.deliverClose(socket, code, reason, true),
      });
    }
    return response;
  };

  return {
    env,
    fetch,
    async runInDurableObject(stub, callback) {
      const name = (stub as { [INSTANCE_NAME]?: string } | undefined)?.[INSTANCE_NAME] ?? "owner";
      const target = instance(name);
      await target.runtime.tick();
      return callback(target.raw as never, target.state);
    },
    async runDurableObjectAlarm() {
      await Promise.all(open.map((entry) => entry.runtime.tick(Date.now() + 1_000_000)));
    },
    dispose() {
      for (const entry of open) {
        void entry.runtime.stop();
        entry.db.close();
      }
      instances.clear();
      byState.clear();
      open.length = 0;
    },
  };
}

/**
 * One harness per process. vitest runs one process per file with `fileParallelism: false`, so
 * per-file state isolation comes for free — same as the workerd setup, where the Durable
 * Object's SQLite is shared within a process only.
 */
export const harness: TestingHarness = await createHarness();

process.on("exit", () => {
  harness.dispose();
});
