# Experiment 0004: Natural-language Entry to Persistent PR Watches

Date: 2026-11-13. Parent: `cd08d1a`. Candidate branch: `feat/pr-watch-tools`.
Status: candidate implemented; real-model gate pending.
No autonomous workflow or child agents were launched. Production remains on `9fc76c7`.

## Observed friction / outer-loop decision

The owner sent a PR-following request to the deployed Otto. It honestly used the existing worker
query plus a 30-minute follow-up, rather than the typed, model-free PR-watch service. The worker
saw the synthetic acceptance status left successful by experiment 0003; that was not real CI.
The owner approved replacing this path. The redundant `f_525` was narrowly cancelled in production
as an operator-authorized cleanup (matching id, Thread and lab reason), with a timeline record.
The one-shot scheduler may still reach the cancelled row, but its status gate prevents a wake.
No model call was used for cleanup and no other schedule was cancelled.

Hypothesis: a dedicated create/list/cancel tool surface can express the same owner intent without
recurring model/worker work, while refusing ambiguous PR/Thread targets and silent scope changes.
Editable: tool/context wiring, prompt guidance, deterministic lookup helpers and tests. Protected:
routing labels/scoring/thresholds, memory trust rules, GitHub permissions and external write actions.

## Inner-loop implementation

- `get_thread` exposes structured PR associations and watch rows.
- Creation requires a real owner run and an explicit link or a unique known target in a clearly
  selected Thread. Multiple PRs, duplicate Thread titles or cross-Thread associations refuse.
- `statuses-only` requires explicit limited scope in owner text; a Checks permission failure is
  not authorization to downgrade. No network permission probes happen in the tool itself.
- An existing matching active watch is reused without renewing expiry. Reuse repairs the schedule
  arm too. Replaying the same task with a relative expiry retains its original deadline and cannot
  resurrect cancellation. Cancellation targets a known id/unique contextual watch, not a guessed candidate.
- A same-turn guard prevents mixing dedicated PR creation with worker dispatch or another schedule,
  including after refusal. It resets for a new owner turn. Web-search action isolation includes
  the new mutation tools.
- Eval context plumbing exposes the same new tool names without real GitHub calls; it does not
  change labels, scoring or thresholds. Memory eval keeps writes/dispatch inert.

## Evaluator

Passed: 59 selected tests on Node host and 59 on workerd (13 new scripted-tool boundary tests,
existing watch/API/web-search/routine regressions). Routing selftest and all 10 memory cases passed.
Typecheck passed. These scripted tests do not establish real-model tool-choice accuracy.

One Node routine regression initially failed because it required a recovered overdue one-shot
schedule to still exist. Temporary diagnostic copies showed it can already have fired and produced
`followup:f_stranded` before the assertion. A committed-parent copy passed; the candidate's old
assertion failed intermittently. The test now permits a live schedule OR a fired follow-up and
additionally requires the actual follow-up run. No reconciliation implementation or eval threshold
was changed to hide the issue. All selected tests subsequently passed on both runtimes. The 11 improvement-tool tests also
passed; the full workspace suite was not run.

Non-secret production selection observed: provider `openai-compatible`, model
`deepseek-v4.1-flash`, requested thinking `high`, endpoint origin `https://ai.ctaigw.cn`, no custom
headers. Effective configuration and a safe credential channel must be confirmed before paid eval.
No production model key was exported and no real routing runs have been made for this candidate.

## Reviewer / next decision

Executor self-review only; independent review pending. Do not merge or deploy this prompt/tool
change until real routing eval meets ADR-0001 decision 14. Use fixed production-matched settings
for baseline and candidate; retain artifacts and record variance limitations. No paid-run budget
or statistical improvement is claimed. Full workspace tests were not run.
