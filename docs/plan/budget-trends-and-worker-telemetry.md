# 多日预算消费趋势与 Worker 上下文遥测实施方案

状态：已落地（Stage 1–3 全部完成，2026-11-22）
前置依赖：[ADR-0004（Web Workspace）](../adr/0004-web-workspace.md)、[ADR-0010（浏览器认证与会话门禁）](../adr/0010-browser-password-authentication.md)、[ADR-0016（暗色仪表盘视觉体系）](../adr/0016-dark-instrument-panel-theme.md)、[2A 记忆与主动调度控制面](./memory-and-proactive-control-plane.md)、[Worker 断点快照与技能沉淀](./worker-checkpoint-and-skill-extraction.md)、[PR 盯盘 CI 失败诊断闭环](./pr-watch-ci-failure-diagnosis.md)

实施顺序：**Stage 1（`047_telemetry_and_worker_context` 迁移 + Steward 用途分类明细账本与 Worker 幂等结算账本） → Stage 2（Connector 四后端运行期轻量遥测扩展 + `GET /app/api/telemetry` 只读聚合接口与路由审计门禁） → Stage 3（控制面原生 SVG 预算趋势面板、实时上下文水位预警与双语安全门禁）**。

## 1. 背景与真实痛点

随着 Otto 同时承载主对话编排、后台事件唤醒、定时 Routine、PR 盯盘自动诊断、断点记忆/技能提炼，以及多台机器上长周期运行的编码 Agent（`pi` / `claude-code` / `codex` / ACP v1），当前在「成本归因」与「运行期上下文健康度」两个维度存在明显盲区：

1. **预算仅有单日总额且缺少用途/事项归因**：
   - [`schema.ts`](../../apps/steward/src/schema.ts)（`015_budget`）中的 `sh_usage_day` 仅按 UTC 日期记录单一总额 `(day, costUsd, tokens, skippedWakes, overNotedAt, updatedAt)`，而 `sh_run`（`008_steward_llm`）本身**并未存储 `costUsd` 或 `tokens` 列**。
   - Steward 主会话通过 `pi.usage` 累积游标（`sh_usage_cursor`）折算差值，而 [`steward.ts`](../../apps/steward/src/steward.ts) 中的 4 类旁路模型调用（`diagnosePrFailure`、`diagnosePrFeedback`、`distillWorker`、`runAmbientSkillTriage`）均通过 `completeBackgroundText` 直接调用 `budget.add(...)` 混入当日总额。一旦某天消费陡增或触发每日软上限，Owner 无法回溯是主对话、高频 Routine、PR 诊断还是某几个特定 Thread 消耗了额度。
   - 控制面「主动调度」标签页（[`control-plane.js`](../../apps/steward/ui/control-plane.js) `renderSchedulesTab`）目前仅在 `lim.over === true` 超额后才渲染红色告警横幅，常态下甚至看不到今日已用额度进度条与重置倒计时。
2. **总管账本与机器侧 Worker 用量口径混同风险，且历史 Worker 用量易被覆盖丢失**：
   - 如 [`budget.ts`](../../apps/steward/src/budget.ts) 明确界定：`DAILY_BUDGET_USD` 仅度量并约束 **Steward 总管自身**的模型调用，不含配对机器上编码 Agent 的开销（后者可能是 Claude Max / ChatGPT Pro 等订阅制回报 `$0` + 真实 Token，也可能是 API Key 回报美元成本）。
   - 当前 [`ledger.ts`](../../apps/steward/src/ledger.ts) 在处理 Worker `settled` 事件时，仅将 `event.usage` 序列化写入 `sh_worker.lastProgress`；一旦该 Worker 被 `send` 续跑并收到下一条 `progress` 事件，上一轮的 `tokens` 与 `cost` 就会被直接覆盖丢失，无法统计各事项或各仓库的编码 Token 消耗排行。
