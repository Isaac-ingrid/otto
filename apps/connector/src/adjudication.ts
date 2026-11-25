// Outcome adjudication, docs/design/connector-pi.md §5.2. Pure logic over one run window
// (from the first `agent_start` after a command is accepted to the next `agent_settled`).
//
// Order matters: aborted → error class → reported → unreported. `report` is consulted only
// after 1 and 2: a report earlier in a failed run must not mask the failure.
import type { ErrorClass, ReportPayload, SettledOutcome } from "./agent.ts";

/** Maximum accepted cooldown horizon (8 days, matching agent-autoloop protocol guard). */
export const MAX_COOLDOWN_WINDOW_MS = 8 * 86_400_000;

/** Default cooldown fallback (1 hour) when a subscription/plan usage window is exhausted
 *  without a concrete reset timestamp in the CLI output. */
export const DEFAULT_USAGE_LIMIT_COOLDOWN_MS = 60 * 60_000;

/** Minimum relative wait (2 minutes) for generic 429/rate-limit messages to park on a
 *  cooldown instead of using the 30 s transient retry. */
const MIN_EXPLICIT_RATE_LIMIT_COOLDOWN_MS = 2 * 60_000;

/** Prompt sent for the single-pass report-only rewrite when an agent did tool work and
 *  finished cleanly without calling `report`. */
export const REWRITE_REPORT_PROMPT =
  "You completed the previous turn without calling the `report` tool. Do NOT read or modify any files " +
  "and do NOT run shell commands — immediately call the `report` tool once summarizing what was already " +
  "done, tested, or left open, then stop.";

export interface AssistantFacts {
  stopReason?: string;
  errorMessage?: string;
  text: string;
}

export interface RetryFacts {
  success: boolean;
  finalError?: string;
}

/** Everything adjudication needs from one run window. */
export interface RunWindow {
  aborted: boolean;
  lastAssistant?: AssistantFacts;
  lastRetry?: RetryFacts;
  report?: ReportPayload;
  /** Structured reset timestamp (epoch ms or seconds or ISO) observed on stream events
   *  such as Claude `rate_limit_event` or Codex `rate_limits`. */
  rateLimitResetAt?: number | string | null;
  /** True when the run executed at least one non-report tool/action. */
  hadWork?: boolean;
}

export interface Adjudication {
  outcome: SettledOutcome;
  errorClass?: ErrorClass;
  /** Validated future epoch ms (`nowMs < limitedUntil <= nowMs + 8 days`) for `rate_limited`. */
  limitedUntil?: number;
  report?: ReportPayload;
  /**
   * Only for `error`: what the agent actually said, verbatim and unbounded-by-classification.
   * The class alone ("unknown") told the user nothing — a real "Codex error: The usage limit
   * has been reached" (2026-11-10) reached them as `error:unknown` while the sentence stayed
   * behind in pi's session file. The steward renders this next to the class.
   */
  errorMessage?: string;
  /** Only for `unreported`: handed to the steward for fallback classification. */
  lastText?: string;
}

function parseTimestampCandidate(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // Epoch seconds vs epoch milliseconds heuristic (1e11 ms = 1973, 1e11 s = year 5138).
    return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Enforces `nowMs < ts <= nowMs + 8 days`; returns undefined when invalid or out of range. */
export function normalizeLimitedUntil(
  candidate: number | string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  const ts = parseTimestampCandidate(candidate);
  if (ts === null) return undefined;
  if (ts <= nowMs || ts > nowMs + MAX_COOLDOWN_WINDOW_MS) return undefined;
  return ts;
}

export interface RateLimitExtraction {
  limitedUntil?: number;
  /** True when an explicit reset timestamp was present in structured metadata or prose,
   *  even if it was rejected for being in the past or > 8 days in the future. */
  sawExplicitTimestamp: boolean;
}

/** Extracts a bounded reset epoch-ms from structured CLI fields or provider error messages. */
export function inspectRateLimitReset(
  message: string,
  nowMs = Date.now(),
  explicitResetAt?: number | string | null,
): RateLimitExtraction {
  if (explicitResetAt !== undefined && explicitResetAt !== null && String(explicitResetAt).trim() !== "") {
    const normalized = normalizeLimitedUntil(explicitResetAt, nowMs);
    return { limitedUntil: normalized, sawExplicitTimestamp: true };
  }

  // 1. Explicit ISO-8601 timestamp in prose (e.g. "resets at 2026-11-24T18:00:00Z").
  const isoMatch = message.match(/\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}|\s*UTC)?)\b/i);
  if (isoMatch?.[1]) {
    const rawIso = isoMatch[1].replace(/\s+UTC$/i, "Z").replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T");
    const parsed = parseTimestampCandidate(rawIso);
    if (parsed !== null) {
      return { limitedUntil: normalizeLimitedUntil(parsed, nowMs), sawExplicitTimestamp: true };
    }
  }

  // 2. Keyed unix epoch in JSON/prose (e.g. `"resets_at": 1795543200`, `resetsAt=1795543200000`).
  const epochMatch = message.match(/\b(?:resets?_at|resetsAt|retry_after_ts|limitedUntil)["'=:\s]+(\d{10,13})\b/i);
  if (epochMatch?.[1]) {
    return {
      limitedUntil: normalizeLimitedUntil(Number(epochMatch[1]), nowMs),
      sawExplicitTimestamp: true,
    };
  }

  // 3. Relative duration after reset/retry phrase (e.g. "try again in 2h 15m", "resets in 45 minutes").
  const relMatch = message.match(
    /\b(?:try again in|resets? in|retry after|available in)\s+((?:\d+\s*(?:d|days?|h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\s*)+)/i,
  );
  if (relMatch?.[1]) {
    let deltaMs = 0;
    const tokenRe = /(\d+)\s*(d|days?|h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)/gi;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(relMatch[1])) !== null) {
      const n = Number(m[1]);
      const unit = m[2]!.toLowerCase();
      if (unit.startsWith("d")) deltaMs += n * 86_400_000;
      else if (unit.startsWith("h")) deltaMs += n * 3_600_000;
      else if (unit.startsWith("m")) deltaMs += n * 60_000;
      else deltaMs += n * 1_000;
    }
    if (deltaMs > 0) {
      return {
        limitedUntil: normalizeLimitedUntil(nowMs + deltaMs, nowMs),
        sawExplicitTimestamp: true,
      };
    }
  }

  return { sawExplicitTimestamp: false };
}

