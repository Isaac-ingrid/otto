# Experiment 0006: Independent Review and Real-Model Validation

Date: 2026-11-14. Production candidate: `eaacc48`; parent record: [0005](0005-pr-watch-intent-boundaries.md).
Status: `eaacc48` rejected by independent review; successor fixes reproduced offline, re-review and paid runs pending.
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
  deterministic memory cases passed. No real model calls or full workspace suite yet.

## Measurement / next decision

Raw artifacts and server receipt will be linked after execution. Production credentials stay on
the VPS in short-lived root-owned processes; profiles contain environment references, not keys.
Isolated synthetic eval worlds must not create production messages, watches, workers or schedules.
The production service/bundle remains unchanged. Preserve raw red results; never alter labels,
thresholds or scorer after seeing outputs to manufacture acceptance.
