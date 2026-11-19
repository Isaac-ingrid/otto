# Workspace Git Diff 审阅与 Thread 归档自动清理 Worktree 实施方案

状态：设计定稿，待实施（2026-11-18）。关联前序决策：[ADR-0004](../adr/0004-web-workspace.md)（Web Workspace）、[ADR-0022](../adr/0022-report-labels-worktree-hooks-and-readonly-proposals.md)（本地批准的 `setup` / `archive` 生命周期钩子）。

实施顺序：**Stage 1（Protocol + Connector 层：`worker_diff` 按需采集与 `WorktreeManager.cleanup` 边界修正） → Stage 2（Steward 账本、持久化 Outbox 归档回收与 API/工具层） → Stage 3（Web Workspace Diff 查看器与归档确认交互）**。

## 1. 背景与真实痛点

目前 Otto 的派单与多后端执行（`pi`、`claude-code`、`codex`）已经全部线上化，但任务收尾的「最后一百米」仍断在线下终端：

1. **看不见具体代码变更**：Worker 在独立 worktree 跑完并上报 `report` 后，Steward 仅持久化 [`GitFacts`](../../packages/protocol/src/git.ts) 计数摘要，Web Workspace 只能回看对话流水账（Session Viewer），无法直接审阅文件增删改的 Unified Diff。
2. **归档与磁盘回收断链**：[`sh_thread`](../../apps/steward/src/schema.ts) 虽已预留 `archived` 列，Connector 侧 [`WorkerManager.cleanupWorktree`](../../apps/connector/src/worker-manager.ts) 也已实现带 `archive` hook 的清理能力，但 Steward 与 Web Workspace 尚未提供归档入口，也从未自动触发 `cleanup_worktree`，长期运行会导致 `~/.otto/worktrees` 与本地 `otto/<slug>-<n>` 分支堆积。

## 2. 现状盘点（复用既有底座，不重复造轮子）

| 模块 | 已有能力 | 现有缺口 | 代码位置 |
| --- | --- | --- | --- |
| Connector Worktree 清理 | `cleanup_worktree` 命令处理已就绪：拦截运行中/热驻留进程、非 `force` 拦截未提交改动与未推送提交、移除前执行已批准 `archive` hook、成功后 `clearWorkerWorktree` | 仅用 `git branch -r --contains HEAD` 判未推送，会导致「零新提交（`HEAD === base`）且主仓无远端」或「只读 detached worktree」被误拒；未顺带清理已无独有提交的 `otto/*` 本地分支 | [`apps/connector/src/worktree.ts`](../../apps/connector/src/worktree.ts)、[`apps/connector/src/worker-manager.ts`](../../apps/connector/src/worker-manager.ts) |
| 无状态按需中继 | `directory_list` / `directory_listing` 已实现「Browser HTTP → Steward DO → Connector WS → HTTP 响应」的有界、带 `AbortSignal` 超时、零 DO 落盘中继范式 | 尚无面向 Worker 工作目录的 Git Diff 中继消息对 | [`packages/protocol/src/directories.ts`](../../packages/protocol/src/directories.ts)、[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts) |
| Steward 归档与派发 | `sh_thread.archived` 列已存在且 `threads.list()` 默认过滤 `archived = 0`；下行 `cmd` 具备持久化 Outbox（离线排队、重连投递） | 缺少 `threads.setArchived`、归档 API、`archive_thread` 工具、`sh_worker.worktreeStatus` 状态追踪，以及取消归档后续派时的「已清理 worktree 自动开新棒」防呆 | [`apps/steward/src/ledger.ts`](../../apps/steward/src/ledger.ts)、[`apps/steward/src/dispatch.ts`](../../apps/steward/src/dispatch.ts) |

## 3. 核心设计不变量与排除范围

### 3.1 核心不变量
1. **Diff 正文零落盘（Relay-Only）**：Steward Durable Object 绝不将代码 Diff 写入 SQLite；仅在浏览器展开变更面板时经在线 Connector 按需实时拉取，单次响应严格受字节预算（`192 KiB`）与超时（`10s`）约束。
2. **未保存代码零静默丢弃**：自动清理必须区分「干净 / 已推送 / 零独有提交」与「含未提交脏改动或本地独有未推送提交」；命中后者时默认拒绝自动删除，必须由 Owner 显式确认选择「强力清理并归档（`force`）」或「保留本地工作树仅归档（`keep`）」。
3. **机器离线不阻塞归档**：归档立即更新 `sh_thread.archived = 1`，而 `cleanup_worktree` 写入目标机器的持久化 Outbox；机器后续上线握手后自动补跑清理与 `archive` hook。

