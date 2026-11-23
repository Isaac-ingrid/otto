## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Toolchain pin

`package.json`'s `packageManager` field is the authoritative pnpm version (Corepack writes it on any `pnpm` run when missing — commit it, never revert it; CI installs exactly this version). If your local pnpm differs, `corepack enable` once and it self-switches.

### Commands

Four packages: `apps/steward` (the Worker/Durable Object, `node-host/`, modularized `ConnectorProtocol` / `HistorySubscriptions` / `ModelConfigStore` / hybrid FTS5 search / dual-ledger telemetry / PR triage / worktree audit, and vanilla JS `ui/`), `apps/connector` (the published `otto` CLI with `pi`, `claude`, `codex`, and `antigravity` adapters plus local worktree/checkpoint/skill relays), `apps/preview-machine`, and `packages/protocol`. `.github/workflows/ci.yml` is the gate list these commands have to satisfy.

- **Typecheck** — `corepack pnpm -r typecheck`. Steward and preview-machine run `wrangler types` first, which rewrites their `worker-configuration.d.ts`; that is expected and leaves `git status` clean. The Node host is a separate project: `corepack pnpm --filter @isaac2ingrid/steward typecheck:node-host`.
- **Tests** — `corepack pnpm -r test`. The steward's `test` script is `node scripts/test-groups.mjs`: it spawns one vitest process per group because one workerd instance and its SQLite back every file in a run, so files within a group still run serially. Debug one file with `corepack pnpm --filter @isaac2ingrid/steward exec vitest run test/<file>.test.ts`; `STEWARD_TEST_GROUPS=n` forces the group count, and `STEWARD_TEST_RUNTIME=node` (or `test:node`) runs the same suite against the Node host. After editing `apps/steward/ui/*.js`, also run `node --check apps/steward/ui/*.js` plus `apps/steward/test/ui-workspace.test.ts` (and Playwright E2E smoke tests when touching browser flows).
- **Connector tests spawn the built CLI** (`dist/cli.js`). `pnpm test` builds first through `pretest`; invoking vitest directly needs `node apps/connector/build.mjs` first (`build.mjs` anchors paths to `apps/connector`). `test/windows-live.test.ts` is deliberately absent from CI — it writes the real `Run` key — and needs `OTTO_WIN_LIVE_INSTALL=1` on Windows.
- **Local isolated dev stack** — `pnpm local:up`, `pnpm local:restart [steward|connector]`, `pnpm local:status`, `pnpm local:logs`, `pnpm local:down`, `pnpm local:reset` (`scripts/local-dev.mjs`), isolating test state from the machine's paired connector service.
- **Connector local refresh & VPS deploy** — `pnpm connector:restart` rebuilds and restarts the paired connector service (run `otto install` once after service-unit updates; `PiAdapter` defaults to a 20s startup RPC timeout). `pnpm deploy:vps` (`-- --apply-env`, `-- --dry-run`) runs the self-hosted VPS rollout via `scripts/deploy-vps.mjs` and requires explicit owner authorization.
- **Credentials-free gates**: `node --test deploy/health-monitor.test.mjs`, `node --test scripts/improvement/improvement.test.mjs`, and the steward evals `eval:memory` / `eval:pr-intent:selftest` (scripted faux models over a real ledger).
- **The connector ships as a self-contained tarball.** `npm pack --dry-run` in `apps/connector` must list `dist/cli.js`, `dist/ext/otto-pi.ts`, `dist/mcp/report-server.mjs` and `bin/otto.js`, and the manifest must keep zero runtime dependencies — workspace packages stay in `devDependencies`. CI fails on a regression.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Autonomous verification selection

The agent owns verification selection and execution; do not require the user to name a skill or choose test commands for routine coding work. Select checks from the actual behavioral impact and dependencies, not just changed filenames.

