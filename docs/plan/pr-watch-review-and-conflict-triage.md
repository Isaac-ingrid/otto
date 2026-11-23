# PR 盯盘只读评审意见与合并冲突感知闭环设计方案（Direction B）

状态：已落地（Stage 1–3 全部完成，2026-11-20）
前置依赖：[ADR-0019（PR 盯盘变更需绑定确认）](../adr/0019-pr-watch-owner-confirmation.md)、[受控改进设计方案](../design/otto-improvement.md)、[PR 盯盘说明](../pr-watches.md)、[Direction A（PR 盯盘只读 CI 失败日志诊断）](./pr-watch-ci-failure-diagnosis.md)

实施顺序：**Stage 1（`pr-evidence.ts` 有界只读合并状态、Review 状态机与行级评论采集 + `045` 迁移） → Stage 2（`pr-watch.ts` 双目标生命周期、游标去重通知、无工具评审提炼与统一诊断接口升级） → Stage 3（工作台统一 PR 阻塞诊断抽屉、评审/冲突卡片徽章与「填入输入框修订/解冲突」闭环 + 全套回归门禁）**。

## 1. 背景与真实痛点

[Direction A](./pr-watch-ci-failure-diagnosis.md) 打通了「CI 变红 ➔ 只读拉取失败步骤与日志 ➔ 无工具根因提炼 ➔ 一键填入输入框修复」闭环，但在真实 PR 研发生命周期中，除了 CI 红灯外还有两类高频卡点目前处于盲区：

1. **合并冲突导致的静默卡死或虚假完成**：
   - 当主干分支（如 `main`）前进导致当前 PR 出现合并冲突（`mergeable === false` / `mergeable_state === "dirty"`）时，GitHub 无法构造合成合并提交 `refs/pull/{n}/merge`，**所有 `on: pull_request` 的 GitHub Actions 工作流根本不会触发**。此时 `checks === 0`，现有 `pr_watch` 会一直静默停留在 `waiting` 直至 24 小时过期，期间完全不会告知用户「PR 已经冲突了」。
   - 反之，若仓库仅配置了 `on: push` 检查且已跑绿，现有 `pr_watch` 会在 PR 处于严重合并冲突、根本无法合入的情况下直接报「CI 通过」并自动结束（`completed`）。
2. **代码评审（Code Review）要求修改与行级意见无感知**：
   - 同事或受信任的代码审查机器人（如 Copilot Reviewer、CodeRabbit 等）在 PR 上提交 `CHANGES_REQUESTED` 或留下关键的 `path:line` 行级评审评论（Review Comments）后，现有盯盘既不会提醒，也无法像 CI 失败那样把具体文件行号、上下文 `diff_hunk` 与修改意见一键组装进事项输入框交由本地 Worker 修订。
3. **CI 先绿、Review 后到的生命周期错位**：
   - 日常协作中 CI 通常在 1～3 分钟内跑绿，而人工或深度评审往往在 10～60 分钟后才到达，主干合并冲突更可能发生在数小时后。若所有盯盘都在首次观测到 CI 变绿的瞬间立即终止（`status = 'completed'`），后续到达的 `CHANGES_REQUESTED` 与主干冲突就永远不会被捕获。

## 2. 现状盘点与复用的底层机制

