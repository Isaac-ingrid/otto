// GitHub evidence reader: fixed origin, GET only, no redirects on metadata, no model or shell.
import { escapeMarkers } from "./wake-text.ts";

export type PrEvidenceMode = "checks-and-statuses" | "statuses-only";
export type PrWatchGoal = "ci_pass" | "merged";
export type PrMergeState = "mergeable" | "conflicted" | "unknown";
export type PrReviewDecision = "changes_requested" | "approved" | "commented" | "none";

export interface PrTarget { owner: string; repo: string; number: number; url: string }
export interface PrEvidence {
  head: string;
  state: "waiting" | "failure" | "success" | "closed" | "merged";
  checks: number;
  failed: number;
  pending: number;
  mergeState?: PrMergeState;
  baseRef?: string;
  baseSha?: string;
  headRef?: string;
}
export type EvidenceResult = { ok: true; evidence: PrEvidence } | { ok: false; reason: string };

export type PrFailureLogSource =
  | "actions_logs"
  | "checks_annotations"
  | "checks_summary"
  | "statuses_only";

export interface PrFailureAnnotation {
  path: string;
  line: number;
  title: string | null;
  message: string;
}

export interface PrFailedItemSnapshot {
  kind: "check_run" | "commit_status";
  name: string;
  conclusion: string;
  url: string | null;
  appSlug?: string | null;
  failedStep?: string | null;
  summaryText?: string | null;
  annotations: PrFailureAnnotation[];
  logExcerpt?: string | null;
}

export interface PrFailureSnapshot {
  head: string;
  capturedAt: number;
  evidenceMode: PrEvidenceMode;
  logSource: PrFailureLogSource;
  logNote?: string | null;
  totalFailed: number;
  items: PrFailedItemSnapshot[];
}

export const MAX_JOB_LOG_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_BYTES = 16 * 1024;
const MAX_EXCERPT_CHARS = 2_400;
const FAILED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "stale",
  "startup_failure",
]);

