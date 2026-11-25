// Stage 5 Multi-Channel Signed Outbound Webhooks (`channel/webhooks.ts`).
//
// Supports non-blocking outbound notifications to:
// - `feishu`: Feishu custom bot Webhook V2 (`msg_type: "interactive"`, Schema 2.0 `card`,
//   optional `timestamp` + `sign` base64(HMAC-SHA256(key = `${ts}\n${secret}`, msg = "")))
// - `generic`: Signed JSON webhook (`X-Otto-Signature-256: sha256=<hex>`, `X-Otto-Timestamp`,
//   `X-Otto-Event`)
// - `dingtalk`: DingTalk custom bot markdown (`?timestamp=...&sign=<url-encoded base64 HMAC>`)
// - `wecom` / `slack`: Markdown / text JSON payload
//
// Security invariants:
// - SSRF protection (`validateWebhookTargetUrl`): requires `https:` in production and blocks
//   loopback, link-local metadata (`169.254.169.254`), RFC1918 private IPv4, IPv6 loopback/ULA,
//   and `.local` / `.internal` hostnames.
// - Never blocks local workspace delivery: bounded 5s timeout per endpoint, errors logged to audit.
import type { SqlExecutor } from "../schema.ts";
import type { LocalMessage, Tone } from "../report-template.ts";
import { renderFeishuCardV2, type FeishuCardV2 } from "./feishu-card-v2.ts";

export type OutboundWebhookKind = "feishu" | "generic" | "dingtalk" | "wecom" | "slack";

const VALID_KINDS = new Set<OutboundWebhookKind>(["feishu", "generic", "dingtalk", "wecom", "slack"]);

export interface OutboundWebhookRow {
  id: string;
  kind: OutboundWebhookKind;
  url: string;
  secretEnc: string | null;
  eventsJson: string;
  enabled: number;
  createdAt: number;
  updatedAt: number;
}

export interface OutboundWebhookView {
  id: string;
  kind: OutboundWebhookKind;
  urlMasked: string;
  hasSecret: boolean;
  events: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OutboundWebhookEventPayload {
  id: string;
  eventType: string;
  threadId: string | null;
  threadTitle?: string;
  tone?: Tone;
  card: LocalMessage;
  workspaceUrl?: string | null;
  actionLinks?: Record<string, string>;
  timestampMs?: number;
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function validateWebhookTargetUrl(
  rawUrl: string,
  options?: { allowHttpLoopbackForTest?: boolean },
): { ok: true; normalizedUrl: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "missing_host" };

  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (options?.allowHttpLoopbackForTest && isLoopback && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return { ok: true, normalizedUrl: parsed.toString() };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "https_required" };
  }
  if (
    isLoopback ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    isPrivateOrReservedIpv4(host)
  ) {
    return { ok: false, reason: "private_or_loopback_host_forbidden" };
  }
  return { ok: true, normalizedUrl: parsed.toString() };
}

function maskUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const tail = u.pathname.length > 14 ? `${u.pathname.slice(0, 10)}…${u.pathname.slice(-4)}` : u.pathname;
    return `${u.origin}${tail}`;
  } catch {
    return "invalid-url";
  }
}

