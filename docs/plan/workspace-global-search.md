# Web Workspace 全局全文检索与跨维度定位跳转（Command-K）实施方案

状态：已落地（Stage 1–3 全部完成，2026-11-22）
前置依赖：[ADR-0004（Web Workspace）](../adr/0004-web-workspace.md)、[ADR-0010（浏览器认证与会话门禁）](../adr/0010-browser-password-authentication.md)、[ADR-0016（暗色仪表盘视觉体系）](../adr/0016-dark-instrument-panel-theme.md)、[2A 记忆与主动调度控制面](./memory-and-proactive-control-plane.md)、[PR 盯盘 CI 失败诊断闭环](./pr-watch-ci-failure-diagnosis.md)、[PR 盯盘评审与冲突感知闭环](./pr-watch-review-and-conflict-triage.md)

实施顺序：**Stage 1（`046_workspace_search_fts` 消息与汇报 FTS5 迁移 + `search.ts` 多源聚合检索与短词回退引擎） → Stage 2（`GET /app/api/search` 与历史消息锚点上下文接口 `GET /app/api/messages/around` + 路由安全门禁单测） → Stage 3（`search-palette.js` 全局 `Cmd+K` 检索浮层、跨维度跳转高亮、双语词条与全仓门禁）**。

## 1. 背景与真实痛点

随着 Otto 在日常研发中承载越来越多的并行事项（Threads）、多后端 Worker 接力、PR 持续盯盘诊断以及三层长期记忆，历史信息分散在五个彼此隔离的视图里，回查成本显著上升：

1. **现有 `Cmd+K` 仅能过滤左侧未归档事项标题**：
   - 当前 [`workspace.js`](../../apps/steward/ui/workspace.js) 中的 `Cmd+K` / `Ctrl+K` 仅将光标聚焦到侧边栏 `#thread-search`，在浏览器内存里按标题、仓库名、分支名过滤当前已加载的 Thread 列表（且 [`workspace.html`](../../apps/steward/ui/workspace.html) 将 `⌘ K` 角标误挂在「全部消息」链接上）。
   - 用户无法跨事项检索某次具体报错文本、某条历史对话回复、某次 Worker 汇报中的决策/遗留项（`decisions` / `leftovers`），或某个 PR 的评审意见与失败步骤。
2. **底层检索能力存在断层与分词盲区**：
   - [`schema.ts`](../../apps/steward/src/schema.ts)（`010_routing`）中的 `sh_thread_fts` 仅索引 `sh_thread.title + goal + summary + 最新一条 sh_report.summary`，**既不包含 `sh_inbound` / `sh_outbound` 聊天消息正文，也不覆盖历史轮次的 `sh_report` 详情与 `sh_timeline` 停机/异常记录**。
   - SQLite FTS5 `trigram` 分词器对**少于 3 个字符**的查询词（如高频双字中文词「限流」「死锁」「超时」「回滚」或短英文词 `PR`、`CI`、`db`）执行 `MATCH` 时永远返回空集，必须配套参数化 `LIKE ... ESCAPE '!'` 与二元重合度重排。
   - L1 断点快照（[`worker-checkpoint.ts`](../../apps/connector/src/worker-checkpoint.ts)）属于向在线 Connector 按需拉取的无状态中继，Steward SQLite 中并无断点快照表；全局检索必须在纯本地 SQLite 内毫秒级闭环，不能扇出唤醒离线或忙碌机器扫描本地 JSONL。
3. **跨窗口历史消息无法直接滚动定位**：
   - [`ledger.ts`](../../apps/steward/src/ledger.ts) 首屏快照默认截断最近 `WORKSPACE_MESSAGES = 120` 条消息，且默认排除已归档事项（`archived = 0`）。若检索命中第 120 条之前的老消息或已归档事项内的记录，前端直接调用现有 `jumpTo(messageId)` 会因目标节点不在 DOM 中而静默失效。

## 2. 现状盘点（复用既有底座与补齐缺口）

