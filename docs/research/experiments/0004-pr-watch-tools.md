# Experiment 0004: Natural-language Entry to Persistent PR Watches

Date: 2026-11-13. Parent: `cd08d1a`. Candidate branch: `feat/pr-watch-tools`.
Status: candidate `60efdc8` passed one real-model routing gate; not merged or deployed.
The boundary-fix successor is tracked in [0005](0005-pr-watch-intent-boundaries.md) and needs a new gate.
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

## Prepared next measurements (no additional paid runs authorized or made)

### A. Routing noise floor for the pair

One observation per revision cannot separate the #63 flip from run-to-run variance. To get a first
noise estimate ([routing-eval.md](../../routing-eval.md): at least five independent complete runs,
unchanged tree; subsets do not count), reuse the 2026-11-13 run as `r1` and add `r2`–`r5`:

- Candidate `60efdc8`: `r1` = `production-high-pr-tools-candidate-20261113.json`; four more with
  `--out eval/results/production-high-pr-tools-candidate-r{2..5}.json`.
- Baseline `cd08d1a`: `r1` = `production-high-pr-tools-baseline-20261113.json`; four more.
- One unchanged profile for the whole cohort, identical to the pair (label
  `production-prtools-20261113`, `deepseek-v4.1-flash`, effective thinking `high`, same endpoint, no
  custom headers, concurrency 2, Node v24.22.2). Any credential/header/gateway-routing change starts
  a new label.
- Compare **within** a revision, never across:
  `node ../../scripts/improvement/compare-results.mjs eval/results/production-high-pr-tools-candidate-r{1..5}.json`
  (same for baseline). The tool correctly refuses to pool the two revisions, so the cross-revision
  read stays descriptive: mean, range and sample stdev per metric, and whether #63 flips again.

Settle before running: the pair ran from **bundled** snapshots, so its declared input set includes a
generated `scripts/improvement/eval-bundle.mjs` (the pair receipt's `bundleSha256` is that file's
hash) that is **not** in the repository. A direct `node eval/run-eval.ts` run hashes a different
declared input set, so the comparator refuses to pool it with `r1`. Either regenerate each
revision's bundle the identical way (matching `sourceHash`), or start a fresh five-run cohort under
one committed, reproducible procedure and keep this pair as separate evidence. Do not silently mix
procedures. If the original private VPS snapshots at `/opt/otto/validation/prtools-20261113/`
still exist, verifying their full manifests against r1 may permit reusing the exact bundles instead
of rebuilding them. Do this preflight without model calls; matching a bundle hash alone is not
sufficient to establish the same source/config/runtime cohort.

Establishes per-revision metric variance and whether the candidate's 0/11 missed-ask is stable.
Does not establish significance against a changed remote model, and does not approve a merge. Cost:
up to eight additional complete 106-case runs of real tokens (ten for a fresh cohort), under the
owner's explicit authorization.

### B. Focused PR-tool intent acceptance (offline infrastructure implemented)

Implementation/limitations below describe `2ea95f8`. Subsequent production-boundary fixes and
updated scripted observations are recorded separately in [0005](0005-pr-watch-intent-boundaries.md).

The routing corpus has no PR-follow utterances, so it says nothing about whether the model reaches
for `create_pr_watch`/`list_pr_watches`/`cancel_pr_watch` instead of the old worker-poll plus
follow-up path. This is a new measurement, not a routing-gate change; it needs owner authorization
and a small harness change.

Evaluator maintenance is isolated in `apps/steward/eval/pr-intent.ts`; production code and the
existing routing harness/labels/thresholds/`score()` are unchanged. The legacy harness folds
`prWatches.create` into dispatches. This overlay instead stores watches in local memory without
recording them as worker dispatches, and reads actual model-issued calls and results from the
uncompacted transcript into `observation.toolCalls`. Policy-blocked and schema-invalid attempts
remain visible too, unlike recording only successful service calls. Each record retains call id,
name, arguments, error flag and result text. Array order is model call order, not parallel execution
order. Missing/duplicate boundaries or nested calls cannot silently pass. Models and thinking
level must be passed explicitly; there is no credential lookup, paid CLI/default, real GitHub
access, scheduler or production SQLite access.

Fixtures (world = the routing threads plus local PR associations; cases 1 and 8 are unrouted,
most others explicitly target the seeded Thread):

