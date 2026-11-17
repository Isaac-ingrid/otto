# Experiment 0009: installed pi model selection and cold-session continuation

Status: scoped pi-only production pilot passed after owner approval; independent review and broader CLI/recovery acceptance remain pending. No npm publication; source commit/push subsequently authorized.
Director/owner: repository owner authorized the assistant to run a small real pi read-only test.
Lane: model request/observation and cold continuation, not coding quality. Date: 2026-11-17.

## Direction (outer loop, initial isolated experiments)

- Hypothesis: a frozen local-agent request survives process termination, reopening connector
  SQLite and rebuilding the manager/adapter, while the same real pi session remains usable.
- Initial allowed operations: two tiny synthetic report-only tasks through installed pi. That
  authorization excluded deployment, publishing, push, real-project tasks and Claude installation.
  The dirty implementation candidate is based on `9ac4510`; later upstream/error-chain tests
  and the pi-only production pilot have separate owner authorizations recorded below.
- Profile: installed pi 1.5.0; `ctaigw/deepseek-v4.1-flash`, the existing configured default.
  Local discovery listed nine models, only one in this provider. No alternate provider/model
  was chosen and no credential was printed or copied into the steward.
- Isolation: OS temporary working directory outside this checkout, synthetic inline arithmetic
  and a random nonce; separate session directory and connector state. Startup network operations,
  auto extensions, MCP, skills, prompt templates and context files disabled. Only Otto's explicit
  extension loaded. CLI allowlist/excludes leave `report`, with file/shell tools excluded.
- Stop conditions: no automatic retry after a failed real task; refuse to claim release readiness
  for missing CLI/platform scenarios. Provider fees were allowed for these two small tasks only.

## Candidate lineage (inner loop)

All local evidence is under `.verification/evidence/pi-real-model-selection/` (ignored).

| Candidate | Observation | Attribution / next step |
| --- | --- | --- |
| `discovery.json` | `get_state` and `get_available_models` succeeded; zero task prompts | Local registry/config evidence, not provider existence validation |
| `acceptance.log`, `live-8bf845b8-…/receipt.json` | `spawn pi ENOENT`; zero tasks | Driver placed flags before Windows shim resolution; driver corrected, runtime source untouched |
| `acceptance-v2.log`, `live-189fcaae-…/receipt.json` | `get_active_tools` unsupported; zero tasks | pi 1.5.0 RPC does not expose that command; tool policy inspected in installed SDK filtering instead |
| `acceptance-v3.log`, `acceptance-v4.log` | Expected local rejection of nonexistent custom-provider ID did not occur; zero tasks | Failed preflight retained, NOT reclassified as a passing negative control |
| `valid-start-resume.log`, `valid-3e7b5d08-22bb-41cf-b741-0231acca626a/receipt.json` | Two real positive tasks passed | Separate, explicitly narrower experiment; does not waive the failed unknown-ID requirement |

The custom provider constructs a local model configuration for arbitrary IDs, and `get_state`
returns that same ID. This is **not** evidence that pi fell back to the previous model, nor proof
that the upstream provider supports the ID. No invalid-model prompt/provider request was made
during those local preflights. A later, separately authorized direct upstream probe is below.
The adapter's known-mismatch guard still rejects a differing observed ID before prompt delivery
(as covered by the fake CLI test); it cannot validate upstream existence from matching local state.

## Evaluator

Commands were explicit Node drivers using `--experimental-transform-types` over the actual
connector source. The positive driver called `WorkerManager.startWorker` with an exact model and
`modelSource: task-default`, then closed the process and store, rebuilt both manager and adapter,
and called the cold `send` path. No in-memory `StartSpec` could provide the second launch's model.

Positive assertions:

1. Real task used the report extension and returned the expected synthetic nonce/sum.
2. Persisted requested model and `get_state` observation matched the selected provider/id.
3. After reopening SQLite, cold send retained the same pi session id and file, recalled the
   original nonce (not repeated in the second prompt), and completed a structured report.
