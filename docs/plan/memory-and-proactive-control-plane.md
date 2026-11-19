# 个人记忆与主动调度、PR 盯盘透明控制面实施方案

状态：已落地（2026-11-19）。关联前序决策：[ADR-0004](../adr/0004-web-workspace.md)（Web Workspace）、[ADR-0016](../adr/0016-dark-instrument-panel-theme.md)（暗色仪表盘视觉体系）、[ADR-0019](../adr/0019-pr-watch-owner-confirmation.md)（PR 盯盘显式确认约束）。

实施顺序：**Stage 1（Steward 账本最小辅助方法 + `/app/api/memory` 与 `/app/api/schedules` 确定性路由 + 单测） → Stage 2（Web Workspace 控制面弹层、容量与调度徽章、双语文案与全仓门禁）**。

## 1. 背景与真实痛点

Otto 的长期记忆（[`notes.ts`](../../apps/steward/src/notes.ts)）、主动例行调度（[`routines.ts`](../../apps/steward/src/routines.ts)）与 PR 持续盯盘（[`pr-watch.ts`](../../apps/steward/src/pr-watch.ts)）已在 Steward Durable Object SQLite 中完备落地，但在日常高频作为 Personal Agent 使用时仍存在三处「黑盒」摩擦：

1. **长期记忆不可见、不可直改**：三层记忆（`resident` 2,400 字符上限、`project` 单仓 1,500 字符上限、`archive` 全文检索层）目前完全藏在后台。Owner 无法直观查看 Steward 记住了哪些偏好、哪些 `worker_reported` / `inferred` 环境结论已被标为过时（`StaleMark`），也无法不耗费对话轮次直接新增、置顶、确认、归档或删除记忆。
2. **主动调度与 PR 盯盘缺少全局总览**：定时 `routine`（`cron` / `once`）、挂起的 `followup` 以及轮询 GitHub 的 `pr_watch` 分散在各自的对话历史里，缺少统一面板查看下次触发时间、最近执行结果（例如 `skipped:超出每日预算`）以及 PR CI 检查进度。
3. **异常与超预算状态下缺少零模型确定性开关**：当触发每日预算上限（`DAILY_BUDGET_USD`）或上游模型服务故障时，依赖自然语言让 Steward 调工具取消任务会受阻；Owner 需要直接读写 SQLite 与调度器的确定性 Web 控制开关。

## 2. 现状盘点（零表迁移复用既有底座）

截至 `042_worktree_lifecycle` 迁移，所有底层表结构（`sh_note`、`sh_note_fts`、`sh_note_log`、`sh_note_pressure`、`sh_routine`、`sh_followup`、`sh_pr_watch`、`sh_pr_watch_notice`）均已就绪，**本方案无需新增数据库迁移**。

