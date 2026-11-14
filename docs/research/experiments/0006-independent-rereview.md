## Review

Read-only review of the supplied `eaacc48..be11d13` diff and frozen target files. No commands, edits or paid calls executed.

### Fixed
The **six original exact repros are addressed**, with focused regressions in `apps/steward/eval/pr-review-regressions.test.ts`:
- Cancellation now checks consent (`src/llm/extension.ts:1249`).
- English negative creation verbs are aligned (`src/pr-watch-intent.ts:8`).
- Model-generated lookup matches no longer authorize PR ownership (`src/llm/extension.ts:1165–1166`).
- Chinese not-only scope and URL-derived scope are handled (`src/llm/extension.ts:1197–1201`).
- One-shot scoring rejects relays and multiple starts (`eval/pr-intent.ts:89–92`).
- The evaluator uses the real deterministic watch service (`eval/pr-intent.ts:130–148`).

However, the authorization classes remain incompletely protected.

### Finding: P1 — Creation still accepts explicit Chinese refusal and inventory questions
Location: `apps/steward/src/pr-watch-intent.ts:7–10`; mutation gate at `src/llm/extension.ts:1184`.

**Repro A:** Use fixture #1’s known PR association. Owner says:

> 不要持续关注 https://github.com/example/otto-demo/pull/12。

Model calls `create_pr_watch` for that Thread/URL with `checks-and-statuses`.

The negative alternatives omit `关注` and `检查`, while the positive expression accepts `持续关注`/`持续检查`. Consequently, creation proceeds despite explicit refusal.

**Repro B:** Existing fixture #4 says:

> 现在都在盯哪些 PR？

A forced `create_pr_watch({threadId:THREAD,evidenceMode:"checks-and-statuses",basis:"user_explicit"})` also proceeds: bare `盯` is treated as persistent consent, and the routed Thread supplies its unique known PR.

**Smallest fix:** Complete Chinese negative coverage and fail closed for inventory/informational questions. Add forced-create regressions asserting zero new watches—not merely correct model selection.

### Finding: P1 — Stopping a worker authorizes cancelling its PR watch
Location: `apps/steward/src/pr-watch-intent.ts:19–21`; cancellation at `src/llm/extension.ts:1257–1259`.

Use fixture #5’s active watches and routed Thread. Owner says:

> 停止 worker，继续盯这个 PR。

Model sequence:
1. `list_pr_watches({})`
2. `cancel_pr_watch({watchId:"pw_x",basis:"user_explicit"})`

The consent parser accepts unqualified `停止`, does not recognize `继续盯` as retention, and the unique contextual candidate permits cancellation. This stops monitoring despite the owner explicitly requesting its continuation.

**Smallest fix:** Bind stop/end/remove wording to the watch being cancelled; reject mixed stop-worker/retain-watch instructions. Add this forced-call regression.

### Finding: P2 — Workers can use a changed profile while retaining the original provenance
Location: `apps/steward/eval/run-pr-intent.ts:28,47–60,75`.

The parent reads the profile once, but each child rereads the original mutable `--config` path. Changing that external profile between cases changes subsequent workers’ model, endpoint or thinking configuration. The parent still records its original configuration and can report `inputStable:true`; the external JSON profile is not among the source hashes.

**Smallest fix:** Give workers a private frozen profile snapshot, or require their effective configuration receipts to match the parent’s. No evidence establishes that this happened during the current measurement.

### Correct
The new runner has explicit-profile configuration, no auth-store fallback, killable per-case execution, preserved incomplete results, and an all-cases-pass gate (`eval/run-pr-intent.ts:23–41,62,78–96`). The real service removes the previous interval-validation false green.

### Merge verdict: BLOCK
The two remaining P1s permit unauthorized mutations; they are **not** conservative acknowledgement-only refusals. Both repro sequences were sent to the parent for offline execution.

After correction, rerun these forced-call regressions and the required routing/focused acceptance on the new fixed source. A green 106-case routing run and 12-case intent run on `be11d13` would not resolve these uncovered authorization gaps.