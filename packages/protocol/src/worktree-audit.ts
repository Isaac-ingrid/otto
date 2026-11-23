// Machine repository policy & stale worktree audit/cleanup wire schemas (Direction E).
// Audit is strictly read-only; cleanup requires explicit itemized targets inside the
// connector's managed worktrees root and enforces a server-side risk confirmation gate.
import { z } from "zod";

export const WORKTREE_AUDIT_TIMEOUT_MS = 20_000;
export const WORKTREE_CLEANUP_TIMEOUT_MS = 30_000;
export const WORKTREE_AUDIT_MAX_ITEMS = 250;
export const WORKTREE_CLEANUP_MAX_TARGETS = 32;

export const WORKTREE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,80}-[0-9a-f]{8}\/[a-z0-9][a-z0-9._-]{0,96}$/i;

export function isValidManagedWorktreeKey(key: string): boolean {
  return WORKTREE_KEY_RE.test(key) && !key.includes("..");
}

export const RepoWritePolicySchema = z.object({
  isolation: z.enum(["worktree", "in-place"]),
  concurrency: z.enum(["parallel", "serial"]),
});
export type RepoWritePolicy = z.infer<typeof RepoWritePolicySchema>;

export const RawAuditedRepoSchema = z.object({
  repoId: z.string().min(1).max(1024),
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(2048),
  capabilityKind: z.enum(["git", "plain"]),
  defaultBranch: z.string().max(256).nullable(),
  writeIsolation: z.enum(["worktree", "in-place"]),
  writeConcurrency: z.enum(["parallel", "serial"]),
  hasSetupHook: z.boolean(),
  hasArchiveHook: z.boolean(),
  hooksApproved: z.boolean(),
  projectApproved: z.boolean(),
  prunableCount: z.number().int().nonnegative(),
});
export type RawAuditedRepo = z.infer<typeof RawAuditedRepoSchema>;

export const RawAuditedWorktreeSchema = z.object({
  repoId: z.string().min(1).max(1024),
  worktreeKey: z.string().min(1).max(256),
  path: z.string().min(1).max(2048),
  managedByOtto: z.boolean(),
  existsOnDisk: z.boolean(),
  prunable: z.boolean(),
  locked: z.boolean(),
  detached: z.boolean(),
  branch: z.string().max(256).nullable(),
  headSha: z.string().max(64).nullable(),
  baseBranch: z.string().max(256).nullable(),
  dirty: z.boolean(),
  modifiedCount: z.number().int().nonnegative(),
  untrackedCount: z.number().int().nonnegative(),
  ahead: z.number().int().nonnegative(),
  pushed: z.boolean(),
  mergedIntoBase: z.boolean(),
  lastCommitAt: z.number().int().nonnegative().nullable(),
  diskBytes: z.number().int().nonnegative(),
  diskComplete: z.boolean(),
  localWorkerId: z.string().max(128).nullable(),
  localThreadId: z.string().max(128).nullable(),
  localMode: z.enum(["write", "readonly"]).nullable(),
  localState: z.string().max(64).nullable(),
  localLiveProcess: z.boolean(),
  localUpdatedAt: z.number().int().nonnegative().nullable(),
});
export type RawAuditedWorktree = z.infer<typeof RawAuditedWorktreeSchema>;

export const WorktreeAuditPayloadSchema = z.object({
  scannedAt: z.number().int().nonnegative(),
  repos: z.array(RawAuditedRepoSchema).max(200),
  worktrees: z.array(RawAuditedWorktreeSchema).max(WORKTREE_AUDIT_MAX_ITEMS),
  truncated: z.boolean().optional(),
});
export type WorktreeAuditPayload = z.infer<typeof WorktreeAuditPayloadSchema>;

export const WorktreeAuditArgsSchema = z.object({
  repoId: z.string().min(1).max(1024).optional(),
});
export type WorktreeAuditArgs = z.infer<typeof WorktreeAuditArgsSchema>;

export const WorktreeAuditErrorSchema = z.enum([
  "unsupported",
  "not_registered_repo",
  "busy",
  "audit_failed",
]);
export type WorktreeAuditError = z.infer<typeof WorktreeAuditErrorSchema>;

export const WorktreeAuditMessageSchema = z.object({
  t: z.literal("worktree_audit"),
  id: z.string().min(1).max(128),
  repoId: z.string().min(1).max(1024).optional(),
});
export type WorktreeAuditMessage = z.infer<typeof WorktreeAuditMessageSchema>;

