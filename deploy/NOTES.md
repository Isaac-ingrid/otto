# Otto on 115.29.164.8 (Aliyun ECS, Hangzhou)

This is *this box's* record. The box-agnostic version of the same runbook — secrets file, unit,
TLS, upgrades, backups, troubleshooting — is [docs/self-hosted.md](../docs/self-hosted.md); keep
the two in step when a step changes shape rather than only changing here.

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
| `/etc/otto/.dev.vars` | `SERVER_KEY`, `LOGIN_PASSWORD`, `MODEL_KEY`, `STEWARD_MODEL`, `DAILY_BUDGET_USD`, `WATCHDOG_LLM` |
| `/var/lib/otto/steward.sqlite` | the database (WAL) |
| `/etc/systemd/system/otto.service` | `User=otto`, `Restart=always`, binds `127.0.0.1:8787` |

`OTTO_CONFIG_DIR=/etc/otto` is not optional: the default is derived from the bundle location and
would look for `.dev.vars` above `/opt/otto`.

### The watchdog ask (off unless asked for)

`WATCHDOG_LLM=1` in `/etc/otto/.dev.vars` lets the steward take one look at a run that has gone
quiet for 20 minutes and re-plan it (`start_worker` with a rewritten brief) or ask the owner —
before the deterministic 45-minute verdict decides. Unset keeps the old behaviour exactly. It
costs one model call per silent stretch, and it rides the ordinary wake queue, so
`DAILY_BUDGET_USD` caps it like everything else. Turn it off again by deleting the line and
restarting `otto`. It lives in `deploy/aliyun.env` too, so `apply-env.sh` putting the file back
cannot silently turn the watchdog off (it rewrites `.dev.vars` wholesale).

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

One-command end-to-end upgrade from the Mac checkout (`scripts/deploy-vps.mjs`):

```bash
pnpm deploy:vps                  # build, SQLite .backup, ship bundle + ui + doctor.sh, guard ACME/TLS, restart & doctor
pnpm deploy:vps -- --apply-env   # also push deploy/aliyun.env -> /etc/otto/.dev.vars before restart
```

Manual step-by-step equivalent:

```bash
(cd apps/steward && node scripts/build-node.mjs)
./deploy/remote.sh --copy apps/steward/dist/node/steward-node.mjs /opt/otto/dist/node
./deploy/remote.sh 'rm -rf /opt/otto/dist/ui && mkdir -p /opt/otto/dist/ui'
./deploy/remote.sh --copy apps/steward/ui /opt/otto/dist/ui
./deploy/remote.sh 'chown -R root:otto /opt/otto/dist && chmod -R g+rX,o-rwx /opt/otto/dist'
./deploy/remote.sh 'systemctl restart otto && sleep 3 && systemctl is-active otto'
```

## Reload log after a code change

`pnpm deploy:vps` keeps the replaced bundle/UI as `/opt/otto/dist/node/steward-node.mjs.prev` and
`/opt/otto/dist/ui.prev`, takes an online SQLite `.backup` first, auto-heals the `:80` ACME
challenge block if overwritten, and rolls code back automatically if `otto.service` fails to start.

Workspace evolution `042–048` & ACME webroot decoupling deployment (2026-11-23):

- Landed migrations `042` through `048` (worktree diff & archive cleanup, checkpoint/skill
  distiller, 3-way stop, ambient memory/skill loop, PR CI/review/conflict triage, `Cmd+K` hybrid
  FTS5 search, multi-day budget/context telemetry, and machine repo policy + stale worktree audit).
- Fixed `node-host/main.ts` to prefer `../ui/workspace.html` (`/opt/otto/dist/ui`) on the VPS,
  aligned `deploy/apply-env.sh` `WANTED` (`OTTO_GITHUB_READ_TOKEN`, push relay vars), exempted
  offline `cleanup_worktree` rows in `deploy/doctor.sh`, and stripped macOS xattrs in `deploy/remote.sh`.
