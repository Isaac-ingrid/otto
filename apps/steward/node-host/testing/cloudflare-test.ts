/**
 * `cloudflare:test` for the Node host.
 *
 * `vitest.node.config.ts` aliases the specifier here, so the steward's test files run
 * unchanged. Only the exports the suite imports are implemented; the rest exist so an
 * accidental import fails loudly at the call site rather than at module load.
 */
import { harness } from "./harness.ts";

export const env = harness.env;

export const SELF = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return harness.fetch(input, init);
  },
};

export function runInDurableObject<T>(
  stub: unknown,
  callback: (instance: never, state: unknown) => T | Promise<T>,
): Promise<T> {
  return harness.runInDurableObject(stub, callback as never);
}

export function runDurableObjectAlarm(stub: unknown): Promise<boolean> {
  void stub;
  return harness.runDurableObjectAlarm().then(() => true);
}

/** Executions are not a thing without an isolate; the Cloudflare helpers are no-ops here. */
export function createExecutionContext(): { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void } {
  return {
    waitUntil(promise) {
      void promise.catch((error) => console.error("[node-host] waitUntil rejected", error));
    },
    passThroughOnException() {},
  };
}

export function waitOnExecutionContext(_context: unknown): Promise<void> {
  return Promise.resolve();
}

export function listDurableObjectIds(): Promise<never[]> {
  return Promise.resolve([]);
}

export default { env, SELF, runInDurableObject };
