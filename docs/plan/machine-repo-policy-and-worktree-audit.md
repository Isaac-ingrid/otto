# 机器仓库策略与陈旧 Worktree 巡检清理实施方案

状态：已落地（Stage 1–3 全部完成）
前置依赖：[ADR-0004（Web Workspace）](../adr/0004-web-workspace.md)、[ADR-0016（暗色仪表盘视觉体系）](../adr/0016-dark-instrument-panel-theme.md)、[ADR-0022（本地自主权与跨仓安全边界）](../adr/0022-conductor-095-selective-adoption.md)、[Worktree Diff 与归档自动清理方案](./worktree-diff-and-archive-cleanup.md)、[Conductor 0.95 借鉴评估](./conductor-0.95-adoptions.md)

实施顺序：**Stage 1（`048_repo_policy_and_worktree_audit` 迁移 + `hello.repos` 写策略透传 + Connector 只读巡检与受控清理引擎） → Stage 2（Steward 账本交叉对账分类器 + `GET .../worktrees/audit` & `POST .../worktrees/cleanup` 接口与路由审计门禁） → Stage 3（控制面「机器与 Worktree 巡检」面板、机器弹窗深链入口与高危二次确认门禁）**。

## 1. 背景与真实痛点

已落地的 [Worktree Diff 与归档自动清理方案](./worktree-diff-and-archive-cleanup.md)（`042_worktree_lifecycle`）打通了「归档单个 Thread 时顺手回收关联工作树」的闭环，但在真实多机高频编码场景下仍存在四个明显的运维盲区：

1. **缺少跨事项全局体检视角**：
   - 当 Owner 开启过大量实验性写工作树、归档时选择了 `keep`（保留工作树）、归档时机器恰好离线且后续队列超时，或者大量事项长期处于 `idle` 未归档状态时，`~/.otto/worktrees/<repoName>-<pathHash>/` 下会静默堆积数十个工作树副本（含各自独立的编译产物或虚拟环境），占用数 GB 甚至数十 GB 磁盘空间，而 Web 端没有任何全局体积与分布视图。
2. **崩溃残留的「无主孤儿目录」无法通过现有命令回收**：
   - 现有 `cleanup_worktree` 命令（[`apps/connector/src/worker-manager.ts`](../../apps/connector/src/worker-manager.ts)）强依赖传入 `workerId` 并在 Connector `LocalStore.worker` 表中查到记录。如果 Connector 在 `git worktree add` 中途异常断电崩溃、本地 SQLite 重置，或目录删除半途失败，磁盘与 Git 元数据中就会留下没有对应 `workerId` 的孤儿工作树目录或悬空 `prunable` 记录，现有单事项归档入口完全无法触达。
3. **陈旧未合并分支缺少集中盘点与防误删分级**：
   - 散落在不同历史事项里的 `otto/<slug>-<n>` 分支究竟哪些已经合入默认主干、哪些已经超过 N 天无提交但仍含未合入代码或 `dirty` 未提交修改，目前只能逐个点开历史 Thread 的 Diff 抽屉人工排查。
4. **本地仓库级并发与隔离策略在 Web 端不可见**：
   - Connector 本地已经维护了完整的仓库写策略（[`apps/connector/src/write-policy.ts`](../../apps/connector/src/write-policy.ts)：`isolation: 'worktree' | 'in-place'`、`concurrency: 'parallel' | 'serial'`）、生命周期 Hooks（`setup` / `archive`）及 `pi --approve` 授权状态，但 `hello.repos` 与 Steward `sh_repo` 尚未同步 `isolation` 与 `concurrency` 字段，导致 Owner 在 Web 控制面看不到某仓库为何在排队（`serial`）或为何原地修改主工作区（`in-place`）。

## 2. 现状盘点与相对初稿的五项代码库对齐修正

在落盘协议前，结合当前代码库真实表结构与安全模型，对初稿设想做如下五项精确对齐：

