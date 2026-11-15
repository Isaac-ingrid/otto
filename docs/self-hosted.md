# Running Otto on your own machine

Otto's primary shape is the one on this page: the steward as a **single Node process** on a VPS, a home server, or a laptop — one SQLite file you can copy and back up, no Cloudflare account, no `wrangler`. The same steward also runs on Cloudflare ([deploy.md](deploy.md)) for owners who prefer a managed edge deployment; that is the alternative, and nothing below depends on it.

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
| `OTTO_PUBLIC_ORIGIN` | **Required in production on the Node host.** Canonical HTTPS origin (`https://<IP>` now, `https://<domain>` after 备案); protects absolute login links and pairing commands from forged Host headers. Only local loopback may use HTTP. |
| `SERVER_KEY` | Bearer token for the owner API, `/api/pairing`, `/api/login-link`. Optional. |
| `SERVER_KEY_PREVIOUS` | Accepted alongside `SERVER_KEY` during a rotation window. See below. |
| `MODEL_KEY` | Model provider key. The workspace **Settings** page writes the same thing at runtime. |
| `TAVILY_API_KEY` | Optional Tavily key for basic-only read-only web search. Takes precedence over Brave; never a model key. |
| `BRAVE_SEARCH_API_KEY` | Optional alternative Brave Search API key. Search is disabled when neither key is set. |
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
explicitly in the unit. **Before upgrading an existing Node deployment**, add
`OTTO_PUBLIC_ORIGIN=https://<current-working-IP-or-domain>` to `.dev.vars` (and to the local
untracked `deploy/aliyun.env` if using `apply-env.sh`). The production process now refuses to
start without it. It overrides any old `sh_deploy.origin` value immediately and replaces that
row on the next request; do not delete the database or re-pair machines just to set it.

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

`deploy/nginx-otto.conf` is the vhost. `Host` + `X-Forwarded-Proto` are needed for the request
origin (browser same-origin checks and WebAuthn); `OTTO_PUBLIC_ORIGIN` is the independent,
trusted address for absolute login links. The vhost rejects unknown Host names, **replaces**
`X-Forwarded-For` with `$remote_addr`, and strips client-supplied `CF-Connecting-IP`. Do not
switch back to `$proxy_add_x_forwarded_for`: the Node host uses the resulting address for
login rate limits. If adding an external trusted proxy, configure nginx real-IP with an explicit
proxy allowlist first. It also keeps `Upgrade`/`Connection` for both WebSocket paths
(the connector relay and the workspace stream), disables buffering, and raises
`client_max_body_size`.

```sh
sudo cp deploy/nginx-otto.conf /etc/nginx/conf.d/otto.conf
sudo sed -i 's/__OTTO_DOMAIN__/otto.example.com/' /etc/nginx/conf.d/otto.conf
sudo nginx -t && sudo systemctl reload nginx
```

`deploy/enable-tls.sh` renders that vhost, runs `certbot --nginx`, and switches the redirect to
live in two stages. **Only after ICP is effective**, use `--stage` briefly to verify routing;
it exposes HTTP without a redirect, so do not sign in, issue login links or pair machines on it.
Run `--live` immediately, then confirm HTTPS login and WebSocket before setting
`OTTO_PUBLIC_ORIGIN` to the domain. Keep the existing IP HTTPS vhost as a rollback path.

> On a mainland-China host, an A record alone is not enough: the provider will not serve 80/443 for
> a domain without ICP 备案. Until that is done, use the configured **IP HTTPS** vhost for sign-in
> and pairing. Keep the steward bound to loopback; do not sign in or pair over HTTP.

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

## Optional web search

Optional web search uses Tavily's or Brave's fixed HTTPS search endpoint. Only user-initiated turns can query
it, at most once per turn, using text from the user's message; the steward cannot fetch arbitrary
URLs or treat snippets as authorization to dispatch work or change memory in that turn. Results
include source links and a retrieval time but are **not** verified full-page research. Keep the
search key only in the protected `.dev.vars` file, restart `otto` after setting it, and remember
that search queries go to the chosen provider. Set `TAVILY_API_KEY` for Tavily or
`BRAVE_SEARCH_API_KEY` for Brave. If both are set, Tavily wins; failures do not trigger a second
provider request. Tavily is fixed to `basic`, five results, no automatic parameter selection,
no generated answer and no raw page content. This controls request cost, **not** account billing:
keep pay-as-you-go/automatic recharge disabled in the provider dashboard and set account limits.
Free quotas and pricing are provider policy and may change.

