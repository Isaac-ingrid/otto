## Review

Reviewed supplied `be11d13..4f66827` artifacts and frozen source, read-only. No commands, edits, paid calls or deployment actions.

No issues found.

- **Correct:** Model context exposes proposals, not mutation capabilities (`apps/steward/src/llm/extension.ts:98–104`). Mutation requires an owner-authenticated action matching the actual outbound confirmation card (`apps/steward/src/steward.ts:3662–3671`).
- **Correct:** Immutable commands, expiry, replay protection, target revalidation and transactional watch/proposal/question updates implement ADR-0019 (`apps/steward/src/pr-watch-approval.ts:61–120`). The production adapter avoids nested transactions (`apps/steward/src/steward.ts:3634–3643`).
- **Correct:** Ordinary quoted replies and generic ask buttons cannot authorize these operations (`apps/steward/src/steward.ts:3874–3877, 4676–4679`). Conservative lexical refusals are usability restrictions, not authorization bypasses.
- **Correct:** Evaluator v3 requires independently declared, exact-match owner plans; proposals alone cannot pass (`apps/steward/eval/pr-intent.ts:140–153, 204–214`). Workers receive frozen profile/environment inputs and checked configuration receipts (`apps/steward/eval/run-pr-intent.ts:65–74, 109–113`).
- **Correct:** Focused tests cover rollback, replay, stale targets, wrong-card/generic actions, ordinary replies, browser confirmation and external-profile changes (`apps/steward/test/pr-watch-approval.test.ts:24–162`; `apps/steward/eval/run-pr-intent.test.ts:41–68`).

**Merge verdict: OK with notes.** No source-review blocker to continuing gated validation. Publication remains pending full-suite and required real-model results. Simulated-owner acceptance is not real UI acceptance; I did not independently execute tests.