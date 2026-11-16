# Steward model candidates

This is a separate browser entry point, not covered by the conversation journey alone.

```sh
OTTO_VERIFY_EVIDENCE=1 corepack pnpm --filter @isaac2ingrid/steward exec playwright test --project=chromium --grep '8\. model failure|9\. stale model|10\. model activation' --trace=on --retries=0 --reporter=list --output=../../.verification/evidence/<unique-run>/model-selection
```

Replace `<unique-run>` with a new local directory name. The existing isolated browser fixture
owns authentication, the Node steward, its SQLite database and cleanup. Do not attach to a real
instance. Preserve failures as well as successful PNG, authenticated workspace JSON and trace ZIP.
This direct Playwright command does not generate the controller's `receipt.json` automatically.

The browser expands More providers, opens DeepSeek's form, submits a key, sees a connection
failure, reloads, finds the persisted failure, retries verification, and explicitly activates.
Before activation the public/runtime selection remains faux; afterwards the committed key and
provider match the submitted candidate. Test 9 changes the selection through the authenticated
public composer API and verifies that stale activation leaves it unchanged with a visible alert
inside the settings modal (not a toast hidden behind its backdrop). Test 10 uses a second browser
tab and a streaming faux reply: activation becomes disabled with an explanation, then becomes
enabled after stopping the reply without closing settings. It never activates automatically. Only provider responses are scripted. These credentials
are fake: passing does not prove live-provider connectivity, billing or model quality.

The SQL/crypto companion is `test/model-draft.test.ts`: encrypted persistence and redaction,
CSRF, slot contention, busy, stale revision/generation, inherited-key rotation and injected import
failure with atomic rollback. `test/model-switch.test.ts` retains legacy selection and catalog
regressions. No event-delivery model property maps to model configuration commits.

Still unverified by this browser journey: first-run no-key chip, all provider forms, real
provider credentials, and the exact backend busy-check/commit interleaving. Test 10 covers the
browser busy transition, not every possible scheduling race. Local coding-agent model selection
is outside this batch.