export function parsePrUrl(value: unknown): PrTarget | null {
  if (typeof value !== "string") return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,8})\/?$/.exec(value);
  if (!match || [".", ".."].includes(match[2]!)) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` };
}

class EvidenceError extends Error {}
type Pull = {
  head: { sha: string; ref?: unknown };
  base?: { sha?: unknown; ref?: unknown };
  user?: { login?: unknown } | null;
  state: string;
  merged: boolean;
  mergeable?: unknown;
  mergeable_state?: unknown;
};
function pullOf(raw: unknown): Pull {
  const p = raw as Partial<Pull> | null;
  if (!p || !/^[a-f0-9]{40}$/i.test(p.head?.sha ?? "") || !["open", "closed"].includes(p.state ?? "") || typeof p.merged !== "boolean") throw new EvidenceError("invalid_pull_response");
  return p as Pull;
}

export function derivePrMergeState(mergeable: unknown, mergeableState: unknown): PrMergeState | undefined {
  if (mergeable === false || mergeableState === "dirty") return "conflicted";
  if (mergeable === true) return "mergeable";
  if (mergeable === null || typeof mergeableState === "string") return "unknown";
  return undefined;
}

function extractPullBranches(pull: Pull, token?: string): {
  mergeState?: PrMergeState;
  baseRef?: string;
  baseSha?: string;
  headRef?: string;
} {
  const mergeState = derivePrMergeState(pull.mergeable, pull.mergeable_state);
  const baseRef =
    typeof pull.base?.ref === "string" && pull.base.ref.trim()
      ? sanitizeUntrustedCiText(pull.base.ref, { ...(token ? { token } : {}), maxChars: 120 })
      : undefined;
  const baseSha =
    typeof pull.base?.sha === "string" && /^[a-f0-9]{40}$/i.test(pull.base.sha)
      ? pull.base.sha.toLowerCase()
      : undefined;
  const headRef =
    typeof pull.head?.ref === "string" && pull.head.ref.trim()
      ? sanitizeUntrustedCiText(pull.head.ref, { ...(token ? { token } : {}), maxChars: 120 })
      : undefined;
  return {
    ...(mergeState !== undefined ? { mergeState } : {}),
    ...(baseRef ? { baseRef } : {}),
    ...(baseSha ? { baseSha } : {}),
    ...(headRef ? { headRef } : {}),
  };
}

export async function readPrEvidence(target: PrTarget, options: { token?: string; fetch?: typeof fetch; mode?: PrEvidenceMode } = {}): Promise<EvidenceResult> {
  const mode = options.mode ?? "checks-and-statuses";
  if (mode !== "checks-and-statuses" && mode !== "statuses-only") return { ok: false, reason: "invalid_evidence_mode" };
  const canonical = parsePrUrl(target.url);
  if (!canonical || canonical.owner !== target.owner || canonical.repo !== target.repo || canonical.number !== target.number) return { ok: false, reason: "invalid_target" };
  const send = options.fetch ?? fetch;
  const path = `/repos/${target.owner}/${target.repo}`;
  const signal = AbortSignal.timeout(20_000); // entire observation, not 20s per request
  const get = async (suffix: string): Promise<unknown> => {
    const response = await send(`https://api.github.com${path}${suffix}`, {
      method: "GET", redirect: "error", signal,
      headers: { accept: "application/vnd.github+json", "user-agent": "Otto-PR-Watch", "x-github-api-version": "2022-11-28",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    });
    if (!response.ok) { await response.body?.cancel(); throw new EvidenceError(`github_http_${response.status}`); }
    // Bound response consumption; do not store/forward raw provider content or error bodies.
    const reader = response.body?.getReader();
    if (!reader) throw new EvidenceError("empty_response");
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new EvidenceError("response_too_large"); }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  try {
    const first = pullOf(await get(`/pulls/${target.number}`));
    if (first.state === "closed") return { ok: true, evidence: { head: first.head.sha, state: first.merged ? "merged" : "closed", checks: 0, failed: 0, pending: 0 } };
    const sha = first.head.sha;
    let checkRuns: Array<{ head_sha?: string; status?: string; conclusion?: string | null }> = [];
    if (mode === "checks-and-statuses") {
      const raw = await get(`/commits/${sha}/check-runs?filter=latest&per_page=100`) as { total_count?: number; check_runs?: typeof checkRuns };
      if (!raw || !Array.isArray(raw.check_runs) || !Number.isInteger(raw.total_count) || raw.total_count !== raw.check_runs.length) throw new EvidenceError("incomplete_checks");
      checkRuns = raw.check_runs;
    }
    const statusesRaw = await get(`/commits/${sha}/status?per_page=100`) as { total_count?: number; statuses?: Array<{ state?: string }>; sha?: string };
    if (!statusesRaw || statusesRaw.sha !== sha || !Array.isArray(statusesRaw.statuses) || !Number.isInteger(statusesRaw.total_count) || statusesRaw.total_count !== statusesRaw.statuses.length) {
      throw new EvidenceError("incomplete_checks"); // includes truncation/pagination: never infer green
    }
    let failed = 0;
    let pending = 0;
    for (const check of checkRuns) {
      if (!check || check.head_sha !== sha || !["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(check.status ?? "")) throw new EvidenceError("invalid_check_response");
      if (check.status !== "completed") pending++;
      else if (FAILED_CHECK_CONCLUSIONS.has(check.conclusion ?? "")) failed++;
      else if (!["success", "neutral", "skipped"].includes(check.conclusion ?? "")) throw new EvidenceError("invalid_check_conclusion");
    }
    for (const status of statusesRaw.statuses) {
      if (status?.state === "pending") pending++;
      else if (status?.state === "failure" || status?.state === "error") failed++;
      else if (status?.state !== "success") throw new EvidenceError("invalid_status_response");
    }
    // PR may acquire a new head or close while checks are fetched. Never apply old-head evidence.
    const final = pullOf(await get(`/pulls/${target.number}`));
    if (final.head.sha !== sha || final.state !== first.state || final.merged !== first.merged) throw new EvidenceError("pr_changed_during_check");
    const checks = checkRuns.length + statusesRaw.statuses.length;
    // All-neutral/skipped is not a green build. At least one real success is required.
    const successful = checkRuns.some(c => c.status === "completed" && c.conclusion === "success") || statusesRaw.statuses.some(s => s.state === "success");
    const pullMeta = extractPullBranches(final, options.token);
    return {
      ok: true,
      evidence: {
        head: sha,
        state: failed ? "failure" : pending || !successful ? "waiting" : "success",
        checks,
        failed,
        pending,
        ...pullMeta,
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof EvidenceError ? error.message : "github_unavailable" };
  }
}

// ---- Stage 1: Bounded Read-Only CI Failure Evidence & Log Reader --------------------------------

const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_SINGLE_RE = /\x1b[@-_]/g;
const CTRL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const ACTIONS_TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z[ \t]+/gm;

const ERROR_ANCHOR_RE =
  /(?:\bFAIL\b|\bFAILED\b|\bERROR\b|Error:|ERR_[A-Z0-9_]+|AssertionError|TypeError|ReferenceError|SyntaxError|TS\d{4,5}:|ELIFECYCLE|exit code [1-9]|Process completed with exit code [1-9]|##\[error\])/;

/** Strict allowlist for GitHub Actions signed log storage redirect targets. */
export function isAllowedActionsLogUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const isActionsHost =
    host.endsWith(".actions.githubusercontent.com") &&
    host.length > ".actions.githubusercontent.com".length;
  const isAzureBlobHost =
    host.endsWith(".blob.core.windows.net") &&
    host.length > ".blob.core.windows.net".length;
  return isActionsHost || isAzureBlobHost;
}

/** Strips ANSI escapes, control chars, known secret shapes, literal read token, and ⟦...⟧ markers. */
export function sanitizeUntrustedCiText(
  raw: string,
  opts: { token?: string; maxChars?: number; preserveNewlines?: boolean } = {},
): string {
  const maxChars = opts.maxChars ?? 600;
  const preserveNewlines = opts.preserveNewlines ?? false;
  let cleaned = raw
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_SINGLE_RE, "")
    .replace(CTRL_CHARS_RE, "");

  if (opts.token && opts.token.length >= 4) {
    cleaned = cleaned.replaceAll(opts.token, "[REDACTED]");
  }

  cleaned = cleaned
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bAQ\.[A-Za-z0-9._-]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|secret)\s*([:=])\s*(["']?)[A-Za-z0-9._~+/-]{8,}\3/gi,
      "$1$2[REDACTED]",
    );

  cleaned = escapeMarkers(cleaned);
  if (!preserveNewlines) {
    cleaned = cleaned.replace(/[\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  } else {
    cleaned = cleaned
      .replace(ACTIONS_TS_PREFIX_RE, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return cleaned.length > maxChars ? `${cleaned.slice(0, Math.max(0, maxChars - 1))}…` : cleaned;
}

function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 500) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
    return escapeMarkers(parsed.toString());
  } catch {
    return null;
  }
}

function extractLogExcerpt(rawLog: string, opts: { token?: string; maxChars?: number }): { excerpt: string | null; hadAnchor: boolean } {
  const cleaned = sanitizeUntrustedCiText(rawLog, {
    ...(opts.token ? { token: opts.token } : {}),
    maxChars: MAX_JOB_LOG_BYTES,
    preserveNewlines: true,
  });
  if (!cleaned) return { excerpt: null, hadAnchor: false };
  const lines = cleaned
    .split("\n")
    .map((line) => (line.length > 260 ? `${line.slice(0, 259)}…` : line))
    .filter((line) => line.trim().length > 0 && !/^##\[(group|endgroup)\]/.test(line.trim()));
  if (lines.length === 0) return { excerpt: null, hadAnchor: false };

  const anchorIdx = lines.findIndex((line) => ERROR_ANCHOR_RE.test(line));
  const tailStart = Math.max(0, lines.length - 30);
  let selected: string[];
  if (anchorIdx >= 0) {
    const anchorStart = Math.max(0, anchorIdx - 3);
    const anchorEnd = Math.min(lines.length, anchorIdx + 18);
    if (anchorEnd >= tailStart) {
      selected = lines.slice(anchorStart);
    } else {
      selected = [...lines.slice(anchorStart, anchorEnd), "…", ...lines.slice(tailStart)];
    }
  } else {
    selected = lines.slice(Math.max(0, lines.length - 35));
  }

  const maxChars = opts.maxChars ?? MAX_EXCERPT_CHARS;
  const joined = selected.join("\n").trim();
  if (!joined) return { excerpt: null, hadAnchor: anchorIdx >= 0 };
  const excerpt = joined.length > maxChars ? `…${joined.slice(joined.length - (maxChars - 1))}` : joined;
  return { excerpt, hadAnchor: anchorIdx >= 0 };
}

async function readStreamBounded(
  response: Response,
  maxBytes: number,
  mode: "strict" | "truncate",
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      if (mode === "strict") {
        await reader.cancel();
        throw new EvidenceError("response_too_large");
      }
      const remain = maxBytes - size;
      if (remain > 0) {
        parts.push(value.subarray(0, remain));
        size += remain;
      }
      truncated = true;
      await reader.cancel();
      break;
    }
    parts.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, truncated };
}

function enforceSnapshotBudget(snapshot: PrFailureSnapshot): PrFailureSnapshot {
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify(snapshot)).byteLength <= MAX_SNAPSHOT_BYTES) return snapshot;
  const trimmed: PrFailureSnapshot = {
    ...snapshot,
    items: snapshot.items.map((item) => ({
      ...item,
      ...(item.logExcerpt ? { logExcerpt: item.logExcerpt.slice(-900) } : {}),
      ...(item.summaryText ? { summaryText: item.summaryText.slice(0, 280) } : {}),
      annotations: item.annotations.slice(0, 4).map((a) => ({ ...a, message: a.message.slice(0, 200) })),
    })),
  };
  if (encoder.encode(JSON.stringify(trimmed)).byteLength <= MAX_SNAPSHOT_BYTES) return trimmed;
  return {
    ...trimmed,
    items: trimmed.items.slice(0, 3).map((item) => ({
      ...item,
      logExcerpt: item.logExcerpt ? item.logExcerpt.slice(-400) : null,
      summaryText: item.summaryText ? item.summaryText.slice(0, 160) : null,
      annotations: item.annotations.slice(0, 2),
    })),
  };
}

