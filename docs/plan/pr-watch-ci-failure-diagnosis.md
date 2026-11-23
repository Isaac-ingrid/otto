# PR 盯盘只读 CI 失败日志采集与根因诊断闭环设计方案

状态：已落地（Stage 1–3 全部完成，2026-11-20）
前置依赖：[ADR-0019（PR 盯盘变更需绑定确认）](../adr/0019-pr-watch-owner-confirmation.md)、[受控改进设计方案](../design/otto-improvement.md)、[PR 盯盘说明](../pr-watches.md)、[Direction 2A 控制面](./memory-and-proactive-control-plane.md)、[三态显式停止与就地中断](./three-way-stop-and-inline-interrupt.md)

实施顺序：**Stage 1（`pr-evidence.ts` 有界只读失败证据与安全日志抓取 + `044` 诊断表迁移） → Stage 2（`pr-watch.ts` 旁路无工具根因诊断、超额确定性降级与只读查询 API） → Stage 3（工作台失败详情弹窗、控制面/事项面板诊断入口与「填入输入框派发修复」闭环 + 端到端回归测试）**。

## 1. 背景与真实痛点

在 [受控改进设计方案](../design/otto-improvement.md) 与 [PR 盯盘说明](../pr-watches.md) 中，`pr_watch` 第一阶段跑通了持续只读轮询闭环，但明确留下了下一阶段的核心缺口：

> *"It follows a PR, summarizes failed/pending counts, notifies on a relevant change, and never modifies code. It does not yet read logs or perform model-assisted failure diagnosis... The broader target remains: follow a PR; analyze CI failure read-only; notify on a relevant change; never modify code without permission."*

在日常研发闭环中，当前行为存在 3 处明显断点：

1. **报错通知只有计数，定位根因仍需手动跨端翻日志**：
   - 当 GitHub CI 变红时，[`PrWatchService`](../../apps/steward/src/pr-watch.ts) 当前仅推送 `CI 检查失败：N 项失败、M 项等待，继续只读跟进`。用户在手机或工作台收到提醒后，仍需点开 GitHub 页面、逐层点进失败 Job、在几千行构建输出里翻找是哪条单测挂了、哪处类型报错还是镜像拉取超时。
2. **控制面与事项面板看不见具体挂在哪一步**：
   - [`control-plane.js`](../../apps/steward/ui/control-plane.js) 与事项右侧「挂起计划」中的 PR 盯盘卡片只展示 `检查 X · 失败 Y · 进行中 Z`，不展示失败的 Check 名称、失败 Step、编译器/测试框架注解（Annotations）或关键报错尾部日志。
3. **从「发现 CI 变红」到「让本地 Agent 修好」缺少安全顺手的衔接**：
   - 用户看完报错后，还得手动复制报错片段、切回对应 Thread 粘贴描述再派活；系统需要在**严格遵守「绝不自动改代码、绝不自动派发写任务、绝不重跑 CI」红线**的前提下，提供像断点面板那样的「一键将结构化失败上下文填入当前事项输入框，由本人过目后回车派发修复」能力。

## 2. 现状盘点与复用的底层机制

