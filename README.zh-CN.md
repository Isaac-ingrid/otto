<p align="center">
  <img src="apps/steward/ui/brand/otto.svg" alt="Otto" width="88" height="88">
</p>

<h1 align="center">Otto</h1>

<p align="center"><strong>汇聚你的所有 agent。</strong></p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

Otto 是一个**自行托管的个人智能体**。总管作为 Node.js 进程运行，状态保存在 SQLite；各台电脑上的 connector（连接器）在你选择的目录中运行本地 coding agent。你可以在网页工作台和 Otto 对话、交代任务，之后从别的设备接着聊。

- **多台机器，一处对话。** 任务、待决事项、后续安排和进展集中在一起。
- **代码留在自己的电脑上。** 连接器在本地运行 pi（或已安装的 Claude Code）；coding agent 的完整会话记录也留在本机。
- **有边界的记忆。** 偏好和项目约定与聊天记录分开保存，记录来源及确认状态；过时事实被取代和仅为腾空间而归档是两回事。
- **随时由你掌控。** 工作台显示正在进行的任务和需要你决定的事项；正在生成的回复可以停下。

## 开始使用

运行总管需要 **Node.js 24**；构建时使用 [`package.json`](package.json) 锁定的 pnpm 版本（若没有 `corepack` 命令，请先安装 Corepack），登录后还需在工作台填写总管的模型 API key。运行连接器的电脑需要 **Node.js 22.18+**、macOS 或 Linux，以及另行安装并完成登录／模型配置的本地 coding agent。总管的模型密钥不会替本地 agent 配置模型。

### 1. 运行总管

从代码检出目录构建，先在自己的电脑上试用：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @isaac2ingrid/steward build:node
mkdir -p apps/steward/dist/ui
cp -R apps/steward/ui/. apps/steward/dist/ui/
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars：把 LOGIN_PASSWORD 设为至少 15 个字符的独立密码。
HOST=127.0.0.1 PORT=8787 OTTO_CONFIG_DIR="$PWD" OTTO_DB_PATH="$PWD/apps/steward/data/steward.sqlite" \
  node apps/steward/dist/node/steward-node.mjs
```

打开 <http://127.0.0.1:8787> 登录，在工作台的**设置**中填写总管的模型 API key。不要提交 `.dev.vars`，也不要在聊天里发送密码或密钥。上面的例子只监听本机，**其他电脑的连接器无法直接访问**。

要长期运行并让其他电脑连接，请按[自托管操作手册](docs/self-hosted.md)部署：除了 bundle，还要部署 **`dist/ui` 和运行时依赖 `ws`**；用服务管理进程和独立的 SQLite 数据目录；通过支持 WebSocket 转发的 HTTPS 反向代理对外提供工作台（仅本机访问时也可以用 SSH 隧道）。明确设置 `OTTO_CONFIG_DIR` 和 `OTTO_DB_PATH`。在线备份 SQLite 请用 SQLite 的 `.backup`，不要只复制处于 WAL 模式的数据库文件。

**完成标志：** 打开工作台，Otto 能回复消息。尚未连接电脑时也可以先对话。

### 2. 连接电脑

在装有 Node.js 22.18+ 和已配置好的本地 coding agent 的 macOS 或 Linux 电脑上，安装已发布的连接器：

```sh
npm install --global @isaac2ingrid/otto
otto --version
```

在 Otto 工作台打开**机器 → 添加机器 → 生成配对命令**，然后在**要连接的电脑上**使用安装好的 CLI，填入实际部署地址和一次性配对码：

```sh
otto connect <你的-Otto-地址> <一次性配对码>
otto status
```

配对码十分钟后过期且只能使用一次，不要发进聊天或日志。配对会安装并启动后台服务（macOS 用 launchd，Linux 用 systemd 用户服务）。连接器主动连向 Otto，电脑无需开放入站端口。在工作台**机器**页面只添加你选定的本地目录，然后用 pi 试一个小的只读任务。如果机器没有显示在线，用 `otto logs -n 50` 排查；执行任务时电脑需要保持唤醒和联网。代理、无服务管理器或源码安装步骤见[连接器操作文档](docs/agent-connect.md)。

**完成标志：** 机器和选定目录显示在线，测试任务返回结果。其他电脑重复这一步。

## 开始对话

可以试试：

> 「检查一下 my-app 的登录流程，告诉我发现了什么问题。」
>
> 「用我 Mac 上的 pi 把这个 bug 修一下。」
>
> 「接着上次的任务做，这次用 pnpm。」

工作台把消息、任务线程、待决事项、已连接的机器和会话记录放在一起。回复边写边出现；中途发的消息排在当前回复之后。

## 它如何工作

**你 → Otto（Node.js + SQLite）→ 主动建立的 WebSocket → connector → pi / Claude Code**

总管协调对话、任务和受治理的记忆；连接器启动本地 coding agent 并回传进展。总管状态存放在**你自己的主机**上的 SQLite 中，需要你自行运维和备份；仓库内容及完整的本地 agent 会话留在运行连接器的电脑上。总管与本地 agent 分别使用各自配置的模型服务。

## 进一步了解

- [自托管操作手册](docs/self-hosted.md)：服务、反向代理、TLS、升级和备份。
- [连接器操作文档](docs/agent-connect.md)：配对、目录、代理和排错。
- [使用说明与 API](docs/usage.md)：Owner API、本地 agent 行为和会话查看。
- [架构设计](docs/design/steward.md) · [产品规格](docs/spec.md) · [路由评测](docs/routing-eval.md) · [记忆评测](docs/memory-eval.md)：面向贡献者。

## 许可证

Otto 采用 [MIT License](LICENSE)。