async function hmacBytes(keyText: string, messageText: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(messageText)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Feishu custom bot webhook signature: `base64(HMAC-SHA256(key = "${timestampSec}\n${secret}", msg = ""))`. */
export async function computeFeishuBotSign(timestampSec: number, signingKey: string): Promise<string> {
  const raw = await hmacBytes(`${timestampSec}\n${signingKey}`, "");
  return bytesToBase64(raw);
}

/** Generic Otto webhook signature: `sha256=<hex(HMAC-SHA256(key = secret, msg = "${timestampSec}.${body}"))>`. */
export async function computeGenericWebhookSignature(
  timestampSec: number,
  signingKey: string,
  rawBody: string,
): Promise<string> {
  const raw = await hmacBytes(signingKey, `${timestampSec}.${rawBody}`);
  return `sha256=${bytesToHex(raw)}`;
}

/** DingTalk custom robot signature: `base64(HMAC-SHA256(key = secret, msg = "${timestampMs}\n${secret}"))`. */
export async function computeDingTalkSign(timestampMs: number, signingKey: string): Promise<string> {
  const raw = await hmacBytes(signingKey, `${timestampMs}\n${signingKey}`);
  return bytesToBase64(raw);
}

export async function buildOutboundWebhookRequest(
  hook: Pick<OutboundWebhookRow, "kind" | "url" | "secretEnc">,
  event: OutboundWebhookEventPayload,
): Promise<{ url: string; headers: Record<string, string>; body: string; feishuCard?: FeishuCardV2 }> {
  const tsMs = event.timestampMs ?? Date.now();
  const tsSec = Math.floor(tsMs / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "Otto-Steward-Webhook/1.0",
  };

  if (hook.kind === "feishu") {
    const feishuCard = renderFeishuCardV2({
      card: event.card,
      ...(event.threadTitle ? { title: event.threadTitle } : {}),
      ...(event.tone ? { tone: event.tone } : {}),
      ...(event.actionLinks ? { actionLinks: event.actionLinks } : {}),
      workspaceUrl: event.workspaceUrl ?? null,
    });
    const payload: Record<string, unknown> = {
      msg_type: "interactive",
      card: feishuCard,
    };
    if (hook.secretEnc) {
      payload.timestamp = String(tsSec);
      payload.sign = await computeFeishuBotSign(tsSec, hook.secretEnc);
    }
    return {
      url: hook.url,
      headers,
      body: JSON.stringify(payload),
      feishuCard,
    };
  }

  if (hook.kind === "dingtalk") {
    let targetUrl = hook.url;
    if (hook.secretEnc) {
      const sign = await computeDingTalkSign(tsMs, hook.secretEnc);
      const u = new URL(targetUrl);
      u.searchParams.set("timestamp", String(tsMs));
      u.searchParams.set("sign", sign);
      targetUrl = u.toString();
    }
    const mdLines = [
      event.card.text,
      ...(event.workspaceUrl ? ["", `[查看详情与操作](${event.workspaceUrl})`] : []),
    ];
    return {
      url: targetUrl,
      headers,
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: {
          title: (event.threadTitle || "Otto 通知").slice(0, 64),
          text: mdLines.join("\n"),
        },
      }),
    };
  }

  if (hook.kind === "wecom") {
    const mdLines = [
      event.card.text,
      ...(event.workspaceUrl ? ["", `[查看详情](${event.workspaceUrl})`] : []),
    ];
    return {
      url: hook.url,
      headers,
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content: mdLines.join("\n").slice(0, 4000) },
      }),
    };
  }

  if (hook.kind === "slack") {
    const text = event.workspaceUrl
      ? `${event.card.text}\n\n<${event.workspaceUrl}|查看详情与操作>`
      : event.card.text;
    return {
      url: hook.url,
      headers,
      body: JSON.stringify({ text }),
    };
  }

  // `generic`: structured JSON + optional HMAC-SHA256 header
  const body = JSON.stringify({
    id: event.id,
    event: event.eventType,
    timestamp: tsSec,
    threadId: event.threadId,
    threadTitle: event.threadTitle ?? null,
    tone: event.tone ?? null,
    text: event.card.text,
    buttons: event.card.buttons ?? [],
    workspaceUrl: event.workspaceUrl ?? null,
  });
  headers["x-otto-event"] = event.eventType;
  headers["x-otto-timestamp"] = String(tsSec);
  if (hook.secretEnc) {
    headers["x-otto-signature-256"] = await computeGenericWebhookSignature(tsSec, hook.secretEnc, body);
  }
  return { url: hook.url, headers, body };
}

export class OutboundWebhookStore {
  constructor(private readonly sql: SqlExecutor) {}

