# Self-hosted steward — next steps

Status at the time of writing: the steward runs on the Aliyun ECS (`115.29.164.8`) under systemd,
bound to `127.0.0.1:8787`, with the gateway model answering real messages. What is *not* done is
a public entry point. Machine layout and ops commands live in [`deploy/NOTES.md`](../../deploy/NOTES.md).

Ordering principle: everything up to and including "P2" is testable through an SSH tunnel and
needs no domain, no certificate and no 备案. Only "P3" does.

## P1 · Flows to exercise on the VPS

| Flow | How to test today | Pass condition |
| --- | --- | --- |
| Connector pairing | tunnel to `127.0.0.1:8787`, `sig connect http://127.0.0.1:8787 <code>` | `sig status` shows paired; machine appears in **机器** |
| Worker dispatch | from the workspace, ask for a trivial repo task | run settles `done`, files land in the local repo, output returns to the chat |
| Workspace stream | open `/app` → workspace tab through the tunnel | live frames arrive and the socket survives idle ✅ |
| Budget guard | set `DAILY_BUDGET_USD` low, send messages until it trips | the cap gates *wakes*, not messages; ledger records the spend ✅ |
| Restart durability | `systemctl restart sig` mid-run | pending run resumes or is reported failed; no lost conversation ✅ |
| Model switching | switch model/thinking level in the composer | `model_changed` frame, next turn uses the new selection ✅ |
| Login | password login + `/api/login-link` link | session cookie issued; link works once, then expires ✅ |

Known divergence to watch: the Node host differs from workerd on one dispatch ordering test
(`docs/design/node-host.md`), so a dispatch that looks "out of order" in a card list is expected
to be cosmetic, not a bug.

## Findings

Real behaviour observed on the VPS that is not what a reader would assume:

1. ~~**Over budget swallows the result of dispatched work.**~~ **Fixed 2026-11-09** — a skipped
   wake whose deterministic half sent nothing (an `unreported` settle's open question, which has
   no deadline on purpose, §5.3) now forwards that question verbatim, through the same path the
   90-second timeout uses (`questions.forwardNow`), instead of letting the cap keep the owner's
   only notice. Failures that already pushed their evidence are still skipped as designed. See
   `docs/design/steward.md` §8 and `test/budget.test.ts`. The original observation follows.
   The cap is a cap on *wakes*, not on
   messages: `skipWake` (`apps/steward/src/steward.ts`) marks the worker's completion wake
   `skipped` and only counts it. Verified: with `DAILY_BUDGET_USD=0.05` and $0.10 spent, a
   read-only task was dispatched (`worker_event settled`, report produced), the wake row went
   `skipped`, `sh_usage_day.skippedWakes` became 1, and **no outbound message was ever queued** —
   the owner never sees the answer. `renderOverBudgetNote` claims "完成汇报、失败提醒、汇总卡片照常",
   which is true for deterministic cards but not for a worker that only reports. Either relay the
   report straight through the cap, or say so in the note.
2. ~~**`sweepWorkers` is armed without `{ idempotent: true }`.**~~ **Fixed 2026-11-09**, but not
   with `idempotent: true`: the SDK's dedupe matches on callback + payload and *ignores the
   delay*, so a leftover row armed with a longer interval would pin the chain to that slower
   cadence (and re-arming from inside the callback's own fire dedupes onto itself and kills the
   chain — `test/stall-reap.test.ts` catches both). Instead `onStart` → `resetWorkerSweepChain`
   cancels the predecessor isolate's `sweepWorkers` rows first, then arms exactly one chain; while
   that reset is in flight, `armWorkerSweeps` returns early so an interleaved cancel cannot eat
   the row it just created. The startup warning is gone (nothing is scheduled during the
   `starting` lifecycle), and no restart adds a second chain.
