// Optional, content-free Web Push. The inbox is always authoritative; push is a best-effort
// wake-up signal, never a transport for decisions, task text or sign-in links.
import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import type { SqlExecutor } from "./schema.ts";

const MAX_DEVICES = 8;
const MAX_AGE_MS = 24 * 60 * 60_000;
const HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
/** Six attempts at most in 24h. The first ones are seconds apart because a single blocked
 *  attempt (an unreachable FCM, a flaky egress) should cost seconds, not the minutes an
 *  exponential backoff spends before it tries again. A re-sent wake-up coalesces in the same
 *  notification, since the payload carries one stable tag per outbound id. */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

export function retryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index]!;
}

/** A failure reason for the server log: never the endpoint, keys or payload. */
function failureReason(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === "string") return cause.code;
  return error instanceof Error ? error.name : "unknown";
}

export interface PushConfig {
  publicKey?: string; privateKey?: string; subject?: string;
  /** Optional server-only Pages egress for FCM; never sent to the browser. */
  relayUrl?: string; relayToken?: string;
}
export interface PushSettings { available: boolean; publicKey: string | null }
export interface SubscriptionInput { endpoint: string; expirationTime: number | null; keys: { p256dh: string; auth: string } }

export function validEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && HOSTS.has(url.hostname) && url.pathname.length > 1;
  } catch { return false; }
}

export function validSubscription(value: unknown): value is SubscriptionInput {
  if (!value || typeof value !== "object") return false;
  const sub = value as Partial<SubscriptionInput>;
  return typeof sub.endpoint === "string" && validEndpoint(sub.endpoint) &&
    (sub.expirationTime === null || (typeof sub.expirationTime === "number" && Number.isFinite(sub.expirationTime))) &&
    typeof sub.keys?.p256dh === "string" && /^[\w-]{86,88}$/.test(sub.keys.p256dh) &&
    typeof sub.keys?.auth === "string" && /^[\w-]{21,24}$/.test(sub.keys.auth);
}

export function quietNow(timeZone: string, at: number): boolean {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(new Date(at)));
    return hour >= 22 || hour < 8;
  } catch { return true; } // bad stored timezone: fail closed, not a midnight surprise
}

export class PushService {
  private draining?: Promise<void>;
  constructor(private readonly sql: SqlExecutor, private readonly config: PushConfig,
    private readonly schedule: (seconds: number) => Promise<unknown>,
    private readonly send: typeof fetch = fetch) {}

