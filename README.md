<p align="center">
  <img src="apps/steward/ui/brand/otto.svg" alt="Otto" width="88" height="88">
</p>

<h1 align="center">Otto</h1>

<p align="center"><strong>Your agents, in one conversation.</strong></p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

**Otto is an always-on coordinator for the coding agents on your computers.** You talk to one personal agent in a web workspace; it remembers ongoing work, routes tasks to local agents, and brings their progress and decisions back to the same conversation. The steward runs on your own server, while the agents work in repositories you choose on your own machines.

- **An always-on coordinator.** The steward stays online on your VPS even when your computers are asleep; it keeps conversations, memory, scheduled follow-ups, and SHA-256-approved local zero-token probes. Local coding work waits for an available connector.
- **One conversation across machines.** Tasks, decisions, follow-ups, live context/tool telemetry and progress stay together, searchable via `Cmd/Ctrl+K` hybrid FTS5 search, with optional OS desktop notifications (`otto notify`), Web Push, and signed outbound webhooks (Feishu Schema 2.0 cards, DingTalk, WeCom, Slack, Generic HMAC).
- **Your code stays on your machines.** A connector runs **pi**, **Claude Code**, **Codex CLI**, **Antigravity (`agy`)**, ACP v1 agents (**OpenCode**, **Agentica**), or locally allowlisted command presets (**`dsh`**, **`zcode`**) with per-repo write isolation (`worktree`/`in-place`), concurrency (`parallel`/`serial`), and optional approved hooks; full coding-agent session records stay on local disk.
- **Resilient quota handling & report salvage.** Rate-limit or subscription-window exhaustion (`error:rate_limited`) parks the session in `idle` under a per-`(machine, provider/agent)` cooldown table and auto-resumes with zero LLM calls when the window resets; clean `unreported` runs execute at most one read-only salvage pass to recover structured reports.
- **Memory, skills & control plane with boundaries.** Otto keeps preferences and project conventions separately from conversation history (tracking source and confirmation), mines cross-session repo patterns to propose new or updated `SKILL.md` skills only with sufficient evidence and owner approval, and provides deterministic worker checkpoints, dual-ledger budget/telemetry charts, and read-only worktree audits with guarded cleanup.
- **Read-only PR follow-up & zero-checkout blind review.** Bind a GitHub PR to an existing task Thread to monitor CI checks, diagnose failing logs, detect merge conflicts, triage trusted reviews, and alert on stalled PRs (`>2h`). With your confirmation, Otto extracts `git_pr_diff` directly from git objects without checking out branches or touching dirty worktrees, and runs an author-isolated cross-engine read-only review.
- **You stay in control.** Stopping a reply, stopping/interrupting a worker (with 5-state stop diagnostics and inline interrupt), and cancelling a PR watch are three separate operations, backed by an 8-hop `autoHops` circuit breaker against unattended event loops.

## Architecture

```text
Browser workspace (Cmd/Ctrl+K search · 5-tab Control Plane) / optional Owner API
                │ HTTPS / WebSocket  (+ verified /owner/in/github|gitlab & signed outbound webhooks)
                ▼
Your VPS: Otto steward (Node.js + SQLite + FTS5)
  ├─ deterministic core: events, deadlines, quota cooldowns, PR triage, probe schedules, queues
  ├─ LLM steward: routing, judgment, summaries, tool calls, skill distillation (autoHops <= 8)
  └─ ledger: Threads, decisions, notes, dual-ledger budget/telemetry, repo policies
                ▲ outbound WebSocket connections
                │
Connectors on macOS / Linux / Windows
  ├─ local adapters: pi, Claude Code, Codex CLI, Antigravity (agy), OpenCode / Agentica (ACP), dsh / zcode
  └─ local relays: worktree diff/audit/cleanup, zero-checkout PR diff, SHA-256 probes, checkpoints, repo skills, desktop notify
```

The steward uses a single persistent SQLite database; connectors initiate connections, so your computers need no inbound ports. Repository contents and complete coding-agent session records stay on those computers. The steward and local agents use separately configured models. The **same steward logic** can alternatively run on [Cloudflare Workers + a SQLite-backed Durable Object](docs/design/node-host.md); the VPS deployment uses a Node host adapter rather than a separate product.

## What makes the design different

