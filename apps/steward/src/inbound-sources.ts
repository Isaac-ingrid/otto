// Stage 3 Synchronous Webhook Signature Verifier & Event Normalizer (`inbound-sources.ts`).
//
// Adapted from `KKKKhazix/agent-autoloop` (`plugins/github/source.ts`, `plugins/gitlab/source.ts`):
// - Constant-time WebCrypto HMAC-SHA256 verification for GitHub (`X-Hub-Signature-256`) and
//   constant-time token verification for GitLab (`X-Gitlab-Token`).
// - Pure synchronous payload normalization with `escapeMarkers` sanitization so untrusted PR/issue
//   titles or commit messages can never smuggle `⟦…⟧` Steward system markers.
// - Produces stable `eventKey` values so retries and `pausedUntil` -> `replay(since)` deduplicate cleanly.
import { escapeMarkers } from "./wake-text.ts";

export type InboundWebhookSource = "github" | "gitlab";

export interface NormalizedWebhookEvent {
  source: InboundWebhookSource;
  eventKey: string;
  eventType: string;
  repoFullName: string;
  summary: string;
  url: string | null;
  actionable: boolean;
  payloadSummary: Record<string, unknown>;
}

function timingSafeHexOrBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function verifyGitHubSignature256(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const trimmed = signatureHeader.trim();
  if (!trimmed.toLowerCase().startsWith("sha256=")) return false;
  const expectedBytes = hexToBytes(trimmed.slice("sha256=".length));
  if (!expectedBytes || expectedBytes.byteLength !== 32) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const actualBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return timingSafeHexOrBytesEqual(new Uint8Array(actualBuf), expectedBytes);
}

export function verifyGitLabToken(secret: string, tokenHeader: string | null): boolean {
  if (!secret || !tokenHeader) return false;
  const enc = new TextEncoder();
  const a = enc.encode(secret);
  const b = enc.encode(tokenHeader);
  return timingSafeHexOrBytesEqual(a, b);
}

function cleanField(val: unknown, maxLen = 200): string {
  if (typeof val !== "string") return "";
  return escapeMarkers(val.replace(/[\r\n\t]+/g, " ").trim()).slice(0, maxLen);
}

export function normalizeGitHubWebhook(
  eventHeader: string | null,
  deliveryHeader: string | null,
  payload: Record<string, unknown>,
): NormalizedWebhookEvent {
  const eventType = cleanField(eventHeader ?? "unknown", 64) || "unknown";
  const repoObj =
    typeof payload.repository === "object" && payload.repository !== null
      ? (payload.repository as Record<string, unknown>)
      : {};
  const repoFullName = cleanField(repoObj.full_name ?? repoObj.name ?? "unknown/repo", 120);
  const action = cleanField(payload.action, 40);

  if (eventType === "ping") {
    return {
      source: "github",
      eventKey: `github:ping:${deliveryHeader ?? repoFullName}`,
      eventType: "ping",
      repoFullName,
      summary: `[GitHub] Webhook ping verified for ${repoFullName}`,
      url: cleanField(repoObj.html_url, 300) || null,
      actionable: false,
      payloadSummary: { repoFullName, eventType: "ping" },
    };
  }

  if (eventType === "pull_request") {
    const pr =
      typeof payload.pull_request === "object" && payload.pull_request !== null
        ? (payload.pull_request as Record<string, unknown>)
        : {};
    const prNum = typeof pr.number === "number" ? pr.number : Number(payload.number ?? 0);
    const title = cleanField(pr.title, 140);
    const headSha = cleanField((pr.head as Record<string, unknown> | undefined)?.sha, 40);
    const url = cleanField(pr.html_url, 300) || null;
    const actionable = ["opened", "synchronize", "reopened", "ready_for_review"].includes(action);
    return {
      source: "github",
      eventKey: `github:pr:${repoFullName}#${prNum}:${action || "event"}:${headSha.slice(0, 12) || deliveryHeader || "0"}`,
      eventType: `pull_request.${action || "unknown"}`,
      repoFullName,
      summary: `[GitHub] ${repoFullName} PR #${prNum} (${action || "updated"}): ${title}`,
      url,
      actionable,
      payloadSummary: { repoFullName, prNumber: prNum, action, headSha, title, url },
    };
  }

  if (eventType === "workflow_run") {
    const run =
      typeof payload.workflow_run === "object" && payload.workflow_run !== null
        ? (payload.workflow_run as Record<string, unknown>)
        : {};
    const runId = String(run.id ?? deliveryHeader ?? "0");
    const name = cleanField(run.name, 100);
    const conclusion = cleanField(run.conclusion, 40);
    const headSha = cleanField(run.head_sha, 40);
    const url = cleanField(run.html_url, 300) || null;
    const actionable = action === "completed" && conclusion === "failure";
    return {
      source: "github",
      eventKey: `github:workflow_run:${repoFullName}:${runId}:${conclusion || action}`,
      eventType: `workflow_run.${action || "unknown"}`,
      repoFullName,
      summary: `[GitHub] ${repoFullName} workflow '${name}' ${action}${conclusion ? ` (${conclusion})` : ""}`,
      url,
      actionable,
      payloadSummary: { repoFullName, runId, name, action, conclusion, headSha, url },
    };
  }

  if (eventType === "issues" || eventType === "issue_comment") {
    const issue =
      typeof payload.issue === "object" && payload.issue !== null
        ? (payload.issue as Record<string, unknown>)
        : {};
    const num = typeof issue.number === "number" ? issue.number : 0;
    const title = cleanField(issue.title, 140);
    const commentId =
      typeof (payload.comment as Record<string, unknown> | undefined)?.id === "number"
        ? String((payload.comment as Record<string, unknown>).id)
        : "";
    const url =
      cleanField((payload.comment as Record<string, unknown> | undefined)?.html_url ?? issue.html_url, 300) || null;
    const actionable = ["opened", "created"].includes(action);
    return {
      source: "github",
      eventKey: `github:${eventType}:${repoFullName}#${num}:${commentId || action || deliveryHeader || "0"}`,
      eventType: `${eventType}.${action || "unknown"}`,
      repoFullName,
      summary: `[GitHub] ${repoFullName} #${num} (${eventType}.${action}): ${title}`,
      url,
      actionable,
      payloadSummary: { repoFullName, issueNumber: num, action, title, url },
    };
  }

  const afterSha = cleanField(payload.after, 40);
  const ref = cleanField(payload.ref, 100);
  return {
    source: "github",
    eventKey: `github:${eventType}:${repoFullName}:${afterSha.slice(0, 12) || deliveryHeader || Date.now()}`,
    eventType,
    repoFullName,
    summary: `[GitHub] ${repoFullName} ${eventType}${ref ? ` (${ref})` : ""}`,
    url: cleanField(payload.compare ?? repoObj.html_url, 300) || null,
    actionable: eventType === "push",
    payloadSummary: { repoFullName, eventType, ref, afterSha },
  };
}

