# Agent connector runbook

You are a coding agent running on a computer the owner wants to connect to an existing Otto deployment. Install the connector, pair this machine, register the owner's chosen repositories, and verify a real task. For deployment, start with the [self-hosted Node runbook](self-hosted.md); [agent-deploy.md](agent-deploy.md) covers the alternative Cloudflare setup.

## 0 · Check the machine and destination

- Confirm this is the machine that will run coding agents. Ask for the existing Otto HTTPS URL and the local repository paths the owner wants to connect.
- Check macOS, Linux or Windows, Node ≥ 22.18 (`node -v`), npm, and git. Background mode uses launchd on macOS, a systemd user service on Linux, and a per-user logon entry on Windows (the `Run` key plus a generated `~/.otto/otto-daemon.vbs` — no elevation; the launcher starts the daemon under `otto daemon --supervise`, which restarts it with backoff, since a `Run` value can start a process but never restart one). On Windows or Linux, if the machine's policy forbids the logon entry or the session cannot reach its service manager, `connect` refuses before spending the code and `--foreground` is the fallback, in a terminal that must stay open. The same applies to a container with no service manager.
- Check the intended local coding agent: `pi` (`pi --version`) is the default; installed Claude Code (`claude --version`), Codex CLI (`codex --version`), ACP v1 agents (`opencode`, `agentica`), and command presets (`dsh`, `zcode`) are also detected automatically. These CLIs are separate from the connector. If missing, install the owner's chosen agent using its official instructions. Have the owner complete its login or provider setup directly, keeping credentials out of chat and logs. The steward's model key does not configure the local coding agent.
- If `otto` is already installed, run `otto status` first. Preserve a correct pairing. If it points to a different deployment, confirm the intended replacement before pairing again.
- Check for `OTTO_HOME` overrides without dumping the environment. A custom state directory cannot install the shared background service; resolve the intended setup or use `--foreground`.
- Verify that the deployment URL is reachable. An unauthenticated `GET /app` returning 401 is expected. On a network where the URL is only reachable through a local HTTP proxy (filtered networks, mainland China), connect with `otto connect <url> <code> --proxy http://127.0.0.1:7890` — both channels (fetch, WebSocket), the connector's `git` calls, and worker children follow it, and the choice is stored so the background service needs no inherited environment. An `HTTPS_PROXY` already set in the shell is captured automatically; `otto doctor` diagnoses direct-vs-proxy reachability when things fail.

Do not read credential stores or ask the owner to paste SERVER_KEY, model keys, login links, or device tokens into chat. Pairing needs a short-lived code, not the owner's permanent SERVER_KEY.

## 1 · Install the connector

If the public npm package is available (`npm view @isaac2ingrid/otto version`), install it to a stable location:

```sh
npm install --global @isaac2ingrid/otto
otto --version
```

Use the owner's normal Node installation and a user-writable npm prefix; do not reach for `sudo` to fix permissions. A global install gives the background service a stable executable path and makes the `otto` command available for later steps.

### If the package is not yet published

An npm 404 is not a successful installation. Use your local checkout of otto. From the repository root, use its pinned pnpm version:

```sh
cd <your checkout of otto>
pnpm install
pnpm --filter @isaac2ingrid/otto build
otto_package_dir="$(mktemp -d)"
npm pack ./apps/connector --ignore-scripts --pack-destination "$otto_package_dir"
npm install --global "$otto_package_dir"/isaac2ingrid-otto-*.tgz
otto --version
```

The built tarball contains the CLI and its assets, so the installed service does not depend on the checkout or an npx cache. If installing an update over a running connector, run `otto restart` afterwards. Until the npm package is published, update by repeating this source-install procedure instead of `otto upgrade`. For network or registry errors other than a missing package, diagnose the error rather than treating it as proof the package is unpublished.

## 2 · Pair with the personal agent

Have the owner open the existing Otto web workspace and go to **Machines → Add a machine → Create pairing command** (中文：**机器 → 添加机器 → 生成配对命令**). Generate the code only after installation is complete; it is single-use and expires in 10 minutes.

The workspace generates a command shaped like:

```sh
npx @isaac2ingrid/otto connect https://otto.example.com <pairing-code>
```

Use the installed CLI with the URL and code from that command (append `--proxy <url>` on filtered networks — see step 0):

```sh
otto connect https://otto.example.com <pairing-code>
```

The owner can run it directly in their terminal, keeping the pairing code out of the agent transcript. With an authorized browser session, an agent may carry out pairing without repeating the code in its report. Use the final reachable deployment URL and do not reuse a code from an example.

