# Local coding-agent model defaults (pi-only pilot; local pi discovery)

This is separate from the steward model candidate flow. No real CLI/provider is invoked.

```sh
OTTO_VERIFY_EVIDENCE=1 corepack pnpm --filter @isaac2ingrid/steward exec playwright test --project=chromium --grep '11\. local-agent|12\. pi picker|13\. legacy pi' --trace=on --retries=0 --output=../../.verification/evidence/<unique-run>/local-agent-models
```

Use a fresh evidence directory. Test 11 uses the existing isolated Node/SQLite fixture. Machine
facts (including a generic fake adapter capability) are prerequisites, not a real-pairing claim.
The browser saves a custom model through Settings, reloads, observes it in Machines, resets to
following the agent default and checks the authenticated public settings API. The steward model
remains faux throughout. The same component serves both entry points. Preserve PNG/JSON/trace
and logs; the direct Playwright command does not create a controller receipt automatically.

Follow-up browser cases 12/13 verify the local pi dropdown, discovery-time default, collapsed
advanced input, explicit custom selection, refresh without default mutation, failure/offline cache
labels, disabled offline refresh and hiding legacy all-library suggestions. Case 12 pairs a
scripted connector on a real loopback authenticated WebSocket. Its catalog replies substitute
for the CLI boundary; this is not a real installed-pi or provider claim. No task is dispatched.

Companion tests:

- Connector `pi-model-discovery.test.ts`: real PiAdapter/PiProcess over the scripted CLI,
  startup hello and real socket refresh, coalescing/busy bounds, timeout, restart/cache,
  metadata-only field projection, truncation and no prompt/worker/command creation.
- Steward `agent-model.test.ts`: metadata refresh CSRF/origin, owning connection correlation,
  concurrent-read rejection, timeout/disconnect cancellation, ignored late replies and unchanged
  task defaults. These ephemeral reads do not participate in durable event ack/replay.

- Protocol `agent-models.test.ts`: bounded declarations, old-agent fallback, suggested vs
  enumerated discovery, qualified vs opaque IDs and trusted observation sources.
- Connector `agent-model.test.ts`: generic fake adapter; persisted requests, reopening SQLite,
  cold send/resume/stall, immutable identity and separate launch/latest observations.
- Connector `adapter-model.test.ts`: real adapters parsing scripted fake CLI state/init, not
  real provider behavior. Pi mismatch is refused before task prompt delivery.
- Connector `claude-manager.test.ts`: Claude explicit selection stays unavailable during the
  pi-only rollout; an explicit request is rejected before worker creation.
- Steward `agent-model.test.ts`: authenticated/CSRF settings, per-machine defaults, dispatch
  dedup/offline snapshots, observed vs requested values and continuation policy.

Shared ledger/event metadata also requires the existing conversation/event-delivery regressions;
run the applicable verification controller journeys and bounded TLC negative controls. Their
scope remains delivery/ack/reducer invariants, not a proof of model selection correctness.

A separately authorized positive real-pi first-start/cold-send experiment is recorded in
`docs/research/experiments/0009-pi-model-selection-acceptance.md`. It is not run by this journey,
and does not waive its failed unknown-ID preflight or outstanding release gates.

A later owner-authorized pi-only production pilot upgraded the backend and this Windows connector.
Its real browser/steward/connector/pi/provider task used only a synthetic fixture, saved/reloaded
and reset the task default, retained requested/observed facts after reconnect, and cleaned up its
directory/registration. See experiment 0009 and `.verification/evidence/pi-only-rollout/`.
A separately authorized local-discovery rollout subsequently verified the actual installed-pi
nine-model list and metadata refresh through the production browser without a task/completion
probe; experiment 0010 and `.verification/evidence/pi-local-catalog-deploy/` record that scope.
This is not permission for another production journey or paid call; the scripted verification
command above remains isolated and credentials-free. Claude explicit selection is gated off.

Not accepted yet: general real CLI startup/resume/alias behavior, other provider permissions/data egress,
further paid calls, package publishing, other real connector upgrades, conversational single-shot selection,
independent thinking levels, or an actual Codex adapter. Real CLI verification needs explicit
operator permission where it starts a coding task or spends provider credits.