| 对齐维度 | 初稿设想 | 代码库真实结构 | 本方案定稿设计 |
| --- | --- | --- | --- |
| **1. 账本交叉对账表** | 与 `sh_thread_repo` 交叉对账 | [`schema.ts`](../../apps/steward/src/schema.ts) 中 `sh_thread_repo (threadId, repoId)` 仅存多对多关联，**不含 `workerId`、分支名或工作树路径**；真实绑定关系分布在 Connector `LocalStore.worker` 与 Steward `sh_worker` + `sh_thread` + `sh_pr_consent` | 采用**双端联合对账**：Connector 扫描 Git 工作树、`~/.otto/worktrees` 受管目录与本地 `worker` 表上报原始事实；Steward 结合 `sh_worker`、`sh_thread` 与 `sh_pr_consent` 完成四态权威分类 |
| **2. 仓库策略模型** | 展示「仓库最大并发写工作树数、默认基准分支」 | [`write-policy.ts`](../../apps/connector/src/write-policy.ts) 与 [`connector-app.ts`](../../apps/connector/src/connector-app.ts) 中，并发上限在机器级为 `limits.maxWorkers`，仓库级策略为二元正交组合 `isolation ('worktree' \| 'in-place')` × `concurrency ('parallel' \| 'serial')` + `defaultBranch` + `hooks` + `projectApproved` | 扩展 `RepoSchema` 与 `048` 迁移将 `writeIsolation` / `writeConcurrency` 缓存进 `sh_repo`（机器离线亦可只读查看），与机器级 `maxWorkers`、`defaultBranch`、Hooks 审批态同屏展示；策略修改保持 CLI 专属（`otto repo-config`） |
| **3. 外部自建工作树物理保护** | 遍历 `git worktree list --porcelain` | `git worktree list` 会同时列出**主工作区（`repo.path`）**以及用户在 `~/.otto/worktrees/` 之外手动执行 `git worktree add` 创建的私人工作树 | 强物理围栏：主工作区直接排除；路径 `realpath` 不在 `realpath(${stateDir}/worktrees)` 下的条目一律标为 `external_unmanaged`（仅只读提示，**协议层与文件系统层双重禁止删除**） |
| **4. 无 `workerId` 孤儿目录回收** | 复用单 worker 清理逻辑 | 崩溃残留目录或悬空 Git worktree 元数据可能无 `workerId`，现有 `cleanupWorktree(workerId)` 会报 `not_found` | 新增受控 `worktree_cleanup` 操作，同时支持按 `workerId` 回收（联动 `archive` hook 与 `sh_worker.worktreeStatus = 'cleaned'`）与按受管相对子路径 `<repoDir>/<slug>` 回收孤儿目录 + `git worktree prune` |
| **5. 跨平台磁盘体积扫描** | 直接统计目录体积 | Connector 支持 macOS / Linux / Windows 原生运行（[`win32.ts`](../../apps/connector/src/win32.ts)），调用外部 `du` 在 Windows 不可用，而无上限递归 `node_modules` 会阻塞事件循环 | 采用纯 Node `fs/promises` 异步 `opendir` + `lstat`（严禁跟随符号链接），内置单工作树条目预算上限（`25,000` 个文件系统条目）与总超时保护；超预算时诚实标记 `diskComplete: false`（前端渲染为 `≥ X MB`） |

## 3. 核心安全边界与设计不变量（对齐 ADR-0022）

1. **巡检阶段绝对只读（Read-Only Audit Invariant）**：
   - `GET /app/api/machines/:deviceId/worktrees/audit` 及其下发的 `worktree_audit` 帧**严禁修改任何工作区文件、严禁执行 `git worktree prune`、严禁清理任何锁文件或本地数据库行**，甚至对 Git 命令显式附加 `--no-optional-locks` 避免在用户本地仓库留下锁竞争。
2. **受管根目录硬围栏（Managed Root Containment）**：
   - Connector 任何删除动作前必须校验目标目录的 `realpath`（若目录仍存在）或规范化父路径严格位于 `realpath(join(stateDir, "worktrees"))` 内部且深度精确匹配 `<repoName>-<pathHash>/<slug>` 两级结构，包含符号链接逃逸、`..` 段或指向 `repo.path` 主检出目录的请求一律以 `forbidden_path` 拒绝。
3. **运行中工作树绝对免疫（Active Worker Immunity）**：
   - 无论请求是否携带 `force: true`，只要某工作树在 Connector 侧存在活跃进程/会话锁（`running` / `starting` / `recovering` / `queued_start`）或在 Steward 侧关联活跃运行态 Worker，服务端一律拒绝删除（返回 `worker_active`），前端复选框永久置灰锁定。
