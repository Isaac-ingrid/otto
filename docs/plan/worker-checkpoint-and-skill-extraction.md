# 中断任务断点快照、轨迹压缩与 Skill 提炼实施方案

状态：已落地（2026-11-19）。关联前序决策：[ADR-0003](../adr/0003-owner-api-replaces-chat-channel.md)（全保真会话回放）、[ADR-0004](../adr/0004-web-workspace.md)（Web Workspace）、[ADR-0017](../adr/0017-turns-are-serial-and-cancellable.md)（串行可取消轮次）、[ADR-0022](../adr/0022-report-labels-worktree-hooks-and-readonly-proposals.md)（只读提议与受控边界），以及已落地的 [2A 记忆与主动调度控制面](./memory-and-proactive-control-plane.md)。

实施顺序：**Stage 1（Protocol + Connector 层：`worker_checkpoint` 确定性断点采集与轨迹折叠脱敏） → Stage 2（Steward 层：断点中继、交接简报兜底、无状态 `completeSimple` 压缩与 Skill 提炼 API） → Stage 3（Web Workspace 断点抽屉、压缩续跑与 Skill 草稿预览导出交互）**。

## 1. 背景与真实痛点

目前 Otto 在 Worker **正常收尾**时体验闭环完整：Worker 调用 `report` 写入 `sh_report`（含 `summary`、`decisions`、`leftovers` 与 `GitFacts`），后续换棒由 [`handoff.ts`](../../apps/steward/src/handoff.ts) 自动组装 `【交接简报】`。但当任务遭遇**手动中断（`interrupt_worker`）、异常掉线（`lost`）、上下文触顶（`error:context`）或半途暂停**时，存在三处明显断层：

1. **停机现场「失忆」**：未调 `report` 即停下的 Worker 在 Steward 账本中仅留下 `lastOutcome` 与单步 `lastProgress`，既看不出停机前完成了哪些子步骤，[`handoff.ts`](../../apps/steward/src/handoff.ts) 换棒时也拿不到这一棒的进展与卡点。
2. **本地完整轨迹未被提炼复用**：Connector 侧 [`session-history.ts`](../../apps/connector/src/session-history.ts) 已能将 `pi`、`claude-code`、`codex` 三类后端的本地会话 JSONL 归一化为结构化 `HistoryEntry[]`，但目前仅用于浏览器逐条翻阅原始流水账，缺少秒级折叠的「断点快照」与面向续跑的「压缩交接包」。
3. **排障经验难以沉淀为记忆或 Skill**：复杂任务（即便中途暂停或几经试错才跑通）往往包含极高价值的仓库构建命令、排障路径与踩坑结论，目前缺少从会话轨迹一键提炼为 **2A 项目记忆** 或标准 **`SKILL.md` 技能模板** 的通道。

## 2. 现状盘点（复用既有底座，不重复造轮子）

| 模块 | 已有能力 | 现有缺口 | 代码位置 |
| --- | --- | --- | --- |
| 多后端会话解析 | 已统一解析 `pi`（分支树回溯）、`claude-code`（过滤 `isSidechain` 与纯 `tool_result`）、`codex`（去重双写事件）的会话 JSONL，输出带 `role`、`text`、`tools: [{ name, args }]` 的 `HistoryEntry[]` | 仅提供分页原始流 `history_req` / `history_chunk`，缺少在 Connector 本地完成的去重动作聚合与尾部断点快照提取 | [`apps/connector/src/session-history.ts`](../../apps/connector/src/session-history.ts)、[`apps/connector/src/full-session-history.ts`](../../apps/connector/src/full-session-history.ts) |
| Git 状态与按需中继 | 已有 `collectGitFacts`、`collectWorkerDiff`、`redactText` 脱敏及 `diffWorker` 无状态有界 WS 中继范式 | 尚未将「停机时未提交脏文件 + 最近提交 + 会话尾部动作链」合成为单次轻量断点帧 | [`apps/connector/src/git-diff.ts`](../../apps/connector/src/git-diff.ts)、[`apps/steward/src/connector-protocol.ts`](../../apps/steward/src/connector-protocol.ts) |
| 交接简报（Handoff） | `assembleBrief` 可跨多份 `ReportRow` 去重汇总 `decisions`、`leftovers` 与 `GitFacts` | 前一棒无 `ReportRow`（被中断或崩溃）时，简报缺失该棒已改文件、最后执行的命令与停机原因 | [`apps/steward/src/handoff.ts`](../../apps/steward/src/handoff.ts) |
| 模型旁路推理与记忆面板 | [`connection-test.ts`](../../apps/steward/src/llm/connection-test.ts) 已示范基于 `buildStewardModels(...).completeSimple()` 的独立旁路调用；2A 控制面已提供 `/app/api/memory` 确定性落库 | 缺少基于旁路 `completeSimple` 的结构化压缩/Skill 提炼接口（不污染 Steward 主会话上下文，且诚实计入 `budget`） | [`apps/steward/src/llm/models.ts`](../../apps/steward/src/llm/models.ts)、[`apps/steward/src/control-plane.ts`](../../apps/steward/src/control-plane.ts) |

