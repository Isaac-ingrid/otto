# The npm scope is the owner's identity

Status: accepted. Supersedes [ADR-0013](0013-alexlikevibe-npm-scope.md).

ADR-0013 moved the packages to `@alexlikevibe/*` because that was the npm identity the code was
being written under, and publishing `@nightboats/*` had been blocked. That identity belongs to the
upstream author, not to this deployment: `@alexlikevibe/sig@0.1.3` is published by
`alexlikevibe <gfanfei@gmail.com>`, so it can neither be deprecated nor republished from here, and
the two namespaces have no relationship beyond a shared history.

Everything therefore moves to the owner's identity, `@isaac2ingrid`:

| Was | Now |
| --- | --- |
| `@alexlikevibe/otto` (public, the connector) | `@isaac2ingrid/otto` |
| `@alexlikevibe/protocol` | `@isaac2ingrid/protocol` |
| `@alexlikevibe/steward` | `@isaac2ingrid/steward` |
| `@alexlikevibe/preview-machine` | `@isaac2ingrid/preview-machine` |
| `docs/adr/0013-alexlikevibe-npm-scope.md` | keeps its name: it is a record of what was decided then |

The scope equals an npm account name, so `@isaac2ingrid/otto` is only publishable once the npm user
`isaac2ingrid` exists — it does not yet (checked 2026-11 against the registry's user document).
The three workspace packages are `private` and never touch the registry; only the connector is
published, and it is the only name where an npm account matters.

Consequences. Nothing is migrated, deprecated or bridged: no version of this project was ever
published under `@isaac2ingrid`, so `@isaac2ingrid/otto@0.2.0` is the first release and there is no
upgrade path to write. Machines running the CLI from a checkout — which is how this deployment runs
it — are unaffected. `apps/connector/README.md` keeps the publish runbook, including the fact that
`publishConfig.registry` has to pin `registry.npmjs.org` because the local `~/.npmrc` points at the
read-only `npmmirror`. Historical records (ADR-0001, ADR-0008, ADR-0013) keep the old scope names,
per the convention ADR-0002 set.