| 模块 | 现有实现 | 本方案复用与演进点 | 代码位置 |
| :--- | :--- | :--- | :--- |
| PR 元数据读取 | `readPrEvidence` 前后双读 `GET /repos/{owner}/{repo}/pulls/{n}`，目前仅提取 `head.sha`、`state`、`merged` | **零额外请求**直接从同一 `/pulls/{n}` 响应提取 `base.ref`、`base.sha`、`head.ref`、`mergeable`（`boolean \| null`）与 `mergeable_state` | [`apps/steward/src/pr-evidence.ts`](../../apps/steward/src/pr-evidence.ts) |
| 只读令牌权限面 | `OTTO_GITHUB_READ_TOKEN` 最小权限已包含 `Pull requests: Read`（连 `statuses-only` 模式也必配该权限） | `GET /pulls/{n}/reviews` 与 `GET /pulls/{n}/comments` 均仅需 **`Pull requests: Read`** 权限（公开仓免令牌可读），无需新增任何 GitHub 写权限或额外令牌配置 | [`docs/pr-watches.md`](../pr-watches.md) |
| 旁路无工具沙盒 | Direction A 已建立 `Steward.completeBackgroundText` + 平衡 JSON 解析 + 0-Token 确定性兜底 | 复用同一无工具沙盒通道提炼多条行级评审意见的修改要点，物理隔绝 PR 评论中的恶意 Prompt Injection | [`apps/steward/src/pr-failure-diagnoser.ts`](../../apps/steward/src/pr-failure-diagnoser.ts)、[`apps/steward/src/steward.ts`](../../apps/steward/src/steward.ts) |
| 工作台诊断弹窗 | Direction A 已上线 [`pr-diagnosis.js`](../../apps/steward/ui/pr-diagnosis.js) 与 `POST /app/api/pr-watches/:watchId/diagnosis` | 原地升级为统一的 **PR 阻塞与评审诊断面板**（按需分节展示「合并冲突」「评审意见」「CI 失败日志」），避免拆出第二个碎片化弹窗 | [`apps/steward/ui/pr-diagnosis.js`](../../apps/steward/ui/pr-diagnosis.js)、[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts) |

## 3. 核心安全边界与设计不变量

PR 评审正文与行级评论比 CI 日志暴露面更广——**在公开仓库中，互联网上任何陌生账号都能在 PR 下发表评论**。因此本方案必须死守以下 6 条硬边界：

1. **受信任作者门禁，严防公开仓路人评论投毒与刷通知（Trusted Author Association Gate）**：
   - GitHub REST 接口在每条 Review 与 Review Comment 上均返回 `author_association` 与 `user.type`。
   - **硬性准入规则**：仅当评论者属于**仓库受信任协作者**（`author_association` 为 `OWNER`、`MEMBER` 或 `COLLABORATOR`）或**已安装的受信任审查 Bot**（`user.type === "Bot"`，如 `copilot-pull-request-reviewer[bot]`、`coderabbitai[bot]` 等，且排除 PR 作者本人自评）时，其评审状态与行级意见才允许进入快照存储、触发通知或送入旁路摘要。
   - 外部路人账号（`NONE`、`FIRST_TIMER`、`FIRST_TIME_CONTRIBUTOR` 及无协作者权限的 `CONTRIBUTOR`）留下的评论在读取边界**直接丢弃正文**（仅记录整数计数 `ignoredUntrustedCount` 供面板诚实披露），杜绝公开仓恶意刷屏耗尽模型每日预算或注入诱导指令。
2. **物理级零工具隔离（Zero-Tool Sandboxed Triage）**：
   - PR 评论正文、`diff_hunk` 代码上下文与分支名一律视为**不可信外部数据**，绝不拼入 `sh_wake` 或送入挂载了工具的 Steward 主会话（`PiHarness`）。
   - 评审要点归纳仅通过零工具 `completeBackgroundText` 在 `<untrusted_pr_feedback>` 隔离标签内完成，输出经严格字段校验、`sanitizeUntrustedCiText` 密钥脱敏与 `escapeMarkers`（转义 `⟦...⟧`）后方可落库；预算超限（`over_budget`）或无模型时直接输出 0-Token 确定性条目列表。
3. **GitHub 异步 `mergeable` 三态诚实语义（严禁把 `null` 误报为冲突或无冲突）**：
   - GitHub 官方协议中，PR 刚推送或久未访问时，首次 `GET /pulls/{n}` 的 `mergeable` 字段会返回 `null`（`mergeable_state: "unknown"`），由 GitHub 后台异步计算合并树。
   - **三态铁律**：
     - `mergeable === false`（或 `mergeable_state === "dirty"`）➔ 确认为 **`conflicted`**（存在合并冲突）；
     - `mergeable === true` ➔ 确认为 **`mergeable`**（当前与基准分支无代码合并冲突）；
     - `mergeable === null` ➔ 严格保持 **`unknown`**（计算中），绝不误报冲突通知，也绝不宣称无冲突。
   - **不编造冲突文件名**：GitHub REST `/pulls/{n}` 不返回具体冲突文件清单；服务端与通知必须如实表述「分支 `<head.ref>` 与基准分支 `<base.ref>` 存在合并冲突」，并在预填提示词中引导本地 Worker 在隔离工作树内执行 `git fetch origin <base.ref>` 实地核查冲突文件，严禁模型猜测文件名。
