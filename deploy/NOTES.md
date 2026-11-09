# Otto on 115.29.164.8 (Aliyun ECS, Hangzhou)

Fresh notes for this box. Secrets live only in `deploy/aliyun.env` (untracked) and, on the
server, `/etc/otto/.dev.vars` (root:otto, 0640). Nothing here is a credential.

## Renamed from Sig (2026-11, [ADR-0014](../docs/adr/0014-rename-to-otto.md))

The box was rebuilt at the new paths rather than edited: the derivation strings changed, so the
old database could not be carried over anyway. What was done, in order: `systemctl disable --now
sig`; create the `otto` user and `/var/lib/otto`, `/etc/otto`, `/opt/otto`; install
`deploy/otto.service` (now the source of truth for the unit, it used to live only on the box);
copy the bundle and `apps/steward/ui`; `deploy/apply-env.sh` to write `/etc/otto/.dev.vars`;
then `deploy/harden.sh` again for the limits, journal cap and backup timer under their new names.
The connector was re-paired and `tstock` re-registered.

The old layout (`/opt/sig`, `/etc/sig`, `/var/lib/sig`, the `sig` user — 11 MB plus the
database) was removed after the new instance proved itself; its database and `.dev.vars` were
archived off the box first (`~/otto-archive/old-sig-state-20261109.tar.gz`, mode 600). Nothing
under `/opt`, `/etc` or `/var/lib` is named `sig` any more:

```bash
./deploy/remote.sh 'rm -rf /opt/sig /etc/sig /var/lib/sig && userdel sig'   # what was run
```

Renaming the connector's machine left a second `sh_machine` row for the same box (the pairing
mints a fresh device id). The stale `dev_c482db6a4879` rows — `sh_machine`, `sh_repo`,
`sh_worker`, `outbox`, `device` — were deleted so the workspace shows one machine, not two.


## Cloudflare side (optional, ADR-0014 follow-up)

Nothing to clean up: `npx wrangler delete --name sig-steward` answers
`This Worker does not exist on your account [code: 10007]` — the pre-rename Worker was never
deployed to this account (the Cloudflare path stays as the upstream default, unused here). If a
Cloudflare deployment ever becomes interesting again, `wrangler.jsonc` already says
`name: otto-steward`, so it would land as a new Worker with a fresh DO.

## What is installed

| Path | What |
| --- | --- |
| `/opt/node` | Node v24.22.2 tarball from `mirrors.aliyun.com/nodejs-release`, symlinked into `/usr/local/bin/{node,npm,npx}` |
| `/opt/otto/dist/node/steward-node.mjs` | the esbuild bundle, built on the Mac and shipped (the box has 1.7 GB RAM — do not build here) |
| `/opt/otto/dist/ui` | copy of `apps/steward/ui`; `createAssets` resolves `dist/ui` from the bundle's own directory |
| `/opt/otto/node_modules/ws` | the bundle's only runtime dependency (`ws` is external by design) |
| `/etc/otto/.dev.vars` | `SERVER_KEY`, `LOGIN_PASSWORD`, `MODEL_KEY`, `STEWARD_MODEL`, `DAILY_BUDGET_USD` |
| `/var/lib/otto/steward.sqlite` | the database (WAL) |
| `/etc/systemd/system/otto.service` | `User=otto`, `Restart=always`, binds `127.0.0.1:8787` |

`OTTO_CONFIG_DIR=/etc/otto` is not optional: the default is derived from the bundle location and
would look for `.dev.vars` above `/opt/otto`.

## Model

`STEWARD_MODEL` points at an OpenAI-compatible gateway:

```json
{"provider":"deepseek","modelId":"deepseek-v4.1-flash-1017","baseUrl":"https://ai.ctaigw.cn/v1","thinkingLevel":"high"}
```

`baseUrl` carries the `/v1`; the adapter appends `/chat/completions`. The model id is the
gateway's own snapshot name, which is not in pi-ai's catalog — `resolveCatalogModel`
(`apps/steward/src/llm/models.ts`) clones the provider's sibling entry under that id because the
selection names an endpoint. Verified end to end on this box: a `POST /api/messages` produced a
real Chinese reply, `sh_run.status = settled`, `resultStatus = done`.

