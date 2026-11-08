// The Node host has to synthesise `CF-Connecting-IP` (node-host/client-ip.ts): workerd fills it
// in, nginx does not. Getting the precedence wrong is a security bug, not a cosmetic one — every
// client collapsing into one bucket means a stranger can spend the owner's password attempts.
import { describe, expect, it } from "vitest";
import { clientIp, isLoopback } from "../node-host/client-ip.ts";

describe("the client address the auth throttle buckets on", () => {
  it("prefers an existing CF-Connecting-IP, so a Cloudflare deployment and the test harnesses keep their address", () => {
    expect(clientIp({ remoteAddress: "127.0.0.1", forwardedFor: "198.51.100.9", existing: "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("takes the first X-Forwarded-For hop when the peer is the proxy on this box", () => {
    expect(clientIp({ remoteAddress: "127.0.0.1", forwardedFor: "198.51.100.9, 10.0.0.2" })).toBe("198.51.100.9");
    expect(clientIp({ remoteAddress: "::1", forwardedFor: ["198.51.100.9"] })).toBe("198.51.100.9");
    expect(clientIp({ remoteAddress: "::ffff:127.0.0.1", forwardedFor: "198.51.100.9" })).toBe("198.51.100.9");
  });

  it("ignores X-Forwarded-For from a remote peer — that header would be the client's own claim", () => {
    expect(clientIp({ remoteAddress: "198.51.100.9", forwardedFor: "203.0.113.7" })).toBe("198.51.100.9");
  });

  it("falls back to the socket, then to `unknown`", () => {
    expect(clientIp({ remoteAddress: "198.51.100.9" })).toBe("198.51.100.9");
    expect(clientIp({})).toBe("unknown");
    // A proxy peer with no forwarded header is the proxy itself, not the client it forgot to name.
    expect(clientIp({ remoteAddress: "127.0.0.1" })).toBe("127.0.0.1");
  });

  it("rejects junk rather than bucketing on it", () => {
    expect(clientIp({ remoteAddress: "127.0.0.1", forwardedFor: "x".repeat(200) })).toBe("127.0.0.1");
    expect(clientIp({ remoteAddress: "127.0.0.1", forwardedFor: "   " })).toBe("127.0.0.1");
  });

  it("knows loopback in all the shapes a socket reports it", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.1.2.3")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("198.51.100.9")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