| 检索维度 | 既有底层存储与索引 | 现有缺口 | 本方案演进方式 | 代码位置 |
| :--- | :--- | :--- | :--- | :--- |
| **事项概览（`threads`）** | `sh_thread` + `sh_thread_fts`（FTS5 `trigram`，触发器同步标题/目标/摘要/最新汇报摘要）+ [`ledger.ts`](../../apps/steward/src/ledger.ts) `recallScore` | 路由召回函数 `findCandidates` 硬编码过滤 `archived = 0` 且上限 8 条，未返回高亮摘要 | 复用 `sh_thread_fts` + 短词 `LIKE` 兜底，支持检索含已归档在内的全部事项并返回匹配字段片段 | [`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)、[`apps/steward/src/ledger.ts`](../../apps/steward/src/ledger.ts) |
| **对话消息（`messages`）** | 用户输入存于 `sh_inbound`（`ownerAuthorized = 1`），系统回复与卡片存于 `sh_outbound`（含 `payload` JSON） | **无全文索引**；`sh_outbound.payload` 混有 `private: true` 私密消息（配对码/登录链接）与 `/link/wl1.*` 一次性令牌；前端仅加载最近 120 条 | 新增 `046` 迁移建立触发器同步的 `sh_message_fts`（物理排除 `private` 行），读时复用 `workspaceText` 清洗，并新增 `/app/api/messages/around` 支撑任意历史锚点定位 | [`apps/steward/src/workspace.ts`](../../apps/steward/src/workspace.ts)、[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts) |
| **汇报与停机记录（`reports`）** | `sh_report`（全量历史汇报：`summary` / `answer` / `decisions` / `leftovers` / `question`）、`sh_worker.lastOutcome`、`sh_timeline` | `sh_thread_fts` 仅保留最后一棒 `summary`；历史棒次的决策、遗留问题、阻塞提问与中断/失联原因无法跨事项检索 | 在 `046` 迁移建立 `sh_report_fts` 覆盖全量 `sh_report` 文本列，并联查关键异常类 `sh_timeline`（`question` / `stall` / `lost` / `settled`），零跨机扇出覆盖断点与结论回查 | [`apps/steward/src/ledger.ts`](../../apps/steward/src/ledger.ts) |
| **PR 诊断与评审（`pr`）** | `sh_pr_watch`、`sh_pr_watch_diagnosis`（`044`）、`sh_pr_watch_feedback`（`045`） | 仅能从已知 Thread 右侧栏或控制面列表点开，无法按报错步骤名、文件路径（如 `src/auth.ts`）或评审人检索直达 | 参数化检索已落盘的 PR URL、失败步骤、编译器注解路径/消息、冲突分支与评审摘要，回车直接拉起 `pr-diagnosis.js` 详情弹窗 | [`apps/steward/src/pr-watch.ts`](../../apps/steward/src/pr-watch.ts)、[`apps/steward/ui/pr-diagnosis.js`](../../apps/steward/ui/pr-diagnosis.js) |
| **长期记忆（`memory`）** | `sh_note` + `sh_note_fts`（`012_notes`）+ [`notes.ts`](../../apps/steward/src/notes.ts) `search()`（已实现 FTS5 + `<3` 字符 `LIKE ... ESCAPE '!'` 回退） | 仅能在控制面「记忆」标签页内单独搜索 | 直接复用 `notes` 只读检索逻辑（保持零 `useCount` / `lastUsedAt` 副作用），命中后一键跳转控制面记忆视图并定位目标卡片 | [`apps/steward/src/notes.ts`](../../apps/steward/src/notes.ts)、[`apps/steward/ui/control-plane.js`](../../apps/steward/ui/control-plane.js) |

## 3. 核心设计不变量与安全边界

1. **纯本地 SQLite 只读闭环，零模型消耗、零跨机扇出（Deterministic & Offline-Safe）**：
   - `GET /app/api/search` 与 `GET /app/api/messages/around` 100% 由 Steward Durable Object 读取本地 SQLite 完成，**绝不调用 LLM，绝不向 Connector 发送 WebSocket 指令**。
   - 即使部署处于超出每日预算软上限（`budget.over === true`）、未配置模型密钥或所有机器离线状态，全局检索与历史定位依然毫秒级可用。
2. **严守私密凭据与内部系统表隔离防线（Zero Credential & Internal Prompt Leak）**：
   - **私密出站消息物理隔离**：`sh_outbound` 中标记了 `json_extract(payload, '$.private') = 1` 的记录（包含设备配对口令、登录链接等，见 [`steward.ts`](../../apps/steward/src/steward.ts) `enqueueOutbound`）在触发器入库与读时解析**双层拦截**，永不进入检索索引或返回前端。
   - **一次性令牌与密钥脱敏**：所有消息、汇报与 PR 摘要在生成 `snippet` 前，统一经 `workspaceText()` 剥离 `/link/wl1.\S*` 一次性登录链接，并经密钥脱敏规则（过滤 `sk-*`、`ghp_*`、`ghs_*`、`AKIA*`、`Bearer *` 及 `OTTO_GITHUB_READ_TOKEN`）清洗。
   - **严禁暴露内部调度与墓碑数据**：绝不检索 `sh_run.text`（含系统提示词注记）、`sh_wake`、`sh_channel_log`、`sh_model` / `sh_provider_key`、`outbox` / `event_inbox`，且严格过滤 `sh_note.status = 'removed'` 已删除记忆与 `sh_inbound.ownerAuthorized = 0` 未授权入站记录。
3. **无副作用检索（Decay-Neutral & Unread-Neutral）**：
   - 在 `Cmd+K` 面板中输入关键词实时预览结果时，**绝不修改**任何 Thread 的 `unread` 状态，也**绝不更新** `sh_note` 的 `useCount` 或 `lastUsedAt`（避免一次全局搜索意外重置常驻记忆 90 天或项目记忆 60 天的自然衰减时钟）；仅当用户显式敲回车切入某个 Thread 时，才走原有 `markSelectedRead()` 流程。
4. **查询有界与防卡顿保护（Bounded Recall）**：
   - 查询串长度限制为 `2..160` 个字符（空白折叠后少于 2 个字符直接返回空数组，避免单字全表匹配），最多提取前 **8 个独立检索词**。
   - FTS5 子查询与短词 `LIKE` 回退子查询在各自分表内均设硬上限（按主键/时间倒序扫描或召回最多 `150` 行），最终聚合返回条数硬上限 `limit <= 50`（默认 `30`），确保在积累数万条消息与汇报后单次查询仍在数毫秒内返回。
5. **零 HTML 注入与中英双语门禁**：
   - 严格遵守 [`ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts) 安全门禁：命中高亮绝不使用服务端拼装 `<em>` HTML 字符串或前端 `innerHTML`，而是由服务端返回纯文本 `snippet` 与字符偏移区间 `highlights: Array<[number, number]>`，前端通过 [`dom.js`](../../apps/steward/ui/dom.js) 的 `h('mark', ...)` 纯文本节点切片渲染；严禁内联 `style=`；所有新增文案在 [`i18n.js`](../../apps/steward/ui/i18n.js) 的 `STRINGS` 中保持 100% 中英对称。

