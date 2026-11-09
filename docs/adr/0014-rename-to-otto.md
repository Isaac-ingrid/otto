# Rename the product to Otto

Status: accepted and implemented. Supersedes the branding decisions of [ADR-0002](0002-sig-brand-and-compatibility.md) (the name Sig, the ∑ mark, the `sig` command) and, with them, the identifier list [ADR-0009](0009-drop-shepherd-compatibility.md) established. ADR-0001's baseline decisions otherwise stand, with `sig` read as `otto` throughout.

The product is **Otto**, and the mark is the lowercase wordmark `otto` — not a symbol. Sig's name came from Sigma and its mark was ∑; that story stopped explaining anything once the name changed, so the wordmark replaces it in the same three-colour palette (`#DF806D`, `#438CA9`, `#D9A441`).

There is still no external user beyond the owner's own machines, so this is one break in the shape ADR-0009 used, not a compatibility layer. Everything the old name touched moves together:

| Was | Now |
| --- | --- |
| npm package `@isaac2ingrid/sig`, command `sig`, `bin/sig.js` | `@isaac2ingrid/otto`, `otto`, `bin/otto.js` |
| State directory `~/.sig`, `SIG_HOME`, `SIG_MACHINE_NAME` | `~/.otto`, `OTTO_HOME`, `OTTO_MACHINE_NAME` |
| Node host `SIG_DB_PATH`, `SIG_CONFIG_DIR` | `OTTO_DB_PATH`, `OTTO_CONFIG_DIR` |
| Child env strips `SIG_*` | strips `OTTO_*` |
| Session cookie `sig_session` | `otto_session` (the `ws1.` version prefix is unchanged) |
| Derivation strings `sig:keyid:v1`, `sig:channel-secret:v1` | `otto:keyid:v1`, `otto:channel-secret:v1` |
| Worker name `sig-steward` | `otto-steward` |
| Service label `dev.sig.connector` | `dev.otto.connector` |
| Worker branches `sig/<threadSlug>-<n>` | `otto/<threadSlug>-<n>` |
| Extension command `/sig`, `sig.command`, `sig.report-reminder`, `[sig:command <id>]` | `/otto`, `otto.command`, `otto.report-reminder`, `[otto:command <id>]` |
| Installed assets `sig-pi-<version>.ts`, `sig-report-<version>.mjs`; MCP key `sig` (tool `mcp__sig__report`) | `otto-pi-…`, `otto-report-…`, `otto` (tool `mcp__otto__report`) |
| Prompt sections `sig-situation`, `sig-notes`, `sig-role`; CSS class `sig-brand` | `otto-*` |
| Brand assets `brand/sig.svg`, `/brand/sig-avatar.png` | `brand/otto.svg`, `/brand/otto-avatar.png` |
| VPS layout `/opt/sig`, `/etc/sig`, `/var/lib/sig`, `sig.service`, `sig-backup.timer` | `/opt/otto`, `/etc/otto`, `/var/lib/otto`, `otto.service`, `otto-backup.timer` |

Deliberately unchanged:

- **`steward`.** It names the coordinating role ([CONTEXT.md](../../CONTEXT.md)), not the product: the Worker, the Durable Object and the workspace packages keep it.
- **The `sh_` table prefix.** It follows `docs/design/steward.md`, is never user-visible, and renaming it would mean a schema migration for no gain.
- **Historical records.** Earlier ADRs, research notes, spike conclusions and recorded eval output keep the names they were written with, per the convention ADR-0002 set. Read `sig` there as `otto`.

Consequences, all accepted pre-release. Every sealed secret and stored derivation was salted with the old string, so the database cannot be carried across: a deployment re-creates `steward.sqlite` and the owner re-pairs, re-registers repositories and re-picks a model. The VPS instance was rebuilt at the new paths rather than edited in place. On npm there is nothing to migrate: the published lineage under the upstream author's scope is theirs, not this project's, and nothing was ever published under the owner's scope ([ADR-0015](0015-owner-npm-scope.md)), so the first release is simply `@isaac2ingrid/otto@0.2.0`. Worker branches already created under `sig/` keep their names; only new ones use `otto/`. On
Cloudflare the renamed Worker is a new Worker with a new Durable Object, so the old
`sig-steward` has to be removed explicitly (`wrangler delete --name sig-steward`) instead of
being replaced by the next deploy.