3. **Worker 运行期上下文水位处于「盲飞」状态**：
   - `sh_worker` 目前仅有整数列 `contextPercent`（`016_relay_handoff`），且 [`ledger.ts`](../../apps/steward/src/ledger.ts) **只在 `settled` 结算事件到达时才更新该字段**。
   - 当 Worker 正在执行长达十余分钟的复杂任务（`state = 'running'`）时，前端看到的 `contextPercent` 要么是 `null`（新会话首轮），要么冻结在上一轮结算时的旧值；同时缺少绝对窗口水位（`contextTokens / contextWindow`）、本会话已触发自动压缩次数（`compactionCount`）以及慢工具耗时感知，导致用户无法在上下文逼近 80%（[`handoff.ts`](../../apps/steward/src/handoff.ts) `HIGH_CONTEXT_USAGE` 阈值）或 90% 前主动介入保存断点或切换新会话。

## 2. 现状盘点（复用既有底座与补齐缺口）

| 模块 / 资产 | 代码位置 | 当前真实能力与局限 | 本方案处理策略 |
| --- | --- | --- | --- |
| Steward 每日预算游标 | [`apps/steward/src/budget.ts`](../../apps/steward/src/budget.ts) | `sh_usage_cursor` + `sh_usage_day` 事务化折算 `pi.usage` 增量，维护 `DAILY_BUDGET_USD` 软上限与 `skippedWakes` | **保持原熔断逻辑零改动**；新增细粒度 `sh_usage_event` 明细表并与 `sh_usage_day` 差额兜底对账 |
| 旁路模型调用入口 | [`apps/steward/src/steward.ts`](../../apps/steward/src/steward.ts) `completeBackgroundText` | 统一收口了 PR CI 诊断、PR 评审提炼、断点蒸馏、技能候选分诊 4 类无工具调用，已计算单次 `costUsd` 与 `tokens` | 为 `completeBackgroundText` 增加结构化归因标签（`category`, `threadId`, `repoId`, `workerId`, `watchId`）落盘 `sh_usage_event` |
| Worker 接力阈值规则 | [`apps/steward/src/handoff.ts`](../../apps/steward/src/handoff.ts) | 定义 `HIGH_CONTEXT_USAGE = 0.8`（`contextPercent >= 80` 自动切新会话交接而非 `resume`） | 前端黄灯预警阈值严格对齐 `80%`，红灯高危阈值设为 `90%`，前后端语义一致 |
| Connector 进度节流器 | [`apps/connector/src/progress.ts`](../../apps/connector/src/progress.ts) | `ProgressThrottle` 强制保证同工具 ≥15s、任意事件 ≥5s 最小间隔，且 [`packages/protocol/src/events.ts`](../../packages/protocol/src/events.ts) `WorkerEventSchema` 支持扩展字段透传 | 遥测字段直接捎带在既有节流后的 `progress` 与 `settled` 事件上，**不新增高频独立心跳帧** |
| 编码 Agent 适配器 | [`pi-adapter.ts`](../../apps/connector/src/pi-adapter.ts) / [`claude-adapter.ts`](../../apps/connector/src/claude-adapter.ts) / [`codex-adapter.ts`](../../apps/connector/src/codex-adapter.ts) / [`acp-adapter.ts`](../../apps/connector/src/acp-adapter.ts) | ACP v1 已有实时 `usage_update`；`pi` 在 `settle` 调 `get_session_stats`；`claude` / `codex` 在结算汇总 `usage` | 按后端真实能力分级采集实时 `contextUsage`、`compactionCount` 与 `lastToolMs`，未知窗口上限时诚实留空百分比 |
| Web 控制面与 DOM 构建器 | [`apps/steward/ui/dom.js`](../../apps/steward/ui/dom.js) / [`control-plane.js`](../../apps/steward/ui/control-plane.js) | 全量基于 `createElement` / `createElementNS` 构建节点，[`ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts) 严禁 `innerHTML` 与内联 `style=` | 在 `dom.js` 导出命名空间安全的 `svg()` 辅助器，用纯声明式 SVG 绘制堆叠柱状图与水位条，零第三方图表库、零内联样式 |

## 3. 核心设计不变量与安全边界

1. **零额外模型调用、零后台唤醒开销**：所有预算趋势、事项排行与上下文遥测 100% 来自本地 SQLite 账本与已有事件流捎带字段，打开面板或轮询刷新绝不触发任何 LLM 调用或向离线机器扇出请求。
2. **总管预算与机器侧 Worker 账本物理双轨隔离**：
   - **Steward 编排账本（`sh_usage_day` + `sh_usage_event`）**：计入 `DAILY_BUDGET_USD` 软熔断水位，反映总管自身模型 API 花费。
   - **Worker 执行账本（`sh_worker_usage`）**：独立统计各事项/仓库下编码 Agent 消耗的 `inputTokens`、`outputTokens`、`totalTokens` 与可选 `costUsd`，仅供遥测透视与效率评估，**绝不计入 `DAILY_BUDGET_USD` 熔断判定**。
3. **新老账本对账守恒（Reconciliation Invariant）**：对于任一 UTC 日期 `d`，`sh_usage_day.costUsd` 始终为权威总额；若升级前历史日期或极端并发下存在未归入具体 `sh_usage_event` 的差额，聚合层自动计算 `unattributed = MAX(0, day.costUsd - SUM(events.costUsd))`，确保堆叠柱状图各分项之和与当日总账严格相等，绝不出现负数或总额跳变。
4. **诚实异构降级（No Fabricated Context Window）**：当某个编码 Agent 后端（如未暴露模型最大窗口的 `codex` CLI 或自定义代理模型）仅上报了 `contextTokens` 而无可靠 `contextWindow` 时，服务端保持 `contextWindow = null, contextPercent = null`，前端仅展示已用 Token 数与压缩次数，绝不硬编码猜测 `200k` 或 `128k` 误导用户。
5. **零代码/路径隐私泄露与零 HTML 注入**：遥测账本仅记录数值指标（美元、Token 数、百分比、毫秒耗时、枚举类别）与内部实体 ID（`threadId`、`repoId`、`workerId`）；前端图表与提示框全部经由 `dom.js` 文本节点与 `SVG_NS` 元素构建，严禁 `innerHTML`、外部字体/脚本及动态 `style` 属性注入。

### 明确不做（排除项）

- **不修改 `DAILY_BUDGET_USD` 熔断策略本身**：不引入按仓库硬配额拦截编码 Worker、不改变 00:00 UTC 重置语义与车主主动消息豁免规则。
- **不在高水位时自动强杀或静默中断运行中的 Worker**：`80%` / `90%` 水位仅在 UI 提供显式视觉预警与一键查看断点/新开交接会话的温和入口，是否打断仍由 Owner 决定（遵守人工确认边界）。
- **不引入 ECharts / Chart.js / D3 等重型前端依赖**：保持 `ui/` 零构建依赖与极速首屏加载。

## 4. 模块一：SQLite 双轨遥测账本与增量迁移（Stage 1）

### 4.1 数据库迁移 `047_telemetry_and_worker_context`（[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)）

1. **Steward 细粒度模型开销事件表 `sh_usage_event`**：
   ```sql
   CREATE TABLE IF NOT EXISTS sh_usage_event (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     day TEXT NOT NULL,
     at INTEGER NOT NULL,
     category TEXT NOT NULL,        -- 'chat' | 'wake' | 'schedule' | 'pr_triage' | 'memory_skill'
     kind TEXT NOT NULL,            -- 'user' | 'verify' | 'event' | 'routine' | 'followup' | 'pr_ci' | 'pr_review' | 'checkpoint_distill' | 'skill_triage'
     operationId TEXT,
     threadId TEXT,
     repoId TEXT,
     workerId TEXT,
     watchId TEXT,
     provider TEXT,
     modelId TEXT,
     costUsd REAL NOT NULL DEFAULT 0,
     tokens INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS idx_sh_usage_event_day ON sh_usage_event(day, category);
   CREATE INDEX IF NOT EXISTS idx_sh_usage_event_thread ON sh_usage_event(threadId, at DESC) WHERE threadId IS NOT NULL;
   ```
2. **机器侧编码 Worker 结算用量表 `sh_worker_usage`（按 `(workerId, seq)` 幂等去重）**：
   ```sql
   CREATE TABLE IF NOT EXISTS sh_worker_usage (
     workerId TEXT NOT NULL,
     seq INTEGER NOT NULL,
     day TEXT NOT NULL,
     at INTEGER NOT NULL,
     threadId TEXT NOT NULL,
     deviceId TEXT NOT NULL,
     repoId TEXT,
     agent TEXT NOT NULL,
     outcome TEXT NOT NULL,
     inputTokens INTEGER NOT NULL DEFAULT 0,
     outputTokens INTEGER NOT NULL DEFAULT 0,
     totalTokens INTEGER NOT NULL DEFAULT 0,
     costUsd REAL,                  -- NULL 表示后端未汇报美元成本（如订阅制 CLI）
     PRIMARY KEY (workerId, seq)
   );
   CREATE INDEX IF NOT EXISTS idx_sh_worker_usage_day ON sh_worker_usage(day);
   CREATE INDEX IF NOT EXISTS idx_sh_worker_usage_thread ON sh_worker_usage(threadId, at DESC);
   CREATE INDEX IF NOT EXISTS idx_sh_worker_usage_repo ON sh_worker_usage(repoId, day) WHERE repoId IS NOT NULL;
   ```
3. **`sh_worker` 运行期上下文遥测列扩展**（使用 `ignoringDuplicateColumn` 保证幂等）：
   - `contextTokens INTEGER`：最近一次观测到的当前会话上下文占用 Token 数；
   - `contextWindow INTEGER`：最近一次观测到的模型上下文窗口上限 Token 数；
   - `compactionCount INTEGER NOT NULL DEFAULT 0`：当前 Worker 会话累计触发的上下文自动压缩次数；
   - `lastToolDurationMs INTEGER`：最近一次已完成工具调用的执行耗时（毫秒）。

### 4.2 Steward 消费归因与对账规则（`apps/steward/src/telemetry.ts` & `budget.ts`）

1. **主会话 `pi.usage` 增量归因**：
   - 扩展 `budget.observe(total, at, attribution?)`：在同一 SQLite 事务内，计算 `costDelta` 与 `tokenDelta` 更新 `sh_usage_cursor` 与 `sh_usage_day` 的同时，若 `costDelta > 0 || tokenDelta > 0` 且传入了 `attribution`（在 [`steward.ts`](../../apps/steward/src/steward.ts) `pollRuns` 结算 `run` 时传入 `{ operationId: run.operationId, kind: run.kind, threadId: run.routedThreadId }`），同步插入一条 `sh_usage_event`：
     - `run.kind === 'user' || run.kind === 'verify'` → `category = 'chat'`；
     - `run.kind === 'event'` → `category = 'wake'`；
     - `run.kind === 'routine' || run.kind === 'followup'` → `category = 'schedule'`。
   - 若在 `drainWakes` 前置探针同步时捕获到跨轮残留增量（无明确单条 `run` 归属），若存在唯一活跃 `sh_run` 则归入该 `run`，否则不写伪造归因，交由查询时与 `sh_usage_day` 差额自动归入 `'unattributed'`。
2. **旁路 `completeBackgroundText` 精确归因**：
   - 为 `completeBackgroundText` 增加必填 `telemetry: { category: 'pr_triage' | 'memory_skill'; kind: 'pr_ci' | 'pr_review' | 'checkpoint_distill' | 'skill_triage'; threadId?: string | null; repoId?: string | null; workerId?: string | null; watchId?: string | null }` 参数：
     - `diagnosePrFailure` → `category: 'pr_triage', kind: 'pr_ci'`（关联 `watch.threadId` 与 `watch.repoId`）；
     - `diagnosePrFeedback` → `category: 'pr_triage', kind: 'pr_review'`（关联 `watch.threadId` 与 `watch.repoId`）；
     - `distillWorker` → `category: 'memory_skill', kind: 'checkpoint_distill'`（关联 `worker.threadId`、`worker.repoId`、`worker.workerId`）；
     - `runAmbientSkillTriage` → `category: 'memory_skill', kind: 'skill_triage'`（关联 `worker.threadId`、`worker.repoId`、`worker.workerId`）。
   - 调用 `budget.add(delta, now, attribution)` 在同一事务内写入 `sh_usage_day` 与 `sh_usage_event`。
3. **数据生命周期控制**：
   - `sh_usage_event` 与 `sh_worker_usage` 仅存储轻量数值行（单行约 120 字节）；在每日首次预算写入或定时巡检时顺带清理超过 `90` 天的明细行（`DELETE FROM sh_usage_event WHERE day < ?`），保持 Durable Object / 本地 SQLite 体积恒定可控。

## 5. 模块二：Connector 运行期遥测与 Steward 聚合 API（Stage 2）

### 5.1 Connector 轻量遥测捎带协议（`apps/connector/src/`）

复用既有 `events` 通道与 `ProgressThrottle`（同相 ≥15s、全局 ≥5s），在 `RawAdapterEvent` 的 `progress` 与 `settled` 上增加可选结构化遥测载荷：

```ts
export interface WorkerLiveTelemetry {
  contextTokens?: number | null;
  contextWindow?: number | null;
  contextPercent?: number | null;
  compactionCount?: number;
  lastToolMs?: number | null;
}
```

四个编码 Agent 后端的分级采集策略：

| Agent 后端 | 运行期 `contextTokens / contextWindow` 来源 | `compactionCount` 来源 | `lastToolMs` 来源 | 结算 `sh_worker_usage` 来源 |
| --- | --- | --- | --- | --- |
| **`pi`** | `turn_start`（距上次采样 ≥15s 时）及压缩完成后非阻塞调用 `rpc({ type: "get_session_stats" }, 1500)` 读取 `contextUsage` | 监听 `auto_compaction_start` / `auto_compaction_end`（或 `compaction` 记录）累加会话内计数 | 记录 `tool_execution_start` 时间戳，在 `tool_execution_end` 计算差值附带于下一帧 `progress` | `settle` 时 `get_session_stats` 返回的**会话累计值与上次结算游标做差**（防止 `resume` 续跑把前几轮累计 Token/花费重复计入 `sh_worker_usage`） |
| **`opencode` / `agentica`（ACP v1）** | 原生监听实时 `usage_update` 事件中的 `used` 与 `size` 实时计算百分比 | 监听会话压缩通知事件（未提供时保持 `0`） | 工具调用起止时间差 | `promptResult` / `latestUsage` 单轮差值落盘 |
| **`claude-code`** | 解析流式 `assistant` 事件中的 `message.usage`（`input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`）作为当前上下文估算；从已知模型目录或 `modelUsage` 读取窗口上限（未知则留空窗口） | 监听 `system` 事件 `subtype === "compact_boundary"` 递增计数 | 相邻 `tool_use` 至对应 `user`（`tool_result`）到达耗时 | `result` 信封中的单轮 `usage` 与 `total_cost_usd` |
| **`codex`** | 解析 `turn.completed` / `token_count` 事件中的当前上下文 Token；若 CLI 未汇报 `model_context_window` 则仅上报 `contextTokens`，`contextPercent` 置 `null` | 监听 rollout / compact 事件（若无则保持 `0`） | `item.started` 至 `item.completed`（`command_execution` / `mcp_tool_call`）时间差 | `turn.completed` / 结算汇总单轮 `input_tokens` + `output_tokens` |

> **关键防双计细节（`pi` / ACP v1 续跑差值）**：`pi` 的 `get_session_stats` 返回整个进程生命周期的**累积** `tokens` 与 `cost`。当同一 `workerId` 经 `send` 多轮续跑时，`PiAdapter` 必须在 `WorkerRuntime` 内存维护 `lastSettledTokens` / `lastSettledCost` 游标，使每次 `settled` 事件额外携带 `turnUsage`（本轮净增量）或净增 `usage`，保证 `sh_worker_usage` 按 `(workerId, seq)` 求和时精确等于真实总消耗，绝不因 5 次 `send` 续跑把首轮开销重复累加 5 次。

### 5.2 Steward 事件归约与实时投影（[`ledger.ts`](../../apps/steward/src/ledger.ts) & [`workspace.ts`](../../apps/steward/src/workspace.ts)）

1. **`case "progress"` 实时更新**：
   - 解析 `event.telemetry`（校验有限非负数值，百分比钳制在 `0..100`），实时 `COALESCE` 更新 `sh_worker` 的 `contextPercent`、`contextTokens`、`contextWindow`、`compactionCount = MAX(compactionCount, excluded)` 与 `lastToolDurationMs`。
   - 保留 `lastProgress` JSON 供当前步骤文本展示（如 `phase === "compacting"` 时展示「正在压缩上下文…」）。
2. **`case "settled"` 结算归档**：
   - 除了同步最终 `contextPercent` / `contextTokens` / `contextWindow` 外，不再把唯一账本寄托在易被覆盖的 `lastProgress` 上，而是以 `INSERT OR IGNORE INTO sh_worker_usage (...)` 幂等记录本轮 `inputTokens`、`outputTokens`、`totalTokens` 与 `costUsd`。
3. **Workspace 快照与 `thread_state` 帧透传**：
   - 扩展 [`workspace.ts`](../../apps/steward/src/workspace.ts) 的 `WorkspaceWorkerView`，输出：
     ```ts
     contextPercent: number | null;
     contextTokens: number | null;
     contextWindow: number | null;
     compactionCount: number;
     lastToolDurationMs: number | null;
     ```
   - 借助现有的 WebSocket `thread_state` / 快照刷新链路，活跃 Worker 的水位条无需前端额外轮询任何新接口即可平滑更新。

### 5.3 只读遥测聚合接口 `GET /app/api/telemetry`（[`workspace-api.ts`](../../apps/steward/src/workspace-api.ts)）

- **鉴权门禁**：位于 `/app/api/*` Owner 会话鉴权守卫之后，补充到 [`routes-audit.test.ts`](../../apps/steward/test/routes-audit.test.ts) 未登录拦截矩阵。
- **查询参数**：
  - `days`：可选正整数，允许枚举 `7 | 14 | 30`（默认 `7`，非法值返回 `400 invalid_days`）。
- **响应契约**：
  ```ts
  export type SpendCategory =
    | "chat"
    | "wake"
    | "schedule"
    | "pr_triage"
    | "memory_skill"
    | "unattributed";

  export interface TelemetryDayPoint {
    day: string; // YYYY-MM-DD (UTC)
    totalCostUsd: number;
    totalTokens: number;
    skippedWakes: number;
    overLimit: boolean;
    byCategory: Record<SpendCategory, { costUsd: number; tokens: number }>;
    worker: {
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      reportedCostUsd: number;
      settledRuns: number;
    };
  }

  export interface TelemetryThreadRankItem {
    threadId: string;
    title: string;
    archived: boolean;
    repos: string[];
    stewardCostUsd: number;
    stewardTokens: number;
    workerTokens: number;
    workerReportedCostUsd: number;
    lastActiveAt: number;
  }

  export interface TelemetryRepoRankItem {
    repoId: string;
    repoName: string;
    stewardCostUsd: number;
    stewardTokens: number;
    workerTokens: number;
    workerReportedCostUsd: number;
    workerRuns: number;
  }

  export interface WorkspaceTelemetryResponse {
    days: 7 | 14 | 30;
    generatedAt: number;
    budget: {
      day: string;
      costUsd: number;
      tokens: number;
      limitUsd: number;
      over: boolean;
      skippedWakes: number;
      resetsAt: number;
    };
    totals: {
      stewardCostUsd: number;
      stewardTokens: number;
      skippedWakes: number;
      byCategory: Record<SpendCategory, { costUsd: number; tokens: number }>;
      workerTokens: number;
      workerReportedCostUsd: number;
      workerRuns: number;
    };
    series: TelemetryDayPoint[];     // 严格按 UTC 日期升序排列的完整 N 天连续序列（空日补 0）
    topThreads: TelemetryThreadRankItem[]; // Top 10（按 stewardCostUsd DESC, workerTokens DESC, stewardTokens DESC 排序）
    topRepos: TelemetryRepoRankItem[];     // Top 10
  }
  ```

## 6. 模块三：Web 控制面 SVG 仪表盘与上下文水位预警（Stage 3）

### 6.1 命名空间安全的原生 SVG 构建器（[`apps/steward/ui/dom.js`](../../apps/steward/ui/dom.js)）

为遵守 CSP 与 `ui-modules.test.ts` 的「零 `innerHTML`、零内联 `style=`」硬约束：
- 在 `dom.js` 导出 `svg(tag, attrs, ...children)`（基于 `document.createElementNS(SVG_NS, tag)` 创建 `<svg>`、`<g>`、`<rect>`、`<line>`、`<text>`、`<title>`）。
- 所有柱体高度、坐标与宽度全部通过标准 SVG 几何属性（`viewBox="0 0 640 180"`、`x`、`y`、`width`、`height`、`rx`）与 CSS 类名（`.tm-bar-chat`、`.tm-bar-wake`、`.tm-bar-schedule`、`.tm-bar-pr`、`.tm-bar-memory`、`.tm-bar-unattributed`、`.tm-limit-line`）表达，**不使用任何 `style=` 属性**。

### 6.2 控制面「预算与遥测」视图与调度顶栏进度条（`ui/telemetry.js` & [`control-plane.js`](../../apps/steward/ui/control-plane.js)）

1. **「主动调度」标签页顶栏常态预算卡补齐**：
   - 在 `renderSchedulesTab` 顶部常态展示今日 Steward 预算进度条（`$0.18 / $1.00 · 42,100 tokens · 00:00 UTC 重置`），达到 `80%` 变琥珀色、达到 `100%` 显示熔断状态与已跳过自动唤醒次数，并附带「查看多日趋势 →」快捷按钮直跳 `telemetry` 标签页。
2. **控制面新增第 4 个一级标签页 `telemetry`（预算与遥测）**：
   - **顶部控制条**：`7 天 / 14 天 / 30 天` 时间窗胶囊切换，以及 `总管模型花费（USD）` 与 `编码 Worker 用量（Tokens）` 双视角切换（当用户使用 `$0` 免费/自建模型或订阅制编码 CLI 时，切换至 Token 视角依然能清晰观察负载波峰）。
   - **堆叠柱状趋势图（纯原生 SVG）**：
     - 横轴为连续 `N` 个 UTC 日期柱，按用途色彩堆叠，叠加 `DAILY_BUDGET_USD` 水平虚线阈值参考线（在 Steward USD 视角下且 `limitUsd > 0` 时展示）。
     - 支持点击或键盘方向键选中某一天，在图下信息条精确展示该日总花费、Token 数、跳过唤醒次数与 6 类分项明细（无障碍友好，无需依赖悬停浮窗定位样式）。
   - **双栏 Top 消耗榜单**：
     - **高消耗事项 Top 10**：展示事项标题（含已归档徽章）、关联仓库、Steward 花费 / Token 与 Worker Token 明细；点击任意事项直接关闭控制面并切换至该 Thread（自动处理已归档展开，复用全局跳转逻辑）。
     - **仓库开销汇总 Top 10**：按仓库汇总周期内 Steward 诊断/记忆开销与机器侧 Worker 运行轮次及总 Token 数。

### 6.3 活跃 Worker 上下文水位指示与分级温和预警（[`workspace.js`](../../apps/steward/ui/workspace.js) & [`workspace.css`](../../apps/steward/ui/workspace.css)）

1. **紧凑水位指示器**：
   - **事项头栏副标题区**：当当前选中事项存在活跃或最近运行过的关联 Worker 且具备上下文遥测时，展示紧凑胶囊徽章（例如 `上下文 68%` 或仅 Token 态 `上下文 84k tok`）。
   - **右侧详情栏 `.worker-card`**：
     - 将原有纯文本 `Context: 68%` 升级为带 `<progress class="worker-context-meter">` 的可视化水位行：展示百分比 + `136k / 200k tokens`（若有窗口信息）+ `已压缩 N 次`（当 `compactionCount > 0`）+ `最近工具 12.4s`（当 `lastToolDurationMs >= 2000` 时展示慢工具提示，避免毫秒级碎噪音）。
     - 当 `worker.progress?.phase === 'compacting'` 时，状态行动态提示「正在自动压缩上下文…」。
2. **三档水位视觉分级与温和引导（严格对齐 `HIGH_CONTEXT_USAGE = 0.8`）**：
   - **常态（`< 80%`）**：中性仪表蓝灰（`.level-normal`），无额外打扰。
   - **预警（`80% – 89%`，`.level-warn` 琥珀色）**：徽章与进度条变琥珀色，附简短提示「已达 80% 交接水位，后续续跑将自动开启新会话接力」。
   - **高危（`>= 90%`，`.level-high` 珊瑚红）**：在 `.worker-card` 内展示温和建议条「上下文接近上限（{percent}%），建议查看断点或新开交接会话」，附一键「查看断点」按钮（直调既有 `open-checkpoint` 弹窗）。

## 7. 分阶段实施路线与验证门禁（Stage 1 → Stage 3）

### Stage 1：双轨遥测账本迁移与归因记账底座
- **改动范围**：[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)（`047_telemetry_and_worker_context`）、[`apps/steward/src/budget.ts`](../../apps/steward/src/budget.ts)、新增 `apps/steward/src/telemetry.ts`、[`apps/steward/src/steward.ts`](../../apps/steward/src/steward.ts)、[`apps/steward/src/ledger.ts`](../../apps/steward/src/ledger.ts)。
- **验收门禁**：
  - 新增 `apps/steward/test/telemetry.test.ts`：
    1. 验证主会话 `user` / `verify` / `event` / `routine` / `followup` 与 4 类旁路 `completeBackgroundText` 调用准确归入各自 `category` 与 `threadId`；
    2. 验证升级前仅有 `sh_usage_day` 老数据的历史日期自动通过 `unattributed` 差额守恒对账，绝不出现负数或总额不一致；
    3. 验证同一 `(workerId, seq)` 的 `settled` 事件重放不会在 `sh_worker_usage` 重复累加 Token 或花费，且完全不影响 `DAILY_BUDGET_USD` 的 `over` 熔断判定；
    4. 验证 `$0` 定价模型与订阅制 Worker（`costUsd: null`）在纯 Token 模式下正常聚合排序。

### Stage 2：Connector 多后端运行期遥测扩展与 `GET /app/api/telemetry`
- **改动范围**：[`apps/connector/src/agent.ts`](../../apps/connector/src/agent.ts)、[`pi-adapter.ts`](../../apps/connector/src/pi-adapter.ts)、[`acp-adapter.ts`](../../apps/connector/src/acp-adapter.ts)、[`claude-adapter.ts`](../../apps/connector/src/claude-adapter.ts)、[`codex-adapter.ts`](../../apps/connector/src/codex-adapter.ts)、[`worker-manager.ts`](../../apps/connector/src/worker-manager.ts)、[`apps/steward/src/workspace.ts`](../../apps/steward/src/workspace.ts)、[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts)、[`apps/steward/src/web.ts`](../../apps/steward/src/web.ts)。
- **验收门禁**：
  - Connector 侧单测验证：`pi` 多轮 `send` 续跑时 `settled` 增量游标不重复累计历史轮次 Token；`progress` 携带 `telemetry` 受 `ProgressThrottle` 节流约束；`codex` 无窗口上限时诚实保持 `contextPercent: null`。
  - Steward 侧单测与 [`routes-audit.test.ts`](../../apps/steward/test/routes-audit.test.ts) 验证：`GET /app/api/telemetry?days=7|14|30` 未授权访问被会话门禁拦截，合法请求返回连续 UTC 日期序列、Top 事项与 Top 仓库列表。

### Stage 3：Web 控制面 SVG 趋势图、Worker 水位预警与双语门禁
- **改动范围**：[`apps/steward/ui/dom.js`](../../apps/steward/ui/dom.js)、新增 `apps/steward/ui/telemetry.js`、[`apps/steward/ui/control-plane.js`](../../apps/steward/ui/control-plane.js)、[`apps/steward/ui/workspace.js`](../../apps/steward/ui/workspace.js)、[`apps/steward/ui/workspace.css`](../../apps/steward/ui/workspace.css)、[`apps/steward/ui/i18n.js`](../../apps/steward/ui/i18n.js)、[`apps/steward/test/ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts)。
- **验收门禁**：
  - 将 `telemetry.js` 纳入 `ui-modules.test.ts` 的 `SCRIPTS` 安全扫描（零 `innerHTML`、零内联 `style=`、单行单引号相对导入）与 `STRINGS` 中英双语词条完整性及占位符对称校验。
  - 为纯函数（堆叠柱状图几何归一化计算、`$0` / 纯 Token 视图回退、上下文水位三档阈值分级 `normal / warn / high`）补充确定性单测。
  - 全仓通过 `tsc --noEmit`、`tsc -p tsconfig.node-host.json`、`node scripts/build-node.mjs` 以及 Steward 与 Connector 全套 Vitest 测试套件。
