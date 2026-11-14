# Experiment 0007: Bound Owner Confirmation and Frozen Evaluation

Date: 2026-11-14. Parent: `1bfe690`; production predecessor: rejected `be11d13`.
Status: two-phase candidate implemented; deterministic checks passed; independent/real-model gates pending.
Not merged or deployed.

Owner authorization: fix boundaries/configuration, review and paid validation; deploy only if
appropriate after all gates pass. Owner is currently not using Otto; this does not waive safety.

## Director decision

Repeated lexical patches cannot be the mutation authority. Adopt
[ADR-0019](../../adr/0019-pr-watch-owner-confirmation.md): model tools only propose, an exact
server-rendered owner decision applies the watch change. Current NLP guards only filter proposals.
Existing Owner API commands and read-only polling are unchanged.

Migration 036 stores immutable, ten-minute proposals keyed by owner source turn, plus action
receipts. Preview includes operation/PR/Thread/mode/interval/lifetime. Generic ask actions and
mismatched messages cannot apply it; owner confirmation causes zero model runs. Mutation and
proposal/question resolution share the real database transaction. A transaction-free backend
adapter avoids workerd's prohibition on nested transactions. Replays do not renew TTL or resurrect
cancelled watches. Reuse preserves the existing expiry; changed targets refuse confirmation.

## Prospective measurement change (before any paid v3 run)

Keep the 12 utterances and expected logical outcomes. Add an independent, predefined owner script:
create cases 1/2/3/10 approve only the correct Thread/URL/mode, 900-second interval and 1440-minute
lifetime; case 5 approves only `pw_x`'s initial identity; case 9 approves the correct proposal then
hits the injected backend refusal. Other cases grant nothing. This script is not inferred from
model outputs, tool choices or replies. Wrong seven-day/default overrides remain unapproved.

Scoring version 3 measures proposal + separate owner decision. A proposal alone is pending, not
success. The failure in case 9 is now a deterministic action response, not a second model turn;
its truthful failure/no-fallback requirement is unchanged, but v2's tool-error sequence is not the
new protocol. Original v2 scores/results are retained, not reinterpreted. Routing labels, score()
and thresholds remain unchanged. Routing/memory context adapters expose the proposal interface
but cannot grant owner confirmation. This is a new input cohort.

The CLI freezes a private profile and credential/header environment once per run. Each child
attests safe requested/effective configuration, checked against the parent. Source-profile edits
must not change later workers. This addresses experiment 0006's P2 instead of assuming operator
file discipline. Temporary snapshots contain env references, not credential literals, and are
removed on normal completion. Results are atomically replaced after each case.

## Validation and publication

Passed before freezing the candidate: app typecheck; routing selftest; all 10 deterministic memory
cases; 34 intent/old-adversarial/CLI assertions including external-profile edits during a run;
124 selected Node tests and the same 124 on workerd (including action/workspace regressions).
The approval backend also tests rollback after a watch insertion fails, relative expiry replay,
stale targets, declined/expired cards, fake ordinary ask actions, wrong message binding, plain
quote replies preserving unrelated questions, browser CSRF/session flow and stale UI taps.

Independent review, full app suite and real-model routing/intent validation remain pending.
Do not treat simulated owner clicks as real UI acceptance. Preserve failing artifacts and never
relax expectations to accommodate measured output. Production remains `9fc76c7` until an accepted
candidate is backed up and deployed; model credentials must stay on the VPS.
