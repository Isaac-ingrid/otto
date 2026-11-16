# Experiment 0008: Verification skill + bounded event-delivery model

Status: local pilot exercised; subsequent review, split commits, push and CI checks authorized.
No deployment or production acceptance is authorized. Local observations below predate publication
and do not imply a remote CI result. Initial base commit `e45cc39` plus the existing dirty worktree
(review fixes already in progress); the retained source manifest, not that commit alone, identifies
what was checked. Owner approved a small skill + TLA+ pilot, not production operations.

## Hypothesis and boundaries

A project-local verification skill can make AI changes easier to inspect by connecting a real user
journey and its evidence to explicit state-machine rules and real code regressions. TLA+ checks the
finite design; tests check selected implementation behaviors. Neither is a proof of all TypeScript.

Use `.agents/skills/verify-otto/` (supported project discovery), not the supplied generator's
hard-coded Cursor directory. The generated feature map is self-contained and does not depend on the
missing `references/feature-map-example/` or an unavailable maintenance command. The supplied root
`SKILL.md` is left unchanged. No multi-agent work or paid model calls were launched.

Protected: product authorization, model routing/scoring, memory trust, protocol policies and runtime
code. This pilot adds verification tooling/docs, a fault-injection contract test, and opt-in evidence
capture to existing browser tests; it does not alter runtime behavior.

## Artifacts and execution

- `.agents/skills/verify-otto/SKILL.md`: launch/doctor/drive/evidence/cleanup and maintenance rules.
- Its `features/` map covers conversation/stop, PR confirmation, and event delivery; it names alternate
  entry points and uncovered layers instead of claiming whole-product coverage.
- `formal/EventDelivery.tla` plus three configs: one worker, two events, one environmental crash;
  normal bounded exploration and two deliberately faulty controls.
- `formal/README.md`: properties, weak-fairness and persistence assumptions, code/test mapping and
  exclusions. No refinement proof or unbounded theorem is claimed.
- `scripts/verification/`: strict CLI, pinned tool setup, model runner, retained manifests and helper
  classification selftests. Public tool setup is explicit; subsequent verification uses local tools.
- `.github/workflows/formal-verification.yml`: path-filtered PR/manual CI configuration. Remote
  results must be checked separately; branch-protection requirements are not changed.

Local tools: Windows, Node v24.19.0, portable Temurin JRE 17.0.21+9, pinned Playwright Chromium
headless shell. Java/TLC were missing initially; downloaded public binaries were checksum-verified
into ignored `.cache/verification/`, without global installation or PATH changes. The JAR's release
URL is v1.8.0; its actual TLC banner is `2026.11.15.002146 (rev: bc1b506)`. Exact SHA-256 is pinned:
`7e53aa636dac8a3cb0533f343115c0548e03fc0ce5edc7739becf58d3d0fb84f`.

Commands exercised from the repo root:

```sh
node scripts/verification/setup-tla.mjs --java
node --test scripts/verification/verification.test.mjs
node scripts/verification/verify-otto.mjs doctor
node scripts/verification/verify-otto.mjs run all
corepack pnpm --filter @isaac2ingrid/steward test:browser
```

## Results and a real verification failure

The first combined run passed conversation assertions but correctly **failed** its evidence check:
body-only Playwright attachments were not durable files under the list reporter. Failed evidence
was retained at `.verification/evidence/1794798410292-6a056f1e-41db-423f-aa22-a1a7ceda3e15/`.
The fix writes PNG and public workspace-state JSON to per-test output paths before attaching them;
it does not relax the evidence requirement. The helper now requires one nonempty PNG, state JSON
and trace ZIP per selected browser journey, rejects skipped coverage and disables automatic retries.

Latest pre-publication combined run, after the independent Node-host type-generation repair
(base `47d6aa0` plus the pilot working tree):
`.verification/evidence/1794810164162-59c500f4-0580-485c-8aeb-b95a3cd3c8af/`.
The earlier successful pilot receipt remains at
`.verification/evidence/1794799006468-eb0a0410-e565-4e70-b8f2-24847beda2b7/`.
The local receipt reports `passed=true`, `inputStable=true`, with 294 declared input hashes.
Snapshots, logs, state JSON, PNGs and all five browser traces remain after cleanup; the controller
lock is absent. Ignored raw artifacts are local-only and are not guaranteed to accompany a clone.

| Check | Observed result |
| --- | --- |
| Combined browser journeys | 3 conversation/stop/reload + 2 PR confirmation/expiry passed |
| PR API/approval contracts, Node | 12 passed |
| Connector client/event contracts, including real sockets | 31 passed |
| Steward ledger/ack contracts, Node | 12 passed |
| New ack contract alone, workerd | 1 passed |
| Helper classification/strict-args selftests | 3 passed |
| Normal six-case browser suite, after opt-in evidence change | 6 passed |
| Steward and Node-host typechecks | Passed |
| TLC normal baseline | Exit 0; 1,545 distinct reachable states, queue exhausted, safety and AllResolved passed |
| Ack-before-persist negative control | Required exit 12; AckAfterPersist counterexample, 21 distinct states before rejection |
| Poison-event negative control | Required exit 13; AllResolved counterexample, 494 distinct states |

The counterexample-to-code bridge is explicit: a premature ack while the inbox is empty maps to
`event-ack-contract.test.ts`, which forces an inbox INSERT failure through the real handler and
asserts no ack, then successful, idempotent retry. The poison cycle maps to the existing oversized
event/archive/reconnect regression over a real payload-limited socket. These are reconstructions of
known fault classes, not newly discovered production incidents. Counterexamples are required to
fail for their named properties; parser errors or timeouts cannot count as successful controls.

## Limits and next decision

This is not a full joined steward + connector + live coding-agent acceptance run, phone-push
acceptance, model-quality measurement or formal code refinement proof. Local results are not
substitutes for remote GitHub CI receipts, which must identify the checked commit. The complete
repository suite was not rerun for this pilot; previous review results remain separate. Failed
journey artifact retention has been exercised by the helper's missing-artifact refusal, but this
is not an exhaustive fault-injection check of every reporter/cleanup failure.

Review future changes against the feature map and model-to-code table. Change policy/assumptions
separately from implementation; do not lower bounds or weaken assertions to manufacture green.
Only expand to another state machine after this small verification loop demonstrates value.
Offsite backup and restore work remain explicitly deferred and outside this experiment.
