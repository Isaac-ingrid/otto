---
name: verify-otto
description: Verify Otto's real browser workspace, PR confirmation boundaries, and durable connector event delivery using isolated local fixtures, retained evidence, and a bounded TLA+ model. Use after changes to those features or before claiming they work; not for production deployment or paid-model evaluation.
---

# Verify Otto

Read the repository's `AGENTS.md`, `CONTEXT.md`, relevant ADRs, and [feature index](features/README.md).
This skill lives three directories below the repository root. Run the following commands from that
root, not from the skill directory. It generates no new app harness: it reuses the existing tests.

## Launch

Prerequisites: Node >=22.18, root-pinned pnpm dependencies, Playwright's pinned Chromium headless
shell, Java 17+ and the pinned TLC JAR. Setup is explicit and may download public binaries:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @isaac2ingrid/steward exec playwright install chromium --only-shell
node scripts/verification/setup-tla.mjs
# Only on Windows x64 when Java is absent:
node scripts/verification/setup-tla.mjs --java
```

Do not run both setup lines blindly: the second additionally downloads/extracts a portable JRE.
No global Java install or PATH edit is needed. Linux/macOS can supply Java 17+ via OTTO_JAVA or
JAVA_HOME. No `.dev.vars`, server key, model credential or real paired machine is needed.

```sh
node scripts/verification/verify-otto.mjs run conversation
```

The harness creates an empty, isolated SQLite database, applies real migrations, configures only
test authentication and a scripted faux model, binds its own loopback port (`0` selects a free
port), and launches a real browser. Ready means a successful password ceremony, visible
`#workspace`, and `#connection[data-state="live"]`, not merely an open port. The command owns
launch and teardown; do not launch a dev server or attach to a user's existing Otto instance.

## Doctor

```sh
node scripts/verification/verify-otto.mjs doctor
```

This is a read-only prerequisite check: Node/dependencies, pinned browser binary, Java version and
TLC checksum. It neither creates a session nor proves a running instance healthy. During a journey,
readiness/auth and port ownership belong to the fixture it created; a lost `live` indicator is a
failure to investigate, not permission to switch to production or bypass sign-in.

## Drive

```sh
node scripts/verification/verify-otto.mjs run conversation
node scripts/verification/verify-otto.mjs run pr-watch
node scripts/verification/verify-otto.mjs run event-delivery
# All three, serially under one checkout-local lock:
node scripts/verification/verify-otto.mjs run all
```

Use the exact selectors, commands and acceptance conditions in each feature file. Prefer those
selectors to coordinates. Browser actions go through real forms/buttons; API observations use the
same authenticated public workspace API. Seeding prerequisites and scripted external responses
are fixture setup, NOT proof of a user operation. Never replace a button journey with an internal
setter. `event-delivery` is explicitly a transport/SQLite contract check, not a browser or real
coding-agent test. Do not silently broaden its claim.

For covered event-protocol changes, also read `formal/README.md`. TLC must pass the finite baseline
and reject both negative controls for the specified reasons. A parser error or an unexpectedly green
mutant is a failed check. Models, assumptions, code and test oracles are separate review surfaces;
do not weaken any of them to make a candidate pass. The ordinary suite and ADR evaluation gates
still apply; this skill neither authorizes paid calls nor replaces the routing/memory gates.

## Evidence

The helper prints a unique `.verification/evidence/<run-id>/` location. Keep:

- `receipt.json`: commands, exits, runtime/tool versions, source hashes, dirty state and input stability;
- per-command logs, successful-journey PNGs and authenticated public workspace-state JSON;
- Playwright trace ZIPs containing the action sequence, not just a final screenshot;
- for event delivery, TLC logs, model/config snapshots and both generated counterexamples.

A pass requires assertions about observable side effects as well as the UI. A screenshot alone is
not proof. Read the logs and receipt; a directory existing does not imply success. `passed:false`,
missing artifacts, changed inputs, a skipped required scenario or a failed negative control blocks
the claim. The helper explicitly verifies browser PNG/JSON/ZIP evidence still exists after teardown.

Faux model and fixed GitHub evidence are external-boundary substitutes, not real-provider quality
or live CI acceptance. Node fetch and browser requests reject external origins during journeys;
public tool downloads happen only in setup. Artifacts contain ephemeral test-session data: keep
local or share deliberately, never commit real credentials. Evidence/cache directories are ignored.

## Cleanup

The test fixtures close their own browser/server, sockets and temporary database; TLC removes only
its own state scratch. The controller removes its own `.cache/verification/verify-otto.lock` in
`finally`, never evidence. Concurrent controller runs are refused. `owner.json` identifies the
controller PID and evidence directory. On an interrupted run inspect that owner before removing a
stale lock; never kill by process name or drive an unrelated instance. Do not run direct test commands
concurrently with this helper against the same checkout. After failure, retain logs and inspect for
owned orphan processes before retrying; do not silently retry until green.

## Helpers and maintenance

- `scripts/verification/verify-otto.mjs`: doctor, launch/drive/evidence/cleanup orchestration.
- `scripts/verification/run-tla.mjs`: standalone model baseline and negative controls.
- `scripts/verification/setup-tla.mjs`: explicit checksum-verified tool setup.
- `node --test scripts/verification/verification.test.mjs`: helper failure-classification selftests.

These Node helpers are invoked explicitly with `node`; no shell executable bit is required.
When a mapped route, selector, state transition or fixture changes, update the feature map and its
code/model correspondence, then rerun the affected journeys. Do not depend on an unavailable
`/maintain-verification-skill` command. Add newly discovered entry points as verified, contract-only,
or unverified; never silently label one convenient path as full feature coverage.
