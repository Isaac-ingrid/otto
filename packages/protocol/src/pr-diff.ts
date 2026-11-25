// Stage 4 Zero-Checkout PR Diff protocol schemas (`git_pr_diff` -> `git_pr_diff_result`).
// Inspects PR commit objects directly via bare `git` plumbing (`fetch` to ephemeral ref / commit
// SHA, `rev-list --parents -n 1`, `diff-tree` / `diff`) without checking out the PR branch or
// executing repository git hooks, and explicitly refuses octopus merges (`parentCount > 2`).
import { z } from "zod";

export const GIT_PR_DIFF_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_PR_DIFF_MAX_BYTES = 80_000;

export const GitPrDiffArgsSchema = z.strictObject({
  repoId: z.string().min(1).max(4096),
  prNumber: z.number().int().positive().optional(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .optional(),
  baseRef: z.string().min(1).max(256).optional(),
  maxBytes: z.number().int().min(1024).max(200_000).optional(),
});

export type GitPrDiffArgs = z.infer<typeof GitPrDiffArgsSchema>;

export const GitPrDiffMessageSchema = z.strictObject({
  t: z.literal("git_pr_diff"),
  id: z.string().min(1).max(128),
  repoId: z.string().min(1).max(4096),
  prNumber: z.number().int().positive().optional(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .optional(),
  baseRef: z.string().min(1).max(256).optional(),
  maxBytes: z.number().int().min(1024).max(200_000).optional(),
});

export type GitPrDiffMessage = z.infer<typeof GitPrDiffMessageSchema>;

export const GitPrDiffPayloadSchema = z.strictObject({
  headSha: z.string().min(7).max(64),
  baseSha: z.string().min(7).max(64),
  parentCount: z.number().int().min(1).max(2),
  filesChanged: z.number().int().nonnegative(),
  changedFiles: z.array(z.string().max(512)).max(200),
  patch: z.string(),
  truncated: z.boolean(),
});

export type GitPrDiffPayload = z.infer<typeof GitPrDiffPayloadSchema>;

export const GitPrDiffErrorCodeSchema = z.enum([
  "not_registered_repo",
  "not_git_repo",
  "octopus_merge_refused",
  "commit_not_found",
  "fetch_failed",
  "unsupported",
  "machine_offline",
  "busy",
  "diff_timeout",
  "diff_failed",
]);

export type GitPrDiffErrorCode = z.infer<typeof GitPrDiffErrorCodeSchema>;

export const GitPrDiffResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    diff: GitPrDiffPayloadSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    code: GitPrDiffErrorCodeSchema,
    message: z.string().max(400).optional(),
  }),
]);

export type GitPrDiffResult = z.infer<typeof GitPrDiffResultSchema>;

export const GitPrDiffResultMessageSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    t: z.literal("git_pr_diff_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(true),
    diff: GitPrDiffPayloadSchema,
  }),
  z.strictObject({
    t: z.literal("git_pr_diff_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(false),
    code: GitPrDiffErrorCodeSchema,
    message: z.string().max(400).optional(),
  }),
]);

export type GitPrDiffResultMessage = z.infer<typeof GitPrDiffResultMessageSchema>;
