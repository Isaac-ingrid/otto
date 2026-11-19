// Connector-collected git metadata and on-demand worker diff relay schemas.
import { z } from "zod";

export interface GitFacts {
  branch: string;
  base: string;
  ahead: number;
  dirty: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  pushed: boolean;
  /** Optional for compatibility with connectors predating relay briefs. */
  head?: string;
  commits?: string[];
  changedFiles?: string[];
  pointersTruncated?: boolean;
}

// Repo capability (issue #88): Git is a detected, optional capability of a registered
// directory, not a registration requirement. A Git-backed repo keeps worktree isolation,
// branch/diff reporting, and PR support; a plain workspace has none of those.
export interface GitCapability {
  readonly kind: "git";
  readonly gitRoot: string;
  readonly defaultBranch: string | null;
  readonly remote: string | null;
}
export interface PlainCapability {
  readonly kind: "plain";
}
export type RepoCapability = GitCapability | PlainCapability;

export const WORKER_DIFF_MAX_FILES = 500;
export const WORKER_DIFF_MAX_COMMITS = 50;
export const WORKER_DIFF_INLINE_PATCH_MAX_BYTES = 128 * 1024;
export const WORKER_DIFF_MESSAGE_MAX_BYTES = 192 * 1024;
export const WORKER_DIFF_TIMEOUT_MS = 10_000;

/** Validates a relative Git path (rejects empty strings, NUL bytes, leading slashes, Windows drives, and `..` segments). */
export function isSafeRelativeGitPath(filePath: string): boolean {
  if (!filePath || filePath.length > 4096 || filePath.includes("\0")) return false;
  if (filePath.startsWith("/") || filePath.startsWith("\\") || /^[A-Za-z]:/.test(filePath)) return false;
  const segments = filePath.split(/[\\/]/);
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

export const WorkerDiffArgsSchema = z.strictObject({
  workerId: z.string().min(1).max(128),
  filePath: z.string().min(1).max(4096).regex(/^[^\0]+$/).optional(),
  contextLines: z.number().int().min(0).max(20).optional(),
});
export type WorkerDiffArgs = z.infer<typeof WorkerDiffArgsSchema>;

export const WorkerDiffFileStatusSchema = z.enum(["A", "M", "D", "R", "U"]);
export type WorkerDiffFileStatus = z.infer<typeof WorkerDiffFileStatusSchema>;

export const WorkerDiffFileSchema = z.object({
  path: z.string().min(1).max(4096),
  oldPath: z.string().min(1).max(4096).optional(),
  status: WorkerDiffFileStatusSchema,
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
});
export type WorkerDiffFile = z.infer<typeof WorkerDiffFileSchema>;

export const WorkerDiffCommitSchema = z.object({
  sha: z.string().min(1).max(64),
  subject: z.string().max(500),
});
export type WorkerDiffCommit = z.infer<typeof WorkerDiffCommitSchema>;

export const WorkerDiffPayloadSchema = z
  .object({
    base: z.string().min(1).max(256),
    branch: z.string().min(1).max(256),
    head: z.string().max(64).optional(),
    dirty: z.number().int().nonnegative(),
    ahead: z.number().int().nonnegative(),
    pushed: z.boolean(),
    commits: z.array(WorkerDiffCommitSchema).max(WORKER_DIFF_MAX_COMMITS),
    files: z.array(WorkerDiffFileSchema).max(WORKER_DIFF_MAX_FILES),
    filesTruncated: z.boolean(),
    patch: z.string(),
    patchTruncated: z.boolean(),
  })
  .refine((payload) => new TextEncoder().encode(JSON.stringify(payload)).byteLength <= WORKER_DIFF_MESSAGE_MAX_BYTES);
export type WorkerDiffPayload = z.infer<typeof WorkerDiffPayloadSchema>;

export const WorkerDiffErrorSchema = z.enum([
  "unsupported",
  "not_found",
  "no_worktree",
  "not_git_repo",
  "invalid_path",
  "diff_failed",
  "busy",
]);
export type WorkerDiffError = z.infer<typeof WorkerDiffErrorSchema>;

export const WorkerDiffMessageSchema = WorkerDiffArgsSchema.extend({
  t: z.literal("worker_diff"),
  id: z.string().min(1).max(128),
});
export type WorkerDiffMessage = z.infer<typeof WorkerDiffMessageSchema>;

export const WorkerDiffResultMessageSchema = z.discriminatedUnion("ok", [
  z.object({ t: z.literal("worker_diff_result"), re: z.string().min(1).max(128), ok: z.literal(true), diff: WorkerDiffPayloadSchema }),
  z.object({ t: z.literal("worker_diff_result"), re: z.string().min(1).max(128), ok: z.literal(false), code: WorkerDiffErrorSchema }),
]);
export type WorkerDiffResultMessage = z.infer<typeof WorkerDiffResultMessageSchema>;
export type WorkerDiffResult =
  | { ok: true; diff: WorkerDiffPayload }
  | { ok: false; code: WorkerDiffError };
