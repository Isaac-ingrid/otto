# Experiment 0007: Bound Owner Confirmation and Frozen Evaluation

Date: 2026-11-14. Parent: `1bfe690`; production predecessor: rejected `be11d13`.
Status: `4f66827` passed independent review and both required real-model gates; deployment preparation.
Not yet deployed at this checkpoint.

Owner authorization: fix boundaries/configuration, review and paid validation; deploy only if
appropriate after all gates pass. Owner is currently not using Otto; this does not waive safety.

## Director decision

Repeated lexical patches cannot be the mutation authority. Adopt
[ADR-0019](../../adr/0019-pr-watch-owner-confirmation.md): model tools only propose, an exact
server-rendered owner decision applies the watch change. Current NLP guards only filter proposals.
Existing Owner API commands and read-only polling are unchanged.

Migration 036 stores immutable, ten-minute proposals keyed by owner source turn, plus action
receipts. Preview includes operation/PR/Thread/mode/interval/lifetime. Generic ask actions and
mismatched messages cannot apply it; owner confirmation causes zero model runs. Mutation and
proposal/question resolution share the real database transaction. A transaction-free backend
adapter avoids workerd's prohibition on nested transactions. Replays do not renew TTL or resurrect
cancelled watches. Reuse preserves the existing expiry; changed targets refuse confirmation.

## Prospective measurement change (before any paid v3 run)

Keep the 12 utterances and expected logical outcomes. Add an independent, predefined owner script:
create cases 1/2/3/10 approve only the correct Thread/URL/mode, 900-second interval and 1440-minute
lifetime; case 5 approves only `pw_x`'s initial identity; case 9 approves the correct proposal then
hits the injected backend refusal. Other cases grant nothing. This script is not inferred from
model outputs, tool choices or replies. Wrong seven-day/default overrides remain unapproved.

Scoring version 3 measures proposal + separate owner decision. A proposal alone is pending, not
success. The failure in case 9 is now a deterministic action response, not a second model turn;
its truthful failure/no-fallback requirement is unchanged, but v2's tool-error sequence is not the
new protocol. Original v2 scores/results are retained, not reinterpreted. Routing labels, score()
and thresholds remain unchanged. Routing/memory context adapters expose the proposal interface
but cannot grant owner confirmation. This is a new input cohort.

The CLI freezes a private profile and credential/header environment once per run. Each child
attests safe requested/effective configuration, checked against the parent. Source-profile edits
must not change later workers. This addresses experiment 0006's P2 instead of assuming operator
file discipline. Temporary snapshots contain env references, not credential literals, and are
removed on normal completion. Results are atomically replaced after each case.

## Validation and publication

Passed before freezing the candidate: app typecheck; routing selftest; all 10 deterministic memory
cases; 34 intent/old-adversarial/CLI assertions including external-profile edits during a run;
124 selected Node tests and the same 124 on workerd (including action/workspace regressions).
The approval backend also tests rollback after a watch insertion fails, relative expiry replay,
stale targets, declined/expired cards, fake ordinary ask actions, wrong message binding, plain
quote replies preserving unrelated questions, browser CSRF/session flow and stale UI taps.

[Independent source review](0007-independent-review.md): no issues found, OK to continue gated
publication; reviewer did not execute tests. Full workerd app suite: 67 files / 865 tests passed.
Full Node app suite: the same 67 / 865 passed after correcting an existing order-dependent dispatch
assertion. Thread views sort by last activity, not dispatch order; the corrected test asserts
cardinality and each Thread's actual mode. No production or evaluated source changed.
`pnpm test:node` uses POSIX inline-env syntax incompatible with Windows cmd; the same Node runner
was invoked with `STEWARD_TEST_RUNTIME=node` supplied externally. [Suite receipt](0007-suite-receipt.json).

## Real-model evidence (one run of each, no selective reruns)

A fixed declared-source Git archive of `4f66827480e2c99ffb3b50bc1f915298b6d110e6` ran on the VPS.
The locally bundled runners are themselves hashed in the manifest. The snapshot has no `.git`;
the [server receipt](0007-validation-receipt.json) binds revision, bundle hashes and UUIDs. This is
not direct-TS evidence and cannot be pooled with older snapshots as a noise cohort.

- [Routing raw JSON](../../../apps/steward/eval/results/production-4f66827-routing-20261115.json):
  106 cases, pass including text-ask 99, wrong-route 0/106, missed-ask 0/11,
  unnecessary-ask 7/95 (7.4%), errors 0. All unchanged routing thresholds passed.
  UUID `1568cbd5-937f-45a7-9333-e33c68ce688c`.
- [Intent v3 raw JSON](../../../apps/steward/eval/results/production-4f66827-intent-20261115.json):
  12/12 passed, errors 0. Create/cancel effects required the separately declared matching owner
  plan. Ambiguous/conditional scope #7 asked before proposing; #9's owner-confirmed injected
  backend failure produced the deterministic failure response, without worker/schedule fallback.
  UUID `e39ec583-13cb-4363-9f73-475ec14785cc`.
- Both: `inputStable=true`, provider `openai-compatible`, model `deepseek-v4.1-flash`, effective
  thinking `high`, no custom headers, same endpoint hash, Node v24.22.2/Linux. Routing concurrency
  2 and intent 1 ran concurrently in a root-only 650 MiB cgroup with lower CPU priority.
  [Profile check](0007-profile-check.json); intent workers additionally attest the frozen profile.

These are one observation each, not a measured noise floor/statistical improvement. v3 is a new
protocol, not a retroactive rescore of v2. Exact provider charges were not measured; spend stays
outside the production conversation ledger. Keys stayed on the VPS, profiles contain env refs,
private results were checked for known credential values before download. No live Thread, worker,
schedule, GitHub status or production conversation was mutated by these isolated evals.

The owner authorized deployment only when appropriate and is not currently using Otto. All
pre-deploy gates now pass. Next: backup program/SQLite, deploy without changing credentials,
and validate the real conversation/card-confirmation lifecycle on the existing private lab PR.
Do not call that synthetic-status smoke a real CI or phone-push acceptance test.
Do not treat simulated owner clicks as real UI acceptance. Preserve failing artifacts and never
relax expectations to accommodate measured output. Production remains `9fc76c7` until an accepted
candidate is backed up and deployed; model credentials must stay on the VPS.
