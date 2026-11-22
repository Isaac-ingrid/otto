// Pure local SQLite hybrid search engine for Web Workspace Command-K (Stage 1).
//
// Architectural & security invariants:
// - 100% deterministic local SQLite reads inside Steward DO: 0 LLM calls, 0 Connector fan-out.
// - Dual-layer privacy fence: `sh_outbound` rows with `private: true` are excluded in 046 triggers
//   AND verified again on read; `/link/wl1.*` one-time login tokens and credential shapes (`sk-*`,
//   `ghp_*`, `AKIA*`, `Bearer *`, literal `githubToken`) are stripped BEFORE term verification and
//   snippet slicing so secrets can neither leak nor be probed via boolean search hits.
// - Side-effect free: never mutates `sh_thread.unread`, `sh_note.useCount`, or `sh_note.lastUsedAt`.
// - Zero HTML injection: emits plain-text `snippet` + UTF-16 `[start, end]` `highlights` intervals.
import type { LedgerSql } from "./ledger.ts";
import type { NoteLayer, NoteRow, Notes } from "./notes.ts";
import {
  parsePrUrl,
  sanitizeUntrustedCiText,
  type PrFailureSnapshot,
  type PrFeedbackSnapshot,
} from "./pr-evidence.ts";
import {
  buildDeterministicPrDiagnosis,
  buildDeterministicPrFeedbackTriage,
  type PrFailureDiagnosis,
  type PrFeedbackTriage,
} from "./pr-failure-diagnoser.ts";
import { cardView, workspaceText } from "./workspace.ts";

export type WorkspaceSearchInputScope =
  | "all"
  | "threads"
  | "messages"
  | "reports"
  | "checkpoints"
  | "pr"
  | "memory";

export type WorkspaceSearchScope =
  | "all"
  | "threads"
  | "messages"
  | "reports"
  | "pr"
  | "memory";

export type WorkspaceSearchItemKind =
  | "thread"
  | "message"
  | "report"
  | "pr_watch"
  | "memory";

export type WorkspaceSearchAnchor =
  | { type: "thread"; threadId: string }
  | { type: "message"; messageId: string; role: "user" | "assistant"; at: number }
  | { type: "report"; workerId: string; seq?: number | null; timelineId?: number | null }
  | { type: "pr_watch"; watchId: string; head: string | null; url: string }
  | { type: "memory"; noteId: string; layer: NoteLayer; scopeRepoId: string | null };

export interface WorkspaceSearchHit {
  id: string;
  kind: WorkspaceSearchItemKind;
  title: string;
  subtitle: string | null;
  snippet: string;
  highlights: Array<[number, number]>;
  titleHighlights: Array<[number, number]>;
  threadId: string | null;
  threadTitle: string | null;
  threadArchived: boolean;
  at: number;
  anchor: WorkspaceSearchAnchor;
}

export interface WorkspaceSearchResponse {
  q: string;
  scope: WorkspaceSearchScope;
  items: WorkspaceSearchHit[];
  truncated: boolean;
}

export interface WorkspaceSearchQueryOptions {
  q: string;
  scope?: WorkspaceSearchInputScope;
  threadId?: string | null;
  includeArchived?: boolean;
  limit?: number;
  githubToken?: string;
}

export interface ParsedSearchQuery {
  normalized: string;
  terms: string[];
  longTerms: string[];
  shortTerms: string[];
  ftsMatch: string | null;
  likePatterns: string[];
}

export const SEARCH_MAX_QUERY_CHARS = 160;
export const SEARCH_MAX_TERMS = 8;
export const SEARCH_DEFAULT_LIMIT = 30;
export const SEARCH_MAX_LIMIT = 50;
export const SEARCH_SNIPPET_MAX_CHARS = 180;
export const SEARCH_MAX_HIGHLIGHTS = 8;

const ONE_TIME_LINK_URL_RE = /https?:\/\/\S*\/link\/wl1\.\S*/gi;
const ONE_TIME_LINK_PATH_RE = /\/link\/wl1\.[A-Za-z0-9._-]+/g;
const HAN_CHAR_RE = /\p{Script=Han}/u;

const VALID_INPUT_SCOPES = new Set<WorkspaceSearchInputScope>([
  "all",
  "threads",
  "messages",
  "reports",
  "checkpoints",
  "pr",
  "memory",
]);

export function isWorkspaceSearchScope(value: string): value is WorkspaceSearchInputScope {
  return VALID_INPUT_SCOPES.has(value as WorkspaceSearchInputScope);
}

export function normalizeSearchScope(scope?: WorkspaceSearchInputScope): WorkspaceSearchScope {
  if (!scope || scope === "all") return "all";
  if (scope === "checkpoints") return "reports";
  return scope;
}

/** Escapes SQLite LIKE wildcards (`!`, `%`, `_`) for `LIKE ... ESCAPE '!'`. */
export function escapeLikePattern(term: string): string {
  return `%${term.replace(/[!%_]/g, (m) => `!${m}`)}%`;
}

