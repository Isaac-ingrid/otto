<p align="center">
  <img src="apps/steward/ui/brand/otto.svg" alt="Otto" width="88" height="88">
</p>

<h1 align="center">Otto</h1>

<p align="center"><strong>汇聚你的所有 agent。</strong></p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

Otto 是一个可自行部署的 **Personal Agent（个人智能体）**，基于 **pi-durable** 和 **Cloudflare Durable Objects** 构建。它记住你的对话和进行中的任务，并连接你各台电脑上的 coding agent。

它既可以跑在**你自己的 Cloudflare 账号**里（一个 Worker 加一个 Durable Object，无需运维），也可以**是你自己机器上的一个 Node 进程**，状态就是一个可以随时拷走的 SQLite 文件（[自托管指南](docs/self-hosted.md)）。两种方式下，网页工作台、connector 和两个对外接口完全一致。

名字没有缩写含义：短、在中英文里都读得顺，作为命令 `otto` 也顺手。图标就是这个词本身。

打开网页工作台，就能和 Otto 对话：让它处理某个仓库的任务、追问进度，或者接着上次的工作继续做。Otto 负责协调，每台电脑上的轻量 **connector（连接器）** 负责运行本地 agent，再把进展和结果带回来。

- **多台机器，一处对话。** 在同一个地方跟进任务、继续讨论、处理需要你决定的事情。
- **用你自己的电脑和 agent。** 支持 pi，以及已安装的 Claude Code；由你选择开放哪些仓库。
- **上下文持续保留。** 对话和任务状态保存在服务端（Durable Object，或自托管机器上的 SQLite 文件）；coding agent 的完整会话记录留在本机，机器在线时可以查看。
- **说错了可以停下。** 回复一次只跑一条，中途发的消息会排在后面，正在回答的那一行上有停止按钮。

## 开始使用

先把 Otto 部署起来——到你的 Cloudflare 账号，或到你自己的机器——再连接实际执行任务的电脑。你需要准备：供 Otto 使用的模型 API key；除自托管外还需要 Cloudflare 账号；**Node.js 22.18+** 只有下面的 agent 路径和 connector 需要（自托管的主机需要 Node 24）。连接器支持 **macOS 和 Linux**，本地 coding agent 也需要安装并完成它自己的登录或模型配置。

### 1. 部署你的 Personal Agent

**从你的代码检出目录部署。** 把这个仓库部署到你自己的 Cloudflare 账号。完整步骤见[部署指南](docs/deploy.md)；在仓库根目录执行：

开始前，请用密码管理器生成并保存一个**至少 15 个字符**的独立密码，填写到 `LOGIN_PASSWORD`。即使 Cloudflare 表单接受了短密码、常见密码或已泄露密码，Otto 启动后也会拒绝使用它们登录。

```sh
pnpm install
wrangler deploy
wrangler secret put LOGIN_PASSWORD
wrangler deploy
```

构建完成后打开 Worker 地址登录，向导会引导你填写模型 API key。