### 明确不做（排除项）
- **不在本轮检索 Connector 本机原始会话 JSONL（Session Viewer 全量工具输出）**：数 MB 级的原始终端输出驻留在各台机器的 `~/.otto` 或 `~/.claude` 目录，跨网实时全文检索既受机器在线状态限制又易阻塞连接；如需查看某次任务的完整原始流，先通过 `reports` / `threads` 命中定位到对应 Worker，再点开「原始会话」即可。
- **不引入外部搜索引擎或向量 Embedding**：完全依托 DO 内置 SQLite FTS5 `trigram` 与确定性打分器。

## 4. 模块一：SQLite FTS5 增量迁移与混合检索引擎（Stage 1）

### 4.1 数据库迁移 `046_workspace_search_fts`（[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)）

在不改动任何既有业务表列结构的前提下，新增两张 `trigram` FTS5 虚表及同步触发器，并在迁移时一次性回填存量历史数据：

1. **对话消息全文索引 `sh_message_fts`**：
   - 结构：`CREATE VIRTUAL TABLE IF NOT EXISTS sh_message_fts USING fts5(docKey UNINDEXED, role UNINDEXED, threadId UNINDEXED, ts UNINDEXED, body, tokenize='trigram')`
   - `docKey` 编码规范：
     - 用户入站消息（`sh_inbound`，仅当 `new.ownerAuthorized = 1 AND new.text IS NOT NULL AND length(trim(new.text)) > 0`）：`docKey = 'in:' || new.channel || ':' || new.msgId`，`role = 'user'`，`body = new.text`。
     - 系统出站消息（`sh_outbound`，仅当 `COALESCE(json_extract(new.payload, '$.private'), 0) = 0`）：`docKey = 'out:' || new.id`，`role = 'assistant'`，`body` 由 SQLite `json_extract` 提取 `$.text`、`$.card.text`、`$.card.title`（读时再由 TypeScript 精确解析 `cardView` 并脱敏生成摘要）。
   - 触发器覆盖：
     - `sh_inbound`：`AFTER INSERT` 与 `AFTER UPDATE OF text, ownerAuthorized, threadId`（先按 `docKey` 删除旧行再插入，兼容 `019_web_workspace` 的 `COALESCE` 补写模式）。
     - `sh_outbound`：`AFTER INSERT` 与 `AFTER DELETE`。
