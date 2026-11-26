# 三态显式停止与就地中断闭环设计方案（Three-Way Stop & Inline Interrupt）

状态：已落地（Stage 1–2 全部完成，2026-11-20）
前置依赖：[ADR-0011（机械式 Worker 控制）](../adr/0011-mechanical-worker-controls.md)、[ADR-0017（Turn 串行且可取消）](../adr/0017-turns-are-serial-and-cancellable.md)、[Direction 2A 控制面](./memory-and-proactive-control-plane.md)、[Worktree Diff 与归档自动回收](./worktree-diff-and-archive-cleanup.md)
参考来源：[`docs/research/personal-agent-2026.md`](../research/personal-agent-2026.md) §5.2 *The three-way stop, because "stop" is not one thing*

## 1. 背景与真实痛点

在「云端总管（Steward）+ 本地多机执行器（Connector Workers）+ 跨会话定时意图（Follow-ups / PR Watches / Routines）」的三层架构里，用户脑海中的「停一下」其实对应着**三种完全不同生命周期与副作用的执行对象**。对照现有代码库，当前「停止」链路存在 4 处明显断层：

1. **对话流「停止」语义含混，易误以为停掉了后台编码任务**：
   - 依据 [ADR-0017](../adr/0017-turns-are-serial-and-cancellable.md) 决策 4，对话流底部的「停止」按钮（`POST /app/api/turn/stop`）仅中止 Durable Object 内正在生成或排队的 Steward 回复（`sh_run`），**绝不触碰已经派发出去的本地 Worker**。
   - 但当前按钮文案仅写着笼统的 `停止`（`Stop`）；当总管刚派完活还在总结、同时本地 Worker 已经跑起来时，用户点完 `停止` 往往要看事后 Toast 才意识到后台 Agent 仍在继续改代码。
2. **中断本地 Worker 路径过深，离线或启动前状态甚至无处可点**：
   - 目前 Web 工作台唯一能中断 Worker 的按钮藏在 `Agent 过程` 全量会话流底部（[`apps/steward/ui/session.js`](../../apps/steward/ui/session.js)），且依赖先建立 `history_req` WebSocket 订阅（[`apps/steward/src/history-subscriptions.ts`](../../apps/steward/src/history-subscriptions.ts) 第 380 行要求先 `subscribe` 才放行 `worker_cmd`）。
   - 这导致两个高频死角：① 右侧事项详情栏明明把「归档」按钮置灰并提示 `请先等待或停止正在运行的 Agent 再归档`，下方的 Worker 卡片与事项头部却**没有任何就地「中断」按钮**；② 当目标机器离线、或 Worker 处于 `starting` / `queued` 尚未落盘本地会话（`sessionId === null`）时，会话流视图进不去，用户无法在页面上直接撤回或叫停它。
3. **`interruptWorker` 缺少「未出站命令直接撤回」与「终态防穿透」裁决**：
   - 当前 [`Dispatcher.interruptWorker`](../../apps/steward/src/dispatch.ts)（第 466 行）仅拦截了 `broken` 状态：
     - 若 Worker 处于 `starting` 且其 `start_worker`（或续跑 `send`）命令仍停留在 DO `outbox` 的 `queued` 状态（例如机器离线待投递），盲目追加一条 `interrupt` 命令不仅无法让事项立刻释放回 `idle`，等机器重连后还会先执行 `start_worker` 拉起新 Worktree 和进程、紧接着再执行 `interrupt` 秒杀它；
     - 若 Worker 已经进入 `idle`（刚跑完汇报），重复点击中断仍会向 `outbox` 塞入一条无效 `interrupt` 并在时间线记下误导性的「中断指令（停止运行）」。
4. **事项绑定的挂起计划（跟进提醒 / PR 盯盘 / 绑定例行）在事项内隐形，归档后仍会诈尸唤醒**：
   - 当前 [`WorkspaceThread`](../../apps/steward/src/workspace.ts) 快照不包含该事项名下的待触发 `sh_followup`（`status = 'open'`）、活跃 `sh_pr_watch`（`status = 'active'`）或绑定了 `threadId` 的 `sh_routine`。用户在事项详情里完全看不出「今晚 20:00 还有一条自动回看在倒计时」，必须切去全局「记忆与调度」弹窗大海捞针。
   - 同时，[`archiveThread`](../../apps/steward/src/steward.ts) 归档事项时未自动收口该事项残留的 `open` 跟进提醒与待决跨机探针提案，导致已归档结案的事项到点后仍会触发 SDK 定时器唤醒总管模型。