4. **高危清理强制二次确认（Two-Tier Confirmation Gate）**：
   - 默认「一键全选安全项」仅勾选**孤立残留（`orphaned`）**或**闲置已净（`idle_clean`）**中满足 `dirty === false` 且 `ahead === 0 || mergedIntoBase === true` 的条目。
   - 凡涉及 `dirty === true`（含未提交修改或未跟踪文件）或 `ahead > 0 && !mergedIntoBase`（含未合入基准分支的本地提交）的条目，**严禁直接一键批量删除**：前端必须弹出高危核对框逐条列出完整路径、分支名、未提交文件数与未合入提交数，且服务端要求显式传入 `force: true` 与 `confirmedRisks: true` 双标志才放行（否则返回 `cleanup_blocked_dirty` / `cleanup_blocked_unmerged`）。
5. **零模型调用与本地主权边界**：
   - 整个巡检、对账与清理链路 100% 确定性执行，消耗 0 LLM Token；本地仓库策略（`isolation`、`concurrency`、Hooks、`pi --approve`）在 Web 端严格只读展示，绝不开放远程 Web 改写本地仓库安全边界的口子。

## 4. Stage 1：协议扩展、`048` 迁移与 Connector 巡检/清理引擎

### 4.1 仓库写策略透传与数据库迁移 `048_repo_policy_and_worktree_audit`

1. **Protocol 扩展（[`packages/protocol/src/messages.ts`](../../packages/protocol/src/messages.ts)）**：
   - 在 `RepoSchema` 中增加可选写策略结构（向后兼容旧版 Connector）：
     ```ts
     export const RepoWritePolicySchema = z.object({
       isolation: z.enum(["worktree", "in-place"]),
       concurrency: z.enum(["parallel", "serial"]),
     });
     ```
   - 在 `HelloMessageSchema.shape.capabilities` 中新增 `worktreeAudit: z.boolean().optional()`。
   - 在 [`apps/connector/src/connector-app.ts`](../../apps/connector/src/connector-app.ts) 的 `snapshot().repos` 与 [`repository.ts`](../../apps/connector/src/repository.ts) 注册回包中附带 `writePolicy: r.writePolicy`。
2. **Steward SQLite 迁移 `048_repo_policy_and_worktree_audit`（[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)）**：
   - 使用 `ignoringDuplicateColumn` 为 `sh_repo` 增加持久化策略缓存列：
     - `writeIsolation TEXT NOT NULL DEFAULT 'worktree'`（`plain` 仓库落盘时默认 `'in-place'`）；
     - `writeConcurrency TEXT NOT NULL DEFAULT 'parallel'`（`plain` 仓库落盘时默认 `'serial'`）；
     - `repoPath TEXT`（复用已有 `path` 列对外只读输出，供机器与巡检视图展示本地挂载路径与默认分支 `defaultBranch`）。
   - 扩展 [`ledger.ts`](../../apps/steward/src/ledger.ts) 的 `recordRepository` 与 `RepoSummaryRow`，使机器离线时控制面仍可读取各仓库最近一次同步的完整策略配置。

### 4.2 Connector 无状态巡检与清理协议帧（[`packages/protocol/src/messages.ts`](../../packages/protocol/src/messages.ts)）

沿用 `worker_diff` 与 `repo_skill_op` 的无状态请求-响应通道（不走持久化 `outbox`，断线即快速失败由前端感知，写入幂等由 Steward `sh_web_request` 保障）：