4. **精准的审阅人状态机与「按游标去重、推新提交不翻旧账」原则**：
   - **审阅人状态折叠**：按 GitHub 官方规则，每位审阅人（按 `user.id` 归并）的当前有效态度取其**最后一条决定性 Review**（`APPROVED`、`CHANGES_REQUESTED`、`DISMISSED`）；中途补充的纯评论（`COMMENTED`）**不会清除**该审阅人先前的 `CHANGES_REQUESTED`，未提交草稿（`PENDING`）直接忽略。
   - **游标级通知去重（防推修复提交后重复报警）**：
     - 若某条 `CHANGES_REQUESTED`（例如 `reviewId = 501`）针对旧提交 `head A` 发出，系统以 **`pr-watch:<watchId>:review:<reviewCursor>`** 去重通知一次；
     - 当开发者推送新提交 `head B` 修复该意见时，在审阅人尚未重新提交新 Review（`reviewId <= 501`）前，**绝不在 `head B` 上把旧的 `reviewId = 501` 当成新报错再炸一次通知**，仅在状态摘要中温和标注 `等待 @reviewer 复审（上次要求修改针对旧提交 <shortSha>）`；只有当审阅人产生更新的 `CHANGES_REQUESTED` 或新的受信任行级评审线程（游标前进）时才发送新通知。
     - 合并冲突通知则按 **`pr-watch:<watchId>:<head>:conflict:<baseSha12>`** 去重：同一 `(head, baseSha)` 只报一次冲突；若后续 `base` 分支更新把原本干净的 `head` 撞出冲突，则会准确触发一次冲突提醒。
5. **双阶段确认与既有默认契约 100% 兼容（Dual `watchGoal` Mode）**：
   - 引入显式跟进目标枚举 `watchGoal: "ci_pass" | "merged"`，默认值为 **`"ci_pass"`**：
     - **`"ci_pass"`（默认，100% 兼容现有全部单测与路由评测）**：以「当前提交 CI 通过且无现行合并冲突或当前提交上的 `CHANGES_REQUESTED`」为完成条件；一旦满足即置 `completed`，若遇冲突或当前提交被要求修改则保持 `active` 并告警。**不强制改动 `create_pr_watch` 既有必填参数与默认语义**，确保 `routing-eval` 零波动。
     - **`"merged"`（全周期盯盘，按需显式开启）**：当用户在自然语言中明确要求「盯到合并 / 持续关注 Review 意见或冲突」（或通过 Owner API 显式传 `watchGoal: "merged"`）时启用；遵循 [ADR-0019](../adr/0019-pr-watch-owner-confirmation.md) 在专用确认卡上明确写出 **`结束条件：PR 合并或关闭（CI 通过后继续跟进评审与合并冲突）`**。在此模式下，CI 变绿仅发送一次该 `head` 的绿灯通知，盯盘继续保持 `active` 守候后续到达的 Review 意见或主干冲突，直至 PR `merged` / `closed` / 到期 / 手动取消。
6. **零自动写操作（Explicit Composer Prefill Only）**：
   - 严禁自动 `git rebase` / `git merge`、严禁自动 `git push --force`、严禁自动调用 GitHub API 回复或 Resolve 评论、严禁自动派发写 Worker。所有修订与解冲突一律通过「一键填入事项输入框，由本人过目后回车派发」执行。