2. **历史汇报全文索引 `sh_report_fts`**：
   - 结构：`CREATE VIRTUAL TABLE IF NOT EXISTS sh_report_fts USING fts5(workerId UNINDEXED, seq UNINDEXED, threadId UNINDEXED, ts UNINDEXED, body, tokenize='trigram')`
   - 索引拼接字段：`COALESCE(summary, '') || '\n' || COALESCE(answer, '') || '\n' || COALESCE(question, '') || '\n' || COALESCE(decisions, '') || '\n' || COALESCE(leftovers, '') || '\n' || COALESCE(changes, '')`。
   - 触发器覆盖：`sh_report` 的 `AFTER INSERT`、`AFTER UPDATE OF answer`（兼容 `024_report_answer`）与 `AFTER DELETE`，并在迁移脚本内按 `NOT EXISTS` 幂等回填存量 `sh_inbound`、`sh_outbound`（排除 `private`）与 `sh_report`。

### 4.2 多源混合召回与短词回退算法（`apps/steward/src/search.ts`）

新建纯逻辑模块 `apps/steward/src/search.ts`（由 `ledger` 或 `workspace-api` 调用），统一处理分词、召回、脱敏、摘要切片与排序：

1. **查询归一化与词项切分（`parseSearchQuery(q)`）**：
   - NFC 归一化、折叠连续空白；若有效码点数 `< 2` 返回空词表；截断至前 `160` 个字符。
   - 按空白切分为至多 `8` 个去重词项 `terms`：
     - **长词组（`[...term].length >= 3`）**：构造安全的双引号转义 FTS5 `MATCH` 表达式（对纯 CJK 长串同时保留完整串与滑动 3 字窗口，兼顾精确短语与跨词匹配）。
     - **短词组（`[...term].length < 3`，如「限流」「死锁」「PR」「CI」）**：生成转义了 `!`、`%`、`_` 的参数化 `LIKE '%...%' ESCAPE '!'` 模式。
2. **五类数据源（`scope`）召回策略**：
   - `scope` 支持：`all`（默认）| `threads` | `messages` | `reports`（兼容别名 `checkpoints`）| `pr` | `memory`；可选过滤参数 `threadId`（限定在单个事项内搜）与 `includeArchived`（默认 `true`，全局搜索天然需要找回已归档老事项，结果中显式标注 `threadArchived: boolean`）。
   - **`threads`**：长词查 `sh_thread_fts`（`LIMIT 80`），短词查 `sh_thread` 的 `title / goal / summary`（`ORDER BY lastActivityAt DESC LIMIT 150`），合并关联仓库名与分支名。
   - **`messages`**：长词查 `sh_message_fts`（`LIMIT 120`），短词对 `sh_inbound`（`ownerAuthorized = 1`）与 `sh_outbound`（`ORDER BY createdAt DESC LIMIT 200`）执行参数化 `LIKE`；读出原行后，对 `sh_inbound` 通过 `LEFT JOIN sh_run ON operationId = 'user:' || msgId` 解析真实路由 `threadId`，对 `sh_outbound` 走 `parsePayload` 二次校验 `!payload.private` 并用 `cardView` / `workspaceText` 提取干净可读文本（关联卡片的 `id` 与前端气泡 DOM `id` 完全一致：用户消息为 `user:${msgId}`，助手消息/卡片为 `${outbound.id}`）。
   - **`reports`（含 `checkpoints` 别名）**：
     - 长词查 `sh_report_fts`（`LIMIT 100`），短词查最近 200 条 `sh_report`；
     - 同步扫描最近 200 条异常/关键决策类 `sh_timeline`（`kind IN ('question', 'stall', 'lost', 'settled')`）及非空 `sh_worker.lastOutcome`，使「上次为什么中断/失联/卡在哪个提问」即使未产出正式 `report` 也能精准搜到。
   - **`pr`**：扫描 `sh_pr_watch` 左连接 `sh_pr_watch_diagnosis` 与 `sh_pr_watch_feedback`（按 `updatedAt DESC LIMIT 100`），在内存中对已脱敏的 `url`、`headRef`、`baseRef`、`effectiveDiagnosis`（`headline`、`rootCauses`、`items[].name/failedStep/annotations`）与 `effectiveTriage`（`headline`、`actionItems`、`threads[].author/path/body`）匹配词项。
   - **`memory`**：调用只读版记忆匹配（复用 `sh_note_fts` + 短词 `LIKE` 且 `status != 'removed'`，附带 `StaleMark` 与仓库名，不触发 `bumpUse`）。
