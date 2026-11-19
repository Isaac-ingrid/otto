// Controlled repository skill catalog & single-file Markdown sync schemas (Direction 2B).
// Strictly scoped to three whitelisted Markdown slots inside registered repositories or
// active write worktrees — zero executable scripts, zero global home directory access.
import { z } from "zod";

export const REPO_SKILL_MAX_BYTES = 32 * 1024;
export const REPO_SKILL_LIST_MAX_ITEMS = 100;
export const REPO_SKILL_LIST_MAX_BYTES = 48 * 1024;
export const REPO_SKILL_TIMEOUT_MS = 8_000;

export const SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidSkillSlug(slug: string): boolean {
  return SKILL_SLUG_RE.test(slug);
}

export const RepoSkillTargetSchema = z.enum([
  "agents-skill",
  "claude-skill",
  "claude-command",
]);
export type RepoSkillTarget = z.infer<typeof RepoSkillTargetSchema>;

export const RepoSkillGitStatusSchema = z.enum([
  "clean",
  "modified",
  "untracked",
  "plain",
]);
export type RepoSkillGitStatus = z.infer<typeof RepoSkillGitStatusSchema>;

export const SkillSlugSchema = z.string().min(1).max(64).regex(SKILL_SLUG_RE);
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const RepoSkillScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo"),
    repoId: z.string().min(1).max(1024),
  }),
  z.object({
    kind: z.literal("worktree"),
    repoId: z.string().min(1).max(1024),
    workerId: z.string().min(1).max(128),
  }),
]);
export type RepoSkillScope = z.infer<typeof RepoSkillScopeSchema>;

export const RepoSkillSummarySchema = z.object({
  target: RepoSkillTargetSchema,
  slug: SkillSlugSchema,
  relativePath: z.string().min(1).max(256),
  name: z.string().min(1).max(120),
  description: z.string().max(300),
  bytes: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  sha256: Sha256HexSchema,
  gitStatus: RepoSkillGitStatusSchema,
});
export type RepoSkillSummary = z.infer<typeof RepoSkillSummarySchema>;

export const RepoSkillOpArgsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    scope: RepoSkillScopeSchema,
  }),
  z.object({
    action: z.literal("read"),
    scope: RepoSkillScopeSchema,
    target: RepoSkillTargetSchema,
    slug: SkillSlugSchema,
  }),
  z.object({
    action: z.literal("write"),
    scope: RepoSkillScopeSchema,
    target: RepoSkillTargetSchema,
    slug: SkillSlugSchema,
    markdown: z.string().min(1).max(REPO_SKILL_MAX_BYTES),
    overwrite: z.boolean().optional(),
    expectedSha256: Sha256HexSchema.optional(),
  }),
  z.object({
    action: z.literal("delete"),
    scope: RepoSkillScopeSchema,
    target: RepoSkillTargetSchema,
    slug: SkillSlugSchema,
    expectedSha256: Sha256HexSchema,
  }),
]);
export type RepoSkillOpArgs = z.infer<typeof RepoSkillOpArgsSchema>;

export const RepoSkillDataSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    skills: z.array(RepoSkillSummarySchema).max(REPO_SKILL_LIST_MAX_ITEMS),
    truncated: z.boolean().optional(),
    projectApproved: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("read"),
    summary: RepoSkillSummarySchema,
    markdown: z.string().max(REPO_SKILL_MAX_BYTES),
  }),
  z.object({
    action: z.literal("write"),
    summary: RepoSkillSummarySchema,
    projectApproved: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("delete"),
    deleted: z.literal(true),
    relativePath: z.string().min(1).max(256),
  }),
]);
export type RepoSkillData = z.infer<typeof RepoSkillDataSchema>;

export const RepoSkillErrorSchema = z.enum([
  "unsupported",
  "not_found",
  "not_registered_repo",
  "no_worktree",
  "invalid_slug",
  "symlink_forbidden",
  "too_large",
  "secret_detected",
  "already_exists",
  "sha256_conflict",
  "busy",
  "io_failed",
]);
export type RepoSkillError = z.infer<typeof RepoSkillErrorSchema>;

export const RepoSkillOpMessageSchema = z.object({
  t: z.literal("repo_skill_op"),
  id: z.string().min(1).max(128),
  op: RepoSkillOpArgsSchema,
});
export type RepoSkillOpMessage = z.infer<typeof RepoSkillOpMessageSchema>;

export const RepoSkillResultMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    t: z.literal("repo_skill_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(true),
    data: RepoSkillDataSchema,
  }),
  z.object({
    t: z.literal("repo_skill_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(false),
    code: RepoSkillErrorSchema,
    existingSha256: Sha256HexSchema.optional(),
  }),
]);
export type RepoSkillResultMessage = z.infer<typeof RepoSkillResultMessageSchema>;

export type RepoSkillResult =
  | { ok: true; data: RepoSkillData }
  | { ok: false; code: RepoSkillError; existingSha256?: string };