- Decoupled `otto-ip` Let's Encrypt HTTP-01 challenge from `/root/tstock/dist` (where `tstock`'s
  `location ~ /\.` rule blocked `/.well-known/acme-challenge/` with `403`) into `/var/www/letsencrypt`
  via `location ^~ /.well-known/acme-challenge/` in `/etc/nginx/sites-available/default`. Renewed
  certificate through `2026-11-29T23:26:26Z` and verified `deploy/doctor.sh` (`health checks failed: 0`).

Local-pi discovery deployment (2026-11-17, explicitly owner approved):
`/opt/otto/releases/agent-models-pi-local-catalog-9ac4510-dirty-20261117T085658Z/`.

- Backend SHA-256: `ce05ad70f5c0760ef7b1d4b1d82e9dfbf589de818b699ccdc60b8eb2780ebeeb`.
  All backend/UI asset hashes verified. No new migration; 038 remains applied. Env and steward
  model/provider-key/generation table hashes unchanged, including the final post-UI check.
- Full previous dist and consistent SQLite backup are under `previous/`. Roll back code only:
  stop otto, preserve current dist, copy previous dist back, restart and check health. Do not
  casually restore the database or erase later data.
- Local Windows release `~/.otto/releases/pi-local-catalog-20261117T085523Z/current/`:
  CLI SHA-256 `b59a192209593bb8d6c2dccc3187874358b2aaa3fcd2242bc2d1095603f73135`.
  Exact running predecessor (not a rebuild) plus SQLite backup retained alongside it. Pairing,
  Run key/autostart setup and all 11 existing workers/model facts retained unchanged.
- Source matched all 271 runtime/test inputs verified in experiment 0010; both builds passed.
  Actual production browser saw nine locally discovered models, default
  `ctaigw/deepseek-v4.1-flash`, collapsed Advanced, and a working metadata-only refresh with
  newer timestamps and matching local cache/server result. Settings/Machines and reload agree.
  Task default and steward model unchanged. No task, `set_model` or paid completion probe.
- Root 200, unauthenticated settings 401, forged public Host 421, SQLite quick-check ok, remote
  doctor zero failures; existing offsite-backup-disabled warning remains. No rollback needed.
  Evidence `.verification/evidence/pi-local-catalog-deploy/`; production auth traces/cookies
  are not retained there. Same package version 0.2.1; no npm publication, commit or push.
  Claude explicit selection remains disabled; broader provider/CLI/recovery acceptance is pending.

Pi-only pilot deployment (2026-11-17, explicitly owner approved):
`/opt/otto/releases/agent-models-pi-9ac4510-dirty-20261117T060239Z/`.

- Backend SHA-256: `4d8b62e20cd12b409dda44063fc5b4e1d5c34190ea022faf36851f96b52f05cc`.
  Backend/UI assets verified; migration `038_agent_model_selection` applied. Env and steward
  model/provider-key/generation table checksums unchanged. No npm publication, commit or push.
- `previous/dist/` and `previous/steward.sqlite` are the code/data backups. Code-only rollback:
  stop otto, preserve current dist, copy this release's previous dist back, restart and check
  health. Do not restore the database casually: retain the additive migration and later data.
- First attempt `/opt/otto/releases/agent-models-pi-9ac4510-dirty-20261117T060004Z/`
  retains the original pre-038 DB backup and failed candidate. It automatically rolled code
  back when the script incorrectly tested public Host rejection at the Node loopback root.
  Old code also returned 200 there; the public nginx boundary correctly returns 421. Corrected
  only the check target; no application/nginx/security policy was weakened.
- Windows connector runs a versioned private build at
  `~/.otto/releases/pi-models-20261117T055649Z/current/`, not the mutable checkout. Previous
  clean `9ac4510` build and pre/post-smoke SQLite backups are alongside it. Same package
  version 0.2.1; artifact identity is SHA-256
  `ac042f11209dd5463e9396f19edecf4781bec7db6c3ea8baebecee6ff40f2cc7`.
  Existing pairing retained; Run key/autostart installation unchanged. Claude explicit model
  selection is disabled; following its own default remains unchanged.