1. **只读巡检请求 `worktree_audit` → `worktree_audit_result`**（超时常量 `WORKTREE_AUDIT_TIMEOUT_MS = 20_000`）：
   ```ts
   export interface WorktreeAuditMessage {
     t: "worktree_audit";
     id: string;
     repoId?: string; // 可选：仅扫描单个仓库；省略时扫描该机器全部已登记仓库
   }

   export interface RawAuditedWorktree {
     repoId: string;
     worktreeKey: string;            // 受管目录相对键 "<repoDir>/<slug>"；外部目录为 "ext:<sha256(path).slice(0,12)>"
     path: string;                   // 机器本地绝对路径（供二次确认框核对）
     managedByOtto: boolean;         // 是否严格位于 realpath(${stateDir}/worktrees) 下
     existsOnDisk: boolean;          // false 表示 git worktree list 中标记 prunable（目录已不在磁盘）
     prunable: boolean;
     locked: boolean;
     detached: boolean;
     branch: string | null;          // 如 "otto/fix-auth-1"，detached 时为 null
     headSha: string | null;
     baseBranch: string | null;      // LocalStore.worker.base 或 repo.defaultBranch
     dirty: boolean;
     modifiedCount: number;          // 已跟踪文件暂存/未暂存改动数
     untrackedCount: number;         // 未跟踪文件数
     ahead: number;                  // 相对 baseBranch 未合入提交数
     pushed: boolean;                // 是否存在已同步的远端上游分支且 aheadUpstream === 0
     mergedIntoBase: boolean;        // headSha 是否为 baseBranch 的祖先提交（含 ahead === 0）
     lastCommitAt: number | null;    // 毫秒时间戳（git log -1 --format=%ct * 1000）
     diskBytes: number;              // 实测占用字节数
     diskComplete: boolean;          // false 表示触达单目录条目预算上限（前端显示 ≥ X MB）
     // Connector LocalStore 本地关联快照（若存在）：
     localWorkerId: string | null;
     localThreadId: string | null;
     localMode: "write" | "readonly" | null;
     localState: string | null;
     localUpdatedAt: number | null;
   }
   ```
2. **受控清理请求 `worktree_cleanup` → `worktree_cleanup_result`**（超时常量 `WORKTREE_CLEANUP_TIMEOUT_MS = 30_000`，单批最多 `32` 个目标）：
   ```ts
   export type WorktreeCleanupTarget =
     | {
         kind: "worker";
         repoId: string;
         workerId: string;
         expectedBranch?: string | null;
         force: boolean;
       }
     | {
         kind: "orphan_dir";
         repoId: string;
         worktreeKey: string; // 必须匹配 "<repoName>-<pathHash>/<slug>"
         expectedBranch?: string | null;
         force: boolean;
       };

   export interface WorktreeCleanupMessage {
     t: "worktree_cleanup";
     id: string;
     targets: WorktreeCleanupTarget[];
     pruneRepoIds: string[];
     confirmedRisks: boolean;
   }
   ```

### 4.3 Connector 扫描与安全回收引擎（新增 `apps/connector/src/worktree-audit.ts`）

1. **双源合并扫描（不漏掉任何孤儿目录）**：
   - **源 A（Git 注册表）**：对每个 `kind === "git"` 的已登记仓库执行 `git --no-optional-locks -C <repo.path> worktree list --porcelain`，解析所有非主工作区（跳过首条 `repo.path` 主工作区）。
   - **源 B（受管磁盘目录）**：扫描 `${stateDir}/worktrees/<repoName>-<pathHash>/*` 下的一级子目录。若有子目录存在于磁盘但已不在 `git worktree list` 中（例如之前只执行了 `git worktree prune` 却残留了物理文件夹，或创建半途失败），同样纳入巡检结果（标记 `managedByOtto: true, existsOnDisk: true`）。
   - **源 C（`LocalStore.worker` 对齐）**：按规范化 `worktree` 路径（及 `workerId`）匹配本地 `worker` 行，补全 `localWorkerId`、`localThreadId`、`base`、`localState`。
2. **Git 状态与合并判定（只读、低开销）**：
   - 若 `existsOnDisk === true` 且含 `.git` 指针：执行 `git --no-optional-locks -C <wtPath> status --porcelain=v1 -uall` 统计 `modifiedCount` 与 `untrackedCount`（任一 `> 0` 即 `dirty = true`）；执行 `git --no-optional-locks -C <wtPath> log -1 --format=%ct` 获取末次提交时间。
   - 相对基准分支（优先取 `worker.base`，回退 `repo.defaultBranch`）：执行 `git rev-list --count <base>..HEAD` 计算 `ahead`；当 `ahead === 0` 时 `mergedIntoBase = true`，否则以 `git merge-base --is-ancestor HEAD <base>` 复核是否已快进合入。