### 明确不做（排除项）
- **不引入 GitHub GraphQL API**：GraphQL 需要额外的查询复杂度防线且与现有 REST 取证栈异构；通过 REST `/pulls/{n}/reviews` + `/pulls/{n}/comments`（利用 `line !== null` 识别当前有效行级评论、`line === null` 识别已被新提交改写过期的评论）即可在纯只读 `GET` 下高质量覆盖。
- **不跨页全量拉取超大型 PR 的上千条历史评论**：`reviews` 单页取最新/前 `100` 条，`comments` 按创建时间倒序取最新 `50` 条；若触及分页上限（返回满额），快照显式置 `truncated: true` 诚实告知，绝不循环翻页拖垮租约。
- **不替代 GitHub 分支保护规则裁定（Branch Protection Evaluation）**：不查询需要管理权限的 `/branches/{branch}/protection` 接口，不宣称「满足合并权限要求」。

## 4. 模块一：只读合并状态与评审证据采集层（Stage 1）

### 4.1 `readPrEvidence` 轻量扩展（[`apps/steward/src/pr-evidence.ts`](../../apps/steward/src/pr-evidence.ts)）

1. **零额外请求提取合并元数据**：
   - 在 `pullOf` 解析 `/pulls/{n}` 响应时，向后兼容地提取可选字段（测试桩未提供时安全回退默认值，保证既有 12 项 `pr-evidence.test.ts` 与 16 项 `pr-watch.test.ts` 原样通过）：
     - `baseRef: string | null`（清洗分支名，限 120 字符）
     - `baseSha: string | null`（校验 40 位十六进制）
     - `headRef: string | null`
     - `mergeState: "mergeable" | "conflicted" | "unknown"`：当 `raw.mergeable === false || raw.mergeable_state === "dirty"` 时为 `"conflicted"`；当 `raw.mergeable === true` 时为 `"mergeable"`；其余（含未提供或 `null`）一律为 `"unknown"`。
2. **有界评审摘要读取器 `readPrReviewAndConflictDetail`**：
   - 发起最多 2 个固定源只读请求（共享 `10s` 超时、`redirect: "error"`、`2 MiB` 流上限）：
     1. `GET /repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100`
     2. `GET /repos/{owner}/{repo}/pulls/{number}/comments?sort=created&direction=desc&per_page=50`
   - **过滤、折叠与裁剪规则**：
     - 过滤掉非受信任作者（保留 `OWNER | MEMBER | COLLABORATOR` 及非作者本人的 `Bot`），统计被过滤条数写入 `ignoredUntrustedCount`；
     - 计算每位受信任审阅人的最新决定性状态，汇总为 `reviewDecision: "changes_requested" | "approved" | "commented" | "none"`，并区分 `changesRequestedOnCurrentHead: boolean`（是否有针对当前 `head` 的未解除 `CHANGES_REQUESTED`）与 `staleChangesRequestedReviewers: string[]`（针对旧 `head` 要求过修改、待复审的审阅人登录名）；
     - 将 `/pulls/{n}/comments` 按根评论 ID（`in_reply_to_id ?? id`）聚合成评审讨论串（Review Threads），仅保留 **`line !== null`**（在当前最新 diff 上仍然有效、未被后续代码改写失效）的讨论串，按最新活跃时间取前 **8 串**；
     - 每串提取脱敏后的 `{ rootCommentId, author, authorAssociation, path, line, diffHunkTail, body, replyCount, latestReplyBody, htmlUrl, commitId }`（其中 `diffHunkTail` 仅保留最后 6 行代码上下文，单串正文上限 `400` 字符，整份快照硬上限 **`16 KiB`**）；
     - 计算单调递增的确定性游标 `reviewCursor = "${maxChangesRequestedReviewId}:${maxTrustedLiveCommentId}"` 供通知去重与缓存复用。

### 4.2 数据结构与 `045_pr_watch_review_and_conflict` 迁移（[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)）