export function normalizeGitLabWebhook(
  eventHeader: string | null,
  payload: Record<string, unknown>,
): NormalizedWebhookEvent {
  const rawKind = cleanField(payload.object_kind ?? eventHeader ?? "unknown", 64) || "unknown";
  const project =
    typeof payload.project === "object" && payload.project !== null
      ? (payload.project as Record<string, unknown>)
      : {};
  const repoFullName = cleanField(project.path_with_namespace ?? project.name ?? "unknown/project", 120);
  const attrs =
    typeof payload.object_attributes === "object" && payload.object_attributes !== null
      ? (payload.object_attributes as Record<string, unknown>)
      : {};

  if (rawKind === "merge_request" || eventHeader === "Merge Request Hook") {
    const iid = Number(attrs.iid ?? 0);
    const action = cleanField(attrs.action ?? attrs.state, 40);
    const title = cleanField(attrs.title, 140);
    const lastCommit = cleanField((attrs.last_commit as Record<string, unknown> | undefined)?.id, 40);
    const url = cleanField(attrs.url, 300) || null;
    const actionable = ["open", "update", "reopen"].includes(action);
    return {
      source: "gitlab",
      eventKey: `gitlab:mr:${repoFullName}!${iid}:${action}:${lastCommit.slice(0, 12) || "0"}`,
      eventType: `merge_request.${action || "unknown"}`,
      repoFullName,
      summary: `[GitLab] ${repoFullName} !${iid} (${action}): ${title}`,
      url,
      actionable,
      payloadSummary: { repoFullName, mrIid: iid, action, lastCommit, title, url },
    };
  }

  if (rawKind === "pipeline" || eventHeader === "Pipeline Hook") {
    const pipeId = String(attrs.id ?? "0");
    const status = cleanField(attrs.status, 40);
    const sha = cleanField(attrs.sha, 40);
    const url = cleanField(attrs.url ?? project.web_url, 300) || null;
    return {
      source: "gitlab",
      eventKey: `gitlab:pipeline:${repoFullName}:${pipeId}:${status}`,
      eventType: `pipeline.${status || "unknown"}`,
      repoFullName,
      summary: `[GitLab] ${repoFullName} pipeline #${pipeId}: ${status}`,
      url,
      actionable: status === "failed",
      payloadSummary: { repoFullName, pipelineId: pipeId, status, sha, url },
    };
  }

  const checkoutSha = cleanField(payload.checkout_sha ?? attrs.id, 40);
  return {
    source: "gitlab",
    eventKey: `gitlab:${rawKind}:${repoFullName}:${checkoutSha.slice(0, 12) || Date.now()}`,
    eventType: rawKind,
    repoFullName,
    summary: `[GitLab] ${repoFullName} ${rawKind}`,
    url: cleanField(attrs.url ?? project.web_url, 300) || null,
    actionable: rawKind === "push" || rawKind === "issue" || rawKind === "note",
    payloadSummary: { repoFullName, eventType: rawKind, checkoutSha },
  };
}
