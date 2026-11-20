// The memory module's ledger half (issue #5, steward.md §2): every sh_* table belongs to this
// file and callers reach it only through the returned interface — never with raw SQL. The
// event reducer (§5.1-5.3) is deterministic, runs in one transaction, and recomputes Thread
// derived state (`running / waiting_you / idle`) plus unread after every change. Notes (the
// knowledge half, issue #18) live in notes.ts behind the `notes` handle below — same rule:
// sh_note* is reached only through the memory module. The situation brief's character
// budget is brief.ts's.
import {
  ulid,
  AgentModelObservationSchema,
  capabilityOf,
  MAX_GLOBAL_AUTO_SIBLINGS,
  MAX_IN_FLIGHT_SIBLINGS_PER_THREAD,
  MAX_PENDING_OWNER_PROPOSALS,
  MAX_PROPOSAL_DEPTH,
  MAX_PROPOSALS_PER_WORKER,
  normalizeReportLabels,
  PROPOSAL_CONFIRM_TTL_MS,
  ProposalEventSchema,
  REPO_SKILL_HELLO_MAX_ITEMS,
  RepoSkillBriefSchema,
  type AgentModelCatalog,
  type AgentModelObservation,
  type ProposalKind,
  type ProposalRejectCode,
  type ProposalStatus,
  type RepoSkillBrief,
  type RepoSkillSummary,
  type RepoSkillTarget,
  type ReportLabel,
} from "@isaac2ingrid/protocol";
import type { GitFacts, HelloMessage } from "@isaac2ingrid/protocol";
import { createBudget } from "./budget.ts";
import { createNotes, type NoteRow } from "./notes.ts";
import { assembleBrief, type BriefDecision, type HandoffBrief } from "./handoff.ts";
import { escapeMarkers, eventWakeText, externalActivityWakeText, queueReturnedWakeText } from "./wake-text.ts";
import { createMachineStatus, type MachineReliability } from "./machine-status.ts";
import type { StartWorkerInput } from "./dispatch.ts";
import type { QuietSection } from "./report-template.ts";
import type { PrFailureSnapshot } from "./pr-evidence.ts";
import { buildDeterministicPrDiagnosis, type PrDiagnosisStatus, type PrFailureDiagnosis } from "./pr-failure-diagnoser.ts";

/** Tagged-template SQL over the DO's SQLite (same shape schema.ts migrations use). */
export type LedgerSql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/** Thread summaries are capped (steward.md §2.6). */
export const MAX_THREAD_SUMMARY = 600;
/** §2.6: the module keeps the last N summary versions per Thread. */
export const SUMMARY_VERSIONS_KEPT = 5;
/** §2.6: every Nth cumulative summary update is a from-scratch rewrite (anti-drift). */
export const SUMMARY_REWRITE_EVERY = 10;
/** The wake merge window (steward.md §5.1/§5.4): events within it become one steward input. */
export const WAKE_MERGE_MS = 3_000;
/** The quiet merge window (issue #11, spec §7.6 / steward.md §6.4): `urgency: quiet` outbound
 *  holds this long per channel+receiver, so notifications landing together leave as one. */
export const QUIET_MERGE_MS = 60_000;
/** steward.md §5.3: external_activity wakes merge over a 10-minute window (low priority). */
export const EXTERNAL_ACTIVITY_MERGE_MS = 10 * 60_000;
/** Blocked reports give the steward this long before the core forwards the question. */
export const QUESTION_WINDOW_MS = 90_000;
/** The workspace shows this many recent messages and per-Thread timeline entries; decisions
 *  stay listed while they are open, but cards older than this window are never offered. */
export const WORKSPACE_MESSAGES = 120;
export const WORKSPACE_TIMELINE = 40;
export const WORKSPACE_DECISION_WINDOW_MS = 60 * 86_400_000;

/** Runs a synchronous closure atomically (`ctx.storage.transactionSync`, steward.md §1). */
export interface LedgerDeps {
  sql: LedgerSql;
  tx: <T>(fn: () => T) => T;
  now?: () => number;
  /** The quiet merge window (issue #11); overridable so tests shrink it. */
  quietWindowMs?: () => number;
}

// ---- relay (issue #8, spec §5.3) ------------------------------------------------------------------

export type { HandoffBrief };
export type { BriefDecision };

// ---- domain shapes (subset of steward.md §2.2 columns) -----------------------------------------

export type ThreadState = "running" | "waiting_you" | "idle";
/** Worker states that keep a Thread `running` (steward.md §5.2); lost/broken do not count. */
export const ACTIVE_WORKER_STATES = ["queued", "starting", "running", "recovering"] as const;

/**
 * The question a wake row is about, when its dedupeKey names one. Report and failure-class
 * settles open `q_<workerId>_<seq>` (their dedupeKey is `report:`/`settled:` + the same pair);
 * a worker's own question names the qid outright. Everything else (routines, external
 * activity, queue returns) has no question, and returns null.
 */
export function wakeQuestionId(dedupeKey: string): string | null {
  const fire = /^(?:report|settled):(.+):(\d+)$/.exec(dedupeKey);
  if (fire) return `q_${fire[1]}_${fire[2]}`;
  return dedupeKey.startsWith("question:") ? dedupeKey.slice("question:".length) : null;
}

export interface ThreadRow {
  threadId: string;
  title: string;
  goal: string | null;
  summary: string | null;
  summaryAt: number | null;
  state: ThreadState;
  unread: boolean;
  lastMachine: string | null;
  lastActivityAt: number;
  archived: boolean;
  createdFromMsg: string | null;
  createdAt: number;
}

export type WorktreeStatus = "active" | "cleaning" | "cleaned" | "cleanup_blocked" | "none";

export interface WorkerRow {
  workerId: string;
  threadId: string;
  deviceId: string;
  repoId: string | null;
  agent: string;
  mode: string;
  state: string;
  worktreeStatus?: WorktreeStatus;
  requestedModel?: string | null;
  modelSource?: 'agent-default' | 'task-default' | 'override';
  launchObservedModel?: AgentModelObservation | null;
  lastObservedModel?: AgentModelObservation | null;
  /** A disconnected machine does not imply the session failed. */
  unreachable?: boolean;
  sessionId: string | null;
  branch: string | null;
  cmdId: string | null;
  /** The worker this one continues from (relay) or was proposed by (sibling). */
  parentWorker: string | null;
  /** ADR-0022 Decision 6: `'relay'` main chain vs `'sibling'` read-only probe. */
  workerRelation?: "relay" | "sibling";
  /** ADR-0022 Decision 6: `0` for main-chain workers, `1` for spawned sibling probes. */
  proposalDepth?: number;
  lastOutcome: string | null;
  lastEventAt: number | null;
  lastProgress: string | null;
  /** Last-reported context usage in percent (settled.usage.contextUsage) — the
   *  resume-vs-new-session input for high context usage (issue #8, connector-pi §11.2). */
  contextPercent: number | null;
  createdAt: number;
}

export interface ReportRow {
  workerId: string;
  seq: number;
  threadId: string;
  status: "done" | "blocked" | "needs_decision";
  summary: string;
  changes: string[] | null;
  decisions: string[] | null;
  leftovers: string[] | null;
  labels?: ReportLabel[] | null;
  tests: { ran: boolean; passed?: boolean; note?: string } | null;
  question: string | null;
  next: string | null;
  git: GitFacts | null;
  answer: string | null;
}

/** Git facts merged into the report event by the connector (connector-pi.md §7.2).
 *  Imported from @isaac2ingrid/protocol so both ends share one shape (issue #8 adds the
 *  pointer fields; they are optional for connectors predating relay briefs). */
export type { GitFacts };

export interface QuestionRow {
  qid: string;
  /** Null for ask_user's threadless routing questions (issue #7, steward.md §3.3). */
  threadId: string | null;
  workerId: string | null;
  text: string;
  status: "open" | "answered";
  askedAt: number;
  answeredAt: number | null;
  kind: "steward" | "report" | "failure" | "unreported";
  fallbackDueAt: number | null;
  handledAt: number | null;
}

/** The ask_user question's button mapping (issue #7): what each card button means. */
export interface AskCandidates {
  options: string[];
  candidates: Array<{ threadId: string; label: string }>;
}

export interface TimelineRow {
  id: number;
  threadId: string;
  ts: number;
  kind: string;
  text: string;
}

export interface MachineRow {
  deviceId: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  agents: string[];
  agentCapabilities?: Record<string, Record<string, boolean>>;
  modelCatalogs?: Record<string, AgentModelCatalog>;
  maxWorkers: number;
  /** The connector process generation (protocol §6.1): changes on every connector restart. */
  bootId: string | null;
  reliability?: MachineReliability | null;
}

export interface ProposalRow {
  id: string;
  workerId: string;
  seq: number;
  threadId: string;
  kind: ProposalKind;
  proposalKey: string;
  dedupeKey: string;
  targetRepoRef: string;
  targetRepoId: string | null;
  targetDeviceId: string | null;
  selectedAgent: string | null;
  prompt: string;
  reason: string;
  status: ProposalStatus;
  rejectCode: ProposalRejectCode | null;
  spawnedWorkerId: string | null;
  cmdId: string | null;
  createdAt: number;
  expiresAt: number | null;
  decidedBy: string | null;
  decidedAt: number | null;
}

export interface RepoSummaryRow {
  repoId: string;
  deviceId: string;
  name: string;
  online: boolean;
  capabilityKind: "git" | "plain";
  hasSetupHook: boolean;
  hasArchiveHook: boolean;
  approved: boolean;
}

export interface RepoContextRow {
  projectApproved: boolean;
  skills: RepoSkillBrief[];
}

export type SkillOfferStatus = "offered" | "saving" | "saved" | "failed" | "dismissed";

