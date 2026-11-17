# 0012: Real pi manual cold resume and first-strike stall recovery

Status: both scoped isolated checks passed. Owner authorized source push after successful checks.
No runtime implementation, production instance, agent installation or user configuration was changed.

## Scope and prerequisites

The owner authorized continuing the remaining manual/stall checks after experiment 0011, including
small real-provider usage, and subsequently asked to push the records if successful. Runtime/test
sources remained unchanged at `2558b60`, whose hosted CI had passed. Tests ran on Windows with
Node 24.19.0, installed pi 1.5.0 and `ctaigw/deepseek-v4.1-flash`.

Real components: ConnectorApp/Client, WorkerManager, CommandLog/EventLog, LocalStore/SQLite,
PiAdapter/PiProcess, installed CLI and provider. The steward endpoint was a loopback mock with
synthetic credentials; no real steward model, browser, production daemon/autostart or VPS was used.
As in 0011, sessions/state/cwd were isolated, startup was offline, automatic extensions/MCP/context
were disabled and only the explicitly supplied report extension could execute tools. Builtin
file/shell tools were excluded. No real project contents or credential stores were read directly.

## Manual cold resume

Evidence: `.verification/evidence/pi-recovery/380935a8-533f-4ce2-ac82-6a5f599c2224/receipt.json`.

- Seed task reported a random nonce and sum. A second user message was durably delivered, its
  command accepted/completed and the worker running, with no new report before the fault.
- Only the owned connector host PID was forcibly terminated. The pi child exited on pipe close;
  the unfinished session tail was lost, not retroactively completed by the old successful report.
- A new connector process reopened the same SQLite state and reported lost in hello. An explicit
  protocol `resume` command with reason `owner-manual` arrived before the unchanged 30-second
  automatic backoff. It performed one cold launch, retained the session ID/file, recalled the
  original nonce and completed through report.
- Replaying the exact previously accepted send command returned duplicate without adapter send.
  The resume budget had one record; the sole resumed event was manual. A further 35-second
  observation found no delayed automatic launch or duplicate report.
- Requested model/source and first observation were retained; latest observation advanced.
  The session had exactly two tool calls, both report. Fixture unchanged; scratch/processes removed.
  No safety ceiling fired. This is a command-level check, not owner-conversation/UI intent testing.

## First-strike stall recovery

Evidence: `.verification/evidence/pi-recovery/13cfea54-a6f6-4600-b68c-543a9401bc19/receipt.json`.

The fault was **induced OS suspension**, not a claim to have found a naturally occurring hang.
A fixed PowerShell/native helper checked the owned session PID, creation identity and parentage,
then held a kernel handle to that process. The managed pi launcher uses spawnSync, so the actual
SDK child was suspended rather than merely its waiting launcher. No unrelated process was targeted.

- A seed task completed. A second turn explicitly requested the **same original synthetic task**
  again. Its user message and accepted command were on disk, the worker running and no new report
  present when the actual SDK process was suspended.
- No fake clock, shortened timeout or synthetic CPU data was used. Defaults remained 480 seconds
  silence, 5% CPU threshold, 2.5-second sample gap and normal check cadence. An observation wrapper
  delegated to the real Windows sampleTreeCpu implementation.
- The two real samples had the same SDK-plus-launcher members and both totalled 593.7 ms CPU:
  delta zero. The manager's actual watchdog reclaimed the old process tree and performed exactly
  one stall respawn. Suspension-to-resumed event time: **514.458 seconds** (8 min 34.458 sec).
- The resumed event had reason stall/count 1, not connector_restart. The crash/manual-resume
  budget table stayed empty, confirming this was the watchdog path. The continued user prompt
  contained the original task plus the implementation's stall note.
- Same worker/session ID/file, model request/source and first observation; new latest observation.
  The real provider reported the requested result, yielding exactly two report calls including
  the seed. No other tools or fixture changes. A further 35 seconds found no extra recovery.
- The kernel handle closed without manually resuming the old SDK: it had been reclaimed by the
  watchdog. All actor/controller/pi processes exited and scratch was removed. No safety ceiling fired.

## Evidence, guards and billing

Each directory retains sanitized session/event traces, observer/control records, a synthetic
pre-recovery SQLite snapshot, receipt and frozen private driver/source hashes. Real provider
credentials were not exported; snapshots contain synthetic loopback pairing data only. Limits guarded unexpected launches/prompts/hot resumes and announced pi SDK
retries; none intervened to manufacture a passing result. Production watchdog thresholds and
manager budgets were not weakened.

Recorded completed-message estimates: manual **USD 0.001093812**, stall **USD 0.001566348**;
combined **USD 0.002660160**. Interrupted/frozen requests may lack usage, so this is not a total
bill or independent HTTP-attempt/routing audit. No failed paid attempt was retried until green.

Only experiment/verification documentation changed. Documentation diff, internal links, staged
content/secret-pattern checks and unchanged verified runtime inputs are the applicable source
checks; unrelated runtime suites were not rerun for prose or represented as fresh paid-test results.
The unrelated untracked `docs/plan/conductor-0.95-adoptions.md` is excluded from this commit.

## Remaining limits

These checks accept the stated report-only manual cold resume and successful first watchdog
respawn on one Windows/pi/provider profile. They do not accept hot/manual interruption semantics,
second-stall terminal failure, changed/new task requirements across a stall, arbitrary tool-child
orphans, write tasks, normal project/extension/MCP environments, power loss/torn storage, other
providers/platforms, real steward replanning or production supervisor recovery. In particular,
the stall case deliberately repeated the original task; it is not proof that a changed latest
brief takes precedence over the original replayed prompt. Existing scripted tests cover other
branches but do not constitute their real CLI acceptance. No further paid task or production
operation is authorized by adding this record.
