# Experiment 0002: Read-only Persistent PR / CI Commission

Status: exploring — integrated via Owner API; deployment and independent review pending.
Date: 2026-11-13. One lane. No child agents or paid model calls.

## Direction (outer loop)

- Problem scenario (not yet a measured user cohort): after a PR is created, the owner must return
  to inspect CI. A Thread persists, but a free-text timed follow-up alone does not establish which
  external version passed or when the commission ends.
- Hypothesis: an explicit, bounded read-only commission can wait and resume across restarts without
  spending model tokens or giving itself repair/merge permission.
- Expected benefit: fewer manual checks and repeated context, to be verified in real use later.
- Allowed edits: a narrow evidence reader/service, additive state migration, exact owner-API route,
  scheduler wiring, tests and docs. No prompt/tool/model/recall changes.
- Protected: existing routing labels/thresholds, memory admission/evidence rules, worker dispatch,
  consent-to-push/PR gate. No external write action or untrusted log ingestion.
- Stop: if useful operation requires autonomous code modification, wider credentials, or weakening
  a hard gate, stop and make a separate proposal.

## Candidate lineage (inner loop)

Parent: `20a61d3` (experiment 0001's tooling). Candidate: the PR-watch feature commit containing
this record; resolve its creation ref with `git log --diff-filter=A --format=%h -- apps/steward/src/pr-watch.ts`.
The owner authorized local commits, not deployment or automatic merge.

Selector: first establish a usable vertical slice via the existing optional Owner API, without
changing the steward's model-facing tools. Keep Thread as the parent; use a typed PR condition
record rather than overloading an instruction routine or repeatedly waking an LLM.

Executor: main assistant. No autonomous Director, parallel lane or automatic merge was run.

Iterations retained in this record:

1. Reuse existing outbound storage and SDK cron. Bind observations to head SHA and re-read head.
2. Add generation/lease protection and an atomic notification intent to cover cancellation,
   restart, expiry and accepted-but-unacknowledged delivery.
3. Self-review identified a transport-retention trap: re-inserting a previously delivered failure
   could produce another push after push-job GC. Keep delivered receipts and suppress unchanged
   observations rather than relying solely on the transport's dedupe retention.

## Evaluator

Scenario checks:

- Authorization, valid existing Thread, idempotent owner request, one scheduler cron.
- Fixed GitHub API origin, GET only, no redirects; token never enters model-visible content.
- No checks/skipped/neutral does not imply green; incomplete or unknown results fail closed.
- Check/status SHA and final PR head agree; an updated head invalidates old success.
- Failures stay active; unavailable evidence is not failure; success/closure/merge terminate.
- Cancel/expire during reads reject late results. Restart recovers abandoned leases.
- Observation + notice intent are transactional; durable enqueue retries use stable IDs.
- No LLM turn or worker session is created by the API/poll path.

Validation commands and observations:

```sh
corepack pnpm --filter @isaac2ingrid/steward exec vitest run --config vitest.node.config.ts test/pr-evidence.test.ts test/pr-watch.test.ts test/pr-watch-api.test.ts test/routines.test.ts test/web-workspace.test.ts node-host/testing/public-origin.test.ts
# 70 tests passed on Node host (new evidence/service/API + existing integration regressions).
corepack pnpm --filter @isaac2ingrid/steward exec vitest run test/pr-evidence.test.ts test/pr-watch.test.ts test/pr-watch-api.test.ts test/schema.test.ts test/push.test.ts
# 43 tests passed on workerd (including the 26 new PR-watch checks).
corepack pnpm --filter @isaac2ingrid/steward typecheck
node --test scripts/improvement/improvement.test.mjs
cd apps/steward
node eval/run-eval.ts --selftest
node eval/run-memory-eval.ts
```

Typecheck, 7 improvement-tool tests, routing selftest and all 10 memory cases passed. The full
workspace test suite was not run. No live private GitHub connectivity, production restart, paid
routing score or measured reduction in owner attention is claimed.

## Reviewer

Executor self-review only. Independent reviewer: pending. Owner merge/deploy approval: pending.
Remaining limits: Owner API only (no natural-language tool/UI); status summary only (no log diagnosis);
up to 100 check runs/statuses (larger responses are unavailable); no atomic GitHub snapshot or proof
that all required workflows have started; one-shot success, not perpetual PR monitoring. Polling may
miss transient external states. See [usage and limitations](../../pr-watches.md).

## Attribution and next outer-loop decision

Hypothesis remains unproven in user experience: evidence insufficient, not measured success.
Next: independent review, owner-authorized deployment with least-privilege GitHub access, and a
small real-use sample. Keep experiment 0001's paid noise baseline pending until the owner supplies
an explicit production-matched profile. No automatic acceptance-rule changes.