| 模块 | 已有能力 | 现有缺口 | 代码位置 |
| --- | --- | --- | --- |
| 三层记忆账本 | 已实现 `list`、`search`（FTS5 + CJK/短词 LIKE 回退）、`propose`、`commit`、`confirm`、`pin`、`remove`、容量预算校验、防投毒约束与读时 `StaleMark` 计算 | ① 缺少只读容量统计与 `sh_note_pressure` 查询辅助；② `ownerArchive`（`demote`）强依赖 `suggest_demote` 日志 ID 且仅限 `resident` 层；③ UI 直接写入若复用默认 `log()` 会将 `reportedAt` 留空，导致下一次聊天回复重复播报 `（记账：…）` | [`apps/steward/src/notes.ts`](../../apps/steward/src/notes.ts) |
| 例行任务与跟进 | `RoutineService` 已实现 `pause(routineId, paused)` 与 `cancel(scheduleId)`（同时支持 `r_*` 与 `f_*`），并同步维护 Agents SDK 定时器与 `sh_timeline` | 未向 Web Workspace 暴露列表与操作 API；`RoutineRow` 未拼装 SDK 调度器中的实时下次触发时间 `nextRunAt` | [`apps/steward/src/routines.ts`](../../apps/steward/src/routines.ts)、[`apps/steward/src/steward.ts`](../../apps/steward/src/steward.ts) |
| PR 盯盘服务 | `PrWatchService` 已提供 `list()`（活跃优先，上限 100 条）与原子 `cancel(id)`（递增 `generation` 丢弃在途轮询并清理未投递通知） | 仅暴露给编程侧 Bearer API `/api/pr-watches`，浏览器会话侧 `/app/api/*` 尚无列表与一键取消接口 | [`apps/steward/src/pr-watch.ts`](../../apps/steward/src/pr-watch.ts) |
| Web Workspace | 已有会话鉴权、同源 + CSRF 校验、`sh_web_request` 请求幂等缓存及宽屏 `#dialog` 容器（`.diff-dialog`） | 缺少控制面聚合计数、记忆检视/编辑器与主动任务管理视图 | [`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts)、[`apps/steward/ui/workspace.js`](../../apps/steward/ui/workspace.js) |

## 3. 核心设计不变量与排除范围

### 3.1 核心不变量
1. **零模型依赖、零额度消耗（Deterministic & Budget-Exempt）**：控制面所有查询与变更请求均由 Steward 直接读写 SQLite 与本地调度器完成，绝不触发 LLM 推理或派发 Worker；即便处于 `overBudget`（超出每日预算）或尚未配置/连通模型，Owner 仍可 100% 正常检视记忆、暂停例行任务、取消跟进与停止 PR 盯盘。
2. **严格遵守记忆防投毒边界（Anti-Poisoning）**：
   - `source === "connector"`（来自仓库 `CLAUDE.md` / `AGENTS.md` 等外部文件）严禁提升至全局 `resident` 层。
   - 低信任来源（`worker_reported`、`inferred`）未获确认前严禁进入 `resident`；Owner 在 UI 点击「提升至全局常驻」时，若尚未确认须先（或原子联动）完成 `confirm`，并以 `sameClaimText` 继承原 `text`、关联 `sourceRef: "web:promote:<noteId>"` 通过 `commit(..., { supersedes: [noteId] })` 写入。
3. **审计完备且零聊天回声污染（Audit Without Stale Reply Echo）**：
   - 模型在后台静默写记忆时，`sh_note_log.reportedAt` 为 `null`，由下一轮聊天回复附带 `（记账：…）` 告知用户；而 Owner 本人在 Web UI 主动点击的新增、置顶、确认、归档、删除操作，必须同时写入完整的 `sh_note_log` 审计记录并将 `reportedAt` 置为当前时间戳（对齐既有 `ownerArchive` 设计），避免数小时后的无关对话突然冒出滞后的记账回声。
4. **严格遵守 [ADR-0019](../adr/0019-pr-watch-owner-confirmation.md) 边界**：会话鉴权 + 同源 `Origin` + `x-csrf-token` 保护下的 Web 控制面取消按钮属于 Owner 本人的显式确定性指令（非模型工具推测），可直接调用 `prWatches.cancel(id)`。
5. **零 HTML 注入与双语词条门禁**：前端严格通过 [`dom.js`](../../apps/steward/ui/dom.js) 的 `h()` 纯文本节点渲染，零 `innerHTML`、零内联 `style=`，且所有新增文案在中英文词表（`STRINGS.en` / `STRINGS.zh`）保持 100% 键对称。

### 3.2 明确不做（排除项）
- **不在本轮构建可视化 Cron 表达式拼装器或通用定时任务创建表单**：自然语言创建例行任务与对话内卡片审批（`RoutineOffer`）体验已经成熟，控制面聚焦「全局透明可见 + 启停/取消确定性兜底」，避免将简洁工作台膨胀成传统后台管理系统。
- **不在本轮引入向量数据库或跨实例记忆同步**：完全复用 SQLite `sh_note` + `sh_note_fts` 三层架构。
- **不在 Web UI 提供任意篡改已有记忆正文的原位覆盖**：修改记忆遵循账本不可变溯源规范（新建 `user_said` 并 `supersedes: [oldNoteId]`，或先删除再新建），保留清晰的 `supersededBy` 演化链。

## 4. 模块一：三层记忆透明检视与确定性管理（Memory Control Plane）

### 4.1 账本层最小扩展（[`apps/steward/src/notes.ts`](../../apps/steward/src/notes.ts)）
在不改动任何 SQLite 表结构的前提下，为 `Notes` 服务补齐以下最小能力：
1. **可选 `reported` 审计参数**：为 `commit`、`confirm`、`pin`、`remove` 增加可选参数 `opts?: { reported?: boolean }`（默认 `false` 保持模型工具侧行为完全不变；Web UI 侧传入 `{ reported: true }`，写入 `sh_note_log` 时直接填充 `reportedAt = now()`）。
2. **通用归档方法 `archiveByOwner(noteId: string)`**：允许将任意 `status === "active"` 且处于 `resident` 或 `project` 层的非置顶（`!pinned`）条目迁入 `layer = "archive"`（保持 `status = "active"` 以便继续被 `search_notes` FTS 命中；置顶条目返回 `{ ok: false, reason: "pinned" }` 提示先取消置顶），并写入 `log("demoted", note, "owner_ui", { reported: true })`。
3. **只读容量与积压快照 `usage()`**：
   - 返回 `resident: { usedChars, capChars: 2400, activeCount, pinnedCount }`；
   - 返回按仓库聚合的 `projects: Array<{ scopeRepoId, usedChars, capChars: 1500, activeCount, pinnedCount }>`；
   - 返回 `unconfirmedCount`（活跃的 `worker_reported` / `inferred` 未确认条目数）及未结算的 `pressure: NotePressureRow[]`（来自 `sh_note_pressure`）。
4. **Web 写入容量预检（避免误写 `sh_note_pressure`）**：
   - 现有 `commit()` 在 `user_said` 超出层容量且未传 `evicts` 时，会向 `sh_note_pressure` 插入一行挂起记录等下轮对话追问。
   - Web 控制面新增或提升记忆时，若未显式传入 `evicts`，先通过无副作用的容量预算检查（注意避开 `propose()` 在完全重复文本上的 `bumpUse` 副作用，或抽出纯读预算计算函数）：若容量充足直接 `commit(..., { reported: true })`；若超出上限且存在可腾挪的非置顶候选，**不写 `sh_note_pressure`**，直接向前端返回 `409 capacity_exceeded` 与 `needsEviction` 候选列表及缺口字符数 `overBy`，由 Owner 在当前弹窗内勾选需归档腾位的旧条目后携带 `evicts: string[]` 一次性原子提交。

### 4.2 记忆 API 契约（[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts)）
所有新路由均位于 `/app/api/*` 会话门禁之后（未登录一律 `401`），写请求强制 `requireOrigin = true`（同源 `Origin` + `x-csrf-token` + `application/json`）并接入 `sh_web_request` 幂等重放缓存：

- **`GET /app/api/memory?layer=all|resident|project|archive&repoId=<optional>&q=<optional>`**：
  - 当 `q` 非空时调用 `ledger.notes.search(q, { layers, repoIds })`（单次上限 20 条）；当 `q` 为空时调用 `ledger.notes.list({ layer, scopeRepoId })`（`archive` 无搜索词时按更新时间倒序截取最近 50 条，避免大表全量序列化）。
  - 响应体包含 `notes`（带读时计算的 `stale?: StaleMark`）、`usage`（`resident` 与各 `project` 容量占用、`unconfirmedCount`、`pressure` 挂起项）以及已知仓库目录映射 `repos: Array<{ id, label }>` 供前端展示可读项目名。
- **`POST /app/api/memory`**（请求体含幂等键 `id: string` 与 `action` 判别联合）：
  - `action: "create"`：`{ id, action: "create", layer: "resident" | "project", scopeRepoId?: string, kind: NoteKind, text: string, pinned?: boolean, supersedes?: string[], evicts?: string[] }` —— 固定以 `source: "user_said"`、`confirmed: true`、`sourceRef: "web:owner"` 写入；超容量未传足够 `evicts` 时返回 `409 { error: "capacity_exceeded", overBy, needsEviction }`。
  - `action: "pin"`：`{ id, action: "pin", noteId: string, pinned: boolean }`。
  - `action: "confirm"`：`{ id, action: "confirm", noteId: string }` —— 确认低信任条目（`evidence: "web:owner_confirm"`）。
  - `action: "promote"`：`{ id, action: "promote", noteId: string, evicts?: string[] }` —— 拦截 `source === "connector"`（`400 connector_cannot_promote`）；若原条目尚未 `confirmed` 先原子执行确认，再以 `layer: "resident"`、`source: "user_said"`、`sourceRef: "web:promote:<noteId>"`、`supersedes: [noteId]` 提交。
  - `action: "archive"`：`{ id, action: "archive", noteId: string }` —— 调用 `archiveByOwner(noteId)` 降级至 `archive` 层；若已置顶返回 `409 note_pinned`。
  - `action: "remove"`：`{ id, action: "remove", noteId: string }` —— 调用 `remove(noteId, "owner_ui", { reported: true })`。
  - `action: "dismiss_pressure"`：`{ id, action: "dismiss_pressure", pressureId: number }` —— 将挂起的 `sh_note_pressure` 置为已结算（丢弃待挤入草稿或由前端一键转为带 `evicts` 的 `create`）。

## 5. 模块二：主动调度与 PR 盯盘控制中心（Schedules & PR Watches）

### 5.1 快照聚合与实时 `nextRunAt` 对齐（[`apps/steward/src/workspace.ts`](../../apps/steward/src/workspace.ts)）
1. **首屏轻量计数摘要**：在现有 `GET /app/api/workspace` 返回的快照中新增只读字段 `controlPlaneSummary`（零额外前端启动请求）：
   `{ residentUsedChars, residentCapChars: 2400, unconfirmedNotes, pressureCount, activeRoutines, pausedRoutines, openFollowups, activePrWatches }`。
2. **例行任务下次触发时间对齐**：Steward 内部通过 Agents SDK `this.listSchedules()` 获取当前内存中已注册定时器的 `{ id, time }`（Unix 秒），按 `routine.scheduleId` 关联映射为毫秒时间戳 `nextRunAt: number | null`，使前端能精确展示下一次触发倒计时，并直观识别「状态为 `active` 但 SDK 定时器缺失」的异常项。
3. **关联上下文可跳转**：每条 `Routine`、`Followup`、`PrWatch` 若绑定了 `threadId`，响应中附带对应会话标题 `threadTitle?: string`，支持在控制面一键跳回原 Thread 查看上下文。

### 5.2 调度与盯盘 API 契约（[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts)）
- **`GET /app/api/schedules`**：
  - `routines`：返回全部 `active` / `paused` 例行任务及最近 20 条已结束（`done` / `cancelled`）记录，含 `nextRunAt`、`lastRunAt`、`lastResult`（含 `skipped:超出每日预算...` 原文提示）、`kind`、`scheduleKind`、`cron` / `onceAt`、`repoId`、`threadId`。
  - `followups`：返回全部 `open` 待触发跟进（按 `dueAt` 升序）及最近 20 条 `fired` / `cancelled` 记录。
  - `prWatches`：调用 `prWatches.list()` 返回活跃优先的 PR 盯盘列表（含 `url`、`status`、`head`、`observedState`、`checks` / `failed` / `pending`、`evidenceMode`、`nextCheckAt`、`expiresAt`、`lastError`）。
  - `budget`：附带当日额度快照 `{ spentUsd, dailyBudgetUsd, overBudget }`，当 `overBudget === true` 时在面板顶部提示定时任务自动跳过原因，同时强调手动暂停/取消不受影响。
- **`POST /app/api/schedules`**（强制 `requireOrigin = true` + CSRF + `sh_web_request` 幂等键 `id`）：
  - `action: "pause_routine"`：`{ id, action: "pause_routine", routineId: string, paused: boolean }` → 调用 `routineService.pause(routineId, paused)`。
  - `action: "cancel_routine"`：`{ id, action: "cancel_routine", routineId: string }` → 校验 `r_` 前缀后调用 `routineService.cancel(routineId)`。
  - `action: "cancel_followup"`：`{ id, action: "cancel_followup", followupId: string }` → 校验 `f_` 前缀后调用 `routineService.cancel(followupId)`。
  - `action: "cancel_pr_watch"`：`{ id, action: "cancel_pr_watch", watchId: string }` → 调用 `prWatches.cancel(watchId)`（原子更新状态、递增 `generation` 并清空未发通知）。

## 6. 模块三：Web Workspace 交互设计（保持三栏克制，按需展开）

遵循 [ADR-0016](../adr/0016-dark-instrument-panel-theme.md) 暗色仪表盘美学，不挤占日常对话与代码审阅的三栏主视野，采用「侧边/顶栏轻量状态入口 + 宽屏双标签模态框」结构：

1. **轻量入口与态势徽章（[`apps/steward/ui/workspace.js`](../../apps/steward/ui/workspace.js) & [`apps/steward/ui/workspace.html`](../../apps/steward/ui/workspace.html)）**：
   - 在左侧导航底部工具区或右侧 Context 概览区提供紧凑入口按钮：「记忆与自动任务（Memory & Automations）」，实时读取 `controlPlaneSummary` 渲染活跃自动任务数（`activeRoutines + openFollowups + activePrWatches`）及待关注角标（`unconfirmedNotes + pressureCount > 0`）。
2. **双标签控制面弹窗（复用 `#dialog` 宽屏样式）**：
   - **Tab 1 — 记忆账本（Memory）**：
     - 顶部展示 `resident`（`used / 2,400` 字符）与当前选中项目 `project`（`used / 1,500` 字符）的容量计量条，以及搜索框（防抖触发 `?q=` 全文检索）与层级筛选器（`全部 / 全局常驻 / 项目专属 / 归档库`）。
     - 若存在 `sh_note_pressure` 挂起项，在列表顶部展示高亮待决横幅，支持勾选淘汰旧条目后一键落库或忽略。
     - 每张记忆卡片清晰标注：`kind`（偏好/约定/环境/事实）、`source` 信任徽章（`用户直述` / `仓库配置` / `Worker 上报` / `模型推断`）、`confirmed` 状态、`pinned` 图钉、`useCount` 命中次数，以及橙色 `StaleMark` 过时提示（例如「后续同机任务已成功，此环境故障记录可能已过时」）。
     - 行内确定性操作按钮：新增记忆表单、置顶/取消置顶、确认（针对未确认低信任条目）、提升至全局常驻（自动屏蔽 `connector` 来源）、归档至 `archive`、删除；当新增或提升触发 `409 capacity_exceeded` 时，原位展开可腾挪候选勾选列表完成原子替换。
   - **Tab 2 — 主动调度与 PR 盯盘（Automations）**：
     - 分三组紧凑列表呈现 **例行任务（Routines）**、**待跟进提醒（Follow-ups）** 与 **PR 盯盘（PR Watches）**，默认聚焦活跃/暂停项，支持折叠展开最近已结束历史。
     - 例行任务展示周期规则（`cron` / `onceAt`）、下次触发时间 `nextRunAt`、最近结果 `lastResult`（醒目高亮预算跳过或失败信息），提供「暂停 / 恢复」与「取消」按钮。
     - 待跟进提醒展示到期时间 `dueAt`、原因与关联会话跳转链接，提供「取消」按钮。
     - PR 盯盘展示 PR 链接、当前 `head` 短哈希、CI 聚合状态（`checks` / `failed` / `pending` 及 `evidenceMode`）、下次轮询时间 `nextCheckAt` 与过期时间 `expiresAt`、最近错误 `lastError`，提供「停止盯盘」按钮。

## 7. 分阶段实施路线与验证门禁

1. **Stage 1（Steward 账本扩展 + 控制面 API + 路由/账本单测）**：
   - 在 [`notes.ts`](../../apps/steward/src/notes.ts) 补齐可选 `{ reported?: boolean }`、`archiveByOwner`、只读 `usage()`、容量无副作用预检与 `dismissPressure`；
   - 在 [`workspace.ts`](../../apps/steward/src/workspace.ts) 与 [`workspace-api.ts`](../../apps/steward/src/workspace-api.ts) 落地 `controlPlaneSummary`、`GET/POST /app/api/memory` 与 `GET/POST /app/api/schedules`（拼装 `listSchedules()` 的 `nextRunAt`）；
   - 新增/扩展 `notes.test.ts`、`workspace-control-plane.test.ts` 并通过 [`routes-audit.test.ts`](../../apps/steward/test/routes-audit.test.ts)（验证未登录 `401`、跨站无 CSRF `403`、幂等重放、`connector` 禁升 `resident`、超预算下仍可暂停/取消、UI 写入不产生滞后聊天记账回声）。
2. **Stage 2（Web Workspace UI + 双语文案 + 全仓构建门禁）**：
   - 抽离干净的前端模块（如 `apps/steward/ui/control-plane.js`）接入 [`workspace.js`](../../apps/steward/ui/workspace.js) 与 [`workspace.css`](../../apps/steward/ui/workspace.css)，补齐 [`strings.js`](../../apps/steward/ui/strings.js) 中英词条；
   - 跑通 [`ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts)（零 HTML sink、零内联样式、EN/ZH 词条 100% 对称）、全仓 `tsc --noEmit`、全量 Vitest 测试套件及 `apps/steward` 静态资源同步构建校验。