interface RawCheckRun {
  id?: unknown;
  head_sha?: unknown;
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  details_url?: unknown;
  app?: { slug?: unknown } | null;
  output?: {
    title?: unknown;
    summary?: unknown;
    text?: unknown;
    annotations_count?: unknown;
  } | null;
}

interface RawCommitStatus {
  context?: unknown;
  state?: unknown;
  description?: unknown;
  target_url?: unknown;
}

/**
 * Reads bounded, sanitized failure details for a specific commit SHA.
 * - Never throws; returns `null` when unavailable or no failed items exist on `sha`.
 * - `statuses-only` never touches `/check-runs` or `/actions/jobs`.
 * - `GET /actions/jobs/{id}/logs` uses `redirect: "manual"`, validates the `302` Location
 *   against `isAllowedActionsLogUrl`, and strips `Authorization` / `Cookie` on the second GET.
 */
export async function readPrFailureDetail(
  target: PrTarget,
  sha: string,
  options: {
    token?: string;
    fetch?: typeof fetch;
    mode?: PrEvidenceMode;
    now?: () => number;
  } = {},
): Promise<PrFailureSnapshot | null> {
  const mode = options.mode ?? "checks-and-statuses";
  if (mode !== "checks-and-statuses" && mode !== "statuses-only") return null;
  const canonical = parsePrUrl(target.url);
  if (
    !canonical ||
    canonical.owner !== target.owner ||
    canonical.repo !== target.repo ||
    canonical.number !== target.number ||
    !/^[a-f0-9]{40}$/i.test(sha)
  ) {
    return null;
  }

  const send = options.fetch ?? fetch;
  const token = options.token;
  const repoPath = `/repos/${target.owner}/${target.repo}`;
  const signal = AbortSignal.timeout(10_000);
  const apiHeaders: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "Otto-PR-Watch",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  const getApiJson = async (suffix: string): Promise<{ ok: true; data: unknown } | { ok: false; status: number }> => {
    const response = await send(`https://api.github.com${repoPath}${suffix}`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: apiHeaders,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status };
    }
    const { bytes } = await readStreamBounded(response, 2 * 1024 * 1024, "strict");
    return { ok: true, data: JSON.parse(new TextDecoder().decode(bytes)) };
  };

  try {
    let failedChecks: RawCheckRun[] = [];
    if (mode === "checks-and-statuses") {
      const checksRes = await getApiJson(`/commits/${sha}/check-runs?filter=latest&per_page=100`);
      if (!checksRes.ok) return null;
      const raw = checksRes.data as { check_runs?: unknown };
      if (!raw || !Array.isArray(raw.check_runs)) return null;
      for (const c of raw.check_runs as RawCheckRun[]) {
        if (!c || c.head_sha !== sha) return null;
        if (c.status === "completed" && typeof c.conclusion === "string" && FAILED_CHECK_CONCLUSIONS.has(c.conclusion)) {
          failedChecks.push(c);
        }
      }
    }

    const statusRes = await getApiJson(`/commits/${sha}/status?per_page=100`);
    if (!statusRes.ok) return null;
    const statusRaw = statusRes.data as { sha?: unknown; statuses?: unknown };
    if (!statusRaw || statusRaw.sha !== sha || !Array.isArray(statusRaw.statuses)) return null;
    const failedStatuses = (statusRaw.statuses as RawCommitStatus[]).filter(
      (s) => s && (s.state === "failure" || s.state === "error"),
    );

    const totalFailed = failedChecks.length + failedStatuses.length;
    if (totalFailed === 0) return null;

    if (mode === "statuses-only") {
      const items: PrFailedItemSnapshot[] = failedStatuses.slice(0, 5).map((s) => ({
        kind: "commit_status",
        name: sanitizeUntrustedCiText(typeof s.context === "string" && s.context.trim() ? s.context : "commit-status", {
          ...(token ? { token } : {}),
          maxChars: 120,
        }),
        conclusion: s.state === "error" ? "error" : "failure",
        url: safeHttpsUrl(s.target_url),
        summaryText:
          typeof s.description === "string" && s.description.trim()
            ? sanitizeUntrustedCiText(s.description, { ...(token ? { token } : {}), maxChars: 400 })
            : null,
        annotations: [],
      }));
      return enforceSnapshotBudget({
        head: sha,
        capturedAt: options.now?.() ?? Date.now(),
        evidenceMode: mode,
        logSource: "statuses_only",
        totalFailed,
        items,
      });
    }

    const items: PrFailedItemSnapshot[] = [];
    let logNote: string | null = null;
    let annotationsFetched = 0;
    let actionsJobsFetched = 0;
    let anyActionsLogs = false;
    let anyChecksDetail = false;

    for (const check of failedChecks.slice(0, 5)) {
      const checkId = typeof check.id === "number" && Number.isSafeInteger(check.id) && check.id > 0 ? check.id : null;
      const appSlug =
        typeof check.app?.slug === "string" && /^[a-z0-9-]{1,64}$/i.test(check.app.slug) ? check.app.slug : null;
      const name = sanitizeUntrustedCiText(
        typeof check.name === "string" && check.name.trim() ? check.name : "check-run",
        { ...(token ? { token } : {}), maxChars: 120 },
      );
      const conclusion = typeof check.conclusion === "string" ? check.conclusion : "failure";
      const url = safeHttpsUrl(check.html_url) ?? safeHttpsUrl(check.details_url);

      const summaryParts = [check.output?.title, check.output?.summary, check.output?.text]
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v) => v.trim());
      const summaryText =
        summaryParts.length > 0
          ? sanitizeUntrustedCiText(summaryParts.join(" — "), { ...(token ? { token } : {}), maxChars: 500 })
          : null;
      if (summaryText) anyChecksDetail = true;

      const annotations: PrFailureAnnotation[] = [];
      const declaredAnnCount =
        typeof check.output?.annotations_count === "number" ? check.output.annotations_count : undefined;
      if (checkId !== null && annotationsFetched < 3 && (declaredAnnCount === undefined || declaredAnnCount > 0)) {
        annotationsFetched += 1;
        try {
          const annRes = await getApiJson(`/check-runs/${checkId}/annotations?per_page=20`);
          if (annRes.ok && Array.isArray(annRes.data)) {
            for (const rawAnn of annRes.data as Array<Record<string, unknown>>) {
              if (!rawAnn || rawAnn.annotation_level !== "failure") continue;
              const message =
                typeof rawAnn.message === "string" && rawAnn.message.trim()
                  ? sanitizeUntrustedCiText(rawAnn.message, { ...(token ? { token } : {}), maxChars: 360 })
                  : "";
              if (!message) continue;
              const path =
                typeof rawAnn.path === "string" && rawAnn.path.trim()
                  ? sanitizeUntrustedCiText(rawAnn.path, { ...(token ? { token } : {}), maxChars: 180 })
                  : "unknown";
              const line =
                typeof rawAnn.start_line === "number" && Number.isInteger(rawAnn.start_line) && rawAnn.start_line > 0
                  ? rawAnn.start_line
                  : 1;
              const title =
                typeof rawAnn.title === "string" && rawAnn.title.trim()
                  ? sanitizeUntrustedCiText(rawAnn.title, { ...(token ? { token } : {}), maxChars: 120 })
                  : null;
              annotations.push({ path, line, title, message });
              if (annotations.length >= 6) break;
            }
          }
        } catch {
          // Annotation fetch failure never fails snapshot assembly.
        }
      }
      if (annotations.length > 0) anyChecksDetail = true;

      let failedStep: string | null = null;
      let logExcerpt: string | null = null;
      const isGithubActions =
        appSlug === "github-actions" ||
        (appSlug === null && typeof url === "string" && /\/actions\/runs\/\d+\/job\/\d+/.test(url));

      if (checkId !== null && isGithubActions && actionsJobsFetched < 2) {
        actionsJobsFetched += 1;
        let jobMatchesSha = false;
        try {
          const jobRes = await getApiJson(`/actions/jobs/${checkId}`);
          if (!jobRes.ok) {
            logNote ??= `actions_job_http_${jobRes.status}`;
          } else {
            const job = jobRes.data as {
              head_sha?: unknown;
              steps?: Array<{ name?: unknown; conclusion?: unknown }>;
            } | null;
            if (!job || job.head_sha !== sha) {
              logNote = "actions_job_sha_mismatch";
            } else {
              jobMatchesSha = true;
              if (Array.isArray(job.steps)) {
                const badStep = job.steps.find(
                  (st) => st && (st.conclusion === "failure" || st.conclusion === "timed_out"),
                );
                if (badStep && typeof badStep.name === "string" && badStep.name.trim()) {
                  failedStep = sanitizeUntrustedCiText(badStep.name, { ...(token ? { token } : {}), maxChars: 140 });
                }
              }
            }
          }
        } catch {
          logNote ??= "actions_job_unavailable";
        }

        if (jobMatchesSha) {
          try {
            const logInitRes = await send(`https://api.github.com${repoPath}/actions/jobs/${checkId}/logs`, {
              method: "GET",
              redirect: "manual",
              signal,
              headers: apiHeaders,
            });
            if (logInitRes.status >= 300 && logInitRes.status < 400) {
              await logInitRes.body?.cancel();
              const location = logInitRes.headers.get("location") ?? "";
              if (!isAllowedActionsLogUrl(location)) {
                logNote = "actions_logs_disallowed_redirect";
              } else {
                // CRITICAL SECURITY INVARIANT: strip Authorization and Cookie on cross-origin log storage GET.
                const logBlobRes = await send(location, {
                  method: "GET",
                  redirect: "error",
                  signal,
                  headers: { "user-agent": "Otto-PR-Watch" },
                });
                if (!logBlobRes.ok) {
                  await logBlobRes.body?.cancel();
                  logNote ??= `actions_logs_blob_http_${logBlobRes.status}`;
                } else {
                  const { bytes, truncated } = await readStreamBounded(logBlobRes, MAX_JOB_LOG_BYTES, "truncate");
                  if (truncated) logNote ??= "actions_logs_truncated_256k";
                  const extracted = extractLogExcerpt(new TextDecoder().decode(bytes), {
                    ...(token ? { token } : {}),
                    maxChars: MAX_EXCERPT_CHARS,
                  });
                  logExcerpt = extracted.excerpt;
                  if (logExcerpt) anyActionsLogs = true;
                }
              }
            } else if (logInitRes.ok) {
              const { bytes, truncated } = await readStreamBounded(logInitRes, MAX_JOB_LOG_BYTES, "truncate");
              if (truncated) logNote ??= "actions_logs_truncated_256k";
              const extracted = extractLogExcerpt(new TextDecoder().decode(bytes), {
                ...(token ? { token } : {}),
                maxChars: MAX_EXCERPT_CHARS,
              });
              logExcerpt = extracted.excerpt;
              if (logExcerpt) anyActionsLogs = true;
            } else {
              await logInitRes.body?.cancel();
              logNote ??= `actions_logs_http_${logInitRes.status}`;
            }
          } catch {
            logNote ??= "actions_logs_unavailable";
          }
        }
      }

      items.push({
        kind: "check_run",
        name,
        conclusion,
        url,
        ...(appSlug ? { appSlug } : {}),
        ...(failedStep ? { failedStep } : {}),
        ...(summaryText ? { summaryText } : {}),
        annotations,
        ...(logExcerpt ? { logExcerpt } : {}),
      });
    }

    for (const s of failedStatuses) {
      if (items.length >= 5) break;
      items.push({
        kind: "commit_status",
        name: sanitizeUntrustedCiText(typeof s.context === "string" && s.context.trim() ? s.context : "commit-status", {
          ...(token ? { token } : {}),
          maxChars: 120,
        }),
        conclusion: s.state === "error" ? "error" : "failure",
        url: safeHttpsUrl(s.target_url),
        summaryText:
          typeof s.description === "string" && s.description.trim()
            ? sanitizeUntrustedCiText(s.description, { ...(token ? { token } : {}), maxChars: 400 })
            : null,
        annotations: [],
      });
    }

    const logSource: PrFailureLogSource = anyActionsLogs
      ? "actions_logs"
      : anyChecksDetail
        ? "checks_annotations"
        : failedChecks.length > 0
          ? "checks_summary"
          : "statuses_only";

    return enforceSnapshotBudget({
      head: sha,
      capturedAt: options.now?.() ?? Date.now(),
      evidenceMode: mode,
      logSource,
      ...(logNote ? { logNote } : {}),
      totalFailed,
      items,
    });
  } catch {
    return null;
  }
}

