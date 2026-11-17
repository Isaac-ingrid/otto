import { describe, expect, it } from "vitest";
import { adjudicate, classifyError } from "../src/adjudication.ts";

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

  it("2c. the agent's own error text rides the settled event (the class alone is undiagnosable)", () => {
    const result = adjudicate({
      aborted: false,
      lastAssistant: {
        stopReason: "error",
        errorMessage: "Codex error: The usage limit has been reached",
        text: "",
      },
    });
    expect(result.outcome).toBe("error");
    expect(result.errorMessage).toBe("Codex error: The usage limit has been reached");
    // No message at all (a silent stop) must not invent one.
    expect(adjudicate({ aborted: false, lastAssistant: { stopReason: "error", text: "" } })).toEqual({
      outcome: "error",
      errorClass: "unknown",
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

describe("classifyError (§5.2 item 2)", () => {
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
    // Quota is an auth-class stop: no retry can succeed, the fix is on that machine.
    ["Codex error: The usage limit has been reached", "auth"],
    ["You exceeded your current quota, please check your plan and billing details", "auth"],
    ["Your credit balance is too low to access the API", "auth"],
    ["insufficient quota", "auth"],
    ["402 payment required", "auth"],
    ['404: {"message":"模型不存在","code":"model_not_found"}', 'unknown'],
    ["something odd happened", "unknown"],
  ])("%s → %s", (message, expected) => {
    expect(classifyError(message)).toBe(expected);
  });
});
