# Event-delivery verification pilot

This is a **bounded design check**, not a proof that Otto's TypeScript implements the model.
The pilot complements, rather than replaces, tests and the existing `verify-sweep-grid` skill.
It changes no runtime behavior or product authorization policy.

## Run

From the repository root (Node >=22.18, Java 17+):

```sh
node scripts/verification/setup-tla.mjs
node --test scripts/verification/verification.test.mjs
node scripts/verification/run-tla.mjs
```

On Windows x64 without Java, explicit `setup-tla.mjs --java` downloads a portable Temurin JRE
under `.cache/verification/java/`. Nothing is installed globally and PATH is not changed.
Elsewhere supply a Java 17+ installation using `OTTO_JAVA` (executable) or `JAVA_HOME`.
Public downloads are explicit setup, separate from offline checking; their URLs and SHA-256
pins are in `scripts/verification/toolchain.json`. A changed release asset fails closed on hash
mismatch. Never replace a pin just to bypass a mismatch. Review a tool upgrade separately.

The runner checks the baseline **and** two deliberately faulty configurations. Expected results:

| Configuration | Required outcome | Meaning |
| --- | --- | --- |
| `EventDelivery.cfg` | Exit 0, complete state exploration, safety and `AllResolved` pass | Correct finite model |
| `AckBeforePersist.cfg` | Exit 12, `AckAfterPersist` counterexample | The checker detects ack-before-durable-write |
| `PoisonEvent.cfg` | Exit 13, `AllResolved` counterexample | Sending the same oversized event repeatedly can never complete |

`CHECK_DEADLOCK FALSE` permits a completed finite stream to stutter; `AllResolved` still rejects
an unfinished dead end. This is not permission to disable progress checks.

A parse error, timeout, missing Java, another invariant failure, or an unexpectedly green negative
control **fails the runner**. A selftest of result parsing is not a substitute for executing TLC.
The two Fault values are test mutations, not product feature flags or alternate accepted policies.

Each run retains logs, exact model/config snapshots, generated counterexample files and
`summary.json` in a unique `.verification/evidence/formal-*/` directory. TLC state scratch is
removed; evidence survives. No production environment, credential store or model API is read.

## Scope and assumptions

The normal configuration has **one worker, two events and at most one environmental crash**.
Each event nondeterministically fits or exceeds the wire cap. Byte counts, JSON encoding, batches,
worker execution and databases are abstracted; TypeScript tests exercise their implementation.
Wire messages and acks may be lost on disconnect; duplicate sends and out-of-order receives are
allowed (more permissive than one WebSocket). Durable inboxes, seqs, processing receipts and local
quarantine survive a crash. A quarantine transaction either archives AND replaces, or does nothing.
The replacement keeps the original identity and is an explicit failure, never a successful report.

`AllResolved` requires weak fairness for production, quarantine, transport, ack advancement and
receipt, processing and reconnect actions. With a finite crash budget, connectivity eventually
stabilizes and storage actions remain available. It does **not** promise progress with endless
outages, disk failure, revoked credentials or permanent resource exhaustion. The poison mutation's
protocol-induced rejections are intentionally not charged to the environmental crash budget.

Not covered: command execution/ambiguous commands; multiple workers or connectors; authentication;
log eviction/events_gap; changing limits mid-stream; archive retention; timers; exact byte sizing;
notification rendering; arbitrary TypeScript interleavings. Finite TLC exploration is not a theorem
for all stream lengths, and no refinement mapping has been proved. Do not describe it as one.

## Model → code → regression map

| Property / action | Implementation | Executable anchor |
| --- | --- | --- |
| `Produce`, durable seq / `NoForgottenUnacked` | `apps/connector/src/events.ts`: append, pending, truncate | `test/events.test.ts`: persisted seqs, restart, ack and replay |
| `Quarantine`, `ArchiveBeforeFailure` | `EventLog.quarantine`, `client.ts` flush; local `event_oversize` | archive/restart/rollback tests in `events.test.ts`; oversized persisted event in `client.test.ts` |
| `Send`, `RejectOversized` negative control | `client.ts` flush UTF-8 accounting; Node host maxPayload | multibyte frame test; real payload-limited socket/reconnect test in `events.test.ts` |
| `Receive`, `AdvanceAck`, `AckAfterPersist` | `apps/steward/src/connector-protocol.ts`: handleEvents, inbox before ack | `apps/steward/test/event-ack-contract.test.ts`: inbox INSERT failure produces no ack, then replay succeeds |
| `Process`, `AtMostOnce` | `ledger.ts`: durable inbox reduction / processedUpTo | ack contract retry/dedup; `ledger.test.ts`: re-delivered batches apply once |
| `NoFalseSuccess` (transport meaning only) | bounded broken notice instead of original report | `ledger.test.ts`: oversized-report failure followed by reported settlement still leaves a failure decision, not a green report |

These tests execute real TypeScript and SQLite, not a second copy of the model. The ack anchor
injects a database failure through the real message handler but uses a minimal connection double;
it is not an end-to-end authentication or browser proof. The connector transport test uses a mock
steward over a real socket; it is not a full steward + connector + coding-agent deployment.

## Counterexample → regression loop

1. Preserve the config and raw trace. Locate the **first** invalid transition.
2. Map that transition to the row above, not to a conveniently similar test.
3. Add a code regression that fails on the bad behavior and passes on the legitimate counterpart.
4. Fix code or independently approved policy. Re-run code anchors, baseline and negative controls.
5. Record the source hashes, bound, tool versions, assumptions and unverified layers.

The ack negative control reaches `PrematureAck` while the durable inbox is still empty. The new
INSERT-failure anchor checks that this transition is unavailable in code. The poison control has a
cycle through Send → RejectOversized → Reconnect; the real socket regression checks that oversized
events now become bounded, archived failure notices and cumulative ack progresses after reconnect.
These are controlled reconstructions of fault classes, not claims that this pilot discovered a new
production incident.

For changes to `client.ts`, `events.ts`, `store.ts`, `connector-protocol.ts` or ledger event reduction,
run both layers. Do not fix a failure by lowering bounds, removing an invariant, strengthening
fairness or weakening an oracle. Changes to the contract/model are separate owner-reviewed changes.

## Evidence and freshness

The pilot was built on `e45cc39` **plus an already-dirty working tree containing review fixes**.
A commit alone does not identify the tested source. The combined `verify-otto` receipt hashes the
declared app/test/model/skill inputs before and after, records dirty state and rejects changed
inputs. This is traceability, not signed evidence against deliberate forgery; edits reverted during
a run and remote tool changes are not detected by local before/after hashes.

The path-filtered `Event delivery model` workflow runs the same checks on PRs and manual dispatch.
It needs no npm install, personal secrets or paid model. This file does not make that job a required
branch-protection check, and local success does not establish that remote CI ran.
