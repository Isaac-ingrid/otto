# Experiment 0013: Claude Code (`claude-code`) explicit model selection and cold-session continuation

Status: code & isolated `fake-claude` self-test implemented; real-CLI `--live` acceptance ready to run on any machine with an authenticated `claude` executable (`claude` CLI is not installed in the current Mac `PATH`).
Lane: `ADR-0021` follow-up — `claude-code` launch model selection, bounded opaque model validation, `system/init.model` observation separation, and cold `--resume` retention. Date: 2026-11-17.

## Scope and capability unlock

1. **Launch-time selection (`selection: "launch"`, `idFormat: "opaque"`)**:
   - `ClaudeAdapter.modelCatalog` advertises `selection: "launch"`, `discovery: "suggested"`, `customModelInput: true`, `actualModelObservation: true`, `thinkingSelection: false`, and `idFormat: "opaque"`, with suggested CLI aliases `sonnet`, `opus`, `haiku`, and `opusplan`.
   - Both Steward (`acceptsAgentModel` in `packages/protocol/src/agent-models.ts`) and Connector (`ClaudeAdapter.validateModel` + `WorkerManager.validateRequestedModel`) enforce `validateClaudeModelId`: bounded `1..256` single-argv tokens supporting aliases (`sonnet`, `opusplan`, `sonnet[1m]`), concrete Anthropic IDs (`claude-sonnet-4-6`), Bedrock IDs/ARNs (`us.anthropic.claude-sonnet-4-6-v1:0`), and Vertex `@` version tags (`claude-sonnet-4-5@20250929`), while rejecting CLI flags (`--help`), whitespace/control characters, `..` traversal, trailing separators, and malformed bracket fragments (`sonnet[`, `sonnet[]`).
2. **Alias request vs concrete `system/init.model` observation (`ADR-0021` Decisions 8 & 9)**:
   - Headless `claude -p --output-format stream-json` resolves aliases at runtime and reports the concrete model in `system/init.model`.
   - `ClaudeAdapter` validates `init.model` through `AgentModelObservationSchema` (`source: "init"`) and keeps `requestedModel` (e.g. `sonnet`), immutable `launchObservedModel`, and advancing `lastObservedModel` strictly distinct.
3. **Error propagation without silent retry or model replacement**:
   - Pre-`init` error result frames and `error_during_execution` `errors[]` arrays from `claude -p` are preserved verbatim (redacted) into startup rejection or `settled { outcome: "error" }` with zero automatic retries or fallback model substitution.

## Reproducible driver (`0013-claude-model-selection-driver.mjs`)

Driver path: `docs/research/experiments/0013-claude-model-selection-driver.mjs`.

1. **Zero-cost preflight (default)**:
   ```bash
   node --experimental-transform-types docs/research/experiments/0013-claude-model-selection-driver.mjs --preflight
   ```
   Verifies catalog capabilities, positive/negative `validateClaudeModelId` & `acceptsAgentModel` parity, and probes `claude --version`.
2. **Zero-cost isolated harness self-test (`fake-claude`)**:
   ```bash
   node --experimental-transform-types docs/research/experiments/0013-claude-model-selection-driver.mjs --selftest
   ```
   Runs `LocalStore` + `WorkerManager` + `ClaudeAdapter` in an isolated temporary Git repository: initial `--session-id <uuid> --model sonnet` run, full SQLite teardown and cold reopen, `--resume <uuid> --model sonnet` continuation recalling a random nonce while keeping `launchObservedModel` immutable and advancing `lastObservedModel`, plus a negative nonexistent-model run verifying `outcome: "error"` and `countResumes === 0`.
3. **Authorized real-CLI acceptance (run once `claude` CLI is installed and signed in)**:
   ```bash
   node --experimental-transform-types docs/research/experiments/0013-claude-model-selection-driver.mjs \
     --live --confirm-paid \
     --model sonnet \
     --negative-model nonexistent-claude-model-0013
   ```
   Executes two tiny report-only synthetic prompts plus one negative invalid-model check in an isolated OS temporary directory outside this checkout, verifies zero dirty files and zero orphan processes, and writes a redacted `receipt.json` (with SHA-256 source hashes) under `.verification/evidence/claude-model-selection/<runId>/receipt.json`.
