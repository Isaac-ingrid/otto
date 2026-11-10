# The memory eval (steward.md §2.3–§2.5, §10.3; the memory-trust review)

Memory is the one place where a wrong answer gets *reused*: a stale fact quoted as evidence at a
worker, an unconfirmed report promoted to the resident layer, a confirmation inherited by a
different claim. Those are not routing mistakes with a percentage budget — a single leak is a
defect. So this eval is built the other way round from [the routing eval](routing-eval.md): a
scripted model (the faux provider, like `--selftest`), a real ledger with the real migrations and
the real notes module, and **exit code 0 only when every case holds**.

## Running it

```bash
cd apps/steward

pnpm eval:memory                    # all cases, no key, no network
node eval/run-memory-eval.ts --only evidence-gate-three-shapes
node eval/run-memory-eval.ts --verbose
```

Unlike `eval:routing`, this can run in regular CI: it is deterministic and spends no tokens. It
is not wired into `.github/workflows/ci.yml` yet — add it beside the test step when the case set
has more than one contributor's worth of history, so the gate does not churn.

## What the cases claim

Each case is a *claim about what the module is allowed to believe*, with a `why` that states the
regression it catches. The families:

| Family | The claim | Cases |
|---|---|---|
| confirmation | A confirmation is bound to the exact claim it was given for — it cannot be spent on a rewording, a negation, or another note. The identical claim still promotes. | `confirmation-not-transferable-negation`, `confirmation-promotes-the-identical-claim` |
| evidence | Memory used as a reason at a worker must be current, confirmed, and placed for **that worker's own repo**. | `evidence-gate-three-shapes` |
| history | A superseded version stays searchable (traceability) but is never current: it cannot be confirmed, and it cannot be revived by a later confirmation. | `history-cannot-be-confirmed` |
| retrieval | The current version leads its own history in `search`; a budget-limited `context()` reports what it left out instead of silently truncating. | `search-current-version-first`, `context-budget-reports-omitted` |

What each case asserts (see `MemoryExpectation` in `eval/memory-dataset.ts`):

- `results` — the model must *see* the refusal (or the confirmation) in a tool result. A boundary
  that blocks silently teaches the model nothing; the block reason is part of the contract.
- `relays` — answers that actually reached a worker, counted exactly (the stub records instead of
  sending). This is the "one leak" detector for the evidence gate.
- `leaks` — substrings that must not appear in any tool result or relayed answer.
- `state` — the end state of the fixtures (layer / status / confirmed).
- `search` / `context` — ledger-level checks with no model involved.

`status` is what separates the two intents the module now names: an **evicted** row stays
`active` (still true, just no longer in the layer) while a **superseded** row becomes
`superseded` (no longer the current fact). A case that starts passing because those two collapsed
back into one is the bug this family exists to catch.

## Adding a case

Add it to `MEMORY_CASES`. Prefer a *pair*: the boundary (refused) and its legal counterpart
(allowed), so a future over-tightening fails loudly instead of looking like caution. Fixtures are
declared in `seed`; a fixture may cite an earlier one via `supersedes`, which is also how
"current vs history" is set up. Keep the expectations in terms of the ledger's *state*, not the
model's prose.