- Full Linux baseline gates passed; final pi-only delta: Linux connector 535, protocol 66,
  connector types; Windows 53 focused tests, recursive/Node-host types and builds. One actual
  production browser/steward/connector/pi/provider readonly task used only `read`/`report`
  against a synthetic fixture, returned its nonce and reached `reported:done`. Requested and
  CLI-observed model IDs matched. Previous default restored, temporary directory/registration
  removed, model facts retained after connector restart. Synthetic thread remains auditable.
- Final remote doctor: zero failures; existing offsite-backup-disabled warning remains.
  Evidence `.verification/evidence/pi-only-rollout/` retains successful checks and all failed
  setup/activation attempts. No production auth trace or session token is retained there.
  Broader provider/CLI/recovery acceptance and independent review are not claimed.

UI follow-up (2026-11-16): `/opt/otto/releases/model-ui-feedback-20261116T102012Z/`
updates only `workspace.js`, `i18n.js` and `workspace.css`, with checksums and a full prior UI
copy in `previous/ui/`. No service restart, migration or database write. Conflict/error feedback
now renders inside the settings modal instead of behind its backdrop; busy activation has an
inline explanation, visible disabled styling and live re-enabling when the reply ends. Nine
browser tests, 56 focused regressions, steward typecheck and the retained conversation journey
passed. Evidence: `.verification/evidence/model-conflict-ui/`. The backend version is unchanged.

Previous backend deployment (2026-11-16): model-selection candidate from `4daf270` plus the uncommitted
workspace changes (not a committed release). Release/receipt:
`/opt/otto/releases/model-selection-4daf270-dirty-20261116T093635Z/` and `deployment.json`.
Bundle/map and every UI asset passed SHA-256 checks before and after activation. The full old
`dist/` and integrity-checked SQLite snapshot are in that release's `previous/` directory.
Migration `037_model_drafts` applied; no credentials, model configuration, dependencies or
connector were changed. Code-only rollback: stop `otto`, preserve the current `dist/`, copy
`previous/dist/` back to `/opt/otto/dist`, and restart. Do not casually restore the database.

Local release checks: complete serial steward suite 888 passed, all seven isolated browser
journeys passed, health-monitor/improvement selftests and memory/routing/PR-intent faux selftests
passed. The earlier parallel suite's single alarm failure remains retained; its root cause was
not established, and the serial pass is not a claim that the parallel race was fixed. Deployment
health: service active, SQLite quick-check ok, public HTTPS 200, unauthenticated settings 401,
forged Host 421, doctor zero failures. Real-provider/owner acceptance is pending. Local evidence:
`.verification/evidence/model-selection-deploy/`. Existing offsite-backup warning remains.

Previous deployment (2026-11-16): `c77f6a5` (runtime source unchanged from CI-verified `b7c1220`).
Node bundle/map and all 19 UI files were checksum-verified before activation. Bundle SHA-256:
`d7d435a3cade23e51f2b866e1af67fd331f5680dcbb7db336302e972f19919c8`.
The release and receipt are `/opt/otto/releases/c77f6a5-20261116T065819Z/` and its
`deployment.json`. `previous/dist/` preserves the complete old bundle/map/UI;
`previous/steward.sqlite` is an integrity-checked pre-upgrade snapshot. Code-only rollback uses
that saved `dist/` plus a service restart; do not restore the database casually.

No active turns existed at activation. Migration remains `036_pr_watch_approvals`; database
quick-check passed. Local and outside-client HTTPS returned 200, unauthenticated workspace API
and WebSocket returned 401, and the forged-Host probe returned 421. `deploy/doctor.sh` reported
zero failures. No login/model/coding-agent acceptance was performed. Existing credentials,
model settings, systemd/nginx configuration and server `ws` 8.22.1 were preserved (the workspace
pin is 8.22.0; no dependency install or downgrade was performed). The local connector was not
upgraded, no npm package was published, and encrypted offsite backup remains disabled.
Verification skills and Java/TLC tools remain development-side, not installed on the VPS.