function ftsQuoteLiteral(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function cjkSlidingTrigrams(term: string, cap = 12): string[] {
  const chars = [...term];
  if (chars.length < 4 || !HAN_CHAR_RE.test(term)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 3 <= chars.length && out.length < cap; i += 1) {
    const gram = chars.slice(i, i + 3).join("");
    if ( HAN_CHAR_RE.test(gram) && !seen.has(gram)) {
      seen.add(gram);
      out.push(gram);
    }
  }
  return out;
}

/**
 * Normalizes user query text, enforces code-point bounds (`2..160`), splits into at most 8
 * unique terms, and separates `>= 3`-char FTS5 trigram terms from `< 3`-char `LIKE` terms.
 */
export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const cleaned = String(rawQuery ?? "")
    .normalize("NFC")
    .replace(/\0/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const codePoints = [...cleaned];
  if (codePoints.length < 2) {
    return {
      normalized: codePoints.join(""),
      terms: [],
      longTerms: [],
      shortTerms: [],
      ftsMatch: null,
      likePatterns: [],
    };
  }
  const normalized = codePoints.slice(0, SEARCH_MAX_QUERY_CHARS).join("").trim();
  if ([...normalized].length < 2) {
    return {
      normalized,
      terms: [],
      longTerms: [],
      shortTerms: [],
      ftsMatch: null,
      likePatterns: [],
    };
  }

  const rawParts = normalized.split(" ").map((p) => p.trim()).filter((p) => p.length > 0);
  const terms: string[] = [];
  const seenLower = new Set<string>();
  for (const part of rawParts) {
    if ([...part].length < 2) continue;
    const key = part.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    terms.push(part);
    if (terms.length >= SEARCH_MAX_TERMS) break;
  }
  // Edge case: e.g. `"a b"` where individual whitespace tokens are 1 char each, yet the
  // normalized phrase itself has >= 3 chars — keep the whole phrase as one searchable term.
  if (terms.length === 0 && [...normalized].length >= 2) {
    terms.push(normalized);
  }

  const longTerms = terms.filter((t) => [...t].length >= 3);
  const shortTerms = terms.filter((t) => [...t].length < 3);

  const ftsClauses: string[] = [];
  const seenFts = new Set<string>();
  const pushFts = (literal: string): void => {
    const key = literal.toLowerCase();
    if (seenFts.has(key) || ftsClauses.length >= 24) return;
    seenFts.add(key);
    ftsClauses.push(ftsQuoteLiteral(literal));
  };
  for (const term of longTerms) {
    pushFts(term);
    for (const gram of cjkSlidingTrigrams(term, 8)) {
      pushFts(gram);
    }
  }

  return {
    normalized,
    terms,
    longTerms,
    shortTerms,
    ftsMatch: ftsClauses.length > 0 ? ftsClauses.join(" OR ") : null,
    likePatterns: shortTerms.map(escapeLikePattern),
  };
}

/** Strips workspace one-time `/link/wl1.*` tokens, ANSI escapes, control chars, and secret shapes. */
export function sanitizeSearchText(
  raw: string,
  opts: { githubToken?: string; maxChars?: number } = {},
): string {
  if (!raw) return "";
  const withoutLinks = workspaceText(raw)
    .replace(ONE_TIME_LINK_URL_RE, "")
    .replace(ONE_TIME_LINK_PATH_RE, "");
  return sanitizeUntrustedCiText(withoutLinks, {
    ...(opts.githubToken ? { token: opts.githubToken } : {}),
    maxChars: opts.maxChars ?? 16_000,
    preserveNewlines: false,
  });
}

/** Snap UTF-16 index outward/inward so slicing never splits a surrogate pair. */
function clampUtf16Start(text: string, idx: number): number {
  const clamped = Math.max(0, Math.min(text.length, idx));
  if (clamped > 0 && clamped < text.length) {
    const code = text.charCodeAt(clamped);
    if (code >= 0xdc00 && code <= 0xdfff) return clamped - 1;
  }
  return clamped;
}

function clampUtf16End(text: string, idx: number): number {
  const clamped = Math.max(0, Math.min(text.length, idx));
  if (clamped > 0 && clamped < text.length) {
    const prev = text.charCodeAt(clamped - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) return clamped - 1;
  }
  return clamped;
}

/**
 * Computes non-overlapping, monotonically increasing UTF-16 `[start, end]` intervals
 * directly against the final sanitized string (`snippet` or `title`), capped at `maxRanges`.
 */
export function computeHighlights(
  text: string,
  needles: readonly string[],
  maxRanges = SEARCH_MAX_HIGHLIGHTS,
): Array<[number, number]> {
  if (!text || needles.length === 0 || maxRanges <= 0) return [];
  const lower = text.toLowerCase();
  const uniqueNeedles = [...new Set(needles.map((n) => n.trim()).filter((n) => n.length > 0))]
    .sort((a, b) => b.length - a.length);
  if (uniqueNeedles.length === 0) return [];

  const rawRanges: Array<[number, number]> = [];
  for (const needle of uniqueNeedles) {
    const nLower = needle.toLowerCase();
    if (!nLower || nLower.length > lower.length) continue;
    let from = 0;
    while (from <= lower.length - nLower.length) {
      const idx = lower.indexOf(nLower, from);
      if (idx === -1) break;
      const end = idx + nLower.length;
      if (end > idx && end <= text.length) {
        rawRanges.push([idx, end]);
      }
      from = idx + Math.max(1, nLower.length);
      if (rawRanges.length >= 64) break;
    }
  }
  if (rawRanges.length === 0) return [];

  rawRanges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of rawRanges) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push([start, end]);
      continue;
    }
    if (start <= prev[1]) {
      if (end > prev[1]) prev[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged.slice(0, maxRanges);
}

/**
 * Extracts a bounded plain-text snippet (`<= 180` UTF-16 code units) centered on the first
 * matched query term and computes exact `[start, end]` highlight intervals on the snippet.
 */
export function buildSnippet(
  sanitizedBody: string,
  needles: readonly string[],
  maxChars = SEARCH_SNIPPET_MAX_CHARS,
): { snippet: string; highlights: Array<[number, number]> } {
  const clean = sanitizedBody.replace(/\s+/g, " ").trim();
  if (!clean) return { snippet: "", highlights: [] };

  if (clean.length <= maxChars) {
    return {
      snippet: clean,
      highlights: computeHighlights(clean, needles),
    };
  }

  const lower = clean.toLowerCase();
  let firstIdx = -1;
  let firstLen = 0;
  const orderedNeedles = [...new Set(needles.filter((n) => n.length > 0))].sort((a, b) => b.length - a.length);
  for (const needle of orderedNeedles) {
    const nLower = needle.toLowerCase();
    const idx = lower.indexOf(nLower);
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
      firstIdx = idx;
      firstLen = nLower.length;
    }
  }

  if (firstIdx === -1) {
    const end = clampUtf16End(clean, maxChars - 1);
    const snippet = `${clean.slice(0, end).trimEnd()}…`;
    return { snippet, highlights: [] };
  }

  const leadContext = 42;
  const rawStart = Math.max(0, firstIdx - leadContext);
  const start = clampUtf16Start(clean, rawStart);
  const prefix = start > 0 ? "…" : "";
  const budget = Math.max(24, maxChars - prefix.length - 1);
  const minEnd = Math.min(clean.length, firstIdx + firstLen);
  const rawEnd = Math.max(minEnd, Math.min(clean.length, start + budget));
  const end = clampUtf16End(clean, rawEnd);
  const suffix = end < clean.length ? "…" : "";
  const core = clean.slice(start, end).trim();
  const snippet = `${prefix}${core}${suffix}`;

  return {
    snippet,
    highlights: computeHighlights(snippet, orderedNeedles),
  };
}

interface MatchEvaluation {
  matched: boolean;
  score: number;
  highlightNeedles: string[];
}

function evaluateCandidateMatch(input: {
  query: ParsedSearchQuery;
  title: string;
  body: string;
  subtitle?: string | null;
  threadArchived: boolean;
  at: number;
  now: number;
}): MatchEvaluation {
  const { query, title, body, subtitle, threadArchived, at, now } = input;
  const titleLower = title.toLowerCase();
  const bodyLower = body.toLowerCase();
  const subLower = (subtitle ?? "").toLowerCase();
  const combined = `${titleLower}\n${subLower}\n${bodyLower}`;

  let matchedTerms = 0;
  let matchedWeight = 0;
  let titleMatched = false;
  const needles: string[] = [];

  const phraseLower = query.normalized.toLowerCase();
  const exactPhraseMatched = combined.includes(phraseLower);
  if (exactPhraseMatched) {
    needles.push(query.normalized);
    if (titleLower.includes(phraseLower)) titleMatched = true;
  }

  for (const term of query.terms) {
    const tLower = term.toLowerCase();
    if (combined.includes(tLower)) {
      matchedTerms += 1;
      matchedWeight += 1;
      needles.push(term);
      if (titleLower.includes(tLower)) titleMatched = true;
      continue;
    }
    const grams = cjkSlidingTrigrams(term, 10);
    if (grams.length > 0) {
      const hitGrams = grams.filter((g) => combined.includes(g.toLowerCase()));
      const minRequired = Math.min(2, grams.length);
      if (hitGrams.length >= minRequired) {
        matchedWeight += 0.6 * (hitGrams.length / grams.length);
        needles.push(...hitGrams);
        if (hitGrams.some((g) => titleLower.includes(g.toLowerCase()))) titleMatched = true;
      }
    }
  }

  if (matchedWeight === 0 && !exactPhraseMatched) {
    return { matched: false, score: 0, highlightNeedles: [] };
  }

  const allTermsMatched = query.terms.length > 0 && matchedTerms === query.terms.length;
  const coverageScore = query.terms.length > 0 ? (matchedWeight / query.terms.length) * 20 : 0;
  const ageMs = Math.max(0, now - at);
  const recencyScore = 10 / (1 + ageMs / (7 * 86_400_000));

  const score =
    (allTermsMatched ? 40 : 0) +
    coverageScore +
    (exactPhraseMatched ? 25 : 0) +
    (titleMatched ? 15 : 0) +
    (!threadArchived ? 5 : 0) +
    recencyScore;

  return {
    matched: true,
    score,
    highlightNeedles: needles,
  };
}