## 2. 现状盘点（零新增 SQLite 表迁移、零新增连接器协议帧）

本方案所需底层原语在现有代码库中已全部具备，**不需要新增任何 SQLite 表迁移，也不需要修改 Connector 通信协议**：

- **第 1 态（停总管回复 Turn）**：已有 `POST /app/api/turn/stop` 与 [`Steward.stopTurn`](../../apps/steward/src/steward.ts)，支持 `sh_web_request` 幂等重放并将 `sh_run` 置为 `cancelled`。
- **第 2 态（撤回未出站命令 / 中断运行中 Worker）**：
  - 未出站撤回原语已存在：[`cancelQueuedCommand`](../../apps/steward/src/steward.ts)（原子将 `outbox` 中 `state = 'queued'` 的命令置为 `expired`）、[`ledger.workers.settleWithdrawnStart`](../../apps/steward/src/ledger.ts)（将未启动的 `starting` Worker 静默收口为 `idle / cancelled`）与 [`ledger.workers.markResumeCancelled`](../../apps/steward/src/ledger.ts)（将未送达的续跑回退为 `idle` 且保留原会话）。
  - 运行中中断原语已存在：Connector [`WorkerManager.interruptWorker`](../../apps/connector/src/worker-manager.ts) 已跨 `pi`、`claude-code`、`codex` 统一实现 `interrupt` 命令（清空待发队列 `clear_queue` ➔ 中止当前运行 ➔ 发出 `settled: aborted` 事件）。
- **第 3 态（收口事项级未来计划）**：
  - [`Steward.cancelSchedule`](../../apps/steward/src/steward.ts) 与 `pauseRoutine` 已封装 SDK Schedule 销毁与 `sh_followup` / `sh_routine` 状态翻转；
  - [`PrWatches.cancel`](../../apps/steward/src/pr-watch.ts) 已支持原子取消活跃盯盘并清空未投递通知（`sh_pr_watch_notice`）；
  - [`ledger.proposals.decide`](../../apps/steward/src/ledger.ts) 已支持关闭 `pending_owner` 跨机只读探针确认。

## 3. 核心设计不变量与三态边界矩阵

### 3.1 核心安全与交互不变量

1. **三态严格正交，严禁静默跨层连坐（Zero Silent Cascade）**：
   - **停回复（Turn）** 只停 Steward 当前/排队的模型回合，绝不中断本地 Worker，绝不取消任何定时计划；
   - **停执行（Worker）** 只撤回或中断指定的本地 Worker（或用户显式点击「停止全部运行中 Agent」时的同事项活跃 Worker），**绝不静默取消跟进提醒、PR 盯盘或例行任务，也绝不清理或丢弃 Worktree 里的本地代码修改**；
   - **停计划（Plans）** 只取消/暂停用户显式指定的未来触发器（或归档结案时残留的一次性跟进/盯盘），绝不触碰运行中的进程。
2. **纯确定性机械控制（0 LLM Token、超额与离线 100% 可用）**：
   - 所有停止、撤回、取消跟进与暂停例行操作均直走确定性账本与 `outbox`，不唤醒 Steward 模型，在每日模型额度耗尽（`over_budget`）或机器离线时照常生效。
3. **一次性意图与周期例行严格区分处置**：
   - `sh_followup`（单次回看）、`sh_pr_watch`（单 PR 盯盘）与 `pending_owner` 探针提案属于**一次性事项附属意图**，支持「一键取消挂起跟进与盯盘」，并在事项归档（`archiveThread`）时自动收口；
   - `sh_routine`（周期例行任务，即使绑定了 `threadId`）属于**长期规则**，事项面板仅提供显式「暂停」快捷按钮，一键收口与事项归档**默认绝不自动删除或取消用户的周期例行任务**。
4. **全路由 CSRF、Origin 与 `sh_web_request` 幂等保护**：
   - 新增的 Web 停止接口全部纳入 `POST` + Session + `Origin` + `X-CSRF-Token` 校验，并以客户端请求 `id` 写入 `sh_web_request` 保证网络抖动重试绝对幂等（不会因重放误杀后续新启动的命令）。

