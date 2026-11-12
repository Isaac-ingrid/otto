/**
 * Which address the auth throttles bucket on (`index.ts` reads `CF-Connecting-IP`).
 *
 * workerd hands the Worker a real client address in that header. Behind nginx on a self-hosted
 * box nothing sets it, so without this every request from every client shared one `unknown`
 * bucket: the per-IP throttle degenerated into the global one and a single stranger could use up
 * the owner's five password attempts per minute.
 *
 * Trust only the socket peer, or X-Forwarded-For from a loopback peer (the local nginx).
 * nginx MUST overwrite X-Forwarded-For with $remote_addr, not append to a client-supplied
 * value. Never trust an incoming CF-Connecting-IP here: nginx forwards it unchanged unless
 * explicitly stripped, letting any remote client choose its own throttle bucket. Cloudflare's
 * Worker runtime supplies that header itself; this Node-host helper never runs there.
 *
 * Kept dependency-free so it can be unit-tested under either runtime (no `node:net` here).
 */

/** First element of a possibly-repeated header, before any comma list. */
export function firstHeaderValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const first = value?.split(",")[0]?.trim();
  return first && first.length <= 64 ? first : undefined;
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1";
}

export interface ClientIpInput {
  /** `request.socket.remoteAddress` — the peer that actually connected. */
  remoteAddress?: string | undefined;
  /** The raw `x-forwarded-for` header. */
  forwardedFor?: string | string[] | undefined;
}

export function clientIp(input: ClientIpInput): string {
  if (isLoopback(input.remoteAddress)) {
    const forwarded = firstHeaderValue(input.forwardedFor);
    if (forwarded) return forwarded;
  }
  return input.remoteAddress ?? "unknown";
}
