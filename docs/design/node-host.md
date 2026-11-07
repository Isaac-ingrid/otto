# Node host: running the steward outside Cloudflare

The steward is a Worker (`apps/steward/src/index.ts`) plus one Durable Object
(`Steward`). This document describes `apps/steward/node-host/`, a small adapter that
runs **that same code, unmodified**, on a plain Node process — for a self-hosted VPS,
a home server, or a laptop.

The Cloudflare deployment stays the default: `wrangler.jsonc`, `pnpm deploy` and the
workerd test suite are untouched. The Node host is a second runtime for the same
program, not a fork.

## Why an adapter and not a port

`apps/steward/src/steward.ts` and the Agents SDK only touch four platform APIs:

| Platform API | Used for | Count in `src/` + SDK |
| --- | --- | --- |
| `ctx.storage.sql` | all durable state (`sh_*`, FTS5, pi-durable sessions) | everywhere |
| `ctx.storage.transactionSync` | migrations, ledger invariants | 8 call sites |
| `this.schedule()` / alarms | ack retries, stall sweeps, routines, tickers | 16 call sites |
| WebSocket upgrade + `ctx.acceptWebSocket` | connector and workspace sockets | 2 paths |

Everything else — routing, the session gate, protocol, ledger, notes, dispatch, the pi
harness — is ordinary TypeScript. `cloudflare:workers` is imported by the Agents SDK for
exactly four names (`DurableObject`, `RpcTarget`, `exports`, `WorkflowEntrypoint`), and
`node-host/scripts/build-node.mjs` rewrites that one specifier to `node-host/cloudflare-workers.ts`
at bundle time. No `if (isNode)` branches, no duplicated business logic.

## What is shimmed

| Cloudflare | Node host | Notes |
| --- | --- | --- |
| `ctx.storage.sql.exec()` | `node-host/sqlite.ts` over `node:sqlite` | cursor-compatible: iterable, `.next()`, `.toArray()`, `.one()`, `.raw()`, `.rowsRead`/`.rowsWritten` |
| `ctx.storage.transactionSync` | `node-host/storage.ts` | genuinely synchronous (`BEGIN IMMEDIATE`); nesting becomes `SAVEPOINT` |
| `ctx.storage.transaction` | same file | async, used by pi-durable sessions |
| `ctx.storage.kv.get/put` | same file | synchronous KV the SDK's schema bookkeeping needs |
| `setAlarm`/`getAlarm`/`deleteAlarm` | same file + `node-host/runtime.ts` | persisted in `__host_alarm`, 250 ms poll, cleared before `alarm()` like workerd |
| `blockConcurrencyWhile` | `node-host/state.ts` | `__drain()` is awaited before every request, alarm and socket frame (the input gate) |
| `WebSocketPair`, 101 `Response` | `node-host/globals.ts`, `node-host/websocket.ts` | undici rejects `status: 101`, so `Response` is subclassed; `Symbol.hasInstance` keeps `instanceof Response` true for real responses |
| `ctx.acceptWebSocket` / `getWebSockets(tag)` | `node-host/state.ts` | in-memory registry; also installs `serializeAttachment`/`deserializeAttachment` on the global `WebSocket` prototype |
| DO namespace binding (`env.Steward`) | `node-host/namespace.ts` | one live instance behind a `Proxy`, so `getAgentByName()` and `stub.pair(...)` RPC both work |
| `env.ASSETS` | `node-host/env.ts` | serves `apps/steward/ui` from disk |
| `LOGIN_RATE_LIMITER` | same file | 10 requests / 60 s per key, in memory |

## What behaves differently

- **One instance.** A personal deployment has one steward (`owner`). Facets, sub-agents and
  Workflows are SDK features the steward does not use; they are not implemented here.
- **No hibernation.** Sockets live in the process. A restart drops them and the connector
  reconnects — the protocol already treats a dropped socket as normal
  (`apps/connector/src/client.ts` retries with the same device token).