`connect` saves the device credentials, installs the background service, and starts it. Before it redeems the code it checks that this machine can host that service at all, so a machine with no service manager, one whose session cannot reach it (a headless Linux session with no systemd user bus), or a Windows machine whose policy disables the logon entry (Run key blocked, Windows Script Host off, no `wscript.exe`) is refused without spending the code — the check is skipped with `--foreground`, which needs no service. `--foreground` is also the right shape for a container with no service manager. The error tells you to pair again with `--foreground`. If the code expires or has already been used, generate a fresh one in the workspace. If the owner cannot sign in, follow the [self-hosted password recovery steps](self-hosted.md#troubleshooting), or [Cloudflare recovery](deploy.md#recover-browser-access) for a Worker deployment. Never ask for a password or SERVER_KEY in chat.

Before the first task, confirm two things about the local agent — both have silently wasted a dispatch:

- **Its default provider has usable quota.** Otto passes no `--model` by default, so the agent uses its own default. A model-capable connector allows an optional per-machine × agent task default in **Settings → Local coding-agent models** or **Machines**. Explicit picker selection currently targets `pi` (metadata RPCs against the installed CLI with cached/offline labels and Advanced exact IDs; Note: custom provider models in `~/.pi/agent/models.json` default to `contextWindow: 128000` unless explicitly configured). Other installed CLIs follow their own configured defaults, and non-intrusive `authStatus` prechecks prevent unauthenticated CLIs from hijacking automatic routing. When a provider or agent hits a rate-limit or subscription quota window, Otto parks the worker in `idle` (`error:rate_limited`) and resumes automatically once the window resets; credential or billing errors (`error:auth`) still require fixing local settings (`~/.pi/agent/settings.json` `defaultProvider`/`defaultModel`, `claude`, `codex`, etc.).
- **The launch Otto resolves is spawnable.** `otto status` / `otto doctor` check this. A spaced path in `OTTO_PI_COMMAND` needs inner quotes; prefer `node <launcher> …`, which has no space to quote. On Windows a bare `pi` is resolved past the `.cmd` shim to its JavaScript entry; if that entry cannot be read, the line reads `pi: windows-unresolved — <shim>` with what to do about it, and no task is dispatched through a shell fallback.

## 3 · Register the selected repositories

In the web workspace, open **Machines**, find the connected machine, and choose **Add directory** (中文：**机器 → 添加目录**). Select an existing directory or enter its absolute path, then wait for registration to succeed. Repeat for each directory the owner chose. The connector detects a Git repository automatically; a plain directory registers the same way, with no branch, worktree isolation, or PR support.

The connector resolves and saves each directory's identity locally before the workspace shows it as registered. Keep the connector online during registration. No restart is needed.

Keep the default `worktree` isolation unless the owner wants a different write policy — a plain (non-Git) directory can only run `in-place`. Do not add `--approve` as a setup shortcut: it enables the repository's local pi extensions and is a separate trust choice. The `otto repo-config` examples in the [deployment guide](deploy.md#connecting-a-machine) apply to connectors on either host.

## 4 · Verify the full connection

1. Run `otto status`. Confirm the intended deployment, installed/running service (or the live foreground process), the agent command Otto will actually launch, and registered repositories. A saved pairing alone does not prove the WebSocket is connected. On Windows the service is a per-user logon entry rather than a manager that watches the process, so read the two lines together: `service: windows dev.otto.connector — …` describes the logon entry (its absence means the machine will not come back after a reboot — `otto install` writes it for a machine that is already paired, without a pairing code), while `daemon: running pid …` is the only evidence that a connector is alive now — and `daemon: stale lock …` means the opposite of what the file on disk suggests. A supervised run adds `[supervised: child pid N, M restarts]` to that line: the pid it prints is then the supervisor, whose child is the process actually doing the work. On Windows the agent line matters: npm-installed agents are `.cmd` shims, and an unresolvable one is what makes a machine look paired but unable to start work. The line also says `NOT SPAWNABLE: <path>` when the executable it resolves to is missing, or `windows-unresolved — <shim>: …` when the shim has no readable JavaScript entry — either way that is a broken `OTTO_PI_COMMAND` (a spaced path needs inner quotes: `OTTO_PI_COMMAND='"C:\Program Files\nodejs\node.exe" C:\path\pi-launcher.js'`), not an agent problem. `otto doctor` fails the same check.
2. Check recent `otto logs -n 50` for a `welcomed` event and confirm the machine is **online** in the workspace's Machines page, with the expected repositories and agents. Fix repeated connection failures before continuing.
3. Ask Otto in the workspace to run a small read-only task (using **pi**, **Claude Code**, or **Codex CLI**), for example: “On this machine, summarize the README in this repository. Do not modify files.” Verify that the task returns a structured report and its session record opens (`ClaudeAdapter` runs read-only tasks under `--permission-mode plan` with read-only tools).

Hand over the machine name, connected repositories, and the observed task result. Explain that the computer must stay awake and connected, and give the owner these management commands:

```sh
otto status
otto doctor
otto logs -n 50
otto stop
otto start
otto restart
otto install     # install (or repair) the logon entry/unit for a machine that is already paired
otto upgrade     # update @isaac2ingrid/otto from npm and restart the running service
otto uninstall   # removes the service, preserves local state
otto probe list  # inspect or approve local SHA-256 zero-token probes under ~/.otto/probes/
otto notify on   # optional: enable native OS desktop notifications on this machine
```

State is stored in `~/.otto/`. The owner can revoke a machine from the workspace at any time. See [self-hosted.md](self-hosted.md#upgrades-and-rollback) for Node updates and operations, [deploy.md](deploy.md#updates) for Cloudflare updates, and [usage.md](usage.md) for agent behavior and session viewing.
