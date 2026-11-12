/**
 * TCP connect tuning for hosts whose egress is slow, not broken.
 *
 * Node resolves a host and races the addresses (Happy Eyeballs), giving each attempt
 * `net.getDefaultAutoSelectFamilyAttemptTimeout()` — 250 ms — before it moves on. A mainland-China
 * VPS measured 250–370 ms to Cloudflare, right on that boundary: the socket was torn down and the
 * failure surfaced as `connect ETIMEDOUT` for *every* address, while `net.connect` to the very same
 * address succeeded every time. Outbound pushes, model calls and search then looked like a censored
 * or unreachable internet instead of a too-short local budget.
 *
 * One second keeps the dual-stack race without inventing timeouts. `OTTO_TCP_HAPPY_EYEBALLS_MS=0`
 * disables the race for a host with a black-holed address family.
 */
import { setDefaultAutoSelectFamily, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

export const DEFAULT_HAPPY_EYEBALLS_MS = 1_000;

/** Applies the process-wide connect defaults; returns the budget in ms, or `false` when disabled. */
export function configureTcpEgress(raw: string | undefined = process.env.OTTO_TCP_HAPPY_EYEBALLS_MS): number | false {
  const requested = raw === undefined || raw.trim() === "" ? DEFAULT_HAPPY_EYEBALLS_MS : Number(raw);
  if (requested === 0) {
    setDefaultAutoSelectFamily(false);
    return false;
  }
  const budget = Number.isFinite(requested) && requested >= 10 ? requested : DEFAULT_HAPPY_EYEBALLS_MS;
  setDefaultAutoSelectFamily(true);
  setDefaultAutoSelectFamilyAttemptTimeout(budget);
  return budget;
}
