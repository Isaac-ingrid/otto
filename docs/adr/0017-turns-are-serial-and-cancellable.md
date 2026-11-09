# ADR-0017: A turn is durable, serial and cancellable

Status: accepted. Settles issue #2 (P4 item 3, "async start/stop with speculative execution") and
answers it with a narrower decision than the title suggests.

Context: the root pi session is the steward's conversation, and the steward's memory *is* that
transcript. Today a turn — one `sh_run` row, one input to the root session — runs alone: a second
owner message submitted while the first turn is in flight is queued by pi as a follow-up
(`whenBusy: "followUp"`) and starts the moment the placed run ends. The cost of that serialisation
is latency on the second message; the benefit is one coherent transcript, one dispatch decision at
a time, and a settle path (`pollRuns` → `settleRun`, steward.md §6.3) that has exactly one reply to
account for. Issue #2 asked to start the next turn before the previous one settles, with clean
cancellation for a speculative turn that loses the race.

## Decisions

1. **The root conversation stays serial. No second session, no fork.** `sessions.fork()` exists and
   would let a second turn run concurrently, but a fork's transcript does not come back: the root
   would answer message 2 without message 1's exchange, and that exchange would never enter the
   conversation the next turn reads. Speculating there trades the steward's memory for a few
   seconds, doubles the chance of two turns dispatching the same work, and splits one day's budget
   across two runs that cannot see each other. Rejected. What the issue calls "speculation" is
   delivered at the boundary instead: a turn is durable *before* it can run (decision 2) and can be
   withdrawn *before* it acts (decision 3). Nothing is ever executed twice, which is the property
   acceptance 2 was protecting.
2. **A turn is durable before it runs.** `submitUserMessage` writes the `sh_run` row first and then
   submits to pi with the row's `operationId`; a crash in either window is repaired by the settler
   (`not_found` ⇒ resubmit the same operation id, steward.md §11). The queued turn therefore
   survives eviction, and the same owner message is one turn for ever — there is no "speculative"
   copy to reconcile.
3. **Stop is a first-class owner action.** `POST /app/api/turn/stop` (workspace session + CSRF, like
   every other mutation) stops the live turn-set:

   - not busy ⇒ every open run is queued, and each is withdrawn with `abort(operationId)`;
   - busy ⇒ `session.abort()`, which withdraws the queued inputs and marks the placed run
     (pi's cooperative abort; the call resolves once the conversation is idle).

   pi settles a withdrawn or aborted input as `unanswered` with reason `aborted`. The settler maps
   that to `sh_run.status = 'cancelled'` — **not** to the failure path: a cancelled owner turn gets
   one deterministic line ("已停止这次回答"), no failure notice, no dispatch verification, and it
   consumes neither the pending memory relay nor the once-a-day budget note (both must ride a reply
   that actually says something). A cancelled wake run is recorded and never retried: its
   deterministic notification already went out, which is exactly the deal §12 already makes for a
   budget-skipped wake.
4. **Cancellation never reaches a worker.** Workers are processes on the owner's machines, started
   over the connector; the abort is conversation-scoped inside the Durable Object. A stopped turn
   leaves every dispatched worker running, and the confirmation says so. Stopping a worker stays
   `interrupt_worker`'s job (ADR-0011's mechanical controls).
5. **A model switch is still refused while a run is placed** (`model_busy`, 409): a run must not
   change provider in the middle of its transcript. A *queued* turn does not block a switch — it
   runs on whatever model is in force when it is placed, because its text is owner intent, not a
   binding to the old model. This is why no queued turn is "superseded by a model change": it is
   not thrown away, it just runs later on the new model.
6. **Ordering and identity are pinned, not assumed.** Turns are written in `createdAt` order, placed
   in that order by the harness, and each reply is keyed `reply:<operationId>` and carries the run's
   `replyTo` msgId. Two owner messages in quick succession therefore produce two replies, in
   submission order, each with its own msgId — pinned by `test/turn-stop.test.ts` rather than
   promised in prose.
7. **The budget gate is untouched.** `stop` is an owner path, never a wake: `skippedWakes` and the
   owner-message/`done`-report exemptions behave exactly as §12 describes, and tokens a stopped run
   already spent stay spent, because `pi.usage` is the truth and the counter is its growth.

## Constraints this keeps

Cancellation is one synchronous ledger write plus one pi `abort()`; there is no new queue, no new
timer, and no new durable state beyond the `cancelled` status value (`sh_run.status` is TEXT, so no
migration). `pollRuns` remains the only settler, and `settleRun` still leaves exactly one row per
turn — a stop can delay a turn's end, never duplicate one. The workspace's stop control is drawn
from the snapshot's existing `busy` flag, so no protocol frame is added.

## Consequences

- The workspace shows a stop control on the "Otto is working" row while a turn is live; it is the
  only way to end a reply early. Everything else about turn lifecycle (merge windows, wake drain,
  the 90-second question fallback) is unchanged.
- A "stop" typed into the conversation is not a command yet: the message would have to wait for the
  run it wants to stop. A deterministic whole-message matcher (the `/花费` pattern in budget.ts)
  could carry it later; the workspace button is the guaranteed path.
- Parallel turns stay rejected for as long as the root transcript is the steward's memory. If a
  future design forks turns, the three invariants above still have to hold: one run per intent, a
  cancelled turn never resubmitted, and a cancelled turn never consuming the reply-side relays.
