import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_LABELS,
  REPORT_LABEL_RE,
  REPORT_LABEL_VOCABULARY,
  normalizeReportLabels,
} from "../src/index.ts";

describe("report outcome labels contract (ADR-0022 decision 2)", () => {
  it("pins the 5-label controlled vocabulary, regex, and max-3 cap", () => {
    expect(REPORT_LABEL_VOCABULARY).toEqual([
      "blocked-by-env",
      "needs-human-verify",
      "flaky-test",
      "needs-migration",
      "scope-creep",
    ]);
    expect(MAX_REPORT_LABELS).toBe(3);
    for (const label of REPORT_LABEL_VOCABULARY) {
      expect(REPORT_LABEL_RE.test(label)).toBe(true);
    }
  });

  it("distinguishes omitted (undefined/null -> undefined) from explicit empty array ([] -> [])", () => {
    expect(normalizeReportLabels(undefined)).toEqual({ labels: undefined, dropped: [] });
    expect(normalizeReportLabels(null)).toEqual({ labels: undefined, dropped: [] });
    expect(normalizeReportLabels([])).toEqual({ labels: [], dropped: [] });
  });

  it("deduplicates in order before applying the max-3 cap", () => {
    expect(
      normalizeReportLabels([
        "blocked-by-env",
        "flaky-test",
        "blocked-by-env",
        "needs-migration",
        "scope-creep",
      ]),
    ).toEqual({
      labels: ["blocked-by-env", "flaky-test", "needs-migration"],
      dropped: ["scope-creep"],
    });
  });

  it("strips unknown, malformed, and non-string items while recording bounded diagnostic tokens", () => {
    expect(
      normalizeReportLabels([
        "ready-for-review",
        "Blocked-By-Env",
        "",
        "a".repeat(33),
        42,
        "needs-human-verify",
      ]),
    ).toEqual({
      labels: ["needs-human-verify"],
      dropped: ["ready-for-review", "Blocked-By-Env", "<empty>", "a".repeat(33), "<number>"],
    });
    expect(normalizeReportLabels("blocked-by-env")).toEqual({
      labels: undefined,
      dropped: ["blocked-by-env"],
    });
  });
});
