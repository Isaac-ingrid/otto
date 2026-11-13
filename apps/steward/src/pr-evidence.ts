// GitHub evidence reader: fixed origin, GET only, no redirects, no model or shell.
export interface PrTarget { owner: string; repo: string; number: number; url: string }
export interface PrEvidence {
  head: string;
  state: "waiting" | "failure" | "success" | "closed" | "merged";
  checks: number;
  failed: number;
  pending: number;
}
export type EvidenceResult = { ok: true; evidence: PrEvidence } | { ok: false; reason: string };

export function parsePrUrl(value: unknown): PrTarget | null {
  if (typeof value !== "string") return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,8})\/?$/.exec(value);
  if (!match || [".", ".."].includes(match[2]!)) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` };
}

class EvidenceError extends Error {}
type Pull = { head: { sha: string }; state: string; merged: boolean };
function pullOf(raw: unknown): Pull {
  const p = raw as Partial<Pull> | null;
  if (!p || !/^[a-f0-9]{40}$/i.test(p.head?.sha ?? "") || !["open", "closed"].includes(p.state ?? "") || typeof p.merged !== "boolean") throw new EvidenceError("invalid_pull_response");
  return p as Pull;
}

export async function readPrEvidence(target: PrTarget, options: { token?: string; fetch?: typeof fetch } = {}): Promise<EvidenceResult> {
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
    const checksRaw = await get(`/commits/${sha}/check-runs?filter=latest&per_page=100`) as { total_count?: number; check_runs?: Array<{ head_sha?: string; status?: string; conclusion?: string | null }> };
    const statusesRaw = await get(`/commits/${sha}/status?per_page=100`) as { total_count?: number; statuses?: Array<{ state?: string }>; sha?: string };
    if (!checksRaw || !Array.isArray(checksRaw.check_runs) || !Number.isInteger(checksRaw.total_count) || checksRaw.total_count !== checksRaw.check_runs.length ||
        !statusesRaw || statusesRaw.sha !== sha || !Array.isArray(statusesRaw.statuses) || !Number.isInteger(statusesRaw.total_count) || statusesRaw.total_count !== statusesRaw.statuses.length) {
      throw new EvidenceError("incomplete_checks"); // includes truncation/pagination: never infer green
    }
    let failed = 0;
    let pending = 0;
    for (const check of checksRaw.check_runs) {
      if (!check || check.head_sha !== sha || !["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(check.status ?? "")) throw new EvidenceError("invalid_check_response");
      if (check.status !== "completed") pending++;
      else if (["failure", "timed_out", "cancelled", "action_required", "stale", "startup_failure"].includes(check.conclusion ?? "")) failed++;
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
    const checks = checksRaw.check_runs.length + statusesRaw.statuses.length;
    // All-neutral/skipped is not a green build. At least one real success is required.
    const successful = checksRaw.check_runs.some(c => c.status === "completed" && c.conclusion === "success") || statusesRaw.statuses.some(s => s.state === "success");
    return { ok: true, evidence: { head: sha, state: failed ? "failure" : pending || !successful ? "waiting" : "success", checks, failed, pending } };
  } catch (error) {
    return { ok: false, reason: error instanceof EvidenceError ? error.message : "github_unavailable" };
  }
}