## 3. 核心设计不变量与排除范围

### 3.1 核心不变量
1. **L1 确定性断点零模型、零落盘膨胀**：`worker_checkpoint` 在 Connector 本地直接扫描 Session JSONL 与 Git 状态并完成折叠与 `redactText` 脱敏，单包上限 `32 KiB`、超时 `8s`；Steward DO 不将原始会话灌入 SQLite，仅在非正常收尾（`cancelled` / `lost` / `error:*` 且无 `report`）时可选将不超 `1.5 KiB` 的最小纯文本检查点摘要挂在 `sh_worker` 以兜底离线交接简报。
2. **L2 压缩与 Skill 提炼走旁路无状态模型调用（Out-of-Band `completeSimple`）**：绝不将数千字 Worker 工具轨迹塞进 Steward 的持久化主对话（避免污染长期会话并拖慢日常调度）；直接调用 `models.completeSimple()` 执行单轮受控提取，同时将返回耗费（`usage`）如实计入 `ledger.budget.add()`，并在 `budget.over` 时拒绝 L2 调用（L1 断点快照始终 100% 免费可用）。
3. **不可信轨迹隔离与「草稿确认」落盘原则**：Worker 会话可能包含外部网页、报错日志或第三方仓库中的提示词注入文本：
   - L2 系统提示词将输入轨迹严格包裹于不可信数据块中，禁止执行任何工具；
   - 提炼出的项目经验默认仅作为前端草稿展示，由 Owner 在弹窗中审阅勾选后才通过 `POST /app/api/memory` 写入；
   - 提炼出的 `SKILL.md` 默认在弹窗纯文本预览/编辑，提供浏览器本地一键下载（`Blob` 导出）或一键复制，不静默改写本地仓库或全局 `~/.claude` 目录。