On Node, edit `sudo nano /etc/otto/.dev.vars`, add `TAVILY_API_KEY=YOUR_KEY` without removing
other settings, save, then run `sudo systemctl restart otto`. Never put a real key in shell
history or chat. If using `deploy/apply-env.sh`, retain the variable in the local untracked
`deploy/aliyun.env` too (the script replaces the remote configuration). Cloudflare deployments
can set the same name as a Worker secret instead. Do not send keys through chat.

## Web Push (optional)

Push is **off until a VAPID signing keypair is configured**. Otto only sends generic,
content-free alerts for owner decisions and worker reports; the signed-in workspace remains
where details and actions live. Each browser opts in separately under **Settings → Phone
notifications**, with a per-device 22:00–08:00 quiet period (device time zone, on by default).
Failed delivery is retried for up to 24 hours; the in-app inbox does not depend on push.

Generate a keypair **outside this repository** on the Linux host (Node 22+), with the stable
HTTPS origin or a contact email as VAPID subject. Copy `deploy/generate-vapid.mjs` to the host,
then as root:

```sh
node ./generate-vapid.mjs /etc/otto/vapid.env https://YOUR-CANONICAL-ORIGIN
install -d -m 0755 /etc/systemd/system/otto.service.d
printf '[Service]\nEnvironmentFile=/etc/otto/vapid.env\n' > /etc/systemd/system/otto.service.d/web-push.conf
systemctl daemon-reload && systemctl restart otto
```

The generator creates a root-owned `0600` file and prints only its path. Node reads these
variables from the systemd environment. Keep the private key separately in your password
manager for disaster recovery: the SQLite timer backs up the **database only**, and the
optional offsite backup currently includes `.dev.vars` but not this extra file. **Never commit
keys or paste them in chat.** Alternatively set all three keys in the protected `.dev.vars`
(and in the local untracked `deploy/aliyun.env` if using `deploy/apply-env.sh`, which replaces
that file in full). Cloudflare deployments can set the three names as Worker secrets; neither
host is required for the other. Do not rotate the keypair casually: existing browser
subscriptions need to opt in again after rotation.

The browser requires trusted HTTPS and permission from a direct tap. On iPhone/iPad (iOS 16.4+),
first add the Otto site to the Home Screen and open it from that icon; a Safari tab cannot
subscribe. After enabling, tap **Send a test notification** on that device; test sends immediately
(even during quiet hours), at most once a minute, and does not create a task. The current IP
HTTPS origin and any future domain are **different push origins**:
after switching to the domain, install/enable notifications again there. Delivery also depends
on the phone's network reaching its platform push service; test from the real phone/network
before relying on it. Signing out on a device removes its subscription; use the in-app pending
list as the fallback. No Telegram token or third-party message content is involved.

### FCM egress relay for restricted Node hosts (optional)

Android Chrome uses `fcm.googleapis.com` for Web Push. If the **server** cannot reach
that host over TCP 443, queued test notifications cannot be delivered. A host with a
working egress route needs no relay. On restricted networks, an optional Cloudflare
**Pages** project (not `workers.dev`, which may also be blocked) can forward only
signed, already-encrypted FCM Web Push requests. The Node server remains the steward;
the VAPID private key, task text and session cookies never go to Pages. Cloudflare
**does** see the browser's FCM subscription endpoint and encrypted notification, so
use this only if that trade-off is acceptable. The phone must independently reach
its own push service; a server relay cannot fix a phone with blocked FCM access.

Create a Pages project, store a random 32-byte base64url `RELAY_TOKEN` as a **Pages
secret**, then deploy `deploy/push-relay/` (it contains `_worker.js`). Configure the
**same** token and the production Pages URL ending in `/push` in a root-owned `0600`
`/etc/otto/push-relay.env` file as `OTTO_PUSH_RELAY_TOKEN` and `OTTO_PUSH_RELAY_URL`.
Add `EnvironmentFile=/etc/otto/push-relay.env` to an `otto.service.d` drop-in, then
`systemctl daemon-reload && systemctl restart otto`. Never put the token in Git,
URLs, browser settings, or chat. The relay rejects all unauthenticated requests and
all destinations except FCM Web Push paths; it does not follow upstream redirects
or return upstream response bodies. A direct 403 from `/push` without the token and
400 for an authenticated invalid request confirm access control, **not** phone
notification delivery. Back up this extra environment file separately or recreate
and rotate the token if the host is lost. Disable the relay by removing its systemd
drop-in and restarting Otto; direct Web Push remains available for other supported
browsers and network routes. Delete the unused Pages project after disabling it.