Previous recorded deployment (2026-11-13): `9fc76c7`, including `d25e65a`'s persistent PR watches and
`20a61d3`'s offline improvement tooling. Bundle SHA-256:
`4abc3a7479bee962d96ff7575d478cf96f56dc265744d5cadee9442b610f8552`.
Migration `035_pr_watch_evidence_mode` applied; existing config/data/UI were preserved. The
previous bundle/map and a verified SQLite snapshot live under
`/opt/otto/releases/9fc76c7/previous/` (root-only). Do not restore the database casually on rollback;
the schema addition is backward-compatible and restoring a snapshot would discard later data.

That earlier release's live [statuses-only acceptance](../docs/research/experiments/0003-statuses-only.md) verified a
synthetic failure → success, actual service restart, deduplicated notices and independent watch
cancellation. No model run, workflow creation or repository-file edit was involved. Checks access
with the selected-repository fine-grained PAT returned 403, so the scope was explicitly narrowed;
there was no automatic permission fallback and no claim of full CI success. The server-side
receipt is `/opt/otto/releases/9fc76c7/acceptance.json`. Deployment health checks passed; encrypted
offsite backups remain disabled. No credentials are recorded here.

Earlier deployments: `c11d787` — turns are serial and the working row can stop one
(ADR-0017); the live check with a real turn streaming is recorded in `docs/plan/self-hosted.md`.
Before that, `9d09ffa` — the dark instrument-panel theme (ADR-0016) — and `93c2b6a` — thread
frames rendered in place of refetching.

## Access today

Two ways in. The steward itself stays on loopback in both.

**1. The tunnel** — how the connector on a personal machine reaches the steward:

```bash
ssh -N -L 8787:127.0.0.1:8787 root@115.29.164.8   # then http://127.0.0.1:8787
```

**2. TLS on the bare IP** (2026-11-10, so a phone can reach the workspace while the domain sits in
ICP review): **`https://115.29.164.8`**.

Let's Encrypt issues certificates for IP identifiers now (January 2026), under the `shortlived`
profile with a 6-day lifetime, so a deployment without a domain can still serve real TLS. There is
no usable `certbot` on this box — Ubuntu 22.04 ships 1.21.0, too old for `--ip-address`, and
`snap install certbot --classic` never finished on this network — so it lives in a venv:

```bash
apt-get install -y python3.10-venv            # without it, venv creation dies on ensurepip
python3 -m venv /usr/local/certbot-venv
/usr/local/certbot-venv/bin/pip install -i https://mirrors.aliyun.com/pypi/simple/ certbot
ln -sf /usr/local/certbot-venv/bin/certbot /usr/local/bin/certbot    # 5.9.0
```

Issuance and renewal use a dedicated **decoupled webroot `/var/www/letsencrypt`** mounted on the
`:80` `default` vhost via `location ^~ /.well-known/acme-challenge/` (updated 2026-11-23 so `tstock`
dotfile `location ~ /\.` rules and frontend rebuilds under `/root/tstock/dist` never block renewal):

```bash
certbot certonly --preferred-profile shortlived \
  --webroot --webroot-path /var/www/letsencrypt \
  --ip-address 115.29.164.8 --cert-name otto-ip \
  --register-unsafely-without-email --agree-tos --non-interactive
certbot renew --dry-run                       # proves the challenge path end to end
```

A 6-day certificate needs care a 90-day one does not: certbot renews when 30 days remain, which is
*always* true here, so a plain timer run would renew every time and walk straight into Let's
Encrypt's duplicate-certificate rate limit. The renewal config therefore carries
`renew_before_expiry = 2 days`, and renewal is a systemd timer, not cron:

```
/etc/systemd/system/certbot-renew.{service,timer}          # 00:17 and 12:17, RandomizedDelaySec=3600
/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh      # systemctl reload nginx
```

