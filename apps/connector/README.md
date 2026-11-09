<p align="center">
  <img src="brand/otto.svg" alt="Otto logo" width="96" height="96">
</p>

# Otto connector

**English** · [简体中文](#otto-connector-简体中文)

`@isaac2ingrid/otto` installs the `otto` command. Otto is a self-hosted personal agent that runs in your Cloudflare account; the connector runs on a macOS or Linux computer and connects that computer to Otto. It keeps a WebSocket connection to your deployment, starts local coding agents such as pi and Claude Code, and reports their progress back to your personal agent.

The connector makes only an outbound connection. You do not need to open an inbound port on your computer.

## Requirements

- macOS or Linux
- Node.js 22.18 or newer
- npm 7 or newer
- A deployed Otto workspace
- A local coding agent, such as pi or Claude Code, installed and authenticated separately

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

The pairing code is single-use and expires after 10 minutes. `connect` saves the device credential, installs a launchd service on macOS or a systemd user service on Linux, and starts the connector. On a machine without a supported service manager, add `--foreground` and keep the terminal open.

### Networks that block the deployment

`*.workers.dev` and similar hosts are unreachable from some networks (notably mainland China without a proxy). Pass a proxy so both the pairing request and the long-lived connection can get through:

```sh
otto connect https://otto.example.com <pairing-code> --proxy http://127.0.0.1:7890
```

With no `--proxy`, `connect` captures `HTTPS_PROXY` from the environment and stores it; the background service, git, and agent workers all inherit it. Check reachability any time with `otto doctor`, and inspect or change the stored proxy with `otto proxy`.

After pairing, open **Machines** in the Otto web workspace. Choose **Add directory** on the online machine, then select an existing directory or enter its absolute path. Otto detects a Git repository automatically; a plain directory works too, with no branch, worktree isolation, or PR support. Wait for registration to succeed before starting work. Repeat for each directory that Otto may use. No connector restart is needed.

Keep repository paths explicit. Do not register an entire home directory.

## Manage the connector

```sh
otto status                 # service, pairing, workers, and registered repositories
otto logs -n 50             # recent connector logs
otto stop                   # stop and disable start-at-login
otto start                  # enable and start
otto restart                # restart the background service
otto upgrade                # install the latest package and restart
otto uninstall              # remove the service, preserve local state
```

State remains in `~/.otto/`. You can revoke a machine from the Otto workspace at any time.

## License

Released under the [MIT License](LICENSE).

## Documentation

The deployment and connector runbooks live in the Otto repository checkout:

- Deploy Otto — `docs/deploy.md`
- Connect a machine — `docs/agent-connect.md`
- Usage and agent behavior — `docs/usage.md`

---

# Otto connector 简体中文

`@isaac2ingrid/otto` 会安装 `otto` 命令。Otto 是部署在你 Cloudflare 账号里的 personal agent；connector 运行在 macOS 或 Linux 电脑上，把这台电脑接入 Otto。它保持到你部署地址的 WebSocket 连接，启动本地的 pi、Claude Code 等 coding agent，并把进展回传给 personal agent。

Connector 只主动发起出站连接，不需要在电脑上开放入站端口。

## 环境要求

- macOS 或 Linux
- Node.js 22.18 或更新版本
- npm 7 或更新版本
- 已部署的 Otto 工作台
- 已单独安装并完成认证的本地 coding agent，例如 pi 或 Claude Code

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

配对码只能使用一次，10 分钟后过期。`connect` 会保存设备凭证，在 macOS 安装 launchd 服务、在 Linux 安装 systemd 用户服务，并启动 connector。没有受支持服务管理器的机器可以加 `--foreground`，并保持终端打开。

### 无法直连部署地址的网络

部分网络（典型如未开代理的中国大陆）无法访问 `*.workers.dev` 等域名。请传入代理，让配对请求和长连接都能通过：

```sh
otto connect https://otto.example.com <pairing-code> --proxy http://127.0.0.1:7890
```

不传 `--proxy` 时，`connect` 会捕获环境变量 `HTTPS_PROXY` 并持久化；后台服务、git 和 agent worker 都会继承该代理。可随时用 `otto doctor` 检查连通性，用 `otto proxy` 查看或修改已存储的代理。

配对后，在 Otto 工作台打开**机器**，找到在线机器并点击**添加目录**。选择一个已有目录或输入其绝对路径，Otto 会自动检测是否为 Git 仓库；普通目录也能添加，只是没有分支、worktree 隔离和 PR 支持。等待登记成功后再开始任务。逐个添加允许 Otto 使用的目录，无需重启 connector。

请明确指定仓库路径，不要登记整个 home 目录。

## 管理 connector

```sh
otto status                 # 查看服务、配对、worker 和已登记仓库
otto logs -n 50             # 查看最近日志
otto stop                   # 停止并取消开机自启
otto start                  # 启用并启动
otto restart                # 重启后台服务
otto upgrade                # 安装最新包并重启
otto uninstall              # 移除服务，保留本地状态
```

状态保存在 `~/.otto/`。你可以随时在 Otto 工作台撤销一台电脑。

## 发布（维护者）

发布的是 `@isaac2ingrid/otto`，scope 就是 npm 账号名本身，所以账号必须先存在。

```sh
npm login          # 先在 npmjs.com 注册 isaac2ingrid，再登录
cd apps/connector
npm publish        # publishConfig.registry 固定为 registry.npmjs.org
```

`publishConfig.registry` 是必要的：本机 `~/.npmrc` 指向 `registry.npmmirror.com`，那是只读镜像，
写入会失败，而报错看起来像网络问题。发布前先改 `package.json` 的 `version`（升级版本时用
`otto upgrade`；当前是 0.2.0）。

`@alexlikevibe/*` 那一支（`@alexlikevibe/sig@0.1.3` 等）属于上游作者自己的 npm 身份，不归本项目，
也 deprecate 不了——那是别人的包。本项目从 `@isaac2ingrid/otto@0.2.0` 重新起算，没有要迁移的
旧包：这台机器跑的是 checkout 里的 `bin/otto.js`，不是 npm 包。

发布不属于自动化流程：本仓库没有 git remote，`.github/workflows/release.yml` 的 tag 触发路径
只对带 `NPM_TOKEN` 的克隆有效。

## 许可证

采用 [MIT License](LICENSE)。