3. **跨平台有界目录体积统计（`measureDirectoryBytesBounded`）**：
   - 使用异步队列遍历目录树，`opendir` + `lstat` 累加常规文件 `stats.size`，遇到 `isSymbolicLink()` 直接跳过（防环路与跨盘误算）。
   - 单工作树最多统计 `MAX_STAT_ENTRIES_PER_WORKTREE = 25_000` 个条目，整机单次巡检最多并发扫描 `3` 个工作树；触顶立即停止下钻并返回 `{ diskBytes, diskComplete: false }`，保证即使存在庞大 `node_modules` 也能在数百毫秒内稳定返回。
4. **受控清理执行顺序**：
   - 逐项复核目标工作树当前实时状态（**防 TOCTOU 竞态**：若用户在打开巡检面板后刚往该工作树写入了新未提交改动，而本次请求 `force === false || confirmedRisks === false`，实时复核立即拦截并返回单条 `status: "blocked_dirty"`，绝不误删刚刚产生的新代码）。
   - 对 `kind === "worker"` 目标：若仓库已审批 `archive` Hook 则按既有契约执行归档钩子，随后执行 `git worktree remove [--force] <wtPath>` + 兜底 `rm(wtPath, { recursive: true, force: true })`（仅限受管根内）+ 若本地分支已合入或 `force === true` 则安全清理 `otto/*` 分支引用 + 调用 `store.clearWorkerWorktree(workerId, now)`。
   - 对 `kind === "orphan_dir"` 目标：双重校验 `worktreeKey` 对应的 `<repoName>-<pathHash>` 确属该 `repoId` 且位于 `realpath(worktreesRoot)` 内后，执行 `git worktree remove [--force]`（若仍在 Git 列表中）+ `rm` 删除孤儿目录。
   - 最后对所有受影响仓库及 `pruneRepoIds` 执行 `git -C <repo.path> worktree prune` 清理悬空管理元数据，并返回逐项结果清单 `{ cleaned, skippedOrBlocked, prunedRepoIds }`。

## 5. Stage 2：Steward 交叉对账分类器与 HTTP API

### 5.1 四态交叉对账分类规则（新增 `apps/steward/src/worktree-audit.ts`）

Steward 收到 Connector 返回的 `RawAuditedWorktree[]` 后，与本地 SQLite 中的 `sh_worker`、`sh_thread`、`sh_pr_consent` 交叉关联，为每个受管工作树赋予唯一分类 `category` 与风险标记：

| 分类枚举 (`category`) | 中文定义 | 判定条件（按优先级自上而下匹配） | 默认批量安全勾选 | 允许清理条件 |
| --- | --- | --- | --- | --- |
| **`external_unmanaged`** | 外部自建工作树 | `managedByOtto === false`（用户在 `~/.otto/worktrees` 外手动创建的 Git worktree） | 永不勾选 | **禁止通过 Otto 删除**（只读展示） |
| **`active`** | 活跃绑定中 | Connector `localState` 或 Steward `sh_worker.state` 处于 `'queued' \| 'starting' \| 'running' \| 'recovering'`，或关联 `sh_thread` 未归档且 `state IN ('running', 'waiting_you')` | 永不勾选 | **禁止删除**（需先停止或等待运行结束） |
| **`orphaned`** | 孤立残留 | ① 无匹配 `sh_worker` 记录（含无 `localWorkerId` 的崩溃残留目录、`existsOnDisk === false` 的 `prunable` 悬空项、或跨实例遗留项）；或 ② 关联 `sh_thread` 不存在或 `sh_thread.archived === 1` | 仅当 `!dirty && (ahead === 0 \|\| mergedIntoBase)` 时自动纳入「安全项」 | 干净项可直接勾选清理；若含 `dirty` 或未合入提交，必须走二次高危确认 |
| **`stale_unmerged`** | 陈旧未合并 | 关联未归档 `idle / broken / lost` 事项，距离最近活动时间 `now - max(lastCommitAt, worker.updatedAt, thread.lastActivityAt) >= staleDays * 86_400_000`（默认 `7` 天），且 `dirty === true \|\| (ahead > 0 && !mergedIntoBase)` | **默认不勾选**（禁用批量一键直删） | 必须在二次确认弹窗核对路径、分支与未提交/未合入计数并勾选风险确认 |
| **`idle_clean`** | 闲置已净 | 关联未归档 `idle / broken / lost` 事项，满足 `dirty === false && (ahead === 0 \|\| mergedIntoBase)`（代码已合入主干或无任何改动，仅占磁盘空间），或未满 `staleDays` 天但已干净完结 | 支持纳入「安全项」回收空间 | 标准确认即可安全回收（保留 Thread 对话与历史汇报不变） |