**Switching the model from Settings wins over `.dev.vars`.** The Settings page writes the choice
(provider, model id, endpoint, thinking level) into `sh_model` row 0, and `mergeModelSelection`
lets a sealed row with a `modelId` beat `STEWARD_MODEL` — so editing `.dev.vars` after a runtime
switch changes nothing until that row is cleared:

```bash
./deploy/remote.sh 'systemctl stop otto && sqlite3 /var/lib/otto/steward.sqlite "DELETE FROM sh_model" && systemctl start otto'
```

Verified here: the composer switched this deployment from `high` to `low` (the switch keeps the
gateway `baseUrl`, otherwise it would silently re-point at `api.deepseek.com`), the next owner
message answered normally, and the level went back to `high`.

## Reload after a code change

```bash
pnpm build:node                                   # on the Mac
./deploy/remote.sh --copy apps/steward/dist/node/steward-node.mjs /opt/otto/dist/node
./deploy/remote.sh 'systemctl restart otto && sleep 3 && systemctl is-active otto'
```

The UI is shipped separately (`--copy apps/steward/ui /opt/otto/dist/ui`) and needs no restart.

## Reload log after a code change

`./deploy/remote.sh --copy apps/steward/dist/node/steward-node.mjs /opt/otto/dist/node` (after
`pnpm --filter @isaac2ingrid/steward build:node`), then `systemctl restart otto`. The box keeps the
bundle it replaced as `/opt/otto/dist/node/steward-node.mjs.prev`:

```bash
./deploy/remote.sh 'cp /opt/otto/dist/node/steward-node.mjs /opt/otto/dist/node/steward-node.mjs.prev'
./deploy/remote.sh --copy apps/steward/dist/node/steward-node.mjs /opt/otto/dist/node
./deploy/remote.sh 'systemctl restart otto && sleep 3 && systemctl is-active otto'
```

Rollback is the copy in reverse plus a restart. The Thread database is untouched by any of this;
`apps/steward/ui` only needs re-copying when the page itself changes.

## Access today

Bound to loopback only, so no port is exposed while there is no name and no cert:

```bash
ssh -N -L 8787:127.0.0.1:8787 root@115.29.164.8   # then http://127.0.0.1:8787
```

`GET /` renders the sign-in page; `POST /api/pairing` with `authorization: Bearer $SERVER_KEY`
returns the `npx @isaac2ingrid/otto connect …` line.

## Going public: `deploy/enable-tls.sh`

The vhost lives in git as `deploy/nginx-otto.conf`, rendered by `deploy/enable-tls.sh`. It is not
Caddy: nginx already owns 80 here (it serves `/root/tstock/dist`), and Caddy would want 80 for
ACME. nginx also ships without a `$connection_upgrade` map, which the script adds as
`/etc/nginx/conf.d/websocket-upgrade.conf`.

```bash
# 1. ICP 备案 must be done first — a Hangzhou ECS cannot serve 80/443 to a domain without it.
# 2. DNS A record -> 115.29.164.8, and set OTTO_DOMAIN (+ optionally OTTO_EMAIL) in aliyun.env.
./deploy/enable-tls.sh --stage   # vhost on :80, no cert: enough to check proxying
./deploy/enable-tls.sh --live    # certbot --nginx: 443 + http->https redirect
```

Both modes back up `/etc/nginx` first and abort if the domain does not resolve to this box.
Rehearsed on 2026-11 against a throwaway `server_name`: `nginx -t` clean, the `default` vhost
(tstock) still answered on its own `Host`, and the steward saw
`Host`/`X-Forwarded-For`/`X-Forwarded-Proto` with a live `upgrade: websocket`.

Two headers are load-bearing, not decoration: `node-host/server.ts` builds the request origin
from `Host` + `X-Forwarded-Proto`, and the app stores it in `sh_deploy.origin` to mint absolute
login links. Verified: a pairing call through the vhost returned
`npx … connect http://otto.test.invalid CODE`, i.e. the forwarded host, not `127.0.0.1:8787`.
The service itself stays on loopback; only nginx is exposed.

## Ops hardening: `deploy/harden.sh`

One idempotent script, run once on the box (it restarts `otto` and journald):

