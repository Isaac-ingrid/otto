<p align="center">
  <img src="apps/steward/ui/brand/otto.svg" alt="Otto" width="88" height="88">
</p>

<h1 align="center">Otto</h1>

<p align="center"><strong>Your agents, in one conversation.</strong></p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

Otto is a **self-hosted personal agent**. Its steward runs as a Node.js process with SQLite state; connectors on your computers run local coding agents in the repositories you choose. Talk to Otto in its web workspace, ask it to work on a task, and pick up the same conversation later from another device.

- **One conversation across machines.** Tasks, decisions, follow-ups and progress stay together.
- **Your code stays on your machines.** A connector runs pi (or an installed Claude Code) locally; full coding-agent session records stay there.
- **Memory with boundaries.** Otto keeps preferences and project conventions separately from conversation history. It tracks their source and confirmation, and distinguishes replacing an outdated fact from merely making room.
- **You stay in control.** The workspace shows active work and decisions that need you; you can stop an in-progress reply.

## Get started

You need **Node.js 24** for the steward, the pnpm version pinned in [`package.json`](package.json) for building (install Corepack if `corepack` is unavailable), and a model-provider API key (entered in the workspace after sign-in). A computer running the connector needs **Node.js 22.18+**, macOS or Linux, and a separately installed and authenticated coding agent. Otto's model key does not configure the local agent.

### 1. Run the steward

From a checkout, build and try it on your own machine:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @isaac2ingrid/steward build:node
mkdir -p apps/steward/dist/ui
cp -R apps/steward/ui/. apps/steward/dist/ui/
cp .dev.vars.example .dev.vars
# Edit .dev.vars: set LOGIN_PASSWORD to a unique password of at least 15 characters.
HOST=127.0.0.1 PORT=8787 OTTO_CONFIG_DIR="$PWD" OTTO_DB_PATH="$PWD/apps/steward/data/steward.sqlite" \
  node apps/steward/dist/node/steward-node.mjs
```

Open <http://127.0.0.1:8787>, sign in and enter the steward's model API key in **Settings**. Do not commit `.dev.vars` or send passwords or keys through chat. This loopback-only example is for local use; it is **not** reachable by connectors on other machines.

For a persistent, remotely reachable installation, follow the [self-hosted runbook](docs/self-hosted.md): deploy the bundle **and `dist/ui` and the `ws` runtime dependency**, use a service and a private SQLite data directory, and expose the workspace through HTTPS with WebSocket forwarding (or use an SSH tunnel for local access). Set `OTTO_CONFIG_DIR` and `OTTO_DB_PATH` explicitly. Back up a live SQLite database using SQLite's online backup, not a plain copy of its WAL file.

**Done when:** the workspace opens and Otto replies to a message. You can chat before adding any machines.

### 2. Connect a computer

On a macOS or Linux computer with Node.js 22.18+ and a configured local coding agent, install the published connector:

```sh
npm install --global @isaac2ingrid/otto
otto --version
```

In Otto's workspace, open **Machines → Add a machine → Create pairing command**. Run the generated command *on that computer* with its actual URL and short-lived code, using the installed CLI:

```sh
otto connect <your-otto-url> <one-time-pairing-code>
otto status
```

The code expires after 10 minutes and is single-use; keep it out of chat and logs. Pairing installs and starts a background service (launchd on macOS, systemd user service on Linux). The connector calls out to Otto, so the computer needs no inbound port. In **Machines**, add only the local directories you want Otto to work in, then try a small read-only pi task. Run `otto logs -n 50` if the machine does not show online. It must stay awake and connected while working. For a proxy, a host without a service manager, or a source installation, see the [connector runbook](docs/agent-connect.md).

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

**You → Otto (Node.js + SQLite) → outbound WebSocket → connector → pi / Claude Code**

The steward coordinates conversations, tasks and governed memory; the connector starts coding-agent sessions and relays their progress. The steward's state lives in SQLite on **your host**, so you operate and back it up yourself. Repository contents and full local agent sessions stay on the computer running the connector. The steward and local agents each use their own configured model provider.

## Documentation

- [Self-hosted runbook](docs/self-hosted.md) — service, reverse proxy, TLS, upgrades and backups.
- [Connector runbook](docs/agent-connect.md) — pairing, directories, proxies and diagnostics.
- [Usage and API](docs/usage.md) — owner API, local agent behavior and session viewing.
- [Architecture](docs/design/steward.md) · [Product spec](docs/spec.md) · [Routing eval](docs/routing-eval.md) · [Memory eval](docs/memory-eval.md) — for contributors.

## License

Otto is released under the [MIT License](LICENSE).