### 3.2 三态语义对照表

| 维度 | 态 1：停止总管回复（Stop Turn） | 态 2：停止本地执行（Stop Worker） | 态 3：收口未来计划（Cancel / Pause Plans） |
| :--- | :--- | :--- | :--- |
| **作用对象** | DO 根会话 `sh_run`（`open` 运行中或排队中回合） | 指定 `sh_worker`（主链 `relay` 或只读探针 `sibling`） | 绑定在该 `threadId` 上的 `open` 跟进、`active` PR 盯盘、`active` 例行任务 |
| **底层动作** | `piHarness.session().abort()` + `sh_run.status = 'cancelled'` | 未出站命令走 `cancelQueuedCommand` 直接撤回；已出站活跃进程入队 `interrupt` 命令 | `cancelSchedule(followupId)`、`prWatches.cancel(watchId)`、可选 `pauseRoutine(routineId, true)` |
| **本地代码与分支** | 无影响 | 完整保留当前 Worktree、已提交 Commit 与未提交修改 | 无影响 |
| **机器离线时表现** | 立即完成（纯云端 DO 操作） | 未出站命令**立即撤回并释放事项**；已出站进程将 `interrupt` 持久入队（重连即达）并如实提示 | 立即完成（纯云端 DO / SDK 调度器操作） |
| **界面文案区分** | `停止本轮回复`（`Stop reply`） | 单卡 `中断`（`Interrupt`）/ 事项头 `停止运行中 Agent` | `取消挂起跟进与盯盘` / 单项 `取消`、`暂停` |

### 3.3 明确不做（排除项）

- **不做自然语言聊天指令拦截（如把用户发消息说「停」硬编码成正则杀进程）**：自然语言里说「先把报错停一下看看」或「如果失败就停」极易误判；聊天消息走 Steward 既有的 `interrupt_worker` 工具授权规则，确定性急停一律走工作台显式按钮。
- **不引入强制 `SIGKILL` 新协议帧**：复用 Connector 现有的 `interrupt`（优雅中止 + 超时回收机制），不破坏本地 Git 索引锁安全。

## 4. 模块一：Steward 确定性 Worker 停止状态机与事项收口 API（Stage 1）

### 4.1 单 Worker 5 态确定性停止裁决（`POST /app/api/workers/:workerId/stop`）

在 [`apps/steward/src/steward.ts`](../../apps/steward/src/steward.ts) 与 [`apps/steward/src/dispatch.ts`](../../apps/steward/src/dispatch.ts) 中抽离统一的确定性停止方法 `stopWorkerByOwner({ id, workerId })`，严格按以下真值表在一个事务/幂等闭环内裁决：

| Worker 当前状态 | `worker.cmdId` 在 `outbox` 状态 | 确定性动作 | 返回 `outcome` | 事项状态影响 |
| :--- | :--- | :--- | :--- | :--- |
| 不存在 | — | 抛 `404 worker_not_found` | — | 无 |
| `idle` 或 `broken` | 任意 | **零写入幂等返回**（不发 `interrupt`，不写假时间线） | `"already_stopped"` | 保持原状 |
| `starting` / `queued`（`sessionId === null`） | 仍为 `queued`（尚未发出 DO） | 原子调用 `cancelQueuedCommand(cmdId)` ➔ `settleWithdrawnStart(workerId)`；同步关闭关联的 `offline:<cmdId>` / `switch:<cmdId>` 待决问题与 `sh_proposal`（若为未发出的 `sibling`） | `"withdrawn"` | 若无其他活跃项，**立即回归 `idle`** |
| `starting`（`sessionId !== null`，即续跑待发） | 仍为 `queued`（尚未发出 DO） | 原子调用 `cancelQueuedCommand(cmdId)` ➔ `markResumeCancelled(workerId, cmdId)`（回退为 `idle`，原本地会话完好保留） | `"withdrawn"` | 若无其他活跃项，**立即回归 `idle`** |
| `queued` / `starting` / `running` / `recovering` | 已离开 DO（`sent` / `done`）或无未发挂起命令 | 入队 `interrupt` 命令（`cmdId = wstop:<id>`），记录时间线 `用户手动中断运行` | 在线返回 `"interrupt_sent"`；离线返回 `"interrupt_queued_offline"` | 待 Connector 回传 `settled: aborted` 后转 `idle` |
| `lost` | 任意 | 不伪造已停止，也不盲塞重复命令；返回当前失联状态提示等待机器重连对账 | `"unreachable"` | 保持原状 |