  upsert(input: {
    id: string;
    kind: OutboundWebhookKind;
    url: string;
    secret?: string | null;
    events?: string[];
    enabled?: boolean;
    allowHttpLoopbackForTest?: boolean;
    now?: number;
  }): { ok: true; view: OutboundWebhookView } | { ok: false; reason: string } {
    if (!VALID_KINDS.has(input.kind)) return { ok: false, reason: "invalid_kind" };
    if (!input.id || !/^[A-Za-z0-9._-]{1,64}$/.test(input.id)) return { ok: false, reason: "invalid_id" };
    const validated = validateWebhookTargetUrl(input.url, {
      allowHttpLoopbackForTest: input.allowHttpLoopbackForTest,
    });
    if (!validated.ok) return { ok: false, reason: validated.reason };
    const ts = input.now ?? Date.now();
    const events = Array.isArray(input.events) && input.events.length > 0 ? input.events : ["*"];
    const enabledInt = input.enabled === false ? 0 : 1;
    const secretVal = input.secret !== undefined ? (input.secret?.trim() || null) : null;

    this.sql`
      INSERT INTO sh_outbound_webhook (id, kind, url, secretEnc, eventsJson, enabled, createdAt, updatedAt)
      VALUES (${input.id}, ${input.kind}, ${validated.normalizedUrl}, ${secretVal}, ${JSON.stringify(events)}, ${enabledInt}, ${ts}, ${ts})
      ON CONFLICT (id) DO UPDATE SET
        kind = excluded.kind,
        url = excluded.url,
        secretEnc = CASE WHEN ${input.secret === undefined ? 1 : 0} = 1 THEN sh_outbound_webhook.secretEnc ELSE excluded.secretEnc END,
        eventsJson = excluded.eventsJson,
        enabled = excluded.enabled,
        updatedAt = excluded.updatedAt
    `;
    const row = this.sql<OutboundWebhookRow>`SELECT * FROM sh_outbound_webhook WHERE id = ${input.id}`[0]!;
    return { ok: true, view: this.toView(row) };
  }

  remove(id: string): boolean {
    this.sql`DELETE FROM sh_outbound_webhook WHERE id = ${id}`;
    return (this.sql<{ changes: number }>`SELECT changes() AS changes`[0]?.changes ?? 0) > 0;
  }

  list(): OutboundWebhookView[] {
    return this.sql<OutboundWebhookRow>`SELECT * FROM sh_outbound_webhook ORDER BY createdAt ASC`.map((r) =>
      this.toView(r),
    );
  }

  listEnabledForEvent(eventType: string): OutboundWebhookRow[] {
    const rows = this.sql<OutboundWebhookRow>`SELECT * FROM sh_outbound_webhook WHERE enabled = 1 ORDER BY createdAt ASC`;
    return rows.filter((row) => {
      try {
        const parsed = JSON.parse(row.eventsJson) as unknown;
        if (!Array.isArray(parsed)) return true;
        return parsed.includes("*") || parsed.includes(eventType);
      } catch {
        return true;
      }
    });
  }

  private toView(row: OutboundWebhookRow): OutboundWebhookView {
    let events: string[] = ["*"];
    try {
      const parsed = JSON.parse(row.eventsJson) as unknown;
      if (Array.isArray(parsed)) events = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      events = ["*"];
    }
    return {
      id: row.id,
      kind: row.kind,
      urlMasked: maskUrl(row.url),
      hasSecret: Boolean(row.secretEnc),
      events,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export async function fanOutOutboundWebhooks(options: {
  hooks: readonly OutboundWebhookRow[];
  event: OutboundWebhookEventPayload;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onLog?: (reason: string, detail: string) => void;
}): Promise<{ delivered: number; failed: number }> {
  if (options.hooks.length === 0) return { delivered: 0, failed: 0 };
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let delivered = 0;
  let failed = 0;

  await Promise.all(
    options.hooks.map(async (hook) => {
      try {
        const req = await buildOutboundWebhookRequest(hook, options.event);
        const res = await fetchFn(req.url, {
          method: "POST",
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          delivered += 1;
        } else {
          failed += 1;
          options.onLog?.("outbound_webhook_http_error", `${hook.id} (${hook.kind}) HTTP ${res.status}`);
        }
      } catch (err) {
        failed += 1;
        options.onLog?.(
          "outbound_webhook_failed",
          `${hook.id} (${hook.kind}) ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  return { delivered, failed };
}
