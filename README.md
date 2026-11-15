<p align="center">
  <img src="apps/steward/ui/brand/otto.svg" alt="Otto" width="88" height="88">
</p>

<h1 align="center">Otto</h1>

<p align="center"><strong>Your agents, in one conversation.</strong></p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

**Otto is an always-on coordinator for the coding agents on your computers.** You talk to one personal agent in a web workspace; it remembers ongoing work, routes tasks to local agents, and brings their progress and decisions back to the same conversation. The steward runs on your own server, while the agents work in repositories you choose on your own machines.

- **An always-on coordinator.** The steward stays online on your VPS even when your computers are asleep; it keeps conversations, memory and scheduled follow-ups. Local coding work waits for an available connector.
- **One conversation across machines.** Tasks, decisions, follow-ups and progress stay together.
- **Your code stays on your machines.** A connector runs pi (or an installed Claude Code) locally; full coding-agent session records stay there.
- **Memory with boundaries.** Otto keeps preferences and project conventions separately from conversation history. It tracks their source and confirmation, and distinguishes replacing an outdated fact from merely making room.
- **You stay in control.** The workspace shows active work and decisions that need you; you can stop an in-progress reply.

## Architecture

```text
Browser workspace / optional Owner API
                │ HTTPS / WebSocket
                ▼
Your VPS: Otto steward (Node.js + SQLite)
  ├─ deterministic core: events, deadlines, notifications, durable queues
  ├─ LLM steward: routing, judgment, summaries, tool calls
  └─ ledger: Threads, decisions, notes, worker state
                ▲ outbound WebSocket connections
                │
Connectors on macOS / Linux / Windows
  └─ pi or Claude Code → selected local repositories
```

The steward uses a single persistent SQLite database; connectors initiate connections, so your computers need no inbound ports. Repository contents and complete coding-agent session records stay on those computers. The steward and local agents use separately configured models. The **same steward logic** can alternatively run on [Cloudflare Workers + a SQLite-backed Durable Object](docs/design/node-host.md); the VPS deployment uses a Node host adapter rather than a separate product.

## What makes the design different

- **A ledger, not an endless prompt, carries continuity.** Threads, worker reports and provenance-aware notes live outside the LLM transcript. Each turn sees a fresh, bounded situation brief; compaction does not have to serve as the project's memory.
- **Code handles certainties; the model handles judgment.** State transitions, deadlines and routine completion notices do not need an LLM call. The model handles ambiguous routing, questions and summaries. If it is unavailable or over budget, deterministic fallbacks still surface pending decisions.
- **Actions have durable boundaries.** Owner turns are recorded before execution, processed serially and cancellable; dispatched work continues independently. Idempotency keys and durable queues make retries and steward restarts recoverable, while tool checks require a verifiable source before event-triggered work can be dispatched.
- **Memory is inspectable.** Notes distinguish user-confirmed facts from worker reports and inferences, and distinguish replacing an outdated fact from archiving one for space. [Architecture details](docs/design/steward.md) · [Turn design](docs/adr/0017-turns-are-serial-and-cancellable.md).

### Ideas adapted from the Super Agent comparison

Rather than copying a product wholesale, Otto [tested three ideas](docs/plan/self-hosted.md#p4--product-follow-ups-from-the-super-agent-comparison) and kept their boundaries explicit:

- **Watchdog re-planning:** an optional model pass can reconsider a stalled worker and re-plan or ask you. It is **off by default** (`WATCHDOG_LLM`); the deterministic stall verdict still applies.
- **Live Thread following:** the workspace subscribes to Thread events and state over WebSocket, with a timeline cursor for resuming, instead of relying solely on polling.
- **No speculative parallel turns:** starting a second answer before the first settles risks missing conversation context or dispatching the same intent twice. Otto instead keeps turns serial, durable and stoppable.

Otto is not a general-purpose cloud browser. Optional read-only web search (Tavily basic or Brave Search API) is off until the owner configures a separate key; it returns bounded snippets and source URLs, not verified full pages or a live weather tool. Coding work needs an online connector; the cloud steward can still converse, remember and schedule while your computers are asleep.

Optional **Web Push** is also off until VAPID keys are configured and each phone opts in under Settings. It sends generic alerts for decisions and completed work, never task text, with 22:00–08:00 local quiet hours by default. The in-app pending list remains the fallback; iPhones require installation to the Home Screen first. See the [self-hosted guide](docs/self-hosted.md#web-push-optional).

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
The connector calls out to Otto, so the computer needs no inbound port. In **Machines**, add only the local directories you want Otto to work in, then try a small read-only pi task. Otto passes no model flag, so the local agent uses its **own** default provider — make sure that one has usable quota (an exhausted default that falls back to another provider surfaces only as an agent-side error). `otto status` prints the agent Otto will actually run and says `NOT SPAWNABLE` if it resolves to a missing executable (a spaced path in `OTTO_PI_COMMAND` needs inner quotes; `node <launcher> …` avoids the question); `otto logs -n 50` shows why a machine did not come online. It must stay awake and connected while working. For a proxy, a host without a service manager, or a source installation, see the [connector runbook](docs/agent-connect.md).

**Done when:** the machine and its chosen directories appear online and the test task returns a result. Repeat for each computer.

## Use Otto

Try asking:

> “Review the login flow in my-app and tell me what you find.”
>
> “Fix that bug on my Mac using pi.”
>
> “Continue the previous task, and use pnpm this time.”

The workspace brings together messages, task threads, decisions, connected machines and session records. Replies stream as they are written; a message sent mid-answer waits its turn.

## Documentation

- [Cloud-server runbook](docs/self-hosted.md) — service, reverse proxy, TLS, upgrades and backups.
- [Connector runbook](docs/agent-connect.md) — pairing, directories, proxies and diagnostics.
- [Usage and API](docs/usage.md) — owner API, local agent behavior and session viewing.
- [Architecture](docs/design/steward.md) · [Product spec](docs/spec.md) · [Routing eval](docs/routing-eval.md) · [Memory eval](docs/memory-eval.md) — for contributors.

## License

Otto is released under the [MIT License](LICENSE).