```sql
ALTER TABLE sh_pr_watch ADD COLUMN watchGoal TEXT NOT NULL DEFAULT 'ci_pass';

CREATE TABLE IF NOT EXISTS sh_pr_watch_feedback (
  watchId TEXT PRIMARY KEY,
  head TEXT NOT NULL,
  baseRef TEXT,
  baseSha TEXT,
  headRef TEXT,
  mergeState TEXT NOT NULL DEFAULT 'unknown',
  -- 'mergeable' | 'conflicted' | 'unknown'
  reviewDecision TEXT NOT NULL DEFAULT 'none',
  -- 'changes_requested' | 'approved' | 'commented' | 'none'
  reviewCursor TEXT NOT NULL DEFAULT '0:0',
  snapshotJson TEXT NOT NULL,
  triageJson TEXT,
  triageStatus TEXT NOT NULL DEFAULT 'none',
  -- 'ready' | 'skipped_over_budget' | 'skipped_no_model' | 'failed' | 'none'
  updatedAt INTEGER NOT NULL
);
```

- 保持 `044` 的 `sh_pr_watch_diagnosis (watchId, head)` 专职存储按提交归档的 CI 失败快照，新增的 `sh_pr_watch_feedback (watchId)` 专职存储 PR 级最新合并状态与评审快照，职责正交、互不覆盖。

## 5. 模块二：双目标状态机、游标去重通知与统一诊断 API（Stage 2）

### 5.1 `PrWatchService` 状态机与轮询节流策略（[`apps/steward/src/pr-watch.ts`](../../apps/steward/src/pr-watch.ts)）

1. **何时拉取评审详情（避免无意义消耗 GitHub API 配额）**：
   - 合并状态 `mergeState` 随每次常规轮询的 `/pulls/{n}` 免费获得（0 额外请求）；
   - 仅在以下任一条件满足且定义了可选依赖 `readFeedbackDetail` 时，在租约事务外拉取一次 `/reviews` + `/comments`：
     - 当前观测将要判定 `evidence.state === "success"`（在宣告完成前核验是否存在未解除的 `CHANGES_REQUESTED` 或新评审意见）；
     - `watch.watchGoal === "merged"`（全周期盯盘模式下每轮常规检查同步巡检最新评审动态）；
     - 用户在工作台显式点开诊断抽屉且请求刷新评审状态。
2. **完成条件（`terminal`）收敛真值表**：

| PR 主状态 (`evidence.state`) | 合并状态 (`mergeState`) | 评审状态 (`reviewDecision`) | `watchGoal = "ci_pass"`（默认） | `watchGoal = "merged"`（全周期） |
| :--- | :--- | :--- | :--- | :--- |
| `merged` / `closed` | 任意 | 任意 | **`completed`**（通知合并/关闭） | **`completed`**（通知合并/关闭） |
| `failure` | 任意 | 任意 | `active`（发 CI 失败通知；若同时冲突则在通知中并列提示冲突） | `active`（同左） |
| `waiting` | **`conflicted`** | 任意 | `active`（**打破静默**：按 `(head, baseSha)` 去重发送合并冲突告警，提示冲突可能阻断 PR 工作流启动） | `active`（同左） |
| `waiting` | `mergeable` / `unknown` | 存在未通知的 `changes_requested` | `active`（按 `reviewCursor` 去重发送评审修改要求通知） | `active`（同左） |
| `success` | **`conflicted`** | 任意 | **`active`（阻断提前完成）**：发送冲突阻塞通知，等待解冲突推新 `head` | `active`（发送 CI 通过但存在合并冲突通知） |
| `success` | 非冲突 | 当前 `head` 有 `changes_requested` | **`active`（阻断提前完成）**：按 `reviewCursor` 发送评审要求修改通知 | `active`（同左） |
| `success` | 非冲突 | 无当前 `head` 的 `changes_requested` | **`completed`**（发 CI 通过通知；若有旧 `head` 待复审审阅人则附一行提示） | **`active`（保持跟进）**：按 `head` 去重发一次 CI 通过通知，继续守候后续评审或主干冲突 |

