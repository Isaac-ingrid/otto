# ADR-0021: Local-agent model defaults are adapter capabilities and immutable worker requests

Status: owner-authorized pi-only pilot deployed; this Windows connector was upgraded locally.
The owner confirmed normal pi-only operation and authorized committing/pushing this batch;
no npm publication is authorized. The local-pi discovery follow-up below was also owner-authorized
and deployed, with a real metadata-only Settings/Machines refresh check (experiment 0010). Claude explicit selection, broader real recovery acceptance and
independent implementation review remain pending.

## Context

The connector already accepted `start_worker.model`, but the steward never supplied it and cold
send/resume/stall paths dropped it. A model displayed from the request alone is not evidence of
what a CLI used. Pi and Claude Code also have different discovery and model-ID semantics.

## Decisions

1. Local agents and Otto's steward model remain separate planes. Local-agent settings store only
   model identifiers, never local login/API keys. Authentication and billing remain agent-owned.
2. An optional, bounded `hello.agents[].modelCatalog` describes selection (`none/launch/idle`),
   discovery (`none/suggested/enumerated`), custom input, actual observation and thinking support.
   Missing declarations permit only following the agent default. Suggestions are not whitelists;
   a complete enumerated catalog is. Unavailable discovery is distinct from CLI installation.
3. IDs are bounded single argv values, not shell fragments. Opaque IDs support CLI syntax such
   as Claude context aliases/colon-containing versions. Qualified IDs use exact `provider/id`
   without pi's thinking suffix; thinking overrides are not exposed in this batch. An adapter
   may narrow validation further. Both steward and connector enforce their available catalog.
4. Migration 038 retains model catalogs per machine, adds `(deviceId, agent)` task defaults and
   separate worker request/observation columns. Catalogs are replaced by each hello, including
   clearing old declarations after a connector downgrade. Defaults never edit agent files.
5. At initial dispatch the deterministic service resolves an explicit supplied override, the
   machine/agent default, or agent-default mode. Worker registration and the outbox contain the
   resolved immutable request/source; duplicate commands do not re-read later defaults. Offline
   commands remain frozen and held under the existing confirmation policy. Switching machines
   revalidates the frozen selection on the chosen target.
6. Defaults apply to newly created sessions, not an existing reusable session. Every local cold
   send, manual/automatic resume and stall respawn reuses the persisted request. An explicit
   different model request forces a new session with a handoff instead of silently editing an
   old session. The worker id is pinned to its original agent and model request.
7. The normal LLM `start_worker` tool schema and prompt are unchanged. Single-shot override is
   supported by the typed deterministic dispatch input, but a conversational/UI one-shot entry
   is deferred: it needs an explicit owner-authorization surface and its own acceptance. No
   autonomous model choice is inferred from task text in this implementation.
8. Pi discovers bounded model metadata from the installed executable's `get_available_models`
   and startup `get_state` in a temporary no-session/offline RPC process. It never prompts,
   changes a model, reads credential stores directly or probes completions. Discovery uses the
   same resolved executable/environment and user model configuration, with executable extensions,
   MCP and project context disabled for safe metadata inspection. Therefore extension/project-only
   entries may be absent and the list remains suggested, not an exhaustive whitelist. Cache stores
   only IDs/names/default ID/timestamps, capped at 100 entries with an explicit truncation marker.
   On startup/manual refresh failure, keep local cached results marked unavailable; never fall
   back to the library-wide catalog. Metadata refresh uses bounded ephemeral authenticated
   `agent_models`/`agent_models_result` reads, not commands, workers or durable event sequences.
   It is owner/CSRF/origin guarded, connection/device correlated, cancelled on disconnect and
   times out. It cannot mutate task defaults or existing sessions. Old pi library suggestions
   are hidden; advanced exact input remains available by capability. Offline views show cache
   timestamps and disable refresh. Pi validates qualified IDs, passes `--model` on task launch
   and observes `get_state.model`; a known mismatch fails before delivering the prompt.
   Claude Code's alias/`system/init.model` plumbing remains covered by scripted tests only.
   For the owner-approved pi-only rollout it advertises `selection: none` and disables custom
   model input; the manager rejects explicit Claude models before creating a worker. Existing
   Claude tasks may still follow their CLI default. Neither advertises hot switching or thinking
   selection. Both retain the existing argv builders.