- **Before editing**, identify affected behavior, invariants and existing coverage. After editing, autonomously run the relevant local, credentials-free checks with existing tools. Choose the smallest sufficient set, expanding for shared code or cross-layer changes; this does not waive ordinary tests, typechecks, ADR evaluation gates or required CI checks.
- **Conversation, PR confirmation or event delivery**: read `.agents/skills/verify-otto/SKILL.md` and run the affected feature checks with retained evidence. Run `all` when multiple covered areas or their shared dependencies are affected, not for every unrelated edit.
- **Persistence, ack, replay, deduplication, oversized-event handling or crash/reconnect ordering**: inspect the mapping in `formal/README.md`. For changes covered by the event-delivery model, run the relevant implementation regressions plus `node scripts/verification/run-tla.mjs`, including both required negative controls. A TLC pass verifies the finite model, not TypeScript refinement or production behavior.
- **Pure prose or cosmetic changes**: use relevant documentation or UI checks; do not run TLC by default. Changes to a behavioral contract, model, assumptions or verification tooling are not automatically low-risk merely because they are outside runtime code.
- **Coverage gaps or blocked checks**: add focused regression coverage for new or changed behavior where feasible. Do not present unrelated passing tests or a non-applicable model as verification. Report missing prerequisites and blockers; do not silently skip, retry until green, or substitute a production instance.
- **Report completion**: state why the checks were selected, what actually ran and passed/failed, where evidence is retained when applicable, and what remains unverified. A proposed command or a previous run against different inputs is not a current result.

Autonomy applies to choosing and running safe checks, not changing acceptance criteria or granting operational permission. Do not weaken invariants, fairness assumptions or assertions to make a candidate pass; intentional policy changes need separate owner review. Paid model calls, real external-service operations, production access, deployment, commits, pushes and multi-agent launches still require authorization for the current task. Verification itself grants none of these permissions.

### Windows working copies

Four things about a Windows checkout bite in ways that look like real defects. None of them is one.

- **`tsc` reporting `TS1490: File appears to be binary`** for a file that is plain UTF-8. It appears after git rewrites a file (`git checkout --`, `git stash pop`, switching branches); the bytes are correct and `git diff` stays empty, but the TypeScript 7 native binary reads a stale view of the file. Unlinking and re-creating the identical bytes clears it:

  ```sh
  corepack pnpm -r typecheck 2>&1 | grep TS1490 | sed 's/^.*typecheck: //' | node scripts/refresh-stale-files.mjs --from-tsc
  ```

  Content is not touched — verify with `git diff --stat` afterwards. Do not "fix" the reported file by editing it; it is not corrupt.
- **The connector suite is not green on a Windows checkout.** `pnpm -r test` passes for `packages/protocol`, `apps/steward` and `apps/preview-machine`, then fails broadly in `apps/connector` for environment reasons, not code reasons: `symlinkSync` needs a privilege the account lacks (`EPERM`), `mkdirSync(..., { mode: 0o000 })` does not make a directory unreadable, path assertions are written with `/`, several tests read the machine's real `~/.otto` (a paired daemon there changes what they see), and cleanup hits the `rmSync` `EPERM` below. CI runs only the platform subset of that suite on `windows-latest` for exactly this reason. Read the failing assertion before assuming your change caused it.
- **`EPERM` on temp-directory cleanup** in connector tests that spawn processes. A child still holds its working directory; the test's `rmSync` retries and gives up. It is reported against whichever test had just finished, so read that test's own assertions in the log rather than treating the `EPERM` as the signal. Pre-existing and environmental — it also reproduces on a clean checkout of `main`.
- **A whole-file line-ending flip that shows up as hundreds of changed lines.** `core.autocrlf` is `true` *globally* here and `false` in this repo, so a file can arrive in the working copy as CRLF and any editor that preserves it will commit the entire file as changed — one doc edit became `240 insertions(+), 223 deletions(-)` where `git diff -w` showed 17. Check `git diff --stat` before committing anything under `docs/` or `deploy/`, and if the count dwarfs your edit, rewrite the file with LF (`node -e` reading, `.replace(/\r\n/g, "\n")`, writing back) instead of trusting the editor's round-trip. `git grep -I --files-with-matches $'\r' HEAD -- .` lists every file in a commit that still carries CRLF; it should be empty.
