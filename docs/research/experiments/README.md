# Improvement Experiments

One directory of human-readable records, outside the evaluator and production memory. Procedure:
[Supervised Improvement of Otto](../../design/otto-improvement.md).

Copy [template.md](template.md) to a numbered file. Keep parent and rejected candidates as Git refs
before switching away; record them here. Reference raw results by path/fingerprint rather than
copying scores into a second source of truth. Review logs and artifacts for secrets before commit.

[Experiment 0008](0008-verification-skill-tla-pilot.md) records the project-local verification skill
and bounded event-delivery TLA+ pilot, including retained failures and the model-to-code bridge.

No automatic acceptance, agent launch, or production write is implied by adding a record.