4. Latest CLI observation updated; first-launch observation remained unchanged.
5. Fixture was unchanged, the owned worker stopped and the external temporary tree was removed.

The progress stream is throttled and contained **no** tool-name records. It is not sufficient
execution evidence. `inspect-retained-session.mjs` subsequently verified the complete retained
session/hash: exactly two `report` tool calls and two corresponding results, and no other tool
calls. This inspection made no model calls. `synthetic-session.jsonl` remains local/private.

pi's final cumulative session statistics: two user messages, four assistant messages, two tool
calls; 6,345 total tokens by its accounting, estimated cumulative cost USD 0.000915444. This is a
CLI/catalog estimate, not an independently verified provider bill or HTTP-attempt audit. Do not
add the first snapshot's cost again: the second snapshot is cumulative.

Source hashes (driver and relevant connector files) were recorded after the run in its receipt;
no runtime source was edited during this experiment. This is not an independent reviewer or a
controller-issued input-stability attestation.

## Follow-up: one direct upstream invalid-ID probe

The owner separately authorized checking upstream behavior. The probe read the same configured
OpenAI-completions endpoint through local pi state and captured `pi auth print-api-key` stdout
only in process memory; no credential, request headers or raw auth output was logged/persisted.
Only a synthetic one-line message and an invented model ID were sent, with `max_tokens: 8`, no
tools, no application retry loop, and redirects forbidden. Endpoint and payload hashes are retained.
No positive provider request was repeated; the earlier valid-model experiment is the control.

The first driver failed before obtaining an HTTP status (`upstream-invalid-id.log`, receipt
`upstream-invalid-e488c2f0-1112-44bb-9e7e-d5532833c8bd/receipt.json`). Pure loopback controls
reproduced an incompatible Node built-in fetch / undici 8 dispatcher combination with
`UND_ERR_INVALID_ARG: invalid onRequestStart method`. Matching undici fetch/dispatcher returned
200 in the loopback control. This was a local driver correction, not an upstream automatic retry;
the failure remains retained. No production/connector runtime code was changed for this probe.

The corrected, single application-level upstream attempt returned:

- HTTP **404**;
- error code/type **`model_not_found`**;
- message **`模型不存在`**;
- no response model, completion output or token usage.

Receipt: `.verification/evidence/pi-real-model-selection/upstream-invalid-4bfa06d6-6d6b-417f-9c0c-16ca29dfd92f/receipt.json`;
log: `upstream-invalid-id-v2.log` in the same experiment evidence root. Scratch cleanup passed.
This supports explicit rejection, with no successful fallback observed **for this one request**.
It does not prove pi/WorkerManager error classification, absence of retries in that different
path, general gateway policy, permanent availability, or that an error request incurs no fee.
Provider billing was not independently inspected. Whole-feature `releaseReady` remains false.

## Follow-up: real pi → connector → isolated steward error propagation

The owner next authorized a single synthetic negative task through the complete event path.
Driver: `.verification/evidence/pi-real-model-selection/full-error-chain.mjs`. It used installed
pi 1.5.0, the real ConnectorApp/WebSocket/event log, and the existing isolated Node steward/browser
fixture. The steward's own model remained scripted faux, explicitly not an acceptance of a real
steward model's autonomous replanning. No production service was accessed or changed.

The browser signed in to the isolated instance and saved the invalid machine/agent default via
its real Settings form. Synthetic pairing and deterministic dispatch were setup seams, not claims
of conversational dispatch or pairing acceptance. The task contained no project content; only
the report extension was allowed, with file/shell/MCP/context discovery disabled as above.

The first driver failed at ESM-only faux-module resolution before any task was dispatched
(`full-error-chain.log`, `error-chain-8eaf8222-374c-4db2-a12f-d7832dbc63b5/receipt.json`). Correcting
the driver's module import did not modify application code. The next run dispatched exactly one
real negative task and passed its scoped assertions:

