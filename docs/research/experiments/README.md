# Improvement Experiments

One directory of human-readable records, outside the evaluator and production memory. Procedure:
[Supervised Improvement of Otto](../../design/otto-improvement.md).

Copy [template.md](template.md) to a numbered file. Keep parent and rejected candidates as Git refs
before switching away; record them here. Reference raw results by path/fingerprint rather than
copying scores into a second source of truth. Review logs and artifacts for secrets before commit.

No automatic acceptance, agent launch, or production write is implied by adding a record.