4. **严格遵守前端安全与双语门禁**：所有断点轨迹、压缩摘要与 `SKILL.md` 源码预览全部经 [`dom.js`](../../apps/steward/ui/dom.js) 的 `h()` 纯文本节点渲染，通过 [`ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts) 的零 HTML sink 与 EN/ZH 词条对称校验。

### 3.2 明确不做（排除项）
- **不在本轮支持跨机器迁移未推送的本地未提交脏文件（`git stash` 跨机传输）**：跨机换棒仍以已推送分支为准；未提交脏改动在断点快照中显式标红提醒，由原机续跑或用户处理。
- **不在本轮构建复杂的云端 Skill 市场或自动注入全局 Prompt 的隐式规则引擎**：聚焦生成符合业界通用规范（YAML frontmatter `name` + `description` + 步骤正文）的干净 `SKILL.md` 文件与 2A 项目记忆条目。

## 4. 模块一：L1 确定性断点快照与交接兜底（Zero-LLM Checkpoint）

### 4.1 协议定义（[`packages/protocol/src/checkpoint.ts`](../../packages/protocol/src/index.ts)）
对齐 `worker_diff` / `worker_diff_result` 新增无状态有界请求/响应对（`WORKER_CHECKPOINT_MAX_BYTES = 32 * 1024`，`WORKER_CHECKPOINT_TIMEOUT_MS = 8_000`，并在 `hello.agents[].capabilities` 声明 `workerCheckpoint: true`）：

- **请求 `worker_checkpoint`**（Steward DO → Connector）：
  `{ t: "worker_checkpoint", id: string, workerId: string }`
- **响应 `worker_checkpoint_result`**（Connector → Steward DO）：
  - `ok: true` 返回结构化 `WorkerCheckpointPayload`：
    - `workerId`、`agent`、`sessionId`、`turnCount`（用户轮次数）、`toolCallCount`（总工具调用数）；
    - `initialGoal: string | null`（首条用户任务提示摘要，限 500 字）；
    - `lastPrompt: string | null`（停机前最后一条下发给 Worker 的指令，限 500 字）；
    - `recentNotes: string[]`（停机前最后至多 3 条非空 Assistant 推理/结论片段，每条限 800 字）；
    - `touchedFiles: { read: string[]; modified: string[] }`（从工具参数与 Git 实时状态去重提取的已读/已改路径清单，各限 60 项）；
    - `commandsRun: string[]`（按执行顺序去重折叠后的最近 20 条 Shell/测试命令摘要，每条限 120 字）；
    - `lastStep: { tool: string; args?: string } | null`（中断瞬间停留在哪一步工具调用）；
    - `git: GitFacts | null`（实时采集的工作树分支、`ahead` 提交数、`dirty` 未提交文件数与 `changedFiles`）。
  - `ok: false`：`code ∈ "not_found" | "no_history" | "read_failed" | "busy"`。

### 4.2 Connector 折叠算法与安全脱敏
1. **复用归一化解析器**：直接调用 [`session-history.ts`](../../apps/connector/src/session-history.ts) 的 `readSessionHistory` / `readClaudeSessionHistory` / `readCodexSessionHistory`（上限读取最近 `2 MB` 分支记录），在内存中单遍扫描聚合：
   - 连续对同一路径的 `Read` / `View` / `Grep` 自动合并计数，区分只读查阅与写操作（`Edit` / `Write` / `MultiEdit` / 实盘 `git status` 变更）；
   - 提取 `Bash` / `run_command` 命令首行并合并完全相同的重试命令（例如标注 `(×3)`）。
2. **统一脱敏**：所有提取出的 `initialGoal`、`lastPrompt`、`recentNotes`、`commandsRun` 全部经 [`redactText`](../../apps/connector/src/redact.ts) 过滤 API Key、Bearer Token 与环境变量敏感串。

### 4.3 Steward 断点中继与 [`handoff.ts`](../../apps/steward/src/handoff.ts) 断片修补
1. **按需 API 与 Steward 只读工具**：
   - 新增 `POST /app/api/workers/:workerId/checkpoint`（会话 + 同源 + CSRF）；若机器离线，自动降级返回账本已有的 `lastOutcome`、`lastProgress` 与最近静态 `GitFacts`（标明 `offlineFallback: true`）。
   - 在 [`extension.ts`](../../apps/steward/src/llm/extension.ts) 为 Steward 新增只读工具 `inspect_worker_checkpoint(workerId)`，当用户在聊天中问「刚才停掉的任务做到哪了？」时，Steward 可直接拉取结构化快照精准作答，无需盲猜。
2. **换棒续跑自动兜底**：当 [`handoff.ts`](../../apps/steward/src/handoff.ts) 的 `assembleBrief` 发现 `fromWorker` 无对应 `ReportRow`（因中断/掉线/超上下文停机）时，若机器在线则拉取（或读取中断时顺带缓存在 `sh_worker` 的轻量检查点摘要）注入 `【交接简报】` 的「停机现场（未完成汇报）」小节，使接力的新 Worker 清楚前棒改过哪些文件、跑过什么命令、停在哪一步。

## 5. 模块二：L2 按需轨迹压缩与 Skill / 记忆提炼（Stateless Distiller）

### 5.1 旁路无状态推理管线（[`apps/steward/src/distiller.ts`](../../apps/steward/src/llm/models.ts)）
当用户在断点面板点击 **「智能压缩进展」** 或 **「提炼为 Skill / 记忆」** 时，Steward 执行独立于主会话的受控提炼：
1. **前置门禁**：
   - 检查每日额度 `budgetState()`：若 `over === true` 返回 `409 over_budget`（提示明日重置或调高 `DAILY_BUDGET_USD`，同时保留 L1 确定性快照可正常查看与复制）；
   - 检查当前激活的 Steward 模型配置与密钥（复用 [`buildStewardModels`](../../apps/steward/src/llm/models.ts)，缺密钥返回 `409 model_not_configured`）。
2. **输入组装与防注入边界**：
   - 仅将 L1 已脱敏的 `WorkerCheckpointPayload`（上限约 `12,000` 字符）包裹在 `<untrusted_worker_trace>...</untrusted_worker_trace>` 数据块内传入 `models.completeSimple()`（零工具绑定、`maxTokens: 1600`、超时 `30s`）；
   - 推理完成后从返回结果提取 `usage`，调用 `ledger.budget.add()` 如实计入当日模型花费。
3. **两类提炼模式（`POST /app/api/workers/:workerId/distill`，含请求幂等键 `id`）**：
   - **`mode: "handoff"`（断点压缩交接包）**：输出结构化 JSON `{ summary, accomplished: string[], deadEnds: string[], stoppedAt: string, nextSteps: string[], continuationPrompt: string }`，其中 `continuationPrompt` 可直接带入当前 Thread 输入框一键续跑。
   - **`mode: "skill"`（Skill 模板与项目记忆提炼）**：输出结构化 JSON：
     - `skill: { slug: string, name: string, description: string, markdown: string }` —— 严格符合通用 `SKILL.md` 格式（含 YAML frontmatter `name`、`description` 及触发场景、标准命令步骤、常见排障注意项）；
     - `suggestedNotes: Array<{ kind: "convention" | "environment" | "fact", text: string }>` —— 至多 3 条单句高密度项目约定草稿，供用户勾选后直接复用 2A 的 `POST /app/api/memory` 落入对应仓库 `project` 层或全局 `resident` 层。

## 6. 模块三：Web Workspace 断点检视与提炼交互

在右侧详情栏（Context Panel）每个已非活跃或已中断的 `workerNode` 操作行（紧邻现有的「查看变更 / View changes」按钮）新增紧凑动作入口 **「断点与提炼 / Checkpoint & Distill」**：

1. **首屏即开的 L1 断点视图（复用宽屏 `#dialog` 弹窗，零模型等待）**：
   - 顶部状态条展示 Worker 停止原因（`outcome`）、轮次与工具总计、分支与未提交脏改动告警；
   - 分块展示 **停机前最后动作**、**已改/已读文件列表**、**执行过的命令链** 以及 **最后 3 段推理摘要**，支持一键复制纯文本断点快照。
2. **弹窗内 L2 按需动作区（双按钮按需触发）**：
   - **「生成压缩续跑包」**：渲染已完成清单、踩坑排除项与下一步建议，底部提供 **「填入输入框继续派发」**（自动选中该 Thread 并将压缩交接提示填入主输入框）与 **「复制简报」**。
   - **「提炼 Skill 与项目记忆」**：
     - 上半区展示可编辑的 `SKILL.md` 纯文本预览框（`textarea`），支持修改后点击 **「下载 SKILL.md」**（浏览器本地下载 `<slug>-SKILL.md`）或 **「复制全文」**；
     - 下半区展示至多 3 条候选项目记忆勾选列表，点击 **「存入记忆控制面」** 即可逐条调用 `/app/api/memory` 持久化。

## 7. 分阶段实施路线与验证门禁

1. **Stage 1（Protocol + Connector 层）**：
   - 新增 `worker_checkpoint` / `worker_checkpoint_result` 协议 schema 与 `workerCheckpoint` 能力标识；
   - 在 Connector 实现跨 `pi` / `claude-code` / `codex` 的轨迹去重折叠器 `collectWorkerCheckpoint`（含 `redactText` 脱敏、路径与命令频次聚合、实时 Git 状态拼装）；补齐三类后端 JSONL 样本单测（含半截崩溃行与超大输出截断测试）。
2. **Stage 2（Steward 中继、Handoff 兜底与旁路 Distiller 层）**：
   - 落地 `POST /app/api/workers/:workerId/checkpoint` 无状态中继与离线账本回退、Steward 只读工具 `inspect_worker_checkpoint`，并在 [`handoff.ts`](../../apps/steward/src/handoff.ts) 为无 `report` 的中断前棒补齐检查点简报兜底；
   - 落地 `POST /app/api/workers/:workerId/distill`（旁路 `completeSimple`、不可信轨迹隔离提示词、JSON 结构校验、`budget.add` 记账与超预算 `409` 拦截）；补齐路由安全门禁（[`routes-audit.test.ts`](../../apps/steward/test/routes-audit.test.ts)）与提炼单测。
3. **Stage 3（Web Workspace UI 与全仓门禁）**：
   - 新增纯 DOM 模块 `apps/steward/ui/checkpoint.js` 接入 `workerNode` 与 `#dialog`，支持 L1 快照秒开、L2 一键续跑填词、候选记忆一键入库与 `SKILL.md` 预览下载，补齐中英双语 `STRINGS`；
   - 跑通 [`ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts)、全仓 `tsc --noEmit`、`build:node` 与全量 Vitest 套件。