### 5.2 Workspace HTTP 接口契约（[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts)）

1. **只读机器策略与仓库列表增强**：
   - 在 `GET /app/api/workspace` 的 `machines[]`（或新增字段 `repoPolicies`）中，除保留向后兼容的 `repos: string[]` 外，补充结构化 `repoDetails` 数组：
     ```ts
     export interface WorkspaceMachineRepoPolicy {
       repoId: string;
       name: string;
       path: string;
       capabilityKind: "git" | "plain";
       defaultBranch: string | null;
       writeIsolation: "worktree" | "in-place";
       writeConcurrency: "parallel" | "serial";
       hasSetupHook: boolean;
       hasArchiveHook: boolean;
       hooksApproved: boolean;
       projectApproved: boolean;
     }
     ```
   - 这样即使机器处于 `offline` 离线状态，Owner 打开控制面或机器面板也能随时查阅每台机器每个仓库的默认分支、并发隔离策略与审批状态。
2. **只读巡检接口 `GET /app/api/machines/:deviceId/worktrees/audit`**：
   - **Query 参数**：
     - `staleDays`：允许正整数 `1..90`（默认 `7`，前端提供 `3 / 7 / 14 / 30` 快捷档位）；
     - `repoId`：可选过滤单个仓库。
   - **响应结构**：返回机器元信息（含 `maxWorkers`、`online`）、按仓库聚合的策略与磁盘占用汇总 `repos[]`（含 `prunableCount`、`managedDiskBytes`、`reclaimableBytes`），以及排序后的工作树条目清单 `items[]`（孤立残留与陈旧未合并置顶，按体积降序排列，附带关联 `threadId`、`threadTitle`、`threadArchived`、`prUrl`）。
   - **离线与兼容降级**：若机器离线返回 `409 { error: "machine_offline" }`（前端仍展示缓存的仓库策略表并提示上线后可扫描磁盘）；若旧版 Connector 未声明 `capabilities.worktreeAudit` 返回 `409 { error: "unsupported" }`。
3. **受控清理接口 `POST /app/api/machines/:deviceId/worktrees/cleanup`**：
   - **安全校验**：强制要求有效会话 Cookie、`X-CSRF-Token`、同源 `Origin`（加入 `workspace-api.ts` 的 `requireOrigin` 列表）及客户端请求幂等键 `id`（写入 `sh_web_request` `worktree-cleanup:${id}`）。
   - **账本闭环联动**：对清理结果中每一条成功回收的 `workerId`，Steward 在同一事务内将 `sh_worker.worktreeStatus` 更新为 `'cleaned'`，向对应 `sh_thread` 写入时间线记录 `已通过机器巡检清理工作树 <workerId>（分支 <branch>）`，并写入 `sh_channel_log` 审计日志 `web_worktrees_cleaned`。
   - **路由安全门禁**：将上述两个新端点同步加入 [`apps/steward/test/routes-audit.test.ts`](../../apps/steward/test/routes-audit.test.ts) 的未认证拦截与 CSRF 校验矩阵。

## 6. Stage 3：Web 控制面「机器与 Worktree 巡检」面板与交互设计

### 6.1 双入口直达（控制面第 5 标签页 + 机器管理弹窗快捷跳转）

1. **控制面新增一级标签页 `worktrees`（机器与 Worktree）**：
   - 在 [`apps/steward/ui/control-plane.js`](../../apps/steward/ui/control-plane.js) 顶栏增加第 5 个标签页（与「记忆」「主动调度」「预算与遥测」「仓库技能」并列），独立模块拆分为 `apps/steward/ui/worktree-audit.js`，保持 `control-plane.js` 职责清晰。