### When outbound calls time out from a slow-egress host

`connect ETIMEDOUT` for *every* address is not proof that a destination is blocked. Node races
the resolved addresses and aborts each attempt after 250 ms; a mainland-China host measured
250–370 ms to Cloudflare, so `fetch` failed ~85% of the time while `curl` and a plain
`net.connect` to the same address succeeded. The Node host raises that budget to one second
(`OTTO_TCP_HAPPY_EYEBALLS_MS`, `0` disables the race). Confirm a suspicious destination with
`curl -4 --max-time 10 https://HOST/` before blaming the route, and read the
`[otto] push failed reason=…` line in `journalctl -u otto`: it names the failure without
logging the endpoint, the keys or the payload.

## Backups

The database is one file. With WAL live, copy it with SQLite's own online backup:

```sh
sudo -u otto sqlite3 /var/lib/otto/steward.sqlite ".backup /var/lib/otto/backups/steward-$(date -u +%Y%m%dT%H%M%S).sqlite"
```

`deploy/harden.sh` installs exactly that as a daily systemd timer keeping 14 copies. That covers a
bad upgrade or an accidental delete; it does **not** survive losing the disk. The optional
`deploy/install-offsite-backup.sh` adds an `OnSuccess` job after the local snapshot and a weekly
isolated download/integrity check. It uploads the snapshot, `/etc/otto/.dev.vars`, and a checksum
manifest to a **configured rclone crypt remote only**; it refuses ordinary plaintext remotes.
It does not configure storage or credentials for you.

To enable it, choose off-host storage and install `rclone` on the server. As root, configure a
storage remote plus an **rclone crypt** overlay in `/etc/otto/rclone.conf` (mode `0600`), and
place `deploy/offsite.env.example` at `/etc/otto/offsite.env` (root-owned, mode `0600`), editing
`OTTO_RCLONE_DEST` to name the crypt remote and `RCLONE_CONFIG` to point to that config. Do not
put secrets in the repository or chat. Copy `deploy/offsite-backup.sh` and
`deploy/install-offsite-backup.sh` to the same directory on the server, then run as root:

```sh
bash ./install-offsite-backup.sh
systemctl start otto-backup.service         # local backup triggers encrypted offsite upload
systemctl start otto-offsite-backup.service # wait for (or retry) upload before verifying
systemctl start otto-offsite-verify.service # private temp download; does not restore production
systemctl status otto-offsite-backup.service otto-offsite-verify.service --no-pager
```

Inspect failures with `journalctl -u otto-offsite-backup -u otto-offsite-verify`. The remote keeps
snapshots until you define a retention policy with your storage provider; the local timer keeps
14. **Save the crypt configuration and its decryption passwords somewhere else** (for example,
your password manager): a copy inside the crypt remote cannot unlock itself after losing this
server. Verify a complete restore on an isolated host too: SQLite integrity check, the saved key
opening sealed model settings, and a connector reconnect. Checksums alone do not prove those
application-level steps. This repository contains no storage destination or credentials.

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

Run the read-only `deploy/doctor.sh` on the server to check `otto`/nginx, the IP certificate's
48-hour validity, recent local SQLite integrity, disk use, the last encrypted offsite
verification, overdue connector commands, overdue push retries, and pushes that exhausted
six attempts in the last 30 minutes. Older exhausted jobs within 24 hours are historical warnings,
not current failures (a cleared check is not proof of end-to-end phone delivery). Only aggregate counts are printed; payloads, endpoints
and credentials are never printed. Failures exit nonzero; intentionally unconfigured offsite
storage is a warning unless `OTTO_REQUIRE_OFFSITE=1`. No automatic task replay or alerts.
From a checkout, run `./deploy/remote.sh 'bash -s' < deploy/doctor.sh`.
An external monitor may alert on that exit status. This script checks the current IP-vhost
layout, not an arbitrary domain deployment.

### Scheduled health monitoring (Node only, optional)