// ---- Direction B: Bounded Read-Only PR Review & Merge Conflict Reader ---------------------------

export interface PrReviewerSummary {
  reviewId: number;
  author: string;
  authorAssociation: string;
  isBot: boolean;
  state: "CHANGES_REQUESTED" | "APPROVED" | "COMMENTED";
  commitId: string | null;
  onCurrentHead: boolean;
  body: string | null;
  htmlUrl: string | null;
}

export interface PrReviewThreadSnapshot {
  rootCommentId: number;
  author: string;
  authorAssociation: string;
  isBot: boolean;
  path: string;
  line: number;
  diffHunkTail?: string | null;
  body: string;
  replyCount: number;
  latestReplyAuthor?: string | null;
  latestReplyBody?: string | null;
  htmlUrl: string | null;
  commitId?: string | null;
}

export interface PrFeedbackSnapshot {
  head: string;
  capturedAt: number;
  baseRef: string | null;
  baseSha: string | null;
  headRef: string | null;
  mergeState: PrMergeState;
  reviewDecision: PrReviewDecision;
  changesRequestedOnCurrentHead: boolean;
  staleChangesRequestedReviewers: string[];
  reviewCursor: string;
  ignoredUntrustedCount: number;
  truncated: boolean;
  reviewers: PrReviewerSummary[];
  threads: PrReviewThreadSnapshot[];
}