2. **机器管理弹窗联动**：
   - 在 [`apps/steward/ui/workspace.js`](../../apps/steward/ui/workspace.js) 的「机器」弹窗（`#machines-btn`）每张机器卡片底部增加「仓库策略与 Worktree 巡检 →」按钮，点击后自动关闭机器弹窗、打开控制面 `worktrees` 标签页并预选中该 `deviceId` 立即发起只读扫描。

### 6.2 仓库策略展示区与巡检筛选栏

1. **顶部机器切换与扫描工具条**：
   - 机器下拉选择器（标注在线/离线状态与机器级并发槽位 `槽位 running / maxWorkers`）+ 陈旧天数胶囊（`3 天 / 7 天 / 14 天 / 30 天`）+ 「重新扫描」按钮。
   - **顶部四格概览指标卡**：受管 Worktree 总占用体积（如 `4.82 GB`）、安全可一键回收体积（如 `3.10 GB`）、孤立残留条目数、陈旧未合并 / 含脏改动条目数。
2. **仓库级默认策略卡片（即使机器离线亦可读）**：
   - 每个已登记仓库头部清晰展示策略徽章组：
     - 隔离策略：`独立 Worktree 隔离`（`worktree`）或 `主目录原地写`（`in-place` 琥珀色提示）；
     - 并发策略：`并行写（受机器槽位 maxWorkers 约束）`（`parallel`）或 `串行单写队列`（`serial`）；
     - 默认基准分支：`base: main`；
     - 本地授权状态：`Setup Hook` / `Archive Hook`（已审批 / 待审批）与 `pi --approve` 状态；
     - 底部附一行轻量说明：仓库隔离与并发策略遵循本地自主权原则，可在目标机器通过 `otto repo-config` 修改。

### 6.3 分级勾选与高危二次确认门禁（防误删交互闭环）

1. **分类筛选胶囊**：`全部` / `孤立残留` / `陈旧未合并` / `闲置已净` / `活跃绑定`。
2. **安全操作栏（默认路径）**：
   - 提供 **「全选安全可回收项」** 按钮：仅自动选中所有满足 `(category === 'orphaned' || category === 'idle_clean') && !dirty && (ahead === 0 || mergedIntoBase)` 的干净工作树。
   - 当当前已勾选项**全部为安全干净项**时，主按钮显示「清理已选安全项 (N) 并执行 Prune」，点击后展示轻量确认条即可执行删除 + `git worktree prune`。
   - 当某仓库存在 `prunableCount > 0`（目录已消失但 Git 元数据未清理）且未勾选任何目录时，提供独立的「仅执行 `git worktree prune`」快捷按钮。
3. **高危拦截与独立二次确认框（含 `dirty` 或未合入提交时）**：
   - 凡条目带有 `含未提交改动（M 个修改 / U 个未跟踪）` 或 `领先基准分支 K 个未合入提交` 徽章：
     - 卡片左侧显著渲染珊瑚红/琥珀色风险标识；
     - 一旦用户手动勾选了至少 1 个高危条目，底部**常规一键删除按钮立即禁用切换为高危警示按钮「核对并强制清理高危项…」**；
     - 点击后弹出模态二次确认框，**逐行完整列出每个高危工作树的本地绝对路径 `path`、分支名 `branch`、关联事项标题（若有）以及具体改动状态（如 `dirty: 3 个未提交文件 · ahead: 2 个提交未合入 main`）**；
     - Owner 必须手动勾选确认复选框（「我已核对以上完整路径与未提交/未合入改动，确认永久删除这些工作树目录并执行 `git worktree prune`」），「确认强制删除」按钮才会解锁并携带 `force: true, confirmedRisks: true` 提交。

## 7. 分阶段实施路线与验证门禁（Stage 1 → Stage 3）