```bash
./deploy/remote.sh --copy deploy/harden.sh /tmp/
./deploy/remote.sh 'bash /tmp/harden.sh'
```

| Piece | Value | Why |
| --- | --- | --- |
| `otto.service.d/limits.conf` | `StartLimitBurst=10`, `StartLimitIntervalSec=300`, `RestartSec=3` | systemd's defaults (5 starts / 10 s) turn one transient failure into a service that stays down |
| same | `MemoryHigh=800M`, `MemoryMax=1200M` | box has 1.7 GB; a Node heap blow kills the steward only, never nginx/sshd, and `Restart=always` brings it back — workers live on the laptop, so a restart is survivable (verified) |
| `journald.conf.d/otto.conf` | `SystemMaxUse=200M`, `RuntimeMaxUse=64M` | the steward is chatty during runs; journal was 16 MB and unbounded |
| `otto-backup.timer` | daily 03:20 UTC (±5 min), `Persistent=true` | `sqlite3 .backup` is an online copy: consistent with a live WAL writer, no long lock |
| `otto-backup.service` | `/var/lib/otto/backups/steward-<utc>.sqlite`, keep 14 | bad upgrade / accidental delete recovery |

Verified after the first run: service `active`, limits in `systemctl show`, a real backup
written and `PRAGMA integrity_check` = `ok` (3 threads, 14 outbound rows inside). Off-box copy is
deferred on purpose (2026-11-09): the backup protects against mistakes, not against losing the
disk, and a restore without `/etc/otto/.dev.vars` re-pairs every machine anyway. `RCLONE_REMOTE`
plus a `rclone copy` step in the unit is the path if that trade ever changes.

`unattended-upgrades` was already installed and enabled (security pockets only, the distro
default), so the script only reports its state. A disk-usage alarm has to be created in the
Aliyun console (cloud monitor, threshold 80 %) — nothing on the box can raise it.

## Secret hygiene

`SERVER_KEY` is the root of every session, device token and sealed secret — and on this box it is
an *explicit* key (`sh_auth_deployment.mode = explicit`), so it is also the owner API bearer. If it
was ever written somewhere it should not have been, rotate it. Use the window, not a rebuild:

```bash
./deploy/rotate-key.sh status    # which key is where — ids only, never a secret
./deploy/rotate-key.sh open      # SERVER_KEY=new, SERVER_KEY_PREVIOUS=old, restart
./deploy/rotate-key.sh verify    # sealed row + connector token must both show the new id
./deploy/rotate-key.sh close     # drop the previous key; the rotation is final
```

Why a window and not a reset: `sh_model.apiKeyEnc` is sealed as `v2.<keyId>…` and each connector’s
device token is `st1.<keyId>…`, and both verifiers accept the previous key while
`SERVER_KEY_PREVIOUS` is set (issue #27, `test/rotation.test.ts`). The sealed model key re-seals
onto the primary on read; a reconnect makes the steward hand the connector a rekeyed token it
persists (`client.ts` → `store.updateToken`). Restarting `otto` is what forces that reconnect.
Swap under a single key without the window and the sealed model key stops opening (no model until
`MODEL_KEY` is entered again) and every paired machine that has not reconnected must re-pair.
`rollback` puts the old key back and is only meaningful while the window is open; after `close`
the old key exists solely in the `0600` backup under `~/.local/state/otto-key-rotation/`.

Reset the database instead — accepting that machines re-pair — only when the old key must die
*now*, or on a generated-key deployment (no `SERVER_KEY` in the env, keys live in the owner DO):

```bash
./deploy/remote.sh 'systemctl stop otto && rm -f /var/lib/otto/steward.sqlite*'
./deploy/apply-env.sh     # pushes the new key from aliyun.env and restarts
```

## 宝塔

Was running on `:8888` and started by `/etc/init.d/bt`. Stopped, disabled at boot, and its
`acme_v2.py` cron entry removed — it managed no sites (`/www/wwwroot` empty) and nginx here is
the distribution's own `/usr/sbin/nginx`, so nothing on 80 was affected. The files under
`/www` (1.5 GB) are kept for rollback; delete with `rm -rf /www` when you are sure.
