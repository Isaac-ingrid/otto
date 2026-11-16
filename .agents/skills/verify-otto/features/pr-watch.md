# PR-watch confirmation

## Sub-features

Conversational proposal, dedicated confirmation, ordinary-text refusal, expired/stale action refusal,
and a polling callback with fixed waiting evidence. Explicit Owner API create/cancel is a separate,
authenticated programmatic path, not a bypass bug (ADR-0019).

## How to get to it (user POV)

In an existing Thread, request continued following of a specific PR with an explicit evidence scope.
Inspect the server-rendered preview, then use its dedicated confirm button. Textual agreement cannot
apply the operation. Cancelling a watch does not stop a turn or worker.

## Driving it with Playwright

```sh
node scripts/verification/verify-otto.mjs run pr-watch
```

Scenarios 3/4 and 7 in `apps/steward/e2e/workspace-smoke.spec.ts` seed a Thread as a precondition,
then type the owner request in `#message-input` and click `#send-button`. They require a visible
`#feed button[data-action^="prwatch:"][data-action$=":confirm"]` and no active watch before
confirmation. Send ordinary agreement: still no watch. Click the dedicated button: one watch and
a confirmation response. Replay cannot apply again. An expired proposal cannot activate a watch.

The helper also runs `pr-watch-api.test.ts` and `pr-watch-approval.test.ts` on the Node host. These
are API/backend contracts, not browser cancellation acceptance. Live GitHub permissions, status
freshness, changed-head behavior, background push and browser cancellation are not proved here.

## Gotchas

The Thread seed is setup, not evidence that the owner created a Thread. `advanceApprovalClock`
is fault setup for expiry, not a production endpoint. Stale action replays use a contract helper;
the primary apply path remains the real button plus authenticated HTTP action. Fixed GitHub
waiting evidence isolates the production reader boundary; a real poll callback is exercised but no
GitHub request is made. Node/browser external requests fail the test even if swallowed by app code.
Never remove confirmation, substitute a setter or silently downgrade evidence scope to make a test pass.
