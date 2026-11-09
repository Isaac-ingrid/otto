# Running Otto on your own machine

Otto deploys to Cloudflare by default ([deploy.md](deploy.md)). This page is the other shape: the
same steward running as a **single Node process** on a VPS, a home server, or a laptop — no
Cloudflare account, no `wrangler`, one SQLite file you can copy.

It is not a port. `apps/steward/node-host/` supplies the four platform APIs the steward uses —
SQLite storage, a durable alarm timer, `WebSocketPair`, and an `env` object — so `src/` runs
unmodified. The design and the shims are written up in [node-host.md](design/node-host.md); this
page is the operator's runbook.

> The scripts under `deploy/` are the automation for the deployment this project actually runs
> (`deploy/NOTES.md` records that box). They are a template, not a product: the host name, paths
> and price assumptions in them are one machine's. Everything below can be done by hand.

## What you need

- **Node 24** on the host. `node:sqlite` is what persists everything, and it needs no flag there
  (on 22.x it is behind `--experimental-sqlite`).
- **pnpm 10** for the build (`corepack enable` is enough).
- **Linux with systemd** for the unit below; macOS works if you run the bundle under `launchd` or
  by hand.
- **A build machine with headroom.** The bundle is produced by esbuild; a 1.7 GB VPS can run it but
  is a poor place to build it. Build where you develop and ship the single file.
- **nginx** (or any proxy) in front if you want TLS. The steward itself binds loopback only.
- **Optional:** a model provider key — the setup wizard in the workspace can take it instead.

## What gets installed

| Path | What |
| --- | --- |
| `/opt/otto/dist/node/steward-node.mjs` | the bundle (~10 MB), built on your machine |
| `/opt/otto/dist/ui/` | copy of `apps/steward/ui`; served from `<bundle dir>/ui` |
| `/opt/otto/node_modules/ws/` | the bundle's only runtime dependency — `ws` stays external by design, so it must sit next to `dist/` |
| `/etc/otto/.dev.vars` | the secrets and settings (`root:otto`, `0640`) |
| `/var/lib/otto/steward.sqlite` | the database (WAL) |
| `/etc/systemd/system/otto.service` | the unit: `User=otto`, `Restart=always`, loopback only |

Build it:

```sh
pnpm install
pnpm --filter @isaac2ingrid/steward build:node   # → apps/steward/dist/node/steward-node.mjs
```

## 1. The secrets file

