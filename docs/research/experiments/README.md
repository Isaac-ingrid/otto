# Improvement Experiments

One directory of human-readable records, outside the evaluator and production memory. Procedure:
[Supervised Improvement of Otto](../../design/otto-improvement.md).

Copy [template.md](template.md) to a numbered file. Keep parent and rejected candidates as Git refs
before switching away; record them here. Reference raw results by path/fingerprint rather than
copying scores into a second source of truth. Review logs and artifacts for secrets before commit.

[Experiment 0008](0008-verification-skill-tla-pilot.md) records the project-local verification skill
and bounded event-delivery TLA+ pilot, including retained failures and the model-to-code bridge.

[Experiment 0009](0009-pi-model-selection-acceptance.md) records the authorized, isolated real-pi
model/cold-send checks, the failed local unknown-ID preflight and the remaining release gates.

[Experiment 0010](0010-pi-local-model-discovery.md) records the local-discovery follow-up:
installed pi metadata instead of library suggestions, refresh/cache/advanced-input boundaries,
scripted browser/transport checks, metadata-only real CLI observation and the subsequently
owner-authorized production refresh check (no task/completion probe).

No automatic acceptance, agent launch, or production write is implied by adding a record.