3. **旁路无工具评审提炼与修复提示词拼装（[`pr-failure-diagnoser.ts`](../../apps/steward/src/pr-failure-diagnoser.ts) 扩展）**：
   - 当 `reviewCursor` 较上次落库值前进且存在有效评审意见（`CHANGES_REQUESTED` 或受信任行级评论）时，调用一次零工具 `diagnosePrFeedbackWithLlm` 生成结构化摘要 `{ headline, actionItems: string[], suggestedRevisionBrief }`（同 `reviewCursor` 后续轮询直接复用缓存，0 重复 Token）；
   - 新增统一提示词构造器 `buildPrActionPrompt({ url, head, ciFailure, feedback })`：
     - **仅合并冲突**：生成拉取 `origin/<baseRef>`、在本地隔离工作树合并/变基解冲突、跑通本地测试并汇报冲突文件处理方案（严禁未经确认 `git push` 或 `--force`）的指令；
     - **仅评审意见**：逐条列出审阅人要求的修改点、`path:line` 位置与原话摘录，要求本地评估修订、跑通测试后汇报（严禁未经确认推送或回复 GitHub）；
     - **复合阻塞（如 CI 红灯 + 合并冲突 / 评审意见并存）**：自动合成一份结构清晰的综合修复指令，一次性填入事项输入框。

### 5.2 接口与工具层轻量投影

1. **升级 `POST /app/api/pr-watches/:watchId/diagnosis`**（[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts)）：
   - 在保持原有返回字段（`snapshot`、`diagnosis`、`effectiveDiagnosis`、`repairPrompt`）100% 向后兼容的基础上，新增返回 `feedback: { mergeState, baseRef, baseSha, headRef, reviewDecision, snapshot, effectiveTriage } | null` 与合成后的统一 `actionPrompt: string | null`（当无 CI 失败但有冲突/评审意见时，`repairPrompt` 同步回填 `actionPrompt`）。
2. **挂起计划、控制面与 Steward 只读工具感知**：
   - 在 [`ledger.ts`](../../apps/steward/src/ledger.ts) `views.workspace()`、[`control-plane.ts`](../../apps/steward/src/control-plane.ts) `readSchedulesControlPlane` 与 [`llm/extension.ts`](../../apps/steward/src/llm/extension.ts)（`get_thread` / `list_pr_watches`）中，除现有 `hasFailureDetail` / `failureHeadline` 外，左连接 `sh_pr_watch_feedback` 附带轻量字段：
     - `watchGoal: "ci_pass" | "merged"`
     - `mergeState: "mergeable" | "conflicted" | "unknown"`
     - `reviewDecision: "changes_requested" | "approved" | "commented" | "none"`
     - `hasActionableFeedback: boolean`（当 CI 失败、合并冲突或存在有效受信任评审意见任一成立时为 `true`）
     - `attentionHeadline: string | null`（按优先级选取：合并冲突 > CI 失败标题 > 评审要求修改标题 > 行级评审意见数摘要）
   - 用户在对话中直接问「这个 PR 现在还有冲突或者未处理的 review 吗？」，总管无需派 Worker 即可秒答审阅人态度、涉及文件行号与合并状态。

## 6. 模块三：Web Workspace 统一阻塞诊断面板与一键预填交互（Stage 3）

继续严格遵守 [`dom.js`](../../apps/steward/ui/dom.js) 纯文本节点 `h()` 规范（零 `innerHTML`、零内联 `style=`、中英双语词条与占位符 100% 对称）：

1. **卡片状态徽章与操作文案自适应（[`workspace.js`](../../apps/steward/ui/workspace.js) & [`control-plane.js`](../../apps/steward/ui/control-plane.js)）**：
   - 在事项右侧「挂起计划」与控制面「PR 盯盘」卡片上：
     - 若 `watchGoal === "merged"`，显示 `盯至合并` 徽章；
     - 若 `mergeState === "conflicted"`，显示醒目琥珀红 `合并冲突` 徽章；若 `reviewDecision === "changes_requested"`，显示 `要求修改` 徽章；若 `reviewDecision === "approved"`，显示绿色 `已批准` 徽章；
     - 当 `hasActionableFeedback === true`（即使 CI 全绿，但存在合并冲突或评审意见）时，展示摘要横幅并开放 **`查看阻塞详情`**（纯 CI 失败时仍显示 `查看失败日志`）与 **`填入输入框处理`** 快捷按钮。