const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REVIEWS_PAGE_SIZE = 100;
const COMMENTS_PAGE_SIZE = 50;

function isTrustedPrParticipant(
  authorLogin: string,
  userType: unknown,
  authorAssociation: unknown,
  prAuthorLogin: string | null,
): { trusted: boolean; isBot: boolean; association: string; isSelf: boolean } {
  const normalizedLogin = authorLogin.trim();
  const isSelf = Boolean(prAuthorLogin && normalizedLogin.toLowerCase() === prAuthorLogin.toLowerCase());
  const isBot = userType === "Bot" || normalizedLogin.endsWith("[bot]");
  const assoc = typeof authorAssociation === "string" ? authorAssociation.toUpperCase() : "NONE";
  const trusted = !isSelf && (TRUSTED_AUTHOR_ASSOCIATIONS.has(assoc) || isBot);
  return { trusted, isBot, association: assoc, isSelf };
}

function extractDiffHunkTail(rawHunk: unknown, token?: string): string | null {
  if (typeof rawHunk !== "string" || !rawHunk.trim()) return null;
  const cleaned = sanitizeUntrustedCiText(rawHunk, {
    ...(token ? { token } : {}),
    maxChars: 2_000,
    preserveNewlines: true,
  });
  if (!cleaned) return null;
  const lines = cleaned
    .split("\n")
    .map((line) => (line.length > 180 ? `${line.slice(0, 179)}…` : line));
  const tail = lines.slice(Math.max(0, lines.length - 6)).join("\n").trim();
  if (!tail) return null;
  return tail.length > 360 ? `…${tail.slice(tail.length - 359)}` : tail;
}