- **A ledger, not an endless prompt, carries continuity.** Threads, worker reports and provenance-aware notes live outside the LLM transcript. Each turn sees a fresh, bounded situation brief; compaction does not have to serve as the project's memory.
- **Code handles certainties; the model handles judgment.** State transitions, deadlines, local zero-token probes (`otto probe`), quota-cooldown timers, and routine completion notices do not need an LLM call. The model handles ambiguous routing, questions and summaries. If it is unavailable or over budget, deterministic fallbacks still surface pending decisions.
- **Actions have durable boundaries.** Owner turns are recorded before execution, processed serially and cancellable; dispatched work continues independently. Idempotency keys, `promptAccepted` session-start markers, and durable queues make retries and restarts recoverable, while tool checks require a verifiable source before event-triggered work can be dispatched and `autoHops` caps unattended chains at 8 hops.
- **Memory is inspectable.** Notes distinguish user-confirmed facts from worker reports and inferences, and distinguish replacing an outdated fact from archiving one for space. [Architecture details](docs/design/steward.md) · [Turn design](docs/adr/0017-turns-are-serial-and-cancellable.md).

### Ideas adapted from Super Agent & agent-autoloop comparisons

Rather than copying external orchestrators wholesale, Otto selectively adopted concrete mechanisms while keeping its ledger and approval boundaries explicit ([Super Agent follow-ups](docs/plan/self-hosted.md#p4--product-follow-ups-from-the-super-agent-comparison) · [agent-autoloop adoptions](docs/plan/agent-autoloop-adoptions.md)):

- **Watchdog re-planning:** an optional model pass can reconsider a stalled worker and re-plan or ask you. It is **off by default** (`WATCHDOG_LLM`); the deterministic stall verdict still applies.
- **Live Thread following:** the workspace subscribes to Thread events and state over WebSocket, with a timeline cursor for resuming, instead of relying solely on polling.
- **No speculative parallel turns:** starting a second answer before the first settles risks missing conversation context or dispatching the same intent twice. Otto instead keeps turns serial, durable and stoppable.
- **Dual-granularity quota cooldowns & one-shot report salvage:** rate-limited runs (`pi:<provider>` or `agent:<kind>`) park in `idle` rather than `broken` and resume automatically once the reset timestamp arrives; clean exits missing `report` run at most one read-only salvage turn.
- **Zero-token local probes & zero-checkout blind PR review:** recurring checks run locally approved scripts under `~/.otto/probes/` without waking the LLM unless triggered, and PR blind reviews inspect bare git diffs (`core.hooksPath=/dev/null`) in a clean or cross-engine read-only session without checking out branches.

### Bounded web search (optional)

Otto is not a general-purpose cloud browser. Configure `TAVILY_API_KEY` for Tavily basic search, or `BRAVE_SEARCH_API_KEY` for Brave; search stays off without either key. If both are configured, Tavily takes precedence, with no automatic fallback request to another provider. Tavily requests use basic search, at most five results, no automatic parameter upgrades, generated answer or raw page content.

Search is limited to one request per owner turn, using a query drawn from the owner's message. Results include source URLs and retrieval time, but remain **untrusted snippets, not verified full pages**; old or irrelevant results can still appear. Search and action tools cannot run in the same turn: web content cannot authorize worker dispatch, commands or memory changes. This is not a live weather tool. Coding work needs an online connector; the cloud steward can still converse, remember and schedule while your computers are asleep.

Basic search limits request cost, **not account billing**. Provider free quotas and pricing may change; keep pay-as-you-go/automatic recharge disabled and set account limits in the provider dashboard. See [search configuration](docs/self-hosted.md#optional-web-search).

Optional **Web Push**, **local desktop notifications**, and **signed outbound webhooks** stay off until explicitly enabled:
- **Web Push** works on supported desktop and mobile browsers once the server has VAPID keys and each device opts in under **Account / Settings → Phone notifications → Enable on this device** (quiet hours default to 22:00–08:00 in that device's time zone; on iPhone, add Otto to the Home Screen first). Alerts contain generic prompts, never task text. See the [self-hosted guide](docs/self-hosted.md#web-push-optional).
- **Desktop notifications (`otto notify on`)** surface local worker completions, questions, and quota holds via native OS tools (`osascript`, PowerShell `NotifyIcon`, `notify-send`) with zero runtime dependencies, skipping headless SSH sessions automatically.
- **Outbound webhooks (`/api/outbound-webhooks`)** deliver SSRF-guarded notifications to Feishu Schema 2.0 interactive cards (with 7-day single-use `sh_web_link` URLs), DingTalk, WeCom, Slack, or generic HMAC-SHA256 endpoints.

## Get started

You need an **always-on cloud server** for the steward (Linux with Node.js 24, a service manager, persistent storage and an HTTPS address that your computers can reach). Build with the pnpm version pinned in [`package.json`](package.json) (install Corepack if `corepack` is unavailable); enter the steward's model-provider API key in the workspace after sign-in. Each connector computer needs **Node.js 22.18+** — macOS, Linux or Windows — and a separately installed and authenticated coding agent. Otto's model key does not configure the local agent.

### 1. Deploy the steward to your cloud server

Build from a checkout on a machine with enough memory (this can be your development computer; a small VPS need not build the bundle itself):

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @isaac2ingrid/steward build:node
mkdir -p apps/steward/dist/ui
cp -R apps/steward/ui/. apps/steward/dist/ui/
```

Then follow the [cloud-server runbook](docs/self-hosted.md) to install **`apps/steward/dist/node/steward-node.mjs`, `dist/ui/` and the `ws` runtime dependency** on the server. Set a unique `LOGIN_PASSWORD` of at least 15 characters and `OTTO_PUBLIC_ORIGIN=https://<your-address>` in its protected `.dev.vars`; set `OTTO_CONFIG_DIR` and `OTTO_DB_PATH` explicitly. Run the process under systemd (automatic restart), bind it to loopback, and put an HTTPS reverse proxy with WebSocket forwarding in front. Keep the VPS and its persistent disk running **24/7**; back up the live SQLite database with SQLite's online backup, not a plain copy while WAL is active. Do not commit secrets or send them through chat.

Local snapshots help recover from a bad upgrade or accidental changes, but copies on the same VPS disk do not survive losing that disk or instance. For experiments with replaceable data, local backups can be a starting point; add encrypted offsite backups and a restore check as you accumulate important, unique history. See [backups](docs/self-hosted.md#backups).

Open **your server's HTTPS address**, sign in and enter the steward's model API key in **Settings**. Optionally configure `TAVILY_API_KEY` (or `BRAVE_SEARCH_API_KEY`) in the protected server environment for read-only, owner-turn web search; it is separate from the model key and disabled when unset. The server must be reachable from every computer you want to connect; an SSH tunnel to a loopback-only address is useful for private access, but not a public connector endpoint.

**Done when:** the workspace is reachable at its intended address and Otto replies to a message. You can chat before adding any machines.

### 2. Connect a computer

On a macOS, Linux or Windows computer with Node.js 22.18+ and a configured local coding agent, install the published connector:

```sh
npm install --global @isaac2ingrid/otto
otto --version
```

In Otto's workspace, open **Machines → Add a machine → Create pairing command**. Run the generated command *on that computer* with its actual URL and short-lived code, using the installed CLI:

```sh
otto connect <your-otto-url> <one-time-pairing-code>
otto status
```

The code expires after 10 minutes and is single-use; keep it out of chat and logs. Pairing installs and starts a background service — launchd on macOS, a systemd user service on Linux, and a per-user logon entry (the `Run` key plus a generated `~/.otto/otto-daemon.vbs`) on Windows. When that is not possible on this machine (a session that cannot reach its service manager, or a Windows logon entry the machine's policy forbids), `connect` says so *before* redeeming the code, so a retry costs no new code — and `--foreground` runs the daemon in the current terminal instead; the machine that is already paired and only lacks that entry has `otto install`, which writes the service for the saved credential and needs no code. `otto status` reports which of the two is in play; on Windows the connector starts at the next logon and the launcher runs it under `otto daemon --supervise`, so a daemon that dies comes back on its own with backoff until `otto stop` says otherwise.

The connector calls out to Otto, so the computer needs no inbound port. In **Machines**, add only the local directories you want Otto to work in, then try a small read-only task. By default Otto passes no model flag, so the local agent uses its **own** default provider. With a connector that advertises model selection, **Settings → Local coding-agent models** (also available in **Machines**) can set a separate task default for each machine/agent. Explicit model selection in the picker is currently enabled for `pi` (showing models discovered locally by that machine's `pi`, discovery-time default and timestamp, manual refresh, and Advanced custom IDs); other installed CLIs (`claude`, `codex`, `agy`, `opencode`, `agentica`) follow their own configured defaults (and for Antigravity, `otto agy-key` can configure an isolated `GEMINI_API_KEY` profile inside `~/.otto` without touching `~/.gemini`). It applies to new sessions; resumed sessions retain their original model request. No local-agent key is stored in Steward; if a provider hits a rate-limit window, Otto parks the session in `idle` and resumes automatically after cooldown. `otto status` and `otto doctor` print the agents Otto will actually run and flag `NOT SPAWNABLE` executables; `otto probe` manages locally SHA-256-approved zero-token probe scripts under `~/.otto/probes/`; `otto notify` toggles local OS notifications; `otto logs -n 50` shows why a machine did not come online. For a proxy, a host without a service manager, or a source installation, see the [connector runbook](docs/agent-connect.md).

**Done when:** the machine and its chosen directories appear online and the test task returns a result. Repeat for each computer.

## Use Otto

Try asking:

> “Review the login flow in my-app and tell me what you find.”
>
> “Fix that bug on my Mac using pi.”
>
> “Continue the previous task, and use pnpm this time.”

The workspace brings together messages, task threads, decisions, connected machines and session records. Replies stream as they are written; a message sent mid-answer waits its turn.

### Search without granting action authority

After configuring a search key in the server's protected `.dev.vars` and restarting Otto, try:

> “Search for the latest Node.js security announcements. Include source URLs and retrieval time.”

The owner has exercised this path with Tavily on the self-hosted Node deployment. That validates the basic query/response flow, not the accuracy or freshness of every result. Check publication dates and official sources before relying on a security claim; the retrieval time is not a publication date. Search does not open the full pages. Any follow-up action needs a separate owner turn, not authorization inferred from a snippet. Keep search keys out of chat, Git and shell history; they are separate from the model key.

### Follow a PR & run zero-checkout blind reviews

In an existing task Thread, ask:

> “Keep following https://github.com/owner/repo/pull/42 in this Thread. Only commit statuses, check every 15 minutes for one hour, and notify me when successful. Show a confirmation card first; do not start a worker.”

Check the card's PR, Thread, evidence scope, interval and lifetime, then use its **dedicated confirm button**. The model only proposes the watch; typing “yes”, quoting agreement or answering an ordinary question cannot authorize it. A confirmation expires after ten minutes. Ask “Which PRs are being followed?” to inspect watches, or “Cancel PR watch `<watch-id>`” to get a cancellation card; cancelling also needs its dedicated confirmation.

Polling, status-change notices and restart recovery run without an LLM turn or connector. When CI fails, reviews arrive, or a PR stalls past two hours, Otto surfaces structured diagnostics or a deduplicated stuck-watch card — where you can authorize a **zero-checkout blind PR review** (`git_pr_diff` with `core.hooksPath=/dev/null`, preferring a different engine family from the author worker and leaving local working trees untouched). **Commit statuses are not Checks/Actions:** `statuses-only` always discloses the missing coverage, and Otto does not silently downgrade full-scope requests when permissions fail. Watches never modify code, re-run CI or merge PRs. See [PR follow-up](docs/pr-watches.md) for scope, limits and the explicit authenticated Owner API.

## Local development & upgrades

From a repository checkout, `pnpm local:*` runs an isolated Steward (`http://127.0.0.1:8787`) and Connector (`mac-local-dev`) under `/tmp/otto-local-test` without touching your paired `~/.otto` service:

```sh
pnpm local:up
pnpm local:restart
pnpm local:restart steward
pnpm local:restart connector
pnpm local:status
pnpm local:logs
pnpm local:down
pnpm local:reset
```

`pnpm local:up` builds both packages, generates local `.dev.vars`, auto-pairs the connector on first boot, and prints a one-click sign-in URL.

For source-linked connectors, self-hosted VPS upgrades, and read-only production verification (using an untracked `deploy/aliyun.env` for `deploy/remote.sh`):

```sh
pnpm connector:restart
pnpm deploy:vps
pnpm deploy:vps -- --apply-env
pnpm verify:prod
```

`pnpm connector:restart` rebuilds `apps/connector` and restarts your paired background service (run `otto install` once after service-unit updates without re-pairing; `PiAdapter` defaults to a 20s startup RPC timeout). `pnpm deploy:vps` backs up SQLite online, uploads the gzipped Steward bundle atomically with SSH drop retries and automatic rollback on failure, checks ACME renewal, and runs `deploy/doctor.sh`. `pnpm verify:prod` performs zero-secret smoke checks across local Connector state, local-vs-remote bundle SHA-256 alignment, remote `doctor.sh`, SQLite `050`–`053` tables, and loopback auth/HMAC gates.

## Documentation

- [Cloud-server runbook](docs/self-hosted.md) — service, reverse proxy, TLS, upgrades and backups.
- [Connector runbook](docs/agent-connect.md) — pairing, directories, local probes, notifications, proxies and diagnostics.
- [Usage and API](docs/usage.md) — owner API, webhook endpoints, local agent behavior and session viewing.
- [PR follow-up](docs/pr-watches.md) — confirmation cards, stuck detection, zero-checkout blind review and GitHub evidence scopes.
- [Supervised improvement](docs/design/otto-improvement.md) — retained experiments, evaluation gates and human acceptance; not autonomous production self-modification.
- [Architecture](docs/design/steward.md) · [Product spec](docs/spec.md) · [Agent-autoloop adoptions](docs/plan/agent-autoloop-adoptions.md) · [Routing eval](docs/routing-eval.md) · [Memory eval](docs/memory-eval.md) — for contributors.

## License

Otto is released under the [MIT License](LICENSE).
