## Review

Reviewed the supplied cumulative diff and target files confirmed identical to `eaacc48`. No edits or commands executed.

### Correct
- Creation binds authorization to owner-authored inbound text, not tool-supplied provenance (`apps/steward/src/llm/extension.ts:1152–1157`; `apps/steward/src/steward.ts:950–956`).
- Intent checks precede existing-watch reuse and replay; replay preserves expiry and does not resurrect cancelled watches (`extension.ts:1183,1207–1226`).
- Same-turn worker/schedule exclusion works in both directions (`extension.ts:1341–1348`).
- Transcript observation retains rejected attempts and rejects missing/duplicate result boundaries (`apps/steward/eval/pr-intent.ts:57–78`).

### Findings — P1

**1. Cancellation requires an identifiable target but no cancellation intent.**
Location: `apps/steward/src/llm/extension.ts:1243–1255`.

With one active watch in the routed Thread, owner input `现在都在盯哪些 PR？` followed by model calls:
1. `list_pr_watches({})`
2. `cancel_pr_watch({watchId:"pw_x",basis:"user_explicit"})`

cancels `pw_x`. Even `不要取消 pw_x` authorizes cancellation through the raw ID inclusion check. Owner identity and target selection do not prove permission to cancel.

Smallest fix: require explicit, non-negated cancellation intent before mutation; retain existing ambiguity checks. Add forced-call tests for listing, retaining and negating cancellation.

**2. Explicit English prohibitions can authorize watch creation.**
Location: `apps/steward/src/pr-watch-intent.ts:7–10`.

Owner input:
`Do not follow https://github.com/example/otto-demo/pull/12.`

The negative regex recognizes `follow-up`, not `follow`; the positive regex recognizes `follow`. With a routed Thread and known association, `create_pr_watch(...checks-and-statuses...)` consequently creates persistent work. `Do not track ...` has the same problem: negative recognition covers `tracking`, while positive recognition covers `track`.

Smallest fix: align negative verb forms with every positive verb form and add tool-boundary regressions proving zero writes.

**3. Model-generated lookup text becomes owner authorization for an ambiguous Thread.**
Location: `apps/steward/src/llm/extension.ts:206–217,1164–1165,1194`.

Use existing intent fixture #8: the PR belongs to two Threads and the owner names neither. Model sequence:
1. `find_threads({query:"t_gw_refactor"})`
2. `create_pr_watch({threadId:"t_gw_refactor",url:PR,evidenceMode:"checks-and-statuses",basis:"user_explicit"})`

The invented query produces an explicit match, which `explicitPrThread` trusts. Creation then bypasses the cross-Thread ambiguity check without asking the owner.

Smallest fix: derive PR-watch Thread authorization from routed metadata or actual owner text; do not trust an explicit match obtained from arbitrary model query text.

**4. Chinese “not only statuses” is inverted into statuses-only consent.**
Location: `apps/steward/src/llm/extension.ts:1198–1201`.

Owner input:
`持续盯住 https://github.com/example/otto-demo/pull/12，不仅看 commit statuses，也要看 CI。`

`limited` matches `仅看 commit statuses`, but `negatedLimit` does not recognize `不仅` or `不只`. A model-selected `statuses-only` watch is accepted, while the requested full evidence mode is refused.

Smallest fix: recognize these negated limitations before computing scope; test both rejected limited-mode and accepted full-mode calls.

### Findings — P2

**5. One-shot scoring passes additional write-capable worker instructions.**
Location: `apps/steward/eval/pr-intent.ts:88–92`.

For fixture #11, issue one successful readonly `start_worker`, followed by:
`send_to_worker({workerId:"w_gw_refactor",text:"Keep polling this PR every minute",intent:"after",basis:"user_explicit"})`.

The seeded worker is write-mode (`eval/harness.ts:53–54`), and the harness records both dispatches. Nevertheless, scoring returns `pass`: it allows arbitrary `send_to_worker` calls and examines readonly mode only on `start_worker`.

Smallest fix: reject additional worker actions for the currently defined single readonly-delegation acceptance path, or explicitly validate a safe alternative path.

**6. The local create stub can report success for production-invalid watches.**
Location: `apps/steward/eval/pr-intent.ts:139–147`.

Fixture #1 with otherwise correct create arguments plus `intervalSeconds:1` produces an active local watch and `pass`. Production rejects that interval (`apps/steward/src/pr-watch.ts:51`). The tool schema itself does not enforce the documented bounds.

Smallest fix: enforce the production input constraints in the overlay—or share deterministic validation—and add a negative scoring regression.

### Readiness and missing validation
- **Merge verdict: BLOCK.** The production authorization findings need correction.
- These are unauthorized mutations/scope changes, not the documented conservative refusal of acknowledgement-only replies.
- Existing focused fixtures miss these sequences. Add the regressions above, then rerun deterministic intent/tool tests and evaluator selftests.
- ADR-0001 decision 14 requires a fresh complete routing gate for the corrected candidate. The earlier `60efdc8` result does not validate `eaacc48` or subsequent fixes.
- Real-model focused acceptance, routing results and full-suite execution were not independently established in this offline lane.