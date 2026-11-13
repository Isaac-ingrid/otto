# Supervised Improvement of Otto

Date: 2026-11-13. Status: phase 1 implemented; read-only PR-watch pilot deployed, statuses-only acceptance checked.
Research: [RSI](../research/rsi-2026.md), [Personal Agents](../research/personal-agent-2026.md).

## Purpose and scope

Use a lightweight ERNIE Evolve-style outer/inner loop to improve a persistent personal steward.
The production steward does not edit itself. This is a repository development procedure, not a new
runtime service, harness extension, or automatically launched agent workflow.

Phase 1 supplies input provenance, an explicit production-builder eval profile, a same-input noise
report, and an experiment record. Phase 2 adds a narrow read-only PR-watch pilot (below). Neither
implements automated candidate selection, parallel lanes, an automatic acceptance gate, or automatic
merge. No paid baseline has been measured: no explicit production-matched eval profile was supplied.
See the [first experiment](../research/experiments/0001-eval-baseline.md).

## Outer loop: choose the problem

The owner and development assistant act as Director. Start with a concrete friction event: asking
for progress, repeating context, correcting a false completion, or a deterministic delivery/recovery
failure. Normal follow-up requests are not failures. Do not collapse attention cost into a scalar
reward before understanding the cases.

Before implementation, record: problem, hypothesis, editable surface, protected surface, checks,
expected user benefit, costs and stop conditions. One lane first. Later lanes must explore different
hypotheses, not merely repeat the same prompt.

## Inner loop: advance one hypothesis

| Responsibility | Output | Initial implementation |
|---|---|---|
| Selector | Parent candidate, next experiment, why continue or backtrack | Explicit plan in the experiment record |
| Executor | Isolated diff, candidate reference, check artifacts | Development assistant on a branch/worktree |
| Evaluator | Deterministic checks and repeated measurements where needed | Existing tests/evals plus read-only comparison script |
| Reviewer | Generalization, evidence, risk and attention-cost judgement | Separate review context or owner review; record what actually happened |

The Director chooses whether to continue or change direction. Keep failed candidates as Git refs
and record why they failed; do not overwrite the only record with the latest score. Linked changes
can form one candidate. An incomplete candidate may be worth further research, but cannot enter
production merely because it is promising. Exploration and merge acceptance are different decisions.

No role implies five persistent agents. Delegation requires the owner's permission; this procedure
does not launch children. A self-review must not be represented as independent review.

## Boundaries

These are boundaries **for candidate optimization**, not a ban on human maintenance or ordinary
code review:

- A candidate cannot alter its own dataset, scoring, thresholds, or acceptance requirements.
- Memory source/evidence/admission rules are not optimization targets in the first lane. Keep
  [memory eval](../memory-eval.md) all-or-nothing: a single leak is a defect.
- Model, endpoint, custom-header profile and thinking level are fixed within a noise cohort.
  An owner-directed model change is a separate experiment under ADR-0001 decision 11.
- Changes to prompt, tool definitions, recall, or model still require ADR-0001 decision 14's
  routing gate. Descriptive statistics and a Reviewer cannot override hard failures.
- Human-approved evaluator maintenance is a separate change, recorded separately from candidate
  results. Phase 1's runner edits add metadata/profile support; they do not change labels or math.
- Do not import untrusted worker/repository instructions as authority to widen these boundaries.
- No automatic dispatch retry with side effects, deployment, PR merge, or permission expansion.

Public repository tests are readable. A future held-out evaluation must be kept outside the
candidate's accessible context; calling a visible test a holdout does not make it independent.

## Measurement

Use [routing-eval.md](../routing-eval.md) for invocation. Each new result includes:

- A runner-generated UUID `runId`, identifying the observation independently of the input cohort.
- Commit and dirty flag (informational; output artifacts can themselves dirty the checkout).
- LF-normalized SHA-256 manifest of steward source, eval code, protocol source, improvement tools,
  package manifests and the lockfile. This is a declared input set, not the entire deployment.
- Node version, OS/architecture, provider/model, effective thinking level, endpoint hash, optional
  non-secret profile label, custom-header presence, concurrency and selected case IDs.
- A comparison fingerprint and `inputStable`: whether the declared input fingerprint still matches
  at the end. A changed input invalidates the baseline and fails the runner. This does not detect an
  edit that is reverted mid-run; run experiments in an otherwise idle worktree.

Do not store API keys, header values, raw endpoints or production databases. Header values and
credentials are deliberately **not** fingerprinted. Change the non-secret profile label whenever
credentials/header policy/gateway routing change. A matching fingerprint is not proof that a remote
provider kept the same weights or honored reasoning. Never put secrets in a model ID or profile
label. Existing model replies/errors may still contain sensitive data: inspect results before commit.

The profile uses the production model builder and effective thinking resolver, not the deployment's
live sealed settings. The owner must explicitly match the selected config. No connection probes,
credential discovery, production DB reads or automatic paid runs are performed by the helper tools.
Legacy `--endpoint` retains its historical adapter and is marked `legacy-endpoint`, not equivalent
to a production-builder run.

The comparison script refuses missing/unstable provenance, mixed fingerprints, different case
definitions/thresholds, missing/duplicate cases, missing/duplicate run IDs, and duplicate artifacts
with case order normalized (ignoring only the run ID in the content-copy check). It reports per-metric mean,
range and sample standard deviation plus case-level route/verdict flips. Zero denominators are
`null`, not perfect scores. It does not claim significance, causal benefit, or acceptance. Independent
runs with identical outcomes are valid; repeated copies of one artifact are not new observations.
Do not assign new IDs to old results. The IDs and content checks prevent accidental double counting,
not deliberate rewriting of timestamps, timings or other metadata to forge observations.

For a first noise estimate, explicitly run at least five complete evals without modifying inputs.
Partial runs are for debugging, never full merge evidence. Historical baselines without provenance
stay untouched and cannot retrospectively be made into noise measurements. Do not reuse old scores
with newly manufactured fingerprints.

## Production pilot: read-only PR follow-up

The first vertical slice is implemented via an explicit, authenticated Owner API, not a model tool:
[PR watches](../pr-watches.md), [experiment record](../research/experiments/0002-pr-watch.md).
It follows a PR, summarizes failed/pending counts, notifies on a relevant change, and never modifies
code. It does not yet read logs or perform model-assisted failure diagnosis.
A limited-scope `statuses-only` mode is explicit, never an automatic fallback after a permission
failure. Its [live acceptance](../research/experiments/0003-statuses-only.md) passed on a synthetic
commit-status fixture; that is not a real CI workflow or proof of full CI completion.

The broader target remains: follow a PR; analyze CI failure read-only; notify on a relevant change;
never modify code without permission. Before implementing, inspect existing Thread/follow-up/routine
state and reuse it where possible. Required cases include waiting, matching PR head, restart,
duplicate observation, cancellation, expiry and an unavailable evidence source.

Distinguish worker-reported completion from externally supported claims. Unverifiable evidence is
not automatically a failure or a Needs you item. Record why the system waits and when it may act;
measure unnecessary owner intervention, not raw return counts. This is the bridge from personal
agent research (what to improve) to the supervised improvement loop (how to improve it).