export function extractRateLimitResetAt(
  message: string,
  nowMs = Date.now(),
  explicitResetAt?: number | string | null,
): number | undefined {
  return inspectRateLimitReset(message, nowMs, explicitResetAt).limitedUntil;
}

const PERMANENT_AUTH_OR_BILLING_RE =
  /\b401\b|\b403\b|\b402\b|unauthorized|forbidden|invalid api key|api key|insufficient (?:quota|balance|credits?)|out of credits|credit balance|check your plan and billing|billing|payment required/;

const USAGE_WINDOW_LIMIT_RE =
  /usage_limit_reached|usage limit|hit your (?:usage |plan |session )?limit|(?:5-hour|five-hour|session|weekly|daily|rolling|coding plan) limit|limit will reset|quota reset/;

export function adjudicate(window: RunWindow, nowMs = Date.now()): Adjudication {
  // 1. aborted == true → aborted.
  if (window.aborted) return { outcome: "aborted" };

  // 2. Last assistant message in the window has stopReason == "error", or the last
  //    auto_retry_end.success == false → error, classified (research #13: a model call
  //    failure produces no error event, only stopReason/errorMessage on the message).
  const errored = window.lastAssistant?.stopReason === "error" || window.lastRetry?.success === false;
  if (errored) {
    const message = window.lastAssistant?.errorMessage ?? window.lastRetry?.finalError ?? "";
    const resetInfo = inspectRateLimitReset(message, nowMs, window.rateLimitResetAt);
    let errorClass = classifyError(message, {
      nowMs,
      explicitResetAt: window.rateLimitResetAt,
    });
    let limitedUntil: number | undefined;
    if (errorClass === "rate_limited") {
      if (resetInfo.sawExplicitTimestamp) {
        if (resetInfo.limitedUntil !== undefined) {
          limitedUntil = resetInfo.limitedUntil;
        } else {
          // Protocol guard: an invalid/past/>8-day explicit timestamp falls back to ordinary
          // error handling instead of parking the worker for weeks.
          errorClass = "unknown";
        }
      } else {
        limitedUntil = nowMs + DEFAULT_USAGE_LIMIT_COOLDOWN_MS;
      }
    }
    return {
      outcome: "error",
      errorClass,
      ...(limitedUntil !== undefined ? { limitedUntil } : {}),
      ...(message ? { errorMessage: message.slice(0, 4000) } : {}),
    };
  }

  // 3. `report` was called within the window → reported; take the LAST call.
  if (window.report) return { outcome: "reported", report: window.report };

  // 4. Otherwise → unreported: the forced re-report already ran and there is still no
  //    report; hand the last assistant text to the steward for fallback classification.
  return { outcome: "unreported", lastText: window.lastAssistant?.text || undefined };
}

/** Error classification, connector-pi.md §5.2 item 2 + Stage 1 quota/cooldown split. */
export function classifyError(
  message: string,
  options?: { nowMs?: number; explicitResetAt?: number | string | null },
): ErrorClass {
  const msg = message.toLowerCase();
  const nowMs = options?.nowMs ?? Date.now();

  // 1. Permanent credential / billing / prepaid-balance failures: user action required.
  if (PERMANENT_AUTH_OR_BILLING_RE.test(msg)) {
    return "auth";
  }

  // 2. Subscription / Coding-Plan usage window exhausted, or rate-limit carrying an explicit
  //    cooldown reset window (> 2 minutes and <= 8 days).
  const resetInfo = inspectRateLimitReset(message, nowMs, options?.explicitResetAt);
  if (USAGE_WINDOW_LIMIT_RE.test(msg)) {
    if (resetInfo.sawExplicitTimestamp && resetInfo.limitedUntil === undefined) {
      return "unknown";
    }
    return "rate_limited";
  }
  if (
    resetInfo.limitedUntil !== undefined &&
    resetInfo.limitedUntil - nowMs >= MIN_EXPLICIT_RATE_LIMIT_COOLDOWN_MS &&
    /\b429\b|rate.?limit|quota|too many requests|limit/.test(msg)
  ) {
    return "rate_limited";
  }
  // Hard quota exhaustion without a reset window ("exceeded your current quota") remains auth.
  if (/exceeded your current|quota/.test(msg)) {
    return "auth";
  }

  // 3. context: context overflow; suggest a new session with a handoff brief.
  if (/context|token limit|maximum context|context_length|too many tokens|overflow/.test(msg)) return "context";

  // 4. transient (short 429, 5xx, overload, network): one automatic 30 s resume allowed.
  if (/\b429\b|rate.?limit|\b5\d\d\b|overload|network|econn|timeout|timed out|fetch failed|socket/.test(msg)) {
    return "transient";
  }
  return "unknown";
}
