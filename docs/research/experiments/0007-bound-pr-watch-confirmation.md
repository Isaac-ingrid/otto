# Experiment 0007: Bound Owner Confirmation and Frozen Evaluation

Date: 2026-11-14. Parent: `1bfe690`; production predecessor: rejected `be11d13`.
Status: accepted source `4f66827` deployed on 2026-11-15 (UTC+8), after independent review,
full app suites and both required real-model gates passed. Live synthetic-lab acceptance passed.

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

## Deployment and live acceptance

The owner authorized deployment only when appropriate and was not currently using Otto. After
all gates passed, local `main` fast-forwarded to integration commit `088d8d9`; no GitHub PR was
merged and no commits were pushed. Production/evaluated code remains byte-identical to `4f66827`;
only the dispatch test and evidence docs followed it.

[Deployment receipt](0007-deployment-receipt.json): stopped the service with zero open runs,
backed up the old program/map and SQLite under `/opt/otto/releases/4f66827/previous/`, verified
backup integrity, installed the verified bundle and restarted. Migration 036 and current database
integrity passed. Configuration, credentials, scopes and systemd unit were unchanged. Bundle SHA-256
`b5e33f35fb9be008ca120fa40a76f2a25e31119df667e396a362f549851ecb6d`.

[Live receipt](0007-live-acceptance.json), [operator driver](0007-live-acceptance-driver.mjs):

- Real production model made a create proposal for the existing private lab PR/Thread, explicitly
  `statuses-only`, 60-second interval / 60-minute lifetime. No watch existed before confirmation;
  quoted ordinary agreement neither authorized it nor invoked the model.
- Pending proposal survived a restart. An authenticated workspace HTTP session + CSRF action
  confirmed the exact server-generated card (202); the card closed and a fresh stale tap got 409.
- An actual GitHub read observed the known head and synthetic pending status. A second restart
  recovered polling; a subsequent scheduled read advanced `checkedAt`, without duplicate notice
  or model run. This exercises real service/SQL/cron/HTTP paths, not the evaluator's simulated owner.
- List caused no proposal/mutation. A cancellation proposal left the watch active until another
  authenticated workspace confirmation. Cancellation remained terminal through an eligible
  subsequent cron window; checkedAt did not change.
- Exactly three production owner model runs (create/list/cancel proposal); confirmation, quote
  interception and polling added none. Worker count 12, outbox 23, follow-ups 1 and routines 2
  stayed unchanged. No new worker commands or model-based follow-up were created.
- Test watch cancelled, zero active test watches, browser session logged out (200). The existing
  lab synthetic context `otto/watch-smoke-9fc76c7` was temporarily pending and restored to success.
  No repo files, real CI runs or other watches were changed; all lab timeline/audit records remain.

The first operator-driver setup attempt failed before model input/watch changes because its PR
URL constant shadowed the native URL constructor; the controller used `globalThis.URL` and the
same full lifecycle was then run. [Failed setup receipt](0007-live-setup-failure.json) retained.
No deployed code, evaluation definition or threshold changed to make that attempt pass.

[Health receipt](0007-health-receipt.json): default-trust public HTTPS 200, anonymous API 401,
owner API 200; read-only doctor 0 failures. Local backup/timer, TLS expiry and queues passed.
Encrypted offsite backup is still disabled (pre-existing, not silently presented as protected).
Rollback: restore the previous program/map first, retain the compatible upgraded database;
do not automatically restore the old SQLite snapshot and erase subsequent records.

This was a synthetic-status lab smoke using a real authenticated workspace HTTP client, not an
actual browser DOM click, phone-push test, full CI workflow or changed-head acceptance. Those and
N>=5 same-input noise observations remain unmeasured. Preserve failing artifacts and never relax
expectations to accommodate measured output. Model credentials stayed on the VPS.
