# ADR-0022: Structured report labels, locally approved worktree hooks, and read-only worker proposals

Status: implemented (2026-11-18 across Stages 1–4: migration `039_report_labels`, connector local hooks + migration `040_repo_hook_capabilities`, and migration `041_readonly_proposals` covering same-machine `v1` auto-approval + cross-machine `v2` owner confirmation cards).
Staged rollout (`C -> B -> A`) and codebase verification targets are tracked in
[docs/plan/conductor-0.95-adoptions.md](../plan/conductor-0.95-adoptions.md).

## Context

Reviewing Conductor 0.95.0 ("Local agents orchestration") against Otto's existing architecture
showed that most headline capabilities — isolated Git worktrees per write task, local-only write
policies, multi-adapter process supervision (`pi`, `claude-code`, `antigravity`), CPU-delta stall
detection, branch-carrying Thread relays, and head-keyed PR-watch notifications — already exist in
Otto. Adopting repository-committed hook configs (`conductor.json`), long-lived dev-server `run`
scripts, worker-initiated Thread archiving, or worker-spawned write branches would weaken Otto's
trust boundary and Thread invariants.

Three narrow gaps remain worth addressing in ROI order:

1. Closing reports (`sh_report`) have no bounded categorical labels for deterministic rendering or
   recurring blocker tallying (such as environment setup failures).
2. Isolated write worktrees lack locally approved `setup` and `archive` hooks, forcing fresh write
   branches to lack untracked local links or dependencies.
3. A running worker session has no safe way to request an isolated read-only probe (especially
   across another registered Directory) without polluting its own context or waiting for a manual
   relay turn.

## Decisions

1. **Explicit exclusions and authority boundaries.** Workers never spawn child agent processes
   directly, never archive Threads, never modify repository or hook settings, and never propose
   write-mode tasks. Repository-committed hook manifests and long-running background `run` scripts
   are rejected. Existing PR-watch changed-head notification behavior (`pr-watch:<watchId>:<head>:<kind>`)
   remains unchanged.
2. **Bounded report labels (Stage 1 / Plan C).** The `report` tool across `otto-pi.ts` and
   `mcp/report-server.mjs` (`claude-code` and `antigravity`) accepts an optional `labels: string[]`
   field, normalized in `normalizeReport` and stored in `sh_report.labels` (JSON text; omitted
   maps to `NULL`, explicit `[]` maps to `"[]"`). At most 3 deduplicated labels matching
   `^[a-z0-9-]{1,32}$` from the fixed vocabulary (`blocked-by-env`, `needs-human-verify`,
   `flaky-test`, `needs-migration`, `scope-creep`) are retained; unknown or excess entries are
   dropped with a diagnostic log rather than failing settlement. Labels render deterministically on
   done-report Messages, Thread timelines, and Steward event wakes, and never trigger automatic
   dispatch, Thread state transitions, or archiving.
3. **Locally approved worktree hooks in `connector.sqlite` (Stage 2 / Plan B).** Per-Directory
   `setup` and `archive` hooks live exclusively in the Connector's `0600` `LocalStore` (`repo`
   table in `connector.sqlite`), never in repository files or separate JSON sidecars. Only the
   machine-local `otto repo-config` CLI may configure or approve hooks; remote commands carrying
   hook parameters are rejected by `rejectLocalOnlyArgs`. Hook entry scripts must reside under
   `~/.otto/hooks/`, and `--approve-hooks` binds the SHA-256 digest of both the normalized hook
   configuration and the entry script bytes. Any byte change invalidates approval until re-approved
   locally. `HelloMessage.repos` and `sh_repo` record only boolean capability summaries
   (`hasSetupHook`, `hasArchiveHook`, `approved`, and `capabilityKind`), never script contents or
   local paths.
4. **Hook execution and `starting` liveness without a new worker state.** Hooks run via `execFile`
   with argument arrays (no `shell: true`), `stdin: "ignore"`, bounded timeouts and log tails, and
   `childEnv` credential scrubbing (no `OTTO_*` variables). `setup` runs only on newly created
   write-mode Git worktrees (never on in-place Directories, main-checkout read-only runs, or
   detached-HEAD `createReadonlyWorktree` checkouts, which guarantee source checkout only). A
   failed or mismatched `setup` hook aborts launch, cleans up the freshly allocated empty worktree,
   marks the worker `broken`, and fails with `setup_hook_failed`. Instead of adding a cross-layer
   `preparing` state across worker reconciliation tables, the worker stays `starting` and emits
   `progress{phase:"setup_hook"}` before hook execution so Steward's `silentSince` sweep observes
   fresh liveness while the hook's own timeout bounds execution. `archive` runs during explicit
   `cleanup_worktree` after clean/pushed checks pass; `archive` failure aborts removal and retains
   the worktree as evidence (`archive_hook_failed`).
