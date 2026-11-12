import { getDefaultAutoSelectFamily, getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamily, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HAPPY_EYEBALLS_MS, configureTcpEgress } from "../tcp.ts";

const restore = { family: getDefaultAutoSelectFamily(), budget: getDefaultAutoSelectFamilyAttemptTimeout() };
afterEach(() => {
  setDefaultAutoSelectFamily(restore.family);
  setDefaultAutoSelectFamilyAttemptTimeout(restore.budget);
});

// A mainland-China VPS connected to Cloudflare in 250–370 ms, while Node aborted each attempt
// after its 250 ms Happy-Eyeballs budget and reported `connect ETIMEDOUT` for every address —
// pushes and model calls failed ~85% of the time even though the same socket connected every
// time. One second keeps the dual-stack race without inventing timeouts.
describe("Node host TCP egress budget", () => {
  it("defaults to a one-second per-address budget", () => {
    expect(configureTcpEgress(undefined)).toBe(DEFAULT_HAPPY_EYEBALLS_MS);
    expect(DEFAULT_HAPPY_EYEBALLS_MS).toBeGreaterThan(250);
    expect(getDefaultAutoSelectFamily()).toBe(true);
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(DEFAULT_HAPPY_EYEBALLS_MS);
  });

  it("takes an explicit millisecond budget", () => {
    expect(configureTcpEgress("2500")).toBe(2500);
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(2500);
    // Blank means "unset", not zero.
    expect(configureTcpEgress("  ")).toBe(DEFAULT_HAPPY_EYEBALLS_MS);
  });

  it("falls back to the default for values the runtime would reject", () => {
    for (const raw of ["-1", "5", "abc", "NaN"]) expect(configureTcpEgress(raw)).toBe(DEFAULT_HAPPY_EYEBALLS_MS);
  });

  it("lets a host with a dead address family turn the race off", () => {
    expect(configureTcpEgress("0")).toBe(false);
    expect(getDefaultAutoSelectFamily()).toBe(false);
  });
});
