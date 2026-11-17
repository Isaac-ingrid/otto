# 0010: Local pi model discovery instead of library-wide suggestions

Status: local verification and the subsequently owner-authorized metadata-only production pilot passed.
The owner confirmed normal operation and authorized source commit/push. Not npm-published;
independent review and broader acceptance remain pending.
The earlier pi-only production pilot in experiment 0009 remains a different historical build.

## Owner intent and boundaries

The owner observed too many irrelevant models and authorized replacing the bundled suggestions
with the installed local pi's metadata. Initial implementation checks did not authorize production
changes. The owner subsequently explicitly approved updating the backend and paired connector;
that separate pilot below used metadata only, not a paid completion or real-project task. No
repository commit, push or npm publication occurred during those experiments; source commit/push
was subsequently explicitly authorized after owner acceptance. The isolated installed CLI check used a
temporary directory, with no session, prompt or completion probe.

## Implementation

- `PiModelDiscovery` uses the same resolved pi executable, user model configuration and filtered
  environment as workers, with offline/no-session/no-approve and executable extensions, MCP,
  skills, templates, context and themes disabled. Only `get_state` and `get_available_models`
  are sent. Every owned process/scratch directory is closed/removed on success, failure or stop.
- This intentionally excludes project/extension-only providers and does not validate upstream
  access, quota or routing. The catalog remains suggested, with advanced exact input available;
  it is not an exhaustive whitelist. Existing qualified-ID validation remains unchanged.
- Shared/cached fields are reconstructed IDs/names, the discovery-time default ID, timestamps,
  status/source and truncation (100 entries). Headers, base URLs, keys and unrelated CLI fields
  are never projected. Corrupt/missing cache is unknown; failure retains stale local metadata,
  never the bundled provider list. Stop cannot recreate a removed connector state directory.
- Startup performs a bounded probe before hello. Owner refresh uses ephemeral metadata frames,
  not commands/workers/events. The server requires session/CSRF/same-origin, validates and
  correlates replies to the owning connection/device, caps concurrency, cancels on connector
  disconnect/revoke and times out. Storage/audit failure still resolves the request explicitly.
- The shared Settings/Machines control shows a local dropdown and discovery-time default/time.
  Manual input is collapsed under Advanced. Refresh never changes the saved task default or
  a worker's immutable request. Offline/failure states label cache; offline refresh is disabled.
  An old pi connector's library suggestions are hidden rather than labelled local discovery.

## Observations and checks

Evidence: `.verification/evidence/pi-local-catalog/receipt.json` and companion logs/artifacts.

- Installed pi 1.5.0 returned **9** models, default `ctaigw/deepseek-v4.1-flash`, through the real
  adapter/PiProcess/resolver path. No prompt or `set_model` was sent, no worker/session was
  created, and isolated metadata state was removed. This is local CLI discovery, not an
  independent wire/billing audit or proof that all nine upstream models can complete a request.
- Connector scripted-CLI/socket checks cover startup hello, refresh/busy, no command/worker/event
  creation, sanitized fields, cache/restart/failure, bounded timeout, cancellation and truncation.
  Windows focused connector tests: 59 passed. Three expanded Windows directory-registration
  cases failed on native-versus-normalized path IDs; their assertions/logs are retained unchanged.
  The same complete connector suite passed in isolated Linux: **541 passed, six existing skips**.
- Linux protocol **67**, preview **7**, steward **896**, Node model/ledger regressions **64** passed.
  Recursive/Node-host types, memory/routing/PR-intent selftests, health/improvement tests,
  self-contained CLI packing/zero runtime dependencies and both application builds passed.
- All **12** browser cases passed with PNG/JSON/trace evidence. Cases 12/13 use an actual
  authenticated loopback WebSocket with scripted catalog replies, real forms/APIs/SQLite and
  no task. They verify local/default display, advanced input, refresh/default independence,
  failure/offline cache and hiding the legacy library catalog. They do not run a real pi.
- The combined verification controller passed conversation, PR confirmation/contracts and real
  connector/steward event anchors. TLC baseline exited 0, ack-before-persist negative control 12,
  poison-event negative control 13. Its finite model does not model metadata discovery or prove
  TypeScript refinement/model choice. Current receipt:
  `.verification/evidence/1794903742753-8432a94b-708b-4acf-9f83-bc43f5871335/receipt.json`.
- Initial Linux full-suite failure: the interface-copy scanner interpreted the condition literal
  `ready` inside a translation call as a translation key. Moving the predicate outside that call
  preserved behavior and assertions; full checks then passed. The final storage-plus-audit
  failure guard was followed by a fresh complete steward/Node/types run and controller/browser
  rerun. Failed attempts remain retained, not silently replaced with green results.

## Owner-authorized production pilot

After owner confirmation, backend/UI release
`/opt/otto/releases/agent-models-pi-local-catalog-9ac4510-dirty-20261117T085658Z/` was activated,
then the paired Windows connector moved to the versioned private release
`~/.otto/releases/pi-local-catalog-20261117T085523Z/current/`. Full previous artifacts and
consistent SQLite backups were retained. No rollback was needed, no database snapshot was
restored, no new migration ran, and pairing/Run-key/autostart configuration stayed unchanged.
The code matched the earlier 271 tested runtime/test source hashes before rebuilding.

A real production login/browser confirmed nine local models and the discovery-time default
`ctaigw/deepseek-v4.1-flash`. DOM options matched the reported local catalog rather than library
suggestions. Advanced input was collapsed. Clicking Refresh traversed the real authenticated
server/connector/pi metadata path, advanced the timestamp and produced matching local cache and
server catalogs. Settings and Machines agreed after reload. Saved task default, all 11 existing
workers/model facts, steward selection and model/provider-key/generation tables remained
unchanged. No new task, `set_model` or completion probe was sent. Env and every backend/UI
asset hash passed checks; root 200, unauthenticated settings 401, forged public Host 421 and
SQLite quick-check ok. Remote doctor had zero failures; its existing offsite-backup warning
remains. Production auth traces/cookies were not retained: cropped model-control PNGs and
sanitized receipts record the operational acceptance.

Evidence: `.verification/evidence/pi-local-catalog-deploy/receipt.json` plus activation,
client-switch, live-UI, checksums and doctor artifacts. This is not upstream availability testing
or permission for another production change/paid call.

## Remaining scope

This is not a hosted GitHub CI run or blanket approval for further deployment. Independent implementation review,
other installed pi versions/platforms/providers, extension/project-specific discovery and actual
availability of each listed model remain unaccepted. Claude explicit selection remains disabled.
The code exposes no new thinking override, connection-management plane or Codex adapter.