The steward reads the same names it would get from `wrangler secret put`, from `process.env` first
and then from `.dev.vars`. Two are worth understanding: `LOGIN_PASSWORD` is your browser login (at
least 15 characters; short, common and compromised passwords are rejected at startup), and
`SERVER_KEY` is optional — it exists for the programmatic [owner API](usage.md#the-owner-api), and
a deployment that only uses the browser never needs to set it.

| Name | Purpose |
| --- | --- |
| `LOGIN_PASSWORD` | Browser login. Required in practice. |
| `SERVER_KEY` | Bearer token for the owner API, `/api/pairing`, `/api/login-link`. Optional. |
| `SERVER_KEY_PREVIOUS` | Accepted alongside `SERVER_KEY` during a rotation window. See below. |
| `MODEL_KEY` | Model provider key. The workspace **Settings** page writes the same thing at runtime. |
| `STEWARD_MODEL` | JSON: `{"provider","modelId","baseUrl","thinkingLevel"}` for an OpenAI-compatible gateway. |
| `DAILY_BUDGET_USD` | Cap on model spend per day. |
| `WATCHDOG_LLM` | `1` lets the model take one look at a run that has gone quiet, before the deterministic verdict. Off unless set. |
| `LOGIN_LINK_TTL_MS`, `LOGIN_LINK_REUSABLE` | Lifetime and replay policy of `POST /api/login-link`. |

```sh
sudo install -d -o root -g otto -m 0750 /etc/otto
sudo install -o root -g otto -m 0640 /dev/null /etc/otto/.dev.vars
sudoedit /etc/otto/.dev.vars          # KEY=value, one per line
```

`apply-env.sh` in `deploy/` does this from an untracked local file and prints only names and lengths
— worth copying if you keep several deployments.

`OTTO_CONFIG_DIR` is the directory the process looks in for `.dev.vars`. Its default is derived
from the bundle's location (two levels up), which in this layout is the wrong place — set it
explicitly in the unit.

## 2. The service

`deploy/otto.service` is the whole thing:

```ini
[Service]
User=otto
WorkingDirectory=/opt/otto
Environment=OTTO_DB_PATH=/var/lib/otto/steward.sqlite
Environment=OTTO_CONFIG_DIR=/etc/otto
Environment=PORT=8787
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/node /opt/otto/dist/node/steward-node.mjs
Restart=always
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/otto
```

```sh
sudo install -d -o otto -g otto -m 0750 /var/lib/otto
sudo install -m 0644 deploy/otto.service /etc/systemd/system/otto.service
sudo systemctl daemon-reload && sudo systemctl enable --now otto
journalctl -u otto -n 20 --no-pager     # "[otto] steward listening on http://127.0.0.1:8787"
```

`HOST=127.0.0.1` is deliberate: with no proxy in front, nothing is reachable from outside. Point
`HOST` at a private address only if you know where the traffic comes from.

## 3. nginx and TLS

`deploy/nginx-otto.conf` is the vhost, and two headers are not optional:
`node-host/server.ts` builds the request origin from `Host` + `X-Forwarded-Proto`, and the app
stores it (`sh_deploy.origin`) to mint absolute login links. Drop either and the links you get back
point at `http://127.0.0.1:8787`. It also keeps `Upgrade`/`Connection` for both WebSocket paths
(the connector relay and the workspace stream), disables buffering, and raises
`client_max_body_size`.

```sh
sudo cp deploy/nginx-otto.conf /etc/nginx/conf.d/otto.conf
sudo sed -i 's/__OTTO_DOMAIN__/otto.example.com/' /etc/nginx/conf.d/otto.conf
sudo nginx -t && sudo systemctl reload nginx
```

`deploy/enable-tls.sh` renders that vhost, runs `certbot --nginx`, and switches the redirect to
live in two stages (`--stage` first, then `--live`) so a failed challenge cannot lock you out.

> On a mainland-China host, an A record alone is not enough: the provider will not serve 80/443 for
> a domain without ICP 备案. Until that is done, reach the box over an SSH tunnel
> (`ssh -N -L 18787:127.0.0.1:8787`) and use `http://127.0.0.1:18787` — the whole product,
> including WebSockets, works that way.

## 4. First sign-in, then machines

Open the origin you configured. The root URL serves the sign-in page once Otto has a
`LOGIN_PASSWORD`; signing in creates a seven-day browser session. The setup wizard asks for the
model provider key if `MODEL_KEY` is unset.

Then pair a computer from **Machines** — the same connector as the Cloudflare path
([usage.md](usage.md#local-coding-agents), [agent-connect.md](agent-connect.md)). The connector
only makes outbound connections, so no port opens on your machines.

If you set `SERVER_KEY`, the owner API works over the same origin:

```sh
KEY="Authorization: Bearer $SERVER_KEY"
curl -X POST https://otto.example.com/api/messages -H "$KEY" -H 'content-type: application/json' -d '{"text":"在吗"}'
curl -X POST https://otto.example.com/api/pairing -H "$KEY"    # → run this on the new machine
```

## Upgrades and rollback

Ship the bundle, keep the one it replaced, restart:

```sh
sudo cp /opt/otto/dist/node/steward-node.mjs{,.prev}
# copy the new bundle and dist/ui into place
sudo chown -R root:otto /opt/otto/dist && sudo chmod -R g+rX,o-rwx /opt/otto/dist
sudo systemctl restart otto && sudo systemctl is-active otto
```

Rollback is the same copy in reverse plus a restart. The database is untouched by a bundle swap;
the UI is a plain directory copy and needs no restart. Re-copy `ui/` whenever the page changes —
the bundle does not carry it.

Schema changes ship inside the bundle and run at startup, so **back up before an upgrade** if the
release notes mention migrations.

## Backups

The database is one file. With WAL live, copy it with SQLite's own online backup:

```sh
sudo -u otto sqlite3 /var/lib/otto/steward.sqlite ".backup /var/lib/otto/backups/steward-$(date -u +%Y%m%dT%H%M%S).sqlite"
```

`deploy/harden.sh` installs exactly that as a daily systemd timer keeping 14 copies. That covers a
bad upgrade or an accidental delete; it does **not** survive losing the disk. For that, copy the
dumps off the box (`rclone`, `scp`, whatever you already run) — deliberately left as your call
here, because it needs credentials of yours.

## Cost and the model

Model spend is capped per day by `DAILY_BUDGET_USD`; the workspace header shows today's spend and
the "Today" panel shows the derived cost per reply. Two behaviours surprise people:

- **Switching the model in Settings beats `.dev.vars`.** The choice is written to `sh_model` row 0
  and a sealed row with a `modelId` wins over `STEWARD_MODEL`. To go back to the file, clear the
  row while the service is stopped:
  `sqlite3 /var/lib/otto/steward.sqlite "DELETE FROM sh_model"`.
- **A gateway endpoint is part of the selection.** An OpenAI-compatible `baseUrl` is stored with the
  model; a switch that loses it re-points at the provider's public default.

## Hardening

`deploy/harden.sh` is optional and idempotent. It caps the journal (a chatty run should not fill
`/`), widens systemd's restart window so one transient crash is not a permanent outage, sets a
memory ceiling so a Node heap blow takes only the steward, and installs the backup timer above.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Cannot find module 'ws'` at startup | the bundle is external on `ws`; put `ws` in `node_modules` next to `dist/` |
| Process starts, then every sign-in is refused | `LOGIN_PASSWORD` missing or rejected by the policy (length, commonness, breach); the reason is on the login page and in the journal |
| Settings changes and hand-written pages disagree | the origin is wrong: check `Host` and `X-Forwarded-Proto` reach the process |
| Connector gets 401/4403 | machine revoked, or paired against a different origin/DB |
| Login links point at `127.0.0.1` | the proxy is not forwarding `Host` |
| Everything works over the tunnel but not on the domain | ICP 备案 (mainland host), or the vhost is not the one answering |
| `node:sqlite` not found | Node too old, or 22.x without `--experimental-sqlite` |

Logs are `journalctl -u otto -f`. The database browser is `sqlite3
/var/lib/otto/steward.sqlite` — `sh_run` is the run ledger (`status` is `open`/`settled`/`cancelled`),
`sh_outbound` the outbox, `sh_channel_log` the channel.

## What this shape is not

- **Not replicated.** One process, one Durable Object, one SQLite file. No HA, no second reader.
- **Not multi-tenant.** One owner per deployment, by design ([CONTEXT](../CONTEXT.md)).
- **Not a migration path in either direction.** The Cloudflare Durable Object's storage export and
  this file are the same schema, but nothing automates moving a deployment between them.
- **Not a smaller feature set.** Same steward, same workspace, same connector protocol; the
  difference is only who provides `ctx.storage`, alarms and sockets.
