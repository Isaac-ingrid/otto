# Experiment 0014: Codex CLI (`codex`) adapter, readonly/image/model support, and session history acceptance

Status: code & isolated `fake-codex` self-test implemented; real-CLI `--live` smoke acceptance ready to run on any machine with an authenticated `codex` executable.
Lane: `CodexAdapter` end-to-end verification — headless `codex exec --json` / `codex exec resume --json`, `-c mcp_servers.otto.*` injection, `--sandbox read-only`, `-i` image attachments, launch model selection + rollout `turn_context` observation, crash recovery (`worker.sessionFile === null`), deduplicated normalized history, and Web full-session `describeRecord` parsing. Date: 2026-11-18.

## Scope and verified invariants

1. **Readonly sandbox, image attachments, and MCP `report` / `propose` injection**:
   - `CodexAdapter` injects Otto's stdio MCP server (`report` and `propose`) via `-c mcp_servers.otto.*` TOML overrides without mutating `~/.codex/config.toml`.
   - `mode: "readonly"` enforces `-s read-only`, `sandbox_mode="read-only"`, and `approval_policy="never"`, while `images` are written to per-worker temp files and passed via `-i <path>`.
2. **Launch model selection and rollout model observation (`selection: "launch"`, `actualModelObservation: true`)**:
   - Validates single-token opaque model IDs (`gpt-5.4`, `gpt-5.3-codex`, `o3`, etc.) while rejecting CLI flags, path traversal (`..`, `//`), and trailing separators.
   - Observes the concrete runtime model from stdout events or `<codexHome>/sessions/.../rollout-*-<sessionId>.jsonl` (`turn_context.payload.model` / `session_meta.payload.model`), preserving `requestedModel`, immutable `launchObservedModel`, and advancing `lastObservedModel` across cold SQLite restarts.
3. **Crash recovery and deduplicated session history + Web viewer**:
   - Leaves `worker.sessionFile` unset (`null`) on `WorkerRow` so Connector restarts route in-flight Codex workers through `lost` + `scheduleAutoResume` (`codex exec resume`) rather than pi's `inspectSessionTail`.
   - `readCodexSessionHistory` deduplicates twin `response_item` + `event_msg` utterances per turn and filters `<environment_context>` blocks, while `apps/steward/ui/session-model.js` (`describeRecord`) natively parses Codex rollout and stream records.

## Reproducible driver (`0014-codex-adapter-smoke-driver.mjs`)

Driver path: `docs/research/experiments/0014-codex-adapter-smoke-driver.mjs`.

1. **Zero-cost preflight (default)**:
   ```bash
   node --experimental-transform-types docs/research/experiments/0014-codex-adapter-smoke-driver.mjs --preflight
   ```
   Verifies `CodexAdapter.capabilities`, `modelCatalog`, positive/negative model ID validation, and probes local `codex --version` + auth readiness without spawning any agent run.
2. **Zero-cost isolated harness self-test (`fake-codex`)**:
   ```bash
   node --experimental-transform-types docs/research/experiments/0014-codex-adapter-smoke-driver.mjs --selftest
   ```
   Runs `LocalStore` + `WorkerManager` + `CodexAdapter` + `session-model.js` against `fake-codex.mjs`: readonly + PNG image start, cold SQLite reopen + `exec resume --json` continuation recalling a random nonce, normalized + full history reassembly (`describeRecord`), connector crash + `reconcileStartup` auto-resume, and single-shot invalid-model error propagation (`countResumes === 0`).
3. **Authorized real-CLI smoke acceptance**:
   ```bash
   node --experimental-transform-types docs/research/experiments/0014-codex-adapter-smoke-driver.mjs \
     --live --confirm-paid \
     --model gpt-5.3-codex \
     --negative-model nonexistent-codex-model-0014
   ```
   Executes report-only synthetic checks (readonly + 1x1 PNG image -> cold SQLite `exec resume` nonce recall -> normalized & Web full-session history verification -> optional negative model check) in an isolated OS temporary Git repository and writes a redacted receipt under `.verification/evidence/codex-adapter-smoke/<runId>/receipt.json`.
