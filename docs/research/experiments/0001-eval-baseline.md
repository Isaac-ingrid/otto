# Experiment 0001: Make Routing Measurements Traceable

Status: exploring — offline tooling checked; paid baseline and independent review pending.
Date: 2026-11-13. Lane: one. Director: owner-directed implementation, not autonomous selection.

## Direction (outer loop)

- Friction: committed eval JSON has no code/config provenance. Production now supports custom
  gateways, headers and thinking settings, while the legacy endpoint eval has its own adapter.
- Hypothesis: reusing the production model builder plus recording input identity makes later
  routing experiments interpretable without changing production behavior or score rules.
- Allowed edits: eval profile/metadata plumbing, offline comparison tools, tests and documentation.
- Protected: case labels, scoring, thresholds, memory trust policy, production steward and connector.
- Success: deterministic provenance, no credential serialization, gateway wire parity for explicit
  profiles, rejection of incompatible measurement cohorts, existing deterministic evals unchanged.
- Stop: if parity requires a production behavioral change, stop and review that separately.

## Candidate lineage (inner loop)

Parent: `c9da512`. Candidate: `20a61d3` (traceable supervised improvement evaluations).
The owner authorized packaging as a local commit; no deployment or paid baseline was performed.

Selector: first remove ambiguity in measurement inputs, then measure noise. Executor: main coding
assistant; no child agents launched. The first local wire fixture incorrectly assumed case #1
required dispatch; the dataset labels it chat. Corrected the fixture to case #2 without changing
any labels or scoring.

## Evaluator

Commands:

```sh
node --test scripts/improvement/improvement.test.mjs
cd apps/steward
node eval/run-eval.ts --selftest
node eval/run-memory-eval.ts
# From repository root:
corepack pnpm --filter @isaac2ingrid/steward typecheck
```

Observed: 7 improvement tests passed (including local wire checks for auto/off/high), routing
selftest passed, all 10 memory cases passed, steward typecheck passed. Full workspace tests were
not run. `git diff --check` and new-doc/script LF/trailing-whitespace checks passed.

The local gateway test sends no paid model calls; a plain response to dispatch case #2 intentionally
fails the unchanged routing gate while proving transport/header/thinking wiring and result output.

Raw paid result paths / noise comparison: **none**. Do not present this implementation as evidence
of improved routing accuracy. Full real-model reruns, remote endpoint stability, and production
configuration matching are still unmeasured. Existing historical baselines are not relabeled.

## Merge-review fixes

Executor review reproduced two P2 defects before merge:

1. A bare `--config` silently selected the default provider; a preloaded fake fetch proved it could
   proceed with an available default key. The regression now requires an error before any fetch or
   artifact write. All valued options are parsed strictly, including missing/blank values, flags
   mistaken for values, duplicate options and unknown names.
2. Five case-order permutations of one artifact were counted as five observations with zero
   variance. The runner now assigns a UUID `runId` outside the cohort fingerprint. Comparison
   requires distinct IDs and normalizes case order when detecting copied content (ignoring only
   the run ID), so relabeling a copy does not suffice. Independent runs with identical outcomes
   remain valid when their recorded observation metadata differs.

The improvement suite now has 11 passing tests, including both reproductions and repeated local
runner invocations that emit distinct IDs. No historical result was relabeled and no paid calls
were made. These are accidental-duplication checks, not signed evidence against metadata forgery.

## Reviewer

Independent review: pending. Executor self-check is not independent review.
Owner merge approval: pending. No deployment or automatic merge performed.

## Attribution and next outer-loop decision

Current uncertainty: evidence insufficient for routing-noise estimates, not a failed hypothesis.
Next: owner selects a non-secret profile label, matches production settings and authorizes paid
runs; run five full measurements on fixed inputs, then inspect per-case variation before proposing
any acceptance-rule change. Existing ADR gates remain in force.