- **No RPC serialization.** `stub.method()` is a direct call, so arguments are not cloned and
  errors keep their stack. Fine for one process; not a general DO emulator.
- **Alarm precision.** workerd arms real alarms; here a 250 ms timer polls the persisted row.
  The steward already assumes early or late alarms (`alarm.test.ts` pins that behaviour), and
  `resendUnacked` re-checks the row it is about to send, so polling is safe.
- **Not covered by the workerd test suite.** `pnpm test` still runs against workerd and stays
  the semantic baseline. The Node host has its own smoke path (below).

## Running it

```bash
cd apps/steward
pnpm build:node          # esbuild bundle -> dist/node/steward-node.mjs
pnpm start:node          # run it
pnpm dev:node            # build, then run
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIG_DB_PATH` | `apps/steward/data/steward.sqlite` | SQLite file (WAL mode) |
| `PORT` | `8787` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `SIG_CONFIG_DIR` | repo root | where `.dev.vars` is read from |

`.dev.vars` supplies the same values `wrangler dev` would: `LOGIN_PASSWORD`, `SERVER_KEY`,
`STEWARD_MODEL` (JSON), `DAILY_BUDGET_USD`, `MODEL_KEY`. As in production, the model API key
ends up in the sealed `sh_model` row, not in the environment.

The process refuses nothing that a Worker would refuse: the session gate, pairing lockout,
budget cap and push policy are all the same code.

## Smoke check

```bash
# 1. boot: the login page renders, the DO migrates on first contact
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/          # 200

# 2. owner API (Bearer SERVER_KEY)
curl -s -X POST -H "authorization: Bearer $SERVER_KEY" -H 'content-type: application/json' \
     -d '{"text":"hello"}' http://127.0.0.1:8787/api/messages

# 3. pairing code, then a connector handshake over ws://
curl -s -X POST -H "authorization: Bearer $SERVER_KEY" http://127.0.0.1:8787/api/pairing
```

Step 2 writes `sh_run`/`sh_outbound`/`pi_entries` and returns `200` with a ULID; step 3 plus a
`hello` frame yields a `welcome`. Both survive a restart of the process, which is the point of
keeping everything in SQLite.

## Deploying on a VPS

1. **Host.** 2 vCPU / 2 GB, Ubuntu 24.04, Node ≥ 22.18 (the repo's `engines` floor).
2. **TLS.** Caddy in front of `127.0.0.1:8787` (the app binds loopback in that case:
   `HOST=127.0.0.1`). Do not expose the port directly.
3. **Process.** systemd, `Restart=always`, `EnvironmentFile=/etc/sig/env`:

   ```ini
   [Service]
   WorkingDirectory=/opt/sig/apps/steward
   EnvironmentFile=/etc/sig/env
   ExecStart=/usr/bin/node dist/node/steward-node.mjs
   Restart=always
   RestartSec=2
   ```

4. **Backups.** WAL mode tolerates being copied with `sqlite3 ... ".backup"` while running:

   ```bash
   sqlite3 "$SIG_DB_PATH" ".backup '/var/backups/sig-$(date +%F).sqlite'"
   ```

   Keep seven days, ship them off the box (rclone to object storage). This file *is* the
   steward: ledger, notes, pi sessions, device tokens, sealed model key.
5. **Health.** Any `/` GET returning 200 means the process is up; the alarm and socket paths
   only run when there is work. Pair an external heartbeat with the systemd unit — a wedged
   process that still answers HTTP is the failure mode worth alerting on.
6. **Network region.** The model provider must be reachable from the host; behind the GFW
   that means `STEWARD_MODEL` pointing at an endpoint you can actually reach.

## When to prefer Cloudflare

If the requirement is not "inside my own network / my own disk / my own jurisdiction", the
Cloudflare deployment is cheaper to run: idle cost is ~0, alarms and hibernation are free,
and there is no process to babysit. Use the Node host when the constraint is where the state
lives, not when the constraint is effort.
