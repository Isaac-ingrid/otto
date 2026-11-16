// Test-only deny-by-default guard. The Node fixture may talk to loopback, never to a
// model, GitHub or any other external service. Record attempts even if app code catches
// fetch's rejection, so teardown cannot turn an unexpected request into a green test.
export function installLoopbackFetchGuard() {
  const original = globalThis.fetch;
  const blocked: string[] = [];
  const guarded: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
      blocked.push(`${url.origin}${url.pathname}`);
      throw new Error("External network is disabled in browser tests");
    }
    // Do not let an allowed loopback URL redirect to an external origin.
    return original(input, { ...init, redirect: "error" });
  };
  globalThis.fetch = guarded;
  return {
    assertIsolated() {
      if (blocked.length > 0) throw new Error(`Unexpected external requests: ${blocked.join(", ")}`);
    },
    restore() {
      if (globalThis.fetch === guarded) globalThis.fetch = original;
    },
  };
}
