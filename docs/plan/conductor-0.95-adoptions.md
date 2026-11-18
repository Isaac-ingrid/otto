# Otto 从 Conductor 0.95.0 采纳的改进方案

状态：已全部实施并通过验证（2026-11-18）；设计决策见 [ADR-0022](../adr/0022-report-labels-worktree-hooks-and-readonly-proposals.md)，阶段 1（方案 C）、阶段 2（方案 B）、阶段 3（方案 A `v1` 同机只读探针）与阶段 4（方案 A `v2` 跨机只读探针 `Needs you` 确认卡闭环）均已落地并通过单测、类型检查与打包门禁。

范围与顺序决定（2026-11-17 已拍板）：按 **方案 C（worker report 结构化标签） → 方案 B（本地批准的 worktree 生命周期钩子） → 方案 A（只读 worker 提案协议：v1 同仓/同机只读、v2 跨机只读确认卡）** 的顺序推进；**砍掉方案 A 原草案中的 v3（写类提案）**，所有写任务一律回到 Steward 主循环派发；**Thread 归档决策留在 Steward**，不由 worker 发起。

## 1. 来源与证据等级

Conductor 是 [conductor.build](https://conductor.build)（Melty Labs）的 macOS 桌面应用，定位为并行运行编码 agent 的工作台。0.95.0 的更新元数据（应用自带的 CrabNebula 更新端点，机器可读）为：`version 0.95.0`、`pub_date 2026-11-17T01:02:02Z`、`headline "Local agents orchestration"`。

- **一手**：上述更新端点返回的版本号、发布时间与 headline。
- **索引实证**（conductor.build 在本机被 Cloudflare 拦 403，`curl`、fetch 与 Jina 都取不回原页；下面是该页被搜索引擎收录的**文本片段**，逐字核对）：
  - `Agents in local workspaces can now start and manage other agents … Agents can also cancel and archive chats and workspaces, set workspace statuses, organize workspaces into sidebar sections, and update a repository's setup, run, and archive scripts.`
  - `Fixed archiving or restoring a workspace running shell code embedded in its branch name.`（该页 `## Fixes` 的首条）
  - 该页日期为 `November 16, 2026`，与更新端点的 `pub_date 2026-11-17T01:02Z` 一致——两者相互印证。
  - 同版另有：`Conductor now runs on Electron instead of Tauri`；`In local repository settings, you can set the run mode, mark an action as the default, choose where an action can run, and turn on enterprise data privacy for a single repository`。因为应用已从 Tauri 迁到 Electron，上面那个 CrabNebula feed 之所以仍可用，是因为版本号与时间同 changelog 页一致（交叉一致），而不是因为它仍是唯一权威来源。
- **未找到逐字依据（不得作为依据）**：
  - `In cloud workspaces, fixed the status showing "Running" while the setup script was still running, and the terminal header showing "Running in cloud" while disconnected.` —— 两轮针对该短语的检索都没有命中；同页能取到的相关条目是 `Fixed new workspaces sometimes getting stuck on "Running setup script…"`，而 cloud 那条讲的是侧栏仓库图标。此句按未核实处理，§5 / B3 的状态设计**不引用它作先例**。
  - "合并严格限定于当前工作区已验证的代码版本"——属更早版本的 PR 迭代，不是 0.95.0 的更新。
- **旧功能，不是本版新增**：setup / run / archive 脚本机制本身早于 0.95.0（历史上来自 `.conductor/settings.toml`、旧的仓库内 `conductor.json`，或云端 Cloud Computer 设置）；0.95.0 的新增是**允许 agent 直接修改这些脚本**。方案 B 因此只借"生命周期钩子"这个形态，明确拒绝"仓库内脚本"与"agent 可改脚本"这两个性质。

因此本方案只借用"结构化状态信号、受控 worktree 钩子、受裁定的只读探针提案"三个方向，其余按第 3 节排除。另外，0.93.0（11 月 4 日）宣布加入 Meta，0.94.2（11 月 13 日）撤回原定的云端关停，第三方报道称本地应用也会在 2027 年初逐步停更（第三方来源，仅作参考）——这是"不把它当外部依赖"的另一条理由。

**修订记录**：
- 初稿曾把"agent 主动归档 workspace"列为未证实；该结论已由上面的索引文本推翻（现属已证实，但它仍是 §3 明确不做的事）。
- 2026-11-17 定稿复核：对照当前代码库修正了 5 处实现偏差（补齐第 3 个适配器 `AntigravityAdapter` 与 MCP 审计文件分离、将事件入口从 `connector-protocol.ts` 修正为 `ledger.ts` 的 `applyEvent` 并去掉冗余的 `run_proposal` 下行命令、补齐只读 agent 能力路由与 `sibling` 对 Thread 单链不变量的隔离、将钩子存储改为 `connector.sqlite` `repo` 表、用 `progress` 事件替代重型 `preparing` 状态机），并拍板 §7.3–§7.5 与 `C → B → A（仅只读）` 顺序。

## 2. 现状核查：Otto 已有，因此不重复造

| 对照文提出的缺口 | Otto 现状 | 位置 |
| --- | --- | --- |
| "Connector 直接连目录运行，多 Thread 易脏写" | Git 仓库默认 `isolation=worktree` + `concurrency=parallel`；worktree 在 `~/.otto/worktrees/<repoName>-<pathHash>/<branchSlug>`，分支 `otto/<threadSlug>-<n>`；**不自动删除**，`cleanup_worktree` 仅显式命令触发，默认拒绝有未提交改动或未推送提交的 worktree | [`docs/design/connector-pi.md`](../design/connector-pi.md) §8.2、[`apps/connector/src/worktree.ts`](../../apps/connector/src/worktree.ts) |
| 仓库级配置应"零仓库污染" | 已是本地设置：`otto repo-config <path> --isolation worktree\|in-place --concurrency parallel\|serial --approve`，持久化在 `connector.sqlite`（`0600`）的 `repo` 表；项目批准与写策略都是本地设置，Steward 模型没有修改本地写策略的工具 | [`apps/connector/src/cli.ts`](../../apps/connector/src/cli.ts)、[`apps/connector/src/store.ts`](../../apps/connector/src/store.ts) |
| 应细分 worker 状态，避免误判 stall | 已有 `queued / starting / running / recovering / lost / broken / idle`；本地 `StallWatchdog` 按整棵子进程树累积 CPU 增量判活，云端 DO 有 `silentSince` 与 `reapWorker` 兜底；Thread 派生状态为 `running / waiting_you / idle` | [`apps/connector/src/watchdog.ts`](../../apps/connector/src/watchdog.ts)、[`apps/steward/src/ledger.ts`](../../apps/steward/src/ledger.ts) |
| 应确保数组传参、禁用 `shell: true` | 全仓没有 `shell: true`，全部 `spawn(file, args)` / `execFile`；分支名由本地 `slugify` 生成，不是远端 PR 分支名 | [`apps/connector/src/worktree.ts`](../../apps/connector/src/worktree.ts)、[`apps/connector/src/pr.ts`](../../apps/connector/src/pr.ts) |
| "拓扑严格单向，单 worker 串行会慢" | 并行写任务本来就允许（默认 parallel）；worker→worker 接力也已存在（`parentWorker` relay 关系 + `decideContinuation` / `assembleBrief`） | [`apps/steward/src/handoff.ts`](../../apps/steward/src/handoff.ts)、[`apps/steward/src/dispatch.ts`](../../apps/steward/src/dispatch.ts) |
| 应在 Ledger 中绑定 `head_sha` | `sh_pr_watch.head` 已存在并每轮写入；通知 id 为 `pr-watch:<watchId>:<head>:<kind>`，稳定且按 head 去重 | [`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts) `sh_pr_watch`、[`apps/steward/src/pr-watch.ts`](../../apps/steward/src/pr-watch.ts) |
| 收尾汇报需结构化 | 收尾报告已有结构：`sh_report` 的 `status / summary / changes / decisions / leftovers / tests / question / next / answer / git`，`status ∈ done\|blocked\|needs_decision`，跨 `pi`、`claude-code`、`antigravity` 三端统一归一 | [`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts) `sh_report`、[`apps/connector/src/pi-adapter.ts`](../../apps/connector/src/pi-adapter.ts) |

README 的 [PR follow-up](../../README.md) 一节里 "changed-head acceptance remain separate validation work" 指的是**没有验证过这条路径**，不是功能缺失；[`docs/pr-watches.md`](../pr-watches.md) 同样只承诺只读。

## 3. 本轮范围

**做（按优先级与实施顺序排列）**

1. **方案 C（第 1 顺位）**：worker report 的结构化标签（最小闭环，覆盖三端适配器与确定性展示）。
2. **方案 B（第 2 顺位）**：本地批准的 worktree 生命周期钩子（`setup / archive`，落 `connector.sqlite`，解决新建 worktree 缺依赖/缺环境的高频痛点）。
3. **方案 A（第 3 顺位）**：只读 worker 提案协议——worker 不能自己拉起进程，只能提交只读探查提案，由 Steward 确定性裁定后通过标准 `start_worker` 拉起只读 `sibling`（v1 同仓库只读，v2 跨仓库/跨机只读）。

**不做 / 明确排除**

- **worker 发起写类提案（原草案 A v3）**：不引入。写分支涉及双分支合并冲突与权限升级，所有写任务必须回到 Steward 主循环由模型或 owner 决策后走正统派发。
- **worker 主动归档 Thread**：归档决策留在 Steward。
- **Conductor 式 sidebar sections / 看板分组**：纯 UI 议题，不在本轮引入。
- **`run` 类长驻脚本（dev server）**：会把 Connector 变成进程管理器，超出"管理一次性/驻留编码会话"的边界。
- **仓库内配置文件（`conductor.json`）或允许 agent 修改钩子脚本**：clone 仓库即代码执行，不接受。
- **PR watch 的 head 策略改动**：保持每个 head 独立通知的现状（见 §7.1）。
- **协议重写、向量记忆、整体架构迁移**：不在本轮。

## 4. 方案 C：worker report 的结构化标签（第 1 顺位）

目标：让 worker 在收尾报告里附带受控分类标签，供确定性卡片、时间线与后续痛点统计（例如统计 `blocked-by-env` 频率）使用；**任何标签都不得直接触发派发、归档或"自动通过"**。

- **三端工具载体与校验对齐**：
  1. **pi**：[`apps/connector/src/ext/otto-pi.ts`](../../apps/connector/src/ext/otto-pi.ts) 的 `reportParameters` 新增可选 `labels: string[]`。
  2. **claude-code & antigravity (`agy acp`)**：[`apps/connector/src/mcp/report-server.mjs`](../../apps/connector/src/mcp/report-server.mjs) 的 `REPORT_TOOL.inputSchema.properties` 同步新增可选 `labels` 数组描述（否则 MCP 模型侧看不到该参数）。
  3. **统一边界清洗**：在 [`apps/connector/src/pi-adapter.ts`](../../apps/connector/src/pi-adapter.ts) 的 `normalizeReport`（`pi`、`claude-code`、`antigravity` 三端共用）中与 `leftovers` 同处解析。
  4. **Steward 存储**：[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts) 新增迁移（当前末条为 `038_agent_model_selection`，顺延为 `039_report_labels`），为 `sh_report` 增加 `labels TEXT`（JSON 数组）。
- **字段语义**：未提供（`undefined`，落库 `NULL`）与空数组 `[]`（明确声明无标签）严格区分，与 `leftovers` 既有语义一致。
- **受控词表与上限（已拍板）**：
  - 允许词表：`blocked-by-env`、`needs-human-verify`、`flaky-test`、`needs-migration`、`scope-creep`。
  - 格式与数量约束：单个匹配 `^[a-z0-9-]{1,32}$`，去重后最多保留前 3 个；未知标签或超限项在 `normalizeReport` 与 Steward 入库边界直接剔除并记一条诊断日志，不报错打断收尾、不落库、不打扰 owner，防止标签演变为第二条自由文本控制通道。
- **消费方**：
  - `done_report` 消息与 Thread timeline 追加一行确定性标签展示（LLM 不在该路径上）；
  - Steward 的 `eventWakeText` 带上已清洗标签，供摘要更新与备注判断参考；
  - `handoff` 交接简报暂不注入标签（避免给下一棒 worker 增加隐式分支暗示），后续视真实数据再评估。
- **验证**：三端工具 schema 与 `normalizeReport` 单测（超额 / 未知词 / 重复 / `undefined` vs `[]`）、Steward `039` 迁移与 reducer 幂等测试（同 `(workerId, seq)` 重放只写一次）、消息模板与 timeline 渲染测试。

## 5. 方案 B：本地批准的生命周期钩子（第 2 顺位）

真实缺口是**新建写模式 worktree 后的环境初始化与清理前归档钩子**：Otto 已有 worktree 隔离，但新建分支目录缺少受控的依赖链接或环境准备钩子。

### B1 定义、存储与信任边界（落 `connector.sqlite`）

- **统一存入 `LocalStore`**：Otto 所有仓库级本地配置均存于 [`apps/connector/src/store.ts`](../../apps/connector/src/store.ts) 的 `connector.sqlite`（`0600` 权限）`repo` 表，**不新建 `~/.otto/repos/*.json` 文件体系**，避免双数据源漂移。
- **表结构演进**：通过 `LocalStore.addColumnIfMissing("repo", ...)` 幂等新增钩子列：`setupHook TEXT`、`archiveHook TEXT`、`hookApprovedSha256 TEXT`、`hookApprovedAt INTEGER`。
- **仅限本机 CLI 写入与哈希绑定**：
  - 仅允许通过 [`apps/connector/src/cli.ts`](../../apps/connector/src/cli.ts) 的 `otto repo-config <path> [--setup-hook <script>] [--archive-hook <script>] [--approve-hooks | --clear-hooks]` 设置与批准；远端 `start_worker` 命令若携带任何钩子字段，一律由 `WorkerManager` 的 `rejectLocalOnlyArgs` 直接拒绝（`local_only_setting`）。
  - 脚本文件必须位于本机受控目录 `~/.otto/hooks/` 下（禁止指向仓库内脚本，彻底拒绝 `conductor.json` 式"clone 即代码执行"）。
  - 执行 `--approve-hooks` 时计算 `SHA-256(canonicalHookSpec + "\0" + setupScriptBytes + "\0" + archiveScriptBytes)` 写入 `hookApprovedSha256`。运行时每次执行前重新计算并比对：配置或入口脚本任意字节变化即视为未批准，拒绝执行并提示重新运行 `otto repo-config <path> --approve-hooks`。
  - **显式信任说明**：钩子以 `cwd = worktree` 运行；虽然入口脚本字节受 `~/.otto/hooks/` 与 SHA-256 锁定，但若钩子内部调用 `pnpm install` 等包管理器，仍会读取仓库内的锁文件与声明。Owner 在本机对该仓库执行 `--approve-hooks` 即代表显式接受该仓库的构建输入边界。
- **向 Steward 上报布尔摘要**：[`packages/protocol/src/messages.ts`](../../packages/protocol/src/messages.ts) 的 `RepoSchema` 与 Steward `sh_repo` 表扩展布尔能力摘要（`hasSetupHook`、`hasArchiveHook`、`approved` 及 `capabilityKind`），绝不上报脚本内容或本机私有路径。CLI 修改后沿用 `cli.ts` 的 `noteServiceRestart()` 提示重连刷新 `hello` 快照。

### B2 执行规则

- 沿用 `execFile(scriptPath, [], { cwd: worktree })` 数组传参、禁用 `shell: true`；设置独立硬超时（默认 180 秒，可配置）、stdout/stderr 截断上限，脱敏日志写入 `~/.otto/logs/hook-<workerId>.log`。
- 子进程环境变量复用 `childEnv` 白名单（剥离全部 `OTTO_*` 与连接器凭据，仅保留基础系统环境与已配置的代理变量），`stdin` 置为 `"ignore"`（非交互）。
- **仅在写任务的新建 worktree 上运行**：
  - 原目录只读任务（`mode = "readonly"` 无 `base`）与 `in-place` 写任务不建 worktree，不跑钩子；
  - 只读接力（`createReadonlyWorktree` 生成的 `<slug>-ro-<n>` 分离 HEAD worktree）同样不跑钩子——文档明确约定：**只读分离 worktree 仅保证源码快照检出，不承诺提供构建产物或依赖目录**。
- **失败即停，绝不带病运行**：`setup` 钩子非零退出、超时或哈希失配时，中止 `launchWorker`，调用 `discardLaunchArtifacts` 回收刚建好的空 worktree，使 worker 落 `broken` 并返回独立错误码 `setup_hook_failed`（与编码 agent 自身 `startup_failed` 区分）。

### B3 状态与防误判机制（不新增 `preparing` 状态）

- **保持现有状态集不变**：本地 [`apps/connector/src/watchdog.ts`](../../apps/connector/src/watchdog.ts) 只检查已 `adapter.start()` 产生 PID 且处于 `running | recovering` 的进程，跑 `setup` 钩子期间编码 agent 尚未启动，本地 watchdog 天然不会触发；云端 Steward DO 的 `silentSince` 则通过 `COALESCE(lastEventAt, createdAt)` 检查 `starting` 状态（默认 8 分钟阈值）。
- 为避免跨端十几处状态枚举（`ACTIVE_WORKER_STATES`、`reconcileFromSnapshot` 等）因新增状态产生对账裂缝，**不新增 `preparing` worker 状态**：`setup` 期间 worker 保持 `starting`，Connector 在启动 `setup` 钩子前立即发出一条 `{ type: "progress", phase: "setup_hook", target: "setup" }` 事件刷新云端 `sh_worker.lastEventAt`，配合钩子自身 180 秒硬超时即可零侵入消除云端误判 stall。

### B4 archive 与清理

- `archive` 钩子与显式 `cleanup_worktree` 命令绑定，在校验 worktree 干净且已推送**之后**、`git worktree remove` **之前**执行。
- 有未提交改动或未推送提交时照常拒绝（除非显式 `force`）；`archive` 钩子执行失败或哈希失配时**不删除 worktree**，返回 `archive_hook_failed` 并保留现场证据。

### B5 验证

未批准/哈希变更拒绝执行、`rejectLocalOnlyArgs` 拦截远端注入、`setup` 超时与失败自动清理空 worktree、`progress{phase:"setup_hook"}` 刷新云端活跃时间、脏 worktree 不跑 `archive`、`archive` 失败保留目录、`childEnv` 不泄露 `OTTO_*` 凭据。

## 6. 方案 A：只读 worker 提案协议（第 3 顺位，收敛为只读探针）

真实缺口是**受控的跨仓/独立上下文只读探查发起权**：当正在执行任务的 worker 需要核对另一仓库的接口契约，或在不污染自身上下文的前提下做独立只读核查时，允许其提交结构化提案，由 Steward 确定性裁定后派发只读 `sibling` worker。**不做任何写类提案**。

### A1 协议与归约层（`packages/protocol` & `apps/steward`）

- **上行事件**：复用现有 `events` 批次（`WorkerEventSchema` 已是 `type: string` + `catchall(unknown)`，无需升协议大版本），新增 `type: "proposal"`。载荷在边界用 `z.strictObject` 严格校验：`kind: "readonly_probe"`、`targetRepoRef`、`prompt`、`reason`、`proposalKey`（幂等键）。
- **归约入口（修正位置）**：[`apps/steward/src/connector-protocol.ts`](../../apps/steward/src/connector-protocol.ts) 的 `handleEvents` 仅负责持久化 `event_inbox` 与累计 ACK，不按 `type` 过滤；真正需要在 `switch (type)` 中显式接入 `case "proposal"` 的位置是 [`apps/steward/src/ledger.ts`](../../apps/steward/src/ledger.ts) 的 `applyEvent`（此前未知 `type` 落入 `default` 无动作）。
- **下行命令复用 `start_worker`**：不新增 `run_proposal` 命令类型。提案在 Steward 云端完成确定性裁定后，直接调用现有 `Dispatcher` 向目标机器下发标准 `start_worker`（强制 `mode: "readonly"`），完整复用现有的命令幂等、离线处理与会话管理。

### A2 Ledger 表结构

新增迁移建表 `sh_proposal`：

| 列 | 说明 |
| --- | --- |
| `id, workerId, seq, threadId, kind` | 提案身份与来源定位 |
| `targetRepoId, targetDeviceId` | 明文索引列：供裁定、配额统计与在线校验直接查询 |
| `prompt, reason` | 经长度与标记转义清洗后的只读探查任务与理由 |
| `status` | `auto_approved / pending_owner / approved / declined / rejected / expired / dispatched` |
| `rejectCode` | 确定性拒绝理由码（如 `quota_exceeded`、`depth_exceeded`、`machine_offline`、`no_readonly_agent`） |
| `spawnedWorkerId` | 派发成功后的 `sibling` workerId |
| `createdAt, expiresAt, decidedBy, decidedAt` | 生命周期与审计 |
| `dedupeKey` | 唯一约束（`${workerId}:${proposalKey}`），保证重放不产生第二次裁定或派发 |

事件归约、配额扣减、确认问题写入在同一同步事务内完成。

### A3 确定性裁定与只读 Agent 路由（不交给 LLM）

| 提案场景 | 确定性裁定规则 |
| --- | --- |
| `proposalDepth >= 1`（由 `sibling` 再次发起） | 直接拒绝（`depth_exceeded`），硬性锁定 `maxProposalDepth = 1`，杜绝链式裂变 |
| 配额超限（单 worker 累计 > 2、单 Thread 在飞 `sibling` >= 2、全局在飞自动 `sibling` >= 3） | 直接拒绝（`quota_exceeded`） |
| 目标仓库未注册，或目标机器离线 | 直接拒绝（`repo_not_found` / `machine_offline`） |
| 目标机器上**不存在 `capabilities.readonly === true` 的可用 agent** | 直接拒绝（`no_readonly_agent`） |
| 同机器（同仓或同机跨仓）只读探查 | 自动批准，并入预算统计 |
| 跨机器只读探查 | **默认不自动批准**，转 `pending_owner` 生成 **Needs you** 确认项（10 分钟过期，与 [ADR-0019](../adr/0019-pr-watch-owner-confirmation.md) 同构），防止静默消耗另一台机器的额度 |

**关键能力路由规则**：当前适配器中，`pi` 支持 `readonly: true`，而 [`claude-adapter.ts`](../../apps/connector/src/claude-adapter.ts) 与 [`antigravity-adapter.ts`](../../apps/connector/src/antigravity-adapter.ts) 均诚实声明 `readonly: false`（`WorkerManager.startWorker` 会对 `readonly: false` 的 agent 抛 `unsupported_capability`）。因此当 `claude-code` 或 `antigravity` worker 发起只读提案时，Steward 裁定器**绝不能盲目继承父 worker 的 `agent`**，必须显式选择目标机器 `hello.agents` 中声明 `readonly: true` 的 agent（如 `pi`）。

### A4 派发语义与 Thread 单链不变量隔离

- `sh_worker` 新增两列：`workerRelation TEXT NOT NULL DEFAULT 'relay'`（取值 `'relay' | 'sibling'`）与 `proposalDepth INTEGER NOT NULL DEFAULT 0`（`sibling` 固定写 `1`）。
- **保护主线不变量（严禁 `sibling` 篡夺主线）**：
  1. `ledger.workers.latestOnThread`、`relaySource`、`latestBranchOnThread` 以及 `handoff.build` 的默认前序选取**必须过滤 `workerRelation = 'relay'`**（排除 `'sibling'`），否则只读 `sibling` 会覆盖主线最新 worker，导致用户后续发消息时误触发 `mode_switch` / `repo_switch` 或把交接简报锚定到探针上。
  2. 派发 `sibling` 时走独立的轻量入口，**严禁调用 `questions.closeOpen(threadId, ...)`，也严禁改写 `sh_thread.lastMachine`**，确保不会误关同 Thread 正在等待 owner 拍板的问题或冲掉主线机器亲和性。
- **单向非阻塞**：Otto 不设父子同步等待通道。工具同步回执固定为 `queued_for_steward_decision`（明确告知模型云端尚未裁定、严禁等待或编造探查结果）；父 worker 正常收尾退出，`sibling` 跑完后其 `report` 进入 `sh_report` 与 `sh_timeline` 并唤醒 Steward 汇总。

### A5 三端 worker 侧入口与 MCP 带外文件分离

不引入任何直写事件日志或内部 IPC 的旁路，严格复用并扩展现有三端工具通道：

1. **pi**：[`apps/connector/src/ext/otto-pi.ts`](../../apps/connector/src/ext/otto-pi.ts) 注册 `propose` 工具，通过 RPC 工具事件由 `PiAdapter` 归一为 `proposal` 事件。
2. **claude-code**：[`apps/connector/src/mcp/report-server.mjs`](../../apps/connector/src/mcp/report-server.mjs) 新增 `propose` 工具，[`apps/connector/src/claude-adapter.ts`](../../apps/connector/src/claude-adapter.ts) 按 `__propose` 后缀识别工具调用。
3. **antigravity (`agy acp`)**：[`apps/connector/src/antigravity-adapter.ts`](../../apps/connector/src/antigravity-adapter.ts) 新增 `isAcpProposalTool` 匹配。**带外审计文件分离**：由于真实 `agy acp` 服务端在 `session/update` 中可能省略 MCP `rawInput`（`AntigravityAdapter` 依赖读取 `report-server.mjs` 落盘文件兜底），而单次运行可产生最多 2 次 `propose` 加 1 次 `report`，`report-server.mjs` 不能把 `propose` 写入覆盖式的 `argv[2]`（`reportFile`），必须接收独立的 `argv[3]`（`proposals-${workerId}.jsonl`，追加写入每条通过校验的提案并在回合开始前清理），防止 `propose` 与 `report` 互相覆盖。

子进程继续保持零 `OTTO_*` 环境变量、零连接器凭据暴露。

### A6 验证与形式模型边界

- 实现回归：`ledger.applyEvent` 提案分支、逐项确定性裁定真值表、`dedupeKey` 重放幂等、`proposalDepth = 1` 阻断二阶派生、`claude/agy` 父 worker 自动路由至 `pi` 只读 agent、`sibling` 不污染 `latestOnThread` / `lastMachine` / open questions、跨机确认卡片过期与单次生效、`agy` 省略 `rawInput` 时从 `proposals-*.jsonl` 完整回收多条提案与最终 `report`。
- 形式模型边界：[`formal/README.md`](../../formal/README.md) 仅覆盖单 worker 的事件持久化、超限隔离、ACK 与至多一次归约；提案经既有 `events` 通道投递时如果改动了 `events.ts`、`connector-protocol.ts` 或 `ledger.ts` 归约骨架，按 `AGENTS.md` 跑 `node scripts/verification/run-tla.mjs`（含两个负控制）确认投递层未退化，但**绝不把 TLC 通过表述为对提案裁定、配额或 `start_worker` 派发路径的验证**。

## 7. 策略决定汇总（全部已定）

1. **PR watch changed-head：保持现状**（2026-11-17 已定）。每个 head 各自一条通知（通知 id `pr-watch:<watchId>:<head>:<kind>`），不改成"head 变化先静默、等 owner 重新确认"，避免漏报新提交结果；也不额外改写通知措辞。
2. **方案 C 词表与上限**（2026-11-17 已定）。上限 3 个，匹配 `^[a-z0-9-]{1,32}$`；词表固定为 `blocked-by-env`、`needs-human-verify`、`flaky-test`、`needs-migration`、`scope-creep`（不设与 `status = done` 重叠的 `ready-for-review`）。
3. **方案 B 钩子存储位置与能力上报**（2026-11-17 已定）。纯本机存储在 `connector.sqlite` 的 `repo` 表，入口脚本限定于 `~/.otto/hooks/` 并做配置 + 脚本字节联合 SHA-256 审批绑定；`hello.repos` 仅向 Steward 上报布尔能力摘要（`hasSetupHook`、`hasArchiveHook`、`approved` 及 `capabilityKind`），不上报脚本正文。
4. **方案 A 范围、配额与跨机策略**（2026-11-17 已定）。收敛为纯只读探针（砍掉 v3 写类提案）；配额定为单 worker ≤ 2 次、单 Thread 在飞 `sibling` ≤ 2、全局在飞自动批准 ≤ 3、强制 `proposalDepth = 1`；跨机只读默认不自动批准（走 **Needs you** 确认按钮）。
5. **留档方式**（2026-11-17 已定）。不单独新建 `docs/research` 对照文；本文档留存 `docs/plan/conductor-0.95-adoptions.md`，架构决策正式落入 [ADR-0022](../adr/0022-report-labels-worktree-hooks-and-readonly-proposals.md)。

## 8. 实施顺序与阶段门禁

1. **阶段 1：方案 C（Report 结构化标签）**
   - 范围：`otto-pi.ts`、`report-server.mjs`、`pi-adapter.ts`、Steward `039_report_labels` 迁移、消息卡片与 timeline 渲染、`eventWakeText`。
   - 门禁：三端单测 + Steward 迁移/归约回归 + `corepack pnpm -r typecheck` + `npm pack --dry-run` 打包自检通过。
2. **阶段 2：方案 B（本地批准的 Worktree 生命周期钩子）**
   - 范围：`LocalStore` `repo` 表钩子列与 SHA-256 校验、`otto repo-config` CLI、`HelloMessage` / `sh_repo` 布尔能力摘要、`WorkerManager.launchWorker`（`setup` + `progress{phase:"setup_hook"}`）与 `cleanupWorktree`（`archive`）。
   - 门禁：哈希失效/未批准拦截、远端参数拒绝、超时回收空 worktree、脏树/失败保留现场及凭据隔离单测全部通过。
3. **阶段 3：方案 A（只读 Worker 提案协议）**
   - 范围：先落 v1（同机只读探针 + `sh_proposal` + `sibling` 主线隔离 + 三端 `propose` 工具与 `proposals-*.jsonl` 分离），验收稳定后再开 v2（跨机只读 + **Needs you** 确认按钮）。
   - 门禁：裁定真值表、重放幂等、`sibling` 不污染 `latestOnThread` / open questions、只读 agent 路由回归通过；若触及事件归约骨架，同步跑通 `run-tla.mjs` 基线与双负控。

每阶段完成后严格按 `AGENTS.md` 汇报：为何选择这些检查、实际运行了什么、通过/失败结果、证据保留位置，以及哪些层尚未验证。

## 相关文档

- [领域术语与边界](../../CONTEXT.md)
- [ADR-0022：结构化汇报标签、本地生命周期钩子与只读探针提案](../adr/0022-report-labels-worktree-hooks-and-readonly-proposals.md)
- [写策略与 worktree 隔离](../design/connector-pi.md#82-write-tasks-write-policy)
- [Steward 架构](../design/steward.md)
- [ADR-0017：turn 串行且可取消](../adr/0017-turns-are-serial-and-cancellable.md)
- [ADR-0019：PR watch 变更需绑定的 owner 确认](../adr/0019-pr-watch-owner-confirmation.md)
- [ADR-0021：本地 agent 模型默认与能力声明](../adr/0021-local-agent-model-selection.md)
- [PR follow-up](../pr-watches.md)
- [事件投递验证试点](../../formal/README.md)
- [技术验证结论](../spike-conclusions.md)
