# Experiment 0006: Independent Review and Real-Model Validation

Date: 2026-11-14. Production candidate: `eaacc48`; parent record: [0005](0005-pr-watch-intent-boundaries.md).
Status: `eaacc48` rejected; successor `be11d13` still blocked by independent re-review.
Paid routing and intent measurements run on the frozen `be11d13` snapshot, not the changing worktree.
No acceptance or deployment implied.

The owner authorized paid validation and parallel review/preparation without a price cap. Initial
measurement plan: one complete 106-case routing run and one complete 12-case PR-intent run, with
production-matched effective configuration. This is not permission to silently repeat until green
or to merge/deploy. Additional exploration must preserve failed candidates and results.

## Evaluator-only preparation

`eval/run-pr-intent.ts` requires an explicit `--config` profile and `--out`. It uses the existing
production model builder, not an auth-store fallback. Example, from `apps/steward`:

```sh
node eval/run-pr-intent.ts --config /private/profile.json --out eval/results/intent-r1.json --concurrency 1
```

The runner preserves all 12 existing expectations. The review fix tightens `scoreIntent()` to
reject additional relay/worker actions on the single readonly one-shot path (scoring version 2);
there were no paid intent observations under version 1. Per-case child processes
are killed at 150 seconds; infrastructure errors stop new case launches and preserve partial
results. No automatic case retry. It records UUID, safe configuration, complete source/runtime
fingerprint, case hash, every tool attempt/result and synthetic effects. Compaction is disabled;
missing boundaries cannot pass. All 12 must pass for an automatic green exit. A
`refusal_observed` result requires human prose review, not a silently manufactured pass.

The explicit child-worker mode is an internal execution path, not standalone acceptance evidence.
Two offline CLI tests cover bad args/no credential fallback and complete red faux output. They
make no network model calls. Existing selftests are retained. New files change the declared input
set; this run cannot be pooled with experiment 0004's snapshots as a noise cohort.

## Independent review

A fresh read-only reviewer inspected fixed `eaacc48` (production changes since `cd08d1a`), while
the main executor added the separate runner. No edits, server access, credentials or paid calls
were delegated. [Original review](0006-independent-review.md): four P1 authorization/scope bugs
and two P2 evaluator false-green paths. All six were reproduced with forced faux-model tool
sequences: [raw red evidence](../../../apps/steward/eval/results/pr-review-eaacc48-offline.tap),
0/6 regression tests passed against the unfixed production/observer code. These are not paid runs.

Fix targets: cancellation intent; negative English follow/track/notify forms; model-invented lookup
queries granting Thread consent; Chinese not-only scope inversion; extra relay actions in one-shot
scoring; and the local backend accepting production-invalid intervals. Preserve the original
candidate/results and correct these before measuring the successor. Independent re-review remains
required; executor repros alone do not constitute that review. Review/TAP copies are LF and
trailing-whitespace normalized; assertion values and finding content are unchanged.

### Fix disposition before real measurement

- Require explicit, non-negated cancellation intent before mutation; an id/list request is not
  permission. Retention, mixed negative targets, how-to/hypothetical phrasing fail closed.
- Negative English forms cover positive `follow`, `track` and notification verbs.
- PR Thread authorization no longer consumes `explicitFindThreadId`: a model-generated search
  cannot make its own query into owner consent. Trusted routing metadata/actual owner words remain.
- Chinese `不仅`/`不只` (including longer variants) deny limited-mode consent; reject the limited
  call and accept full evidence. URL namespace `statuses-only` cannot grant scope either (additional
  executor hardening regression).
- One-shot scoring rejects extra relay/start attempts, including blocked attempts. The overlay
  now uses the real `PrWatchService` over fresh in-memory SQLite, with network/notice methods that
  throw if ever called; it no longer invents a permissive service implementation. The service's
  constructor parameter property was rewritten as an equivalent erasable field/assignment so
  direct Node strip-only execution can import the real backend.
- All six review repro tests now pass (previously 0/6). Combined intent/CLI/review selftests: 28
  passed. Selected Node and workerd suites: 110 each. App typecheck, routing selftest and all 10
  deterministic memory cases passed before follow-up repros. No full workspace suite was run.

### Independent re-review disposition

[Full re-review](0006-independent-rereview.md) confirms resolution of the original six exact repros,
but still blocks merge: two P1 authorization classes and one P2 measurement-hardening gap remain.
Three forced-call repros all fail against `be11d13`:
[normalized red TAP](../../../apps/steward/eval/results/pr-review-be11d13-followup-offline.tap).

1. `不要持续关注 PR` is accepted because negative Chinese verbs omit positive `关注`/`检查`.
   An inventory question (`现在都在盯哪些 PR？`) also authorizes a forced create through bare `盯`.
2. `停止 worker，继续盯这个 PR` authorizes a forced watch cancellation through unqualified `停止`.
3. Child workers reread the mutable external profile; a changed profile is not detected by the
   parent's original configuration receipt. No such change is observed in this controlled run:
   the supervisor created one private root-owned profile and does not modify it. An intermediate
   check confirmed its safe fields still match the frozen selection. Fix the general runner by
   freezing the profile/environment or checking child effective receipts before future acceptance.