The vhost is `deploy/nginx-otto-ip.conf` — `listen 443 ssl`, `server_name 115.29.164.8`,
certificate from `/etc/letsencrypt/live/otto-ip/`, still proxying to `127.0.0.1:8787`. For updates, copy `deploy/nginx-otto-ip.conf` and `deploy/apply-nginx-ip.sh` into
`/tmp/otto-nginx/`, then run `bash /tmp/otto-nginx/apply-nginx-ip.sh` through `deploy/remote.sh`.
The script renders the IP, checks `nginx -t`, reloads, waits for the new workers to accept
connections, probes normal/forged Host and restores
`/etc/nginx/sites-available/otto.pre-hardening` automatically if a check fails. **2026-11-11:**
three attempts rolled back while tightening the probe (the first had SSH quoting trouble; the
later ones tested in the very same second as `systemctl reload nginx` and reached old workers).
With a 3-second settle after reload, the live config passed: `nginx -t`, both units active,
loopback and outside-client `https://115.29.164.8/` returned 200, and the same requests with
`Host: attacker.example` returned 421. No domain vhost was installed. It is
deliberately **not** on `:80`: this box's `default` server answers `:80` *by IP* (`server_name _`)
with the tstock build, so a vhost carrying `server_name 115.29.164.8` on `:80` takes that traffic
over. Not theory — an earlier attempt installed exactly that, and `http://115.29.164.8/` served
Otto's sign-in page for two minutes before it was rolled back. Because `:80` is not ours, a plain
HTTP request can never be redirected from there, and typing `115.29.164.8:443` without a scheme
(which browsers read as `http://`) lands on the TLS port and gets nginx's
`400 The plain HTTP request was sent to HTTPS port`. The vhost answers that case with
`error_page 497 =301 https://<ip>$request_uri` — host hardcoded, so a crafted `Host` header cannot
turn it into an open redirect.

Verified from a client outside the box: `https://115.29.164.8/` → `200 Sign in - Otto` with the
chain validating against the public trust store and `subjectAltName = IP Address:115.29.164.8`;
`/app/api/workspace` → `401`; `POST /auth/password` → `401 {"error":"invalid_password"}` (so
sameOrigin passes and the password is really compared); a `wss://…/app/ws?view=workspace`
handshake reaches the app's `401` session gate in 70 ms; `:80` still answers the tstock page. The
cleartext run on `:8080` is gone (nothing listens, `ufw` rule deleted — drop the security-group
rule too). Roll back by restoring the cleartext vhost:

```bash
cp /etc/nginx/sites-available/otto.ip8080.saved /etc/nginx/sites-available/otto
nginx -t && systemctl reload nginx && ufw allow 8080/tcp   # plus its security-group rule
```

