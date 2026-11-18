// Bounded outcome labels for worker closing reports (ADR-0022 decision 2).
// Purely descriptive metadata for deterministic cards, timelines, and Steward wakes —
// labels never trigger dispatch, Thread state transitions, or archiving.

export const REPORT_LABEL_VOCABULARY = [
  "blocked-by-env",
  "needs-human-verify",
  "flaky-test",
  "needs-migration",
  "scope-creep",
] as const;

export type ReportLabel = (typeof REPORT_LABEL_VOCABULARY)[number];

export const MAX_REPORT_LABELS = 3;
export const REPORT_LABEL_RE = /^[a-z0-9-]{1,32}$/;

const REPORT_LABEL_SET: ReadonlySet<string> = new Set(REPORT_LABEL_VOCABULARY);

export interface NormalizedReportLabels {
  /** `undefined` when omitted (persists as NULL); `[]` when explicitly empty or all entries dropped. */
  labels: ReportLabel[] | undefined;
  /** Bounded diagnostic tokens for unknown, malformed, or excess (>3) entries dropped at the boundary. */
  dropped: string[];
}

function formatDroppedToken(value: unknown): string {
  if (typeof value === "string") {
    const clean = value.replace(/[\r\n\t]+/g, " ").trim();
    return clean.length === 0 ? "<empty>" : clean.slice(0, 40);
  }
  return `<${typeof value}>`;
}

/**
 * Normalizes optional `report.labels`:
 * - `undefined` / `null` → `{ labels: undefined, dropped: [] }` (maps to SQL NULL)
 * - non-array → `{ labels: undefined, dropped: ["<type>"] }`
 * - `string[]` → deduplicated in order, unknown/malformed items dropped, capped at 3.
 */
export function normalizeReportLabels(raw: unknown): NormalizedReportLabels {
  if (raw === undefined || raw === null) {
    return { labels: undefined, dropped: [] };
  }
  if (!Array.isArray(raw)) {
    return { labels: undefined, dropped: [formatDroppedToken(raw)] };
  }
  const labels: ReportLabel[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !REPORT_LABEL_RE.test(item) || !REPORT_LABEL_SET.has(item)) {
      dropped.push(formatDroppedToken(item));
      continue;
    }
    if (seen.has(item)) continue;
    seen.add(item);
    if (labels.length >= MAX_REPORT_LABELS) {
      dropped.push(item);
      continue;
    }
    labels.push(item as ReportLabel);
  }
  return { labels, dropped };
}