  private async deliver(endpoint: string, payload: Awaited<ReturnType<typeof buildPushPayload>>): Promise<Response> {
    const { relayUrl, relayToken } = this.config;
    if (new URL(endpoint).hostname !== "fcm.googleapis.com" || (!relayUrl && !relayToken))
      return this.send(endpoint, { ...payload, redirect: "error", signal: AbortSignal.timeout(10_000) });
    // A partial or malformed relay configuration must never leak the bearer token
    // or quietly send to an unexpected origin.
    if (!relayUrl || !relayToken || !/^[A-Za-z0-9_-]{43}$/.test(relayToken)) throw new Error("push relay not configured");
    const url = new URL(relayUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || url.search || url.pathname !== "/push")
      throw new Error("invalid push relay URL");
    const bytes = new Uint8Array(payload.body);
    const body = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return this.send(relayUrl, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(11_000),
      headers: { "content-type": "application/json", "x-otto-push-relay-token": relayToken },
      body: JSON.stringify({ endpoint, body, headers: {
        authorization: payload.headers.authorization, ttl: payload.headers.ttl,
        "content-encoding": payload.headers["content-encoding"], "content-type": payload.headers["content-type"],
      } }),
    });
  }

  settings(): PushSettings {
    const { publicKey, privateKey, subject } = this.config;
    const available = !!(publicKey && /^[\w-]{86,88}$/.test(publicKey) && privateKey && /^[\w-]{42,44}$/.test(privateKey) &&
      subject && /^(https:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/.test(subject));
    return { available, publicKey: available ? publicKey! : null };
  }

  subscribe(value: unknown, timeZone: string, quiet: boolean): boolean {
    if (!this.settings().available || !validSubscription(value) || timeZone.length > 100) return false;
    try { new Intl.DateTimeFormat("en", { timeZone }); } catch { return false; }
    const sub = value as SubscriptionInput;
    const count = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_push_sub`[0]!.n;
    if (count >= MAX_DEVICES && this.sql`SELECT 1 FROM sh_push_sub WHERE endpoint = ${sub.endpoint}`.length === 0) return false;
    this.sql`INSERT INTO sh_push_sub (endpoint, p256dh, auth, timeZone, quiet, createdAt)
      VALUES (${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth}, ${timeZone}, ${quiet ? 1 : 0}, ${Date.now()})
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
        timeZone = excluded.timeZone, quiet = excluded.quiet`;
    if (!quiet) this.sql`UPDATE sh_push_job SET dueAt = ${Date.now()} WHERE endpoint = ${sub.endpoint} AND sentAt IS NULL`;
    return true;
  }

  unsubscribe(endpoint: string): void {
    if (!validEndpoint(endpoint)) return;
    this.sql`DELETE FROM sh_push_job WHERE endpoint = ${endpoint}`;
    this.sql`DELETE FROM sh_push_sub WHERE endpoint = ${endpoint}`;
  }

  /** Stable outbound id × endpoint: retries and DO restarts cannot create a second job. */
  queue(outboundId: string, kind: "attention" | "done" | "health"): void {
    if (!this.settings().available) return;
    const now = Date.now();
    this.sql`INSERT OR IGNORE INTO sh_push_job (outboundId, endpoint, kind, createdAt, dueAt)
      SELECT ${outboundId}, endpoint, ${kind}, ${now}, ${now} FROM sh_push_sub`;
  }

  /** An explicit per-device test, rate-limited to one per minute by its durable id. */
  queueTest(endpoint: string): boolean {
    if (!this.settings().available || !validEndpoint(endpoint) ||
        this.sql`SELECT 1 FROM sh_push_sub WHERE endpoint = ${endpoint}`.length === 0) return false;
    const now = Date.now();
    this.sql`INSERT OR IGNORE INTO sh_push_job (outboundId, endpoint, kind, createdAt, dueAt)
      VALUES (${`test:${Math.floor(now / 60_000)}`}, ${endpoint}, ${"test"}, ${now}, ${now})`;
    return true;
  }

  /** Close the crash window between settling an outbound row and scheduling its push job.
   *  Sent/exhausted jobs remain for 24h so an isolate restart never replays a delivered alert. */
  reconcile(): void {
    if (!this.settings().available) return;
    const now = Date.now();
    this.sql`INSERT OR IGNORE INTO sh_push_job (outboundId, endpoint, kind, createdAt, dueAt)
      SELECT o.id, s.endpoint, CASE WHEN o.questionId IS NOT NULL THEN 'attention' ELSE 'done' END, o.sentAt, ${now}
      FROM sh_outbound o JOIN sh_push_sub s ON s.createdAt <= o.sentAt
      WHERE o.status = 'sent' AND o.kind = 'card' AND o.sentAt >= ${now - MAX_AGE_MS}
        AND (o.questionId IS NOT NULL OR o.id LIKE 'notify:report:%')`;
  }

  /** Retry at most six times in the first 24h. 404/410 invalidates that browser's subscription. */
  async drain(): Promise<void> {
    if (this.draining) return this.draining;
    const run = this.drainPass();
    this.draining = run;
    try { await run; } finally { if (this.draining === run) this.draining = undefined; }
  }

  private async drainPass(): Promise<void> {
    if (!this.settings().available) return;
    const now = Date.now();
    this.sql`DELETE FROM sh_push_job WHERE createdAt < ${now - MAX_AGE_MS}`;
    this.sql`UPDATE sh_push_job SET sentAt = ${now} WHERE attempts >= 6 AND sentAt IS NULL`;
    const jobs = this.sql<{ outboundId: string; endpoint: string; kind: string; timeZone: string; quiet: number; p256dh: string; auth: string; attempts: number }>`
      SELECT j.outboundId, j.endpoint, j.kind, s.timeZone, s.quiet, s.p256dh, s.auth, j.attempts
      FROM sh_push_job j JOIN sh_push_sub s ON j.endpoint = s.endpoint
      WHERE j.sentAt IS NULL AND j.dueAt <= ${now} ORDER BY j.dueAt LIMIT 10`;
    for (const job of jobs) {
      if (job.kind === "attention") {
        const open = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_outbound o JOIN sh_question q ON q.qid = o.questionId
          WHERE o.id = ${job.outboundId} AND q.status = 'open'`[0]!.n;
        if (!open) {
          this.sql`UPDATE sh_push_job SET sentAt = ${Date.now()} WHERE outboundId = ${job.outboundId} AND endpoint = ${job.endpoint}`;
          continue;
        }
      }
      if (job.kind !== "test" && job.quiet && quietNow(job.timeZone, Date.now())) {
        this.sql`UPDATE sh_push_job SET dueAt = ${Date.now() + 60 * 60_000} WHERE outboundId = ${job.outboundId} AND endpoint = ${job.endpoint}`;
        continue;
      }
      try {
        // Never use the outbound card, question or thread title as notification content.
        const subscription: PushSubscription = { endpoint: job.endpoint, expirationTime: null, keys: { p256dh: job.p256dh, auth: job.auth } };
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(job.outboundId) as BufferSource));
        const tag = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        const payload = await buildPushPayload({ data: JSON.stringify({ kind: job.kind, tag }), options: { ttl: 3600 } }, subscription, {
          subject: this.config.subject, publicKey: this.config.publicKey, privateKey: this.config.privateKey,
        });
        const response = await this.deliver(job.endpoint, payload);
        if (response.ok || response.status === 404 || response.status === 410) {
          if (!response.ok) this.unsubscribe(job.endpoint);
          if (response.ok) this.sql`UPDATE sh_push_job SET sentAt = ${Date.now()} WHERE outboundId = ${job.outboundId} AND endpoint = ${job.endpoint}`;
          continue;
        }
        console.error(`[otto] push rejected kind=${job.kind} status=${response.status} attempt=${job.attempts + 1}`);
      } catch (error) {
        // Network/crypto failure: keep the in-app card and retry, never log tokens or payload.
        console.error(`[otto] push failed kind=${job.kind} reason=${failureReason(error)} attempt=${job.attempts + 1}`);
      }
      const attempts = job.attempts + 1;
      this.sql`UPDATE sh_push_job SET attempts = ${attempts}, dueAt = ${Date.now() + retryDelayMs(attempts)}
        WHERE outboundId = ${job.outboundId} AND endpoint = ${job.endpoint}`;
    }
    const next = this.sql<{ at: number | null }>`SELECT MIN(dueAt) AS at FROM sh_push_job WHERE sentAt IS NULL`[0]?.at;
    if (next !== null && next !== undefined) await this.schedule(Math.max(1, Math.ceil((next - Date.now()) / 1000)));
  }
}