export const WorktreeAuditResultMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    t: z.literal("worktree_audit_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(true),
    audit: WorktreeAuditPayloadSchema,
  }),
  z.object({
    t: z.literal("worktree_audit_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(false),
    code: WorktreeAuditErrorSchema,
  }),
]);
export type WorktreeAuditResultMessage = z.infer<typeof WorktreeAuditResultMessageSchema>;

export type WorktreeAuditResult =
  | { ok: true; audit: WorktreeAuditPayload }
  | { ok: false; code: WorktreeAuditError };

export const WorktreeCleanupTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("worker"),
    repoId: z.string().min(1).max(1024),
    workerId: z.string().min(1).max(128),
    expectedBranch: z.string().max(256).nullable().optional(),
    force: z.boolean(),
  }),
  z.object({
    kind: z.literal("orphan_dir"),
    repoId: z.string().min(1).max(1024),
    worktreeKey: z.string().min(3).max(200).regex(WORKTREE_KEY_RE),
    expectedBranch: z.string().max(256).nullable().optional(),
    force: z.boolean(),
  }),
]);
export type WorktreeCleanupTarget = z.infer<typeof WorktreeCleanupTargetSchema>;

export const WorktreeCleanupArgsSchema = z.object({
  targets: z.array(WorktreeCleanupTargetSchema).max(WORKTREE_CLEANUP_MAX_TARGETS),
  pruneRepoIds: z.array(z.string().min(1).max(1024)).max(64).optional(),
  confirmedRisks: z.boolean().optional(),
});
export type WorktreeCleanupArgs = z.infer<typeof WorktreeCleanupArgsSchema>;

export const WorktreeCleanupItemStatusSchema = z.enum([
  "cleaned",
  "already_gone",
  "blocked_dirty",
  "blocked_unmerged",
  "blocked_locked",
  "worker_active",
  "forbidden_path",
  "branch_mismatch",
  "not_registered_repo",
  "hook_failed",
  "failed",
]);
export type WorktreeCleanupItemStatus = z.infer<typeof WorktreeCleanupItemStatusSchema>;

export const WorktreeCleanupItemOutcomeSchema = z.object({
  targetKey: z.string().min(1).max(256),
  kind: z.enum(["worker", "orphan_dir"]),
  repoId: z.string().min(1).max(1024),
  workerId: z.string().max(128).nullable(),
  worktreeKey: z.string().max(256).nullable(),
  branch: z.string().max(256).nullable(),
  status: WorktreeCleanupItemStatusSchema,
  message: z.string().max(400).optional(),
  freedBytes: z.number().int().nonnegative().optional(),
});
export type WorktreeCleanupItemOutcome = z.infer<typeof WorktreeCleanupItemOutcomeSchema>;

export const WorktreeCleanupPayloadSchema = z.object({
  items: z.array(WorktreeCleanupItemOutcomeSchema).max(WORKTREE_CLEANUP_MAX_TARGETS),
  prunedRepoIds: z.array(z.string().min(1).max(1024)).max(64),
});
export type WorktreeCleanupPayload = z.infer<typeof WorktreeCleanupPayloadSchema>;

export const WorktreeCleanupErrorSchema = z.enum([
  "unsupported",
  "bad_request",
  "busy",
  "cleanup_failed",
]);
export type WorktreeCleanupError = z.infer<typeof WorktreeCleanupErrorSchema>;

export const WorktreeCleanupMessageSchema = z.object({
  t: z.literal("worktree_cleanup"),
  id: z.string().min(1).max(128),
  op: WorktreeCleanupArgsSchema,
});
export type WorktreeCleanupMessage = z.infer<typeof WorktreeCleanupMessageSchema>;

export const WorktreeCleanupResultMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    t: z.literal("worktree_cleanup_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(true),
    result: WorktreeCleanupPayloadSchema,
  }),
  z.object({
    t: z.literal("worktree_cleanup_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(false),
    code: WorktreeCleanupErrorSchema,
  }),
]);
export type WorktreeCleanupResultMessage = z.infer<typeof WorktreeCleanupResultMessageSchema>;

export type WorktreeCleanupResult =
  | { ok: true; result: WorktreeCleanupPayload }
  | { ok: false; code: WorktreeCleanupError };