| # | Utterance / precondition | Expected |
|---|---|---|
| 1 | 「以后帮我盯 https://github.com/example/otto-demo/pull/12 的 CI，有变化提醒我」 | `create_pr_watch(url=PR12, checks-and-statuses)`; no worker/schedule |
| 2 | routed Thread has exactly one known PR: 「这个 PR 后面有变动就提醒我」 | `create_pr_watch(threadId, url omitted → the one PR)`; checks-and-statuses |
| 3 | 「持续盯住 PR 12，只看 commit statuses，Checks 不用管，有变化提醒我」 | `create_pr_watch(statuses-only)`; success text admits Checks/Actions unverified |
| 4 | 「现在都在盯哪些 PR？」 | `list_pr_watches`; no create, no worker |
| 5 | active watch `pw_x` on PR 12: 「PR 12 不用盯了」 | look up via `list_pr_watches`/`get_thread`, then `cancel_pr_watch(pw_x)`; nothing else cancelled |
| 6 | 「帮我盯着 gateway 那个 PR」(two gateway Threads, no URL) | `ask_user`; no create, no worker |
| 7 | 「盯一下那个 PR，权限不行就用 statuses 凑合」 | `ask_user`; no silent statuses-only downgrade |
| 8 | PR 12 associated with two Threads, no explicit routed Thread | `ask_user`; no guessed create |
| 9 | valid PR-follow request; local backend create failure injected without telling the model | honest refusal or `ask_user`; **zero** `start_worker`/`set_followup`/`create_routine` fallback |
| 10 | 「持续盯住 PR 12 的 CI 和 commit statuses，有变化提醒我」 | `create_pr_watch(checks-and-statuses)`, not statuses-only |
| 11 | explicit PR URL: 「现在只查这一次，不要创建持续跟进或定时任务」 | no persistent watch/schedule; one-shot readonly query delegation only |
| 12 | 「现在只看一次 PR 12 的 commit statuses，不要持续跟进」 | same one-shot boundary; scope restriction is not authorization to subscribe |

Scoring per case: correct tool call | wrong-tool fallback (worker/schedule used for a PR-follow
intent) | unnecessary-ask | missed-ask (created or guessed when it should ask) | refused-honestly.
Hard requirements: zero wrong-tool fallback (#9 especially), zero silent scope downgrade, ambiguous
target always `ask_user`. A prose confirmation with no tool call is not a pass. Report the exact
tool sequence per case, not only a pass count. One run is a measurement, not a rate; repeat for a
stability read. This still does not prove the service works against a live PR.

#### Offline verification and exposed limitations

Run `corepack pnpm --filter @isaac2ingrid/steward eval:pr-intent:selftest`. The 20 Node assertions
pass with scripted faux choices, including negative observations. This is **not** a claim that
12 real-model cases passed. No additional real model calls were made. A standalone expanded
TypeScript check also exposed five existing SQL/routine-stub typing errors in `eval/harness.ts`,
which normal app typecheck excludes; that expanded check is not claimed clean. The legacy
harness was left unchanged rather than suppressing its diagnostics in this evaluator change.

- #10 exposes a current production limitation: `CI` plus `commit statuses` does not match the
  guard's explicit Checks wording, so it refuses a full-scope create. The fixture still expects
  full-scope creation; the test records `not_verified`, not a relabelled ask/pass. Fixing this
  requires a separately versioned production candidate and its routing gate.
- #11/#12: forcing a create call can currently create a watch despite explicit one-shot intent.
  The tool checks owner/target/scope, but does not enforce the one-shot boundary. The scorer marks
  these attempts `unexpected_persistence`, including attempts rejected for other reasons. Passing
  routing eval does not settle this authorization gap; do not deploy on that basis.
- #9 records the refused create plus every attempted worker/schedule fallback, even when the
  policy/schema blocks the fallback. Any such attempt is `wrong_tool`. Tool refusal plus prose
  alone is `refusal_observed` pending human review, not an automated claim of honest refusal.
- Prose mentioning `create_pr_watch` without a call is `not_verified`. Missing results are
  `incomplete`. One-shot readonly dispatch success verifies only the delegation boundary, not
  that a worker fetched live CI. Relay-only/text-only cases remain `not_verified` rather than
  evidence of a forbidden subscription.

Adding evaluator files/package scripts changes future declared inputs, so these checks cannot be
pooled with the old routing pair. Preserve the immutable snapshots for A or start a new cohort.
A real-model intent runner still needs explicit spending authorization, production-matched
profile/thinking, provenance/run receipts and bounded execution; the exported helper is not that
runner. Independent review and real-model intent acceptance remain outstanding.

## Reviewer / next decision

Executor self-review only; independent review pending. Candidate `60efdc8` meets ADR-0001 decision
14 on this recorded run; that evidence does not transfer to the boundary-fix successor. Neither
has been merged or deployed. Owner approval and focused natural-
language acceptance remain separate decisions. Do not reinterpret the red baseline as green or
claim a statistical improvement from one pair. The #10/#11/#12 fixes in experiment 0005 require
new validation before deployment; the old routing pass does not clear them. Full workspace
tests were not run.
