import { describe, expect, it } from "vitest";
import {
  adjudicate,
  classifyError,
  DEFAULT_USAGE_LIMIT_COOLDOWN_MS,
  extractRateLimitResetAt,
  MAX_COOLDOWN_WINDOW_MS,
  normalizeLimitedUntil,
} from "../src/adjudication.ts";

const report = { status: "done" as const, summary: "fixed" };

describe("adjudicate (connector-pi.md §5.2 order)", () => {
  it("1. aborted wins over everything, including errors and reports", () => {
    expect(
      adjudicate({
        aborted: true,
        lastAssistant: { stopReason: "error", errorMessage: "403", text: "" },
        report,
      }),
    ).toEqual({ outcome: "aborted" });
  });

  it("2. last assistant stopReason error → error with class", () => {
    const result = adjudicate({
      aborted: false,
      lastAssistant: { stopReason: "error", errorMessage: "403 Unauthorized", text: "" },
      report,
    });
    expect(result.outcome).toBe("error");
    expect(result.errorClass).toBe("auth");
    // A report earlier in the failed run must not mask the failure.
    expect(result.report).toBeUndefined();
  });

  it("2b. last auto_retry_end success=false → error, classified from finalError", () => {
    const result = adjudicate({ aborted: false, lastRetry: { success: false, finalError: "529 overloaded" } });
    expect(result).toEqual({ outcome: "error", errorClass: "transient", errorMessage: "529 overloaded" });
  });

  it("2c. usage-window exhaustion settles error:rate_limited with +1h fallback when no timestamp is given", () => {
    const nowMs = Date.parse("2026-11-24T12:00:00Z");
    const result = adjudicate(
      {
        aborted: false,
        lastAssistant: {
          stopReason: "error",
          errorMessage: "Codex error: The usage limit has been reached",
          text: "",
        },
      },
      nowMs,
    );
    expect(result).toEqual({
      outcome: "error",
      errorClass: "rate_limited",
      limitedUntil: nowMs + DEFAULT_USAGE_LIMIT_COOLDOWN_MS,
      errorMessage: "Codex error: The usage limit has been reached",
    });
    // No message at all (a silent stop) must not invent one.
    expect(adjudicate({ aborted: false, lastAssistant: { stopReason: "error", text: "" } }, nowMs)).toEqual({
      outcome: "error",
      errorClass: "unknown",
    });
  });

  it("2d. honors structured rateLimitResetAt within 8 days and falls back to ordinary error when > 8 days or past", () => {
    const nowMs = Date.parse("2026-11-24T12:00:00Z");
    const twoHoursSec = Math.floor((nowMs + 2 * 3_600_000) / 1000);
    expect(
      adjudicate(
        {
          aborted: false,
          rateLimitResetAt: twoHoursSec,
          lastAssistant: { stopReason: "error", errorMessage: "Claude usage limit reached", text: "" },
        },
        nowMs,
      ),
    ).toEqual({
      outcome: "error",
      errorClass: "rate_limited",
      limitedUntil: twoHoursSec * 1000,
      errorMessage: "Claude usage limit reached",
    });

    // > 8 days ahead: protocol guard rejects distant timestamp and falls back to ordinary error.
    const tenDaysMs = nowMs + 10 * 86_400_000;
    expect(
      adjudicate(
        {
          aborted: false,
          rateLimitResetAt: tenDaysMs,
          lastAssistant: { stopReason: "error", errorMessage: "Claude usage limit reached", text: "" },
        },
        nowMs,
      ),
    ).toEqual({
      outcome: "error",
      errorClass: "unknown",
      errorMessage: "Claude usage limit reached",
    });
  });

  it('preserves a real model-not-found failure and does not let an earlier done report mask it', () => {
    const message = '404: {"message":"模型不存在","type":"model_not_found","code":"model_not_found"}';
    expect(adjudicate({ aborted: false, lastAssistant: { stopReason: 'error', errorMessage: message, text: '' }, report })).toEqual({ outcome: 'error', errorClass: 'unknown', errorMessage: message });
  });

  it("3. report called in the window → reported", () => {
    expect(adjudicate({ aborted: false, report })).toEqual({ outcome: "reported", report });
  });

  it("4. otherwise → unreported with the last assistant text", () => {
    expect(adjudicate({ aborted: false, lastAssistant: { stopReason: "stop", text: "Is it on main?" } })).toEqual({
      outcome: "unreported",
      lastText: "Is it on main?",
    });
    expect(adjudicate({ aborted: false })).toEqual({ outcome: "unreported" });
  });
});

describe("classifyError & extractRateLimitResetAt (§5.2 + Stage 1 cooldown)", () => {
  const nowMs = Date.parse("2026-11-24T12:00:00Z");

  it.each([
    ["401 Unauthorized", "auth"],
    ["403 forbidden", "auth"],
    ["Invalid API key provided", "auth"],
    ["429 Too Many Requests", "transient"],
    ["503 Service Unavailable", "transient"],
    ["529 overloaded", "transient"],
    ["network error: ECONNRESET", "transient"],
    ["request timed out", "transient"],
    ["context length exceeded", "context"],
    ["maximum context length is 128000 tokens", "context"],
    // Subscription / Coding Plan rolling window exhaustion → rate_limited cooldown:
    ["Codex error: The usage limit has been reached", "rate_limited"],
    ["usage_limit_reached: Coding Plan 5-hour limit reached", "rate_limited"],
    ["429 rate_limit_error: resets at 2026-11-24T15:30:00Z", "rate_limited"],
    ["Rate limit reached, try again in 45m", "rate_limited"],
    // Hard prepaid/billing stops stay auth:
    ["You exceeded your current quota, please check your plan and billing details", "auth"],
    ["Your credit balance is too low to access the API", "auth"],
    ["insufficient quota", "auth"],
    ["402 payment required", "auth"],
    ['404: {"message":"模型不存在","code":"model_not_found"}', 'unknown'],
    ["something odd happened", "unknown"],
  ])("%s → %s", (message, expected) => {
    expect(classifyError(message, { nowMs })).toBe(expected);
  });

  it("extracts ISO, epoch-seconds, and relative reset timestamps within the 8-day ceiling", () => {
    expect(extractRateLimitResetAt("resets at 2026-11-24T15:30:00Z", nowMs)).toBe(
      Date.parse("2026-11-24T15:30:00Z"),
    );
    expect(extractRateLimitResetAt("try again in 2h 15m", nowMs)).toBe(
      nowMs + (2 * 60 + 15) * 60_000,
    );
    expect(normalizeLimitedUntil(nowMs + MAX_COOLDOWN_WINDOW_MS, nowMs)).toBe(
      nowMs + MAX_COOLDOWN_WINDOW_MS,
    );
    expect(normalizeLimitedUntil(nowMs + MAX_COOLDOWN_WINDOW_MS + 1, nowMs)).toBeUndefined();
    expect(normalizeLimitedUntil(nowMs, nowMs)).toBeUndefined();
  });
});
