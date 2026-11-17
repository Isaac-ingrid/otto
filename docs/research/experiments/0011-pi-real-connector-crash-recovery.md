# 0011: Real pi recovery after an in-flight connector-process crash

Status: scoped isolated acceptance passed. No runtime implementation or production change.

## Authorization and scope

After CI for `2558b60` passed, the owner authorized one small real-pi recovery experiment using
synthetic data and limited provider usage. The test used installed pi 1.5.0, Node 24.19.0 and
`ctaigw/deepseek-v4.1-flash`. It did not install an agent, change keys/configuration, access a
real project, deploy, commit or push. The unrelated untracked
`docs/plan/conductor-0.95-adoptions.md` was left untouched.

Real implementation: ConnectorApp, ConnectorClient, CommandLog, EventLog, WorkerManager,
LocalStore/SQLite, PiAdapter/PiProcess, installed pi and its configured provider. Two separate
owned Node processes hosted the connector composition, not the installed production daemon.
A loopback mock steward authenticated with synthetic credentials, sent commands and acknowledged
frames. There was no real cloud steward/model, browser, production pairing or VPS in this run.

Pi ran with offline startup, no automatic extensions/MCP/skills/templates/context/themes,
thinking off and an isolated session directory. The adapter supplied its explicit report
extension; builtin file/shell tools were excluded, leaving report only. A harmless fixture in
a temporary directory stayed unchanged. Provider authentication remained local to pi; no
credential store was read directly or copied into evidence.

## Fault and observations

1. An initial synthetic task remembered a random nonce and `17+25=42`, reporting the answer.
2. A second task requested the original nonce after any restart. Before injecting the fault,
   the command was durably `done` (delivery accepted), the worker was `running`, its new user
   message was persisted and no second-task report existed. The old successful report was not
   accepted as completion of the new task.
3. The driver forcibly terminated **only its own connector host PID**, not the process tree.
   The real pi child then exited when its parent pipes closed; no forced pi cleanup was needed.
   The retained session tail classified the current run as `lost`.
4. A new Node connector process reopened the same SQLite database and ran real
   `reconcileStartup`. Its first hello exposed the worker as lost. The unchanged production
   30-second backoff scheduled one automatic cold resume; lost-to-resumed event time was
   32.122 seconds, including pi startup.
5. Replaying the exact accepted command ID/payload produced a duplicate acknowledgement,
   not a new prompt. The restarted adapter observed one worker launch and zero send/hot-resume
   calls. The resume used the same worker ID, session ID and session file, recalled the original
   nonce and produced the expected recovered report.
6. Requested model/source and first-launch observation were retained. Latest CLI state
   observation advanced and matched the request. This remains CLI identity evidence, not an
   audit of upstream routing or model weights.
7. A further 35-second observation found one automatic-resume record total and no extra launch.
   The complete retained session had exactly two tool calls, both report. All owned actor/pi
   processes exited and the temporary fixture/state/session directory was removed.

Observer taps delegated to unchanged implementation methods. Safety ceilings were armed for
additional launches/redelivery/hot resumes and announced pi SDK retries; none fired. They did
not suppress an action to produce a passing result. The default manager backoff/retry budget
was not weakened or shortened.

## Evidence and cost limits

Evidence directory:
`.verification/evidence/pi-recovery/88782c18-b28e-47e7-b465-5dac2d3e88ef/`.
It retains receipt/source hashes, observer messages, redacted event/session records and an
isolated pre-restart SQLite snapshot containing only synthetic pairing/task data. Private
ignored drivers are under `.verification/evidence/pi-recovery/`.

Completed-message pi cost estimate: **USD 0.001167612**. This is not an independently verified
bill; the interrupted request may not have returned usage. There was no independent HTTP-attempt
count or proof that the interrupted prompt had already reached the provider. The injected cut
was after durable user delivery and before its report, not an asserted mid-token-stream cut.

Validation was direct assertions against real rows, retained session/tool calls, wire events
and process lifecycle, not a screenshot or a scripted provider response. CI and prior finite
TLC checks are prerequisites recorded elsewhere, not fresh results from this experiment.
No runtime code changed, so this run did not rerun unrelated suites or claim new model coverage.

## Remaining scope

This accepts one report-only **automatic cold resume after a connector host crash** on this
Windows/pi/provider profile. It does not accept power loss/torn storage, a pi-only crash,
manual resume, stall recovery, arbitrary tool-child orphan cleanup, writes, real repository
work, normal user extension/MCP environments, live steward replanning, other models/platforms
or the installed daemon/autostart supervisor path. Consumer subscription adapters remain out
of scope. Subsequent [experiment 0012](0012-pi-manual-and-stall-recovery.md) separately covers
limited manual cold resume and first-strike stall recovery. No further paid call, source push or
production operation is authorized by adding this record.
