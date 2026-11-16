import { afterEach, describe, expect, it, vi } from "vitest";
import { installLoopbackFetchGuard } from "../../e2e/network-guard.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

describe("browser fixture's Node network guard", () => {
  it("rejects external requests before I/O and remembers swallowed failures", async () => {
    const send = vi.fn();
    globalThis.fetch = send;
    const guard = installLoopbackFetchGuard();
    try {
      await expect(fetch("https://api.github.com/repos/example/demo/pulls/42")).rejects.toThrow("External network is disabled");
      expect(send).not.toHaveBeenCalled();
      expect(() => guard.assertIsolated()).toThrow("Unexpected external requests");
    } finally {
      guard.restore();
    }
    expect(globalThis.fetch).toBe(send);
  });

  it("allows loopback requests but refuses redirect following", async () => {
    const send = vi.fn(async () => new Response("local"));
    globalThis.fetch = send;
    const guard = installLoopbackFetchGuard();
    try {
      expect(await (await fetch("http://127.0.0.1:12345/app", { redirect: "follow" })).text()).toBe("local");
      expect(send).toHaveBeenCalledWith("http://127.0.0.1:12345/app", { redirect: "error" });
      expect(() => guard.assertIsolated()).not.toThrow();
    } finally {
      guard.restore();
    }
  });
});
