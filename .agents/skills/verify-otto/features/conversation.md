# Conversation and stopping a turn

## Sub-features

Password sign-in, send/reply, stop an in-flight answer, reload/reconnect without duplicate runs.
Owner API message submission is an alternate entry point covered by `owner-api-boundaries.test.ts`,
not by this browser journey. Passkeys and production sign-in are not accepted here.

## How to get to it (user POV)

Open the fixture's own loopback URL, enter its test password, and arrive at `/app`. The everyday
conversation is in the workspace; the Stop control belongs to the running answer, not a worker.

## Driving it with Playwright

```sh
node scripts/verification/verify-otto.mjs run conversation
```

The existing `apps/steward/e2e/workspace-smoke.spec.ts` scenarios 1, 2 and 5 drive:

1. Fill `#login-password`, click `#password-signin`; require `#workspace` and live `#connection`.
2. Fill `#message-input`, click `#send-button`; assert user text and scripted reply in `#feed`.
3. While a reply streams, click `button[data-action="stop-turn"]`; require the stop notice and
   disappearance of the active stop control.
4. Reload and reconnect; require retained messages and exactly one model run for the original turn.

The public workspace snapshot and final screenshots are captured before fixture teardown; traces
retain the actions. Passing means the reply actually arrived, stop converged, and the run count did
not grow on reload/reconnect, not merely that the page returned HTTP 200.

## Gotchas

The model response is scripted; this proves transport/UI behavior, not model quality. No real agent
is dispatched, so this does not prove worker cancellation (which is intentionally a different action).
Test authentication is generated inside an empty fixture; never reuse a production password. The
existing reconnect scenario is a browser transport smoke, not a full process-restart acceptance test.
If readiness, auth or seed setup fails, report it; do not bypass login or weaken selectors to pass.
