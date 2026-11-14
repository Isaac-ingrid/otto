# Experiment 0005: Persistent PR Intent and Full CI Scope

Date: 2026-11-14. Parent: `2ea95f8`; production-code predecessor: `60efdc8`.
Branch: `feat/pr-watch-tools`. Status: deterministic checks passed; new real routing gate pending.
No child agents, paid model calls, merge or deployment. Production remains on `9fc76c7`.

## Outer-loop decision / preserved evidence

Experiment [0004](0004-pr-watch-tools.md) recorded one routing pair, followed by an offline intent
observer. Its scripted negative cases exposed two tool-boundary defects:

1. An explicit persistent request for "CI and commit statuses" was refused unless the owner also
   used the guard's narrower Checks vocabulary.
2. A real owner plus a known PR could authorize creation even when the owner requested just one
   lookup or explicitly rejected ongoing monitoring. The previous prompt alone was not a hard gate.

The owner approved fixing these boundaries and adding regressions, not additional paid measurement.
The old snapshots, results and labels are retained unchanged. The old real-model pass belongs to
`60efdc8`, **not this successor**. New tool guidance and code require a new ADR-0001 decision 14
routing gate before merge/deployment. The intent scorer and its 12 expected outcomes are unchanged.

## Inner-loop change

`src/pr-watch-intent.ts` adds conservative lexical checks over the real owner text:

- Require explicit persistent intent; a bare URL or a one-time status query is insufficient.
- Reject explicit one-shot/negative or contradictory watch wording before target lookup, existing
  watch reuse and task replay. URL paths containing `watch`, `monitor` or `CI` do not grant intent
  or scope. Do not mutate or cancel a pre-existing watch as a side effect of refusal.
- Recognize positive `CI` together with commit statuses as full evidence scope. Common negated
  CI/Checks wording is not positive authorization. Explicit statuses-only consent and
  no-permission-fallback rules remain intact; negated English `not only commit statuses` /
  `no statuses-only` cannot authorize the limited mode.

Tool descriptions and guidance distinguish a one-shot readonly query from persistent delegation.
Owner provenance, Thread/PR ambiguity, expiry/idempotency and same-turn fallback guards remain.
These are conservative lexical rules, **not** a general natural-language authorization proof:
ambiguous or contradictory wording must be clarified. Bare acknowledgements or target-button
replies without persistent-intent words currently need explicit restatement; carrying authorization
from an earlier owner turn would need separate provenance-backed design. This candidate does not change the Owner
API, poller, credentials, CI results, routing labels, `score()` or thresholds.

## Evaluator

- Node host: 110 selected tests passed across intent, tools, watch service/API, web-search and
  routine regressions. Workerd: the same 110 passed. Includes 41 lexical scope/intent assertions
  and 10 additional tool-boundary cases; not the full workspace suite.
- Offline intent observer: 20 tests passed. All 12 fixtures now have a scripted acceptance path,
  including full-scope creation for #10. This does **not** measure real-model choice accuracy.
- Forced create calls for #11/#12 now return errors with zero new watches. The intent scorer still
  marks them `unexpected_persistence`: rejecting a bad model choice is not a correct tool choice.
- One-shot requests also refuse the existing-watch reuse path without changing its row or expiry.
- Negated CI does not silently select full scope; statuses-only still requires explicit owner words.

Additional checks passed: app typecheck, routing selftest, all 10 deterministic memory cases,
and all 11 improvement-tool tests (local fake gateway only). Full workspace tests were not run.
The expanded eval TypeScript check remains blocked by the five existing legacy-harness typing
errors documented in experiment 0004; no clean expanded-check claim is made.

## Reviewer / next decision

Executor self-review only. Independent review, a new production-matched routing run and focused
real-model intent acceptance remain pending. No fee or statistical benefit is claimed. Resolve the
measurement procedure/profile and obtain spending authorization before any new real-model run.
A future noise estimate must not pool this source tree with the older immutable fingerprints.