### 3.2 明确不做（排除项）
- **不在本轮引入「自动合并回本地默认分支（auto-merge）」**：本地主分支可能正被用户在终端编辑，自动切分支合并极易引发工作区冲突；合入路径保持走现有受控 `pr_worker` 或用户本地合并。
- **不允许 Worker 自主归档 Thread**：遵守 [ADR-0022](../adr/0022-report-labels-worktree-hooks-and-readonly-proposals.md) 边界，归档只能由 Owner 在 Workspace 操作或明确口头指示 Steward 执行。
- **不在前端使用任何 HTML 注入渲染 Diff**：严格遵守 [`ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts) 门禁，禁止 `innerHTML` 与内联样式。

## 4. 模块一：Worker Git Diff 按需审阅设计

### 4.1 协议定义（[`packages/protocol/src/git.ts`](../../packages/protocol/src/git.ts)）
对齐 `directory_list` / `directory_listing` 新增有界请求/响应对（常量上限：`WORKER_DIFF_INLINE_PATCH_MAX_BYTES = 128 * 1024`，`WORKER_DIFF_MESSAGE_MAX_BYTES = 192 * 1024`，`WORKER_DIFF_TIMEOUT_MS = 10_000`）：

- **请求 `worker_diff`**（Steward DO → Connector）：
  `{ t: "worker_diff", id: string, workerId: string, filePath?: string, contextLines?: number }`
- **响应 `worker_diff_result`**（Connector → Steward DO）：
  - `ok: true`：包含 `base`、`branch`、`head`、`dirty`、`ahead`、`pushed`、`commits`（`base..HEAD` 提交列表，上限 50 条）、`files`（全量变更文件：`{ path, oldPath?, status: "A" | "M" | "D" | "R" | "U", insertions, deletions, binary }`，上限 500 项）、`patch: string`、`patchTruncated: boolean`。
  - `ok: false`：`code ∈ "not_found" | "no_worktree" | "not_git_repo" | "invalid_path" | "diff_failed" | "busy"`。

### 4.2 两级按需采集与安全脱敏（Connector）
1. **统一采集范围（覆盖已提交 + 未提交 + 未跟踪文件）**：
   - 针对 `worker.worktree`（或具备 `base` 的 Git 仓 `in-place` 工作目录），执行 `git diff --numstat -M <base>` 与 `git status --porcelain` 生成完整 `files` 摘要（含未跟踪新文件 `U`）。
   - **首屏整包模式（未传 `filePath`）**：执行 `git diff --no-ext-diff --unified=3 -M <base>`；若 UTF-8 字节数不超过 `128 KiB`，直接随首包返回完整 `patch`（`patchTruncated: false`），90% 日常改动一次往返秒开；超出预算则截断或置空整包 `patch`（`patchTruncated: true`），由前端按文件点开。
   - **单文件按需模式（传入 `filePath`）**：校验 `filePath` 为合法相对路径（禁止绝对路径、`..` 段、空字节），置于 `--` 分隔符后执行 `execFile("git", ["diff", "--no-ext-diff", "--unified=3", "-M", base, "--", filePath])`（若为未跟踪新文件 `U`，直接限长读取构造新增块），单文件上限 `128 KiB`。
2. **敏感信息脱敏**：所有返回的 `patch` 与提交说明统一经 [`redactText`](../../apps/connector/src/redact.ts) 过滤已知密钥。

### 4.3 Steward 中继路由与前端渲染
- **Steward HTTP 路由**：在 [`workspace-api.ts`](../../apps/steward/src/workspace-api.ts) 新增 `POST /app/api/workers/:workerId/diff`（校验会话、CSRF 与同源，绑定请求级 `AbortSignal`）；若机器离线返回 `409 machine_offline`，前端回退展示已持久化的静态 `GitFacts`。
- **Workspace 视图**：在 [`workspace.js`](../../apps/steward/ui/workspace.js) 的 `workerNode` 渲染分支与增删统计条及「查看变更」折叠抽屉；左侧/顶部列出 `files` 清单（支持点击单文件懒加载超大 Diff），代码区全部用 `h('pre')` / `h('div')` 纯文本节点按行渲染 `.diff-add` / `.diff-del` / `.diff-hunk` 高亮。

## 5. 模块二：Thread 归档与 `cleanup_worktree` 自动回收闭环

### 5.1 归档清理 5 态确定性裁决矩阵

新增 `POST /app/api/threads/:threadId/archive`（参数 `{ id, archived: boolean, cleanupPolicy?: "auto" | "force" | "keep" }`，默认 `"auto"`）以及供用户明确指令调用的 Steward 工具 `archive_thread`：

| Thread 下关联 Worker / Worktree 状态 | `"auto"` 默认裁决 | 执行动作与状态流转 |
| --- | --- | --- |
| **1. 含活跃或排队中 Worker**（`starting` / `running` / `queued` / `recovering`） | **拒绝（`409 thread_active`）** | 不修改 `archived`，提示先停止运行中的任务 |
| **2. 无独立 Worktree**（纯问答、`plain` 目录、`in-place` 模式或已清理） | **直接归档** | `sh_thread.archived = 1`，无需下发清理命令 |
| **3. 只读独立 Worktree**（`mode === "readonly"` 的 detached worktree） | **直接归档 + 自动清理** | `archived = 1`；向 Outbox 写入 `cleanup_worktree { workerId, force: false }` |
| **4. 写 Worktree 已推送远端（`pushed` / 已有 PR）或无独有变更（`ahead === 0 && dirty === 0`）** | **直接归档 + 自动清理** | `archived = 1`；`worktreeStatus = "cleaning"`；向 Outbox 写入 `cleanup_worktree { workerId, force: false }`（自动触发已批准 `archive` hook） |
| **5. 写 Worktree 含未提交改动（`dirty > 0`）或未推送本地提交（`ahead > 0 && !pushed`）** | **拦截确认（`409 worktree_unmerged`）** | 返回受影响 Worker 分支与未保存计数，前端弹框供用户二选一：① `cleanupPolicy: "force"`（跑完 `archive` hook 后强清工作树并归档）或 ② `cleanupPolicy: "keep"`（保留本地工作树仅归档） |

### 5.2 三项关键边界修补
1. **修补 `WorktreeManager.cleanup` 的安全清理判定与孤儿分支回收**（[`apps/connector/src/worktree.ts`](../../apps/connector/src/worktree.ts)）：
   - 非 `force` 模式下，当工作树无未提交脏改动（`!dirty`）时，若满足以下任一条件即视为无独有未保存提交、允许安全清理：① `mode === "readonly"`；② `HEAD === base`（零新提交，兼容无 `origin` 的纯本地 Git 仓）；③ `HEAD` 已被远端追踪分支或主仓默认分支包含。
   - 当写工作树的 `otto/<slug>-<n>` 分支无独有未合入提交（或 `force === true`）时，在 `git worktree remove` 后顺带执行 `git branch -d/-D` 回收该临时分支。
2. **Connector 实盘二次兜底**：若账本缓存的 `GitFacts` 显示干净，但用户在终端手动改脏了该 worktree，Connector 执行 `cleanup_worktree { force: false }` 会实盘拦截并返回 `worktree_dirty`（或 `archive_hook_failed`）；Steward 收到 `cmd_result` 后将 `sh_worker.worktreeStatus` 标为 `"cleanup_blocked"`，绝不静默删文件。
3. **取消归档（Unarchive）后的续接防呆**：
   - Steward 新增迁移 `042_worktree_lifecycle`（在 `sh_worker` 增加 `worktreeStatus TEXT NOT NULL DEFAULT 'active'`，并在 Connector `hello.workers` 同步 `hasWorktree: boolean`）。
   - 当已归档且 `worktreeStatus === 'cleaned'` 的 Thread 被取消归档并继续追加指令时，[`dispatch.ts`](../../apps/steward/src/dispatch.ts) 识别旧写 Worker 工作树已回收，自动走 `start_worker` 开启新一棒并附带交接简报，避免向已清理目录的旧 Worker 误发 `send`。

## 6. 分阶段交付与验证门禁

1. **Stage 1（Protocol + Connector）**：落地 `worker_diff` / `worker_diff_result` 与 `hasWorktree` 协议 schema；实现 `collectWorkerDiff`（两级预算、路径防穿越、密钥脱敏）与 `WorktreeManager.cleanup` 边界修正；补齐协议与 Connector 单测。
2. **Stage 2（Steward 账本、Outbox 与 API）**：落地 `042_worktree_lifecycle` 迁移、`worker_diff` 无状态中继路由、Thread 归档/取消归档 API 与 `archive_thread` 工具、离线 Outbox 投递、`cmd_result` 回写与 `dispatch` 续接防呆；补齐 Steward 节点单测。
3. **Stage 3（Web Workspace UI 与全仓门禁）**：落地 Worker Diff 折叠查看器、Thread 归档按钮与未合入变更二次确认弹层、侧边栏「已归档」筛选切换；跑通 `ui-modules.test.ts`（零 HTML sink 与双语词条完整性）、全仓 5 项 `tsc --noEmit`、全量 Vitest 套件与 `npm pack --dry-run`。