同时同步收紧 `Dispatcher.interruptWorker`（供 Steward LLM 工具与会话流 `worker_cmd` 共用）：当 `worker.state === "idle"` 时直接拒绝并说明「该任务已运行结束，无需中断」；当 `starting` 命令仍在 `outbox` 排队未发时优先走撤回分支，消除两套入口行为分叉。

### 4.2 事项级批量停止与计划收口路由（`POST /app/api/threads/:threadId/stop`）

支持前端在事项详情面板按用户显式选择的维度一次或分步执行确定性收口：

- **请求体**：
  ```ts
  interface ThreadStopInput {
    id: string;                 // 8..128 位幂等请求 ID（sh_web_request 键 `tstop:<id>`）
    stopWorkers?: boolean;      // 停止该 Thread 下全部活跃 Worker（主链 relay + 探针 sibling）
    cancelFollowups?: boolean;  // 取消该 Thread 下全部 status = 'open' 的 sh_followup
    cancelPrWatches?: boolean;  // 取消该 Thread 下全部 status = 'active' 的 sh_pr_watch
    expireProposals?: boolean;  // 关闭该 Thread 下全部 status = 'pending_owner' 的跨机只读探针确认
    pauseRoutines?: boolean;    // 暂停绑定在该 Thread 下全部 status = 'active' 的 sh_routine（默认 false）
  }
  ```
- **返回体**：
  ```ts
  interface ThreadStopResult {
    ok: true;
    id: string;
    threadId: string;
    workers: Array<{ workerId: string; outcome: "withdrawn" | "interrupt_sent" | "interrupt_queued_offline" | "already_stopped" | "unreachable" }>;
    cancelledFollowups: string[];
    cancelledPrWatches: string[];
    expiredProposals: string[];
    pausedRoutines: string[];
  }
  ```
- **时间线与审计留痕**：凡实际撤回/中断了 Worker 或取消/暂停了挂起计划，在 `sh_timeline` 写入一条清晰的摘要记录（如 `已手动取消 1 条待触发跟进与 1 项 PR 盯盘`），并写入 `sh_channel_log`（`web_worker_stopped` / `web_thread_stopped`）。

### 4.3 事项归档（`archiveThread`）防诈尸收口补强

在 [`Steward.archiveThread`](../../apps/steward/src/steward.ts) 确认无活跃 Worker、正式执行归档（`archived: true`）时：
- 自动取消绑定在该 `threadId` 上的残留 `open` `sh_followup`（同步销毁对应 SDK 定时任务）、`active` `sh_pr_watch` 以及未决的 `pending_owner` `sh_proposal`；
- 绑定在该 `threadId` 上的周期 `sh_routine` **不自动删除**；返回结果附带 `cancelledFollowups` 与 `cancelledPrWatches` 计数，确保归档结案的事项不再半夜诈尸唤醒模型。

### 4.4 `WorkspaceThread` 轻量挂起计划视图扩展（[`apps/steward/src/workspace.ts`](../../apps/steward/src/workspace.ts)）

在 `buildWorkspace` 组装每个 `WorkspaceThread` 时，直接从内存已读出的账本快照中附带该事项的活跃计划摘要（零额外慢查询、不含任何内部敏感字段）：

```ts
export interface WorkspaceThreadPlans {
  followups: Array<{ id: string; dueAt: number; reason: string }>;
  prWatches: Array<{ id: string; url: string; nextCheckAt: number }>;
  routines: Array<{ id: string; kind: "digest" | "instruction"; schedule: string; instruction: string }>;
}
```

## 5. 模块二：Web Workspace 三态显式交互体验（Stage 2）

全部前端改动严格遵守 [`apps/steward/ui/dom.js`](../../apps/steward/ui/dom.js) 纯文本节点 `h()` 构造规范（零 `innerHTML`、零内联 `style=`、中英双语键值完整对称）：