**Passkeys still cannot be used here, and that is the address's fault, not the browser's.** WebAuthn
defines the RP ID as a *valid domain string*, and an IP literal is not one
([w3c/webauthn#1358](https://github.com/w3c/webauthn/issues/1358)); the steward derives it from the
request host (`steward.ts`: `webauthnLoginVerify(url.hostname, …)`), so over `https://<ip>` the API
is present in the page but every ceremony throws `SecurityError`. The login page and the settings
dialog now detect an IP-literal host and say so, instead of offering a button that can only fail —
and once the domain is live, passkeys start working on their own.

**Historical 8080 incident (not the current 80/443 config).** The port in the `Host` header
was load-bearing. The first phone sign-in failed with
`无法连接 Otto，请检查网络后重试`, and the access log said `POST /auth/password 403`.
`sameOrigin()` (`src/index.ts`) compares the browser's `Origin` header against the origin the app
builds from `Host` + `X-Forwarded-Proto` (`node-host/server.ts`), and nginx's `$host` **drops the
port** — so the app saw `http://115.29.164.8` while the phone sent `http://115.29.164.8:8080`, and
every auth POST was `403 {"error":"forbidden"}` even though the page itself loaded fine. The then-fix was
`proxy_set_header Host $http_host;` in the 8080 vhost, after which the same probe returned
`401 {"error":"invalid_password"}` — sameOrigin passed. Today both vhosts use default ports and
pin the forwarded Host to their own literal name/IP; this also blocks raw Host-header injection.
If a non-default port is used again, forward its explicitly validated canonical host:port (not an
unchecked `$http_host`). The app's own error text was the reliable signal in this incident.

The login page also still carried Cloudflare-era copy — `Forgot your password?` told a self-hosted
owner to open *your Worker* in the Cloudflare dashboard — and it reported any non-401 answer as a
network failure, which is what sent the diagnosis after a network fault that did not exist. Both are
fixed in `apps/steward/ui/login.js` and `apps/steward/src/login-page.ts`: the recovery steps are now
split self-hosted vs Cloudflare, and a refused sign-in reports the HTTP status it got. The UI ships
with `--copy` and needs no restart; the static copy inside the bundle only changes on the next code
deploy.

`GET /` renders the sign-in page; `POST /api/pairing` with `authorization: Bearer $SERVER_KEY`
returns the `npx @isaac2ingrid/otto connect …` line.

This tunnel is the whole reachability story right now, and that has a consequence worth stating: a
paired connector stores the URL it was paired with (`~/.otto/connector.sqlite`), so a machine paired
through `127.0.0.1:8787` cannot come back online after a logoff or reboot until that tunnel exists
again — the connector retries and reconnects within a minute once it does (observed: `connection_closed
1006` until the tunnel returned, then `welcomed`), but nothing restarts the tunnel itself.

*Superseded 2026-11-11: the connector now points at `https://115.29.164.8` and the tunnel is
retired, so a reboot no longer needs it. The paragraph stays as the reason the tunnel existed, and
as the note to read before pairing a machine through a local forward.*

**Re-pointing a paired connector needs no pairing code (2026-11-11).** `serverUrl` in
`~/.otto/connector.sqlite` is local bookkeeping: the steward identifies a machine by `deviceId` +
`token`, so with the daemon stopped a single `UPDATE credentials SET serverUrl = ?` moved this
machine from `http://127.0.0.1:8787` (the tunnel) to `https://115.29.164.8`, and the next start came
back `welcomed` on the first try. `sh_deploy.origin` followed on its own — it is one row rewritten
by whichever request last reached the app. The tunnel is retired. `lastSeen` is written only on
connect, so "still online" is read from there being no `connection_closed` across several 25 s
heartbeats, not from a moving timestamp.

## Going public: `deploy/enable-tls.sh`

The vhost lives in git as `deploy/nginx-otto.conf`, rendered by `deploy/enable-tls.sh`. It is not
Caddy: nginx already owns 80 here (it serves `/root/tstock/dist`), and Caddy would want 80 for
ACME. nginx also ships without a `$connection_upgrade` map, which the script adds as
`/etc/nginx/conf.d/websocket-upgrade.conf`.

```bash
# 1. Before shipping the new Node bundle, set OTTO_PUBLIC_ORIGIN=https://115.29.164.8
#    in untracked aliyun.env, run apply-env.sh, and verify the IP HTTPS login still works.
# 2. ICP 备案 must be EFFECTIVE on Aliyun first: test http://ottocloud.cn/ for the block page.
# 3. DNS A record -> 115.29.164.8, set OTTO_DOMAIN (+ optionally OTTO_EMAIL) in aliyun.env.
./deploy/enable-tls.sh --stage   # brief :80 routing probe ONLY, no HTTP login/pairing
./deploy/enable-tls.sh --live    # certbot --nginx: 443 + http->https redirect
# Verify HTTPS login and WSS, then update OTTO_PUBLIC_ORIGIN=https://ottocloud.cn and restart.
```

Both modes back up `/etc/nginx` first and abort if the domain does not resolve to this box.
They also abort with `Permission denied (publickey,password)` when `OTTO_SSH_KEY` in `aliyun.env`
names a key that is not on this machine — it did (`~/.ssh/aliyun_sig`, since pointed at
`~/.ssh/id_ed25519_tstock`), and the script cannot tell that apart from a real auth failure.
Rehearsed on 2026-11 against a throwaway `server_name`: `nginx -t` clean, the `default` vhost
(tstock) still answered on its own `Host`, and the steward saw
`Host`/`X-Forwarded-For`/`X-Forwarded-Proto` with a live `upgrade: websocket`.

**Where it stands on the box (audited 2026-11-10, read-only).** Neither mode has been run against
the real name: `/etc/nginx/conf.d/otto.conf` does not exist (only `websocket-upgrade.conf`), there
is no `certbot` binary in the distribution and nothing listens on 443 for a domain vhost — the
venv `certbot` and `/etc/letsencrypt` belong to the by-IP certificate above, and the cleartext
`:8080` vhost has been retired). Everything else the step
needs is already in place — `otto.service` enabled with `Restart=always`, the memory/`StartLimit`
drop-in, `/etc/otto/.dev.vars` (root:otto 640), `otto-backup.timer` taking a daily online `.backup`
(15 kept, same disk only — an offsite copy is still a gap), and `ufw` allowing 80/443. Probing from a
client: `:80` answers `200` (the tstock site) but `:443` and `:8443` both **time out** rather than
refuse, which points at the Aliyun security group having no rule for them — that is a console step,
not something the scripts can do. So the resume order is: ICP review effective → security group 443 → short `--stage` probe
(**never** pair or log in on HTTP) → `--live` → verify HTTPS/WSS → update
`OTTO_PUBLIC_ORIGIN` and re-point the connector URL (no new pairing code needed).
(As of 2026-11-10 that security-group rule exists and `https://115.29.164.8` serves a trusted
certificate, so the by-IP path is already the working way in; the domain path stays unrun.)

**2026-11-11: the name resolves, and Aliyun intercepts it.** `ottocloud.cn` and `www.ottocloud.cn`
both point at this box, and nginx still sees nothing for them: `:80` answers
`403 Non-compliance ICP Filing` with `Server: Beaver` and a link to
`aliyun.com/beian/beian-block?id=…`. That answer comes from Aliyun's edge, not this machine — the
access log has zero requests for the name. So the filing is not effective for it (either not yet
granted, or granted through a different 接入商 that was never 接入备案 here). `:443` is *not*
intercepted: `openssl s_client -connect ottocloud.cn:443 -servername ottocloud.cn` completes a
handshake and gets this box's by-IP certificate back, because no vhost answers that SNI yet.

The consequence for this script: `--live` is `certbot --nginx`, i.e. HTTP-01 on `:80`, so it
cannot run until the block lifts. A certificate for the name is obtainable meanwhile by DNS-01 (the
zone is on Aliyun DNS, `dns7/dns8.hichina.com`), at the cost of a DNS-scoped AccessKey on the box
and an `:80` that still shows the block page to anyone who types the bare name. Diagnostic trap
worth remembering: a `Host: <name>` probe against the raw IP returned tstock's `200` *before* the A
record existed, which reads like a pass — Aliyun's check follows DNS, so only
`curl http://<name>/` after the record exists answers the question.

`Host` + `X-Forwarded-Proto` still determine the request origin for browser same-origin checks.
Historically they also determined absolute links: a rehearsal pairing call through the vhost
returned `npx … connect http://otto.test.invalid CODE`. That behaviour is superseded by
`OTTO_PUBLIC_ORIGIN` on the Node host: the configured HTTPS origin now wins for links and commands.
The service itself stays on loopback; only nginx is exposed. The new Node bundle uses
`OTTO_PUBLIC_ORIGIN` for absolute links and refuses production startup without it. Both vhosts
reject unknown Host headers and replace client-supplied IP headers before forwarding. Test the
rendered config with `nginx -t` and verify a forged Host returns 421. The box's nginx
has only one `:443` vhost; a raw `Host: attacker.example` must not reach Otto.

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
still pending an operator-owned storage target: local copies protect against mistakes, not losing
the disk. `deploy/offsite-backup.sh` and `deploy/install-offsite-backup.sh` now provide an opt-in
rclone-crypt-only upload plus isolated weekly download/integrity check, pairing each SQLite
snapshot with `/etc/otto/.dev.vars`. They are **not installed on this box** until an encrypted
remote, credentials and a separately safeguarded crypt config are provided. See
[the offsite backup runbook](../docs/self-hosted.md#backups).

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