interface ThreadMeta {
  threadId: string;
  title: string;
  archived: boolean;
  lastActivityAt: number;
  repoIds: string[];
  repoNames: string[];
  latestBranch: string | null;
}

interface ScoredHit {
  hit: WorkspaceSearchHit;
  score: number;
}

function jsonOrNull<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function clipTitle(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, clampUtf16End(clean, max - 1)).trimEnd()}…`;
}

function extractOutboundReadable(
  row: { id: string; kind: string; payload: string },
  githubToken?: string,
): { private: boolean; cardTitle: string | null; text: string } {
  const parsed = jsonOrNull<{ text?: unknown; card?: unknown; private?: unknown }>(row.payload);
  if (!parsed) return { private: false, cardTitle: null, text: "" };
  if (parsed.private === true || parsed.private === 1) {
    return { private: true, cardTitle: null, text: "" };
  }
  if (row.kind === "card" && parsed.card !== undefined) {
    const view = cardView(parsed.card);
    const cardTitle = view.title ? sanitizeSearchText(view.title, { githubToken, maxChars: 200 }) : null;
    const parts = [
      view.title,
      ...view.body,
      view.note ?? "",
      ...view.buttons.map((b) => b.label),
    ].filter((s) => typeof s === "string" && s.trim().length > 0);
    const rawCardText =
      typeof (parsed.card as { text?: unknown } | null)?.text === "string" && parts.length === 0
        ? String((parsed.card as { text: string }).text)
        : parts.join("\n");
    return {
      private: false,
      cardTitle: cardTitle || null,
      text: sanitizeSearchText(rawCardText, { githubToken }),
    };
  }
  const plain = typeof parsed.text === "string" ? parsed.text : "";
  return {
    private: false,
    cardTitle: null,
    text: sanitizeSearchText(plain, { githubToken }),
  };
}

export interface WorkspaceSearchDeps {
  sql: LedgerSql;
  notes: Pick<Notes, "get" | "list">;
  now?: () => number;
}

export function createWorkspaceSearch(deps: WorkspaceSearchDeps) {
  const { sql, notes } = deps;
  const nowFn = deps.now ?? Date.now;

  const query = (opts: WorkspaceSearchQueryOptions): WorkspaceSearchResponse => {
    const scope = normalizeSearchScope(opts.scope);
    const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.trunc(opts.limit ?? SEARCH_DEFAULT_LIMIT)));
    const includeArchived = opts.includeArchived ?? true;
    const filterThreadId = opts.threadId?.trim() ? opts.threadId.trim() : null;
    const githubToken = opts.githubToken;
    const parsed = parseSearchQuery(opts.q);

    if (parsed.terms.length === 0) {
      return {
        q: parsed.normalized,
        scope,
        items: [],
        truncated: false,
      };
    }

    const now = nowFn();

    // Preload lightweight repo & machine display maps (small bounded tables).
    const repoNameById = new Map<string, string>();
    for (const r of sql<{ repoId: string; name: string }>`SELECT repoId, name FROM sh_repo ORDER BY updatedAt DESC`) {
      if (!repoNameById.has(r.repoId)) repoNameById.set(r.repoId, r.name);
    }
    const machineNameById = new Map<string, string>();
    for (const m of sql<{ deviceId: string; name: string }>`SELECT deviceId, name FROM sh_machine`) {
      machineNameById.set(m.deviceId, m.name);
    }

    const threadMetaCache = new Map<string, ThreadMeta | null>();
    const getThreadMeta = (threadId: string | null | undefined): ThreadMeta | null => {
      if (!threadId) return null;
      if (threadMetaCache.has(threadId)) return threadMetaCache.get(threadId)!;
      const row = sql<{
        threadId: string;
        title: string;
        archived: number;
        lastActivityAt: number;
      }>`SELECT threadId, title, archived, lastActivityAt FROM sh_thread WHERE threadId = ${threadId}`[0];
      if (!row) {
        threadMetaCache.set(threadId, null);
        return null;
      }
      const repoIds = sql<{ repoId: string }>`SELECT repoId FROM sh_thread_repo WHERE threadId = ${threadId}`.map(
        (r) => r.repoId,
      );
      const repoNames = repoIds.map((id) => repoNameById.get(id) ?? id);
      const latestBranch =
        sql<{ branch: string | null }>`
          SELECT branch FROM sh_worker
          WHERE threadId = ${threadId} AND branch IS NOT NULL
          ORDER BY createdAt DESC, workerId DESC LIMIT 1
        `[0]?.branch ?? null;
      const meta: ThreadMeta = {
        threadId: row.threadId,
        title: sanitizeSearchText(row.title, { githubToken, maxChars: 240 }) || row.threadId,
        archived: Boolean(row.archived),
        lastActivityAt: row.lastActivityAt,
        repoIds,
        repoNames,
        latestBranch: latestBranch
          ? sanitizeSearchText(latestBranch, { githubToken, maxChars: 120 })
          : null,
      };
      threadMetaCache.set(threadId, meta);
      return meta;
    };

    const candidates: ScoredHit[] = [];
    let hitInternalCap = false;

    // ---- 1. Threads (`threads`) -----------------------------------------------------------------
    if (scope === "all" || scope === "threads") {
      const threadIds = new Set<string>();
      if (filterThreadId) {
        threadIds.add(filterThreadId);
      } else {
        if (parsed.ftsMatch !== null) {
          try {
            const ftsRows = sql<{ threadId: string }>`
              SELECT threadId FROM sh_thread_fts
              WHERE sh_thread_fts MATCH ${parsed.ftsMatch}
              ORDER BY bm25(sh_thread_fts) LIMIT 80
            `;
            if (ftsRows.length >= 80) hitInternalCap = true;
            for (const r of ftsRows) threadIds.add(r.threadId);
          } catch {
            // Fallback to parameterized LIKE below if FTS expression cannot execute.
            for (const term of parsed.longTerms) {
              const pat = escapeLikePattern(term);
              const likeRows = sql<{ threadId: string }>`
                SELECT threadId FROM sh_thread
                WHERE title LIKE ${pat} ESCAPE '!'
                   OR COALESCE(goal, '') LIKE ${pat} ESCAPE '!'
                   OR COALESCE(summary, '') LIKE ${pat} ESCAPE '!'
                ORDER BY lastActivityAt DESC LIMIT 80
              `;
              for (const r of likeRows) threadIds.add(r.threadId);
            }
          }
        }
        for (const pat of parsed.likePatterns) {
          const likeRows = sql<{ threadId: string }>`
            SELECT threadId FROM sh_thread
            WHERE title LIKE ${pat} ESCAPE '!'
               OR COALESCE(goal, '') LIKE ${pat} ESCAPE '!'
               OR COALESCE(summary, '') LIKE ${pat} ESCAPE '!'
            ORDER BY lastActivityAt DESC LIMIT 150
          `;
          if (likeRows.length >= 150) hitInternalCap = true;
          for (const r of likeRows) threadIds.add(r.threadId);
        }
        // Also match repo name or worker branch name on recent threads.
        for (const term of parsed.terms) {
          const pat = escapeLikePattern(term);
          const branchRows = sql<{ threadId: string }>`
            SELECT DISTINCT threadId FROM sh_worker
            WHERE branch IS NOT NULL AND branch LIKE ${pat} ESCAPE '!'
            ORDER BY createdAt DESC LIMIT 60
          `;
          for (const r of branchRows) threadIds.add(r.threadId);
          const repoRows = sql<{ threadId: string }>`
            SELECT DISTINCT tr.threadId
            FROM sh_thread_repo tr
            JOIN sh_repo r ON r.repoId = tr.repoId
            WHERE r.name LIKE ${pat} ESCAPE '!' OR tr.repoId LIKE ${pat} ESCAPE '!'
            LIMIT 60
          `;
          for (const r of repoRows) threadIds.add(r.threadId);
        }
      }

      for (const tid of threadIds) {
        const row = sql<{
          threadId: string;
          title: string;
          goal: string | null;
          summary: string | null;
          archived: number;
          lastActivityAt: number;
        }>`
          SELECT threadId, title, goal, summary, archived, lastActivityAt
          FROM sh_thread WHERE threadId = ${tid}
        `[0];
        if (!row) continue;
        const meta = getThreadMeta(tid);
        if (!meta) continue;
        if (!includeArchived && meta.archived) continue;

        const latestReportSummary =
          sql<{ summary: string }>`
            SELECT summary FROM sh_report
            WHERE threadId = ${tid}
            ORDER BY receivedAt DESC, seq DESC LIMIT 1
          `[0]?.summary ?? "";

        const bodyParts = [
          row.goal ? sanitizeSearchText(row.goal, { githubToken }) : "",
          row.summary ? sanitizeSearchText(row.summary, { githubToken }) : "",
          latestReportSummary ? sanitizeSearchText(latestReportSummary, { githubToken }) : "",
        ].filter((p) => p.length > 0);
        const bodyText = bodyParts.join(" — ") || meta.title;
        const subtitle = [...meta.repoNames, meta.latestBranch].filter(Boolean).join(" · ") || null;

        const evalRes = evaluateCandidateMatch({
          query: parsed,
          title: meta.title,
          body: bodyText,
          subtitle,
          threadArchived: meta.archived,
          at: row.lastActivityAt,
          now,
        });
        if (!evalRes.matched) continue;

        const { snippet, highlights } = buildSnippet(bodyText, evalRes.highlightNeedles);
        candidates.push({
          score: evalRes.score + 2, // slight tie-break boost for top-level Thread overview
          hit: {
            id: `thread:${row.threadId}`,
            kind: "thread",
            title: clipTitle(meta.title),
            subtitle,
            snippet,
            highlights,
            titleHighlights: computeHighlights(clipTitle(meta.title), evalRes.highlightNeedles),
            threadId: row.threadId,
            threadTitle: meta.title,
            threadArchived: meta.archived,
            at: row.lastActivityAt,
            anchor: { type: "thread", threadId: row.threadId },
          },
        });
      }
    }

    // ---- 2. Messages (`messages`: `sh_inbound` + non-private `sh_outbound`) ---------------------
    if (scope === "all" || scope === "messages") {
      const inboundKeys = new Set<string>(); // `${channel}:${msgId}`
      const outboundIds = new Set<string>();

      const addDocKey = (docKey: string): void => {
        if (docKey.startsWith("in:")) {
          inboundKeys.add(docKey.slice(3));
        } else if (docKey.startsWith("out:")) {
          outboundIds.add(docKey.slice(4));
        }
      };

      if (filterThreadId) {
        // Thread-scoped search resolves `COALESCE(r.routedThreadId, i.threadId)` directly so
        // messages routed at run time (with `sh_inbound.threadId IS NULL`) are never missed.
        const inScoped = sql<{ channel: string; msgId: string }>`
          SELECT i.channel, i.msgId
          FROM sh_inbound i LEFT JOIN sh_run r ON r.operationId = 'user:' || i.msgId
          WHERE i.ownerAuthorized = 1
            AND i.text IS NOT NULL
            AND COALESCE(r.routedThreadId, i.threadId) = ${filterThreadId}
          ORDER BY i.receivedAt DESC LIMIT 200
        `;
        if (inScoped.length >= 200) hitInternalCap = true;
        for (const r of inScoped) inboundKeys.add(`${r.channel}:${r.msgId}`);

        const outScoped = sql<{ id: string }>`
          SELECT id FROM sh_outbound
          WHERE threadId = ${filterThreadId}
            AND json_valid(payload)
            AND COALESCE(json_extract(payload, '$.private'), 0) = 0
          ORDER BY createdAt DESC LIMIT 200
        `;
        if (outScoped.length >= 200) hitInternalCap = true;
        for (const r of outScoped) outboundIds.add(r.id);
      } else {
        if (parsed.ftsMatch !== null) {
          try {
            const ftsRows = sql<{ docKey: string }>`
              SELECT docKey FROM sh_message_fts
              WHERE sh_message_fts MATCH ${parsed.ftsMatch}
              ORDER BY bm25(sh_message_fts) LIMIT 120
            `;
            if (ftsRows.length >= 120) hitInternalCap = true;
            for (const r of ftsRows) addDocKey(r.docKey);
          } catch {
            for (const term of parsed.longTerms) {
              const pat = escapeLikePattern(term);
              for (const r of sql<{ channel: string; msgId: string }>`
                SELECT channel, msgId FROM sh_inbound
                WHERE ownerAuthorized = 1 AND text IS NOT NULL AND text LIKE ${pat} ESCAPE '!'
                ORDER BY receivedAt DESC LIMIT 120
              `) {
                inboundKeys.add(`${r.channel}:${r.msgId}`);
              }
              for (const r of sql<{ id: string }>`
                SELECT id FROM sh_outbound
                WHERE json_valid(payload)
                  AND COALESCE(json_extract(payload, '$.private'), 0) = 0
                  AND payload LIKE ${pat} ESCAPE '!'
                ORDER BY createdAt DESC LIMIT 120
              `) {
                outboundIds.add(r.id);
              }
            }
          }
        }
        for (const pat of parsed.likePatterns) {
          const inRows = sql<{ channel: string; msgId: string }>`
            SELECT channel, msgId FROM sh_inbound
            WHERE ownerAuthorized = 1 AND text IS NOT NULL AND text LIKE ${pat} ESCAPE '!'
            ORDER BY receivedAt DESC LIMIT 200
          `;
          if (inRows.length >= 200) hitInternalCap = true;
          for (const r of inRows) inboundKeys.add(`${r.channel}:${r.msgId}`);

          const outRows = sql<{ id: string }>`
            SELECT id FROM sh_outbound
            WHERE json_valid(payload)
              AND COALESCE(json_extract(payload, '$.private'), 0) = 0
              AND payload LIKE ${pat} ESCAPE '!'
            ORDER BY createdAt DESC LIMIT 200
          `;
          if (outRows.length >= 200) hitInternalCap = true;
          for (const r of outRows) outboundIds.add(r.id);
        }
      }

      for (const key of inboundKeys) {
        const sep = key.indexOf(":");
        if (sep <= 0) continue;
        const channel = key.slice(0, sep);
        const msgId = key.slice(sep + 1);
        const row = sql<{
          msgId: string;
          text: string | null;
          resolvedThreadId: string | null;
          receivedAt: number;
          ownerAuthorized: number;
        }>`
          SELECT i.msgId, i.text, COALESCE(r.routedThreadId, i.threadId) AS resolvedThreadId,
                 i.receivedAt, i.ownerAuthorized
          FROM sh_inbound i
          LEFT JOIN sh_run r ON r.operationId = 'user:' || i.msgId
          WHERE i.channel = ${channel} AND i.msgId = ${msgId}
        `[0];
        if (!row || row.ownerAuthorized !== 1 || !row.text) continue;
        if (filterThreadId && row.resolvedThreadId !== filterThreadId) continue;

        const meta = getThreadMeta(row.resolvedThreadId);
        const threadArchived = meta?.archived ?? false;
        if (!includeArchived && threadArchived) continue;

        const cleanBody = sanitizeSearchText(row.text, { githubToken });
        if (!cleanBody) continue;
        const rawTitle = meta?.title ?? clipTitle(cleanBody, 48);
        const title = clipTitle(rawTitle);
        const subtitle = meta ? [...meta.repoNames, meta.latestBranch].filter(Boolean).join(" · ") || null : null;

        const evalRes = evaluateCandidateMatch({
          query: parsed,
          title,
          body: cleanBody,
          subtitle,
          threadArchived,
          at: row.receivedAt,
          now,
        });
        if (!evalRes.matched) continue;

        const messageId = `user:${row.msgId}`;
        const { snippet, highlights } = buildSnippet(cleanBody, evalRes.highlightNeedles);
        candidates.push({
          score: evalRes.score,
          hit: {
            id: `msg:${messageId}`,
            kind: "message",
            title,
            subtitle,
            snippet,
            highlights,
            titleHighlights: computeHighlights(title, evalRes.highlightNeedles),
            threadId: meta ? meta.threadId : row.resolvedThreadId,
            threadTitle: meta?.title ?? null,
            threadArchived,
            at: row.receivedAt,
            anchor: {
              type: "message",
              messageId,
              role: "user",
              at: row.receivedAt,
            },
          },
        });
      }

      for (const outId of outboundIds) {
        const row = sql<{
          id: string;
          kind: string;
          threadId: string | null;
          payload: string;
          createdAt: number;
        }>`
          SELECT id, kind, threadId, payload, createdAt
          FROM sh_outbound WHERE id = ${outId}
        `[0];
        if (!row) continue;
        if (filterThreadId && row.threadId !== filterThreadId) continue;

        const extracted = extractOutboundReadable(row, githubToken);
        // Second-layer privacy fence: never return private outbound rows or empty redacted shells.
        if (extracted.private || !extracted.text) continue;

        const meta = getThreadMeta(row.threadId);
        const threadArchived = meta?.archived ?? false;
        if (!includeArchived && threadArchived) continue;

        const title = clipTitle(extracted.cardTitle ?? meta?.title ?? clipTitle(extracted.text, 48));
        const subtitleParts = [
          extracted.cardTitle && meta?.title && extracted.cardTitle !== meta.title ? meta.title : null,
          ...(meta?.repoNames ?? []),
        ].filter((v): v is string => Boolean(v));
        const subtitle = subtitleParts.join(" · ") || null;

        const evalRes = evaluateCandidateMatch({
          query: parsed,
          title,
          body: extracted.text,
          subtitle,
          threadArchived,
          at: row.createdAt,
          now,
        });
        if (!evalRes.matched) continue;

        const { snippet, highlights } = buildSnippet(extracted.text, evalRes.highlightNeedles);
        candidates.push({
          score: evalRes.score,
          hit: {
            id: `msg:${row.id}`,
            kind: "message",
            title,
            subtitle,
            snippet,
            highlights,
            titleHighlights: computeHighlights(title, evalRes.highlightNeedles),
            threadId: meta ? meta.threadId : row.threadId,
            threadTitle: meta?.title ?? null,
            threadArchived,
            at: row.createdAt,
            anchor: {
              type: "message",
              messageId: row.id,
              role: "assistant",
              at: row.createdAt,
            },
          },
        });
      }
    }

    // ---- 3. Reports & Worker Checkpoints/Outcomes (`reports`) -----------------------------------
    if (scope === "all" || scope === "reports") {
      const reportKeys = new Set<string>(); // `${workerId}\0${seq}`

      if (filterThreadId) {
        const scopedReports = sql<{ workerId: string; seq: number }>`
          SELECT workerId, seq FROM sh_report
          WHERE threadId = ${filterThreadId}
          ORDER BY receivedAt DESC, seq DESC LIMIT 200
        `;
        if (scopedReports.length >= 200) hitInternalCap = true;
        for (const r of scopedReports) reportKeys.add(`${r.workerId}\0${r.seq}`);
      } else {
        if (parsed.ftsMatch !== null) {
          try {
            const ftsRows = sql<{ workerId: string; seq: number }>`
              SELECT workerId, CAST(seq AS INTEGER) AS seq FROM sh_report_fts
              WHERE sh_report_fts MATCH ${parsed.ftsMatch}
              ORDER BY bm25(sh_report_fts) LIMIT 100
            `;
            if (ftsRows.length >= 100) hitInternalCap = true;
            for (const r of ftsRows) reportKeys.add(`${r.workerId}\0${Number(r.seq)}`);
          } catch {
            for (const term of parsed.longTerms) {
              const pat = escapeLikePattern(term);
              for (const r of sql<{ workerId: string; seq: number }>`
                SELECT workerId, seq FROM sh_report
                WHERE summary LIKE ${pat} ESCAPE '!'
                   OR COALESCE(answer, '') LIKE ${pat} ESCAPE '!'
                   OR COALESCE(question, '') LIKE ${pat} ESCAPE '!'
                   OR COALESCE(decisions, '') LIKE ${pat} ESCAPE '!'
                   OR COALESCE(leftovers, '') LIKE ${pat} ESCAPE '!'
                   OR COALESCE(changes, '') LIKE ${pat} ESCAPE '!'
                ORDER BY receivedAt DESC LIMIT 100
              `) {
                reportKeys.add(`${r.workerId}\0${r.seq}`);
              }
            }
          }
        }
        for (const pat of parsed.likePatterns) {
          const likeRows = sql<{ workerId: string; seq: number }>`
            SELECT workerId, seq FROM sh_report
            WHERE summary LIKE ${pat} ESCAPE '!'
               OR COALESCE(answer, '') LIKE ${pat} ESCAPE '!'
               OR COALESCE(question, '') LIKE ${pat} ESCAPE '!'
               OR COALESCE(decisions, '') LIKE ${pat} ESCAPE '!'
               OR COALESCE(leftovers, '') LIKE ${pat} ESCAPE '!'
               OR COALESCE(changes, '') LIKE ${pat} ESCAPE '!'
               OR COALESCE(next, '') LIKE ${pat} ESCAPE '!'
            ORDER BY receivedAt DESC LIMIT 200
          `;
          if (likeRows.length >= 200) hitInternalCap = true;
          for (const r of likeRows) reportKeys.add(`${r.workerId}\0${r.seq}`);
        }
      }

      const workerInfoCache = new Map<
        string,
        { agent: string; deviceId: string; branch: string | null; repoId: string | null } | null
      >();
      const getWorkerInfo = (workerId: string) => {
        if (!workerId) return null;
        if (workerInfoCache.has(workerId)) return workerInfoCache.get(workerId)!;
        const w = sql<{
          agent: string;
          deviceId: string;
          branch: string | null;
          repoId: string | null;
        }>`SELECT agent, deviceId, branch, repoId FROM sh_worker WHERE workerId = ${workerId}`[0] ?? null;
        workerInfoCache.set(workerId, w);
        return w;
      };

      for (const key of reportKeys) {
        const sep = key.indexOf("\0");
        if (sep <= 0) continue;
        const workerId = key.slice(0, sep);
        const seq = Number(key.slice(sep + 1));
        const row = sql<{
          workerId: string;
          seq: number;
          threadId: string;
          status: string;
          summary: string;
          answer: string | null;
          question: string | null;
          decisions: string | null;
          leftovers: string | null;
          changes: string | null;
          next: string | null;
          receivedAt: number;
        }>`
          SELECT workerId, seq, threadId, status, summary, answer, question, decisions, leftovers, changes, next, receivedAt
          FROM sh_report WHERE workerId = ${workerId} AND seq = ${seq}
        `[0];
        if (!row) continue;
        if (filterThreadId && row.threadId !== filterThreadId) continue;

        const meta = getThreadMeta(row.threadId);
        const threadArchived = meta?.archived ?? false;
        if (!includeArchived && threadArchived) continue;

        const wInfo = getWorkerInfo(row.workerId);
        const decisions = jsonOrNull<string[]>(row.decisions) ?? [];
        const leftovers = jsonOrNull<string[]>(row.leftovers) ?? [];
        const changes = jsonOrNull<string[]>(row.changes) ?? [];
        const rawSegments = [
          row.summary,
          row.answer ?? "",
          row.question ?? "",
          ...decisions,
          ...leftovers,
          ...changes,
          row.next ?? "",
        ].filter((s) => typeof s === "string" && s.trim().length > 0);
        const cleanBody = sanitizeSearchText(rawSegments.join(" · "), { githubToken });
        if (!cleanBody) continue;

        const cleanSummary = sanitizeSearchText(row.summary, { githubToken, maxChars: 140 });
        const title = clipTitle(cleanSummary || meta?.title || `${wInfo?.agent ?? "worker"} #${row.seq}`);
        const machineLabel = wInfo ? (machineNameById.get(wInfo.deviceId) ?? wInfo.deviceId) : null;
        const subtitle = [
          meta?.title ?? null,
          wInfo ? `${wInfo.agent}@${machineLabel}` : null,
          wInfo?.branch ? sanitizeSearchText(wInfo.branch, { githubToken, maxChars: 80 }) : null,
        ]
          .filter(Boolean)
          .join(" · ") || null;

        const evalRes = evaluateCandidateMatch({
          query: parsed,
          title,
          body: cleanBody,
          subtitle,
          threadArchived,
          at: row.receivedAt,
          now,
        });
        if (!evalRes.matched) continue;

        const { snippet, highlights } = buildSnippet(cleanBody, evalRes.highlightNeedles);
        candidates.push({
          score: evalRes.score,
          hit: {
            id: `report:${row.workerId}:${row.seq}`,
            kind: "report",
            title,
            subtitle,
            snippet,
            highlights,
            titleHighlights: computeHighlights(title, evalRes.highlightNeedles),
            threadId: row.threadId,
            threadTitle: meta?.title ?? null,
            threadArchived,
            at: row.receivedAt,
            anchor: {
              type: "report",
              workerId: row.workerId,
              seq: row.seq,
              timelineId: null,
            },
          },
        });
      }

      // Key anomaly/decision timeline entries (`question`, `stall`, `lost`, `settled`).
      const timelineRows = filterThreadId
        ? sql<{ id: number; threadId: string | null; ts: number; kind: string; text: string; refs: string | null }>`
            SELECT id, threadId, ts, kind, text, refs
            FROM sh_timeline
            WHERE threadId = ${filterThreadId}
              AND kind IN ('question', 'stall', 'lost', 'settled')
            ORDER BY id DESC LIMIT 200
          `
        : sql<{ id: number; threadId: string | null; ts: number; kind: string; text: string; refs: string | null }>`
            SELECT id, threadId, ts, kind, text, refs
            FROM sh_timeline
            WHERE kind IN ('question', 'stall', 'lost', 'settled')
            ORDER BY id DESC LIMIT 200
          `;
      if (timelineRows.length >= 200) hitInternalCap = true;

      for (const entry of timelineRows) {
        const meta = getThreadMeta(entry.threadId);
        const threadArchived = meta?.archived ?? false;
        if (!includeArchived && threadArchived) continue;

        const refs = jsonOrNull<{ workerId?: unknown; seq?: unknown }>(entry.refs);
        const workerId = typeof refs?.workerId === "string" ? refs.workerId : "";
        const refSeq = typeof refs?.seq === "number" && Number.isInteger(refs.seq) ? refs.seq : null;

        const cleanBody = sanitizeSearchText(entry.text, { githubToken });
        if (!cleanBody) continue;

        const wInfo = workerId ? getWorkerInfo(workerId) : null;
        const machineLabel = wInfo ? (machineNameById.get(wInfo.deviceId) ?? wInfo.deviceId) : null;
        const title = clipTitle(meta?.title ?? cleanBody);
        const subtitle = [
          wInfo ? `${wInfo.agent}@${machineLabel}` : null,
          entry.kind,
        ]
          .filter(Boolean)
          .join(" · ") || null;

        const evalRes = evaluateCandidateMatch({
          query: parsed,
          title,
          body: cleanBody,
          subtitle,
          threadArchived,
          at: entry.ts,
          now,
        });
        if (!evalRes.matched) continue;

        const { snippet, highlights } = buildSnippet(cleanBody, evalRes.highlightNeedles);
        candidates.push({
          score: evalRes.score,
          hit: {
            id: `timeline:${entry.id}`,
            kind: "report",
            title,
            subtitle,
            snippet,
            highlights,
            titleHighlights: computeHighlights(title, evalRes.highlightNeedles),
            threadId: entry.threadId,
            threadTitle: meta?.title ?? null,
            threadArchived,
            at: entry.ts,
            anchor: {
              type: "report",
              workerId,
              seq: refSeq,
              timelineId: entry.id,
            },
          },
        });
      }

      // Non-report terminal worker outcomes (e.g. `start_failed:...`, `resume_failed:...`, `error:auth`, `reaped`).
      const outcomeWorkers = filterThreadId
        ? sql<{
            workerId: string;
            threadId: string;
            agent: string;
            deviceId: string;
            branch: string | null;
            lastOutcome: string;
            updatedAt: number;
          }>`
            SELECT workerId, threadId, agent, deviceId, branch, lastOutcome, updatedAt
            FROM sh_worker
            WHERE threadId = ${filterThreadId}
              AND lastOutcome IS NOT NULL
              AND lastOutcome NOT LIKE 'reported:%'
            ORDER BY updatedAt DESC LIMIT 100
          `
        : sql<{
            workerId: string;
            threadId: string;
            agent: string;
            deviceId: string;
            branch: string | null;
            lastOutcome: string;
            updatedAt: number;
          }>`
            SELECT workerId, threadId, agent, deviceId, branch, lastOutcome, updatedAt
            FROM sh_worker
            WHERE lastOutcome IS NOT NULL
              AND lastOutcome NOT LIKE 'reported:%'
            ORDER BY updatedAt DESC LIMIT 100
          `;
      for (const w of outcomeWorkers) {
        const meta = getThreadMeta(w.threadId);
        const threadArchived = meta?.archived ?? false;
        if (!includeArchived && threadArchived) continue;

        const cleanOutcome = sanitizeSearchText(w.lastOutcome, { githubToken, maxChars: 240 });
        if (!cleanOutcome) continue;
        const machineLabel = machineNameById.get(w.deviceId) ?? w.deviceId;
        const title = clipTitle(`${w.agent}@${machineLabel} (${cleanOutcome})`);
        const subtitle = [meta?.title ?? null, w.branch ? sanitizeSearchText(w.branch, { githubToken, maxChars: 80 }) : null]
          .filter(Boolean)
          .join(" · ") || null;

        const evalRes = evaluateCandidateMatch({
          query: parsed,
          title,
          body: cleanOutcome,
          subtitle,
          threadArchived,
          at: w.updatedAt,
          now,
        });
        if (!evalRes.matched) continue;

        const { snippet, highlights } = buildSnippet(cleanOutcome, evalRes.highlightNeedles);
        candidates.push({
          score: evalRes.score,
          hit: {
            id: `worker:${w.workerId}`,
            kind: "report",
            title,
            subtitle,
            snippet,
            highlights,
            titleHighlights: computeHighlights(title, evalRes.highlightNeedles),
            threadId: w.threadId,
            threadTitle: meta?.title ?? null,
            threadArchived,
            at: w.updatedAt,
            anchor: {
              type: "report",
              workerId: w.workerId,
              seq: null,
              timelineId: null,
            },
          },
        });
      }
    }

    // ---- 4. PR Watch Diagnostics & Review Feedback (`pr`) ---------------------------------------
    if (scope === "all" || scope === "pr") {
      const watches = filterThreadId
        ? sql<{
            id: string;
            threadId: string;
            url: string;
            status: string;
            head: string | null;
            observedState: string | null;
            checkedAt: number | null;
            createdAt: number;
          }>`
            SELECT id, threadId, url, status, head, observedState, checkedAt, createdAt
            FROM sh_pr_watch
            WHERE threadId = ${filterThreadId}
            ORDER BY (status = 'active') DESC, COALESCE(checkedAt, createdAt) DESC LIMIT 100
          `
        : sql<{
            id: string;
            threadId: string;
            url: string;
            status: string;
            head: string | null;
            observedState: string | null;
            checkedAt: number | null;
            createdAt: number;
          }>`
            SELECT id, threadId, url, status, head, observedState, checkedAt, createdAt
            FROM sh_pr_watch
            ORDER BY (status = 'active') DESC, COALESCE(checkedAt, createdAt) DESC LIMIT 100
          `;
      if (watches.length >= 100) hitInternalCap = true;

      for (const watch of watches) {
        const meta = getThreadMeta(watch.threadId);
        const threadArchived = meta?.archived ?? false;
        if (!includeArchived && threadArchived) continue;

        const parsedTarget = parsePrUrl(watch.url);
        const prShort = parsedTarget
          ? `${parsedTarget.owner}/${parsedTarget.repo}#${parsedTarget.number}`
          : sanitizeSearchText(watch.url, { githubToken, maxChars: 140 });

        const diagRows = sql<{
          head: string;
          snapshotJson: string;
          diagnosisJson: string | null;
          updatedAt: number;
        }>`
          SELECT head, snapshotJson, diagnosisJson, updatedAt
          FROM sh_pr_watch_diagnosis
          WHERE watchId = ${watch.id}
          ORDER BY updatedAt DESC LIMIT 5
        `;

        const fbRow = sql<{
          head: string;
          baseRef: string | null;
          headRef: string | null;
          mergeState: string;
          reviewDecision: string;
          snapshotJson: string;
          triageJson: string | null;
          updatedAt: number;
        }>`
          SELECT head, baseRef, headRef, mergeState, reviewDecision, snapshotJson, triageJson, updatedAt
          FROM sh_pr_watch_feedback
          WHERE watchId = ${watch.id}
        `[0] ?? null;

        // Collect per-head PR candidate records (current head combines latest feedback + diagnosis;
        // older commit heads with failure diagnostics remain independently searchable).
        const headsToCheck = new Set<string>();
        if (watch.head) headsToCheck.add(watch.head);
        if (fbRow?.head) headsToCheck.add(fbRow.head);
        for (const d of diagRows) headsToCheck.add(d.head);
        if (headsToCheck.size === 0) headsToCheck.add("");

        for (const headKey of headsToCheck) {
          const diagRow = diagRows.find((d) => d.head === headKey) ?? null;
          const useFb = fbRow && (headKey === "" || fbRow.head === headKey) ? fbRow : null;

          const segments: string[] = [watch.url, prShort];
          let primaryHeadline: string | null = null;
          let latestAt = watch.checkedAt ?? watch.createdAt;

          if (diagRow) {
            latestAt = Math.max(latestAt, diagRow.updatedAt);
            const snap = jsonOrNull<PrFailureSnapshot>(diagRow.snapshotJson);
            const storedDiag = jsonOrNull<PrFailureDiagnosis>(diagRow.diagnosisJson);
            if (snap && Array.isArray(snap.items)) {
              const effectiveDiag = storedDiag ?? buildDeterministicPrDiagnosis(snap, watch.url);
              primaryHeadline = effectiveDiag.headline;
              segments.push(
                effectiveDiag.headline,
                ...effectiveDiag.rootCauses,
                effectiveDiag.suggestedFixBrief,
              );
              for (const item of snap.items) {
                segments.push(
                  item.name,
                  item.failedStep ?? "",
                  item.summaryText ?? "",
                  item.logExcerpt ?? "",
                );
                for (const ann of item.annotations ?? []) {
                  segments.push(`${ann.path}:${ann.line}`, ann.title ?? "", ann.message);
                }
              }
            }
          }

          if (useFb) {
            latestAt = Math.max(latestAt, useFb.updatedAt);
            if (useFb.headRef) segments.push(useFb.headRef);
            if (useFb.baseRef) segments.push(useFb.baseRef);
            if (useFb.mergeState === "conflicted") segments.push("conflicted 合并冲突");
            const fbSnap = jsonOrNull<PrFeedbackSnapshot>(useFb.snapshotJson);
            const storedTriage = jsonOrNull<PrFeedbackTriage>(useFb.triageJson);
            if (fbSnap) {
              const effectiveTriage = storedTriage ?? buildDeterministicPrFeedbackTriage(fbSnap, watch.url);
              primaryHeadline ??= effectiveTriage.headline;
              segments.push(
                effectiveTriage.headline,
                ...effectiveTriage.actionItems,
                effectiveTriage.suggestedRevisionBrief,
              );
              for (const rev of fbSnap.reviewers ?? []) {
                segments.push(`@${rev.author}`, rev.state, rev.body ?? "");
              }
              for (const th of fbSnap.threads ?? []) {
                segments.push(
                  `@${th.author}`,
                  `${th.path}:${th.line}`,
                  th.body,
                  th.latestReplyAuthor ? `@${th.latestReplyAuthor}` : "",
                  th.latestReplyBody ?? "",
                );
              }
            }
          }

          const cleanBody = sanitizeSearchText(
            segments.filter((s) => typeof s === "string" && s.trim().length > 0).join(" · "),
            { githubToken },
          );
          if (!cleanBody) continue;

          const cleanHeadline = primaryHeadline
            ? sanitizeSearchText(primaryHeadline, { githubToken, maxChars: 120 })
            : "";
          const title = clipTitle(cleanHeadline ? `${prShort} — ${cleanHeadline}` : prShort);
          const subtitle = [
            meta?.title ?? null,
            headKey ? headKey.slice(0, 7) : null,
            useFb?.headRef ? sanitizeSearchText(useFb.headRef, { githubToken, maxChars: 60 }) : null,
          ]
            .filter(Boolean)
            .join(" · ") || null;

          const evalRes = evaluateCandidateMatch({
            query: parsed,
            title,
            body: cleanBody,
            subtitle,
            threadArchived,
            at: latestAt,
            now,
          });
          if (!evalRes.matched) continue;

          const { snippet, highlights } = buildSnippet(cleanBody, evalRes.highlightNeedles);
          const resolvedHead = headKey || null;
          candidates.push({
            score: evalRes.score,
            hit: {
              id: `pr:${watch.id}:${resolvedHead ?? "none"}`,
              kind: "pr_watch",
              title,
              subtitle,
              snippet,
              highlights,
              titleHighlights: computeHighlights(title, evalRes.highlightNeedles),
              threadId: watch.threadId,
              threadTitle: meta?.title ?? null,
              threadArchived,
              at: latestAt,
              anchor: {
                type: "pr_watch",
                watchId: watch.id,
                head: resolvedHead,
                url: watch.url,
              },
            },
          });
        }
      }
    }

    // ---- 5. Layered Memory (`memory`: decay-neutral read over `sh_note` + `sh_note_fts`) ---------
    if (scope === "all" || scope === "memory") {
      const scopedRepoIds = filterThreadId ? new Set(getThreadMeta(filterThreadId)?.repoIds ?? []) : null;
      const noteIds = new Set<string>();

      if (parsed.ftsMatch !== null) {
        try {
          const ftsNotes = sql<{ noteId: string }>`
            SELECT n.noteId
            FROM sh_note_fts f JOIN sh_note n ON n.rowid = f.rowid
            WHERE sh_note_fts MATCH ${parsed.ftsMatch}
              AND n.status != 'removed'
            ORDER BY bm25(sh_note_fts) LIMIT 80
          `;
          if (ftsNotes.length >= 80) hitInternalCap = true;
          for (const r of ftsNotes) noteIds.add(r.noteId);
        } catch {
          for (const term of parsed.longTerms) {
            const pat = escapeLikePattern(term);
            for (const r of sql<{ noteId: string }>`
              SELECT noteId FROM sh_note
              WHERE status != 'removed' AND text LIKE ${pat} ESCAPE '!'
              ORDER BY pinned DESC, createdAt DESC LIMIT 80
            `) {
              noteIds.add(r.noteId);
            }
          }
        }
      }
      for (const pat of parsed.likePatterns) {
        const likeNotes = sql<{ noteId: string }>`
          SELECT noteId FROM sh_note
          WHERE status != 'removed' AND text LIKE ${pat} ESCAPE '!'
          ORDER BY pinned DESC, createdAt DESC LIMIT 120
        `;
        if (likeNotes.length >= 120) hitInternalCap = true;
        for (const r of likeNotes) noteIds.add(r.noteId);
      }

      for (const noteId of noteIds) {
        // `notes.get` is strictly read-only: attaches `StaleMark` without touching `useCount` or `lastUsedAt`.
        const note: NoteRow | null = notes.get(noteId);
        if (!note || note.status === "removed") continue;
        if (scopedRepoIds !== null && note.layer !== "resident") {
          if (!note.scopeRepoId || !scopedRepoIds.has(note.scopeRepoId)) continue;
        }

        const repoLabel = note.scopeRepoId ? (repoNameById.get(note.scopeRepoId) ?? note.scopeRepoId) : null;
        const rawNoteBody = note.stale?.text ? `${note.text} (${note.stale.text})` : note.text;
        const cleanBody = sanitizeSearchText(rawNoteBody, { githubToken });
        if (!cleanBody) continue;

        const cleanFirstLine = sanitizeSearchText(note.text.split("\n")[0] ?? note.text, {
          githubToken,
          maxChars: 120,
        });
        const title = clipTitle(cleanFirstLine || note.noteId);
        const subtitle = [note.layer, repoLabel, note.kind].filter(Boolean).join(" · ") || null;

        const evalRes = evaluateCandidateMatch({
          query: parsed,
          title,
          body: cleanBody,
          subtitle,
          threadArchived: note.layer === "archive" || note.status === "superseded",
          at: note.createdAt,
          now,
        });
        if (!evalRes.matched) continue;

        const { snippet, highlights } = buildSnippet(cleanBody, evalRes.highlightNeedles);
        candidates.push({
          score: evalRes.score + (note.pinned ? 3 : 0) + (note.status === "active" ? 2 : 0),
          hit: {
            id: `mem:${note.noteId}`,
            kind: "memory",
            title,
            subtitle,
            snippet,
            highlights,
            titleHighlights: computeHighlights(title, evalRes.highlightNeedles),
            threadId: null,
            threadTitle: null,
            threadArchived: false,
            at: note.createdAt,
            anchor: {
              type: "memory",
              noteId: note.noteId,
              layer: note.layer,
              scopeRepoId: note.scopeRepoId,
            },
          },
        });
      }
    }

    // Deduplicate by `hit.id` (keeping highest score) and sort deterministically.
    const deduped = new Map<string, ScoredHit>();
    for (const entry of candidates) {
      const existing = deduped.get(entry.hit.id);
      if (!existing || entry.score > existing.score) {
        deduped.set(entry.hit.id, entry);
      }
    }
    const sorted = [...deduped.values()].sort(
      (a, b) => b.score - a.score || b.hit.at - a.hit.at || a.hit.id.localeCompare(b.hit.id),
    );

    if (scope !== "all") {
      const items = sorted.slice(0, limit).map((s) => s.hit);
      return {
        q: parsed.normalized,
        scope,
        items,
        truncated: hitInternalCap || sorted.length > items.length,
      };
    }

    // Quota-balanced selection for `scope === "all"`:
    // 1) Guarantee up to 1 top hit per matching `kind` so long chat logs never starve memory/PR hits;
    // 2) Cap any single `kind` at 60% of `limit` (`Math.max(1, Math.ceil(limit * 0.6))`).
    const maxPerKind = Math.max(1, Math.ceil(limit * 0.6));
    const selected: ScoredHit[] = [];
    const selectedIds = new Set<string>();
    const countByKind = new Map<WorkspaceSearchItemKind, number>();

    const seenFirstKind = new Set<WorkspaceSearchItemKind>();
    for (const entry of sorted) {
      if (selected.length >= limit) break;
      if (seenFirstKind.has(entry.hit.kind)) continue;
      seenFirstKind.add(entry.hit.kind);
      selected.push(entry);
      selectedIds.add(entry.hit.id);
      countByKind.set(entry.hit.kind, 1);
    }

    for (const entry of sorted) {
      if (selected.length >= limit) break;
      if (selectedIds.has(entry.hit.id)) continue;
      const currentCount = countByKind.get(entry.hit.kind) ?? 0;
      if (currentCount >= maxPerKind) continue;
      selected.push(entry);
      selectedIds.add(entry.hit.id);
      countByKind.set(entry.hit.kind, currentCount + 1);
    }

    selected.sort(
      (a, b) => b.score - a.score || b.hit.at - a.hit.at || a.hit.id.localeCompare(b.hit.id),
    );

    return {
      q: parsed.normalized,
      scope,
      items: selected.map((s) => s.hit),
      truncated: hitInternalCap || sorted.length > selected.length,
    };
  };

  return { query };
}

export type WorkspaceSearch = ReturnType<typeof createWorkspaceSearch>;