如果部署时提示 GitHub 授权过期，请按[部署排错指南](docs/deploy.md#deployment-troubleshooting)恢复连接。修改登录密码无法修复 GitHub 授权。

**或交给你的 coding agent。** 复制这段，发给你的 coding agent：

```text
帮我把 Otto 这个 personal agent 部署到我自己的 Cloudflare 账号。

项目仓库：本地的 otto 代码检出目录（找不到就问我路径）
请先阅读该目录里的 docs/agent-deploy.md，并按其中的步骤操作。

检查前置条件，部署 Worker 和 Durable Object，配置密钥，验证访问，
然后打开网页工作台。需要 Cloudflare 授权时引导我完成；模型 API key
由我直接在工作台的设置页填写，不要让密钥出现在聊天或日志里。
最后确认 Otto 能回复一条消息，并告诉我部署地址。
连接电脑这一步，我会另用 connector 安装 prompt 完成。
```

**完成标志：** 能打开网页工作台，Otto 能回复你的第一条消息。还没连接电脑时，也可以先和 Otto 对话。

**或者部署到自己的机器上。** 不需要 Cloudflare 账号：同一个 steward 作为一个 Node 进程运行在它的 SQLite 文件旁边，前面挂 nginx 或直接走 SSH 隧道。

```sh
pnpm install && pnpm --filter @isaac2ingrid/steward build:node
# → 把 dist/node/steward-node.mjs 和 ui/ 拷到目标机，配置 LOGIN_PASSWORD，用 systemd 启动
```

密钥文件、systemd 单元、TLS、升级回滚和备份都在[自托管指南](docs/self-hosted.md)里。

### 2. 连接你的电脑

在**你希望 Otto 执行任务的那台电脑上**打开 coding agent，复制这段：

```text
帮我在这台电脑上安装 Otto connector，连接到我已经部署在 Cloudflare
上的 personal agent。

项目仓库：本地的 otto 代码检出目录（找不到就问我路径）
请先阅读该目录里的 docs/agent-connect.md，并按其中的步骤操作。

向我确认 Otto 部署地址，以及我要连接的本地仓库。检查 Node.js 和本地
coding agent 的配置，安装 connector，并引导我从网页工作台的「机器」
页面完成配对。启动 connector，只登记我选定的仓库，验证这台机器和
仓库在 Otto 中显示在线。不要让长期凭证出现在聊天或日志里。
最后运行一个小的只读任务，确认整条连接正常工作。
```

**完成标志：** Otto 中能看到机器在线，并且一个只读任务成功返回结果。要连接更多电脑，在每台电脑上重复这段 prompt 即可。

Connector 会主动连接 Otto，你无需给电脑开放入站端口。本地 agent 工作期间，电脑需要保持唤醒和联网。

> 如果你的 agent 找不到仓库，请把它指向本地 checkout。npm 包暂不可用时，connector 指南提供从源码安装的路径。如果所在网络无法访问 `workers.dev`，部署指南也包含自定义域名的配置方法。

## 开始对话

连接电脑后，可以试试：

> 「检查一下 my-app 的登录流程，告诉我发现了什么问题。」
>
> 「用我 Mac 上的 pi 把这个 bug 修一下。」
>
> 「接着上次的任务做，这次用 pnpm。」

工作台把消息、任务线程、待决事项、已连接的机器和会话记录放在一起。回复会边写边出现，中途发的消息排在当前回答之后，正在回答的那一行可以停下这次回答。界面支持中英文切换。

## 它如何工作

**你 → Cloudflare 上的 Otto → 电脑上的 connector → pi / Claude Code**

云端 agent 使用 **`@earendil-works/pi-durable`** 运行，借助 **Cloudflare Durable Object** 持久化状态并协调任务。Connector 通过 WebSocket 保持连接，在本地启动 coding agent 会话，再把进度回传给 Otto。代码和完整会话文件留在本机；本地 coding agent 仍会照常使用它配置的模型服务。

Cloudflare 是默认形态而不是前置条件：`apps/steward/node-host/` 用 `node:sqlite` 提供了 `ctx.storage`、定时器和 socket，同一份 `src/` 也能跑在普通 Node 进程上（[设计说明](docs/design/node-host.md)）。

## 进一步了解

- [部署操作文档](docs/agent-deploy.md) · [Connector 操作文档](docs/agent-connect.md)：供你的 coding agent 执行。
- [部署指南](docs/deploy.md)：手动部署、模型配置、自定义域名、费用和更新。
- [自托管操作手册](docs/self-hosted.md)：在自己的机器上跑同一个 steward——systemd、nginx、TLS、备份与升级。
- [使用说明与 API](docs/usage.md)：Owner API、本地 agent 行为和会话查看。
- [架构设计](docs/design/steward.md) · [产品规格](docs/spec.md) · [路由评测](docs/routing-eval.md)：面向贡献者。

## 许可证

Otto 采用 [MIT License](LICENSE)。