3. ~~**One outbound row took 61 s longer than its neighbour.**~~ **Explained 2026-11-09: not a
   bug.** It is the issue #11 quiet merge window. Re-read the two rows: both were
   `urgency = quiet` done-reports, `nextAttemptAt - createdAt = 60000` exactly, delivered 60.2 s
   and 60.7 s after creation — while every `push` row (owner replies, asks, failures) went out
   2–6 ms after creation. A quiet report waits out the 60-second merge window so several can
   fold into one message; the neighbour that "went out immediately" was a `push` row and never
   shared that window. The original observation follows. Row 8 was created 00:19:17 and sent
   00:20:18 (`attempts = 1`) while row 9, created 18 s later, went out immediately.

4. ~~**Every client's auth attempts shared one throttle bucket.**~~ **Fixed 2026-11-09** — on
   workerd the edge limiter keys on `CF-Connecting-IP`, which the platform fills in. nginx sets
   only `X-Forwarded-For`, so the Node host saw no address and every request bucketed as
   `unknown`: one stranger could spend the owner's five password attempts per minute. Fixed by
   synthesising the header in `node-host/server.ts` (`node-host/client-ip.ts`, unit-tested):
   an existing `CF-Connecting-IP` wins (so the workerd suite's fixed test IPs keep working when
   the same tests run on this host), `X-Forwarded-For` is only believed from a loopback peer —
   i.e. the nginx on this box — and otherwise the socket address is used. Verified on the VPS:
   five attempts from `203.0.113.5` then `429`, while `198.51.100.9` and the tunnel got their own
   `401`s and only the global 20/min bucket counted all of them.

## Log

- **2026-11-09** — **Login flows verified** and one real bug fixed. Wrong password → `401
  invalid_password`, right password → `200` with `sig_session` (HttpOnly, SameSite=Lax, 7 days),
  `/app` with that cookie → `200`, a login link works once (`303`) and then answers `410`.
  Also learned: `/auth/*` requires `Origin` to equal the serving origin (`403` otherwise) and
  sits behind two throttle layers — a per-scope edge limiter in `src/index.ts` and a per-purpose
  bucket table in the DO (`password`: 5/IP and 20 global per minute). The second layer was the
  only one doing anything on this box: see Finding 4.
- **2026-11-09** — **Workspace live stream verified** (the frame protocol, not SSE: the owner
  socket carries `stream` frames). A browser-equivalent client (`ws` + the `sig_session` cookie,
  `?role=web&view=workspace`) saw `workspace_changed` 5.2 s after an owner message, three
  incremental `stream` frames of the reply being typed, the closing empty frame, then another
  `workspace_changed`. `threadId` is `null` when the turn routed to no thread, which is correct
  for a status question.
- **2026-11-09** — **Thinking-level switching verified, after fixing two bugs it exposed.**
  `selectComposerModel` looked the model up in pi-ai's catalog, so a gateway's own model id —
  the one this deployment was already running — answered `model_not_available`; and it passed
  `baseUrl: undefined` into `setModelConfig`, which would have dropped the gateway endpoint and
  re-pointed the deployment at `api.deepseek.com` on the next turn. Now it resolves through
  `resolveCatalogModel` against the deployment's *current* selection (sealed row merged over
  `STEWARD_MODEL`) and carries that `baseUrl` through. Verified on the box: `high` → `low`
  → a real reply → back to `high`, with `baseUrl` intact throughout.

- **2026-11-08** — VPS deployed under systemd on `127.0.0.1:8787`; the gateway model answered a
  real message (`sh_run` settled `done`, `sh_outbound` sent).
- **2026-11-09** — Connector pairing verified through the SSH tunnel: `dev_fbe47c5f3cac`
  (`isaac-mac`) reached the steward, `sh_machine.online = 1`, `maxWorkers = 8`, connector log
  shows `welcomed`. Run with `SIG_HOME=/tmp/sig-conn-test` so nothing touched `~/.sig`.
- **2026-11-09** — First real dispatch through the VPS: `tstock` registered from the workspace,
  `POST /api/messages` → steward opened Thread「摸清 tstock 目录结构与入口文件」 → `start_worker`
  to `isaac-mac` → pi ran read-only in `/Users/isaac/agent/tstock` → 5 outbound messages, every
  `sh_run` settled `done`, `git status` in the repo stayed clean (0 files).
  Observed, by design but worth knowing: the worker's first report hit the length limit, so the
  steward re-ran the *same* worker with "re-send it smaller" — one extra worker run per long
  report. Login-link minting also exercised: valid token → 303, unknown token → 410.
