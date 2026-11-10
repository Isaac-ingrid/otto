<p align="center">
  <img src="apps/steward/ui/brand/otto.svg" alt="Otto" width="88" height="88">
</p>

<h1 align="center">Otto</h1>

<p align="center"><strong>Your agents, in one conversation.</strong></p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

Otto is a **self-hosted personal agent** with an **always-on steward in the cloud**. Run the steward 24/7 on your own cloud server (VPS) as a Node.js process with SQLite state. Connectors on your computers run local coding agents in the repositories you choose. Talk to Otto in its web workspace, ask it to work on a task, and pick up the same conversation later from another device.

- **An always-on coordinator.** The steward stays online on your VPS even when your computers are asleep; it keeps conversations, memory and scheduled follow-ups. Local coding work waits for an available connector.
- **One conversation across machines.** Tasks, decisions, follow-ups and progress stay together.
- **Your code stays on your machines.** A connector runs pi (or an installed Claude Code) locally; full coding-agent session records stay there.
- **Memory with boundaries.** Otto keeps preferences and project conventions separately from conversation history. It tracks their source and confirmation, and distinguishes replacing an outdated fact from merely making room.
- **You stay in control.** The workspace shows active work and decisions that need you; you can stop an in-progress reply.

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

Then follow the [cloud-server runbook](docs/self-hosted.md) to install **`apps/steward/dist/node/steward-node.mjs`, `dist/ui/` and the `ws` runtime dependency** on the server. Set a unique `LOGIN_PASSWORD` of at least 15 characters in its protected `.dev.vars`; set `OTTO_CONFIG_DIR` and `OTTO_DB_PATH` explicitly. Run the process under systemd (automatic restart), bind it to loopback, and put an HTTPS reverse proxy with WebSocket forwarding in front. Keep the VPS and its persistent disk running **24/7**; back up the live SQLite database with SQLite's online backup, not a plain copy while WAL is active. Do not commit secrets or send them through chat.

Open **your server's HTTPS address**, sign in and enter the steward's model API key in **Settings**. The server must be reachable from every computer you want to connect; an SSH tunnel to a loopback-only address is useful for private access, but not a public connector endpoint.

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

The code expires after 10 minutes and is single-use; keep it out of chat and logs. Pairing installs and starts a background service — launchd on macOS, a systemd user service on Linux, and a per-user logon entry (the `Run` key plus a generated `~/.otto/otto-daemon.vbs`) on Windows. When that is not possible on this machine (a session that cannot reach its service manager, or a Windows logon entry the machine's policy forbids), `connect` says so *before* redeeming the code, so a retry costs no new code — and `--foreground` runs the daemon in the current terminal instead. `otto status` reports which of the two is in play; on Windows the connector starts at the next logon and the launcher runs it under `otto daemon --supervise`, so a daemon that dies comes back on its own with backoff until `otto stop` says otherwise.
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

## How it works

**You → Otto on your always-on cloud server (Node.js + SQLite) ← outbound WebSocket from each computer's connector → pi / Claude Code**

The VPS steward stays available for conversations, memory and scheduling around the clock; connectors initiate outbound connections to it and start coding-agent sessions only when their computers are online. The steward's state lives in SQLite on **your server**, so you operate and back it up yourself. Repository contents and full local agent sessions stay on the computer running the connector. The steward and local agents each use their own configured model provider.

## Documentation

- [Cloud-server runbook](docs/self-hosted.md) — service, reverse proxy, TLS, upgrades and backups.
- [Connector runbook](docs/agent-connect.md) — pairing, directories, proxies and diagnostics.
- [Usage and API](docs/usage.md) — owner API, local agent behavior and session viewing.
- [Architecture](docs/design/steward.md) · [Product spec](docs/spec.md) · [Routing eval](docs/routing-eval.md) · [Memory eval](docs/memory-eval.md) — for contributors.

## License

Otto is released under the [MIT License](LICENSE).
