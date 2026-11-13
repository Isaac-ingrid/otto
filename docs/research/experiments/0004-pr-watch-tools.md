# Experiment 0004: Natural-language Entry to Persistent PR Watches

Date: 2026-11-13. Parent: `cd08d1a`. Candidate branch: `feat/pr-watch-tools`.
Status: candidate `60efdc8` passed one real-model routing gate; not merged or deployed.
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

## Authorized real-model pair (2026-11-13)

The owner authorized exactly two complete measurements: baseline `cd08d1a` and candidate `60efdc8`.
Both used the resolved production configuration: provider `openai-compatible`, model
`deepseek-v4.1-flash`, effective thinking `high`, same endpoint and no custom headers. Concurrency
was 2 in both runs; Node v24.22.2 on the VPS. Neither production conversations nor live Threads
were used as eval worlds.

Each revision was extracted as a declared-source Git archive and its runner bundled locally with
the installed, lockfile-pinned dependencies. Bundled faux selftests passed locally and on the
server before paid calls. The runner was placed at `scripts/improvement/eval-bundle.mjs` so its
input-root calculation still points at its snapshot; its hash is in the input manifest. Archives
have no `.git`, so raw `provenance.git` is null: do not mistake that for an unknown candidate.
The separate [pair receipt](0004-pr-watch-tools-pair.json) binds each snapshot revision, bundle
hash and run UUID to its result. This is bundled-snapshot evidence, not direct-TS execution.

A short-lived, root-owned process resolved the sealed key and effective thinking policy on the
server, opened production SQLite read-only, and passed the same credentials in process memory to
both isolated runs. No model credential was exported or written into the profiles/results. Logs
remained private; results were checked for known credential values before download. The job ran
sequentially with a 650 MiB cgroup memory ceiling and lower CPU priority; the production service
remained active. No connection-test completions or third paid run were added.

| Metric | Baseline | Candidate | Required |
|---|---|---|---|
| Pass including text-ask | 92/106 (86.8%) | 93/106 (87.7%) | descriptive, not the gate |
| Wrong-route | 0/106 | 0/106 | <2% |
| Missed ask | 1/11 (9.1%) | 0/11 | <3% |
| Unnecessary ask | 13/95 (13.7%) | 13/95 (13.7%) | <15% |
| Errors | 0 | 0 | 0 |
| Gate | **fail** | **pass** | all requirements |

Raw artifacts:

- [Baseline](../../../apps/steward/eval/results/production-high-pr-tools-baseline-20261113.json),
  run `e70672c7-5f78-482f-8f16-c67f5b858ed2`.
- [Candidate](../../../apps/steward/eval/results/production-high-pr-tools-candidate-20261113.json),
  run `cc4f5722-efd6-4bfb-bed4-d3d36eb2cc53`.

Both contain all 106 cases and `inputStable=true`. Eight of 106 verdicts changed; the other 98 are
identical. #63 is the only change that moves a threshold.

| # | Utterance | Label | Baseline | Candidate | Dataset note |
|---|---|---|---|---|---|
| 63 | 网关那边有点慢，帮我看看 | ask | attach `t_gw_refactor` → **missed-ask** | ask → pass | 网关簇 x2，日志开销也可能相关 |
| 49 | 接口加个 v2 版本前缀 | new | ask → unnecessary-ask | new → pass | — |
| 75 | 把慢的地方都看看 | new | ask → unnecessary-ask | new → pass | 全面性能排查是新工作 |
| 93 | 文档补完把 postman collection 也导出 | attach `t_docs` | ask → unnecessary-ask | attach `t_docs` → pass | — |
| 18 | 数据库迁移工具定了没 | chat | chat → pass | ask → unnecessary-ask | 状态询问：选型结论在汇报里 |
| 87 | 支付那个先只对线上环境对账 | attach `t_pay` | attach `t_pay` → pass | ask → unnecessary-ask | — |
| 103 | 回到搜索调研那条线程继续 | attach `t_search_plan` | attach `t_search_plan` → pass | ask → unnecessary-ask | live 验证过的显式措辞 |
| 69 | 那个等我的事我再想想 | ask | chat (`pass_text_ask`) | ask → pass | waiting x3 |

The unnecessary-ask **count** is unchanged at 13/95, but it is not the same set: the candidate
drops #49/#75/#93 and adds #18/#87/#103. Fixing #63 does not cost the other two metrics.

Three further cases kept their verdict but changed dispatch counts: #9 (1 → 0) and #89 (1 → 0)
still asked (unnecessary-ask) and no longer dispatched a worker alongside; #39 (2 → 1) still
attached to `t_login_rl`. Full outcome, reply and timing for every case stay in the raw JSON shown
above; this table is derived from it, not a second source of truth.

These are **one observation per revision**, not a measured noise floor or statistically established
improvement. No labels/thresholds were changed after observing results, and no selective re-runs
were made. The same-input noise comparator correctly refuses to pool these different-revision
fingerprints. This corpus tests existing routing, not real-model PR-tool intent selection; that
still requires a separately authorized focused acceptance test. Isolated eval spend is not entered
into the production conversation/budget ledger, and exact provider charges were not measured.

## Reviewer / next decision

Executor self-review only; independent review pending. The candidate meets ADR-0001 decision 14
on this recorded run; it has not been merged or deployed. Owner approval and focused natural-
language acceptance remain separate decisions. Do not reinterpret the red baseline as green or
claim a statistical improvement from one pair. Full workspace tests were not run.
