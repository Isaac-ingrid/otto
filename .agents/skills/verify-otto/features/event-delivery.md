# Durable event delivery and recovery

## Sub-features

Progress/results survive reconnect, duplicate events reduce once, inbox persistence precedes ack,
and an oversized result produces an explicit failure instead of an endless reconnect loop or false success.

## How to get to it (user POV)

Normally an owner starts work in a Thread on an online machine and sees progress, result or a decision.
For this pilot the coding agent and the joined deployment are intentionally NOT started: the helper
exercises the transport contracts directly in isolated databases and loopback sockets. Do not present
this as a full user dispatch journey or live machine acceptance.

## Driving it with transport tests and TLC

```sh
node scripts/verification/verify-otto.mjs run event-delivery
```

The helper runs:

- Connector `client.test.ts` and `events.test.ts`: real implementation, fake socket unit checks and
  a real socket against a payload-limited mock steward; local archive, transaction rollback,
  continuing seqs, replay and cumulative ack are asserted.
- Steward `ledger.test.ts` and `event-ack-contract.test.ts`: real SQLite/reducer/message handler.
  A forced inbox INSERT error must produce no ack; retry persists and applies once. An oversized
  report's failure followed by settlement must not become a green successful report.
- `formal/EventDelivery.tla`: finite baseline plus ack-before-persist and poison-event negative controls.

Success requires all code anchors, the model baseline and the expected counterexamples. Read
`formal/README.md` for exact mappings, weak-fairness assumptions and excluded behaviors. Raw logs,
config/model snapshots and traces remain in the printed evidence directory after cleanup.

## Gotchas

The model has one worker, two events and one environmental crash; it does not prove arbitrary stream
lengths or TypeScript refinement. Tests add real byte counts/SQL/sockets that the abstract model omits.
The sequence grid skill covers different, single-sweep decisions; do not replace it with this model.
No real machine is paired and no pi/Claude process runs. Windows has unrelated POSIX permission and
process-cleanup debt; preserve any actual failure instead of calling the whole connector suite green.
Code/model/oracle changes need separate rationale. A parser error is never a successful negative control.