- **2026-11-09** — **Restart durability passes**: a `systemctl restart sig` at 00:18:21 landed
  while worker `w_01M6XZ7BDC5Y5J9KFJ9PXKAZ4Y` was mid-run. The connector saw `connection_closed
  1006`, reconnected (`welcomed`) 1 s later, the worker kept emitting progress (it lives on the
  Mac, not the VPS), and its report was accepted after the restart — Thread went `waiting_you`
  with the full answer, so in-flight work survives a steward restart even though the in-memory
  worker registry does not.
- **2026-11-09** — **Budget cap behaves as documented for wakes**: `/花费` is answered without a
  model call (`spent $0.09 / cap $0.05, 399,772 tokens`), an owner message still dispatched while
  over budget, and the worker's settle wake was skipped once (`skippedWakes = 1`, `overNotedAt`
  set). See Findings 1 for what that costs the owner. Cap restored to $1 afterwards.

## P2 · Ops hardening (no domain needed)

Done by `deploy/harden.sh` (idempotent, re-runnable; details in NOTES.md):

- **Backup** ✅ `sqlite3 .backup` runs daily on a systemd timer into `/var/lib/sig/backups/`,
  keeping 14. Verified: file written, `PRAGMA integrity_check` = `ok`, live rows inside.
  Off-box copy is *not* done — needs `RCLONE_REMOTE`; until then this recovers from mistakes,
  not from losing the disk.
- **Logs** ✅ journald capped at 200 MB (+64 MB runtime) via a `sig` drop-in.
- **Restart safety** ✅ `RestartSec=3`, `StartLimitBurst=10` over 300 s, and a memory ceiling
  (`MemoryHigh=800M`/`MemoryMax=1200M`) so a Node heap blow takes only the steward.
- **Unattended upgrades** ✅ already installed and enabled (security pockets only, distro
  default); the script reports it rather than changing it.
- **Disk watch** — open: the alarm has to be created in the Aliyun console (80 % threshold).
  Nothing on the box can raise it. 32 GB free, DB 1.1 MB after several conversations.
- **Kernel reboot** ✅ rebooted the box: back in 53 s, `sig`/`nginx`/`ssh`/backup timer all
  `active`, `http 200`, DB intact (3 threads), and an owner message after boot answered from
  the gateway — so `SERVER_KEY` unsealing still works on a cold start. Note the SSH tunnel dies
  with the box; `ssh -f -N -L 18787:127.0.0.1:8787 …` has to be re-run after any reboot.
- **Rotate `SERVER_KEY`** — open, and it is the one remaining item with real exposure: the
  current value was echoed into a chat transcript. Rotation is *not* just an env edit —
  `sh_model` is sealed under it, so either reset the DB (`NOTES.md` → Secret hygiene) or set
  `SERVER_KEY_PREVIOUS` to the old value to keep the sealed secrets and device tokens open.

## P3 · Public entry point (blocked on 备案)

Deliberately deferred: a Hangzhou ECS cannot serve 80/443 to a domain without ICP 备案, so the
steward stays on loopback and testing uses a tunnel. Everything else is already prepared:

- `deploy/nginx-sig.conf` + `deploy/enable-tls.sh` (`--stage` then `--live`), rehearsed on the box.
- `deploy/aliyun.env` has empty `SIG_DOMAIN` / `SIG_EMAIL` fields waiting for a name.

When 备案 clears: DNS A record → `./deploy/enable-tls.sh --stage` → `--live`, then re-pair any
machine that was paired against the tunnel URL (the URL is part of the pairing).

## P4 · Product follow-ups from the Super-agent comparison

Only after the flows above are boring:

1. **LLM watchdog session** — the current watchdog is deterministic; the interesting Super-agent
   idea is a second model pass that decides whether a stuck run should be re-planned.
2. **Thread subscription passthrough** — let a watcher subscribe to a running thread instead of
   polling the ledger.
3. **Async start/stop with speculative execution** — start the next turn before the previous one
   is fully settled.