function enforceFeedbackBudget(snapshot: PrFeedbackSnapshot): PrFeedbackSnapshot {
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify(snapshot)).byteLength <= MAX_SNAPSHOT_BYTES) return snapshot;
  const trimmed: PrFeedbackSnapshot = {
    ...snapshot,
    reviewers: snapshot.reviewers.slice(0, 6).map((r) => ({
      ...r,
      body: r.body ? r.body.slice(0, 220) : null,
    })),
    threads: snapshot.threads.slice(0, 6).map((t) => ({
      ...t,
      body: t.body.slice(0, 240),
      diffHunkTail: t.diffHunkTail ? t.diffHunkTail.slice(-200) : null,
      latestReplyBody: t.latestReplyBody ? t.latestReplyBody.slice(0, 140) : null,
    })),
  };
  if (encoder.encode(JSON.stringify(trimmed)).byteLength <= MAX_SNAPSHOT_BYTES) return trimmed;
  return {
    ...trimmed,
    reviewers: trimmed.reviewers.slice(0, 4).map((r) => ({ ...r, body: r.body ? r.body.slice(0, 120) : null })),
    threads: trimmed.threads.slice(0, 4).map((t) => ({
      ...t,
      body: t.body.slice(0, 150),
      diffHunkTail: null,
      latestReplyBody: null,
    })),
  };
}

interface RawPrReview {
  id?: unknown;
  user?: { id?: unknown; login?: unknown; type?: unknown } | null;
  author_association?: unknown;
  state?: unknown;
  body?: unknown;
  commit_id?: unknown;
  html_url?: unknown;
}

interface RawPrComment {
  id?: unknown;
  in_reply_to_id?: unknown;
  user?: { id?: unknown; login?: unknown; type?: unknown } | null;
  author_association?: unknown;
  path?: unknown;
  line?: unknown;
  diff_hunk?: unknown;
  body?: unknown;
  commit_id?: unknown;
  html_url?: unknown;
}

/**
 * Reads bounded, sanitized PR mergeability, review decisions, and live inline diff threads.
 * - Only ingests reviews/comments from trusted collaborators (OWNER/MEMBER/COLLABORATOR) or Bots.
 * - Untrusted outsider comments are discarded at the boundary (counted in ignoredUntrustedCount).
 * - Never throws; returns null if unavailable or if the PR head drifted during collection.
 */
