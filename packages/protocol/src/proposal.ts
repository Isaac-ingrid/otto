// Read-only worker proposals (ADR-0022 Decisions 5-8; Plan §6 Stage 3).
//
// Workers may submit bounded `readonly_probe` proposals over the existing `events` stream.
// Write proposals are excluded by design; Steward adjudicates proposals deterministically in
// `ledger.ts#applyEvent` and dispatches approved probes via standard `start_worker` (`readonly`).
import { z } from "zod";

export const PROPOSAL_KINDS = ["readonly_probe"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
export const MAX_PROPOSAL_TARGET_CHARS = 256;
export const MAX_PROPOSAL_PROMPT_CHARS = 4_000;
export const MAX_PROPOSAL_REASON_CHARS = 500;

export const MAX_PROPOSALS_PER_WORKER = 2;
export const MAX_IN_FLIGHT_SIBLINGS_PER_THREAD = 2;
export const MAX_GLOBAL_AUTO_SIBLINGS = 3;
export const MAX_PROPOSAL_DEPTH = 1;
export const PROPOSAL_CONFIRM_TTL_MS = 10 * 60_000;
export const MAX_PENDING_OWNER_PROPOSALS = 20;

export const PROPOSAL_TOOL_ACK = "queued_for_steward_decision" as const;

export const ProposalPayloadSchema = z.strictObject({
  kind: z.literal("readonly_probe"),
  targetRepoRef: z.string().trim().min(1).max(MAX_PROPOSAL_TARGET_CHARS),
  prompt: z.string().trim().min(1).max(MAX_PROPOSAL_PROMPT_CHARS),
  reason: z.string().trim().min(1).max(MAX_PROPOSAL_REASON_CHARS),
  proposalKey: z.string().trim().regex(PROPOSAL_KEY_RE),
});

export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

export const ProposalEventSchema = z.strictObject({
  workerId: z.string().min(1),
  seq: z.number().int().min(1),
  ts: z.number().int(),
  type: z.literal("proposal"),
  kind: z.literal("readonly_probe"),
  targetRepoRef: z.string().trim().min(1).max(MAX_PROPOSAL_TARGET_CHARS),
  prompt: z.string().trim().min(1).max(MAX_PROPOSAL_PROMPT_CHARS),
  reason: z.string().trim().min(1).max(MAX_PROPOSAL_REASON_CHARS),
  proposalKey: z.string().trim().regex(PROPOSAL_KEY_RE),
});

export type ProposalEvent = z.infer<typeof ProposalEventSchema>;

export type ProposalStatus =
  | "auto_approved"
  | "pending_owner"
  | "approved"
  | "declined"
  | "rejected"
  | "expired"
  | "dispatched";

export const PROPOSAL_REJECT_CODES = [
  "depth_exceeded",
  "quota_exceeded",
  "repo_not_found",
  "cross_machine_unsupported",
  "machine_offline",
  "no_readonly_agent",
  "thread_archived",
] as const;

export type ProposalRejectCode = (typeof PROPOSAL_REJECT_CODES)[number];

/** Strictly validates a raw `propose` tool argument object; returns null when invalid. */
export function parseProposalPayload(raw: unknown): ProposalPayload | null {
  const parsed = ProposalPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