| 模块 | 现有实现 | 本方案复用与演进点 | 代码位置 |
| :--- | :--- | :--- | :--- |
| GitHub 状态取证器 | 固定请求 `https://api.github.com`、仅 `GET`、`redirect: "error"`、`20s` 总超时、`2 MiB` 响应体上限、前后双读 `/pulls/{n}` 校验 `head.sha` 未漂移 | 保持主状态判定 `readPrEvidence` 100% 纯净不变；新增独立的 `readPrFailureDetail` 仅在首次观测到新 `(watchId, head)` 进入 `failure` 时按三层证据阶梯有界采集 | [`apps/steward/src/pr-evidence.ts`](../../apps/steward/src/pr-evidence.ts) |
| PR 盯盘调度服务 | 单分钟幂等 Cron、每次最多处理 2 条到期 Watch、`120s` 租约 + `generation` 乐观锁、`pr-watch:<id>:<head>:<kind>` 稳定通知去重 | 在租约内串行追加有界失败详情采集与旁路无工具诊断，提交事务前复核 `status === 'active'` 与 `generation` 一致，确保中途取消或过期立即丢弃晚到结果 | [`apps/steward/src/pr-watch.ts`](../../apps/steward/src/pr-watch.ts) |
| 旁路无工具 LLM 调用 | `Steward.completeBackgroundText` 已封装基于 `completeSimple` 的纯文本单轮调用，零工具挂载、计入 `sh_usage_day` 每日额度，并兼容 `openai-compatible` 网关 | 直接复用该无工具通道运行结构化根因提炼（模仿 [`distiller.ts`](../../apps/steward/src/distiller.ts) 的 `<think>` 剥离与平衡 JSON 解析），物理隔绝外部日志触发任何工具的可能 | [`apps/steward/src/steward.ts`](../../apps/steward/src/steward.ts)、[`apps/steward/src/distiller.ts`](../../apps/steward/src/distiller.ts) |
| 数据库迁移体系 | 当前最新迁移为 `043_ambient_memory_and_skill_loop` | 新增幂等迁移 `044_pr_watch_failure_diagnostics` 建独立表 `sh_pr_watch_diagnosis (watchId, head)`，**不改动 `sh_pr_watch` 原有列结构**，确保既有 5 套 PR Watch 测试深等断言零回归 | [`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts) |

## 3. 核心安全边界与设计不变量

CI 报错文本、Check 摘要、Job 步骤名与测试输出均属于**完全不可信的外部输入**（PR 分支代码、第三方测试夹具或依赖包均可向控制台打印任意提示词注入文本或伪造系统标记）。本方案必须死守以下 6 条硬边界：

1. **物理级零工具隔离（Zero-Tool Sandboxed Diagnosis）**：
   - 外部 CI 日志与注解**绝不作为 `sh_wake` 送入挂载了 `start_worker` / `notes_commit` 等工具的 Steward 根会话（`PiHarness`）**。
   - L2 根因诊断仅允许通过无任何工具定义的 `completeSimple` 单次调用完成，输出经严格 Zod Schema 校验与长度截断；即使日志内含恶意 Prompt Injection，模型在物理上也没有任何工具可调、无法写记忆、无法派发任务。
2. **绝不自动修改代码、绝不自动派发 Worker、绝不写 GitHub**：
   - 盯盘发现失败只做「只读采集 + 只读诊断 + 通知汇报」。
   - 「派发修复」一律采用**显式填入当前事项输入框（Composer Prefill）**机制：点击按钮仅将结构化修复提示词填入输入框并聚焦，用户亲眼核对内容后自行按回车走正常 `user:` 轮次派发，杜绝任何后台静默写操作。
3. **GitHub API 重定向与凭据零泄漏防线（Cross-Origin Token Strip）**：
   - 所有元数据请求（`check-runs`、`annotations`、`actions/jobs/{id}`）严格锁定 `https://api.github.com` 且 `redirect: "error"`。
   - 唯独 GitHub Actions 原始日志端点 `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` 按官方协议返回 `302` 签名地址：必须以 **`redirect: "manual"`** 请求 `api.github.com`，校验 `Location` 必须为 `https:` 且主机名严格命中 GitHub 官方日志存储白名单（`*.actions.githubusercontent.com` 或 `*.blob.core.windows.net`），随后发起的第二次 `GET` **彻底剥离 `Authorization` 与 `Cookie` 请求头**并设 `redirect: "error"`，确保 `OTTO_GITHUB_READ_TOKEN` 在任何情况下绝不发往非 `api.github.com` 域名。
4. **权限诚实披露，严禁静默降级伪装（Honest Coverage Disclosure）**：
   - `statuses-only` 盯盘绝不请求 `/check-runs` 或 `/actions/jobs`，仅提取失败的 `commit status` 描述与 `target_url`。
   - `checks-and-statuses` 盯盘若令牌无 `Actions: read` 权限（日志端点返回 `403` / `404`）或失败项来自第三方 CI（如 Vercel / Buildkite），**绝不影响主状态 `failure` 的判定与通知**，如实基于 Check Run `output` 与 `annotations` 生成快照，并显式标记 `logSource = "checks_only"`（注明未读取完整 Actions 原始日志）。
5. **采集频次、内存流式截断与租约预算受控**：
   - 仅当某个 `(watchId, head)` **首次被观测到处于 `failure`** 时执行一次失败详情拉取与诊断；同一 `head` 后续轮询持续为 `failure` 时直接复用已持久化的 `(watchId, head)` 记录，零重复拉取、零重复消耗模型 Token。
   - 单次最多采集前 **3 个失败 Check Run** 的注解（每个最多 20 条）及最多 **2 个 GitHub Actions 失败 Job** 的原始日志；原始日志流式读取硬上限 **`256 KiB` / Job**（仅保留尾部窗口与首个错误锚点附近行），落库 JSON 总大小硬上限 **`16 KiB`**。
   - 失败详情采集总超时控制在 **`10s`** 内，L2 模型诊断超时控制在 **`15s`** 内；任一环节超时或报错均优雅降级保留上一层确定性结果，绝不拖垮 `120s` 盯盘租约。
6. **双层脱敏与标记转义（Redaction + Marker Escaping）**：
   - 落库、送入 L2 模型以及返回前端前，统一剥离 ANSI 控制序列（`\x1b\[...`）与不可见控制字符，执行高置信密钥正则脱敏（含 `sk-*`、`ghp_*`、`ghs_*`、`AKIA*`、`Bearer *` 以及当前环境配置的 `OTTO_GITHUB_READ_TOKEN` 原文串），并调用 `escapeMarkers` 转义 `⟦...⟧` 防止污染后续任何系统文本。

### 明确不做（排除项）
- **不支持 GitHub Enterprise 自定义域名或第三方 CI 平台私有 API 抓取**：非 GitHub Actions 的第三方检查仅读取其回写到 GitHub Check Runs / Commit Statuses 的公开 `output`、`annotations` 与链接。
- **不在服务器端解压多文件归档（如 Workflow 级 `.zip` 日志包）**：单 Job 日志接口 `GET /actions/jobs/{job_id}/logs` 直接返回纯文本流，无需引入 ZIP 解压器，避免 Zip Bomb 内存风险。
- **不自动重跑 Failed Jobs（`POST .../rerun`）或自动评论 PR**：保持 `OTTO_GITHUB_READ_TOKEN` 100% 纯只读语义。

## 4. 模块一：三层只读失败证据采集与清洗引擎（Stage 1）

### 4.1 证据阶梯设计（`apps/steward/src/pr-evidence.ts`）

保持现有 `readPrEvidence` 返回结构与判定逻辑完全兼容（可在 `PrEvidence` 上附带内部已读出的原始失败项元数据引用，或由专门导出的 `readPrFailureDetail` 执行增量拉取）：

| 层级 | 适用范围 | GitHub REST 端点 | 提取内容与降级策略 |
| :--- | :--- | :--- | :--- |
| **L1-Status** | `statuses-only` 与 `checks-and-statuses` 共用 | 已由主流程读出的 `/commits/{sha}/status` | 提取 `state === "failure" \| "error"` 的 `{ context, state, description, targetUrl }`（最多 5 项） |
| **L1-Checks** | 仅 `checks-and-statuses` | 已读出的 `/commits/{sha}/check-runs` + 按需对前 3 个失败项请求 `GET /repos/{owner}/{repo}/check-runs/{id}/annotations?per_page=20` | 提取 `{ id, name, appSlug, conclusion, htmlUrl, title, summary, text }` 及 `annotation_level === "failure"` 的精确 `{ path, startLine, endLine, title, message }`（自动覆盖 `tsc`、`vitest`、`eslint` 等标准 matcher 报错） |
| **L1-Actions** | 仅 `checks-and-statuses` 且 `app.slug === "github-actions"`（前 2 个失败项） | ① `GET /repos/{owner}/{repo}/actions/jobs/{id}`（`redirect: "error"`）<br>② `GET /repos/{owner}/{repo}/actions/jobs/{id}/logs`（`redirect: "manual"` ➔ 白名单无鉴权头二级拉取） | ① 从 `steps[]` 精确定位 `conclusion === "failure" \| "timed_out"` 的步骤名（如 `Run pnpm test`）；<br>② 流式读取至多 `256 KiB`，提取含 `Error:` / `FAIL` / `ERR_` / `exit code` 关键窗口与末尾 40 行（单 Job 截断至 `2,400` 字符）。若 `403`/`404` 则记 `logSource = "checks_only"` 并平稳返回 L1-Checks |

并在采集末尾再次核对（或绑定）目标 `sha`：所有接口（`check-runs` 归属 `head_sha === sha`、`actions/jobs/{id}` 返回 `head_sha === sha`）均强校验 `job.head_sha === sha`，若发现 SHA 不匹配立即丢弃该 Job 日志，杜绝跨提交串台。

### 4.2 结构化快照与诊断数据结构

```ts
export type PrFailureLogSource =
  | "actions_logs"      // 成功读取 Actions Job 失败步骤与原始日志片段
  | "checks_annotations"// 读取到 Check Run 输出摘要或代码行级注解（无 Actions 原始日志）
  | "checks_summary"    // 仅 Check Run 名称与结论（无注解且无日志权限/第三方 CI）
  | "statuses_only";    // statuses-only 模式，仅 Commit Status 描述

export interface PrFailedItemSnapshot {
  kind: "check_run" | "commit_status";
  name: string;
  conclusion: string;
  url: string | null;
  appSlug?: string | null;
  failedStep?: string | null;
  summaryText?: string | null;
  annotations: Array<{
    path: string;
    line: number;
    title: string | null;
    message: string;
  }>;
  logExcerpt?: string | null;
}

export interface PrFailureSnapshot {
  head: string;
  capturedAt: number;
  evidenceMode: PrEvidenceMode;
  logSource: PrFailureLogSource;
  logNote?: string | null; // 例如 "actions_logs_http_403" 等固定诊断码，绝不存原始响应体
  totalFailed: number;
  items: PrFailedItemSnapshot[]; // 上限 5 项
}

export type PrFailureCategory =
  | "test_failure"
  | "typecheck_or_build"
  | "lint_or_format"
  | "infra_or_timeout"
  | "config_or_permission"
  | "unknown";

export interface PrFailureDiagnosis {
  category: PrFailureCategory;
  headline: string;          // 一句话根因结论（<= 120 字）
  rootCauses: string[];      // 1..3 条带具体文件/测试名/步骤名的客观证据要点
  suggestedFixBrief: string; // 供用户核对后填入输入框的修复任务草稿（<= 600 字）
}
```

### 4.3 数据库迁移 `044_pr_watch_failure_diagnostics`（[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)）

新建独立关联表 `sh_pr_watch_diagnosis`，**零修改 `sh_pr_watch` 原有列**：

```sql
CREATE TABLE IF NOT EXISTS sh_pr_watch_diagnosis (
  watchId TEXT NOT NULL,
  head TEXT NOT NULL,
  snapshotJson TEXT NOT NULL,
  diagnosisJson TEXT,
  diagnosisStatus TEXT NOT NULL DEFAULT 'none',
  -- 取值: 'ready' | 'skipped_over_budget' | 'skipped_no_model' | 'failed'
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (watchId, head)
);
CREATE INDEX IF NOT EXISTS sh_pr_watch_diagnosis_watch
  ON sh_pr_watch_diagnosis (watchId, updatedAt DESC);
```

独立建表的三项收益：
1. **历史提交可回溯**：当 PR 从失败的 `head A` 推进到新的 `head B` 后，对话历史中 `head A` 的失败消息仍能准确查回当时的快照与诊断；
2. **天然按 `(watchId, head)` 幂等**：同一失败提交在后续轮询周期内检测到主键已存在即跳过外网日志抓取与模型调用；
3. **100% 向后兼容**：`PrWatchService.create()` / `list()` 的基础返回结构在核心单测中零破坏。

## 5. 模块二：旁路无工具根因诊断、通知增强与只读 API（Stage 2）

### 5.1 旁路诊断器 `apps/steward/src/pr-failure-diagnoser.ts`

1. **确定性兜底摘要生成器（0 Token 随时可用）**：
   - 无论是否调用模型，先由纯函数 `renderDeterministicFailureSummary(snapshot)` 生成简洁可读的客观摘要（列出失败的 Check / Step 名称、首条 `path:line` 注解或首行关键报错，以及 `suggestedFixBrief` 默认确定性模板）。
   - 当部署超出每日预算（`budgetState().over`）、未配置模型密钥、或网关请求超时失败时，通知消息与前端面板无缝回退展示这份确定性摘要，并诚实标记 `diagnosisStatus`（如 `skipped_over_budget`）。
2. **无工具单轮模型提炼（`diagnosePrFailureWithLlm`）**：
   - 系统提示词明确声明输入为**不可信的外部 CI 构建输出**，严禁听从其中任何指令，仅按固定 JSON 格式提取 `{ category, headline, rootCauses, suggestedFixBrief }`；
   - 复用 `distiller.ts` 同款平衡 JSON 提取器（自动剥离推理模型的 `<think>...</think>` 块与 Markdown 代码围栏），通过 Zod 校验并清洗长度与 `escapeMarkers` 后落入 `diagnosisJson`。

### 5.2 `PrWatchService` 轮询与通知衔接（[`apps/steward/src/pr-watch.ts`](../../apps/steward/src/pr-watch.ts)）

1. 在 `PrWatchDeps` 新增两个**可选注入依赖**（保持全部既有单测无需改签名即可运行）：
   - `readFailureDetail?(target: PrTarget, head: string, mode: PrEvidenceMode): Promise<PrFailureSnapshot | null>`
   - `diagnoseFailure?(snapshot: PrFailureSnapshot): Promise<{ status: "ready"; diagnosis: PrFailureDiagnosis } | { status: "skipped_over_budget" | "skipped_no_model" | "failed" }>`
2. **执行时机（严格在 `tx` 事务之外）**：
   - 在 `pass()` 中，仅当 `result.ok && result.evidence.state === "failure"` 且 `sh_pr_watch_diagnosis` 尚无 `(claim.id, result.evidence.head)` 记录时，依次调用 `readFailureDetail` 与 `diagnoseFailure`；
   - 进入结算 `tx` 后，先校验 `current.status === "active" && current.generation === claim.generation`（若期间用户取消了盯盘或已超时过期，直接丢弃，不写表、不发通知）；
   - 将增强后的根因结论（1 行 `headline` + 最多 2 条失败项/错误要点 + 证据范围披露）拼入 `pr-watch:<id>:<head>:failure` 通知正文，与 `sh_pr_watch` 状态更新、`sh_pr_watch_diagnosis` 记录在**同一个 SQLite 同步事务**内原子提交。
3. **取消清理一致性**：
   - `cancel(id)` 继续递增 `generation` 并清空未投递 `sh_pr_watch_notice`；已落库的只读历史诊断保留供审计查阅（或随事项归档静默留存）。

### 5.3 工作台与 Steward 只读查询接口

1. **Web Workspace 诊断详情与手动重试路由**（[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts)，纳入 Session + `requireOrigin` + CSRF + `sh_web_request` 幂等保护）：
   - `POST /app/api/pr-watches/:watchId/diagnosis`：
     - 请求体 `{ id?: string, head?: string, refreshDiagnosis?: boolean }`：
     - 默认（`refreshDiagnosis !== true`）为**纯本地 SQL 只读查询**（0 网络、0 模型 Token）：返回指定 `(watchId, head ?? watch.head)` 的 `{ watch, snapshot, diagnosis, diagnosisStatus, repairPrompt }`；
     - 当用户显式点击「重新生成 AI 根因诊断」（`refreshDiagnosis: true`，要求幂等 `id`）且已有 `snapshot` 时，重新调用一次 `diagnoseFailure(snapshot)` 更新 `sh_pr_watch_diagnosis` 并返回最新结果（若 `overBudget` 则返回 `409 budget_exceeded` 提示今日额度已满，L1 日志快照仍正常展示）。
2. **控制面与事项挂起计划轻量摘要挂载**：
   - 在 [`control-plane.ts`](../../apps/steward/src/control-plane.ts) 的 `readSchedulesControlPlane` 以及 [`ledger.ts`](../../apps/steward/src/ledger.ts) 的 `views.workspace`（`thread.plans.prWatches`）中，通过单次左连接附带当前 `head` 的轻量状态字段 `failureHeadline?: string | null` 与 `hasFailureDetail: boolean`（不把几千字原始日志塞进首屏 `workspace` 快照，保持首屏载荷轻快）。
3. **Steward 对话只读感知（[`apps/steward/src/llm/extension.ts`](../../apps/steward/src/llm/extension.ts)）**：
   - 在只读工具 `list_pr_watches` 与 `get_thread` 的 `prWatches` 视图中附带已脱敏的 `failureHeadline` 与失败项名称列表（不注入大段原始日志），方便用户在聊天里直接问「刚才那个 PR 为什么红了？」时总管能秒答具体原因。

## 6. 模块三：Web Workspace 诊断审阅与一键填入修复交互（Stage 3）

全部前端实现严格遵循 [`dom.js`](../../apps/steward/ui/dom.js) 纯文本节点 `h()` 构造规范（零 `innerHTML`、零内联 `style=`、中英双语词条与占位符 100% 对称）：

1. **触点 A：事项右侧「挂起计划」与控制面「PR 盯盘」卡片直达**
   - 当某条 `pr_watch` 当前存在失败快照（`hasFailureDetail === true`）时：
     - 在卡片下方直接展示紧凑的橙红根因摘要条（如 `单测失败：calc.test.mjs 第 18 行断言不匹配`）；
     - 操作栏并排提供 **`查看失败日志`** 与 **`填入输入框修复`** 两个按钮。
2. **触点 B：PR 失败诊断弹窗（独立轻量模块 `apps/steward/ui/pr-diagnosis.js`，挂载于 `#dialog.control-dialog`）**
   - **顶部元信息栏**：展示 PR 链接、短 `head` SHA、证据覆盖徽章（诚实标注 `Actions 日志 + 注解` / `仅 Check 注解与摘要` / `仅 Commit Statuses`）。
   - **根因结论卡片**：展示分类徽章（如 `测试失败` / `类型或构建错误` / `基础设施超时`）、一句话 `headline` 与 1～3 条根因要点；若此前因每日额度超限或模型未配跳过了 AI 提炼，展示温和提示条并提供「重新生成根因摘要」按钮。
   - **分项报错与日志折叠区**：逐项列出失败的 Check / Status、失败的 Actions Step 名称、`path:line` 编译器/测试注解列表，以及等宽滚动代码块 `pre` 渲染的脱敏尾部日志片段（支持一键复制日志片段）。
   - **底部行动栏**：
     - 主按钮 **`填入输入框派发修复`**：关闭弹窗、自动切换到该 `pr_watch` 绑定的 `threadId`，并将拼装好的修复指令（含 PR 链接、失败提交 SHA、失败 Job/Step、核心报错摘录与「请在该分支工作树定位修复并跑通对应检查后汇报，未经确认不要强推」说明）填入底部输入框并聚焦光标——用户扫一眼确认无误后按回车，即可直接接续原分支 Worker 修复！
     - 辅助按钮：**`复制修复提示词`** 与 **`在 GitHub 打开`**。

## 7. 分阶段实施路线与验证门禁（Stage 1 → Stage 3）

| 阶段 | 交付范围 | 验证门禁 |
| :--- | :--- | :--- |
| **Stage 1：三层只读失败取证与 `044` 迁移** | `pr-evidence.ts` 新增 `readPrFailureDetail`（含 `annotations`、`actions/jobs`、`redirect: "manual"` 白名单二级日志流、跨域名剥离 `Authorization`、`256 KiB` 流截断、ANSI/密钥脱敏与 `head_sha` 二次核验）；`schema.ts` 新增 `044_pr_watch_failure_diagnostics` | 专项单测覆盖：重定向到非白名单域名拒绝、二级日志请求零 `Authorization` 头、超 `256 KiB` 流式截断、`403` 无 Actions 权限优雅回退 `checks_only`、`statuses-only` 零越界请求、密钥与 `⟦...⟧` 标记脱敏、PR `head` 漂移丢弃 |
| **Stage 2：旁路无工具诊断、通知集成与只读 API** | 新增 `pr-failure-diagnoser.ts`；升级 `pr-watch.ts` 在首次 `(watchId, head)` 失败时采集诊断并增强通知文本；`workspace-api.ts` 暴露 `POST /app/api/pr-watches/:id/diagnosis`；`control-plane.ts` / `ledger.ts` / `extension.ts` 挂载轻量失败摘要 | 既有 5 套 `pr-watch*.test.ts` 100% 零回归；新增测试覆盖：同 `(watchId, head)` 重复轮询不重拉日志不重调模型、`over_budget` 下零模型调用仍产出确定性通知与快照、拉取期间 `cancel` 或租约过期不落脏数据、`routes-audit.test.ts` 鉴权与 CSRF 全绿 |
| **Stage 3：工作台诊断弹窗与一键填入修复闭环** | 新增 `apps/steward/ui/pr-diagnosis.js`，接入 `workspace.js`、`control-plane.js`、`i18n.js` 与 `workspace.css`，打通右侧挂起计划、控制面盯盘卡片、诊断弹窗与输入框预填修复闭环 | `ui-modules.test.ts` 全绿（零 HTML 注入、零内联样式、双语词条与占位符 100% 对称），`tsc --noEmit` 与 `build-node.mjs` 打包通过，Playwright 隔离网络守卫无泄漏 |