9. Requested, first launch-observed and latest-observed values are distinct. No requested value
   fills an unknown observation. A missing first-launch observation stays unknown even if a later
   resume can report a model. Bounded trusted observations travel with started/resumed and
   reconnect snapshots; older observations cannot overwrite newer timestamps in the steward.
   Agent-written summaries and report prose are never model-selection evidence.
10. Settings and Machines share one component. It states scope, separate billing, old-connector
    limitations and offline/stale capabilities. Worker cards label requested and observed values
    separately. Changing a default broadcasts a settings refresh but does not reconfigure the
    steward root model or any running coding worker.

## Verification and remaining gates

- `packages/protocol/test/agent-models.test.ts`: old-agent fallback, suggestions vs complete
  catalogs, bounded IDs/catalogs and qualification rules, trusted observation source validation.
- `apps/connector/test/agent-model.test.ts`: a generic fake Codex adapter (not a real Codex
  integration), gating, immutability, reopening SQLite, cold send/resume/stall request retention
  and first/latest observation separation. No real child process or provider is used.
- `apps/connector/test/adapter-model.test.ts`: real pi/Claude adapters over scripted fake CLI
  processes; state/init parsing, pi mismatch refusal before prompt, unknown observations.
- `apps/steward/test/agent-model.test.ts`: authenticated API/CSRF, old connector, independent
  defaults, dispatch/replay/offline snapshots, observation vs request, resume and explicit model
  change. Browser smoke test 11 saves/resets through Settings and Machines without changing the
  steward model. Machine facts are fixture setup, not evidence of real pairing or agent use.

[Experiment 0009](../research/experiments/0009-pi-model-selection-acceptance.md) records two
owner-authorized report-only real tasks on pi 1.5.0 with `ctaigw/deepseek-v4.1-flash`: first start
and a cold send after reopening SQLite retained the request, session/history and observations.
A separately authorized direct upstream nonexistent-ID probe returned HTTP 404 `model_not_found`.
A subsequent real pi/connector/WebSocket/isolated-steward test preserved that error in the browser;
over 35 seconds it observed no application retry, model replacement or false done report. The
steward's own model was scripted faux, so autonomous real-model replanning is not accepted.
This does not accept other models, general wrong-ID behavior, manual/automatic-resume,
stall recovery or real Claude aliases/init/resume. No Claude executable was found. In particular,
this custom provider accepts arbitrary IDs into local state: matching `get_state.model` is not
upstream existence/availability validation. The direct 404 only establishes the one endpoint
response, not a general gateway policy; the later error-chain experiment has the narrower
application-level retry/propagation scope described above. The unsuccessful local negative preflight remains
retained. This ADR grants no further paid calls, publishing or deployment permission. Pi suggestions
come from the connector's library version, not a claim about the installed CLI/account's capabilities.

The connector's Windows suite has known permission, path and process-cleanup failures; the
original failures are retained. Local isolated Linux release checks passed (not a hosted GitHub
CI claim): full steward 892, protocol 66, preview 7, connector 534, ten browser cases and the
Node/evaluation/packaging gates. After disabling Claude explicit selection, the final connector
suite passed 535 tests with six existing platform/live skips, protocol 66 and connector types;
Windows focused regressions passed 53 and recursive/Node-host types passed. No assertion was
weakened. Evidence: `.verification/evidence/pi-only-rollout/`.

After explicit owner approval, migration 038/backend/UI and the versioned local connector were
activated. One real production browser → steward model → connector → pi → provider task read
only a synthetic fixture and reported its nonce. Requested and CLI-observed models matched;
server outcome was `reported:done`, with exactly one added worker and no connector resume.
The session contained only `read` and `report` calls. The temporary task default was restored,
its directory/registration removed, and model facts survived a real connector restart. This
accepts only the observed pi/provider/task path; it does not establish upstream routing identity,
general recovery behavior or Claude behavior. See experiment 0009 for rollback/setup failures
and retained evidence.
The event-delivery finite model covers delivery/ack/reduction invariants, not correctness of model
choice or all recovery semantics. Its baseline and negative controls are separate regressions;
passing TLC is not real CLI acceptance or TypeScript refinement.
