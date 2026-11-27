<p align="center">
  <img src="brand/otto.svg" alt="Otto logo" width="96" height="96">
</p>

# Otto connector

**English** · [简体中文](#otto-connector-简体中文)

`@isaac2ingrid/otto` installs the `otto` command. Otto is a self-hosted personal agent that runs primarily as a Node process on your own server, with Cloudflare Workers as an alternative. The connector runs on macOS, Linux, or Windows and connects that computer to Otto. It keeps an outbound WebSocket connection to your deployment, starts local coding agents (`pi`, Claude Code, Codex CLI, ACP v1 `opencode` / `agentica`, or locally allowlisted `dsh` / `zcode` presets), runs local SHA-256-approved zero-token probes and zero-checkout PR diffs, and reports progress back to your personal agent.

The connector makes only an outbound connection. You do not need to open an inbound port on your computer.

## Requirements

- macOS, Linux, or Windows
- Node.js 22.18 or newer
- npm 7 or newer
- A deployed Otto workspace
- At least one local coding agent (`pi`, Claude Code, Codex CLI, OpenCode, or Agentica) installed and authenticated separately

## Install

Install the connector globally on the machine that will run your coding agents:

```sh
npm install --global @isaac2ingrid/otto
otto --version
```

Use a user-writable npm prefix. Do not use `sudo` to work around an npm permissions problem.

## Connect a machine

Open your Otto web workspace and go to **Machines → Add a machine → Create pairing command**. The workspace creates a one-time command:

```sh
npx @isaac2ingrid/otto connect https://otto.example.com <pairing-code>
```

If the connector is already installed globally, use the shorter form:

```sh
otto connect https://otto.example.com <pairing-code>
```

The pairing code is single-use and expires after 10 minutes. `connect` saves the device credential, installs a background service — launchd on macOS, a systemd user service on Linux, a per-user logon entry (the `Run` key plus a generated `~/.otto/otto-daemon.vbs`) on Windows — and starts the connector. The Windows entry starts the daemon under `otto daemon --supervise`, which restarts it with backoff after a crash — a `Run` value can start a process but never restart one. On a machine whose policy forbids that entry, or whose session cannot reach its service manager, add `--foreground` and keep the terminal open.

### Networks that block the deployment

If your deployment URL is unreachable from this network (for example, a Cloudflare `*.workers.dev` URL without a proxy in mainland China), pass a proxy so both the pairing request and the long-lived connection can get through:

```sh
otto connect https://otto.example.com <pairing-code> --proxy http://127.0.0.1:7890
```

With no `--proxy`, `connect` captures `HTTPS_PROXY` from the environment and stores it; the background service, git, and agent workers all inherit it. Check reachability any time with `otto doctor`, and inspect or change the stored proxy with `otto proxy`.

After pairing, open **Machines** in the Otto web workspace. Choose **Add directory** on the online machine, then select an existing directory or enter its absolute path. Otto detects a Git repository automatically; a plain directory works too, with no branch, worktree isolation, or PR support. Wait for registration to succeed before starting work. Repeat for each directory that Otto may use. No connector restart is needed.

Keep repository paths explicit. Do not register an entire home directory.

## Manage the connector

```sh
otto status                 # service, pairing, workers, agents, and registered repositories
otto doctor                 # pairing, service, local agent binaries, proxy, and reachability check
otto logs -n 50             # recent connector logs
otto stop                   # stop and disable start-at-login
otto start                  # enable and start
otto restart                # restart the background service
otto install                # install (or repair) the service for a machine that is already paired
otto upgrade                # install the latest package and restart
otto uninstall              # remove the service, preserve local state
otto repo-config <path>     # inspect or update local-only write isolation, concurrency, trust & hooks
otto probe list             # list or approve local SHA-256 zero-token scripts under ~/.otto/probes/
otto notify [on|off|test]   # toggle or test zero-dependency OS desktop notifications
otto daemon --supervise     # run the daemon in this terminal, restarting it on failure
```

State remains in `~/.otto/`. Per-repository write policies (`otto repo-config`) and local probe approvals (`otto probe approve <name>`) are strictly local to the machine and cannot be altered remotely. You can revoke a machine from the Otto workspace at any time.

## License

Released under the [MIT License](LICENSE).

## Documentation

The deployment and connector runbooks live in the Otto repository checkout:

- Deploy Otto on your own server (primary) — `docs/self-hosted.md`
- Deploy on Cloudflare Workers (alternative) — `docs/deploy.md`
- Connect a machine — `docs/agent-connect.md`
- Usage and agent behavior — `docs/usage.md`

---

# Otto connector 简体中文

`@isaac2ingrid/otto` 会安装 `otto` 命令。Otto 是自托管 personal agent，主要以 Node 进程运行在自己的服务器上，也可选择部署到 Cloudflare Workers；connector 运行在 macOS、Linux 或 Windows 电脑上，把这台电脑接入 Otto。它保持到你部署地址的出站 WebSocket 连接，启动本地的 `pi`、Claude Code、Codex CLI、OpenCode / Agentica（ACP v1）或本机白名单命令预设（`dsh` / `zcode`），执行经 SHA-256 审批的本地零 Token 探针与零检出 PR Diff，并把进展回传给服务端。

Connector 只主动发起出站连接，不需要在电脑上开放入站端口。

## 环境要求

- macOS、Linux 或 Windows
- Node.js 22.18 或更新版本
- npm 7 或更新版本
- 已部署的 Otto 工作台
- 已单独安装并完成认证的本地 coding agent（如 `pi`、Claude Code、Codex CLI、OpenCode 或 Agentica）

## 安装

在需要运行 coding agent 的电脑上全局安装：

```sh
npm install --global @isaac2ingrid/otto
otto --version
```

请使用当前用户可写的 npm prefix。遇到权限问题时不要用 `sudo` 绕过。

## 连接电脑

打开 Otto 网页工作台，进入 **机器 → 添加机器 → 生成配对命令**。工作台会生成一次性命令：

```sh
npx @isaac2ingrid/otto connect https://otto.example.com <pairing-code>
```

如果已经全局安装 connector，可以直接运行：

```sh
otto connect https://otto.example.com <pairing-code>
```

配对码只能使用一次，10 分钟后过期。`connect` 会保存设备凭证，安装并启动后台服务（macOS 用 launchd，Linux 用 systemd 用户服务，Windows 用当前用户登录自启动：`Run` 注册表项加生成的 `~/.otto/otto-daemon.vbs`；Windows 启动器会以 `otto daemon --supervise` 方式运行守护进程，崩溃后按退避策略重启）。机器策略禁止自启动、或当前会话够不到服务管理器时，可以加 `--foreground`，并保持终端打开。

### 无法直连部署地址的网络

如果当前网络无法访问部署地址（例如未开代理时无法从中国大陆访问 Cloudflare 的 `*.workers.dev` 域名），请传入代理，让配对请求和长连接都能通过：

```sh
otto connect https://otto.example.com <pairing-code> --proxy http://127.0.0.1:7890
```

不传 `--proxy` 时，`connect` 会捕获环境变量 `HTTPS_PROXY` 并持久化；后台服务、git 和 agent worker 都会继承该代理。可随时用 `otto doctor` 检查连通性，用 `otto proxy` 查看或修改已存储的代理。

配对后，在 Otto 工作台打开**机器**，找到在线机器并点击**添加目录**。选择一个已有目录或输入其绝对路径，Otto 会自动检测是否为 Git 仓库；普通目录也能添加，只是没有分支、worktree 隔离和 PR 支持。等待登记成功后再开始任务。逐个添加允许 Otto 使用的目录，无需重启 connector。

请明确指定仓库路径，不要登记整个 home 目录。

## 管理 connector

```sh
otto status                 # 查看服务、配对、worker、本地 agent 和已登记仓库
otto doctor                 # 检查配对、服务、本机 agent 可执行性、代理与连通性
otto logs -n 50             # 查看最近日志
otto stop                   # 停止并取消开机自启
otto start                  # 启用并启动
otto restart                # 重启后台服务
otto install                # 为已配对的机器安装（或修复）后台服务（不需要配对码）
otto upgrade                # 安装最新包并重启
otto uninstall              # 移除服务，保留本地状态
otto repo-config <path>     # 查看或设置仅限本机修改的写入隔离、并发、信任与钩子策略
otto probe list             # 查看或审批 ~/.otto/probes/ 下的 SHA-256 零 Token 本地探针脚本
otto notify [on|off|test]   # 开关或测试零外部依赖的系统桌面通知
otto daemon --supervise     # 在当前终端运行守护进程，崩溃后自动重启
```

状态保存在 `~/.otto/`。仓库写入策略（`otto repo-config`）与本地探针审批（`otto probe approve <name>`）均仅允许在本机 CLI 修改，无法通过远端指令覆写。你可以随时在 Otto 工作台撤销一台电脑。

## 发布（维护者）

发布的是 `@isaac2ingrid/otto`，scope 就是 npm 账号名本身。

**npm 已经停止新增 TOTP 2FA**（`npm profile enable-2fa` 现在直接报
`Adding a new TOTP 2FA is no longer supported`），所以没有"6 位验证码"可输。发布靠**安全密钥 +
浏览器按键**：先 `npm stage publish` 上传，再 `npm stage approve` 当场按指纹。

一次性准备：用 **Safari** 打开
<https://www.npmjs.com/settings/isaac2ingrid/tfa> 添加安全密钥（Touch ID 即可）。
注册必须走 Safari —— Chrome 会默认选"手机或平板电脑作为安全密钥"，等不到响应就报
`Device registration failed`；注册好之后用 Chrome 认证是没问题的。

```sh
cd apps/connector
pnpm build
npm stage publish --registry=https://registry.npmjs.org   # 输出 stage id
```

然后批准（会打开浏览器，按 Touch ID，命令自己继续）：

```sh
npm stage approve <stage-id> --registry=https://registry.npmjs.org
```

- `--registry` 在 `approve` 上不能省：`publishConfig.registry` 只对 publish 生效，不传就会打到本机
  npmrc 里的镜像，回 `404 /-/stage/***/approve not found`。
- `npm stage list` 看未批准的暂存件，`view <id>` 看详情，`reject <id>` 丢弃。暂存件会过期，过期就重新
  `stage publish`。
- 上传这一步用的是 `~/.npmrc` 里那把 `bypass 2FA` 的 granular token（它就是勾了 *Bypass two-factor
  authentication* 建出来的那种）；npm 正在逐步限制它，届时改用 `npm login --auth-type=web` 拿会话 token。
- 发布完确认：`npm view @isaac2ingrid/otto version`，再在干净目录跑
  `npx -y @isaac2ingrid/otto@1.0.0 help`。

## 许可证

采用 [MIT License](LICENSE)。