2. **统一诊断弹窗分节渲染（[`apps/steward/ui/pr-diagnosis.js`](../../apps/steward/ui/pr-diagnosis.js)）**：
   - **分节一：合并冲突警示卡（当 `mergeState === "conflicted"` 时置顶展示）**：
     - 展示 `<headRef> ➔ <baseRef>` 分支冲突说明与解冲突安全边界提示（不在云端猜测冲突文件名，交由本地隔离工作树精确检出）。
   - **分节二：代码评审意见区（当存在受信任 Review 或有效行级讨论串时展示）**：
     - 顶部展示审阅结论徽章（`要求修改` / `评审评论` / `已批准`）、待复审审阅人提示，以及旁路提炼的 `1～3` 条核心修订要点；若存在被过滤的非协作者路人评论，诚实显示灰色小字 `已忽略 N 条非仓库协作者评论`；
     - 下方逐条渲染有效行级评审卡片：审阅人账号与身份徽章（如 `@alice · MEMBER`）、`path:line` 代码定位、等宽 `diffHunkTail` 代码上下文片段、评论正文与最新回复，以及跳转原评论的外部链接。
   - **分节三：CI 失败日志诊断区（保留 Direction A 完整能力）**：
     - 当该提交存在 CI 失败快照时并列展示失败步骤、编译器注解与尾部日志。
   - **底部统一行动栏**：
     - 主按钮根据当前阻塞类型自适应文案（`填入输入框解决冲突` / `填入输入框派发修订` / `填入输入框综合修复`），点击后自动关闭弹窗、定位到所属事项并将合成好的指令填入底部输入框聚焦，等待用户确认回车。

## 7. 分阶段实施路线与验证门禁（Stage 1 → Stage 3）

| 阶段 | 交付范围 | 验证门禁 |
| :--- | :--- | :--- |
| **Stage 1：只读合并/评审证据采集与 `045` 迁移** | `pr-evidence.ts` 扩展 `/pulls/{n}` 合并三态解析，新增 `readPrReviewAndConflictDetail`（含受信任 `author_association` 过滤、审阅人决定性状态折叠、`line !== null` 有效行级评论聚合、分页截断标记与 `16 KiB` 裁剪）；`schema.ts` 新增 `045_pr_watch_review_and_conflict` | 专项单测覆盖：`mergeable: null` 保持 `unknown` 不误报、`mergeable: false` 识别冲突、路人 `NONE` 评论零落库防投毒、`COMMENTED` 不覆盖先前的 `CHANGES_REQUESTED`、`line: null` 过期行级评论自动剔除、密钥与 `⟦...⟧` 转义清洗 |
| **Stage 2：双目标状态机、游标去重与诊断接口升级** | `pr-watch.ts` 支持 `watchGoal`（`"ci_pass"` 默认 / `"merged"` 全周期）、冲突打破 `waiting` 静默、按 `reviewCursor` 与 `(head, baseSha)` 精准去重防推修复后翻旧账；`pr-watch-approval.ts` 支持 `watchGoal` 确认卡绑定；扩展 `pr-failure-diagnoser.ts` 与 `POST /app/api/pr-watches/:id/diagnosis` | 既有全部 `pr-watch*.test.ts` 与路由自检 100% 零回归；新增集成测试覆盖：`waiting + conflicted` 破静默告警、推新 `head` 后旧 `CHANGES_REQUESTED` 不重复炸通知、`watchGoal = "merged"` 在 CI 变绿后继续保持 `active` 并捕获后续新评审意见、`over_budget` 零模型兜底 |
| **Stage 3：统一阻塞诊断弹窗与修订/解冲突预填闭环** | 升级 `pr-diagnosis.js`、`workspace.js`、`control-plane.js`、`i18n.js` 与 `workspace.css`，支持冲突警示卡、行级 `diff_hunk` 评审卡片、复合提示词预填与双语对称文案 | `ui-modules.test.ts` 全绿（零 HTML 注入、零内联样式、双语词条与占位符 100% 对称），`tsc --noEmit`、`tsconfig.node-host.json` 与 `build-node.mjs` 构建全绿 |
