// On-demand deterministic worker checkpoint relay schemas (Direction 2B / L1 Checkpoint).
// Summarizes an interrupted, paused, or finished worker's local session JSONL and Git status
// within a strict 32 KiB wire cap, without invoking an LLM or bloating DO storage.
import { z } from "zod";

export const WORKER_CHECKPOINT_MAX_BYTES = 32 * 1024;
export const WORKER_CHECKPOINT_TIMEOUT_MS = 8_000;
export const WORKER_CHECKPOINT_MAX_FILES = 60;
export const WORKER_CHECKPOINT_MAX_COMMANDS = 20;
export const WORKER_CHECKPOINT_MAX_NOTES = 3;

export const WorkerCheckpointArgsSchema = z.strictObject({
  workerId: z.string().min(1).max(128),
});
export type WorkerCheckpointArgs = z.infer<typeof WorkerCheckpointArgsSchema>;

export const WorkerCheckpointStepSchema = z.object({
  tool: z.string().min(1).max(128),
  args: z.string().max(240).optional(),
});
export type WorkerCheckpointStep = z.infer<typeof WorkerCheckpointStepSchema>;

export const WorkerCheckpointGitSchema = z.object({
  branch: z.string().max(256),
  base: z.string().max(256),
  head: z.string().max(64).optional(),
  ahead: z.number().int().nonnegative(),
  dirty: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  pushed: z.boolean(),
  changedFiles: z.array(z.string().max(512)).max(100).optional(),
});
export type WorkerCheckpointGit = z.infer<typeof WorkerCheckpointGitSchema>;

export const WorkerCheckpointPayloadSchema = z
  .object({
    workerId: z.string().min(1).max(128),
    agent: z.string().min(1).max(64),
    sessionId: z.string().max(256).nullable(),
    turnCount: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    initialGoal: z.string().max(600).nullable(),
    lastPrompt: z.string().max(600).nullable(),
    recentNotes: z.array(z.string().max(900)).max(WORKER_CHECKPOINT_MAX_NOTES),
    touchedFiles: z.object({
      read: z.array(z.string().max(512)).max(WORKER_CHECKPOINT_MAX_FILES),
      modified: z.array(z.string().max(512)).max(WORKER_CHECKPOINT_MAX_FILES),
    }),
    commandsRun: z.array(z.string().max(180)).max(WORKER_CHECKPOINT_MAX_COMMANDS),
    lastStep: WorkerCheckpointStepSchema.nullable(),
    git: WorkerCheckpointGitSchema.nullable(),
    offlineFallback: z.boolean().optional(),
  })
  .refine((payload) => new TextEncoder().encode(JSON.stringify(payload)).byteLength <= WORKER_CHECKPOINT_MAX_BYTES);
export type WorkerCheckpointPayload = z.infer<typeof WorkerCheckpointPayloadSchema>;

export const WorkerCheckpointErrorSchema = z.enum([
  "unsupported",
  "not_found",
  "no_history",
  "read_failed",
  "busy",
]);
export type WorkerCheckpointError = z.infer<typeof WorkerCheckpointErrorSchema>;

export const WorkerCheckpointMessageSchema = WorkerCheckpointArgsSchema.extend({
  t: z.literal("worker_checkpoint"),
  id: z.string().min(1).max(128),
});
export type WorkerCheckpointMessage = z.infer<typeof WorkerCheckpointMessageSchema>;

export const WorkerCheckpointResultMessageSchema = z.discriminatedUnion("ok", [
  z.object({ t: z.literal("worker_checkpoint_result"), re: z.string().min(1).max(128), ok: z.literal(true), checkpoint: WorkerCheckpointPayloadSchema }),
  z.object({ t: z.literal("worker_checkpoint_result"), re: z.string().min(1).max(128), ok: z.literal(false), code: WorkerCheckpointErrorSchema }),
]);
export type WorkerCheckpointResultMessage = z.infer<typeof WorkerCheckpointResultMessageSchema>;
export type WorkerCheckpointResult =
  | { ok: true; checkpoint: WorkerCheckpointPayload }
  | { ok: false; code: WorkerCheckpointError };
