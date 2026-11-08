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
| Workspace stream | open `/app` → workspace tab through the tunnel | SSE stays connected past a callback; no 502 after idle |
| Budget guard | set `DAILY_BUDGET_USD` low, send messages until it trips | message refused with the budget reason; ledger records the spend |
| Restart durability | `systemctl restart sig` mid-run | pending run resumes or is reported failed; no lost conversation |
| Model switching | switch model/thinking level in the composer | `model_changed` frame, next turn uses the new selection |
| Login | password login + `/api/login-link` link | session cookie issued; link works once, then expires |

Known divergence to watch: the Node host differs from workerd on one dispatch ordering test
(`docs/design/node-host.md`), so a dispatch that looks "out of order" in a card list is expected
to be cosmetic, not a bug.

## Log

- **2026-11-08** — VPS deployed under systemd on `127.0.0.1:8787`; the gateway model answered a
  real message (`sh_run` settled `done`, `sh_outbound` sent).
- **2026-11-09** — Connector pairing verified through the SSH tunnel: `dev_fbe47c5f3cac`
  (`isaac-mac`) reached the steward, `sh_machine.online = 1`, `maxWorkers = 8`, connector log
  shows `welcomed`. Run with `SIG_HOME=/tmp/sig-conn-test` so nothing touched `~/.sig`.
  Next: register a directory in the web workspace (needs a browser), then dispatch.

## P2 · Ops hardening (no domain needed)

- **Backup**: `SIG_DB_PATH` is one SQLite file. `sqlite3 .backup` to `/var/lib/sig/backups/` on a
  systemd timer, then `rclone copy` to the remote named in `RCLONE_REMOTE`. Untested so far.
- **Logs**: everything goes to journald. Set `SystemMaxUse=` or a `sig` drop-in; at 2 vCPU the
  steward is chatty during runs.
- **Restart safety**: `Restart=always` is set; add `StartLimitBurst`/`StartLimitIntervalSec` so a
  crash loop does not spin forever.
- **Unattended upgrades** for security patches only, and confirm the box survives a kernel reboot
  with `sig` and `nginx` both coming back.
- **Disk watch**: 32 GB free now; SQLite + WAL grew to 2 MB after one conversation. Set a
  threshold alarm (阿里云 cloud monitor) at 80 %.
- **Rotate `SERVER_KEY`** and reset the DB if the current key was ever exposed (see NOTES.md).

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
