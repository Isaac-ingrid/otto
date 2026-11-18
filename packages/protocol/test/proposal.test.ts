import { describe, expect, it } from "vitest";
import {
  EventsMessageSchema,
  MAX_PENDING_OWNER_PROPOSALS,
  MAX_PROPOSAL_PROMPT_CHARS,
  MAX_PROPOSAL_REASON_CHARS,
  MAX_PROPOSAL_TARGET_CHARS,
  PROPOSAL_CONFIRM_TTL_MS,
  PROPOSAL_REJECT_CODES,
  PROPOSAL_TOOL_ACK,
  ProposalEventSchema,
  ProposalPayloadSchema,
  parseProposalPayload,
} from "../src/index.ts";

describe("readonly proposal protocol schema (ADR-0022 Stages 3–4)", () => {
  const validPayload = {
    kind: "readonly_probe" as const,
    targetRepoRef: "shared-contracts",
    prompt: "Inspect OpenAPI response types for POST /v2/orders.",
    reason: "Verify upstream DTO field names before generating client types.",
    proposalKey: "probe-orders-dto_v1:01",
  };

  it("accepts a valid readonly_probe payload, trims whitespace, and exposes v2 confirmation constants", () => {
    const parsed = ProposalPayloadSchema.parse({
      ...validPayload,
      targetRepoRef: "  shared-contracts  ",
      prompt: "  Inspect DTOs  ",
      reason: "  Verify contract  ",
      proposalKey: "  probe.key-1  ",
    });
    expect(parsed).toEqual({
      kind: "readonly_probe",
      targetRepoRef: "shared-contracts",
      prompt: "Inspect DTOs",
      reason: "Verify contract",
      proposalKey: "probe.key-1",
    });
    expect(PROPOSAL_TOOL_ACK).toBe("queued_for_steward_decision");
    expect(PROPOSAL_CONFIRM_TTL_MS).toBe(10 * 60_000);
    expect(MAX_PENDING_OWNER_PROPOSALS).toBe(20);
    expect(PROPOSAL_REJECT_CODES).toContain("thread_archived");
  });

  it("strictly rejects write kinds, extra fields, and out-of-bounds strings", () => {
    expect(parseProposalPayload({ ...validPayload, kind: "write_task" })).toBeNull();
    expect(parseProposalPayload({ ...validPayload, kind: "archive_thread" })).toBeNull();

    // Extra keys (such as mode, branch, approveProject, setupHook) must fail z.strictObject.
    expect(parseProposalPayload({ ...validPayload, mode: "write" })).toBeNull();
    expect(parseProposalPayload({ ...validPayload, approveProject: true })).toBeNull();

    expect(parseProposalPayload({ ...validPayload, targetRepoRef: "" })).toBeNull();
    expect(parseProposalPayload({ ...validPayload, targetRepoRef: "r".repeat(MAX_PROPOSAL_TARGET_CHARS + 1) })).toBeNull();
    expect(parseProposalPayload({ ...validPayload, prompt: "" })).toBeNull();
    expect(parseProposalPayload({ ...validPayload, prompt: "p".repeat(MAX_PROPOSAL_PROMPT_CHARS + 1) })).toBeNull();
    expect(parseProposalPayload({ ...validPayload, reason: "" })).toBeNull();
    expect(parseProposalPayload({ ...validPayload, reason: "x".repeat(MAX_PROPOSAL_REASON_CHARS + 1) })).toBeNull();

    expect(parseProposalPayload({ ...validPayload, proposalKey: "-bad-start" })).toBeNull();
    expect(parseProposalPayload({ ...validPayload, proposalKey: "bad space" })).toBeNull();
    expect(parseProposalPayload({ ...validPayload, proposalKey: "k".repeat(65) })).toBeNull();
  });

  it("rides the existing events batch envelope and validates strictly at reducer boundary", () => {
    const wireBatch = EventsMessageSchema.parse({
      t: "events",
      id: "evt-batch-1",
      batch: [
        {
          workerId: "w_parent01",
          seq: 3,
          ts: 1_700_000_000_000,
          type: "proposal",
          ...validPayload,
        },
      ],
    });
    const parsedEvent = ProposalEventSchema.safeParse(wireBatch.batch[0]);
    expect(parsedEvent.success).toBe(true);

    const sneaky = ProposalEventSchema.safeParse({
      ...wireBatch.batch[0],
      extraPrivilege: "root",
    });
    expect(sneaky.success).toBe(false);
  });
});