### Stage 1：协议扩展、`048` 迁移与 Connector 巡检/受控清理引擎
- **改动范围**：[`packages/protocol/src/messages.ts`](../../packages/protocol/src/messages.ts)、[`apps/connector/src/worktree-audit.ts`](../../apps/connector/src/worktree-audit.ts)（新增）、[`apps/connector/src/worker-manager.ts`](../../apps/connector/src/worker-manager.ts)、[`apps/connector/src/client.ts`](../../apps/connector/src/client.ts)、[`apps/connector/src/connector-app.ts`](../../apps/connector/src/connector-app.ts)、[`apps/connector/src/repository.ts`](../../apps/connector/src/repository.ts)、[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)（`048_repo_policy_and_worktree_audit`）、[`apps/steward/src/ledger.ts`](../../apps/steward/src/ledger.ts)。
- **验收门禁**：
  - 新增 `apps/connector/test/worktree-audit.test.ts`：
    1. 验证只读巡检准确识别干净工作树、`dirty`（修改 + 未跟踪文件）、未合入分支（`ahead > 0`）、已合入分支（`mergedIntoBase: true`）、无 `workerId` 的崩溃残留孤儿目录以及 `prunable` 悬空记录，且巡检前后工作区文件与 Git 引用零变化；
    2. 验证用户在 `~/.otto/worktrees/` 之外自建的外部 Git worktree 被标为 `managedByOtto: false`，且任何尝试删除外部路径、主仓库根目录 `repo.path` 或符号链接逃逸路径的 `worktree_cleanup` 请求均被 `forbidden_path` 拦截；
    3. 验证运行中 Worker 的工作树在 `force: true` 下仍被 `worker_active` 拒绝；`dirty` 或未合入工作树在未传 `force: true, confirmedRisks: true` 时被实时复核拦截（覆盖扫描后新增脏改动的 TOCTOU 场景）；
    4. 验证目录体积统计在超出条目预算时平稳截断并返回 `diskComplete: false`。

### Stage 2：Steward 交叉对账分类器与巡检/清理 HTTP 接口
- **改动范围**：新增 `apps/steward/src/worktree-audit.ts`、[`apps/steward/src/connector-protocol.ts`](../../apps/steward/src/connector-protocol.ts)、[`apps/steward/src/workspace.ts`](../../apps/steward/src/workspace.ts)、[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts)、[`apps/steward/src/steward.ts`](../../apps/steward/src/steward.ts)。
- **验收门禁**：
  - 新增 `apps/steward/test/worktree-audit.test.ts` 并更新 [`apps/steward/test/routes-audit.test.ts`](../../apps/steward/test/routes-audit.test.ts)：
    1. 验证 `active` / `orphaned`（含已归档 Thread、不存在的 Thread、无 `workerId` 孤儿目录）/ `stale_unmerged`（按 `staleDays` 阈值判定）/ `idle_clean` / `external_unmanaged` 五类交叉对账准确性；
    2. 验证机器离线时 `GET /app/api/workspace` 依然输出缓存的 `repoPolicies`（`writeIsolation`、`writeConcurrency`、`defaultBranch`），而 `GET /app/api/machines/:deviceId/worktrees/audit` 返回 `409 machine_offline`；
    3. 验证 `POST /app/api/machines/:deviceId/worktrees/cleanup` 的 CSRF / `Origin` 防护、`sh_web_request` 相同请求 ID 幂等重放、清理成功后 `sh_worker.worktreeStatus = 'cleaned'` 状态同步及 Thread 时间线审计写入。

### Stage 3：Web 控制面「机器与 Worktree 巡检」面板与双语门禁
- **改动范围**：新增 `apps/steward/ui/worktree-audit.js`、[`apps/steward/ui/control-plane.js`](../../apps/steward/ui/control-plane.js)、[`apps/steward/ui/workspace.js`](../../apps/steward/ui/workspace.js)、[`apps/steward/ui/workspace.css`](../../apps/steward/ui/workspace.css)、[`apps/steward/ui/i18n.js`](../../apps/steward/ui/i18n.js)、[`apps/steward/test/ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts)。
- **验收门禁**：
  - 将 `worktree-audit.js` 纳入 [`ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts) 的 `SCRIPTS` 安全扫描（零 `innerHTML`、零内联 `style=`、单行单引号相对导入、i18n 键名不含数字 `0-9`）及中英双语词条对称测试。
  - 为前端纯函数（安全项过滤逻辑、高危项判定与二次确认门禁解锁条件、字节体积格式化含 `≥` 非完整估算前缀）编写确定性单测。
  - 全仓跑通类型检查、构建与Connector + Steward 全部测试套件。