- pi assistant stopped with error and retained the upstream **404 / model_not_found / 模型不存在**.
- Connector emitted `settled { outcome: error, errorClass: unknown }` with that detail intact.
  The current classifier is generic `unknown`, not a dedicated configuration-error category.
- Real WebSocket delivery/reduction produced a steward worker outcome `error:unknown`, no done
  report, and a browser-visible `模型不存在` message. `start_worker` command-result `ok:true`
  meant process/startup acceptance, not business completion; the final task remained failed.
- During **35 seconds** after failure (longer than the default 30-second connector resume
  backoff): one launch, zero recorded connector resumes, zero pi auto-retry events, one worker,
  no done report and no observed model change. Extra-start/send/resume ceilings and pi-retry
  cancellation taps were armed for safety but **never fired**; an intervention would fail the test.
- The invalid request and CLI-configured observation remained separate from provider validity.
  A subsequent prompt-free discovery still returned the original valid default model.

Receipt and artifacts:
`.verification/evidence/pi-real-model-selection/error-chain-4c0fef0e-081b-4e84-96d8-21811d5ec73a/`
contains `receipt.json`, real `worker-events.json`, authenticated `workspace-state.json`, the
first-visible-error screenshot `failure-visible.png`, Playwright `trace.zip` and a redacted
synthetic pi session. The screenshot was taken at first visible error; the final API snapshot was
captured after the observation window, not claimed to be the same instant. Owned process, browser,
fixture and scratch cleanup passed. Local synthetic auth/session artifacts remain private/ignored.

Runtime versions: Node 24.19.0; connector pi-ai 1.2.0; steward pi-ai 1.3.0; installed pi 1.5.0.
The parent fixture's loopback guard remained intact; only the separately authorized pi child made
the real provider request. HTTP-attempt counts inside pi/its SDK were not independently wire-audited,
so this establishes no observed application retry, not an audited exactly-one-HTTP-attempt claim.
No billing conclusion follows from a failed response. Real steward-model retry decisions, longer
windows, other CLI/provider versions and Claude Code remain unverified.

Credentials-free characterization regressions were added to connector `adjudication.test.ts`
and `agent-model.test.ts`: model-not-found preserves detail and cannot be masked by an earlier
done report; a shortened unit backoff exposes accidental connector retries/model replacement.
Together with `adapter-model.test.ts`, **38 tests passed**, and connector typecheck passed.
No runtime policy/classifier change was made. This does not grant feature deployment permission.

## Linux release-check follow-up (before deployment)

An isolated, unprivileged local Docker check used a source-only archive (498 files; no ignored
credentials, host node_modules, real agent configuration or Docker socket mounted), Node
24.22.3 and the repository-pinned pnpm 10.33.0. Image digest:
`node@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496`.
Containers were limited to four CPUs/4 GiB and removed after retaining evidence.

The first container lacked a PID1 init, so orphan children remained zombies and
`reconcile.test.ts:290` failed. Its process dump/log is retained. A fresh container with
`--init` passed without changing assertions or application logic: full workspace tests
(protocol 66, preview 7, steward 892, connector 534 with six predeclared platform/live skips),
all ten browser cases, 126 Node CI regressions, 60 Node model regressions, recursive/Node-host
typechecks, credentials-free health/improvement/memory/routing/PR-intent checks and connector
packing/zero runtime dependencies. The earlier Windows permission/path/cleanup failures were
not hidden or patched away. These are local Linux checks, not a claimed hosted GitHub CI run.
Evidence and source-archive fingerprint: `.verification/evidence/local-agent-models-linux/receipt.json`.

No production service or local paired connector was changed by these checks. Claude real
acceptance remains missing. A proposed pi-only rollout (including local connector upgrade and
keeping Claude model selection unavailable) requires an explicit owner scope confirmation;
this check does not itself authorize a narrower release or deployment.

## Owner-authorized pi-only production pilot

