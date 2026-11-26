# Using Otto

[English README](../README.md) · [中文 README](../README.zh-CN.md)

## The owner API

This API requires an explicit `SERVER_KEY` and remains available for existing deployments and programmatic clients. New deployments can use the web workspace and machine pairing without configuring this API credential. The generated internal signing key is never exposed as a bearer token.

There is no chat channel for now ([ADR-0003](adr/0003-owner-api-replaces-chat-channel.md)). Browser authority comes from the deployment password or a registered passkey ([ADR-0010](adr/0010-browser-password-authentication.md)); holding `SERVER_KEY` authorizes the optional owner API. Natural language in, natural language out — the model dispatches through its `start_worker` tool (machine choice, branch relay, and the three-part done-report stay deterministic) and only ever disturbs you on its own initiative through `notify_user`/`ask_user`. In event-triggered runs its plain text output is discarded by structure — quiet by default is guaranteed by the code, not the prompt.

```sh
KEY="Authorization: Bearer $SERVER_KEY"

# Say something (the reply lands in the message list below):
curl -X POST https://otto.example.com/api/messages -H "$KEY" -H 'content-type: application/json' \
  -d '{"text": "把 repo-a 里的登录 bug 修了"}'

# Read what came back — replies, done reports, questions, digests (poll with ?after=<cursor>):
curl "https://otto.example.com/api/messages?limit=20" -H "$KEY"

# Quote a message to continue that Thread / answer its question:
curl -X POST https://otto.example.com/api/messages -H "$KEY" -H 'content-type: application/json' \
  -d '{"text": "改用 pnpm", "replyTo": "<message id from the list>"}'

# Press a button a message carries (ask options, PR consent [同意/先不要], offline asks):
curl -X POST https://otto.example.com/api/actions -H "$KEY" -H 'content-type: application/json' \
  -d '{"cardMsgId": "<message id>", "action": "pr_approve"}'

# Add a machine / open the web workspace:
curl -X POST https://otto.example.com/api/pairing     -H "$KEY"   # → run this on the new machine
curl -X POST https://otto.example.com/api/login-link  -H "$KEY"   # → one-time web login URL
```

Follow-up work continues relay-style (spec §5.3): the same agent on the same machine **resumes the previous session**, while a machine/agent switch, a bloated context (≥ 80%), or your explicit ask for a fresh perspective starts a **new session on the previous worker's branch**, prefixed with a deterministic handoff brief. You can also reach a worker mid-run — 「改用 pnpm」 goes out as a steer (where supported), 「停下那个」 aborts, and stopping only ever follows your explicit instruction. Across event-driven and follow-up wakes, `autoHops` caps unattended chains at 8 hops (`MAX_AUTO_HOPS = 8`) until you send a message or tap a card.

Additional `SERVER_KEY`-authenticated Owner API endpoints:

- `GET | POST /api/pr-watches` — list, create, or cancel read-only GitHub PR watches (see [pr-watches.md](pr-watches.md)).
- `GET | POST /api/inbound-sources` — configure (`action: "configure"`), snooze (`action: "pause"`), or deduplicate-replay (`action: "replay"`) verified webhook events sent to `POST /owner/in/github` and `POST /owner/in/gitlab`.
- `GET | POST /api/outbound-webhooks` — list, upsert, or remove SSRF-guarded signed outbound notification targets (`feishu` Schema 2.0 interactive cards with single-use 7-day workspace links, `generic` HMAC-SHA256 JSON, `dingtalk`, `wecom`, and `slack`).

The owner API has no stop route: ending a reply is a workspace action ([ADR-0017](adr/0017-turns-are-serial-and-cancellable.md)), and a `POST /api/messages` sent while Otto is answering queues behind that reply instead of interrupting it.

Two exact phrases stay deterministic and never reach the model — they mint credentials, so they must work without one: `/加机器` (also `/添加机器`, `/add-machine`) answers with the connect command, and `/网页` (also `/web`, `/login`) answers with a one-time login link. The same things exist as the `/api/pairing` and `/api/login-link` routes above.

## Local coding agents

**pi** is the default worker agent. When external coding CLIs are installed on a machine, the connector detects them automatically and advertises them in `hello.agents` alongside non-intrusive `authStatus` prechecks:

