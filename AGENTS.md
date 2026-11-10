## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

#### Toolchain pin

`package.json`'s `packageManager` field is the authoritative pnpm version (Corepack writes it on any `pnpm` run when missing — commit it, never revert it; CI installs exactly this version). If your local pnpm differs, `corepack enable` once and it self-switches.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Windows working copies

Two things about a Windows checkout bite in ways that look like real defects. Neither is one.

- **`tsc` reporting `TS1490: File appears to be binary`** for a file that is plain UTF-8. It appears after git rewrites a file (`git checkout --`, `git stash pop`, switching branches); the bytes are correct and `git diff` stays empty, but the TypeScript 7 native binary reads a stale view of the file. Unlinking and re-creating the identical bytes clears it:

  ```sh
  corepack pnpm -r typecheck 2>&1 | grep TS1490 | sed 's/^.*typecheck: //' | node scripts/refresh-stale-files.mjs --from-tsc
  ```

  Content is not touched — verify with `git diff --stat` afterwards. Do not "fix" the reported file by editing it; it is not corrupt.
- **`EPERM` on temp-directory cleanup** in connector tests that spawn processes. A child still holds its working directory; the test's `rmSync` retries and gives up. It is reported against whichever test had just finished, so read that test's own assertions in the log rather than treating the `EPERM` as the signal. Pre-existing and environmental — it also reproduces on a clean checkout of `main`.
