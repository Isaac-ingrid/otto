/**
 * Which address the auth throttles bucket on (`index.ts` reads `CF-Connecting-IP`).
 *
 * workerd hands the Worker a real client address in that header. Behind nginx on a self-hosted
 * box nothing sets it, so without this every request from every client shared one `unknown`
 * bucket: the per-IP throttle degenerated into the global one and a single stranger could use up
 * the owner's five password attempts per minute.
 *
 * Precedence, and why:
 *   1. An existing `CF-Connecting-IP` wins — that is Cloudflare's (or a test harness's) claim to
 *      know the client, and it is also what keeps the workerd suite's fixed test IPs meaningful
 *      when the same tests run against this host.
 *   2. Only a loopback peer may speak for the client through `X-Forwarded-For`: there the proxy
 *      is on this box (nginx → 127.0.0.1:8787), so the header cannot have come from the internet.
 *      A direct remote connection ignoring its own `X-Forwarded-For` is exactly the spoof that
 *      would dodge the per-IP bucket.
 *   3. Otherwise the socket's own address.
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
  /** The raw `cf-connecting-ip` header, if the peer already sent one. */
  existing?: string | string[] | undefined;
}

export function clientIp(input: ClientIpInput): string {
  const claimed = firstHeaderValue(input.existing);
  if (claimed) return claimed;
  if (isLoopback(input.remoteAddress)) {
    const forwarded = firstHeaderValue(input.forwardedFor);
    if (forwarded) return forwarded;
  }
  return input.remoteAddress ?? "unknown";
}