Copy `deploy/doctor.sh`, `deploy/health-monitor.mjs` and `deploy/install-health-monitor.sh`
into the same directory on the server, then run `sudo bash install-health-monitor.sh`.
It installs `otto-health.timer` (every 15 minutes) independently of the Otto service.
The root-only state directory `/var/lib/otto-health` durably queues notices while Otto is down;
failed sends retry on the next check using stable IDs. The monitor reads the explicit
`SERVER_KEY` from `/etc/otto/.dev.vars` and sends only fixed check labels/event types to
loopback `/api/health-notice`; it never prints the key or starts a model turn.

Each check failure emits one Workspace message, with reminders at most every six hours,
and one recovery message when the check clears. Optional generic Web Push obeys device quiet
hours; Workspace history is the fallback. If the server, network or Otto is unavailable,
immediate phone notification is **not guaranteed**: use an external monitor for whole-host
outages. Health messages are conversation history, not questions requiring an answer.
Use `systemctl status otto-health.timer` and `journalctl -u otto-health.service` to inspect it;
`sudo systemctl disable --now otto-health.timer` disables future checks.

Machine online flags are reconciled against actual restored connector sockets at server startup:
Node restarts cannot leave a disconnected machine looking online, and Cloudflare hibernated
connections remain online. `lastSeen` records hello/connection transitions, not a periodic
heartbeat; its age alone is not proof that a long-lived connection is dead.

| Symptom | Cause |
| --- | --- |
| `Cannot find module 'ws'` at startup | the bundle is external on `ws`; put `ws` in `node_modules` next to `dist/` |
| Process starts, then every sign-in is refused | `LOGIN_PASSWORD` missing or rejected by the policy (length, commonness, breach); the reason is on the login page and in the journal |
| Settings changes and generated links disagree | check that `OTTO_PUBLIC_ORIGIN` matches the intended HTTPS entry point |
| Connector gets 401/4403 | machine revoked, or paired against a different origin/DB |
| Login links point at `127.0.0.1` | set `OTTO_PUBLIC_ORIGIN` to the canonical HTTPS origin and restart |
| IP HTTPS works but the domain does not | check ICP 备案, DNS, TLS certificate, and the domain vhost |
| `node:sqlite` not found | Node too old, or 22.x without `--experimental-sqlite` |

If you cannot sign in with a password or passkey, replace `LOGIN_PASSWORD` in
`/etc/otto/.dev.vars` with a new, unique password of at least 15 characters, then restart
`otto`. If you deploy via `deploy/apply-env.sh`, update the untracked `deploy/aliyun.env` too,
so a later apply does not restore the old value. Existing browser sessions and login links are
revoked; machine credentials and data are preserved. Never send the password in chat.

Logs are `journalctl -u otto -f`. The database browser is `sqlite3
/var/lib/otto/steward.sqlite` — `sh_run` is the run ledger (`status` is `open`/`settled`/`cancelled`),
`sh_outbound` the outbox, `sh_channel_log` the channel.

## Optional read-only PR / CI follow-up

[PR watches](pr-watches.md) bind a GitHub PR to an existing Thread through the explicit-SERVER_KEY
Owner API. A persistent timer checks external status without waking a model or dispatching a worker.
For private repositories, set `OTTO_GITHUB_READ_TOKEN` in the protected configuration to a
selected-repository, read-only token (Pull requests and Commit statuses), then restart Otto and
explicitly create a `statuses-only` watch. Fine-grained PATs in the current GitHub UI do not offer
Checks. The default `checks-and-statuses` mode requires a credential that can read Checks as well;
it does not automatically downgrade when access is denied.
No token is needed for public repositories, subject to GitHub rate limits. Watches expire, can be
cancelled independently of turns, and never modify code, re-run CI or merge a PR. No conversation
tool or workspace management page is included in this first pilot.

## What this shape is not

- **Not replicated.** One process, one Durable Object, one SQLite file. No HA, no second reader.
- **Not multi-tenant.** One owner per deployment, by design ([CONTEXT](../CONTEXT.md)).
- **Not a migration path in either direction.** The Cloudflare Durable Object's storage export and
  this file are the same schema, but nothing automates moving a deployment between them.
- **Not a smaller feature set.** Same steward, same workspace, same connector protocol; the
  difference is only who provides `ctx.storage`, alarms and sockets.