The owner explicitly approved pi-only exposure, upgrading this paired Windows connector and one
synthetic read-only live task. Claude now advertises `selection: none`/no custom model input;
a manager regression rejects explicit Claude selection before worker creation. Existing
Claude default-following behavior is unchanged. Final-delta checks passed: Linux connector 535
(with six existing skips), protocol 66, connector types; Windows focused regressions 53,
recursive/Node-host types and both builds. The earlier full Linux backend/browser gates cover
unchanged backend/UI source. No hosted CI run is claimed.

Backend/UI release: `/opt/otto/releases/agent-models-pi-9ac4510-dirty-20261117T060239Z/`.
Migration 038 applied. Previous dist and consistent SQLite snapshots were retained; the original
pre-038 snapshot also remains in the first attempted release. The first activation automatically
rolled code back because its public-Host 421 check incorrectly targeted the internal Node root.
The unchanged old version also returned 200 there; public HTTPS returned 421. The same 421
assertion was corrected to target the actual nginx boundary, without application/config/policy
changes. A doctor invocation against the wrong local host and a registration request missing its
session CSRF header are also retained as failed setup attempts, not application failures.

The local connector runs from the versioned private release
`~/.otto/releases/pi-models-20261117T055649Z/current/` (CLI SHA-256
`ac042f11209dd5463e9396f19edecf4781bec7db6c3ea8baebecee6ff40f2cc7`). A clean `9ac4510`
connector build and SQLite backup are retained for code rollback. No Run key/autostart was
installed or changed, no re-pairing occurred, and no database snapshot was restored.

A real production browser saved `ctaigw/deepseek-v4.1-flash`, reloaded and observed the same
value in Machines. The actual steward model dispatched one new readonly pi worker in a new
synthetic temporary directory. Its session contained exactly `read` and `report`; the report
returned the fixture's random nonce and its bytes were unchanged. The immutable request/source
and first/latest CLI `state` observations survived transport/API reduction; the server outcome
was `reported:done`, with one added worker and zero connector resume attempts. Matching state
is still not proof of upstream routing/weights, and using the currently configured valid model
does not accept precedence against another global default.

The task default was restored to its prior null value through the owner form. Only the owned
settled synthetic pi process was closed; its fixture directory and exact registration were
removed. A real connector restart removed the registration from the machine snapshot and
retained the worker's requested/observed facts. The synthetic thread/report remain auditable.
Production env and steward model/key-table checksums were unchanged; final remote doctor had
zero failures (existing offsite-backup warning remains). Pi session cost estimate: USD
0.001389468, excluding steward costs and not an independently verified bill. No further real
calls are authorized by this record. Production auth traces/cookies were not persisted;
evidence contains cropped synthetic/model-control PNGs and sanitized receipts instead.

Evidence: `.verification/evidence/pi-only-rollout/` (activation, first-attempt rollback,
source/artifact hashes, Linux/Windows checks, live-task and cleanup receipts, remote doctor).

## Reviewer

Independent review: pending. Positive results support only this installed pi version, configured
model, the isolated report-only first-start/cold-send scenario and the synthetic live pilot above. They do not establish filesystem
sandboxing, arbitrary coding tasks, alternate model precedence, manual/automatic resume, stall
recovery, other providers, upstream wrong-ID failure timing, or Claude Code behavior.

## Attribution and outer-loop decision

The initial failures were driver assumptions, not proofs of runtime defects. Unknown-ID local
acceptance is a real limitation of discovery/state as an availability check. The direct upstream
404 and the scoped real pi/connector/steward failure path are now recorded, but real-steward-model
replanning and other CLI/provider/platform scenarios remain open release gates;
this is not a reason to pretend suggested catalogs are complete whitelists. Continue with
explicitly authorized remaining CLI/platform checks. The earlier experiments did not deploy or
publish; the subsequent pi-only deployment is separately authorized and recorded above.
Owner approved this scoped deployment/local upgrade/test, not a general CLI release. After the
local-discovery rollout the owner confirmed normal operation and authorized source commit/push.
Npm publication and independent implementation review remain pending.