5. **Read-only worker proposals and deterministic Steward adjudication (Stage 3 / Plan A).**
   Workers may emit a strictly validated `proposal` event (`kind: "readonly_probe"`) over the
   existing durable `events` batch, reduced in `ledger.ts` (`applyEvent`) into `sh_proposal`
   keyed idempotently by `dedupeKey` (`${workerId}:${proposalKey}`). Approved proposals dispatch a
   read-only worker session via Steward's existing `Dispatcher` and standard `start_worker` command
   — no `run_proposal` wire command is added. Same-machine read-only probes auto-approve within
   hard quotas (at most 2 proposals per worker, 2 in-flight `sibling` sessions per Thread, 3
   auto-approved in-flight globally, and `proposalDepth < 1`). Cross-machine read-only probes
   never auto-approve by default; they open a 10-minute bound confirmation in **Needs you**
   modeled on [ADR-0019](0019-pr-watch-owner-confirmation.md).
6. **Read-only capability routing across adapters.** Because `claude-code` and `antigravity`
   declare `capabilities.readonly = false`, Steward's proposal adjudicator must never blindly copy
   the proposing worker's `agent` kind. It must select an installed agent on the target Machine
   that advertises `capabilities.readonly === true` (such as `pi`), or deterministically reject the
   proposal with `no_readonly_agent`.
7. **Thread main-chain isolation for `sibling` sessions.** `sh_worker` records
   `workerRelation` (`'relay' | 'sibling'`, default `'relay'`) and `proposalDepth` (`0` on normal
   sessions, `1` on proposal-spawned `sibling` sessions). `latestOnThread`, `relaySource`,
   `latestBranchOnThread`, and default `handoff.build` selection filter strictly to `'relay'`
   sessions so a read-only `sibling` never hijacks follow-up continuations or handoff pointers.
   Dispatching a `sibling` never closes open Thread questions (`questions.closeOpen`) and never
   overwrites `sh_thread.lastMachine`. Tool responses return `queued_for_steward_decision`
   synchronously; parent workers never block awaiting `sibling` completion.
8. **Out-of-band MCP file separation for ACP adapters.** `pi` exposes `propose` in `otto-pi.ts`;
   `claude-code` and `antigravity` share `mcp/report-server.mjs`. Because `agy acp` notifications
   may omit MCP `rawInput` in `session/update`, `report-server.mjs` must write validated proposals
   to a separate append-only JSONL path (`argv[3]`, `proposals-<workerId>.jsonl`) rather than the
   single-overwrite `report` audit file (`argv[2]`), preserving multiple proposals alongside the
   final closing `report`.

## Validation boundaries

Each stage requires focused unit and integration regressions before advancing:

- **Stage 1 (Plan C)**: `normalizeReport` bounds across `pi`, `claude-code`, and `antigravity`
  (`report-server.mjs` schema visibility, unknown/duplicate/excess label stripping, `undefined` vs
  `[]`), Steward migration and `(workerId, seq)` replay idempotency, and deterministic Message /
  timeline rendering.
- **Stage 2 (Plan B)**: `LocalStore` SQLite column migration, SHA-256 invalidation on config or
  entry-script mutation, `rejectLocalOnlyArgs` enforcement, `setup_hook_failed` empty-worktree
  rollback, `progress{phase:"setup_hook"}` timestamp refresh, dirty-worktree refusal and
  `archive_hook_failed` preservation on `cleanup_worktree`, and `OTTO_*` environment scrubbing.
- **Stage 3 (Plan A)**: `ledger.applyEvent` adjudication truth tables, quota and `proposalDepth = 1`
  enforcement, cross-adapter `readonly: true` agent selection, non-interference of `sibling`
  workers with `latestOnThread` / `lastMachine` / open Thread questions, bound **Needs you**
  confirmation expiry/idempotency for cross-machine probes, and `proposals-<workerId>.jsonl`
  recovery when ACP `session/update` omits `rawInput`.

Per [`formal/README.md`](../../formal/README.md), the TLA+ event-delivery pilot covers single-worker
durable persistence, oversize quarantine, cumulative acks, and at-most-once inbox reduction only.
If Stage 3 modifies `events.ts`, `connector-protocol.ts`, or the `ledger.ts` inbox-reduction loop,
`node scripts/verification/run-tla.mjs` (including both negative controls) must pass to guard
delivery invariants, but TLC results do not verify proposal adjudication, quotas, hook execution,
or `start_worker` command dispatch.