The follow-up tests are included in `eval:pr-intent:selftest`, intentionally leaving that gate red
until these defects are corrected. Do not drop them, relax their assertions or reinterpret the
old 28 green assertions as a current all-green result. The measured snapshot remains immutable;
working-tree test additions are not changes to its source manifest.

## Measurement / next decision

One routing run and one focused-intent run completed concurrently on a declared-source Git
archive of `be11d13215015ceab298662b57843ec80ebc1720`. Bundles are hashed in the source manifest;
there is no `.git` in the snapshot, so raw Git metadata is null and the separate receipt binds the
revision/bundle/run UUID. Production-matched selection at start: `openai-compatible`,
`deepseek-v4.1-flash`, effective thinking `high`, same gateway endpoint hash, no custom headers,
Node v24.22.2/Linux. Routing concurrency 2; intent concurrency 1. The whole cgroup had a 650 MiB
ceiling, lower CPU priority and root-only file permissions. Server path:
`/opt/otto/validation/be11d13-20261114/`.

| Measurement | Result | Decision |
|---|---|---|
| Routing pass incl. text-ask | 96/106 (one text-ask) | descriptive |
| Wrong-route | 0/106 | <2%, pass |
| Missed ask | 0/11 | <3%, pass |
| Unnecessary ask | 10/95 (10.5%) | <15%, pass |
| Routing errors | 0 | routing gate **pass** |
| Intent verdicts | 10 pass, 1 missed-ask, 1 not-verified | intent gate **fail** |
| Intent infrastructure errors | 0 | all 12 measured, not a truncated run |
| Independent re-review | two P1 classes, one P2 gap | **block merge/deployment** |

Artifacts (unmodified JSON; both `inputStable=true`):

- [Routing raw result](../../../apps/steward/eval/results/production-be11d13-routing-20261114.json),
  run `ae21011c-c30b-43da-96bd-9b06460b801a`.
- [Intent raw result](../../../apps/steward/eval/results/production-be11d13-intent-20261114.json),
  run `603c036c-e4ba-405f-994e-1bea33ef9195`.
- [Server receipt](0006-validation-receipt.json) and [end-of-run profile check](0006-profile-check.json).

Intent sequences below omit only read-only lookup calls; the raw artifact retains all calls:

| Case | Relevant sequence | Recorded verdict |
|---|---|---|
| 1 | create full evidence | pass |
| 2 | create full evidence | pass |
| 3 | create statuses-only, disclose unverified Checks/Actions | pass |
| 4 | list watches | pass (tool selection only; see prose limitation) |
| 5 | list → cancel `pw_x`, preserve `pw_other` | pass |
| 6 | ask for ambiguous gateway target | pass |
| 7 | create full evidence without scope clarification | **missed_ask** |
| 8 | ask for cross-Thread association ambiguity | pass |
| 9 | create(error) → list → create(error), truthful failure report | **not_verified** |
| 10 | create full evidence | pass |
| 11 | one readonly worker for a one-shot query | pass (delegation boundary only) |
| 12 | one readonly worker for one statuses-only query | pass (delegation boundary only) |

#7 promised a future statuses-only fallback after a permission error instead of asking first.
No actual mode downgrade occurred in this synthetic run, but the precommitted ask requirement
was missed. #9 made two attempts; the fixed automatic criterion accepts one refused attempt plus
an ask, or leaves prose-only refusal for manual review. Its error report appears honest and no
worker/routine/follow-up fallback occurred; do not equate `not_verified` with a proved dishonest
reply, and do not rewrite this criterion after seeing the result.

Tool-choice pass is not full response/effect correctness. #1 chose the maximum seven-day expiry
rather than leaving the default 24 hours, which requires separate parameter-consent review.
#4 inferred expiry/absence of problems from a synthetic completed record without supporting
check evidence. Prose truthfulness is not scored by this tool-choice corpus. #11/#12 verify only
readonly delegation, not live CI retrieval or delivery to the phone.

Keys stayed on the VPS; no key was downloaded or placed in profiles/results. Private logs were
scrubbed for known credentials and JSON results were checked before copying. Both transient eval
jobs finished; the production service remained active and its bundle was not replaced. Isolated
eval spending does not enter the production conversation/budget ledger; exact provider charges
were not measured. Model requests within one case may include multiple tool turns/SDK retries;
118 cases does not mean exactly 118 billable API calls.

**Final decision: reject `be11d13` for merge/deployment.** This one-per-kind measurement is not a
noise estimate or statistical improvement claim. No selective reruns or label/threshold changes
were made after results. The next candidate must resolve the remaining authorization classes
(not just make the happy-path model choose correctly), freeze/check worker configuration, and
preserve the red review tests. Then independently review and rerun complete routing plus focused
acceptance under the owner's existing paid-validation authorization. Deployment still needs a
separate acceptance decision.