export interface SkillOfferRow {
  id: string;
  workerId: string;
  threadId: string;
  deviceId: string;
  repoId: string;
  target: RepoSkillTarget;
  slug: string;
  name: string;
  description: string;
  summaryBullets: string[];
  markdown: string;
  status: SkillOfferStatus;
  savedPath: string | null;
  savedSha256: string | null;
  failureReason: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface OfflineDispatchRow {
  cmdId: string;
  threadId: string;
  deviceId: string;
  input: StartWorkerInput;
  status: "offered" | "waiting" | "switching" | "switched" | "cancelled";
  choices: string[];
}

/** A notification intent persisted by the reducer (steward.md §5.1 step 4). */
export interface NotifyRow {
  id: number;
  dedupeKey: string;
  kind:
    | "done_report"
    | "attention_report"
    | "failure_push"
    | "stall_notice"
    | "machine_offline"
    | "machine_online"
    | "waited_started"
    | "pr_created"
    | "pr_failed"
    | "proposal_confirm";
  threadId: string;
  workerId: string | null;
  questionId: string | null;
  /** Issue #21: render inputs that belong to the intent (a pr_created's url/branch, a
   *  pr_failed's stage/message) — JSON, read by the renderer, written by the reducer. */
  payload: string | null;
}

export type ProposalDecisionOutcome =
  | {
      status: "approved";
      appliedNow: true;
      proposal: ProposalRow;
      spawnedWorkerId: string;
      cmdId: string;
    }
  | {
      status: "already_decided";
      appliedNow: false;
      proposal: ProposalRow;
    }
  | {
      status: "declined";
      appliedNow: boolean;
      proposal: ProposalRow;
    }
  | {
      status: "expired";
      appliedNow: boolean;
      proposal: ProposalRow;
    }
  | {
      status: "rejected";
      appliedNow: true;
      rejectCode: ProposalRejectCode;
      proposal: ProposalRow;
    }
  | {
      status: "not_found";
      appliedNow: false;
      proposal: null;
    };

/** The consent gate's durable state (issue #21): the user's tap on a done card's
 *  [同意]/[先不要], the pr_worker command it sent, and the async result that came back. */
export interface PrConsentRow {
  workerId: string;
  seq: number;
  threadId: string;
  decision: "approved" | "declined";
  cmdId: string | null;
  attempts: number;
  url: string | null;
  failure: string | null;
  decidedAt: number;
  updatedAt: number;
}

/** A worker in an active state, plus its machine's connection state (issue #13 review: the
 * reap sweep needs WHEN the machine went offline, not just that it is offline now). */
export interface SilentWorker extends WorkerRow {
  machineOnline: boolean;
  machineLastSeen: number;
}

/** A durable wake_request (steward.md §5.1 step 4): one future steward input. */
export interface WakeRow {
  id: number;
  operationId: string;
  kind: "event" | "routine" | "followup" | "watchdog";
  dedupeKey: string;
  text: string;
  priority: "low" | "normal" | "high";
  /** 'skipped' = the daily budget cap kept this wake from the model (issue #28, steward.md §12). */
  status: "pending" | "merged" | "submitted" | "skipped";
  dueAt: number;
  mergedInto: number | null;
  createdAt: number;
  submittedAt: number | null;
}

/** One steward run (steward.md §6.3): a submitted input and how its outcome is handled. */
export interface RunRow {
  operationId: string;
  kind: "user" | "event" | "routine" | "followup" | "verify" | "watchdog";
  replyTo: string | null;
  channel: string | null;
  routedThreadId: string | null;
  text: string;
  /** `cancelled` is ADR-0017's terminal state for a turn the owner stopped: the input was
   *  withdrawn before it acted (pi settles it `unanswered`/`aborted`), never a failure. */
  status: "open" | "settled" | "cancelled";
  resultStatus: string | null;
  resultReason: string | null;
  resultText: string | null;
  replyOutboundId: string | null;
  /** The run already produced user-facing output (notify_user/ask_user) — an empty final
   *  text is then legitimate, not a failure (review #9). */
  notified: boolean;
  /** Real dispatches inside this run (settle-time verification, issue #7). */
  dispatchCount: number;
  createdAt: number;
  settledAt: number | null;
}

// ---- routing (steward.md §3, issue #7) -----------------------------------------------------------

/** One row of findCandidates' answer. */
export interface RouteCandidate {
  threadId: string;
  title: string;
  /** One-line summary (null when the thread has none yet). */
  summary: string | null;
  repos: string[];
  state: ThreadState;
  lastActivityAt: number;
  /** Why this candidate is here: 进行中 / 等你拍板 / 关键词命中 / 最近活跃 / 回复指向. */
  matchReason: string;
  /** Below the recall cutoff's confidence band — attach on it alone is exactly the guess
   *  the confidence gate exists to stop (spike eval tuning). */
  weak: boolean;
}

/** §3.2's answer: an explicit short-circuit, or the assembled candidate set. */
export interface RouteCandidates {
  confidence: "explicit" | "candidates";
  /** Set iff confidence is "explicit": the one thread signals 1–2 resolved to. */
  explicitThread: RouteCandidate | null;
  candidates: RouteCandidate[];
}

/** How many threads each recall bucket contributes (§3.2). */
export const FTS_RECALL_LIMIT = 8;
export const RECENT_RECALL_LIMIT = 5;
/** The assembled set never exceeds this (§3.2). */
export const CANDIDATE_CAP = 12;
/** Bigram overlap at or above this counts as a real match (the spike eval's cutoff). */
export const RECALL_SCORE_CUTOFF = 2;
/** Weak below this — informative, but never attachable alone. */
export const RECALL_WEAK_BELOW = 5;

const routeSummaryOf = (summary: string | null): string | null =>
  summary && summary.length > 0 ? (summary.length > 120 ? `${summary.slice(0, 119)}…` : summary) : null;

/**
 * The recall scorer behind findCandidates (spike-final's eval-tuned algorithm, ported):
 * CJK has no spaces, so overlap is scored by character-bigram hits plus latin word matches —
 * 「依赖升级…」 finds 「升级依赖」, and 「文档补完」 finds 「补 API 文档」. It covers the
 * 2-character queries the trigram FTS index cannot match, and ranks the FTS-recalled bucket.
 */
export function recallScore(query: string, haystack: string): number {
  const q = query.toLowerCase();
  const hay = haystack.toLowerCase();
  const gramSet = (text: string): Set<string> => {
    const set = new Set<string>();
    const chars = [...text];
    for (let i = 0; i < chars.length - 1; i++) {
      if (!/\s/.test(chars[i]!) && !/\s/.test(chars[i + 1]!)) set.add(chars[i]! + chars[i + 1]!);
    }
    return set;
  };
  const grams = gramSet(q);
  const hayGrams = gramSet(hay);
  const gramHits = [...grams].filter((g) => hayGrams.has(g)).length;
  const latin = q.match(/[a-z0-9_./-]{2,}/g) ?? [];
  const latinHits = latin.filter((t) => hay.includes(t)).length;
  return gramHits + latinHits * 2;
}

/** The FTS5 MATCH expression for findCandidates: latin segments ≥3 chars stay whole (word
 *  matches), CJK text contributes every 3-character window (the trigram index matches
 *  substrings, so a whole long phrase would never hit). Quotes are stripped so user text can
 *  never inject FTS operators; terms dedupe; the count stays bounded for long inputs. */
export function ftsMatchExpression(text: string): string | null {
  const terms = new Set<string>();
  for (const segment of text.split(/[\s\p{P}\p{S}]+/u)) {
    const clean = segment.replace(/"/g, "").trim();
    if (clean.length === 0) continue;
    if (/^[a-z0-9_./-]+$/i.test(clean)) {
      if ([...clean].length >= 3) terms.add(clean.toLowerCase());
      continue;
    }
    const chars = [...clean];
    for (let i = 0; i + 2 < chars.length; i++) terms.add(chars.slice(i, i + 3).join(""));
    if (chars.length === 3) terms.add(clean);
  }
  const ordered = [...terms].slice(0, 24);
  if (ordered.length === 0) return null;
  return ordered.map((term) => `"${term}"`).join(" OR ");
}

// ---- proactive behavior (issue #20, steward.md §8) ----------------------------------------------

export type RoutineKind = "digest" | "instruction";
export type RoutineStatus = "active" | "paused" | "done" | "cancelled";
export type FollowupStatus = "open" | "fired" | "cancelled";

export interface RoutineRow {
  routineId: string;
  kind: RoutineKind;
  createdFromMsg: string;
  scheduleKind: "cron" | "once";
  cron: string | null;
  onceAt: number | null;
  instruction: string;
  repoId: string | null;
  threadId: string | null;
  status: RoutineStatus;
  scheduleId: string | null;
  lastRunAt: number | null;
  /** The latest processed `routine:<id>:<fireTime>` — the fire-level idempotency key. */
  lastFireKey: string | null;
  lastResult: string | null;
  outcomeRecorded: boolean;
  createdAt: number;
}

export interface FollowupRow {
  followupId: string;
  threadId: string;
  dueAt: number;
  reason: string;
  createdBy: "user" | "steward";
  sourceRef: string;
  status: FollowupStatus;
  scheduleId: string | null;
  /** When it fired — the freshness bound for using it as a provenance ref (review #47-5). */
  firedAt: number | null;
  lastResult: string | null;
  outcomeRecorded: boolean;
  createdAt: number;
}

/** A routine suggestion waiting for the owner's button tap (steward.md §8.5). */
export interface RoutineOfferRow {
  offerId: string;
  spec: RoutineSpecStored;
  sourceMsg: string;
  status: "offered" | "accepted" | "dismissed";
  outboundId: string | null;
  createdAt: number;
}

/** The offer's stored spec (JSON in sh_routine_offer.spec). */
export interface RoutineSpecStored {
  instruction: string;
  kind: RoutineKind;
  cron?: string;
  onceAt?: number;
  threadId?: string;
  repoId?: string;
}

// ---- web read model (steward.md §10: pages are served from the memory module's views) -------------

/** L2 Timeline view: thread header, its summary events, its workers with machine names. */
export interface TimelineView {
  thread: ThreadRow;
  entries: TimelineRow[];
  workers: Array<WorkerRow & { machineName: string }>;
  openQuestion: QuestionRow | null;
}

/** L1 Thread-list row: the thread plus the situation bits the index page shows (spec §7.4). */
export interface ThreadListEntry {
  thread: ThreadRow;
  lastWorker: (WorkerRow & { machineName: string }) | null;
  workerCount: number;
}

export interface NewThreadInput {
  title: string;
  goal: string;
  /** Stable id for eval/world seeding; generated when omitted. */
  threadId?: string;
  createdFromMsg?: string;
  repoIds?: string[];
}

export interface NewWorkerInput {
  workerId: string;
  threadId: string;
  deviceId: string;
  repoId?: string;
  agent: string;
  mode: string;
  cmdId?: string;
  requestedModel?: string | null;
  modelSource?: 'agent-default' | 'task-default' | 'override';
  /** Relay (issue #8) or sibling parent (ADR-0022). */
  parentWorker?: string;
  workerRelation?: "relay" | "sibling";
  proposalDepth?: number;
  /** Whether the connector will create an isolated git worktree (`write` or `readonly` with `base`). */
  hasWorktree?: boolean;
}

/** One event row lifted out of the protocol layer's `event_inbox`. */
interface InboxEventRow {
  workerId: string;
  seq: number;
  payload: string;
}

/** What a delivery pass needs to send one row, plus the claim token that proves ownership. */
export interface OutboundDeliveryRow {
  id: string;
  kind: string;
  channel: string;
  receiveId: string;
  attempts: number;
  payload: string;
  threadId: string | null;
  questionId: string | null;
  claim: string;
}

const jsonOrNull = <T>(value: string | null | undefined): T | null => {
  if (value === null || value === undefined || value === "") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const viewMachine = (r: Record<string, unknown>): MachineRow => ({
  deviceId: r.deviceId as string,
  name: r.name as string,
  online: !!r.online,
  lastSeen: (r.lastSeen as number | null) ?? null,
  agents: jsonOrNull<string[]>(r.agents as string | null) ?? [],
  agentCapabilities: jsonOrNull<Record<string, Record<string, boolean>>>(r.agentCapabilities as string | null) ?? {},
  modelCatalogs: jsonOrNull<Record<string, AgentModelCatalog>>(r.modelCatalogs as string | null) ?? {},
  maxWorkers: (r.maxWorkers as number | null) ?? 1,
  bootId: (r.bootId as string | null) ?? null,
  reliability: jsonOrNull<MachineReliability>(r.reliability as string | null),
});

const VALID_WORKTREE_STATUS = new Set<WorktreeStatus>([
  "active",
  "cleaning",
  "cleaned",
  "cleanup_blocked",
  "none",
]);

const viewWorker = (r: Record<string, unknown>): WorkerRow => ({
  workerId: r.workerId as string,
  threadId: r.threadId as string,
  deviceId: r.deviceId as string,
  repoId: (r.repoId as string | null) ?? null,
  agent: r.agent as string,
  requestedModel: (r.requestedModel as string | null) ?? null,
  modelSource: (r.modelSource as WorkerRow['modelSource']) ?? 'agent-default',
  launchObservedModel: jsonOrNull<AgentModelObservation>(r.launchObservedModel as string | null),
  lastObservedModel: jsonOrNull<AgentModelObservation>(r.lastObservedModel as string | null),
  mode: r.mode as string,
  state: r.state as string,
  worktreeStatus: VALID_WORKTREE_STATUS.has(r.worktreeStatus as WorktreeStatus)
    ? (r.worktreeStatus as WorktreeStatus)
    : "active",
  unreachable: !!r.unreachable,
  sessionId: (r.sessionId as string | null) ?? null,
  branch: (r.branch as string | null) ?? null,
  cmdId: (r.cmdId as string | null) ?? null,
  parentWorker: (r.parentWorker as string | null) ?? null,
  workerRelation: r.workerRelation === "sibling" ? "sibling" : "relay",
  proposalDepth: typeof r.proposalDepth === "number" ? r.proposalDepth : 0,
  lastOutcome: (r.lastOutcome as string | null) ?? null,
  lastEventAt: (r.lastEventAt as number | null) ?? null,
  lastProgress: (r.lastProgress as string | null) ?? null,
  contextPercent: (r.contextPercent as number | null) ?? null,
  createdAt: r.createdAt as number,
});

const viewProposal = (r: Record<string, unknown>): ProposalRow => ({
  id: r.id as string,
  workerId: r.workerId as string,
  seq: r.seq as number,
  threadId: r.threadId as string,
  kind: r.kind as ProposalKind,
  proposalKey: r.proposalKey as string,
  dedupeKey: r.dedupeKey as string,
  targetRepoRef: r.targetRepoRef as string,
  targetRepoId: (r.targetRepoId as string | null) ?? null,
  targetDeviceId: (r.targetDeviceId as string | null) ?? null,
  selectedAgent: (r.selectedAgent as string | null) ?? null,
  prompt: r.prompt as string,
  reason: r.reason as string,
  status: r.status as ProposalStatus,
  rejectCode: (r.rejectCode as ProposalRejectCode | null) ?? null,
  spawnedWorkerId: (r.spawnedWorkerId as string | null) ?? null,
  cmdId: (r.cmdId as string | null) ?? null,
  createdAt: r.createdAt as number,
  expiresAt: (r.expiresAt as number | null) ?? null,
  decidedBy: (r.decidedBy as string | null) ?? null,
  decidedAt: (r.decidedAt as number | null) ?? null,
});

const viewReport = (r: Record<string, unknown>): ReportRow => ({
  workerId: r.workerId as string,
  seq: r.seq as number,
  threadId: r.threadId as string,
  status: r.status as ReportRow["status"],
  summary: r.summary as string,
  changes: jsonOrNull<string[]>(r.changes as string | null),
  decisions: jsonOrNull<string[]>(r.decisions as string | null),
  leftovers: jsonOrNull<string[]>(r.leftovers as string | null),
  labels: jsonOrNull<ReportLabel[]>(r.labels as string | null),
  tests: jsonOrNull<ReportRow["tests"]>(r.tests as string | null),
  question: (r.question as string | null) ?? null,
  next: (r.next as string | null) ?? null,
  git: jsonOrNull<GitFacts>(r.git as string | null),
  answer: (r.answer as string | null) ?? null,
});

const viewQuestion = (r: Record<string, unknown>): QuestionRow => ({
  qid: r.qid as string,
  threadId: (r.threadId as string | null) ?? null,
  workerId: (r.workerId as string | null) ?? null,
  text: r.text as string,
  status: r.status as QuestionRow["status"],
  askedAt: r.askedAt as number,
  answeredAt: (r.answeredAt as number | null) ?? null,
  kind: (r.kind as QuestionRow["kind"]) ?? "steward",
  fallbackDueAt: (r.fallbackDueAt as number | null) ?? null,
  handledAt: (r.handledAt as number | null) ?? null,
});

const viewPrConsent = (r: Record<string, unknown>): PrConsentRow => ({
  workerId: r.workerId as string,
  seq: r.seq as number,
  threadId: r.threadId as string,
  decision: r.decision === "approved" ? "approved" : "declined",
  cmdId: (r.cmdId as string | null) ?? null,
  attempts: (r.attempts as number) ?? 0,
  url: (r.url as string | null) ?? null,
  failure: (r.failure as string | null) ?? null,
  decidedAt: r.decidedAt as number,
  updatedAt: r.updatedAt as number,
});

const viewRoutine = (r: Record<string, unknown>): RoutineRow => ({
  routineId: r.routineId as string,
  kind: r.kind as RoutineKind,
  createdFromMsg: r.createdFromMsg as string,
  scheduleKind: r.scheduleKind as RoutineRow["scheduleKind"],
  cron: (r.cron as string | null) ?? null,
  onceAt: (r.onceAt as number | null) ?? null,
  instruction: r.instruction as string,
  repoId: (r.repoId as string | null) ?? null,
  threadId: (r.threadId as string | null) ?? null,
  status: r.status as RoutineStatus,
  scheduleId: (r.scheduleId as string | null) ?? null,
  lastRunAt: (r.lastRunAt as number | null) ?? null,
  lastFireKey: (r.lastFireKey as string | null) ?? null,
  lastResult: (r.lastResult as string | null) ?? null,
  outcomeRecorded: !!r.outcomeRecorded,
  createdAt: r.createdAt as number,
});

const viewFollowup = (r: Record<string, unknown>): FollowupRow => ({
  followupId: r.followupId as string,
  threadId: r.threadId as string,
  dueAt: r.dueAt as number,
  reason: r.reason as string,
  createdBy: r.createdBy as FollowupRow["createdBy"],
  sourceRef: r.sourceRef as string,
  status: r.status as FollowupStatus,
  scheduleId: (r.scheduleId as string | null) ?? null,
  firedAt: (r.firedAt as number | null) ?? null,
  lastResult: (r.lastResult as string | null) ?? null,
  outcomeRecorded: !!r.outcomeRecorded,
  createdAt: r.createdAt as number,
});

const viewOffer = (r: Record<string, unknown>): RoutineOfferRow => ({
  offerId: r.offerId as string,
  spec: jsonOrNull<RoutineSpecStored>(r.spec as string | null) ?? { instruction: "", kind: "instruction" },
  sourceMsg: r.sourceMsg as string,
  status: r.status as RoutineOfferRow["status"],
  outboundId: (r.outboundId as string | null) ?? null,
  createdAt: r.createdAt as number,
});

export function createLedger(deps: LedgerDeps) {
  const { sql, tx } = deps;
  const now = deps.now ?? Date.now;
  const quietWindowMs = deps.quietWindowMs ?? (() => QUIET_MERGE_MS);

  // The notes half of the memory module (issue #18, steward.md §2.3-§2.5): layered
  // knowledge with a two-phase write. Same SQL handle, same transaction wrapper.
  const notes = createNotes({ sql, tx, now });
  const machineStatus = createMachineStatus({
    sql,
    tx,
    now,
    timelineAdd: (threadId, kind, text, refs) => timeline.add(threadId, kind, text, refs),
  });

  // The daily budget counter (issue #28, steward.md §12): sh_usage_day / sh_usage_cursor.
  // Same SQL handle, same transaction wrapper.
  const budget = createBudget({ sql, tx, now });

  /** §2.6 (issue #8): records one landed summary version, keeping the last
   *  SUMMARY_VERSIONS_KEPT. The version number is also the cumulative update count;
   *  `previous` (the summary before this update) backfills history for threads that
   *  predate versioning. */
  const recordSummaryVersion = (threadId: string, summary: string, previous: string | null): void => {
    tx(() => {
      const max =
        sql<{ m: number }>`SELECT COALESCE(MAX(version), 0) AS m FROM sh_thread_summary WHERE threadId = ${threadId}`[0]!.m;
      // Backfill: a thread that predates versioning enters history with its prior summary
      // as version 1, so the counter never lies about how many updates landed.
      if (max === 0 && previous !== null) {
        sql`INSERT OR IGNORE INTO sh_thread_summary (threadId, version, summary, at) VALUES (${threadId}, 1, ${previous}, ${now()})`;
      }
      const next =
        sql<{ m: number }>`SELECT COALESCE(MAX(version), 0) AS m FROM sh_thread_summary WHERE threadId = ${threadId}`[0]!.m + 1;
      sql`INSERT INTO sh_thread_summary (threadId, version, summary, at) VALUES (${threadId}, ${next}, ${summary}, ${now()})`;
      const stale = sql<{ version: number }>`
        SELECT version FROM sh_thread_summary WHERE threadId = ${threadId} ORDER BY version DESC LIMIT -1 OFFSET ${SUMMARY_VERSIONS_KEPT}
      `;
      for (const row of stale) {
        sql`DELETE FROM sh_thread_summary WHERE threadId = ${threadId} AND version = ${row.version}`;
      }
    });
  };

  const threadFromRow = (r: Record<string, unknown>): ThreadRow => ({
    threadId: r.threadId as string,
    title: r.title as string,
    goal: (r.goal as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    summaryAt: (r.summaryAt as number | null) ?? null,
    state: r.state as ThreadState,
    unread: !!r.unread,
    lastMachine: (r.lastMachine as string | null) ?? null,
    lastActivityAt: r.lastActivityAt as number,
    archived: !!r.archived,
    createdFromMsg: (r.createdFromMsg as string | null) ?? null,
    createdAt: r.createdAt as number,
  });

  const sanitizeSkillBriefText = (raw: string, max: number): string =>
    escapeMarkers(
      raw
        .replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
        .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
        .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, "[REDACTED]")
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
        .replace(/\bAQ\.[A-Za-z0-9._-]{20,}\b/g, "[REDACTED]")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim(),
    ).slice(0, max);

  const toStoredSkillBrief = (s: { target: RepoSkillTarget; slug: string; relativePath: string; name: string; description: string }): RepoSkillBrief | null => {
    const parsed = RepoSkillBriefSchema.safeParse({
      target: s.target,
      slug: s.slug,
      relativePath: s.relativePath.replace(/[\r\n\t]+/g, "").trim().slice(0, 256),
      name: sanitizeSkillBriefText(s.name, 80) || s.slug,
      description: sanitizeSkillBriefText(s.description, 160),
    });
    return parsed.success ? parsed.data : null;
  };

  function recordRepository(deviceId: string, repo: HelloMessage["repos"][number]): void {
    const capabilityKind = repo.capabilityKind ?? capabilityOf(repo).kind;
    const hasSetupHook = repo.hasSetupHook === true ? 1 : 0;
    const hasArchiveHook = repo.hasArchiveHook === true ? 1 : 0;
    const approved = (hasSetupHook === 1 || hasArchiveHook === 1) && repo.approved === true ? 1 : 0;
    const projectApproved = repo.projectApproved === true ? 1 : 0;
    const briefs = (repo.skills ?? [])
      .slice(0, REPO_SKILL_HELLO_MAX_ITEMS)
      .map(toStoredSkillBrief)
      .filter((b): b is RepoSkillBrief => b !== null);
    sql`
      INSERT OR REPLACE INTO sh_repo (
        repoId, deviceId, name, path, defaultBranch, remote,
        capabilityKind, hasSetupHook, hasArchiveHook, approved,
        projectApproved, skillIndexJson, updatedAt
      )
      VALUES (
        ${repo.repoId}, ${deviceId}, ${repo.name}, ${repo.path}, ${repo.defaultBranch}, ${repo.remote},
        ${capabilityKind}, ${hasSetupHook}, ${hasArchiveHook}, ${approved},
        ${projectApproved}, ${JSON.stringify(briefs)}, ${now()}
      )
    `;
  }

  function recordModelObservations(workerId: string, values: { launchObservedModel?: unknown; lastObservedModel?: unknown }): void {
    const launch = AgentModelObservationSchema.safeParse(values.launchObservedModel);
    const latest = AgentModelObservationSchema.safeParse(values.lastObservedModel);
    const previous = workers.get(workerId)?.lastObservedModel;
    const updateLatest = latest.success && (!previous || latest.data.observedAt >= previous.observedAt);
    if (launch.success || updateLatest) sql`UPDATE sh_worker
      SET launchObservedModel = COALESCE(launchObservedModel, ${launch.success ? JSON.stringify(launch.data) : null}),
          lastObservedModel = COALESCE(${updateLatest ? JSON.stringify(latest.data) : null}, lastObservedModel)
      WHERE workerId = ${workerId}`;
  }

  const machines = {
    /** Upserts machine facts + the full repo snapshot from a hello, and marks it online. */
    upsertFromHello(hello: HelloMessage): void {
      const ts = now();
      machineStatus.setOnline(hello.deviceId, true, hello.machine.name);
      const agentCapabilities = JSON.stringify(
        Object.fromEntries(
          hello.agents.map((a) => [
            a.kind,
            Object.fromEntries(
              Object.entries(a.capabilities ?? {}).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
            ),
          ]),
        ),
      );
      sql`
        INSERT INTO sh_machine (deviceId, name, online, lastSeen, agents, agentCapabilities, maxWorkers, bootId, modelCatalogs)
        VALUES (${hello.deviceId}, ${hello.machine.name}, 1, ${ts}, ${JSON.stringify(hello.agents.map((a) => a.kind))}, ${agentCapabilities}, ${hello.limits.maxWorkers}, ${hello.bootId}, ${JSON.stringify(Object.fromEntries(hello.agents.filter(a => a.modelCatalog).map(a => [a.kind, a.modelCatalog])))})
        ON CONFLICT (deviceId) DO UPDATE SET
          name = excluded.name, online = 1, lastSeen = excluded.lastSeen,
          agents = excluded.agents, agentCapabilities = excluded.agentCapabilities,
          maxWorkers = excluded.maxWorkers, bootId = excluded.bootId, modelCatalogs = excluded.modelCatalogs
      `;
      for (const snapshot of hello.workers) {
        if (workers.get(snapshot.workerId)?.deviceId === hello.deviceId) recordModelObservations(snapshot.workerId, snapshot);
      }
      // Slots occupied by sessions outside this ledger also count; tracked sessions are
      // counted live so a subsequent dispatch/settle immediately changes the free slots.
      const trackedRunning = hello.workers.filter((w) =>
        (ACTIVE_WORKER_STATES as readonly string[]).includes(w.state) && workers.get(w.workerId) !== null).length;
      sql`UPDATE sh_machine SET otherRunning = ${Math.max(0, hello.limits.running - trackedRunning)} WHERE deviceId = ${hello.deviceId}`;
      // hello.repos is a full snapshot: replace this machine's rows so removals stick.
      sql`DELETE FROM sh_repo WHERE deviceId = ${hello.deviceId}`;
      for (const repo of hello.repos) recordRepository(hello.deviceId, repo);
    },
    setModelCatalog(deviceId: string, agent: string, catalog: AgentModelCatalog): boolean {
      const machine = machines.get(deviceId);
      if (!machine || !machine.agents.includes(agent)) return false;
      sql`UPDATE sh_machine SET modelCatalogs = ${JSON.stringify({ ...machine.modelCatalogs, [agent]: catalog })} WHERE deviceId = ${deviceId}`;
      return true;
    },
    /** Online derives from live connections only (issue #5): onConnect marks, onClose clears. */
    setOnline(deviceId: string, online: boolean, fallbackName?: string): void {
      machineStatus.setOnline(deviceId, online, fallbackName);
    },
    /** Reconcile persisted flags with restored sockets after startup (Node loses all sockets).
     * Only transitions are written: a hibernated live socket must not reset reliability clocks. */
    reconcileOnline(connected: ReadonlySet<string>): void {
      for (const row of sql<{ deviceId: string; online: number }>`SELECT deviceId, online FROM sh_machine`) {
        const online = connected.has(row.deviceId);
        if (!!row.online !== online) machineStatus.setOnline(row.deviceId, online);
      }
    },
    get(deviceId: string): MachineRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_machine WHERE deviceId = ${deviceId}`[0];
      return row ? viewMachine(row) : null;
    },
    list(): MachineRow[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_machine ORDER BY deviceId`.map(viewMachine);
    },
    /** Workers still consuming a slot (free-slot tiebreak, ADR-0001 decision 6). */
    runningCount(deviceId: string): number {
      return sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sh_worker
        WHERE deviceId = ${deviceId} AND state IN ('starting', 'running', 'recovering')
      `[0]!.n + (sql<{ n: number }>`SELECT otherRunning AS n FROM sh_machine WHERE deviceId = ${deviceId}`[0]?.n ?? 0);
    },
  };

  const viewRepoSummary = (r: Record<string, unknown>): RepoSummaryRow => ({
    repoId: r.repoId as string,
    deviceId: r.deviceId as string,
    name: r.name as string,
    online: Number(r.online ?? 0) === 1,
    capabilityKind: r.capabilityKind === "plain" ? "plain" : "git",
    hasSetupHook: Number(r.hasSetupHook ?? 0) === 1,
    hasArchiveHook: Number(r.hasArchiveHook ?? 0) === 1,
    approved: Number(r.approved ?? 0) === 1,
  });

  const repos = {
    recordRegistration: recordRepository,
    /** Machines that have a repo matching `ref` by name or exact repoId (routing signal 2). */
    machinesHaving(ref: string): { deviceId: string; repoId: string; repoName: string }[] {
      return sql<{ deviceId: string; repoId: string; repoName: string }>`
        SELECT deviceId, repoId, name AS repoName FROM sh_repo
        WHERE name = ${ref} OR repoId = ${ref} OR path = ${ref}
        ORDER BY repoId
      `;
    },
    get(repoId: string, deviceId: string): RepoSummaryRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT r.repoId, r.deviceId, r.name, COALESCE(m.online, 0) AS online,
               r.capabilityKind, r.hasSetupHook, r.hasArchiveHook, r.approved
        FROM sh_repo r LEFT JOIN sh_machine m ON m.deviceId = r.deviceId
        WHERE r.repoId = ${repoId} AND r.deviceId = ${deviceId}
      `[0];
      return row ? viewRepoSummary(row) : null;
    },
    /** All registered repos (the brief's repos line, issue #7, plus Stage 2 boolean hook summary). */
    list(): RepoSummaryRow[] {
      return sql<Record<string, unknown>>`
        SELECT r.repoId, r.deviceId, r.name, COALESCE(m.online, 0) AS online,
               r.capabilityKind, r.hasSetupHook, r.hasArchiveHook, r.approved
        FROM sh_repo r LEFT JOIN sh_machine m ON m.deviceId = r.deviceId
        ORDER BY r.name, r.repoId
      `.map(viewRepoSummary);
    },
    /** Cached pi project approval + whitelisted skill briefs for dispatch injection. */
    contextFor(repoId: string, deviceId?: string): RepoContextRow {
      const row = deviceId
        ? sql<Record<string, unknown>>`
            SELECT projectApproved, skillIndexJson FROM sh_repo
            WHERE repoId = ${repoId} AND deviceId = ${deviceId}
          `[0]
        : sql<Record<string, unknown>>`
            SELECT r.projectApproved, r.skillIndexJson
            FROM sh_repo r LEFT JOIN sh_machine m ON m.deviceId = r.deviceId
            WHERE r.repoId = ${repoId}
            ORDER BY COALESCE(m.online, 0) DESC, r.updatedAt DESC LIMIT 1
          `[0];
      if (!row) return { projectApproved: false, skills: [] };
      const raw = jsonOrNull<unknown[]>(row.skillIndexJson as string | null) ?? [];
      const skills = raw
        .map((item) => RepoSkillBriefSchema.safeParse(item))
        .filter((p): p is { success: true; data: RepoSkillBrief } => p.success)
        .map((p) => p.data);
      return {
        projectApproved: Number(row.projectApproved ?? 0) === 1,
        skills,
      };
    },
    /** Immediately reflects live repo-level skill list/write/delete outcomes in sh_repo cache. */
    syncSkillMutation(
      deviceId: string,
      repoId: string,
      mutation:
        | { kind: "list"; skills: RepoSkillSummary[]; projectApproved?: boolean }
        | { kind: "upsert"; summary: RepoSkillSummary; projectApproved?: boolean }
        | { kind: "delete"; relativePath: string },
    ): void {
      const current = repos.contextFor(repoId, deviceId);
      let nextSkills: RepoSkillBrief[] = current.skills;
      let nextApproved = current.projectApproved;
      if (mutation.kind === "list") {
        nextSkills = mutation.skills
          .slice(0, REPO_SKILL_HELLO_MAX_ITEMS)
          .map(toStoredSkillBrief)
          .filter((b): b is RepoSkillBrief => b !== null);
        if (mutation.projectApproved !== undefined) nextApproved = mutation.projectApproved;
      } else if (mutation.kind === "upsert") {
        const brief = toStoredSkillBrief(mutation.summary);
        if (brief) {
          const filtered = current.skills.filter((s) => s.relativePath !== brief.relativePath);
          nextSkills = [...filtered, brief]
            .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
            .slice(0, REPO_SKILL_HELLO_MAX_ITEMS);
        }
        if (mutation.projectApproved !== undefined) nextApproved = mutation.projectApproved;
        sql`
          UPDATE sh_skill_offer
          SET status = 'saved', savedPath = ${mutation.summary.relativePath},
              savedSha256 = ${mutation.summary.sha256}, failureReason = NULL, decidedAt = ${now()}
          WHERE repoId = ${repoId} AND slug = ${mutation.summary.slug} AND status IN ('offered', 'failed')
        `;
      } else {
        nextSkills = current.skills.filter((s) => s.relativePath !== mutation.relativePath);
      }
      sql`
        UPDATE sh_repo
        SET projectApproved = ${nextApproved ? 1 : 0},
            skillIndexJson = ${JSON.stringify(nextSkills)},
            updatedAt = ${now()}
        WHERE repoId = ${repoId} AND deviceId = ${deviceId}
      `;
    },
  };

  // ---- threads / workers -----------------------------------------------------------------------

  const threads = {
    create(input: NewThreadInput): ThreadRow {
      const threadId = input.threadId ?? `t_${ulid()}`;
      const ts = now();
      sql`
        INSERT INTO sh_thread (threadId, title, goal, state, unread, lastActivityAt, createdFromMsg, createdAt)
        VALUES (${threadId}, ${input.title}, ${input.goal}, 'idle', 0, ${ts}, ${input.createdFromMsg ?? null}, ${ts})
      `;
      for (const repoId of input.repoIds ?? []) {
        sql`INSERT OR IGNORE INTO sh_thread_repo (threadId, repoId) VALUES (${threadId}, ${repoId})`;
      }
      return threads.get(threadId)!;
    },
    get(threadId: string): ThreadRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_thread WHERE threadId = ${threadId}`[0];
      return row ? threadFromRow(row) : null;
    },
    list(opts?: { includeArchived?: boolean }): ThreadRow[] {
      const rows = opts?.includeArchived
        ? sql<Record<string, unknown>>`
            SELECT * FROM sh_thread ORDER BY lastActivityAt DESC, threadId
          `
        : sql<Record<string, unknown>>`
            SELECT * FROM sh_thread WHERE archived = 0 ORDER BY lastActivityAt DESC, threadId
          `;
      return rows.map(threadFromRow);
    },
    archivedCount(): number {
      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_thread WHERE archived = 1`[0]!.n;
    },
    setArchived(threadId: string, archived: boolean): boolean {
      const flag = archived ? 1 : 0;
      sql`
        UPDATE sh_thread
        SET archived = ${flag},
            unread = CASE WHEN ${flag} = 1 THEN 0 ELSE unread END,
            lastActivityAt = ${now()}
        WHERE threadId = ${threadId}
      `;
      return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    },
    repoIds(threadId: string): string[] {
      return sql<{ repoId: string }>`SELECT repoId FROM sh_thread_repo WHERE threadId = ${threadId}`.map((r) => r.repoId);
    },
    addRepo(threadId: string, repoId: string): void {
      sql`INSERT OR IGNORE INTO sh_thread_repo (threadId, repoId) VALUES (${threadId}, ${repoId})`;
    },
    /** Bug 4: dispatch affinity — the machine the Thread last ran on. */
    setLastMachine(threadId: string, deviceId: string): void {
      sql`UPDATE sh_thread SET lastMachine = ${deviceId}, lastActivityAt = ${now()} WHERE threadId = ${threadId}`;
    },
    /** Reply or card click on the Thread's message = the user has seen it (§6.5). */
    markRead(threadId: string): void {
      sql`UPDATE sh_thread SET unread = 0 WHERE threadId = ${threadId}`;
    },
    /** The steward's bookkeeping update (§2.6): summaries capped at 600 characters; each
     *  landed summary is versioned (last 5 kept) and the Nth-bounded updates trigger the
     *  from-scratch rewrite prompt. A blank or unchanged summary does not count as an
     *  update — only real rewrites move the counter. */
    update(threadId: string, patch: { title?: string; goal?: string; summary?: string }): boolean {
      if (patch.summary !== undefined && patch.summary.length > MAX_THREAD_SUMMARY) return false;
      if (patch.summary !== undefined && patch.summary.trim().length === 0) return false;
      const before = sql<ThreadRow>`SELECT * FROM sh_thread WHERE threadId = ${threadId}`[0];
      if (!before) return false;
      const changedSummary = patch.summary !== undefined && patch.summary !== before.summary;
      sql`
        UPDATE sh_thread SET
          title = COALESCE(${patch.title ?? null}, title),
          goal = COALESCE(${patch.goal ?? null}, goal),
          summary = COALESCE(${patch.summary ?? null}, summary),
          summaryAt = CASE WHEN ${patch.summary ?? null} IS NULL THEN summaryAt ELSE ${now()} END
        WHERE threadId = ${threadId}
      `;
      if (changedSummary) recordSummaryVersion(threadId, patch.summary!, before.summary);
      return true;
    },
    /** §2.6 (issue #8): the retained summary versions, newest first. */
    summaryVersions(threadId: string): Array<{ version: number; summary: string; at: number }> {
      return sql<{ version: number; summary: string; at: number }>`
        SELECT version, summary, at FROM sh_thread_summary WHERE threadId = ${threadId} ORDER BY version DESC
      `;
    },
    /** §2.6 (issue #8): cumulative summary updates so far, and whether the NEXT one lands on
     *  the every-10th boundary that must be written from scratch (timeline + reports), not
     *  edited out of the current summary — the anti-drift rule. */
    summaryStatus(threadId: string): { updates: number; rewriteDue: boolean } {
      const updates =
        sql<{ m: number }>`SELECT COALESCE(MAX(version), 0) AS m FROM sh_thread_summary WHERE threadId = ${threadId}`[0]!.m;
      return { updates, rewriteDue: (updates + 1) % SUMMARY_REWRITE_EVERY === 0 };
    },

    /**
     * threads.findCandidates (§3.2, issue #7): routing candidates for one utterance.
     *
     * 1. Signal 1 (reply-to / card click) never reaches here in production — the input is
     *    routed before the model — but `explicitThreadId` short-circuits the same way when
     *    the caller knows it. Signal 2 (explicit mention): the text contains exactly one
     *    thread's title or a thread id (or `hints` name repos/machines that pin one thread).
     *    A unique hit returns as `confidence: "explicit"` with just that thread.
     * 2. Otherwise: all running + waiting-you threads, then the FTS-recalled top 8 over the
     *    text (trigram index, ranked by the bigram scorer so 2-char queries count too), then
     *    the 5 most recent — deduped, capped at 12, each with a match reason.
     */
    findCandidates(input: { text: string; hints?: string[]; explicitThreadId?: string | null }): RouteCandidates {
      const all = sql<Record<string, unknown>>`
        SELECT * FROM sh_thread WHERE archived = 0 ORDER BY lastActivityAt DESC, threadId
      `.map(threadFromRow);
      const reposOf = (threadId: string): string[] =>
        sql<{ repoId: string }>`SELECT repoId FROM sh_thread_repo WHERE threadId = ${threadId}`.map((r) => r.repoId);
      const toCandidate = (thread: ThreadRow, matchReason: string, weak = false): RouteCandidate => ({
        threadId: thread.threadId,
        title: thread.title,
        summary: routeSummaryOf(thread.summary),
        repos: reposOf(thread.threadId),
        state: thread.state,
        lastActivityAt: thread.lastActivityAt,
        matchReason,
        weak,
      });

      // ---- signal 1: the caller already resolved the thread (reply / card click) ----
      if (input.explicitThreadId) {
        const routed = all.find((t) => t.threadId === input.explicitThreadId);
        if (routed) {
          return {
            confidence: "explicit",
            explicitThread: toCandidate(routed, "回复/按钮显式指向"),
            candidates: [toCandidate(routed, "回复/按钮显式指向")],
          };
        }
      }

      // ---- signal 2: explicit mention — the text names exactly one thread ----
      const lower = input.text.toLowerCase();
      const mentioned = all.filter((t) => t.title.length > 1 && lower.includes(t.title.toLowerCase()));
      const byId = all.filter((t) => lower.includes(t.threadId.toLowerCase()));
      // Hints (§3.1 signal 2): repo or machine names pin the thread set.
      const hintThreads = new Set<string>();
      for (const hint of input.hints ?? []) {
        for (const row of repos.machinesHaving(hint)) {
          for (const t of all) if (reposOf(t.threadId).includes(row.repoId)) hintThreads.add(t.threadId);
        }
        for (const machine of machines.list()) {
          if (machine.name === hint || machine.deviceId === hint) {
            for (const w of sql<{ threadId: string }>`SELECT DISTINCT threadId FROM sh_worker WHERE deviceId = ${machine.deviceId}`) {
              hintThreads.add(w.threadId);
            }
          }
        }
      }
      const explicitPicks = [...new Set([...mentioned, ...byId].map((t) => t.threadId))];
      const explicitUnique =
        explicitPicks.length === 1
          ? (all.find((t) => t.threadId === explicitPicks[0]) ?? null)
          : hintThreads.size === 1
            ? (all.find((t) => t.threadId === [...hintThreads][0]) ?? null)
            : null;
      if (explicitUnique) {
        const reason = mentioned.some((t) => t.threadId === explicitUnique.threadId)
          ? "消息里点名了它的标题"
          : byId.some((t) => t.threadId === explicitUnique.threadId)
            ? "消息里带了它的 id"
            : "仓库/机器指向它";
        const candidate = toCandidate(explicitUnique, reason);
        return { confidence: "explicit", explicitThread: candidate, candidates: [candidate] };
      }

      // ---- assembly (§3.2 step 2) ----
      const active = all.filter((t) => t.state === "running" || t.state === "waiting_you");
      const picked = new Set<string>(active.map((t) => t.threadId));
      const candidates: RouteCandidate[] = active
        .sort((a, b) => (a.state === b.state ? b.lastActivityAt - a.lastActivityAt : a.state === "running" ? -1 : 1))
        .map((t) => toCandidate(t, t.state === "running" ? "进行中" : "等你拍板"));

      // Recall: FTS over the text (trigram index), ranked by the bigram scorer; the scorer
      // alone stands in when the index has no ≥3-char segment to match (or the runtime's
      // SQLite lacks FTS5 — findCandidates must never throw over recall).
      const scored = all
        .map((thread) => {
          const report = sql<{ summary: string | null }>`
            SELECT summary FROM sh_report WHERE threadId = ${thread.threadId} ORDER BY receivedAt DESC, seq DESC LIMIT 1
          `[0]?.summary;
          const hay = `${thread.title} ${thread.goal ?? ""} ${thread.summary ?? ""} ${report ?? ""}`;
          return { thread, score: recallScore(input.text, hay) + (thread.state !== "idle" ? 1 : 0) };
        })
        .filter((entry) => entry.score >= RECALL_SCORE_CUTOFF)
        .sort((a, b) => b.score - a.score || b.thread.lastActivityAt - a.thread.lastActivityAt);

      let ftsIds: string[] = [];
      const match = ftsMatchExpression(input.text);
      if (match !== null) {
        try {
          ftsIds = sql<{ threadId: string }>`
            SELECT threadId FROM sh_thread_fts WHERE sh_thread_fts MATCH ${match} ORDER BY bm25(sh_thread_fts) LIMIT 32
          `.map((r) => r.threadId);
        } catch {
          ftsIds = []; // no FTS5 / tokenizer in this runtime: the scorer above is the recall
        }
      }
      const recallOrder = new Map<string, number>();
      ftsIds.forEach((id, index) => recallOrder.set(id, index));
      const recalled = [...scored]
        .sort((a, b) => {
          // The bigram scorer ranks (spike-eval-tuned); FTS presence is the recall net and
          // bm25 order only breaks scorer ties — bm25 over OR'd trigrams is too noisy to lead.
          const sa = recallOrder.has(a.thread.threadId) ? recallOrder.get(a.thread.threadId)! : 999;
          const sb = recallOrder.has(b.thread.threadId) ? recallOrder.get(b.thread.threadId)! : 999;
          return b.score - a.score || sa - sb || b.thread.lastActivityAt - a.thread.lastActivityAt;
        })
        .slice(0, FTS_RECALL_LIMIT);
      for (const entry of recalled) {
        if (picked.has(entry.thread.threadId)) continue;
        if (candidates.length >= CANDIDATE_CAP) break;
        picked.add(entry.thread.threadId);
        candidates.push(toCandidate(entry.thread, `关键词命中（${entry.score}）`, entry.score < RECALL_WEAK_BELOW));
      }

      for (const thread of all.slice(0, RECENT_RECALL_LIMIT)) {
        if (picked.has(thread.threadId)) continue;
        if (candidates.length >= CANDIDATE_CAP) break;
        picked.add(thread.threadId);
        candidates.push(toCandidate(thread, "最近活跃", true));
      }

      return { confidence: "candidates", explicitThread: null, candidates };
    },
  };

  const hasSurvivingBranch = (worker: WorkerRow): boolean => {
    if (!worker.branch) return false;
    if (worker.worktreeStatus !== "cleaned" && worker.worktreeStatus !== "cleaning") return true;
    const latestGit = reports.latestForWorker(worker.workerId)?.git ?? null;
    const pushed = latestGit?.pushed === true || prConsent.branchState(worker.workerId).url !== null;
    return pushed && (latestGit?.ahead ?? 0) > 0;
  };

  const workers = {
    register(input: NewWorkerInput): WorkerRow {
      const ts = now();
      const workerRelation = input.workerRelation ?? "relay";
      const proposalDepth = input.proposalDepth ?? (workerRelation === "sibling" ? 1 : 0);
      const repoCap = input.repoId ? repos.get(input.repoId, input.deviceId)?.capabilityKind : null;
      const initialWorktreeStatus: WorktreeStatus =
        repoCap === "plain" || !input.repoId
          ? "none"
          : input.hasWorktree !== undefined
            ? input.hasWorktree
              ? "active"
              : "none"
            : input.mode === "readonly"
              ? "none"
              : "active";
      sql`
        INSERT INTO sh_worker (
          workerId, threadId, deviceId, repoId, agent, mode, state, worktreeStatus, cmdId, parentWorker,
          workerRelation, proposalDepth, createdAt, updatedAt, requestedModel, modelSource
        )
        VALUES (
          ${input.workerId}, ${input.threadId}, ${input.deviceId}, ${input.repoId ?? null},
          ${input.agent}, ${input.mode}, 'starting', ${initialWorktreeStatus}, ${input.cmdId ?? null}, ${input.parentWorker ?? null},
          ${workerRelation}, ${proposalDepth}, ${ts}, ${ts}, ${input.requestedModel ?? null}, ${input.modelSource ?? 'agent-default'}
        )
      `;
      // A fresh run of this id: any deferred reap-reconcile verdict is void.
      sql`DELETE FROM sh_reap_pending WHERE workerId = ${input.workerId}`;
      return workers.get(input.workerId)!;
    },
    hasSurvivingBranch,
    setWorktreeStatus(workerId: string, status: WorktreeStatus): boolean {
      sql`UPDATE sh_worker SET worktreeStatus = ${status}, updatedAt = ${now()} WHERE workerId = ${workerId}`;
      return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    },
    get(workerId: string): WorkerRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_worker WHERE workerId = ${workerId}`[0];
      return row ? viewWorker(row) : null;
    },
    listByThread(threadId: string): WorkerRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_worker WHERE threadId = ${threadId} ORDER BY createdAt, workerId
      `.map(viewWorker);
    },
    /** The Thread's most recent main-chain (`relay`) worker — continuation target and relay-base
     *  source (spec §5.3; ADR-0022 Decision 6: `sibling` probes never hijack main-chain continuations). */
    latestOnThread(threadId: string): WorkerRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_worker
        WHERE threadId = ${threadId} AND workerRelation = 'relay'
        ORDER BY createdAt DESC, workerId DESC LIMIT 1
      `[0];
      return row ? viewWorker(row) : null;
    },
    /** The Thread's most recent main-chain (`relay`) worker that actually has a surviving branch — the relay
     *  base when the latest leg ran readonly or never started (issue #8, spec §5.3). `target`
     *  filters out same-machine/different-repo rows: relaying repo-A's branch name into repo-B's
     *  clone would just fail the start (PR #54 review finding 3); cross-machine rows stay — the
     *  branch may exist there after a push+fetch, and the dispatch flags `crossMachine`. */
    latestBranchOnThread(threadId: string, target?: { deviceId: string; repoId: string | null }): WorkerRow | null {
      const rows = target
        ? sql<Record<string, unknown>>`
            SELECT * FROM sh_worker WHERE threadId = ${threadId} AND workerRelation = 'relay' AND branch IS NOT NULL
              AND NOT (deviceId = ${target.deviceId} AND repoId IS NOT NULL AND ${target.repoId} IS NOT NULL AND repoId != ${target.repoId})
            ORDER BY createdAt DESC, workerId DESC
          `
        : sql<Record<string, unknown>>`
            SELECT * FROM sh_worker WHERE threadId = ${threadId} AND workerRelation = 'relay' AND branch IS NOT NULL
            ORDER BY createdAt DESC, workerId DESC
          `;
      return rows.map(viewWorker).find(hasSurvivingBranch) ?? null;
    },
    /** The worker a new relay session continues FROM (issue #8): the previous leg. Same
     *  machine must also mean same repo — continuing a thread into another repository of
     *  one machine silently relays the wrong repo's branch, so such a worker yields null
     *  and the session starts fresh. */
    relaySource(threadId: string, target: { deviceId: string; repoId: string | null }): WorkerRow | null {
      const previous = workers.latestOnThread(threadId);
      if (!previous) return null;
      if (previous.deviceId === target.deviceId && previous.repoId !== null && target.repoId !== null && previous.repoId !== target.repoId) {
        return null;
      }
      return previous;
    },
    reportsForWorker(workerId: string): ReportRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_report WHERE workerId = ${workerId} ORDER BY seq
      `.map(viewReport);
    },
    byCommand(cmdId: string): WorkerRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_worker WHERE cmdId = ${cmdId}`[0];
      return row ? viewWorker(row) : null;
    },
    /** Backfills the start_worker cmdId once the command exists (registration precedes it). */
    setCmdId(workerId: string, cmdId: string): void {
      sql`UPDATE sh_worker SET cmdId = ${cmdId}, updatedAt = ${now()} WHERE workerId = ${workerId}`;
    },
    setModelRequest(workerId: string, requestedModel: string | null, modelSource: NonNullable<WorkerRow['modelSource']>): void {
      sql`UPDATE sh_worker SET requestedModel = ${requestedModel}, modelSource = ${modelSource}, updatedAt = ${now()} WHERE workerId = ${workerId}`;
    },

    /**
     * Reconciles this device's workers against the hello.workers snapshot (issue #12,
     * connector-pi.md §9.1 step 4 / protocol §6.1): the backstop for states the event stream
     * never delivered (events lost beyond the connector's retention, or never emitted).
     *
     * Gated per worker on `lastSeq <= processedUpTo`: while events are still in flight the
     * stream is authoritative and reconciliation must not write under it. Transitions land
     * on the timeline but NEVER push — lost/resumed are facts, not interruptions of the
     * user's day (spec §9: “lost contact, not failed”). Idempotent by construction: once the
     * ledger matches the snapshot, later hellos take no branch.
     */
    reconcileFromSnapshot(deviceId: string, snapshots: HelloMessage["workers"]): void {
      const rows = sql<Record<string, unknown>>`
        SELECT * FROM sh_worker WHERE deviceId = ${deviceId}
      `.map(viewWorker);
      for (const worker of rows) {
        const snap = snapshots.find((s) => s.workerId === worker.workerId);
        if (!snap) continue; // not this deployment's business (pruned / other device)
        if (typeof snap.hasWorktree === "boolean") {
          if (snap.hasWorktree) {
            if (worker.worktreeStatus !== "active" && worker.worktreeStatus !== "cleaning") {
              sql`UPDATE sh_worker SET worktreeStatus = 'active', updatedAt = ${now()} WHERE workerId = ${worker.workerId}`;
            }
          } else if (
            worker.worktreeStatus === "active" ||
            worker.worktreeStatus === "cleaning" ||
            worker.worktreeStatus === "cleanup_blocked"
          ) {
            const nextStatus: WorktreeStatus =
              worker.branch !== null || worker.worktreeStatus === "cleaning" ? "cleaned" : "none";
            sql`UPDATE sh_worker SET worktreeStatus = ${nextStatus}, updatedAt = ${now()} WHERE workerId = ${worker.workerId}`;
          }
        }
        const processed =
          sql<{ processedUpTo: number }>`SELECT processedUpTo FROM worker_ack WHERE workerId = ${worker.workerId}`[0]
            ?.processedUpTo ?? 0;
        if (snap.lastSeq > processed) {
          // The event stream is still telling the story — but if this worker was reaped by
          // the DO while its machine was offline, park the snapshot's verdict: once the
          // stream catches up (resolveReapPending), the verdict applies without waiting for
          // another hello that may never come (issue #13 review finding 2).
          if (worker.state === "lost" && worker.lastOutcome === "reaped") {
            sql`
              INSERT OR REPLACE INTO sh_reap_pending (workerId, threadId, snapState, lastSeq, createdAt)
              VALUES (${worker.workerId}, ${worker.threadId}, ${snap.state}, ${snap.lastSeq}, ${now()})
            `;
          }
          continue;
        }
        if (snap.state === 'broken' && worker.state !== 'broken') {
          recordBrokenQuestion(worker, `q_broken_${worker.workerId}_${processed}`, '自动恢复未成功（连接器对账），需要你决定下一步。');
        }
        // Back online (issue #14): the connector's snapshot re-states this worker's truth —
        // the DO-side unreachable mark from the drop must not outlive the reconnection.
        sql`UPDATE sh_worker SET unreachable = 0 WHERE workerId = ${worker.workerId}`;
        const ledgerActive = (ACTIVE_WORKER_STATES as readonly string[]).includes(worker.state);
        const snapActive = (ACTIVE_WORKER_STATES as readonly string[]).includes(snap.state);
        if (ledgerActive && !snapActive) {
          sql`UPDATE sh_worker SET state = ${snap.state}, updatedAt = ${now()} WHERE workerId = ${worker.workerId}`;
          timeline.add(
            worker.threadId,
            snap.state === "lost" ? "lost" : "note",
            snap.state === "lost"
              ? "失去联系（连接器重启后对账）"
              : snap.state === "broken"
                ? "自动恢复未成功（连接器对账）"
                : "运行已结束（连接器重启后对账）",
            { workerId: worker.workerId, reconciled: true },
          );
          recomputeThreadState(worker.threadId);
        } else if (worker.state === "lost" && snapActive) {
          sql`
            UPDATE sh_worker SET state = ${snap.state},
                                lastOutcome = CASE WHEN lastOutcome = 'reaped' THEN NULL ELSE lastOutcome END,
                                updatedAt = ${now()}
            WHERE workerId = ${worker.workerId}
          `;
          timeline.add(worker.threadId, "resumed", "已恢复运行（连接器重启后对账）", {
            workerId: worker.workerId,
            reconciled: true,
          });
          recomputeThreadState(worker.threadId);
        } else if (worker.state === "lost" && (snap.state === "broken" || snap.state === "idle")) {
          sql`UPDATE sh_worker SET state = ${snap.state}, updatedAt = ${now()} WHERE workerId = ${worker.workerId}`;
          timeline.add(
            worker.threadId,
            "note",
            snap.state === "broken" ? "自动恢复未成功（对账），需要你决定下一步" : "运行已结束（对账）",
            { workerId: worker.workerId, reconciled: true },
          );
          recomputeThreadState(worker.threadId);
        }
      }
    },

    /**
     * A resume dispatch in flight (issue #8): the ledger flips an idle worker to `starting`
     * when the continuation reuses its session, so the Thread reads running-shaped right
     * away. `lost` stays lost — the connector's §9.2 resume owns that state, and the
     * pending send queues behind it.
     */
    markResumePending(workerId: string, cmdId: string): void {
      sql`
        UPDATE sh_worker SET state = CASE WHEN state = 'idle' THEN 'starting' ELSE state END,
                            cmdId = ${cmdId}, lastEventAt = ${now()}, updatedAt = ${now()}
        WHERE workerId = ${workerId}
      `;
    },

    /**
     * A still-queued resume was withdrawn (the user cancelled, issue #8): revert the
     * resume-pending `starting` back to `idle` silently — the user's own click, nothing to
     * report. Same cmdId guard as markResumeFailed.
     */
    markResumeCancelled(workerId: string, cmdId: string): boolean {
      const worker = workers.get(workerId);
      if (!worker || worker.cmdId !== cmdId || worker.state !== "starting") return false;
      sql`UPDATE sh_worker SET state = 'idle', updatedAt = ${now()} WHERE workerId = ${workerId}`;
      timeline.add(worker.threadId, "note", "用户取消：接续指令在送出前撤回，原会话未受影响", { workerId, cmdId });
      recomputeThreadState(worker.threadId);
      return true;
    },

    /**
     * The resume send failed at the connector (rejected / failed cmd_result / sweep, issue
     * 8): a resume-pending `starting` worker reverts to `idle` — the session itself is intact
     * — and the failure is surfaced. A resume sent into a still-`running` worker (intent
     * "after") cannot revert the state (the run goes on); the undelivered task is still
     * recorded on the timeline and pushed to the user — the promise "会汇报" must not
     * silently evaporate (PR #54 review finding 8). Idempotent on the cmdId; only the
     * command that the worker row still points at may settle it.
     */
    markResumeFailed(workerId: string, cmdId: string, reason: string): boolean {
      const worker = workers.get(workerId);
      if (!worker || worker.cmdId !== cmdId) return false;
      if (worker.state === "starting") {
        sql`
          UPDATE sh_worker SET state = 'idle', lastOutcome = ${`resume_failed:${reason}`}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        timeline.add(worker.threadId, "note", `接续原会话失败（${reason}）；原会话未受影响，重新派发即可`, {
          workerId,
          cmdId,
        });
        sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        notifications.queue(`resume_failed:${cmdId}`, "failure_push", worker.threadId, workerId);
        recomputeThreadState(worker.threadId);
        return true;
      }
      if (worker.state === "running" || worker.state === "recovering") {
        // The current run is unaffected; only the queued-in task was lost. State stays; the
        // outcome marker routes the deterministic failure card (and the next report/settled
        // overwrites it).
        sql`UPDATE sh_worker SET lastOutcome = ${`resume_failed:${reason}`}, updatedAt = ${now()} WHERE workerId = ${workerId}`;
        timeline.add(worker.threadId, "note", `接续指令未送达（${reason}）；当前运行不受影响，但新任务没有交给它`, {
          workerId,
          cmdId,
        });
        sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        notifications.queue(`resume_failed:${cmdId}`, "failure_push", worker.threadId, workerId);
        recomputeThreadState(worker.threadId);
        return true;
      }
      return false;
    },

    /**
     * A start_worker the connector rejected or that failed (cmd_ack rejected / cmd_result
     * ok:false). Marks the worker broken, records it on the timeline, and queues a failure
     * push — deterministic, idempotent (duplicate cmd_results re-settle the same command).
     * `cmdId` may be null when the command row never came to exist (enqueue threw): the
     * dedupe key then falls back to the workerId.
     */
    markStartFailed(workerId: string, cmdId: string | null, reason: string): boolean {
      const worker = workers.get(workerId);
      if (!worker || worker.state === "broken") return false;
      // Issue #14: a start that dies while an offline ask was open settles the ask too —
      // the offer row must not sit `offered`/`waiting` on top of a broken worker, and the
      // `offline:` question would otherwise pin the Thread in waiting_you forever.
      const askCmdId = cmdId ?? worker.cmdId;
      if (askCmdId !== null && offlineDispatches.transition(askCmdId, "offered", "cancelled")) {
        questions.close(`offline:${askCmdId}`, "派发未能开始");
      }
      if (askCmdId !== null && offlineDispatches.transition(askCmdId, "waiting", "cancelled")) {
        questions.close(`offline:${askCmdId}`, "派发未能开始");
      }
      sql`
        UPDATE sh_worker SET state = 'broken', lastOutcome = ${`start_failed:${reason}`}, updatedAt = ${now()}
        WHERE workerId = ${workerId}
      `;
      timeline.add(worker.threadId, "note", `派发失败（${reason}）`, { workerId, cmdId });
      sql`UPDATE sh_thread SET unread = 1, lastActivityAt = ${now()} WHERE threadId = ${worker.threadId}`;
      recordBrokenQuestion(worker, `q_start_${cmdId ?? workerId}`, `派发失败：${reason}。需要你决定下一步。`);
      recomputeThreadState(worker.threadId);
      return true;
    },

    /**
     * Active workers silent for at least `silentMs` (silence counts from lastEventAt, or
     * createdAt when no event ever arrived), with their machine's online flag — the shared
     * query of the DO-side stall alarm (§8.4) and the reap sweep (spike-conclusions §2).
     */
    silentSince(silentMs: number): SilentWorker[] {
      const cutoff = now() - silentMs;
      return sql<Record<string, unknown>>`
        SELECT w.*, CASE WHEN m.online = 1 THEN 1 ELSE 0 END AS machineOnline,
               COALESCE(m.lastSeen, 0) AS machineLastSeen
        FROM sh_worker w LEFT JOIN sh_machine m ON m.deviceId = w.deviceId
        WHERE w.state IN ('queued', 'starting', 'running', 'recovering')
          AND COALESCE(w.lastEventAt, w.createdAt) <= ${cutoff}
        ORDER BY w.workerId
      `.map((r) => ({ ...viewWorker(r), machineOnline: r.machineOnline === 1, machineLastSeen: Number(r.machineLastSeen ?? 0) }));
    },

    /**
     * The §8.4 stall alarm firing for one worker: one timeline entry and one stall_notice
     * intent — "a given stall notifies only once". The dedupe key carries lastEventAt, so the
     * next event (which rewrites that timestamp) arms a fresh stall naturally. Idempotent.
     */
    notifyStall(workerId: string, silentMs: number): boolean {
      const worker = workers.get(workerId);
      if (!worker || !(ACTIVE_WORKER_STATES as readonly string[]).includes(worker.state)) return false;
      const dedupeKey = `stall:${workerId}:${worker.lastEventAt ?? 0}`;
      if (notifications.seen(dedupeKey)) return false;
      return tx(() => {
        if (notifications.seen(dedupeKey)) return false; // re-check inside the transaction
        const minutes = Math.max(1, Math.round(silentMs / 60_000));
        timeline.add(worker.threadId, "stall", `worker 已经 ${minutes} 分钟没有任何动静`, { workerId, silentMs });
        sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        notifications.queue(dedupeKey, "stall_notice", worker.threadId, workerId);
        return true;
      });
    },

    /**
     * The reap sweep's verdict (issue #13): a worker wedged in an active state — its machine
     * offline, or online but long silent — becomes `lost` so the Thread stops pretending to
     * be running. Timeline only, never a push (spec §9: lost contact, not failed). Idempotent;
     * when the machine returns, hello.workers reconciliation decides resumed vs ended.
     */
    reapWorker(workerId: string, online: boolean): boolean {
      const worker = workers.get(workerId);
      if (!worker || !(ACTIVE_WORKER_STATES as readonly string[]).includes(worker.state)) return false;
      return tx(() => {
        sql`UPDATE sh_worker SET state = 'lost', lastOutcome = 'reaped', updatedAt = ${now()} WHERE workerId = ${workerId}`;
        timeline.add(
          worker.threadId,
          "lost",
          online ? "机器在线但 worker 长时间无事件，视为失联（DO 兜底回收）" : "机器离线超过 10 分钟，worker 视为失联（DO 兜底回收）",
          { workerId, reaped: true },
        );
        recomputeThreadState(worker.threadId);
        return true;
      });
    },

    /**
     * Applies deferred hello-workers verdicts whose event stream has caught up (see
     * reconcileFromSnapshot's gated branch). A `lost`+`reaped` worker whose parked snapshot
     * is active resumes; one whose snapshot says the run ended accepts that verdict. Ordered
     * by seq only — never by connector timestamps, which may skew. Idempotent.
     */
    resolveReapPending(): number {
      let resolved = 0;
      for (const pending of sql<{ workerId: string; threadId: string; snapState: string; lastSeq: number }>`
        SELECT workerId, threadId, snapState, lastSeq FROM sh_reap_pending
      `) {
        const processed =
          sql<{ processedUpTo: number }>`SELECT processedUpTo FROM worker_ack WHERE workerId = ${pending.workerId}`[0]
            ?.processedUpTo ?? 0;
        if (pending.lastSeq > processed) continue; // still gated
        const worker = workers.get(pending.workerId);
        // One verdict, one transaction (PR #46 review finding 3): the delete and the state
        // writes commit together — a crash between them would lose the parked verdict and
        // leave the worker lost+reaped with nothing left to resolve it.
        tx(() => {
          sql`DELETE FROM sh_reap_pending WHERE workerId = ${pending.workerId}`;
          resolved += 1;
          if (!worker || worker.state !== "lost" || worker.lastOutcome !== "reaped") return; // the story moved on
          const snapActive = (ACTIVE_WORKER_STATES as readonly string[]).includes(pending.snapState);
          if (snapActive) {
            sql`
              UPDATE sh_worker SET state = 'running', lastOutcome = NULL, updatedAt = ${now()}
              WHERE workerId = ${pending.workerId}
            `;
            timeline.add(pending.threadId, "resumed", "已恢复运行（回收后按连接器快照对账）", {
              workerId: pending.workerId,
              reconciled: true,
            });
          } else {
            // The connector says the run ended while it was unreachable: take its word for it.
            sql`
              UPDATE sh_worker SET state = ${pending.snapState}, updatedAt = ${now()}
              WHERE workerId = ${pending.workerId}
            `;
            timeline.add(pending.threadId, "note", `对账：连接器报告运行已结束（${pending.snapState}）`, {
              workerId: pending.workerId,
              reconciled: true,
            });
          }
          if (pending.snapState === 'broken') {
            recordBrokenQuestion(worker, `q_broken_${worker.workerId}_${processed}`, '自动恢复未成功（回收后对账），需要你决定下一步。');
          }
          recomputeThreadState(pending.threadId);
        });
      }
      return resolved;
    },

    /**
     * A start_worker the user withdrew (the dispatcher's `expired` — its only writer) ends
     * its still-`starting` worker quietly — timeline only, no push: the user already knows
     * they cancelled. Opens the Thread for a fresh dispatch instead of wedging it behind a
     * worker that will never run. (notAfter queue timeouts are `failed/not_after` and route
     * through markStartFailed with a push — the owner did NOT ask for that one.)
     */
    settleWithdrawnStart(workerId: string): boolean {
      const worker = workers.get(workerId);
      if (!worker || worker.state !== "starting") return false;
      sql`UPDATE sh_worker SET state = 'idle', lastOutcome = 'cancelled', worktreeStatus = 'none', updatedAt = ${now()} WHERE workerId = ${workerId}`;
      timeline.add(worker.threadId, "note", "派发命令已撤回，worker 未启动", { workerId, withdrawn: true });
      recomputeThreadState(worker.threadId);
      return true;
    },
  };

  const reports = {
    latestForWorker(workerId: string): ReportRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_report WHERE workerId = ${workerId} ORDER BY seq DESC LIMIT 1
      `[0];
      return row ? viewReport(row) : null;
    },
    /** The Thread's reports, oldest first (receivedAt then arrival order — a same-ms burst
     *  stays in the order the connector sent it). Raw material for handoff briefs (§2.6). */
    listByThread(threadId: string): ReportRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_report WHERE threadId = ${threadId} ORDER BY receivedAt, rowid
      `.map(viewReport);
    },
  };

  // ---- handoff briefs (steward.md §2.6, issue #8) -------------------------------------------------

  const handoff = {
    /**
     * Assembles the deterministic brief for a new session on a Thread (§2.6): goal,
     * current state, deduped decisions with their source worker, the latest leftovers, and
     * git pointers — pointers, not content. The steward adds only the task at hand
     * afterwards (handoff.renderHandoffBrief leaves the section open for exactly that).
     *
     * `fromWorker` names the leg to continue from; it defaults to the Thread's latest
     * `relay` worker (`sibling` probes never override main-chain relay state, ADR-0022).
     * Pointers fall back to the Thread's latest reported git facts when that leg
     * reported none (connector-pi.md §7.2: facts come from git, never the model).
     */
    build(threadId: string, fromWorker?: string): HandoffBrief | null {
      const thread = threads.get(threadId);
      if (!thread) return null;
      const all = workers.listByThread(threadId);
      if (all.length === 0) return null;
      const relayWorkers = all.filter((w) => (w.workerRelation ?? "relay") === "relay");
      const named = fromWorker !== undefined ? all.find((w) => w.workerId === fromWorker) : undefined;
      const fromWorkerRow = named ?? relayWorkers.at(-1);
      if (!fromWorkerRow) return null;
      const allReports = reports.listByThread(threadId);
      const relayWorkerIds = new Set(relayWorkers.map((w) => w.workerId));
      const threadReports =
        (fromWorkerRow.workerRelation ?? "relay") === "relay"
          ? allReports.filter((r) => relayWorkerIds.has(r.workerId))
          : allReports;
      const latestGit = threadReports.filter((r): r is ReportRow & { git: GitFacts } => r.git !== null).at(-1) ?? null;
      // A readonly from-leg has no branch of its own: its predecessor's pointers carry the
      // relay (finding 4) — same resolution the dispatcher uses for the base.
      const pointerWorker = fromWorkerRow.branch ? fromWorkerRow : workers.latestBranchOnThread(threadId);
      return assembleBrief({
        threadId,
        goal: thread.goal ?? thread.title,
        state: thread.summary,
        fromWorker: fromWorkerRow,
        ...(pointerWorker ? { pointerWorker } : {}),
        reports: threadReports,
        latestGit,
      });
    },
  };

  /** ADR-0022 Decision 7: picks an agent on `machine` that explicitly declares `readonly: true`.
   *  Prefers `preferredAgent` when it is read-only-capable, then `pi`, then any `readonly: true` agent. */
  function selectReadonlyAgent(machine: MachineRow | null, preferredAgent?: string): string | null {
    if (!machine) return null;
    const caps = machine.agentCapabilities ?? {};
    const isReadonlyCapable = (agent: string): boolean =>
      machine.agents.includes(agent) && caps[agent]?.readonly === true;
    if (preferredAgent && isReadonlyCapable(preferredAgent)) return preferredAgent;
    if (isReadonlyCapable("pi")) return "pi";
    for (const agent of machine.agents) {
      if (isReadonlyCapable(agent)) return agent;
    }
    return null;
  }

  const proposals = {
    get(id: string): ProposalRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_proposal WHERE id = ${id}`[0];
      return row ? viewProposal(row) : null;
    },
    byDedupeKey(dedupeKey: string): ProposalRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_proposal WHERE dedupeKey = ${dedupeKey}`[0];
      return row ? viewProposal(row) : null;
    },
    list(): ProposalRow[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_proposal ORDER BY createdAt, id`.map(viewProposal);
    },
    listByThread(threadId: string): ProposalRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_proposal WHERE threadId = ${threadId} ORDER BY createdAt, id
      `.map(viewProposal);
    },
    listByWorker(workerId: string): ProposalRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_proposal WHERE workerId = ${workerId} ORDER BY createdAt, id
      `.map(viewProposal);
    },
    pendingDispatch(): ProposalRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_proposal WHERE status IN ('auto_approved', 'approved') ORDER BY createdAt, id
      `.map(viewProposal);
    },
    markDispatched(id: string, cmdId: string): boolean {
      sql`UPDATE sh_proposal SET status = 'dispatched', cmdId = ${cmdId} WHERE id = ${id} AND status IN ('auto_approved', 'approved')`;
      return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    },
    /** Withdraws an unstarted sibling proposal when its spawned worker is cancelled pre-flight. */
    markWithdrawnBySpawnedWorker(spawnedWorkerId: string, actor = 'user:worker_stop'): boolean {
      sql`
        UPDATE sh_proposal
        SET status = 'declined', decidedBy = ${actor}, decidedAt = ${now()}
        WHERE spawnedWorkerId = ${spawnedWorkerId} AND status IN ('auto_approved', 'approved', 'dispatched')
      `;
      return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    },
    /** Cancels all still-open cross-machine probe confirmation cards on a Thread. */
    cancelOpenForThread(threadId: string, reason: string, actor = 'user:thread_stop'): string[] {
      return tx(() => {
        const tsNow = now();
        const open = sql<Record<string, unknown>>`
          SELECT * FROM sh_proposal
          WHERE threadId = ${threadId} AND status = 'pending_owner' AND (expiresAt IS NULL OR expiresAt > ${tsNow})
          ORDER BY createdAt, id
        `.map(viewProposal);
        if (open.length === 0) return [];
        for (const p of open) {
          sql`
            UPDATE sh_proposal
            SET status = 'declined', decidedBy = ${actor}, decidedAt = ${tsNow}
            WHERE id = ${p.id} AND status = 'pending_owner'
          `;
          questions.close(p.id, reason);
        }
        recomputeThreadState(threadId);
        return open.map((p) => p.id);
      });
    },
    expireDue(nowMs: number = now()): number {
      return tx(() => {
        const due = sql<Record<string, unknown>>`
          SELECT * FROM sh_proposal
          WHERE status = 'pending_owner' AND expiresAt IS NOT NULL AND expiresAt <= ${nowMs}
          ORDER BY createdAt, id
        `.map(viewProposal);
        for (const p of due) {
          sql`
            UPDATE sh_proposal
            SET status = 'expired', decidedBy = 'ttl_expired', decidedAt = ${nowMs}
            WHERE id = ${p.id} AND status = 'pending_owner'
          `;
          questions.close(p.id, "跨机只读探针确认已过期");
          timeline.add(p.threadId, "note", `跨机只读探针确认已过期（${p.targetRepoRef}）`, {
            proposalId: p.id,
            proposalKey: p.proposalKey,
            workerId: p.workerId,
          });
          recomputeThreadState(p.threadId);
        }
        return due.length;
      });
    },
    decide(id: string, approve: boolean, ownerRef: string): ProposalDecisionOutcome {
      if (!ownerRef.startsWith("user:")) throw new Error("owner_action_required");
      return tx(() => {
        const current = proposals.get(id);
        if (!current) return { status: "not_found", appliedNow: false, proposal: null };
        const tsNow = now();
        if (current.status === "declined") {
          return { status: "declined", appliedNow: false, proposal: current };
        }
        if (current.status === "expired") {
          return { status: "expired", appliedNow: false, proposal: current };
        }
        if (current.status !== "pending_owner") {
          return { status: "already_decided", appliedNow: false, proposal: current };
        }
        if ((current.expiresAt !== null && current.expiresAt <= tsNow) || questions.get(id)?.status !== "open") {
          sql`
            UPDATE sh_proposal
            SET status = 'expired', decidedBy = 'ttl_expired', decidedAt = ${tsNow}
            WHERE id = ${id}
          `;
          questions.close(id, "跨机只读探针确认已过期");
          timeline.add(current.threadId, "note", `跨机只读探针确认已过期（${current.targetRepoRef}）`, {
            proposalId: id,
            proposalKey: current.proposalKey,
            workerId: current.workerId,
          });
          recomputeThreadState(current.threadId);
          return { status: "expired", appliedNow: true, proposal: proposals.get(id)! };
        }
        if (!approve) {
          sql`
            UPDATE sh_proposal
            SET status = 'declined', decidedBy = ${ownerRef}, decidedAt = ${tsNow}
            WHERE id = ${id}
          `;
          questions.close(id, "暂不探测");
          timeline.add(current.threadId, "answer", `拒绝跨机只读探针（${current.targetRepoRef}）`, {
            proposalId: id,
            proposalKey: current.proposalKey,
            workerId: current.workerId,
          });
          recomputeThreadState(current.threadId);
          return { status: "declined", appliedNow: true, proposal: proposals.get(id)! };
        }

        const rejectLive = (rejectCode: ProposalRejectCode, noteText: string): ProposalDecisionOutcome => {
          sql`
            UPDATE sh_proposal
            SET status = 'rejected', rejectCode = ${rejectCode}, decidedBy = ${ownerRef}, decidedAt = ${tsNow}
            WHERE id = ${id}
          `;
          questions.close(id, noteText);
          timeline.add(current.threadId, "note", noteText, {
            proposalId: id,
            proposalKey: current.proposalKey,
            workerId: current.workerId,
            rejectCode,
          });
          if (threads.get(current.threadId)) recomputeThreadState(current.threadId);
          return { status: "rejected", appliedNow: true, rejectCode, proposal: proposals.get(id)! };
        };

        const thread = threads.get(current.threadId);
        if (!thread || thread.archived) {
          return rejectLive("thread_archived", "批准跨机只读探针失败（thread_archived）：所属 Thread 已归档或不存在");
        }
        const machine = current.targetDeviceId ? machines.get(current.targetDeviceId) : null;
        if (!machine || !machine.online) {
          return rejectLive(
            "machine_offline",
            `批准跨机只读探针失败（machine_offline）：目标机器已离线（${current.targetRepoRef}）`,
          );
        }
        const repoSummary =
          current.targetRepoId && current.targetDeviceId
            ? repos.get(current.targetRepoId, current.targetDeviceId)
            : null;
        if (!repoSummary) {
          return rejectLive(
            "repo_not_found",
            `批准跨机只读探针失败（repo_not_found）：目标仓库已不在该机器登记（${current.targetRepoRef}）`,
          );
        }
        const agent = current.selectedAgent;
        if (!agent || !machine.agents.includes(agent) || machine.agentCapabilities?.[agent]?.readonly !== true) {
          return rejectLive(
            "no_readonly_agent",
            `批准跨机只读探针失败（no_readonly_agent）：目标机器 ${machine.name} 的只读代理能力已变化`,
          );
        }
        const activeThreadSiblings = sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM sh_worker
          WHERE threadId = ${current.threadId} AND workerRelation = 'sibling'
            AND state IN ('queued', 'starting', 'running', 'recovering')
        `[0]!.n;
        if (activeThreadSiblings >= MAX_IN_FLIGHT_SIBLINGS_PER_THREAD) {
          return rejectLive("quota_exceeded", "批准跨机只读探针失败（quota_exceeded）：当前 Thread 运行中的只读探针已达上限");
        }

        const parent = workers.get(current.workerId);
        const spawnedWorkerId = `w_${ulid()}`;
        const cmdId = `proposal:${id}`;
        workers.register({
          workerId: spawnedWorkerId,
          threadId: current.threadId,
          deviceId: machine.deviceId,
          repoId: repoSummary.repoId,
          agent,
          mode: "readonly",
          cmdId,
          parentWorker: current.workerId,
          workerRelation: "sibling",
          proposalDepth: Math.min(MAX_PROPOSAL_DEPTH, (parent?.proposalDepth ?? 0) + 1),
        });
        sql`
          UPDATE sh_proposal
          SET status = 'approved', spawnedWorkerId = ${spawnedWorkerId}, cmdId = ${cmdId},
              decidedBy = ${ownerRef}, decidedAt = ${tsNow}
          WHERE id = ${id}
        `;
        questions.close(id, "批准只读探针");
        timeline.add(
          current.threadId,
          "dispatch",
          `已批准跨机只读探针 ${spawnedWorkerId}（${agent}@${machine.name}，仓库 ${escapeMarkers(repoSummary.name)}）：${current.reason}`,
          {
            workerId: spawnedWorkerId,
            parentWorker: current.workerId,
            proposalId: id,
            proposalKey: current.proposalKey,
            cmdId,
            repoId: repoSummary.repoId,
            workerRelation: "sibling",
            crossMachine: true,
          },
        );
        recomputeThreadState(current.threadId);
        return {
          status: "approved",
          appliedNow: true,
          proposal: proposals.get(id)!,
          spawnedWorkerId,
          cmdId,
        };
      });
    },
  };

  const questions = {
    openForThread(threadId: string): QuestionRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_question WHERE threadId = ${threadId} AND status = 'open'
        ORDER BY askedAt DESC LIMIT 1
      `[0];
      return row ? viewQuestion(row) : null;
    },
    get(qid: string): QuestionRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_question WHERE qid = ${qid}`[0];
      return row ? viewQuestion(row) : null;
    },
    openForWorker(workerId: string): QuestionRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_question WHERE workerId = ${workerId} AND status = 'open' ORDER BY askedAt, qid
      `.map(viewQuestion);
    },
    markHandled(qid: string): void {
      sql`UPDATE sh_question SET handledAt = COALESCE(handledAt, ${now()}) WHERE qid = ${qid}`;
    },
    setOptions(qid: string, options: string[]): void {
      sql`UPDATE sh_question SET options = ${JSON.stringify(options)} WHERE qid = ${qid} AND status = 'open'`;
    },
    /** Atomic timeout → intent. A reset can only replay the same durable intent. */
    queueFallbacks(): void {
      tx(() => {
        for (const q of sql<QuestionRow>`
          SELECT * FROM sh_question WHERE status = 'open' AND handledAt IS NULL AND fallbackDueAt <= ${now()}
        `) {
          if (q.threadId) notifications.queue(`question:${q.qid}`, 'attention_report', q.threadId, q.workerId, q.qid);
          questions.markHandled(q.qid);
        }
      });
    },
    nextFallback(): number | null {
      return sql<{ at: number | null }>`
        SELECT MIN(fallbackDueAt) AS at FROM sh_question WHERE status = 'open' AND handledAt IS NULL
      `[0]?.at ?? null;
    },
    /** Open, unhandled questions — the sweep's working set (§5.3). */
    unhandled(): QuestionRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_question WHERE status = 'open' AND handledAt IS NULL AND fallbackDueAt IS NOT NULL ORDER BY fallbackDueAt, qid
      `.map(viewQuestion);
    },
    /** Test seam: shrink/extend the window of an already-open question (mirrors the reducer). */
    setFallbackWindow(qid: string, ms: number): void {
      const q = questions.get(qid);
      if (!q) return;
      sql`UPDATE sh_question SET fallbackDueAt = ${q.askedAt + ms} WHERE qid = ${qid} AND status = 'open'`;
    },
    /**
     * Issue #28: the daily cap skipped the wake that would have handled this question inside
     * its window. Expire the window NOW and queue the very same §5.3 forward the 90-second
     * timeout would have queued — one deterministic `attention_report`, rendered from the
     * question text verbatim, no model. Used only when the owner has had no card at all for
     * this event (a failure push already reached them, so those are left alone).
     */
    forwardNow(qid: string): boolean {
      const q = questions.get(qid);
      if (!q || q.status !== "open" || q.handledAt !== null || q.threadId === null) return false;
      notifications.queue(`question:${qid}`, "attention_report", q.threadId, q.workerId, qid);
      questions.markHandled(qid);
      return true;
    },
    /** The ask_user button mapping (issue #7): plain options + routing candidates. */
    payload(qid: string): AskCandidates | null {
      const row = sql<{ options: string | null; candidates: string | null }>`
        SELECT options, candidates FROM sh_question WHERE qid = ${qid}
      `[0];
      if (!row) return null;
      return {
        options: jsonOrNull<string[]>(row.options) ?? [],
        candidates: jsonOrNull<AskCandidates["candidates"]>(row.candidates) ?? [],
      };
    },
    /** ask_user's insert (issue #7): threadId null for a threadless routing ask. */
    insert(input: { qid: string; threadId: string | null; workerId?: string | null; text: string; options?: string[]; candidates?: AskCandidates["candidates"]; kind?: QuestionRow["kind"]; fallbackDueAt?: number }): void {
      sql`
        INSERT OR IGNORE INTO sh_question (qid, threadId, workerId, text, options, candidates, status, askedAt, kind, fallbackDueAt)
        VALUES (${input.qid}, ${input.threadId}, ${input.workerId ?? null}, ${input.text},
                ${JSON.stringify(input.options ?? [])}, ${JSON.stringify(input.candidates ?? [])}, 'open', ${now()},
                ${input.kind ?? 'steward'}, ${input.fallbackDueAt ?? null})
      `;
      if (input.threadId) recomputeThreadState(input.threadId);
    },
    /** Marks one question answered with what settled it (a click's chosen label). */
    close(qid: string, answer: string): boolean {
      sql`
        UPDATE sh_question SET status = 'answered', answeredAt = ${now()}
        WHERE qid = ${qid} AND status = 'open'
      `;
      const changed = sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
      const row = changed ? questions.get(qid) : null;
      if (row?.threadId) {
        timeline.add(row.threadId, "note", `问题已回答：${answer.slice(0, 120)}`, { qid });
        recomputeThreadState(row.threadId);
      }
      return changed;
    },
    /** A fresh dispatch supersedes what the Thread was waiting on (the user moved on). */
    closeOpen(threadId: string, reason: string): void {
      sql`
        UPDATE sh_question SET status = 'answered', answeredAt = ${now()}
        WHERE threadId = ${threadId} AND status = 'open'
      `;
      if (sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0) {
        timeline.add(threadId, "note", `问题已关闭：${reason}`, null);
        recomputeThreadState(threadId);
      }
    },
  };

  const timeline = {
    /** A summary event. `threadId` null = a Thread-less record (a routine fire, §8.6) — kept
     *  for audit; thread pages filter by id so it never leaks into a Thread's timeline. */
    add(threadId: string | null, kind: string, text: string, refs: Record<string, unknown> | null): void {
      sql`
        INSERT INTO sh_timeline (threadId, ts, kind, text, refs)
        VALUES (${threadId}, ${now()}, ${kind}, ${text}, ${refs ? JSON.stringify(refs) : null})
      `;
      if (threadId !== null) sql`UPDATE sh_thread SET lastActivityAt = ${now()} WHERE threadId = ${threadId}`;
    },
    list(threadId: string): TimelineRow[] {
      return sql<TimelineRow>`SELECT id, threadId, ts, kind, text FROM sh_timeline WHERE threadId = ${threadId} ORDER BY id`;
    },
    /** The newest `limit` entries, oldest first — the workspace's compact view of a Thread. */
    recent(threadId: string, limit: number): TimelineRow[] {
      return sql<TimelineRow>`
        SELECT id, threadId, ts, kind, text FROM sh_timeline WHERE threadId = ${threadId} ORDER BY id DESC LIMIT ${limit}
      `.reverse();
    },
  };

  const offlineDispatches = {
    get(cmdId: string): OfflineDispatchRow | null {
      const row = sql<{ cmdId: string; threadId: string; deviceId: string; input: string; status: OfflineDispatchRow["status"]; choices: string | null }>`
        SELECT * FROM sh_offline_dispatch WHERE cmdId = ${cmdId}`[0];
      return row ? { ...row, input: JSON.parse(row.input), choices: JSON.parse(row.choices ?? "[]") } : null;
    },
    create(input: StartWorkerInput, threadId: string, deviceId: string): void {
      sql`INSERT OR IGNORE INTO sh_offline_dispatch (cmdId, threadId, deviceId, input)
        VALUES (${input.cmdId}, ${threadId}, ${deviceId}, ${JSON.stringify(input)})`;
    },
    transition(cmdId: string, from: OfflineDispatchRow["status"], to: OfflineDispatchRow["status"], choices: string[] = []): boolean {
      sql`UPDATE sh_offline_dispatch SET status = ${to}, choices = ${JSON.stringify(choices)} WHERE cmdId = ${cmdId} AND status = ${from}`;
      return sql<{ n: number }>`SELECT changes() AS n`[0]!.n > 0;
    },
    /** Flips switching → switched WITHOUT touching the stored choices, and `reopen` flips
     *  it back the same way (PR #51 review finding 8): the picker's buttons index into the
     *  choices, so any transition that rewrote them — including the forward one — would
     *  strand a refused switch exactly as before the fix. */
    markSwitched(cmdId: string, to: "switched" | "switching" = "switched"): boolean {
      const from = to === "switched" ? "switching" : "switched";
      sql`UPDATE sh_offline_dispatch SET status = ${to} WHERE cmdId = ${cmdId} AND status = ${from}`;
      return sql<{ n: number }>`SELECT changes() AS n`[0]!.n > 0;
    },
  };

  // ---- notification intents (§5.1 step 4) --------------------------------------------------------

  const notifications = {
    /** INSERT OR IGNORE on dedupeKey: the reducer transaction may be re-entered after a crash.
     *  `questionId` links #10's resolution window to its question row; `dueAt` is the
     *  machine-status debounce (§5.3) — such intents are data until the state has held for
     *  the window, and the drain re-checks them, not a timer promise. `payload` is #21's
     *  pr-intent render input (url/stage/message) — data the renderer reads, not state. */
    queue(
      dedupeKey: string,
      kind: NotifyRow["kind"],
      threadId: string,
      workerId: string | null,
      questionId: string | null = null,
      payload: string | null = null,
      dueAt?: number,
    ): void {
      // The debounced variants add the dueAt column; interpolation would bind a parameter,
      // not SQL text, so the statement is chosen before the template runs. Both variants
      // write payload — the column exists for everyone once migration 018 has run.
      const stmt =
        dueAt === undefined
          ? sql`INSERT OR IGNORE INTO sh_notify (dedupeKey, kind, threadId, workerId, createdAt, questionId, payload)
                VALUES (${dedupeKey}, ${kind}, ${threadId}, ${workerId}, ${now()}, ${questionId}, ${payload})`
          : sql`INSERT OR IGNORE INTO sh_notify (dedupeKey, kind, threadId, workerId, questionId, dueAt, createdAt, payload)
                VALUES (${dedupeKey}, ${kind}, ${threadId}, ${workerId}, ${questionId}, ${dueAt}, ${now()}, ${payload})`;
      void stmt;
    },
    /** Whether a row with this dedupeKey exists (sent or pending) — "already notified". */
    seen(dedupeKey: string): boolean {
      return sql`SELECT 1 AS one FROM sh_notify WHERE dedupeKey = ${dedupeKey}`.length > 0;
    },
    pending(): NotifyRow[] {
      return sql<NotifyRow>`SELECT id, dedupeKey, kind, threadId, workerId, questionId, payload FROM sh_notify WHERE sentAt IS NULL AND (dueAt IS NULL OR dueAt <= ${now()}) ORDER BY id`;
    },
    markSent(id: number): void {
      sql`UPDATE sh_notify SET sentAt = ${now()} WHERE id = ${id} AND sentAt IS NULL`;
    },
    /** A dropped intent (its news evaporated — a healed blip) is REMOVED, not marked sent:
     *  sentAt means "the owner was told", and later notices key off exactly that. */
    drop(id: number): void {
      sql`DELETE FROM sh_notify WHERE id = ${id} AND sentAt IS NULL`;
    },
  };

  // ---- PR consent gate (issue #21, spike-conclusions §2) ---------------------------------------

  const prConsent = {
    get(workerId: string, seq: number): PrConsentRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_pr_consent WHERE workerId = ${workerId} AND seq = ${seq}
      `[0];
      return row ? viewPrConsent(row) : null;
    },
    byCmd(cmdId: string): PrConsentRow | null {
      if (!cmdId) return null;
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_pr_consent WHERE cmdId = ${cmdId} ORDER BY updatedAt DESC LIMIT 1
      `[0];
      return row ? viewPrConsent(row) : null;
    },
    latestForWorker(workerId: string): PrConsentRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_pr_consent WHERE workerId = ${workerId} ORDER BY updatedAt DESC, seq DESC LIMIT 1
      `[0];
      return row ? viewPrConsent(row) : null;
    },
    /** Cross-card view of one worker's PR (review finding 5): consent rows are per report,
     *  but the PR is per worker/branch — any row's url answers for every card of that worker,
     *  and any approved-but-unresolved row means a dispatch is in flight. `pendingCmdId`
     *  names the in-flight command so a tap can prove liveness against the outbox. */
    branchState(workerId: string): { url: string | null; pending: boolean; pendingCmdId: string | null } {
      const rows = sql<{ url: string | null; decision: string; failure: string | null; cmdId: string | null }>`
        SELECT url, decision, failure, cmdId FROM sh_pr_consent WHERE workerId = ${workerId}
      `;
      const pendingRow = rows.find((r) => r.decision === "approved" && r.url === null && r.failure === null);
      return {
        url: rows.find((r) => r.url !== null)?.url ?? null,
        pending: pendingRow !== undefined,
        pendingCmdId: pendingRow?.cmdId ?? null,
      };
    },
    /** Records the user's tap. An upsert, never a silent re-create: a declined row may be
     *  approved later, and a failed approved row re-approved for another attempt (which
     *  clears the failure — the retry gets a fresh command id). */
    record(input: {
      workerId: string;
      seq: number;
      threadId: string;
      decision: "approved" | "declined";
      cmdId?: string | null;
      attempts?: number;
    }): void {
      sql`
        INSERT INTO sh_pr_consent (workerId, seq, threadId, decision, cmdId, attempts, url, failure, decidedAt, updatedAt)
        VALUES (${input.workerId}, ${input.seq}, ${input.threadId}, ${input.decision}, ${input.cmdId ?? null},
                ${input.attempts ?? 0}, NULL, NULL, ${now()}, ${now()})
        ON CONFLICT (workerId, seq) DO UPDATE SET
          decision = excluded.decision, cmdId = excluded.cmdId, attempts = excluded.attempts,
          url = NULL, failure = NULL, updatedAt = ${now()}
      `;
    },
    /** The pr_created landing: the loop's async answer (issue #21 AC2). */
    settleUrl(workerId: string, seq: number, url: string): void {
      sql`
        UPDATE sh_pr_consent SET url = ${url}, failure = NULL, updatedAt = ${now()}
        WHERE workerId = ${workerId} AND seq = ${seq}
      `;
    },
    /** The cmd_result(ok) backstop (review finding 4): the connector settles pr_worker with
     *  the URL even when the pr_created event was lost (its emit raced a shutdown). This
     *  delivers the card without the event; idempotent against the event path — whichever
     *  lands first wins, the other no-ops on the already-set url. */
    settleFromCommand(cmdId: string, url: string, branch: string): boolean {
      const row = prConsent.byCmd(cmdId);
      if (!row || (row.url !== null && row.url !== "")) return false;
      prConsent.settleUrl(row.workerId, row.seq, url);
      notifications.queue(
        `pr_created:cmd:${cmdId}`,
        "pr_created",
        row.threadId,
        row.workerId,
        null,
        JSON.stringify({ url, branch }),
      );
      timeline.add(row.threadId, "note", `PR 已创建：${url}${branch ? `（分支 ${branch}）` : ""}`, { workerId: row.workerId, cmdId });
      sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${row.threadId}`;
      recomputeThreadState(row.threadId);
      return true;
    },
    /** The failure sink both paths share — the pr_failed event AND a failed pr_worker
     *  command row (rejected at the door, or never delivered to an offline machine).
     *  Idempotent: only the FIRST failure on a decided row notifies; the duplicate that
     *  can follow (cmd_result after the event, or the event after the cmd path) must not
     *  push a second card. */
    fail(input: { workerId: string; cmdId?: string | null; stage: string; message: string }): boolean {
      const row = (input.cmdId ? prConsent.byCmd(input.cmdId) : null) ?? prConsent.latestForWorker(input.workerId);
      // url set = the PR exists: not a failure, whatever a racing duplicate says (it would
      // also clobber the good url with failure/NULL).
      if (!row || row.failure !== null || row.url !== null) return false;
      const message = input.message.slice(0, 280);
      sql`
        UPDATE sh_pr_consent SET failure = ${message}, url = NULL, updatedAt = ${now()}
        WHERE workerId = ${row.workerId} AND seq = ${row.seq}
      `;
      notifications.queue(
        // Attempt-scoped (review finding 1): the retry's failure must reach the owner too —
        // the row-level `failure IS NULL` guard alone deduped both attempts onto one card
        // because record() clears the marker between them. Both sinks of ONE attempt (the
        // pr_failed event and the failed cmd_result) still share this key: one card each.
        `prfail:${row.workerId}:${row.seq}:${row.attempts}`,
        "pr_failed",
        row.threadId,
        row.workerId,
        null,
        JSON.stringify({ stage: input.stage, message }),
      );
      timeline.add(
        row.threadId,
        "note",
        `推送/创建 PR 失败（${input.stage}）：${message}`,
        { workerId: row.workerId, ...(input.cmdId ? { cmdId: input.cmdId } : {}) },
      );
      sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${row.threadId}`;
      recomputeThreadState(row.threadId);
      return true;
    },
  };

  // ---- outbound queue rows (sh_outbound is ledger-owned; delivery policy lives in steward.ts)

  const outbound = {
    enqueue(input: {
      kind: "text" | "card";
      to: string;
      threadId?: string | null;
      questionId?: string | null;
      text?: string;
      card?: unknown;
      urgency?: "push" | "quiet";
      /** Structured merge section (issue #11): carried in the payload so a quiet group folds
       *  into one card that keeps each thread's three parts. */
      part?: QuietSection;
      /** The text carries a credential or is channel setup chatter: delivered, but kept out of
       *  the workspace's conversation. */
      private?: boolean;
      /** Stable dedupe key (review #6): same id → same row (INSERT OR IGNORE), never a second
       *  message; the id doubles as the provider-side uuid. Omitted: a fresh one-of message. */
      id?: string;
    }): string {
      // Issue #11 (steward.md §6.4): `urgency: push` is due NOW; a quiet row holds for the
      // merge window, ANCHORED at the oldest still-open quiet row for this channel+receiver —
      // arrivals inside an open window join it, later ones start their own.
      let dueAt = now();
      if ((input.urgency ?? "quiet") === "quiet") {
        const windowMs = quietWindowMs();
        const anchor = sql<{ at: number | null }>`
          SELECT MIN(createdAt) AS at FROM sh_outbound
          WHERE channel = 'local' AND receiveId = ${input.to} AND urgency = 'quiet'
            AND status = 'queued' AND createdAt > ${now() - windowMs}
        `[0]?.at;
        dueAt = anchor !== null && anchor !== undefined ? anchor + windowMs : now() + windowMs;
      }
      const payload = JSON.stringify({ text: input.text, card: input.card, part: input.part, ...(input.private ? { private: true } : {}) });
      if (input.id !== undefined) {
        sql`
          INSERT OR IGNORE INTO sh_outbound (id, channel, kind, receiveId, threadId, questionId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
          VALUES (${input.id}, 'local', ${input.kind}, ${input.to}, ${input.threadId ?? null}, ${input.questionId ?? null},
                  ${payload}, ${input.urgency ?? "quiet"}, 'queued', 0, ${dueAt}, ${now()})
        `;
        return input.id;
      }
      const id = ulid(); // stable across retries; doubles as the provider-side uuid
      sql`
        INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, questionId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
        VALUES (${id}, 'local', ${input.kind}, ${input.to}, ${input.threadId ?? null}, ${input.questionId ?? null},
                ${payload}, ${input.urgency ?? "quiet"}, 'queued', 0, ${dueAt}, ${now()})
      `;
      return id;
    },
    /** §3.1 signal 1: reply-to / card-callback routing, never data stuffed into the card.
     *  A MERGED card (issue #11) spans several threads — no single owner — so it routes to
     *  the conversation and the steward decides which matter the reply belongs to. */
    threadIdForProviderMsg(providerMsgId: string): string | null {
      const rows = outbound.threadIdsForProviderMsg(providerMsgId);
      return rows.length === 1 ? rows[0]! : null;
    },
    /** Every thread bound to a provider message (issue #11): one for single cards, several
     *  for a merged card — a reply to it means ALL of them were seen (§6.5). */
    threadIdsForProviderMsg(providerMsgId: string): string[] {
      return sql<{ threadId: string }>`
        SELECT DISTINCT threadId FROM sh_outbound WHERE providerMsgId = ${providerMsgId} AND threadId IS NOT NULL
      `.map((row) => row.threadId);
    },
    /** The full routing row behind a provider message: id (button actions key off it — e.g.
     *  `offer:` ids resolve a routine suggestion) plus its Thread, when bound. */
    rowForProviderMsg(providerMsgId: string): { id: string; threadId: string | null; questionId: string | null } | null {
      return sql<{ id: string; threadId: string | null; questionId: string | null }>`
        SELECT id, threadId, questionId FROM sh_outbound WHERE providerMsgId = ${providerMsgId}
      `[0] ?? null;
    },
    row(id: string): Record<string, unknown> | null {
      return sql<Record<string, unknown>>`SELECT * FROM sh_outbound WHERE id = ${id}`[0] ?? null;
    },
    /** Cards that may still hold a decision for the owner (the workspace's "Needs you"):
     *  questions, routine offers, offline asks, memory suggestions and PR consent. The
     *  caller decides which are still open; this only narrows the scan to what could be. */
    decisionCards(sinceMs: number): Record<string, unknown>[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_outbound
        WHERE kind = 'card' AND createdAt > ${sinceMs} AND (
          id LIKE 'offer:%' OR id LIKE 'offline:%' OR id LIKE 'switch:%' OR id LIKE 'noteask:%'
          OR id LIKE 'noteconfirm:%' OR id LIKE 'skilloffer:%'
          OR id LIKE 'proposalapproval:%' OR id LIKE 'prwatchapproval:%'
          OR (id LIKE 'notify:report:%' AND payload LIKE '%pr_approve%')
          OR questionId IS NOT NULL OR payload LIKE '%"action":"ask:%' OR payload LIKE '%"action":"asknew:%'
        )
        ORDER BY createdAt, id
      `;
    },
    rows(limit: number): Record<string, unknown>[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_outbound ORDER BY createdAt, id LIMIT ${limit}`;
    },

    // The rest are the delivery pass's state transitions on the same table (claims, retry
    // bookkeeping) — ledger-owned SQL so no caller ever writes sh_outbound by hand.

    /** Rows whose delivery pass died mid-send (claim expired): back to queued. */
    reclaimExpiredClaims(nowMs: number): void {
      sql`UPDATE sh_outbound SET status = 'queued' WHERE status = 'sending' AND claimExpiresAt <= ${nowMs}`;
    },
    dueIds(nowMs: number, batch: number): string[] {
      return sql<{ id: string }>`
        SELECT id FROM sh_outbound WHERE status = 'queued' AND nextAttemptAt <= ${nowMs}
        ORDER BY createdAt, id LIMIT ${batch}
      `.map((row) => row.id);
    },
    /** Due rows WITH their routing keys (issue #11): the delivery pass groups quiet rows by
     *  channel+receiver so one window leaves as one merged message. */
    dueRows(nowMs: number, batch: number): Array<{ id: string; urgency: string; channel: string; receiveId: string }> {
      return sql<{ id: string; urgency: string; channel: string; receiveId: string }>`
        SELECT id, urgency, channel, receiveId FROM sh_outbound
        WHERE status = 'queued' AND nextAttemptAt <= ${nowMs}
        ORDER BY createdAt, id LIMIT ${batch}
      `;
    },
    /** The claim (spike bug 1): one conditional UPDATE hands a row to exactly one pass. */
    claimForDelivery(id: string, nowMs: number, claimMs: number): OutboundDeliveryRow | null {
      const claim = crypto.randomUUID();
      sql`
        UPDATE sh_outbound SET status = 'sending', claimToken = ${claim}, claimExpiresAt = ${nowMs + claimMs}
        WHERE id = ${id} AND (status = 'queued' OR (status = 'sending' AND claimExpiresAt <= ${nowMs}))
      `;
      const row = sql<Omit<OutboundDeliveryRow, "claim">>`
        SELECT id, kind, channel, receiveId, attempts, payload, threadId, questionId
        FROM sh_outbound WHERE id = ${id} AND claimToken = ${claim}
      `[0];
      return row ? { ...row, claim } : null;
    },
    stillOwns(id: string, claim: string): boolean {
      return sql<{ claimToken: string | null }>`SELECT claimToken FROM sh_outbound WHERE id = ${id}`[0]?.claimToken === claim;
    },
    settleSent(id: string, claim: string, providerMsgId: string, nowMs: number): void {
      if (!outbound.stillOwns(id, claim)) return;
      sql`
        UPDATE sh_outbound SET status = 'sent', providerMsgId = ${providerMsgId}, sentAt = ${nowMs},
                               attempts = attempts + 1, claimToken = NULL, claimExpiresAt = NULL, lastError = NULL
        WHERE id = ${id}
      `;
    },
    /** `nextAttemptAt: null` settles the row permanently as failed. */
    settleFailure(id: string, claim: string, attempts: number, error: string, nextAttemptAt: number | null, nowMs: number): void {
      if (!outbound.stillOwns(id, claim)) return;
      if (nextAttemptAt === null) {
        sql`
          UPDATE sh_outbound SET status = 'failed', attempts = ${attempts}, lastError = ${error},
                                 claimToken = NULL, claimExpiresAt = NULL
          WHERE id = ${id}
        `;
        return;
      }
      sql`
        UPDATE sh_outbound SET status = 'queued', attempts = ${attempts}, nextAttemptAt = ${nextAttemptAt},
                               lastError = ${error}, claimToken = NULL, claimExpiresAt = NULL
        WHERE id = ${id}
      `;
    },
    /** Earliest moment the delivery alarm should fire again, or null when nothing is pending. */
    nextWake(nowMs: number): number | null {
      const nextDue = sql<{ at: number | null }>`
        SELECT MIN(nextAttemptAt) AS at FROM sh_outbound WHERE status = 'queued'
      `[0]?.at ?? null;
      const nextReclaim = sql<{ at: number | null }>`
        SELECT MIN(claimExpiresAt) AS at FROM sh_outbound WHERE status = 'sending'
      `[0]?.at ?? null;
      const candidates = [nextDue, nextReclaim].filter((v): v is number => v !== null);
      return candidates.length === 0 ? null : Math.min(...candidates);
    },
  };

  // ---- steward runs and wake_requests (steward.md §5.1 step 4, §6.3) --------------------------

  /** `mergeMs` is the 3-second merge window (§5.4); rows merge into a still-pending wake of
   *  the same kind without extending its dueAt, so wake latency stays bounded.
   *  `opts.operationId` (routine/follow-up fires): a fixed id with NO merging — each fire is
   *  its own steward input, and the operationId itself is the dedup (§8.2/§11). */
  const wakes = {
    queue(kind: WakeRow["kind"], dedupeKey: string, text: string, opts: { priority?: WakeRow["priority"]; mergeMs?: number; operationId?: string; dueAt?: number } = {}): void {
      const ts = now();
      if (sql`SELECT 1 FROM sh_wake WHERE dedupeKey = ${dedupeKey}`.length > 0) return;
      if (opts.operationId !== undefined) {
        sql`
          INSERT OR IGNORE INTO sh_wake (operationId, kind, dedupeKey, text, priority, status, dueAt, createdAt)
          VALUES (${opts.operationId}, ${kind}, ${dedupeKey}, ${text}, ${opts.priority ?? "normal"}, 'pending', ${opts.dueAt ?? ts}, ${ts})
        `;
        return;
      }
      const mergeMs = opts.mergeMs ?? WAKE_MERGE_MS;
      // Merge only within the same window class: a 10-minute external_activity wake must not
      // swallow a 3-second report wake (and vice versa) — their latencies answer different
      // needs (steward.md §5.3/§5.4). dueAt - createdAt is the row's own merge window.
      const open = sql<{ id: number; text: string }>`
        SELECT id, text FROM sh_wake
        WHERE kind = ${kind} AND status = 'pending' AND dueAt > ${ts}
          AND dueAt - createdAt >= ${Math.max(mergeMs - 1, 1)} AND dueAt - createdAt <= ${mergeMs + 1}
        ORDER BY id LIMIT 1
      `[0];
      if (open) {
        // §5.4: events within the window become ONE wake-up — append this block to the
        // pending row's text. The row keeps its operationId: one steward input, ever.
        sql`UPDATE sh_wake SET text = ${open.text + "\n" + text},
          priority = CASE WHEN ${opts.priority ?? 'normal'} = 'high' THEN 'high' ELSE priority END,
          dueAt = MIN(dueAt, ${ts + mergeMs}) WHERE id = ${open.id}`;
        sql`
          INSERT OR IGNORE INTO sh_wake (operationId, kind, dedupeKey, text, priority, status, dueAt, mergedInto, createdAt)
          VALUES (${"evt:" + ulid()}, ${kind}, ${dedupeKey}, ${text}, ${opts.priority ?? "normal"}, 'merged', ${ts + mergeMs}, ${open.id}, ${ts})
        `;
        return;
      }
      sql`
        INSERT OR IGNORE INTO sh_wake (operationId, kind, dedupeKey, text, priority, status, dueAt, createdAt)
        VALUES (${"evt:" + ulid()}, ${kind}, ${dedupeKey}, ${text}, ${opts.priority ?? "normal"}, 'pending', ${ts + mergeMs}, ${ts})
      `;
    },
    due(nowMs: number): WakeRow[] {
      return sql<WakeRow>`
        SELECT * FROM sh_wake WHERE status = 'pending' AND dueAt <= ${nowMs} ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, dueAt, id
      `;
    },
    /** Earliest pending dueAt (the next moment the drain alarm must fire), or null. */
    earliestDue(nowMs: number): number | null {
      return sql<{ at: number | null }>`SELECT MIN(dueAt) AS at FROM sh_wake WHERE status = 'pending'`[0]?.at ?? null;
    },
    markSubmitted(id: number): void {
      sql`UPDATE sh_wake SET status = 'submitted', submittedAt = ${now()} WHERE id = ${id} AND status = 'pending'`;
    },
    /** Issue #28 (steward.md §12): the daily budget cap kept this wake from the model. The
     *  row is done — 'skipped' never re-drains — and its audit trail stays in sh_channel_log
     *  (plus sh_routine/sh_followup.lastResult for fires, which own an outcome either way). */
    markSkipped(id: number): void {
      sql`UPDATE sh_wake SET status = 'skipped', submittedAt = ${now()} WHERE id = ${id} AND status = 'pending'`;
    },
  };

  const ownerInputs = {
    record(channel: "local" | "web" | "feishu", msgId: string, text: string | null, threadId: string | null = null): void {
      sql`
        INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized, text, threadId)
        VALUES (${channel}, ${msgId}, ${msgId}, 'message', ${now()}, 1, ${text}, ${threadId})
        ON CONFLICT(channel, msgId) DO UPDATE SET text = COALESCE(sh_inbound.text, excluded.text),
          threadId = COALESCE(sh_inbound.threadId, excluded.threadId), ownerAuthorized = 1
      `;
    },
  };

  const webRequests = {
    get(id: string): { payload: string; status: string } | null {
      return sql<{ payload: string; status: string }>`SELECT payload, status FROM sh_web_request WHERE id = ${id}`[0] ?? null;
    },
    start(id: string, payload: string): void {
      sql`INSERT OR IGNORE INTO sh_web_request (id, payload, createdAt) VALUES (${id}, ${payload}, ${now()})`;
    },
    complete(id: string): void {
      sql`UPDATE sh_web_request SET status = 'done' WHERE id = ${id}`;
    },
    pending(): Array<{ id: string; payload: string }> {
      return sql<{ id: string; payload: string }>`SELECT id, payload FROM sh_web_request WHERE status = 'pending' ORDER BY createdAt`;
    },
  };

  const runs = {
    /** False when the operationId already ran/queued — the idempotency answer (§11). */
    open(
      operationId: string,
      kind: RunRow["kind"],
      text: string,
      opts: { replyTo?: string; channel?: string; routedThreadId?: string | null } = {},
    ): boolean {
      const exists = sql`SELECT 1 AS one FROM sh_run WHERE operationId = ${operationId}`;
      if (exists.length > 0) return false;
      sql`
        INSERT INTO sh_run (operationId, kind, replyTo, channel, routedThreadId, text, status, createdAt)
        VALUES (${operationId}, ${kind}, ${opts.replyTo ?? null}, ${opts.channel ?? null}, ${opts.routedThreadId ?? null},
                ${text}, 'open', ${now()})
      `;
      return true;
    },
    openRows(): RunRow[] {
      return sql<RunRow>`SELECT * FROM sh_run WHERE status = 'open' ORDER BY createdAt, operationId`;
    },
    get(operationId: string): RunRow | null {
      return (sql<RunRow>`SELECT * FROM sh_run WHERE operationId = ${operationId}`[0] ?? null);
    },
    /** One more real dispatch happened inside this run (settle-time verification, issue #7). */
    countDispatch(operationId: string): void {
      sql`UPDATE sh_run SET dispatchCount = dispatchCount + 1 WHERE operationId = ${operationId}`;
    },
    rows(): RunRow[] {
      return sql<RunRow>`SELECT * FROM sh_run ORDER BY createdAt, operationId`;
    },
    /** Records the outcome. For kind=user the caller already queued the reply text. */
    settle(operationId: string, result: { status: string; reason?: string; text?: string }, replyOutboundId?: string): void {
      sql`
        UPDATE sh_run SET status = 'settled', resultStatus = ${result.status}, resultReason = ${result.reason ?? null},
                          resultText = ${result.text ?? null}, replyOutboundId = ${replyOutboundId ?? null}, settledAt = ${now()}
        WHERE operationId = ${operationId} AND status = 'open'
      `;
    },
    /**
     * ADR-0017: the owner stopped this turn. Its own terminal state, not `settled`, so nothing
     * downstream mistakes the withdrawal for a failed run and the row is never resubmitted (the
     * settler only re-submits `not_found`, and only for `open` rows). Idempotent: a turn already
     * settled or cancelled keeps its row.
     */
    cancel(operationId: string, reason: string, replyOutboundId?: string): void {
      sql`
        UPDATE sh_run SET status = 'cancelled', resultStatus = 'cancelled', resultReason = ${reason},
                          replyOutboundId = COALESCE(${replyOutboundId ?? null}, replyOutboundId), settledAt = ${now()}
        WHERE operationId = ${operationId} AND status = 'open'
      `;
    },
  };

  // ---- routines / follow-ups / offers (issue #20, steward.md §8) -------------------------------

  const routines = {
    create(input: {
      routineId: string;
      kind: RoutineKind;
      createdFromMsg: string;
      scheduleKind: "cron" | "once";
      cron?: string | null;
      onceAt?: number | null;
      instruction: string;
      threadId?: string | null;
      repoId?: string | null;
    }): RoutineRow {
      const ts = now();
      sql`
        INSERT OR IGNORE INTO sh_routine (routineId, kind, createdFromMsg, scheduleKind, cron, onceAt, instruction, repoId, threadId, status, createdAt)
        VALUES (${input.routineId}, ${input.kind}, ${input.createdFromMsg}, ${input.scheduleKind}, ${input.cron ?? null}, ${input.onceAt ?? null},
                ${input.instruction}, ${input.repoId ?? null}, ${input.threadId ?? null}, 'active', ${ts})
      `;
      return routines.get(input.routineId)!;
    },
    get(routineId: string): RoutineRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_routine WHERE routineId = ${routineId}`[0];
      return row ? viewRoutine(row) : null;
    },
    list(): RoutineRow[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_routine ORDER BY createdAt, routineId`.map(viewRoutine);
    },
    exists(routineId: string): boolean {
      return sql`SELECT 1 AS one FROM sh_routine WHERE routineId = ${routineId}`.length > 0;
    },
    setScheduleId(routineId: string, scheduleId: string): void {
      sql`UPDATE sh_routine SET scheduleId = ${scheduleId} WHERE routineId = ${routineId}`;
    },
    setStatus(routineId: string, status: RoutineStatus): boolean {
      sql`UPDATE sh_routine SET status = ${status} WHERE routineId = ${routineId}`;
      return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    },
    /**
     * The fire-level gate (§8.2/§11): claims this exact fire (`routine:<id>:<fireTime>`)
     * atomically. False = already processed — the SDK re-dispatched the job, or the alarm
     * replayed it — and the caller must do nothing. Also stamps lastRunAt/lastResult and
     * retires once-routines (a re-armed past onceAt must never fire twice).
     */
    beginFire(routineId: string, operationId: string, initialResult: string): boolean {
      return tx(() => {
        const row = sql<{ status: string; lastFireKey: string | null; scheduleKind: string }>`
          SELECT status, lastFireKey, scheduleKind FROM sh_routine WHERE routineId = ${routineId}
        `[0];
        if (!row || row.status !== "active" || row.lastFireKey === operationId) return false;
        sql`
          UPDATE sh_routine SET lastFireKey = ${operationId}, lastRunAt = ${now()}, lastResult = ${initialResult},
                                outcomeRecorded = 0,
                                status = CASE WHEN scheduleKind = 'once' THEN 'done' ELSE status END
          WHERE routineId = ${routineId}
        `;
        return true;
      });
    },
    /** The run's outcome (explicit no_action, or the settle fallback). Explicit wins. */
    recordOutcome(routineId: string, outcome: string): void {
      sql`
        UPDATE sh_routine SET lastResult = ${outcome}, outcomeRecorded = 1
        WHERE routineId = ${routineId} AND outcomeRecorded = 0
      `;
    },
  };

  const followups = {
    create(input: {
      followupId: string;
      threadId: string;
      dueAt: number;
      reason: string;
      createdBy: "user" | "steward";
      sourceRef: string;
    }): FollowupRow {
      sql`
        INSERT OR IGNORE INTO sh_followup (followupId, threadId, dueAt, reason, createdBy, sourceRef, status, createdAt)
        VALUES (${input.followupId}, ${input.threadId}, ${input.dueAt}, ${input.reason}, ${input.createdBy}, ${input.sourceRef}, 'open', ${now()})
      `;
      return followups.get(input.followupId)!;
    },
    get(followupId: string): FollowupRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_followup WHERE followupId = ${followupId}`[0];
      return row ? viewFollowup(row) : null;
    },
    listByThread(threadId: string): FollowupRow[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_followup WHERE threadId = ${threadId} ORDER BY createdAt`.map(viewFollowup);
    },
    list(): FollowupRow[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_followup ORDER BY createdAt, followupId`.map(viewFollowup);
    },
    exists(followupId: string): boolean {
      return sql`SELECT 1 AS one FROM sh_followup WHERE followupId = ${followupId}`.length > 0;
    },
    setScheduleId(followupId: string, scheduleId: string): void {
      sql`UPDATE sh_followup SET scheduleId = ${scheduleId} WHERE followupId = ${followupId}`;
    },
    setStatus(followupId: string, status: FollowupStatus): boolean {
      sql`UPDATE sh_followup SET status = ${status} WHERE followupId = ${followupId}`;
      return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    },
    /** The fire gate: only an `open` follow-up fires exactly once (status flips to `fired`). */
    beginFire(followupId: string, initialResult: string): boolean {
      return tx(() => {
        sql`
          UPDATE sh_followup SET status = 'fired', firedAt = ${now()}, lastResult = ${initialResult}, outcomeRecorded = 0
          WHERE followupId = ${followupId} AND status = 'open'
        `;
        return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
      });
    },
    recordOutcome(followupId: string, outcome: string): void {
      sql`
        UPDATE sh_followup SET lastResult = ${outcome}, outcomeRecorded = 1
        WHERE followupId = ${followupId} AND outcomeRecorded = 0
      `;
    },
  };

  const offers = {
    create(input: { offerId: string; spec: RoutineSpecStored; sourceMsg: string; outboundId: string }): RoutineOfferRow {
      sql`
        INSERT OR IGNORE INTO sh_routine_offer (offerId, spec, sourceMsg, status, outboundId, createdAt)
        VALUES (${input.offerId}, ${JSON.stringify(input.spec)}, ${input.sourceMsg}, 'offered', ${input.outboundId}, ${now()})
      `;
      return offers.get(input.offerId)!;
    },
    get(offerId: string): RoutineOfferRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_routine_offer WHERE offerId = ${offerId}`[0];
      return row ? viewOffer(row) : null;
    },
    /** The tap consumes the offer exactly once; false = already handled or unknown. */
    consume(offerId: string, status: "accepted" | "dismissed"): RoutineOfferRow | null {
      const row = offers.get(offerId);
      if (!row || row.status !== "offered") return null;
      sql`UPDATE sh_routine_offer SET status = ${status} WHERE offerId = ${offerId} AND status = 'offered'`;
      return { ...row, status };
    },
  };

  const viewSkillOffer = (r: Record<string, unknown>): SkillOfferRow => ({
    id: r.id as string,
    workerId: r.workerId as string,
    threadId: r.threadId as string,
    deviceId: r.deviceId as string,
    repoId: r.repoId as string,
    target: (r.target === "claude-skill" || r.target === "claude-command" ? r.target : "agents-skill") as RepoSkillTarget,
    slug: r.slug as string,
    name: r.name as string,
    description: r.description as string,
    summaryBullets: jsonOrNull<string[]>(r.summaryJson as string | null) ?? [],
    markdown: r.markdown as string,
    status: r.status as SkillOfferStatus,
    savedPath: (r.savedPath as string | null) ?? null,
    savedSha256: (r.savedSha256 as string | null) ?? null,
    failureReason: (r.failureReason as string | null) ?? null,
    createdAt: r.createdAt as number,
    decidedAt: (r.decidedAt as number | null) ?? null,
  });

  const skillOffers = {
    create(input: {
      id?: string;
      workerId: string;
      threadId: string;
      deviceId: string;
      repoId: string;
      target?: RepoSkillTarget;
      slug: string;
      name: string;
      description: string;
      summaryBullets: string[];
      markdown: string;
    }): SkillOfferRow | null {
      const id = input.id ?? `so_${ulid()}`;
      sql`
        INSERT OR IGNORE INTO sh_skill_offer (
          id, workerId, threadId, deviceId, repoId, target, slug, name, description,
          summaryJson, markdown, status, createdAt
        )
        VALUES (
          ${id}, ${input.workerId}, ${input.threadId}, ${input.deviceId}, ${input.repoId},
          ${input.target ?? "agents-skill"}, ${input.slug}, ${input.name}, ${input.description},
          ${JSON.stringify(input.summaryBullets.slice(0, 3))}, ${input.markdown}, 'offered', ${now()}
        )
      `;
      return skillOffers.byWorker(input.workerId);
    },
    get(id: string): SkillOfferRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_skill_offer WHERE id = ${id}`[0];
      return row ? viewSkillOffer(row) : null;
    },
    byWorker(workerId: string): SkillOfferRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_skill_offer WHERE workerId = ${workerId}`[0];
      return row ? viewSkillOffer(row) : null;
    },
    listByThread(threadId: string): SkillOfferRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_skill_offer WHERE threadId = ${threadId} ORDER BY createdAt, id
      `.map(viewSkillOffer);
    },
    cooldownStatus(
      threadId: string,
      repoId: string,
      nowMs: number = now(),
    ): { allowed: boolean; reason?: "thread_already_offered" | "repo_24h_cooldown" | "repo_72h_dismiss_backoff" } {
      const onThread = sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_skill_offer WHERE threadId = ${threadId}`[0]!.n;
      if (onThread > 0) return { allowed: false, reason: "thread_already_offered" };
      const recent = sql<Record<string, unknown>>`
        SELECT * FROM sh_skill_offer WHERE repoId = ${repoId} ORDER BY createdAt DESC, id DESC LIMIT 2
      `.map(viewSkillOffer);
      if (recent.length > 0) {
        const latest = recent[0]!;
        if (recent.length >= 2 && recent[0]!.status === "dismissed" && recent[1]!.status === "dismissed") {
          if (nowMs - latest.createdAt < 72 * 3_600_000) {
            return { allowed: false, reason: "repo_72h_dismiss_backoff" };
          }
        }
        if (nowMs - latest.createdAt < 24 * 3_600_000) {
          return { allowed: false, reason: "repo_24h_cooldown" };
        }
      }
      return { allowed: true };
    },
    beginSave(id: string): SkillOfferRow | null {
      sql`
        UPDATE sh_skill_offer SET status = 'saving', failureReason = NULL
        WHERE id = ${id} AND status IN ('offered', 'failed')
      `;
      if (sql<{ n: number }>`SELECT changes() AS n`[0]!.n === 0) return null;
      return skillOffers.get(id);
    },
    markSaved(id: string, savedPath: string, savedSha256: string): SkillOfferRow | null {
      sql`
        UPDATE sh_skill_offer
        SET status = 'saved', savedPath = ${savedPath}, savedSha256 = ${savedSha256},
            failureReason = NULL, decidedAt = ${now()}
        WHERE id = ${id}
      `;
      return skillOffers.get(id);
    },
    markFailed(id: string, failureReason: string): SkillOfferRow | null {
      sql`
        UPDATE sh_skill_offer
        SET status = 'failed', failureReason = ${failureReason.slice(0, 240)}, decidedAt = ${now()}
        WHERE id = ${id}
      `;
      return skillOffers.get(id);
    },
    dismiss(id: string): SkillOfferRow | null {
      sql`
        UPDATE sh_skill_offer SET status = 'dismissed', decidedAt = ${now()}
        WHERE id = ${id} AND status IN ('offered', 'failed')
      `;
      if (sql<{ n: number }>`SELECT changes() AS n`[0]!.n === 0) return null;
      return skillOffers.get(id);
    },
  };

  // ---- the reducer (steward.md §5) ----------------------------------------------------------------

  /**
   * Applies every contiguous, unprocessed event from the protocol layer's inbox to the
   * ledger — one transaction, idempotent per (workerId, seq) via worker_ack.processedUpTo
   * (protocol §4.3: persistence and processing are decoupled; a crash between the events_ack
   * and this call leaves the rows pending, and the next wake drains them again).
   */
  function applyPendingEvents(): { applied: number; completedRelayWorkers: string[] } {
    return tx(() => {
      let applied = 0;
      const completedRelaySet = new Set<string>();
      const tracked = sql<{ workerId: string; processedUpTo: number }>`
        SELECT workerId, processedUpTo FROM worker_ack
      `;
      for (const { workerId } of tracked) {
        for (;;) {
          const next = nextInboxRow(workerId);
          if (!next) break; // gap or fully drained: stop in order (resync fills gaps later)
          if (applyEvent(JSON.parse(next.payload) as Record<string, unknown>) === "relay_done") {
            completedRelaySet.add(workerId);
          }
          applied += 1;
        }
      }
      return { applied, completedRelayWorkers: [...completedRelaySet] };
    });
  }

  function nextInboxRow(workerId: string): InboxEventRow | null {
    const row = sql<{ processedUpTo: number }>`SELECT processedUpTo FROM worker_ack WHERE workerId = ${workerId}`[0];
    if (!row) return null;
    return (
      sql<InboxEventRow>`
        SELECT workerId, seq, payload FROM event_inbox WHERE workerId = ${workerId} AND seq = ${row.processedUpTo + 1}
      `[0] ?? null
    );
  }

  /** One event, already committed to the inbox. Deterministic; no LLM anywhere in here. */
  function applyEvent(event: Record<string, unknown>): "relay_done" | void {
    const workerId = String(event.workerId ?? "");
    const seq = Number(event.seq ?? 0);
    const type = String(event.type ?? "");
    const ts = Number(event.ts ?? 0) || now();
    const worker = workers.get(workerId);
    if (!worker) {
      // Events for a worker this deployment never dispatched (stale device, other owner):
      // advance the watermark so the row never re-blocks the queue, and touch nothing else.
      sql`UPDATE worker_ack SET processedUpTo = ${seq} WHERE workerId = ${workerId}`;
      return;
    }

    // Issue #13 review finding 2: a worker reaped by the DO that produces an event is alive.
    // If a hello-snapshot verdict is parked for this worker (its stream was behind at
    // reconnect), that verdict — not this event, which may predate the reap — decides once
    // the stream catches up (workers.resolveReapPending).
    const resurrectable =
      worker.state === "lost" &&
      worker.lastOutcome === "reaped" &&
      sql`SELECT 1 AS one FROM sh_reap_pending WHERE workerId = ${workerId}`.length === 0;

    // Issue #14: an event from the machine is contact, whatever the DO believed during the
    // drop — the unreachable mark dies with the first real news.
    sql`UPDATE sh_worker SET unreachable = 0 WHERE workerId = ${workerId}`;
    if (type === 'started' || type === 'resumed') {
      recordModelObservations(workerId, event);
    }
    switch (type) {
      case "queued": {
        // §8.2 serial repos (issue #16): the connector parked this write worker behind the
        // repo's current one; `started` follows when the slot frees. Not a failure — the
        // Thread stays running-shaped. A reaped worker that re-parks is provably alive:
        // clear the marker like every other resume path.
        sql`
          UPDATE sh_worker SET state = 'queued',
                              lastOutcome = CASE WHEN lastOutcome = 'reaped' THEN NULL ELSE lastOutcome END,
                              lastEventAt = ${ts}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        timeline.add(worker.threadId, "note", "排队中：等同一仓库的前一个写任务结束（serial 模式）", {
          workerId,
          seq,
          behind: event.behind ?? null,
        });
        break;
      }
      case "started": {
        // branch COALESCEs: a resumed session's started event carries no branch (the hot
        // prompt path, connector-pi.md §6.2) and must not erase the branch the ledger
        // already holds — it is the relay base for the next leg (issue #8).
        sql`
          UPDATE sh_worker SET state = 'running', sessionId = ${str(event.sessionId)},
                              branch = COALESCE(${str(event.branch)}, branch),
                              worktreeStatus = CASE WHEN ${str(event.branch)} IS NOT NULL AND worktreeStatus = 'none' THEN 'active' ELSE worktreeStatus END,
                              lastOutcome = CASE WHEN lastOutcome = 'reaped' THEN NULL ELSE lastOutcome END,
                              lastEventAt = ${ts}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        timeline.add(worker.threadId, "started", `worker 开始运行${event.branch ? `（分支 ${String(event.branch)}）` : ""}`, {
          workerId,
          seq,
        });
        break;
      }
      case "progress": {
        // Coarse progress only updates the worker; it never reaches the timeline (§5.3) —
        // except when it proves a reaped worker is alive (issue #13 review finding 2).
        const lastProgress = JSON.stringify({ phase: event.phase, tool: event.tool ?? null, target: event.target ?? null, turn: event.turn ?? null });
        if (resurrectable) {
          sql`
            UPDATE sh_worker SET state = 'running', lastOutcome = NULL, lastEventAt = ${ts},
                                lastProgress = ${lastProgress}, updatedAt = ${now()}
            WHERE workerId = ${workerId}
          `;
          timeline.add(worker.threadId, "resumed", "重新收到事件，恢复运行（回收后自动纠正）", { workerId, seq, resurrected: true });
          recomputeThreadState(worker.threadId);
        } else {
          sql`
            UPDATE sh_worker SET lastEventAt = ${ts}, lastProgress = ${lastProgress}, updatedAt = ${now()}
            WHERE workerId = ${workerId}
          `;
        }
        sql`UPDATE worker_ack SET processedUpTo = ${seq} WHERE workerId = ${workerId}`;
        return; // no further state change
      }
      case "report": {
        if (resurrectable) {
          // A report from a worker the DO reaped: it is alive (issue #13 review finding 2).
          sql`UPDATE sh_worker SET state = 'running', lastOutcome = NULL, updatedAt = ${now()} WHERE workerId = ${workerId}`;
          timeline.add(worker.threadId, "resumed", "重新收到事件，恢复运行（回收后自动纠正）", { workerId, seq, resurrected: true });
        }
        const isSibling = worker.workerRelation === "sibling";
        const status = (event.status === "blocked" || event.status === "needs_decision" ? event.status : "done") as ReportRow["status"];
        const normalizedLabels = normalizeReportLabels(event.labels);
        if (normalizedLabels.dropped.length > 0) {
          sql`
            INSERT INTO sh_channel_log (ts, channel, reason, detail)
            VALUES (${now()}, 'local', 'report_labels_dropped', ${`${workerId}:${seq} dropped=${normalizedLabels.dropped.join(",")}`})
          `;
        }
        const storedLabels = normalizedLabels.labels;
        sql`
          INSERT OR IGNORE INTO sh_report (workerId, seq, threadId, status, summary, changes, decisions, leftovers, labels, tests, question, next, git, answer, receivedAt)
          VALUES (${workerId}, ${seq}, ${worker.threadId}, ${status}, ${str(event.summary) ?? ""},
                  ${event.changes ? JSON.stringify(event.changes) : null},
                  ${event.decisions ? JSON.stringify(event.decisions) : null},
                  ${event.leftovers ? JSON.stringify(event.leftovers) : null},
                  ${storedLabels !== undefined ? JSON.stringify(storedLabels) : null},
                  ${event.tests ? JSON.stringify(event.tests) : null},
                  ${str(event.question)}, ${str(event.next)},
                  ${event.git ? JSON.stringify(event.git) : null}, ${str(event.answer)}, ${now()})
        `;
        sql`
          UPDATE sh_worker SET lastOutcome = ${`reported:${status}`}, lastEventAt = ${ts}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        if (!isSibling || status !== "done") {
          sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        }
        const labelSuffix = storedLabels && storedLabels.length > 0 ? `\n标签：${storedLabels.join(", ")}` : "";
        timeline.add(
          worker.threadId,
          "report",
          `${isSibling ? "只读探针汇报" : "汇报"}（${status}）：${str(event.summary) ?? ""}${labelSuffix}`,
          {
            workerId,
            seq,
            ...(isSibling ? { workerRelation: "sibling" } : {}),
            ...(storedLabels && storedLabels.length > 0 ? { labels: storedLabels } : {}),
          },
        );
        let relayDone = false;
        if (status === "done") {
          // ADR-0022 Decision 8: `sibling` done reports feed Steward synthesis via `event`
          // wake without spamming a standalone owner done card.
          if (!isSibling) {
            notifications.queue(`report:${workerId}:${seq}`, "done_report", worker.threadId, workerId);
            relayDone = true;
          }
        } else {
          questions.insert({
            qid: `q_${workerId}_${seq}`, threadId: worker.threadId, workerId,
            text: str(event.question) ?? str(event.summary) ?? '', kind: 'report',
            fallbackDueAt: now() + QUESTION_WINDOW_MS,
          });
        }
        // §5.3: report events wake the steward for bookkeeping (summary, notes). The
        // deterministic card above still goes out on its own — the LLM is not on its path.
        wakes.queue(
          "event",
          `report:${workerId}:${seq}`,
          eventWakeText({
            thread: threads.get(worker.threadId),
            worker: workers.get(workerId)!,
            machine: machines.get(worker.deviceId),
            report: {
              status,
              summary: str(event.summary) ?? "",
              changes: Array.isArray(event.changes) ? (event.changes as string[]) : null,
              decisions: Array.isArray(event.decisions) ? (event.decisions as string[]) : null,
              leftovers: Array.isArray(event.leftovers) ? (event.leftovers as string[]) : null,
              labels: storedLabels ?? null,
              tests: (event.tests as ReportRow["tests"]) ?? null,
              question: str(event.question),
              answer: str(event.answer),
              git: (event.git as ReportRow["git"]) ?? null,
            },
            notified: status === "done" && !isSibling,
            // issue #8: the anti-drift rewrite prompt rides the done-bookkeeping wake.
            ...(status === "done" && !isSibling && threads.summaryStatus(worker.threadId).rewriteDue ? { summaryRewriteDue: true } : {}),
            ...(status !== "done" ? { questionId: `q_${workerId}_${seq}` } : {}),
          }),
          { priority: status === "done" ? "normal" : "high" },
        );
        if (relayDone) {
          sql`UPDATE worker_ack SET processedUpTo = ${seq} WHERE workerId = ${workerId}`;
          recomputeThreadState(worker.threadId);
          return "relay_done";
        }
        break;
      }
      case "settled": {
        const outcome = String(event.outcome ?? "");
        const errorClass = event.errorClass ? String(event.errorClass) : null;
        if (outcome === "reported" || outcome === "aborted") {
          sql`
            UPDATE sh_worker SET state = 'idle', lastOutcome = ${worker.lastOutcome ?? `settled:${outcome}`}, lastEventAt = ${ts}, updatedAt = ${now()}
            WHERE workerId = ${workerId}
          `;
          timeline.add(worker.threadId, "settled", outcome === "aborted" ? "运行被中断" : "运行结束", { workerId, seq });
        } else if (outcome === "error" && errorClass === "transient") {
          // The connector auto-resumes (connector-pi §9.2): the run is still in flight from
          // the Thread's point of view — state stays, nothing is sent.
          timeline.add(worker.threadId, "settled", "瞬时错误，连接器将自动重试", { workerId, seq, errorClass });
        } else {
          const text = settledQuestionText(outcome, errorClass, event);
          const qid = `q_${workerId}_${seq}`;
          const unreported = outcome === 'unreported';
          questions.insert({ qid, threadId: worker.threadId, workerId, text, kind: unreported ? 'unreported' : 'failure' });
          sql`
            UPDATE sh_worker SET state = ${unreported || errorClass === 'context' ? 'idle' : 'broken'},
              lastOutcome = ${unreported ? 'unreported' : `error:${errorClass ?? outcome}`}, lastEventAt = ${ts}, updatedAt = ${now()}
            WHERE workerId = ${workerId}
          `;
          sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
          timeline.add(worker.threadId, "question", text, { workerId, seq, errorClass });
          if (!unreported) notifications.queue(`settled:${workerId}:${seq}`, "failure_push", worker.threadId, workerId, qid);
          // §5.3: failure-class settles wake the steward (it may classify, note, or add
          // context on top of the deterministic push the user already received).
          wakes.queue(
            "event",
            `settled:${workerId}:${seq}`,
            eventWakeText({
              thread: threads.get(worker.threadId),
              worker: workers.get(workerId)!,
              machine: machines.get(worker.deviceId),
              report: null,
              settled: { outcome, errorClass, text },
              notified: !unreported,
              questionId: qid,
            }),
            { priority: "high" },
          );
        }
        if (event.usage) {
          sql`UPDATE sh_worker SET lastProgress = ${JSON.stringify({ usage: event.usage })} WHERE workerId = ${workerId}`;
          // issue #8: context usage in percent — the resume-vs-new-session input
          // (connector-pi.md §11.2). percent wins; tokens/contextWindow stands in when
          // the connector did not compute one.
          const cu = (event.usage as { contextUsage?: { percent?: unknown; tokens?: unknown; contextWindow?: unknown } }).contextUsage;
          const percent =
            typeof cu?.percent === "number" && cu.percent >= 0
              ? cu.percent
              : typeof cu?.tokens === "number" && typeof cu.contextWindow === "number" && cu.contextWindow > 0
                ? (cu.tokens / cu.contextWindow) * 100
                : null;
          if (percent !== null) {
            sql`UPDATE sh_worker SET contextPercent = ${Math.round(percent)} WHERE workerId = ${workerId}`;
          }
        }
        break;
      }
      case "broken": {
        // The connector currently surfaces a broken worker through settled error events
        // (breakWorker emits error-class settles) and the hello/reap reconcile paths — this
        // explicit protocol event is the defensive shape for a future producer. Review note
        // (a): kept deliberately; the rules table's `broken` row is wired either way.
        sql`UPDATE sh_worker SET state = 'broken', lastOutcome = 'broken', lastEventAt = ${ts}, updatedAt = ${now()} WHERE workerId = ${workerId}`;
        recordBrokenQuestion(worker, `q_${workerId}_${seq}`, str(event.reason) ?? '自动恢复未成功，需要你决定下一步。');
        break;
      }
      case "lost":
      case "resumed": {
        // lost: not failed — the steward waits (spec §9). resumed: back to running (and a
        // resumed worker is by definition no longer reaped).
        sql`
          UPDATE sh_worker SET state = ${type === "lost" ? "lost" : "running"},
                              lastOutcome = CASE WHEN lastOutcome = 'reaped' THEN NULL ELSE lastOutcome END,
                              lastEventAt = ${ts}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        timeline.add(worker.threadId, type, lostResumedText(type, event), { workerId, seq });
        break;
      }
      case "queue_returned": {
        // §6.2: texts `clear_queue` handed back at interrupt time — they never reached the
        // worker. Recorded on the timeline, and the steward is woken to decide their fate
        // (resend with authorization, tell the user, or drop).
        const texts = (Array.isArray(event.texts) ? event.texts : []).map((t) => String(t).slice(0, 200));
        timeline.add(worker.threadId, "note", `中断时取回 ${texts.length} 条未送达消息：${texts.join("；") || "（空）"}`, {
          workerId,
          seq,
          texts,
        });
        if (texts.length > 0) {
          wakes.queue(
            "event",
            `queue_returned:${workerId}:${seq}`,
            queueReturnedWakeText({
              thread: threads.get(worker.threadId),
              worker: workers.get(workerId)!,
              machine: machines.get(worker.deviceId),
              texts,
            }),
          );
        }
        break;
      }
      case "external_activity": {
        // §10: the connector compared the session tail against lastKnownEntryId before a
        // relaunch and found entries it did not write — the owner used the session at the
        // keyboard. Deterministic timeline note (counts, window, coarse summary); the steward
        // is woken at low priority to fold the summary into the Thread (steward.md §5.3),
        // merging over the §5.4 10-minute window.
        const count = Number(event.entries ?? 0);
        const changedFiles = (Array.isArray(event.changedFiles) ? event.changedFiles : []).map((f) => String(f));
        const summary = str(event.summary) ?? "";
        const window = [str(event.firstAt), str(event.lastAt)].filter((v) => v !== null).join(" ~ ");
        timeline.add(
          worker.threadId,
          "note",
          `会话在机器上被直接使用过：新增 ${count} 条记录${window ? `（${window}）` : ""}${changedFiles.length ? `，改动文件：${changedFiles.join("、")}` : ""}${summary ? `。${summary}` : ""}`,
          { workerId, seq, entries: count, firstAt: event.firstAt ?? null, lastAt: event.lastAt ?? null, changedFiles },
        );
        wakes.queue(
          "event",
          `external_activity:${workerId}:${seq}`,
          externalActivityWakeText({
            thread: threads.get(worker.threadId),
            worker: workers.get(workerId)!,
            machine: machines.get(worker.deviceId),
            count,
            window: window || null,
            changedFiles,
            summary,
          }),
          { priority: "low", mergeMs: EXTERNAL_ACTIVITY_MERGE_MS },
        );
        break;
      }
      case "pr_created": {
        // The consent gate's async answer (issue #21 AC2): the connector pushed the branch
        // and gh opened the PR. Deterministic card, no wake — there is nothing for the model
        // to decide; the URL is recorded on the consent row so a repeated [同意] answers
        // honestly instead of opening a second PR.
        const url = str(event.url) ?? "";
        const branch = str(event.branch);
        const consentRow = (str(event.cmdId) ? prConsent.byCmd(str(event.cmdId)!) : null) ?? prConsent.latestForWorker(workerId);
        // Review finding 4: the cmd_result(ok) backstop may have settled this URL already
        // (the event was lost once and replayed, or the two simply raced) — one card per PR.
        if (consentRow && url !== "" && consentRow.url === url) break;
        if (consentRow) prConsent.settleUrl(consentRow.workerId, consentRow.seq, url);
        timeline.add(
          worker.threadId,
          "note",
          `PR 已创建${url ? `：${url}` : ""}${branch ? `（分支 ${branch}）` : ""}`,
          { workerId, seq, url },
        );
        sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        notifications.queue(
          `pr_created:${workerId}:${seq}`,
          "pr_created",
          worker.threadId,
          workerId,
          null,
          JSON.stringify({ url, branch: branch ?? "" }),
        );
        break;
      }
      case "pr_failed": {
        // The failure half (issue #21 AC4): the classified stage rides the payload so the
        // card can tell the owner what to fix on the machine. prConsent.fail owns the
        // timeline/unread/notify — it is shared with the failed-command path and dedupes
        // between the two.
        prConsent.fail({
          workerId,
          cmdId: str(event.cmdId) || null,
          stage: str(event.stage) ?? "unknown",
          message: str(event.message) ?? "",
        });
        break;
      }
      case "proposal": {
        if (resurrectable) {
          sql`UPDATE sh_worker SET state = 'running', lastOutcome = NULL, updatedAt = ${now()} WHERE workerId = ${workerId}`;
          timeline.add(worker.threadId, "resumed", "重新收到事件，恢复运行（回收后自动纠正）", { workerId, seq, resurrected: true });
        }
        sql`UPDATE sh_worker SET lastEventAt = ${ts}, updatedAt = ${now()} WHERE workerId = ${workerId}`;
        const parsedProposal = ProposalEventSchema.safeParse(event);
        if (!parsedProposal.success) {
          sql`
            INSERT INTO sh_channel_log (ts, channel, reason, detail)
            VALUES (${now()}, 'local', 'invalid_proposal_event', ${`${workerId}:${seq}`})
          `;
          break;
        }
        const p = parsedProposal.data;
        const dedupeKey = `${workerId}:${p.proposalKey}`;
        if (proposals.byDedupeKey(dedupeKey) !== null) {
          // Replay or duplicate proposalKey from the same worker: idempotent no-op.
          break;
        }
        const safePrompt = escapeMarkers(p.prompt);
        const safeReason = escapeMarkers(p.reason);
        const safeTarget = escapeMarkers(p.targetRepoRef);
        const tsNow = now();
        const existingWorkerProposalCount =
          sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_proposal WHERE workerId = ${workerId}`[0]!.n;
        const recordRejected = (
          rejectCode: ProposalRejectCode,
          noteText: string,
          targetDeviceId: string | null = null,
          targetRepoId: string | null = null,
        ): void => {
          if (existingWorkerProposalCount >= 20) {
            sql`
              INSERT INTO sh_channel_log (ts, channel, reason, detail)
              VALUES (${tsNow}, 'local', 'proposal_spam_dropped', ${`${workerId}:${seq} code=${rejectCode}`})
            `;
            return;
          }
          const proposalId = `prop_${ulid()}`;
          sql`
            INSERT INTO sh_proposal (
              id, workerId, seq, threadId, kind, proposalKey, dedupeKey, targetRepoRef,
              targetRepoId, targetDeviceId, selectedAgent, prompt, reason, status, rejectCode,
              spawnedWorkerId, cmdId, createdAt, expiresAt, decidedBy, decidedAt
            )
            VALUES (
              ${proposalId}, ${workerId}, ${seq}, ${worker.threadId}, ${p.kind}, ${p.proposalKey}, ${dedupeKey}, ${safeTarget},
              ${targetRepoId}, ${targetDeviceId}, NULL, ${safePrompt}, ${safeReason}, 'rejected', ${rejectCode},
              NULL, NULL, ${tsNow}, NULL, 'steward_core', ${tsNow}
            )
          `;
          timeline.add(worker.threadId, "note", noteText, {
            workerId,
            seq,
            proposalId,
            proposalKey: p.proposalKey,
            rejectCode,
          });
        };

        if ((worker.proposalDepth ?? 0) >= MAX_PROPOSAL_DEPTH || worker.workerRelation === "sibling") {
          recordRejected("depth_exceeded", `拒绝只读探针提案（depth_exceeded）：子探针不可级联发起提案（${safeTarget}）`);
          break;
        }
        const activeThreadSiblings = sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM sh_worker
          WHERE threadId = ${worker.threadId} AND workerRelation = 'sibling'
            AND state IN ('queued', 'starting', 'running', 'recovering')
        `[0]!.n;
        const pendingThreadProposals = sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM sh_proposal
          WHERE threadId = ${worker.threadId} AND status = 'pending_owner' AND expiresAt > ${tsNow}
        `[0]!.n;
        if (
          existingWorkerProposalCount >= MAX_PROPOSALS_PER_WORKER ||
          activeThreadSiblings + pendingThreadProposals >= MAX_IN_FLIGHT_SIBLINGS_PER_THREAD
        ) {
          recordRejected("quota_exceeded", `拒绝只读探针提案（quota_exceeded）：超出配额上限（${safeTarget}）`);
          break;
        }
        const matches = repos.machinesHaving(p.targetRepoRef);
        if (matches.length === 0) {
          recordRejected("repo_not_found", `拒绝只读探针提案（repo_not_found）：未找到已登记仓库「${safeTarget}」`);
          break;
        }
        const sameMachineRepo = matches.find((m) => m.deviceId === worker.deviceId);
        if (!sameMachineRepo) {
          // ADR-0022 Stage 4 (v2): cross-machine `readonly_probe` NEVER auto-approves; verify an
          // online remote machine with a `readonly: true` agent exists, then enter `pending_owner`
          // and deliver a bound owner confirmation card to Needs you.
          const remoteMatches = matches.filter((m) => m.deviceId !== worker.deviceId);
          const onlineCandidates = remoteMatches
            .map((rm) => ({ repo: rm, machine: machines.get(rm.deviceId) }))
            .filter((c): c is { repo: (typeof remoteMatches)[number]; machine: MachineRow } =>
              c.machine !== null && c.machine.online,
            );
          if (onlineCandidates.length === 0) {
            recordRejected(
              "machine_offline",
              `拒绝跨机只读探针提案（machine_offline）：目标仓库「${safeTarget}」所在远端机器不在线`,
              remoteMatches[0]!.deviceId,
              remoteMatches[0]!.repoId,
            );
            break;
          }
          const readonlyCandidates = onlineCandidates
            .map((c) => ({
              ...c,
              agent: selectReadonlyAgent(c.machine, worker.agent),
              freeSlots: Math.max(0, c.machine.maxWorkers - machines.runningCount(c.machine.deviceId)),
            }))
            .filter((c): c is typeof c & { agent: string } => c.agent !== null);
          if (readonlyCandidates.length === 0) {
            recordRejected(
              "no_readonly_agent",
              `拒绝跨机只读探针提案（no_readonly_agent）：远端在线机器上没有支持严格只读模式的代理（${safeTarget}）`,
              onlineCandidates[0]!.repo.deviceId,
              onlineCandidates[0]!.repo.repoId,
            );
            break;
          }
          const thread = threads.get(worker.threadId);
          if (!thread || thread.archived) {
            recordRejected(
              "thread_archived",
              `拒绝跨机只读探针提案（thread_archived）：所属 Thread 已归档`,
              readonlyCandidates[0]!.repo.deviceId,
              readonlyCandidates[0]!.repo.repoId,
            );
            break;
          }
          const pendingGlobalOwner = sql<{ n: number }>`
            SELECT COUNT(*) AS n FROM sh_proposal WHERE status = 'pending_owner' AND expiresAt > ${tsNow}
          `[0]!.n;
          if (pendingGlobalOwner >= MAX_PENDING_OWNER_PROPOSALS) {
            recordRejected(
              "quota_exceeded",
              `拒绝跨机只读探针提案（quota_exceeded）：待确认跨机探针已达全局上限（${safeTarget}）`,
              readonlyCandidates[0]!.repo.deviceId,
              readonlyCandidates[0]!.repo.repoId,
            );
            break;
          }
          readonlyCandidates.sort(
            (a, b) =>
              b.freeSlots - a.freeSlots ||
              a.repo.deviceId.localeCompare(b.repo.deviceId) ||
              a.repo.repoId.localeCompare(b.repo.repoId),
          );
          const chosen = readonlyCandidates[0]!;
          const proposalId = `prop_${ulid()}`;
          const expiresAt = tsNow + PROPOSAL_CONFIRM_TTL_MS;
          sql`
            INSERT INTO sh_proposal (
              id, workerId, seq, threadId, kind, proposalKey, dedupeKey, targetRepoRef,
              targetRepoId, targetDeviceId, selectedAgent, prompt, reason, status, rejectCode,
              spawnedWorkerId, cmdId, createdAt, expiresAt, decidedBy, decidedAt
            )
            VALUES (
              ${proposalId}, ${workerId}, ${seq}, ${worker.threadId}, ${p.kind}, ${p.proposalKey}, ${dedupeKey}, ${safeTarget},
              ${chosen.repo.repoId}, ${chosen.repo.deviceId}, ${chosen.agent}, ${safePrompt}, ${safeReason}, 'pending_owner', NULL,
              NULL, NULL, ${tsNow}, ${expiresAt}, NULL, NULL
            )
          `;
          questions.insert({
            qid: proposalId,
            threadId: null,
            workerId: null,
            text: `确认在 ${chosen.machine.name} 启动只读探针查看 ${escapeMarkers(chosen.repo.repoName)}？原因：${safeReason}`,
            options: ["批准只读探针", "暂不探测"],
          });
          notifications.queue(`proposal:${proposalId}`, "proposal_confirm", worker.threadId, workerId, proposalId);
          sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
          timeline.add(
            worker.threadId,
            "question",
            `等待确认跨机只读探针（${chosen.agent}@${chosen.machine.name}，仓库 ${escapeMarkers(chosen.repo.repoName)}）：${safeReason}`,
            {
              workerId,
              seq,
              proposalId,
              proposalKey: p.proposalKey,
              targetDeviceId: chosen.repo.deviceId,
              targetRepoId: chosen.repo.repoId,
            },
          );
          break;
        }
        const activeGlobalAutoSiblings = sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM sh_worker w
          JOIN sh_proposal pr ON pr.spawnedWorkerId = w.workerId
          WHERE w.workerRelation = 'sibling'
            AND w.state IN ('queued', 'starting', 'running', 'recovering')
            AND pr.decidedBy = 'auto_same_machine'
        `[0]!.n;
        if (activeGlobalAutoSiblings >= MAX_GLOBAL_AUTO_SIBLINGS) {
          recordRejected("quota_exceeded", `拒绝只读探针提案（quota_exceeded）：超出配额上限（${safeTarget}）`);
          break;
        }
        const machine = machines.get(worker.deviceId);
        if (!machine || !machine.online) {
          recordRejected(
            "machine_offline",
            `拒绝只读探针提案（machine_offline）：同机不在线，无法启动只读探针（${safeTarget}）`,
            worker.deviceId,
            sameMachineRepo.repoId,
          );
          break;
        }
        const selectedAgent = selectReadonlyAgent(machine, worker.agent);
        if (!selectedAgent) {
          recordRejected(
            "no_readonly_agent",
            `拒绝只读探针提案（no_readonly_agent）：机器 ${machine.name} 上没有支持严格只读模式的代理`,
            worker.deviceId,
            sameMachineRepo.repoId,
          );
          break;
        }

        const proposalId = `prop_${ulid()}`;
        const spawnedWorkerId = `w_${ulid()}`;
        const cmdId = `proposal:${proposalId}`;
        workers.register({
          workerId: spawnedWorkerId,
          threadId: worker.threadId,
          deviceId: worker.deviceId,
          repoId: sameMachineRepo.repoId,
          agent: selectedAgent,
          mode: "readonly",
          cmdId,
          parentWorker: worker.workerId,
          workerRelation: "sibling",
          proposalDepth: (worker.proposalDepth ?? 0) + 1,
        });
        sql`
          INSERT INTO sh_proposal (
            id, workerId, seq, threadId, kind, proposalKey, dedupeKey, targetRepoRef,
            targetRepoId, targetDeviceId, selectedAgent, prompt, reason, status, rejectCode,
            spawnedWorkerId, cmdId, createdAt, expiresAt, decidedBy, decidedAt
          )
          VALUES (
            ${proposalId}, ${workerId}, ${seq}, ${worker.threadId}, ${p.kind}, ${p.proposalKey}, ${dedupeKey}, ${safeTarget},
            ${sameMachineRepo.repoId}, ${worker.deviceId}, ${selectedAgent}, ${safePrompt}, ${safeReason}, 'auto_approved', NULL,
            ${spawnedWorkerId}, ${cmdId}, ${tsNow}, NULL, 'auto_same_machine', ${tsNow}
          )
        `;
        timeline.add(
          worker.threadId,
          "dispatch",
          `自动批准同机只读探针 ${spawnedWorkerId}（${selectedAgent}@${machine.name}，仓库 ${escapeMarkers(sameMachineRepo.repoName)}）：${safeReason}`,
          {
            workerId: spawnedWorkerId,
            parentWorker: worker.workerId,
            proposalId,
            proposalKey: p.proposalKey,
            cmdId,
            repoId: sameMachineRepo.repoId,
            workerRelation: "sibling",
          },
        );
        break;
      }
      default:
        // process_exit and future event types carry no ledger semantics yet.
        break;
    }

    sql`UPDATE worker_ack SET processedUpTo = ${seq} WHERE workerId = ${workerId}`;
    recomputeThreadState(worker.threadId);
  }

  /** The terminal broken paths (event, rejected start, and snapshot reconciliation) agree. */
  function recordBrokenQuestion(worker: WorkerRow, qid: string, text: string): void {
    // A cmd_result and its failure event can describe the same terminal transition.
    if (questions.openForWorker(worker.workerId).some(q => q.kind === 'failure')) return;
    questions.insert({ qid, threadId: worker.threadId, workerId: worker.workerId, text, kind: 'failure' });
    timeline.add(worker.threadId, 'question', text, { qid, workerId: worker.workerId });
    sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
    notifications.queue(`question:${qid}`, 'failure_push', worker.threadId, worker.workerId, qid);
    wakes.queue('event', `question:${qid}`, eventWakeText({
      thread: threads.get(worker.threadId), worker, machine: machines.get(worker.deviceId),
      report: null, settled: { outcome: 'broken', errorClass: null, text }, notified: true, questionId: qid,
    }), { priority: 'high' });
  }

  /**
   * Thread derived state (steward.md §5.2): a pure function recomputed after every change,
   * never set by the LLM or the user. `unread` is set where the news lands, cleared on read.
   */
  function recomputeThreadState(threadId: string): void {
    const tsNow = now();
    sql`
      UPDATE sh_thread SET state = CASE
        WHEN EXISTS (
          SELECT 1 FROM sh_worker w WHERE w.threadId = sh_thread.threadId AND w.state IN ('queued', 'starting', 'running', 'recovering')
        ) THEN 'running'
        WHEN EXISTS (
          SELECT 1 FROM sh_question q WHERE q.threadId = sh_thread.threadId AND q.status = 'open'
        ) OR EXISTS (
          SELECT 1 FROM sh_proposal pr WHERE pr.threadId = sh_thread.threadId AND pr.status = 'pending_owner' AND pr.expiresAt > ${tsNow}
        ) THEN 'waiting_you'
        ELSE 'idle'
      END, lastActivityAt = ${tsNow}
      WHERE threadId = ${threadId}
    `;
  }

  // ---- views: the web read model (steward.md §10) ------------------------------------------------

  const withMachineName = (worker: WorkerRow): WorkerRow & { machineName: string } => ({
    ...worker,
    machineName: machines.get(worker.deviceId)?.name ?? worker.deviceId,
  });

  const views = {
    /** Owner-facing data only: internal wake/run text and worker transcripts stay out. */
    workspace(opts?: { includeArchived?: boolean }) {
      return {
        archivedCount: threads.archivedCount(),
        activePrWatches: sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_pr_watch WHERE status = 'active'`[0]!.n,
        threads: threads.list(opts).map((thread) => ({
          ...thread,
          repoIds: threads.repoIds(thread.threadId),
          workers: workers.listByThread(thread.threadId).map((worker) => ({
            ...withMachineName(worker),
            report: reports.latestForWorker(worker.workerId),
            consent: prConsent.latestForWorker(worker.workerId),
          })),
          plans: {
            followups: followups
              .listByThread(thread.threadId)
              .filter((f) => f.status === 'open')
              .sort((a, b) => a.dueAt - b.dueAt)
              .map((f) => ({ id: f.followupId, dueAt: f.dueAt, reason: f.reason })),
            prWatches: sql<{
              id: string;
              url: string;
              nextCheckAt: number;
              head: string | null;
              observedState: string | null;
              failed: number;
              pending: number;
              snapshotJson: string | null;
              diagnosisJson: string | null;
              diagnosisStatus: PrDiagnosisStatus | null;
            }>`
              SELECT w.id, w.url, w.nextCheckAt, w.head, w.observedState, w.failed, w.pending,
                     d.snapshotJson, d.diagnosisJson, d.diagnosisStatus
              FROM sh_pr_watch w
              LEFT JOIN sh_pr_watch_diagnosis d ON d.watchId = w.id AND d.head = w.head
              WHERE w.threadId = ${thread.threadId} AND w.status = 'active'
              ORDER BY w.nextCheckAt, w.id
            `.map((r) => {
              const snap = r.observedState === 'failure' ? jsonOrNull<PrFailureSnapshot>(r.snapshotJson) : null;
              const diag = snap ? jsonOrNull<PrFailureDiagnosis>(r.diagnosisJson) : null;
              return {
                id: r.id,
                url: r.url,
                nextCheckAt: r.nextCheckAt,
                head: r.head,
                observedState: r.observedState,
                failed: r.failed,
                pending: r.pending,
                hasFailureDetail: snap !== null,
                failureHeadline: snap ? (diag?.headline ?? buildDeterministicPrDiagnosis(snap, r.url).headline) : null,
                diagnosisStatus: snap ? (r.diagnosisStatus ?? 'skipped_no_model') : null,
              };
            }),
            routines: sql<Record<string, unknown>>`
              SELECT * FROM sh_routine
              WHERE threadId = ${thread.threadId} AND status = 'active'
              ORDER BY createdAt, routineId
            `.map(viewRoutine).map((r) => ({
              id: r.routineId,
              kind: r.kind,
              scheduleKind: r.scheduleKind,
              cron: r.cron,
              onceAt: r.onceAt,
              instruction: r.instruction,
            })),
          },
          timeline: timeline.recent(thread.threadId, WORKSPACE_TIMELINE),
        })),
        machines: machines.list().map((machine) => ({ ...machine, running: machines.runningCount(machine.deviceId) })),
        repos: repos.list(),
        inputs: sql<{ id: string; text: string; threadId: string | null; at: number; channel: string }>`
          SELECT i.msgId AS id, i.text, COALESCE(r.routedThreadId, i.threadId) AS threadId, i.receivedAt AS at, i.channel
          FROM sh_inbound i LEFT JOIN sh_run r ON r.operationId = 'user:' || i.msgId
          WHERE i.ownerAuthorized = 1 AND i.text IS NOT NULL ORDER BY i.receivedAt DESC, i.msgId DESC LIMIT ${WORKSPACE_MESSAGES}
        `.reverse(),
        outbound: sql<Record<string, unknown>>`
          SELECT * FROM sh_outbound ORDER BY createdAt DESC, id DESC LIMIT ${WORKSPACE_MESSAGES}
        `.reverse(),
        decisionCards: outbound.decisionCards(now() - WORKSPACE_DECISION_WINDOW_MS),
        activity: sql<TimelineRow>`SELECT id, threadId, ts, kind, text FROM sh_timeline ORDER BY id DESC LIMIT 20`.reverse(),
        /** The steward is working on something the owner asked for. */
        busy: runs.openRows().some((run) => run.kind === "user" || run.kind === "verify"),
      };
    },
    /** `views.timeline` — the L2 page: thread, summary events, workers, the open question. */
    timeline(threadId: string): TimelineView | null {
      const thread = threads.get(threadId);
      if (!thread) return null;
      return {
        thread,
        entries: timeline.list(threadId),
        workers: workers.listByThread(threadId).map(withMachineName),
        openQuestion: questions.openForThread(threadId),
      };
    },
    /** The L1 index: threads.list plus each one's latest worker and situation bits. */
    threadList(): ThreadListEntry[] {
      return threads.list().map((thread) => ({
        thread,
        lastWorker: (worker => (worker ? withMachineName(worker) : null))(workers.latestOnThread(thread.threadId)),
        workerCount: workers.listByThread(thread.threadId).length,
      }));
    },
  };

  // ---- whole-ledger debug view for tests (read-only) ---------------------------------------------

  const debug = {
    snapshot(): {
      machines: MachineRow[];
      repos: RepoSummaryRow[];
      threads: Array<ThreadRow & { repoIds: string[]; workers: WorkerRow[]; questions: QuestionRow[]; timeline: TimelineRow[] }>;
      reports: ReportRow[];
      /** Every question row, threadless routing asks included (issue #7). */
      questions: QuestionRow[];
      /** The consent gate's rows (issue #21) — what the user tapped and what came back. */
      prConsent: PrConsentRow[];
      /** ADR-0022 Stage 3: worker read-only proposals and their deterministic verdicts. */
      proposals: ProposalRow[];
      pendingNotifications: NotifyRow[];
      runs: RunRow[];
      wakes: WakeRow[];
      notes: NoteRow[];
      noteLog: Array<{ id: number; ts: number; op: string; noteId: string; text: string; reason: string | null; reportedAt: number | null }>;
      routines: RoutineRow[];
      followups: FollowupRow[];
      offers: RoutineOfferRow[];
      /** The newest timeline entries across ALL threads — routine fires may be Thread-less. */
      timelineRecent: Array<{ id: number; threadId: string | null; ts: number; kind: string; text: string }>;
      /** The open/answered offline asks (issue #14): cmdId → status + machine choices. */
      offlineDispatches: Array<{ cmdId: string; threadId: string; deviceId: string; status: string; choices: string[] }>;
    } {
      return {
        machines: machines.list(),
        repos: repos.list(),
        threads: threads.list().map((t) => ({
          ...t,
          repoIds: threads.repoIds(t.threadId),
          workers: workers.listByThread(t.threadId),
          questions: sql<QuestionRow>`
            SELECT * FROM sh_question WHERE threadId = ${t.threadId} ORDER BY askedAt
          `,
          timeline: timeline.list(t.threadId),
        })),
        reports: sql<Record<string, unknown>>`SELECT * FROM sh_report ORDER BY receivedAt, seq`.map(viewReport),
        questions: sql<QuestionRow>`
          SELECT * FROM sh_question ORDER BY askedAt
        `,
        prConsent: sql<Record<string, unknown>>`SELECT * FROM sh_pr_consent ORDER BY decidedAt`.map(viewPrConsent),
        proposals: proposals.list(),
        pendingNotifications: notifications.pending(),
        runs: runs.rows(),
        wakes: sql<WakeRow>`SELECT * FROM sh_wake ORDER BY id`,
        notes: sql<Record<string, unknown>>`SELECT * FROM sh_note ORDER BY createdAt, noteId`.map((r) => ({
          ...r,
          confirmed: !!r.confirmed,
          pinned: !!r.pinned,
        })) as unknown as NoteRow[],
        noteLog: sql<{ id: number; ts: number; op: string; noteId: string; text: string; reason: string | null; reportedAt: number | null }>`
          SELECT id, ts, op, noteId, text, reason, reportedAt FROM sh_note_log ORDER BY id
        `,
        routines: routines.list(),
        followups: followups.list(),
        offers: sql<Record<string, unknown>>`SELECT * FROM sh_routine_offer ORDER BY createdAt`.map(viewOffer),
        timelineRecent: sql<{ id: number; threadId: string | null; ts: number; kind: string; text: string }>`
          SELECT id, threadId, ts, kind, text FROM sh_timeline ORDER BY id DESC LIMIT 20
        `.reverse(),
        offlineDispatches: sql<{ cmdId: string; threadId: string; deviceId: string; status: string; choices: string | null }>`
          SELECT cmdId, threadId, deviceId, status, choices FROM sh_offline_dispatch ORDER BY cmdId
        `.map((r) => ({ ...r, choices: JSON.parse(r.choices ?? "[]") })),
      };
    },
  };

  return {
    machines, machineStatus, offlineDispatches, repos, threads, workers, reports, questions, timeline, notifications, outbound,
    runs, ownerInputs, webRequests, wakes, notes, budget, routines, followups, offers, skillOffers, handoff, proposals, views, applyPendingEvents, recomputeThreadState, debug,
    prConsent,
  };
}

export type Ledger = ReturnType<typeof createLedger>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Timeline text for `lost` / `resumed` events; `resumed` carries its reason when given. */
function lostResumedText(type: string, event: Record<string, unknown>): string {
  const reason = str(event.reason);
  if (type === "lost") return `失去联系（${reason ?? "未知原因"}）`;
  return reason ? `已恢复继续运行（${reason}）` : "已恢复继续运行";
}

/** The deterministic question text for failure-class settled events (steward.md §5.3). */
function settledQuestionText(outcome: string, errorClass: string | null, event: Record<string, unknown>): string {
  const lastText = typeof event.lastText === "string" && event.lastText.length > 0 ? event.lastText : "";
  // The agent's own sentence outranks the connector's fallback text: for an `error` settle the
  // class (`unknown`) says nothing, and this is the only place the user can see the real cause
  // (2026-11-10: a quota failure reached them as `error:unknown`).
  const errorMessage =
    typeof event.errorMessage === "string" && event.errorMessage.length > 0 ? event.errorMessage : "";
  const detail = errorMessage || lastText ? `（${(errorMessage || lastText).slice(0, 160)}）` : "";
  if (outcome === "unreported") {
    return `worker 结束时没有产出汇报。${lastText ? `最后说：${lastText.slice(0, 300)}` : ""}`;
  }
  switch (errorClass) {
    case "auth":
      // §9.2: auth never auto-resumes — the detail says what the connector saw (e.g. a
      // failed resume), the base says what the user must do. Quota failures classify as auth
      // too (the fix is the same: repair credentials/quota on that machine, or pick a model
      // that has budget), so the sentence names both causes.
      return `机器上的模型凭据或额度不可用（401/403 或额度用尽），需要你在那台机器上修复后重新派发。${detail}`;
    case "context":
      return "上下文超长，这个会话装不下了；建议开一个新会话，带上交接简报继续。";
    case "stall":
      // The connector's watchdog already gave the run one automatic restart (issue #13);
      // a stall reaching the user means even that did not bring it back.
      return `worker 长时间无输出且 CPU 近零，自动重启一次后仍然挂死，需要你决定下一步。${detail}`;
    default:
      // error:unknown — includes the connector's terminal §9.2 outcomes (resume failed /
      // budget exhausted / startup interrupted), whose reason rides in lastText.
      return `运行出错（${errorClass ?? "未知"}），需要你决定下一步。${detail}`;
  }
}
