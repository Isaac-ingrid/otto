# Experiment 0003: Least-privilege Commit-status Follow-up

Date: 2026-11-13. Parent: `d25e65a`. Candidate/deployed program: `9fc76c7`.
Status: limited-scope live acceptance passed; independent review pending.

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

## Live outcomes (2026-11-13)

The plan above was executed on the Node VPS using the existing lab PR #1 and its Thread, with
`evidenceMode=statuses-only`. The fixture context was `otto/watch-smoke-9fc76c7`.

- Server token reads: PR 200, commit statuses 200, check runs 403. No credential scope was widened.
- Deployed `9fc76c7`; migration `035_pr_watch_evidence_mode` applied. Previous program and a verified
  SQLite snapshot are retained under `/opt/otto/releases/9fc76c7/previous/`.
- Real cron observed synthetic failure, left the watch active, and sent one Thread-linked notice.
- After an actual `systemctl restart otto`, cron observed unchanged failure again: still one notice.
- Publishing synthetic success on the same head produced a second notice and completed the watch.
- A separate watch cancelled before observation retained null `checkedAt` and emitted no notice,
  including while the scheduler processed the later success transition.
- Both result notices explicitly said Checks/Actions were unverified. Both outbound rows reached
  local `sent`; this does not establish phone push receipt.
- No test watches remain active; no new steward runs appeared during acceptance. The GitHub
  fixture status was left successful. Repository files/default branch were unchanged.
- Deployment health check passed. Existing offsite-backup-disabled warning remains.

Private server receipt: `/opt/otto/releases/9fc76c7/acceptance.json` (no tokens). These results
validate a synthetic commit-status transition, persistence and dedupe, **not actual CI**, branch
protection, changed-head behavior in production, or end-to-end phone notifications.

Independent review and paid routing-noise baseline remain pending. No secrets belong in records.
