# Experiment 0003: Least-privilege Commit-status Follow-up

Date: 2026-11-13. Parent: `d25e65a`. Status: implemented; live transition acceptance pending.

## Problem and scope

The owner configured a selected-repository fine-grained PAT for `otto-write-lab`. Its current
permission UI has no Checks option. Server-side read-only verification returned PR 200, combined
commit statuses 200 and check runs 403. The original token setup instructions were incorrect.
Never copy the development machine's broad OAuth token onto the server to hide this mismatch.

Add an explicit immutable `evidenceMode` to each commission. Existing rows/default requests stay
`checks-and-statuses`; denied Checks access remains unavailable evidence. New owner requests can
choose `statuses-only`, which never calls check-runs and never labels its success as full CI.
The narrower scope appears in API state, timeline metadata, failure/success and expiry notices.
No model-facing tools, routing gates, credential scopes or external write capabilities were added.

## Evaluator

Typecheck passed. 42 tests passed on Node and 42 on workerd, covering evidence/service/API and
schema regressions. New cases cover explicit limited scope, no automatic downgrade after 403,
zero/incomplete statuses, changed head, immutable replay scope and limited notice wording.

## Live acceptance plan

Use existing PR #1 and its existing Thread. A named synthetic commit-status context, clearly
labeled as a fixture rather than CI, will be written using the owner's existing local GitHub CLI
session. The deployed steward receives only the separate read-only token. No repository files,
default branch, workflows or GitHub Actions minutes are involved.

Create a new `statuses-only` watch via the Owner API, observe failure once, verify an unchanged
observation does not duplicate it, restart and verify recovery, then publish success and verify a
head-bound terminal notice. Separately create/cancel a watch and verify no later observation.
Leave the fixture status successful. Record real observations separately from this plan; do not
claim that a synthetic status proves actual CI or changed-head behavior in production.

Independent review and paid routing-noise baseline remain pending. No secrets belong in records.