1. **触点 A：对话流 `.working` 状态行显式区分「停回复」与「停 Agent」**（[`apps/steward/ui/workspace.js`](../../apps/steward/ui/workspace.js)）
   - 将 `.working` 行按钮文案从笼统的 `停止` 升级为明确的 **`停止本轮回复`**（英文 `Stop reply`）；
   - 当当前选中事项同时存在运行中的本地 Worker 时，在状态行旁附带轻量提示文案（`本地 Agent 仍在运行，可在右侧面板单独中断`），彻底消除「点了停止以为后台进程也停了」的错觉。
2. **触点 B：右侧事项详情栏「就地中断」按钮（单卡级 + 事项头批量级）**
   - **单张 `workerNode` 卡片**：只要 `isActiveWorker(worker)` 为真（`queued` / `starting` / `running` / `recovering`），在卡片操作区直接展示醒目的危险态按钮 **`中断`**（中断请求发送中显示 `正在中断…` 并防抖禁用）；用户无需切进 `Agent 过程` 即可一键撤回或叫停任意主链 Worker 或 `sibling` 探针，机器离线排队的未发出任务更是点完秒回空闲、立刻解锁「归档」按钮。
   - **事项头部动作栏**：当事项下存在活跃 Worker 时，在置灰的「归档」按钮旁并排展示 **`停止运行中 Agent` / `停止全部 Agent (N)`** 快捷按钮，直接解决「想归档提示先停 Agent、旁边却没地方停」的断点。
3. **触点 C：右侧事项详情栏「挂起计划」卡片与停机后顺手收口**
   - 当 `thread.plans` 下存在待触发跟进、活跃 PR 盯盘或活跃绑定例行时，在事项详情栏渲染紧凑的 **「挂起计划」** 分组：
     - 每条跟进提醒 / PR 盯盘列出到期时间或 PR 链接，右侧配单条 **`取消`** 按钮；每条活跃例行配单条 **`暂停`** 按钮；
     - 当挂起跟进 + PR 盯盘合计不少于 1 项时，顶部提供 **`取消全部跟进与盯盘`** 一键收口按钮。
   - 若用户刚在该事项点了中断 Worker，且该事项恰好还挂着待触发跟进或 PR 盯盘，Toast 反馈在告知中断结果的同时温和提醒可在右侧「挂起计划」一并取消，做到**不静默越权、但一键可达**。

## 6. 分阶段实施路线与验证门禁（Stage 1 → Stage 3）

| 阶段 | 交付范围 | 验证门禁 |
| :--- | :--- | :--- |
| **Stage 1：后端三态裁决与收口 API** | `dispatch.ts` / `steward.ts` 补齐 5 态 `stopWorkerByOwner` 与 `stopThreadByOwner`、补强 `interruptWorker` 终态与未出站撤回、`archiveThread` 自动清理残留一次性跟进/盯盘、`workspace.ts` 挂载 `thread.plans`、`workspace-api.ts` 暴露 `/app/api/workers/:id/stop` 与 `/app/api/threads/:id/stop` | `packages/protocol` 与 `apps/steward` `tsc --noEmit` 零错误；现有 `turn-stop.test.ts`、`dispatch.test.ts`、`worktree-archive.test.ts` 零回归 |
| **Stage 2：工作台三态显式交互** | `workspace.js`、`i18n.js`、`workspace.css` 落地 `.working` 显式「停止本轮回复」文案、`workerNode` 与事项头就地中断按钮、右侧「挂起计划」展示与一键收口 | `ui-modules.test.ts` 全部通过（零 HTML 注入、零内联样式、中英双语键值与占位符 100% 对齐），`build-node.mjs` 构建通过 |
| **Stage 3：端到端回归测试套件** | 新增 `apps/steward/test/three-way-stop.test.ts`，覆盖三态正交隔离、离线未出站 `start_worker` 秒撤回解锁归档、未出站续跑撤回保会话、在线 `interrupt` 投递、多 Worker（含 `sibling`）批量中断、挂起跟进/盯盘单条与批量收口（保留周期 `routine`）、归档防诈尸清理与 `sh_web_request` 幂等重放 | 全套新增测试与关联回归测试在 Node 运行时 100% 通过 |