- **Claude Code (`claude`)** — headless `claude -p` stream-json execution with Otto's `report` / `propose` MCP tools, strict read-only execution (`--permission-mode plan` + read-only tools), cached input token accounting, and `rate_limit_event` reset-time extraction.
- **Codex CLI (`codex`)** — JSONL execution and resume (including macOS desktop app binary fallbacks and Windows sandbox read-only ACLs), transient stream error clearing on completed turns, and `readonly` support.
- **Antigravity (`agy`)** & **ACP v1 (`opencode`, `agentica`)** — JSON-RPC 2.0 ACP session management with worktree realpath permission checks and optional isolated `GEMINI_API_KEY` profiles (`otto agy-key`). Gemini CLI is intentionally omitted.
- **Local Command presets (`dsh`, `zcode`, `command`)** — locally allowlisted `CommandAdapter` templates spawned with `shell: false` and single-pass placeholder substitution.

Across `pi`, `claude-code`, and `codex`, clean exits that omit a structured `report` run at most **one read-only salvage pass** to recover the report without re-executing file edits or shell commands. When a provider or subscription hits a quota or rate-limit window (`error:rate_limited`), Otto parks the worker in `idle` (under `pi:<provider>` or `agent:<kind>` cooldowns), preserves its worktree and session, and resumes automatically once the window resets.

## The web workspace

`/app` is the owner's everyday entry ([ADR-0004](adr/0004-web-workspace.md)): one continuous conversation — the same local channel the owner API serves — with the Threads behind it, `Cmd/Ctrl+K` hybrid FTS5 search, a "Needs you" view over open decisions (questions, PR consent, PR stuck actions, cross-machine probe approvals, offline asks, routine and memory/skill suggestions), a 5-tab Control Plane (Memory, Schedules, Repo Skills, Budget & Telemetry, Machines & Worktree Audit), and the day's model spend against the budget cap. The page is plain HTML/ES modules with no frontend build and a CSP that forbids inline script and every other origin; it stays current over a browser WebSocket nudge and can show a reply as it is being written. The interface is English by default with an in-page EN/中文 switch, on one dark instrument-panel surface ([ADR-0016](adr/0016-dark-instrument-panel-theme.md)).

One turn at a time, and you can end it ([ADR-0017](adr/0017-turns-are-serial-and-cancellable.md)). A message sent while Otto is answering is queued — it is written to the run ledger before it is handed to the agent, so it survives a restart, and it is answered after the current reply rather than interrupting it. The "Otto is working" row carries a **stop** control: it withdraws a queued turn, or aborts the one being written, and answers with one line saying so. A stopped turn is not a failure — nothing is dispatched a second time, no failure notice arrives, and dispatches already made keep running (stopping a worker is `interrupt_worker`'s job, and the notice says so). Typing "stop" into the conversation is not a command yet; it would queue behind the turn it wants to end.

A Thread that is open in the workspace is also **followed live** ([protocol §6.9](design/connector-do-protocol.md)): the page asks the steward to subscribe the connection to that Thread, and new timeline rows, worker states and events are pushed as they happen instead of being polled. The snapshot stays authoritative — pushed rows are merged into it by id, so a row is never drawn twice — and an explicit refetch still follows every workspace change, just later and coalesced while the subscription is live.

Open the deployment URL and sign in with the deployment password or a registered passkey. Either method creates a seven-day browser session. Existing explicit-key deployments can still use `POST /api/login-link` for a single-use login link. For browser access and password recovery, see the [self-hosted runbook](self-hosted.md#troubleshooting), or the [Cloudflare runbook](deploy.md#recover-browser-access) for a Worker deployment.

Each Thread exposes its workers' **session records** ([ADR-0005](adr/0005-web-entry-and-local-sessions.md)): the full recorded session — messages, tool calls and results, images, compaction notes — streamed from the machine through the steward over the browser socket and never stored or logged server-side (protocol doc §6.6). The connector serves it from the live agent process or, once the process is gone, from the session file on disk, resumable with a cursor and bounded per page; an offline machine shows why the record is unavailable instead of an empty page. Machines are listed and revoked in the workspace too (撤销 bumps the device epoch and closes the connection with 4403, so a stolen token dies instantly).