3. **统一相关性打分、纯文本摘要窗口与高亮偏移（`buildSnippet`）**：
   - **打分权重**：全部词项同时命中（AND 覆盖度 `+40`）> 完整短语精确子串命中（`+25`）> 标题 / PR Headline / 记忆首句命中（`+15`）> 未归档活跃事项（`+5`）> 时间新鲜度平滑衰减（`recency`）。`scope=all` 时对单一来源设配额保底与上限（单类最多占 `limit` 的 60%），防止某一次长日志对话刷屏挤掉匹配的记忆或 PR 诊断。
   - **安全摘要与偏移计算**：围绕首个命中词截取前后约 `140` 字符的纯文本窗口（首尾截断处加 `…`），在完成脱敏后的最终 `snippet` 字符串上计算所有命中词的不重叠 `[start, end]` 码元区间数组 `highlights`（最多 8 段），供前端零 HTML 解析渲染 `<mark>`。

## 5. 模块二：Steward 只读检索与历史消息锚点 API（Stage 2）

### 5.1 全局聚合检索接口 `GET /app/api/search`

在 [`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts) 新增会话保护下的只读 `GET` 路由（非 `GET` 请求一律返回 `405 method_not_allowed`；未登录由 [`web.ts`](../../apps/steward/src/web.ts) 统一拦截返回 `401 auth_required`）：

- **请求参数**：
  - `q`：必填检索词（空串或空白折叠后少于 2 字符直接返回 `200 { q, items: [], truncated: false }`；超过 160 字符自动截断或返回 `400 bad_request`）。
  - `scope`：`all | threads | messages | reports | checkpoints | pr | memory`（默认 `all`，非法枚举返回 `400 bad_request`；其中 `checkpoints` 映射至 `reports`）。
  - `threadId`：可选（匹配 `THREAD_ID` 正则），用于在当前打开的 Thread 内做局部深搜。
  - `limit`：`1..50` 整数（默认 `30`）。
- **统一响应结构**：

```ts
export type WorkspaceSearchItemKind =
  | "thread"
  | "message"
  | "report"
  | "pr_watch"
  | "memory";

export type WorkspaceSearchAnchor =
  | { type: "thread"; threadId: string }
  | { type: "message"; messageId: string; role: "user" | "assistant"; at: number }
  | { type: "report"; workerId: string; seq?: number | null; timelineId?: number | null }
  | { type: "pr_watch"; watchId: string; head: string | null; url: string }
  | { type: "memory"; noteId: string; layer: "resident" | "project" | "archive"; scopeRepoId: string | null };

export interface WorkspaceSearchHit {
  id: string;                      // 稳定唯一键，如 "msg:user:web:..." / "pr:w_1:abc123"
  kind: WorkspaceSearchItemKind;
  title: string;                   // 主标题（事项标题 / PR 短标识 / 记忆分类标签 / Worker 标识）
  subtitle: string | null;         // 副标题（所属事项名 · 仓库名 · 分支或状态徽章）
  snippet: string;                 // 已脱敏纯文本摘要（<= 180 字）
  highlights: Array<[number, number]>; // 相对 snippet 的 [start, end] 高亮切片索引
  titleHighlights: Array<[number, number]>; // 相对 title 的 [start, end] 高亮切片索引
  threadId: string | null;
  threadTitle: string | null;
  threadArchived: boolean;
  at: number;                      // 毫秒时间戳
  anchor: WorkspaceSearchAnchor;
}

export interface WorkspaceSearchResponse {
  q: string;
  scope: "all" | "threads" | "messages" | "reports" | "pr" | "memory";
  items: WorkspaceSearchHit[];
  truncated: boolean;
}
```

### 5.2 历史消息上下文切片接口 `GET /app/api/messages/around`

为彻底解决「命中 120 条首屏窗口之前的老消息无法在 `#feed` 中滚动定位」的问题，新增配套只读路由：

- **请求参数**：`GET /app/api/messages/around?messageId=<id>&threadId=<optional>&limit=30`（`limit` 范围 `5..60`，默认 `30`；仅 `GET`）。
- **查询逻辑**：
  1. 根据 `messageId`（`user:<msgId>` 查 `sh_inbound`，其余查非私密 `sh_outbound`）精确定位目标消息的时间戳 `anchorAt` 与所属 `resolvedThreadId`（若不存在或命中 `private: true` 行则返回 `404 message_not_found`）。
  2. 以 `(anchorAt, messageId)` 为中心，在选定 `threadId`（若传入）或全局消息流中分别向前取 `floor(limit / 2)` 条、向后取 `ceil(limit / 2)` 条授权可见消息，复用 [`workspace.ts`](../../apps/steward/src/workspace.ts) 完全相同的 `WorkspaceMessage` 转换器输出 `{ anchorId, threadId: resolvedThreadId, messages: WorkspaceMessage[], hasOlder: boolean, hasNewer: boolean }`。
- **零首屏负担**：日常打开工作台首屏 `/app/api/workspace` 仍只传最近 120 条消息，仅当用户从 `Cmd+K` 点选了一条不在当前 `state.snapshot.messages` 中的远古消息时才按需拉取一次上下文切片。

## 6. 模块三：Web Workspace `Cmd+K` 面板与跨维度定位交互（Stage 3）

### 6.1 入口与快捷键重构（[`workspace.html`](../../apps/steward/ui/workspace.html) & [`workspace.js`](../../apps/steward/ui/workspace.js)）

1. **修正既有快捷键归属**：
   - 移除 [`workspace.html`](../../apps/steward/ui/workspace.html) 中「全部消息（All messages）」链接上容易误导的 `<span class="shortcut">⌘ K</span>` 角标。
   - 在顶栏右侧状态区（或左侧栏搜索框旁）新增紧凑的全局检索触发按钮 **`搜索 ⌘K / Search ⌘K`**（`data-action="global-search"`，移动端同样显示搜索图标按钮）。
   - 全局 `keydown` 监听升级：按下 `Cmd+K` / `Ctrl+K` 时，无论当前侧边栏是否收起、是否处于某个 Worker Session 视图或已打开其他非忙碌弹窗，均一键唤起（或聚焦/关闭）全局 Command-K 搜索面板；左侧 `#thread-search` 保留作为纯侧栏快速过滤框（可绑定 `/` 或点击使用）。
2. **独立前端模块 `apps/steward/ui/search-palette.js`（复用 `#dialog.search-dialog`）**：
   - **顶部输入与范围栏**：
     - 自动聚焦带放大镜图标的搜索输入框，输入采用 `160ms` 防抖 + `AbortController` 自动取消过期在途请求，确保快速打字时绝不发生旧响应覆盖新结果（乱序竞态）。
     - 输入为空时默认展示**零网络请求的本地即时建议**：当前待处理事项（Needs you）、正在运行的事项（Running）与最近活跃的 8 个事项，开箱即具备快速切换面板能力。
     - 紧随输入框下方提供胶囊分类筛选栏（支持鼠标点击或 `Tab` / `Shift+Tab` 切换）：`全部 (All)`、`事项 (Threads)`、`消息 (Messages)`、`汇报与断点 (Reports)`、`PR 诊断 (PR)`、`记忆 (Memory)`，以及可选的「仅当前事项」过滤开关（当 `state.selected` 非空时出现）。
   - **安全高亮渲染器 `highlightText(text, ranges)`**：
     - 纯函数校验 `ranges` 单调合法后，用 `text.slice(...)` 交替生成普通文本节点与 `h('mark', { class: 'search-mark' }, matchedSlice)`，100% 通过 `ui-modules.test.ts` 的零 HTML 注入扫描。
   - **全键盘导航闭环**：
     - `ArrowDown` / `ArrowUp`（及 `Ctrl+N` / `Ctrl+P`）在结果列表中循环移动高亮选中项（同步维护 `aria-activedescendant` 与 `scrollIntoView({ block: 'nearest' })`）；`Enter` 执行跳转；`Escape` 关闭浮层并归还焦点。

### 6.2 五类命中条目的精准跳转与锚点高亮闭环

当用户在某条命中结果上敲回车或点击时，按 `hit.anchor.type` 执行确定性直达动作：

| 命中类型（`anchor.type`） | 已归档事项前置处理 | 视图切换与滚动高亮行为 |
| :--- | :--- | :--- |
| **`thread`** | 若 `hit.threadArchived && !state.showArchived`，自动置 `state.showArchived = true` 并拉取含归档快照 | 关闭搜索面板，调用 `select(hit.anchor.threadId)` 切入该事项对话视图 |
| **`message`** | 同上（若归属已归档事项先开启归档可见并刷新快照） | ① 若 `state.snapshot.messages` 已含 `messageId`：切入对应 `threadId`（无归属则切至「全部消息」），滚动至 `#<messageId>` 气泡并触发 `.flash` 琥珀色脉冲高亮；<br>② 若不在首屏 120 条内：请求 `GET /app/api/messages/around`，在 `#feed` 挂载「历史消息定位视图（含返回最新消息按钮）」，渲染上下文气泡后滚动并 `.flash` 高亮目标消息 |
| **`report`** | 同上 | 切入目标 `threadId`（若处于 Session 视图则切回主面板并展开右侧详情栏 `#context-panel`），定位到对应 `worker-card`（或对应 `timeline` 条目）滚动居中并 `.flash` 高亮；若该条来自停机无汇报的 Worker，卡片上的「断点与提炼」按钮可直接聚焦备按 |
| **`pr_watch`** | 无需切换归档开关即可直接弹窗 | 直接调用 `openPrDiagnosisDialog(hit.anchor.watchId, { head: hit.anchor.head, threadId: hit.threadId, url: hit.anchor.url })` 打开 PR 失败日志 / 评审冲突诊断弹窗 |
| **`memory`** | 无需切换事项 | 打开控制面弹窗（`type: 'control-plane'`），自动切至「记忆」标签页，带入当前检索词 `q` 并滚动高亮目标 `noteId` 卡片 |

## 7. 分阶段实施路线与验证门禁（Stage 1 → Stage 3）

| 阶段 | 交付范围 | 验证门禁 |
| :--- | :--- | :--- |
| **Stage 1：`046` FTS5 迁移与混合检索引擎** | `schema.ts` 新增 `046_workspace_search_fts`（`sh_message_fts`、`sh_report_fts`、增删改触发器与存量幂等回填，物理排除 `private` 出站行）；新建 `apps/steward/src/search.ts` 实现多源召回、`<3` 字中文/英文短词 `LIKE ... ESCAPE '!'` 回退、脱敏、摘要切片与高亮区间计算 | 专项单测 `search.test.ts` 覆盖：中文三字以上 FTS 命中、双字中文词（「限流」「死锁」）与双字母词（`PR`、`CI`）回退命中、`%!_"*` 特殊字符零 SQL/FTS 注入、`private: true` 配对码与 `/link/wl1.*` 零泄漏、`removed` 记忆不返回、检索不增加 `sh_note.useCount` / 不重置 `lastUsedAt`、存量数据迁移回填一致性 |
| **Stage 2：只读 API 契约与安全门禁** | `workspace-api.ts` 新增 `GET /app/api/search` 与 `GET /app/api/messages/around`；在 `routes-audit.test.ts` 的 `PROBE_PATHS` 注册两条新路径 | `routes-audit.test.ts` 全绿（未认证访问返回 `401`，非 `GET` 方法返回 `405`）；新增 API 集成测试验证：`over_budget` 与无模型配置下正常检索、超 120 条历史消息通过 `/around` 精确取回前后文、请求私密消息 ID 返回 `404` |
| **Stage 3：Command-K 前端交互与全仓门禁** | 新增 `apps/steward/ui/search-palette.js`（纳入 `ui-modules.test.ts` `SCRIPTS` 与 i18n 扫描列表），接入 `workspace.html`、`workspace.js`、`workspace.css` 与 `i18n.js`；打通防抖取消、键盘导航、历史消息切片视图与五维直达跳转 | `ui-modules.test.ts` 全绿（零 `innerHTML` / 零内联 `style`、模块导出完整、EN/ZH 词条与占位符 100% 对称）；全仓 `tsc --noEmit`、`build:node` 与全量 Vitest 测试套件通过 |