export async function readPrReviewAndConflictDetail(
  target: PrTarget,
  sha: string,
  options: {
    token?: string;
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<PrFeedbackSnapshot | null> {
  const canonical = parsePrUrl(target.url);
  if (
    !canonical ||
    canonical.owner !== target.owner ||
    canonical.repo !== target.repo ||
    canonical.number !== target.number ||
    !/^[a-f0-9]{40}$/i.test(sha)
  ) {
    return null;
  }

  const send = options.fetch ?? fetch;
  const token = options.token;
  const repoPath = `/repos/${target.owner}/${target.repo}`;
  const signal = AbortSignal.timeout(10_000);
  const apiHeaders: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "Otto-PR-Watch",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  const getApiJson = async (suffix: string): Promise<{ ok: true; data: unknown } | { ok: false; status: number }> => {
    const response = await send(`https://api.github.com${repoPath}${suffix}`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: apiHeaders,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status };
    }
    const { bytes } = await readStreamBounded(response, 2 * 1024 * 1024, "strict");
    return { ok: true, data: JSON.parse(new TextDecoder().decode(bytes)) };
  };

  try {
    const pullRes = await getApiJson(`/pulls/${target.number}`);
    if (!pullRes.ok) return null;
    const pull = pullOf(pullRes.data);
    if (pull.head.sha.toLowerCase() !== sha.toLowerCase()) return null;

    const prAuthorLogin =
      typeof pull.user?.login === "string" && pull.user.login.trim() ? pull.user.login.trim() : null;
    const pullBranches = extractPullBranches(pull, token);
    const mergeState: PrMergeState = pullBranches.mergeState ?? "unknown";

    const [reviewsRes, commentsRes] = await Promise.all([
      getApiJson(`/pulls/${target.number}/reviews?per_page=${REVIEWS_PAGE_SIZE}`),
      getApiJson(`/pulls/${target.number}/comments?sort=created&direction=desc&per_page=${COMMENTS_PAGE_SIZE}`),
    ]);
    if (!reviewsRes.ok || !Array.isArray(reviewsRes.data)) return null;
    if (!commentsRes.ok || !Array.isArray(commentsRes.data)) return null;

    let ignoredUntrustedCount = 0;
    const truncated =
      reviewsRes.data.length >= REVIEWS_PAGE_SIZE || commentsRes.data.length >= COMMENTS_PAGE_SIZE;

    const rawReviews = (reviewsRes.data as RawPrReview[])
      .filter((r): r is RawPrReview & { id: number } => Boolean(r && typeof r.id === "number" && Number.isSafeInteger(r.id) && r.id > 0))
      .sort((a, b) => a.id - b.id);

    type ReviewerTrack = {
      decisive: PrReviewerSummary | null;
      latestCommentOnHead: PrReviewerSummary | null;
    };
    const byReviewer = new Map<string, ReviewerTrack>();
    let maxActionableReviewId = 0;

    for (const r of rawReviews) {
      const rawState = typeof r.state === "string" ? r.state.toUpperCase() : "";
      if (rawState === "PENDING" || !rawState) continue;
      const rawLogin = typeof r.user?.login === "string" ? r.user.login.trim() : "";
      if (!rawLogin) continue;
      const trust = isTrustedPrParticipant(rawLogin, r.user?.type, r.author_association, prAuthorLogin);
      if (trust.isSelf) continue;
      if (!trust.trusted) {
        ignoredUntrustedCount += 1;
        continue;
      }

      const key = rawLogin.toLowerCase();
      const track = byReviewer.get(key) ?? { decisive: null, latestCommentOnHead: null };
      const author = sanitizeUntrustedCiText(rawLogin, { ...(token ? { token } : {}), maxChars: 80 });
      const commitId =
        typeof r.commit_id === "string" && /^[a-f0-9]{40}$/i.test(r.commit_id) ? r.commit_id.toLowerCase() : null;
      const onCurrentHead = commitId === sha.toLowerCase();
      const body =
        typeof r.body === "string" && r.body.trim()
          ? sanitizeUntrustedCiText(r.body, { ...(token ? { token } : {}), maxChars: 400 })
          : null;
      const htmlUrl = safeHttpsUrl(r.html_url);

      if (rawState === "DISMISSED") {
        track.decisive = null;
      } else if (rawState === "CHANGES_REQUESTED" || rawState === "APPROVED") {
        track.decisive = {
          reviewId: r.id,
          author,
          authorAssociation: trust.association,
          isBot: trust.isBot,
          state: rawState,
          commitId,
          onCurrentHead,
          body,
          htmlUrl,
        };
      } else if (rawState === "COMMENTED" && body && onCurrentHead) {
        track.latestCommentOnHead = {
          reviewId: r.id,
          author,
          authorAssociation: trust.association,
          isBot: trust.isBot,
          state: "COMMENTED",
          commitId,
          onCurrentHead: true,
          body,
          htmlUrl,
        };
      }
      byReviewer.set(key, track);
    }

    const reviewers: PrReviewerSummary[] = [];
    const staleChangesRequestedReviewers: string[] = [];
    let changesRequestedCount = 0;
    let changesRequestedOnCurrentHead = false;
    let approvedCount = 0;

    for (const track of byReviewer.values()) {
      if (track.decisive) {
        reviewers.push(track.decisive);
        if (track.decisive.state === "CHANGES_REQUESTED") {
          changesRequestedCount += 1;
          maxActionableReviewId = Math.max(maxActionableReviewId, track.decisive.reviewId);
          if (track.decisive.onCurrentHead) {
            changesRequestedOnCurrentHead = true;
          } else {
            staleChangesRequestedReviewers.push(track.decisive.author);
          }
        } else if (track.decisive.state === "APPROVED") {
          approvedCount += 1;
        }
      } else if (track.latestCommentOnHead) {
        reviewers.push(track.latestCommentOnHead);
        maxActionableReviewId = Math.max(maxActionableReviewId, track.latestCommentOnHead.reviewId);
      }
    }

    // Parse inline diff comments: group by root id, keep only live diff positions (line !== null).
    const rawComments = (commentsRes.data as RawPrComment[])
      .filter((c): c is RawPrComment & { id: number } => Boolean(c && typeof c.id === "number" && Number.isSafeInteger(c.id) && c.id > 0))
      .sort((a, b) => a.id - b.id);

    type ThreadBuilder = {
      root: PrReviewThreadSnapshot;
      lastActivityId: number;
    };
    const threadMap = new Map<number, ThreadBuilder>();
    let maxTrustedLiveCommentId = 0;

    for (const c of rawComments) {
      const rawLogin = typeof c.user?.login === "string" ? c.user.login.trim() : "";
      if (!rawLogin) continue;
      const trust = isTrustedPrParticipant(rawLogin, c.user?.type, c.author_association, prAuthorLogin);
      const replyTo =
        typeof c.in_reply_to_id === "number" && Number.isSafeInteger(c.in_reply_to_id) && c.in_reply_to_id > 0
          ? c.in_reply_to_id
          : null;

      if (replyTo === null) {
        if (trust.isSelf) continue;
        if (!trust.trusted) {
          ignoredUntrustedCount += 1;
          continue;
        }
        // Outdated diff comments have line === null on GitHub REST v3; skip outdated roots.
        if (typeof c.line !== "number" || !Number.isInteger(c.line) || c.line <= 0) continue;
        const body =
          typeof c.body === "string" && c.body.trim()
            ? sanitizeUntrustedCiText(c.body, { ...(token ? { token } : {}), maxChars: 400 })
            : "";
        if (!body) continue;
        const path =
          typeof c.path === "string" && c.path.trim()
            ? sanitizeUntrustedCiText(c.path, { ...(token ? { token } : {}), maxChars: 180 })
            : "unknown";
        const author = sanitizeUntrustedCiText(rawLogin, { ...(token ? { token } : {}), maxChars: 80 });
        const commitId =
          typeof c.commit_id === "string" && /^[a-f0-9]{40}$/i.test(c.commit_id) ? c.commit_id.toLowerCase() : null;
        threadMap.set(c.id, {
          root: {
            rootCommentId: c.id,
            author,
            authorAssociation: trust.association,
            isBot: trust.isBot,
            path,
            line: c.line,
            diffHunkTail: extractDiffHunkTail(c.diff_hunk, token),
            body,
            replyCount: 0,
            htmlUrl: safeHttpsUrl(c.html_url),
            commitId,
          },
          lastActivityId: c.id,
        });
        maxTrustedLiveCommentId = Math.max(maxTrustedLiveCommentId, c.id);
      } else {
        const existing = threadMap.get(replyTo);
        if (!existing) {
          if (!trust.isSelf && !trust.trusted) ignoredUntrustedCount += 1;
          continue;
        }
        if (!trust.isSelf && !trust.trusted) {
          ignoredUntrustedCount += 1;
          continue;
        }
        const replyBody =
          typeof c.body === "string" && c.body.trim()
            ? sanitizeUntrustedCiText(c.body, { ...(token ? { token } : {}), maxChars: 240 })
            : "";
        existing.root.replyCount += 1;
        if (replyBody) {
          existing.root.latestReplyAuthor = sanitizeUntrustedCiText(rawLogin, {
            ...(token ? { token } : {}),
            maxChars: 80,
          });
          existing.root.latestReplyBody = replyBody;
        }
        existing.lastActivityId = Math.max(existing.lastActivityId, c.id);
        if (trust.trusted) maxTrustedLiveCommentId = Math.max(maxTrustedLiveCommentId, c.id);
      }
    }

    // Re-read PR head SHA at the end so mid-flight head pushes never publish mismatched review snapshots.
    const verifyPullRes = await getApiJson(`/pulls/${target.number}`);
    if (!verifyPullRes.ok) return null;
    const verifyPull = pullOf(verifyPullRes.data);
    if (verifyPull.head.sha.toLowerCase() !== sha.toLowerCase()) return null;

    const threads = [...threadMap.values()]
      .sort((a, b) => b.lastActivityId - a.lastActivityId)
      .slice(0, 8)
      .map((entry) => entry.root);

    const hasTrustedCommentReview = reviewers.some((r) => r.state === "COMMENTED");
    const reviewDecision: PrReviewDecision =
      changesRequestedCount > 0
        ? "changes_requested"
        : threads.length > 0 || hasTrustedCommentReview
          ? "commented"
          : approvedCount > 0
            ? "approved"
            : "none";

    return enforceFeedbackBudget({
      head: sha.toLowerCase(),
      capturedAt: options.now?.() ?? Date.now(),
      baseRef: pullBranches.baseRef ?? null,
      baseSha: pullBranches.baseSha ?? null,
      headRef: pullBranches.headRef ?? null,
      mergeState,
      reviewDecision,
      changesRequestedOnCurrentHead,
      staleChangesRequestedReviewers,
      reviewCursor: `${maxActionableReviewId}:${maxTrustedLiveCommentId}`,
      ignoredUntrustedCount,
      truncated,
      reviewers,
      threads,
    });
  } catch {
    return null;
  }
}
