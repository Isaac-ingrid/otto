# Sig on 115.29.164.8 (Aliyun ECS, Hangzhou)

Fresh notes for this box. Secrets live only in `deploy/aliyun.env` (untracked) and, on the
server, `/etc/sig/.dev.vars` (root:sig, 0640). Nothing here is a credential.

## What is installed

| Path | What |
| --- | --- |
| `/opt/node` | Node v24.22.2 tarball from `mirrors.aliyun.com/nodejs-release`, symlinked into `/usr/local/bin/{node,npm,npx}` |
| `/opt/sig/dist/node/steward-node.mjs` | the esbuild bundle, built on the Mac and shipped (the box has 1.7 GB RAM — do not build here) |
| `/opt/sig/dist/ui` | copy of `apps/steward/ui`; `createAssets` resolves `dist/ui` from the bundle's own directory |
| `/opt/sig/node_modules/ws` | the bundle's only runtime dependency (`ws` is external by design) |
| `/etc/sig/.dev.vars` | `SERVER_KEY`, `LOGIN_PASSWORD`, `MODEL_KEY`, `STEWARD_MODEL`, `DAILY_BUDGET_USD` |
| `/var/lib/sig/steward.sqlite` | the database (WAL) |
| `/etc/systemd/system/sig.service` | `User=sig`, `Restart=always`, binds `127.0.0.1:8787` |

`SIG_CONFIG_DIR=/etc/sig` is not optional: the default is derived from the bundle location and
would look for `.dev.vars` above `/opt/sig`.

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

## Reload after a code change

```bash
pnpm build:node                                   # on the Mac
./deploy/remote.sh --copy apps/steward/dist/node/steward-node.mjs /opt/sig/dist/node
./deploy/remote.sh 'systemctl restart sig && sleep 3 && systemctl is-active sig'
```

The UI is shipped separately (`--copy apps/steward/ui /opt/sig/dist/ui`) and needs no restart.

## Access today

Bound to loopback only, so no port is exposed while there is no name and no cert:

```bash
ssh -N -L 8787:127.0.0.1:8787 root@115.29.164.8   # then http://127.0.0.1:8787
```

`GET /` renders the sign-in page; `POST /api/pairing` with `authorization: Bearer $SERVER_KEY`
returns the `npx @alexlikevibe/sig connect …` line.

## Before this faces the internet

1. **ICP 备案** — a Hangzhou ECS cannot serve 80/443 to a domain without it.
2. `nginx` already owns port 80 on this box (it serves `/root/tstock/dist`), so terminate TLS
   there — `certbot --nginx` — instead of adding Caddy, which would want 80 for ACME.
3. Then set `HOST=0.0.0.0` + `PORT=8787` and put an nginx `location /` in front, keeping the
   service off the public interface itself.
4. `SERVER_KEY` is the root of every session, device token and sealed secret: rotate it (and
   reset the database, since `sh_model` is sealed under it) before real use if it was ever
   written somewhere it should not have been.

## 宝塔

Was running on `:8888` and started by `/etc/init.d/bt`. Stopped, disabled at boot, and its
`acme_v2.py` cron entry removed — it managed no sites (`/www/wwwroot` empty) and nginx here is
the distribution's own `/usr/sbin/nginx`, so nothing on 80 was affected. The files under
`/www` (1.5 GB) are kept for rollback; delete with `rm -rf /www` when you are sure.
