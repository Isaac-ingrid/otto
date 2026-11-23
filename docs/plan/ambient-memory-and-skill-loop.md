# 记忆与技能无感闭环设计方案（派发自动注入 + 收尾顺路记记忆 + 高摩擦任务推卡一键存 Skill）

状态：已落地（Stage 1–3 全部完成，2026-11-19）。关联前序决策：[ADR-0004](../adr/0004-web-workspace.md)（Web Workspace）、[ADR-0016](../adr/0016-dark-instrument-panel-theme.md)（暗色仪表台设计规范）、[ADR-0022](../adr/0022-report-labels-worktree-hooks-and-readonly-proposals.md)（本地信任红线与受控边界），以及已落地的 [2A 记忆与主动调度控制面](./memory-and-proactive-control-plane.md)、[中断任务断点快照与 Skill 提炼方案](./worker-checkpoint-and-skill-extraction.md)、[2B 仓库技能受控落盘与工作台目录管理](./repo-skill-sync-and-catalog.md)，对照研究基线 [Personal Agent 2026](../research/personal-agent-2026.md) 与 [RSI 2026](../research/rsi-2026.md)。

实施顺序：**Stage 1（派发端自动注入：`hello.repos` 轻量技能索引同步 + `043` 账本迁移 + `Dispatcher.startNewSession` 确定性注入项目记忆与按需读技能指引） → Stage 2（收尾顺路记记忆与一键转正：`eventWakeText` 踩坑事实提取准则 + `noteconfirm` 聊天流内一键确认/删除） → Stage 3（高摩擦任务推卡一键存 Skill：L0 确定性门槛 + L1 旁路严格否决器 + `sh_skill_offer` 卡片确定性落盘与冷却熔断）**。

## 1. 背景与核心产品命题：如何避开「控制面填空陷阱」？

在 2A（三层记忆控制面）与 2B（仓库技能受控落盘与目录管理）相继完工后，工作台的底层存储、安全边界与可视化面板均已就绪，但真实日常使用中暴露出一个核心体验断层：**控制面打开仍是 `0 / 2400 字`，技能目录也需要人工点进「断点与提炼」主动触发才会生长**。

这正是 [Personal Agent 2026](../research/personal-agent-2026.md) 所警示的 **「Today 陷阱」**：如果把记忆整理与技能沉淀变成需要 Owner 手工去二级弹窗里填写、维护的管理作业，绝大多数时候它就会一直空着；真正有生命力的个人助手应当在日常派活与收尾的主干流里**自己把经验攒下来、下次派活自己用起来**，而控制面只承担「平时不用开，偶尔看一眼、删错纠偏」的兜底职责。

结合代码链路逐段排查，当前阻碍「越用越懂项目」的三处精确断头如下：

1. **派发端断头（新开任务时，项目记忆与仓库技能均未传给 Worker）**：
   - 在 [`apps/steward/src/llm/extension.ts`](../../apps/steward/src/llm/extension.ts) 中，`ledger.notes.forRepos([repoId])` 仅挂载在 `get_thread(threadId)` 的返回值里；当用户新开一个事项并直接调用 `start_worker`（传入 `newTitle`）时，Steward 根本不会调用 `get_thread`，而 [`apps/steward/src/dispatch.ts`](../../apps/steward/src/dispatch.ts) 的 `startNewSession` 只拼装了前序交接简报 `renderHandoffBrief(brief)`，**从未把该仓库沉淀的 `project` 记忆注入给编码 Worker**。
   - 同时，根据 [`pi-integration.md`](../research/pi-integration.md) 实测结论，`pi` 在默认 `--no-approve` 沙盒下会忽略仓库内的 `.agents/skills/*/SKILL.md`；由于派发提示词里也没有附上该仓现有技能的轻量索引，Worker 既不知道有哪些现成 `SKILL.md` 可按需 `Read`，还会重复踩前人已经固化过的流程坑。
2. **收尾端断头（Worker 跑完汇报时，Steward 只更新摘要、不顺手记经验）**：
   - 在 [`apps/steward/src/wake-text.ts`](../../apps/steward/src/wake-text.ts) 的 `eventWakeText` 中，当 `report.status === "done"` 时，系统提示仅要求 Steward 调用 `update_thread` 更新一句话摘要并尽快 `no_action` 收尾，没有任何指令引导它从 `report.decisions`、`report.tests.note` 或 `blocked-by-env` / `flaky-test` / `needs-migration` 标签中把「下次派单还会踩的构建/环境/规范事实」顺手记入 `project` 层。
   - 另一边，[`apps/steward/src/distiller.ts`](../../apps/steward/src/distiller.ts) 仅绑定在手动接口 `POST /app/api/workers/:workerId/distill` 上，即使某个任务经历了十几轮工具排障才打通套路，只要用户没想起来点开右侧抽屉的「断点与提炼」，这段高价值套路就会随会话归档被遗忘。
3. **确认端断头（缺少聊天流内「顺手点一下」的低摩擦确认闭环）**：
   - 按信任模型，`source: "worker_reported"` 的记忆落库时默认 `confirmed = 0`；目前它仅在汇报末尾附一行纯文本提示，用户若想转正或删掉错误观察，必须打开顶栏控制面弹窗翻找对应条目。
   - 同样，对于值得固化进仓库的 `SKILL.md`，目前只有完整编辑器弹窗一条重路径，缺少类似主动调度 `sh_routine_offer`（`offer:<id>`）那样在对话流里展示 3 行摘要、点一下「写入仓库技能」即可受控落盘的轻量提议卡。

## 2. 现状盘点（最大化复用 2A / 2B 底座）

| 模块 | 既有能力 | 本方案复用与升级点 | 关键代码位置 |
| --- | --- | --- | --- |
| 三层记忆账本 | 已支持 `resident` / `project` / `episodic` 分层、`forRepos` 预算读取（单仓 `1500` 字上限）、`confirmed` 信任位与 `stale`（30 天未确认）标记 | 复用 `forRepos` 在派发端按信任等级拆分渲染；新增聊天卡片动作直调 `notes.confirm` / `notes.remove` | [`apps/steward/src/notes.ts`](../../apps/steward/src/notes.ts) |
| 派发前置简报 | `handoff.ts` 已为换棒新会话生成有界、经 `redactText` + `escapeMarkers` 脱敏的前置说明块 | 同构新增 `renderRepoContextBrief`，仅在新启动 Worker 会话时拼入有界项目记忆与按需读技能索引 | [`apps/steward/src/handoff.ts`](../../apps/steward/src/handoff.ts)、[`apps/steward/src/dispatch.ts`](../../apps/steward/src/dispatch.ts) |
| 收尾记账唤醒 | `eventWakeText` 已在每次 `worker_report(done)` 时唤醒 Steward 执行 `update_thread` | 零新增唤醒轮次：直接在同一轮 `done` 唤醒文案中加入克制的项目踩坑事实沉淀准则 | [`apps/steward/src/wake-text.ts`](../../apps/steward/src/wake-text.ts) |
| 轨迹提炼与受控写技能 | `distiller.ts` 已具备 `worker_checkpoint` 采样与 `SKILL.md` 生成；2B 已实现三槽位白名单、软链阻断、凭据拦截与 CAS 原子落盘 | 在 `distiller.ts` 前置 L0 确定性高摩擦过滤与 L1 `worthSaving` 严格否决器；卡片确认后直调 2B 的 `repoSkillOp(write)` | [`apps/steward/src/distiller.ts`](../../apps/steward/src/distiller.ts)、[`apps/connector/src/repo-skills.ts`](../../apps/connector/src/repo-skills.ts) |
| 待决卡片状态机 | `workspace.ts` 与 `sh_outbound` 已统一承载 `offer:<id>`、`proposalapproval:<id>`、`prwatchapproval:<id>` 等幂等决策卡 | 同构接入 `noteconfirm:<noteId>` 与 `skilloffer:<offerId>`，天然复用 Web 工作台与外部聊天渠道的按钮交互 | [`apps/steward/src/workspace.ts`](../../apps/steward/src/workspace.ts)、[`apps/steward/src/report-template.ts`](../../apps/steward/src/report-template.ts) |

## 3. 核心安全边界与防噪音红线（6 条硬约束）

让记忆与技能「自动转起来」最容易踩的两个大坑是**静默污染仓库/上下文（自我投毒）**与**每跑完一单就弹卡片求表扬（通知疲劳）**。本方案用以下 6 条硬性边界锁死风险：

1. **零静默写盘（Owner 独占仓库文件落盘权）**：
   - 无论旁路提炼模型的置信度有多高，系统**绝对不会**在后台自动往目标仓库写入或修改任何 `SKILL.md`。
   - 后台旁路最多只能在 SQLite `sh_skill_offer` 表生成一条待决提议并推送静默卡片；唯有 Owner 本人显式点击卡片上的 **「写入仓库技能」** 按钮，Steward 才会以确定性代码调用 `repoSkillOp({ action: "write", overwrite: false })`（全程零 LLM 介入，且 Steward 对话模型依旧不挂载任何写/删技能工具）。
2. **记忆信任分层不降级（严防错误观察滚雪球）**：
   - Worker 汇报顺路写入的项目记忆固定标记为 `source: "worker_reported"`（`confirmed = 0`）。
   - 派发端向后续 Worker 注入时，强制在文本结构上把 **`confirmed = 1 || pinned = 1`（Owner 已确认项目约定）** 与 **`confirmed = 0`（前序任务待确认观察）** 拆成两个独立小节；待确认观察最多附带最新 `2` 条（自动剔除超过 30 天未确认的 `stale` 条目），并带有显式警示：`以下为前序任务自动记录的待验证观察，仅供参考；若与当前仓库实测代码冲突，以实测为准`。
   - 未经 Owner 点击确认的 `worker_reported` 记忆，严禁被 Steward 用于 `answer_worker` 自动代答，也严禁自动晋升至全局 `resident` 常驻层。
3. **跨层抗提示词注入（严格只读数据围栏）**：
   - 从目标仓库 `.agents/skills` / `.claude/*` 扫描采集的 `name`、`description` 以及 `worker_reported` 笔记，可能混入第三方仓库文本或构建输出残片。
   - 所有拼入 `renderRepoContextBrief` 或 Steward 态势简报的字段，入库与渲染前必须经过 `redactText`（脱敏密钥串）+ `escapeMarkers`（转义 `⟦...⟧` 等控制标记）+ 单行空白折叠与硬截断；外层包裹明确的只读数据声明，声明其仅为仓库背景资料，不可覆盖本轮任务要求与安全边界。
4. **三级防噪音漏斗与冷却熔断（宁漏十次，不扰一次）**：
   - Skill 提议卡必须先后穿过 **L0 确定性高摩擦门槛**、**L1 旁路模型 `worthSaving` 严格否决（含已有技能查重）** 与 **L2 频控冷却与预算硬熔断**：
     - 同一事项（`threadId`）全生命周期**最多推送 1 张** Skill 提议卡；
     - 同一注册仓库（`repoId`）`24 小时` 内**最多推送 1 张** Skill 提议卡；
     - 若 Owner 对同一仓库连续 `2` 张提议卡点击了「忽略」（`dismissed`），该仓库自动进入 **`72 小时` 静默退避期**；
     - 当日 LLM 预算超限（`ledger.runs.budget().over === true`）时，旁路提炼直接短路跳过，零额外 Token 消耗。
5. **恪守 `pi --no-approve` 本地信任不变量**：
   - 派发注入仅在提示词中告知编码 Worker「仓库内存在以下技能文件相对路径，需要时可用 `Read` 工具按需查阅纯文本说明」，**绝不自动修改 `connector.sqlite` 中的 `repo.approved`**，不会自动开启 `pi --approve`，也不会触发任何项目级 Hook、MCP Server 或可执行扩展。
6. **隔离核心路由与记忆评测面（守住 [RSI 2026](../research/rsi-2026.md) 门禁）**：
   - 派发注入收拢在确定性代码 `dispatch.ts`，收尾顺路记账收拢在 `wake-text.ts`，高摩擦 Skill 甄别收拢在主链落定后的独立异步任务 `distiller.ts`；**完全不修改 `findCandidates` 路由候选召回算法**，确保路由评测（`wrong-route < 2%`）与记忆零泄露评测（`eval:memory` 10/10）零退化。

### 明确不做（排除项）
- **不做后台定时全量重跑历史会话提炼**：仅针对实时新完成的任务按门槛触发，不翻旧账消耗额外预算。
- **不在机器离线时把卡片确认的技能写入排入延迟队列**：若点击「写入仓库技能」时机器恰好离线，卡片保持可重试状态并提示上线后再点（与 PR 审批重试模型一致），避免数小时后静默覆盖本地文件。
- **不触碰 Antigravity（`agy`）任何实时能力或目录槽位**：维持 `agy` 冻结红线。

## 4. 三大闭环机制与精确触发阈值设计

### 4.1 闭环一：派发端确定性记忆与技能索引自动注入（Stage 1）

#### 4.1.1 `HelloMessage.repos` 轻量技能目录同步与账本缓存
为让 `Dispatcher.startNewSession` 在同步拼装提示词时无需每次阻塞等待一次跨网 WS 查询，在 Connector 握手与技能变更时维护一份极轻量的元数据快照：

1. **协议扩展（[`packages/protocol/src/messages.ts`](../../packages/protocol/src/messages.ts)）**：
   - 在 `RepoSchema` 新增两个可选向后兼容字段：
     - `projectApproved: z.boolean().optional()`：映射 `LocalStore.getRepo(repoId).approved`（即 `pi` 是否以 `--approve` 运行，与 `RepoSchema.approved` 所代表的 ADR-0022 Worktree Hook 授权位严格解耦）；
     - `skills: z.array(RepoSkillBriefSchema).max(25).optional()`：单条仅含 `{ target, slug, relativePath, name, description }`，其中 `name` 截断至 `80` 字符、`description` 截断至 `160` 字符，经脱敏清洗且**不含任何 Markdown 正文**（25 条上限总荷载不足 `5 KiB`）。
   - Connector 在构造 `hello.repos`（启动握手与 `otto repo-config` 刷新）时直接复用 [`apps/connector/src/repo-skills.ts`](../../apps/connector/src/repo-skills.ts) 的本地扫描结果填充；同时，每当 Steward 侧成功执行 `repo_skill_op` 的 `write` / `delete` 或 `list` 时，顺带用最新摘要刷新 Steward 本地缓存，做到写入即刻对下一棒 Worker 生效。
2. **账本迁移 `043_ambient_memory_and_skill_loop`（[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)）**：
   - 为 `sh_repo` 新增 `projectApproved INTEGER NOT NULL DEFAULT 0` 与 `skillIndexJson TEXT NOT NULL DEFAULT '[]'`；
   - 在 `ledger.repos` 新增专用只读查询 `contextFor(repoId)` 返回 `{ projectApproved, skills }`，**保持既有 `ledger.repos.list()` 返回字段不变**，确保全仓既有账本单测零破坏。

#### 4.1.2 `renderRepoContextBrief` 注入条件与字符预算
在 [`apps/steward/src/handoff.ts`](../../apps/steward/src/handoff.ts) 新增纯函数 `renderRepoContextBrief(input)`，由 [`apps/steward/src/dispatch.ts`](../../apps/steward/src/dispatch.ts) 的 `startNewSession` 在拼装 `fullPrompt` 时置于 `renderHandoffBrief(brief)` 之前、用户任务 `prompt` 之前：

- **精确注入范围**：
  - **触发**：所有调用 `startNewSession` 且绑定了 `repoId` 的新启动 Worker 会话（含全新 Thread 的首棒 `start_worker`、前棒结束后的换棒新会话、以及同仓只读 `sibling` 探针）；
  - **跳过**：`resumeSession`（复用存活会话继续对话时**不重复注入**，避免多轮追问膨胀上下文）；无 `repoId` 的纯通用会话自动跳过；当该仓既无活跃 `project` 记忆也无任何仓库技能文件时，返回空串 `""`（零多余字符）。
- **硬字符预算（总上限 `REPO_CONTEXT_BRIEF_CAP = 900` 字符）**：
  1. **已确认项目约定（上限 `500` 字符）**：提取 `ledger.notes.forRepos([repoId])` 中 `pinned === true || confirmed === true` 的条目（置顶优先，其次按 `updatedAt DESC`）；
  2. **前序待验证观察（上限 `2` 条且不超 `200` 字符）**：提取 `confirmed === false && !stale` 的最新条目，前置明确说明「仅供参考，以当前代码实测为准」；
  3. **仓库可用技能按需读取索引（上限 `8` 条且不超 `250` 字符）**：列出 `- <relativePath> — <description>`，并附一句固定指引：
     > 以上为本仓库已沉淀的操作技能文件（只读背景索引）。仅当本轮任务命中对应场景时，先用文件读取工具按需阅读对应相对路径获取详细步骤；无关场景无需读取。
  - 这一设计同时解决了两个关键问题：既避免把几十份完整 `SKILL.md` 全量塞爆首轮上下文，又让默认处于 `--no-approve` 下的 `pi`（以及跨目录槽位的 `codex` / `claude-code`）都能按需精准读取 `.agents/skills/<slug>/SKILL.md`。
- **Steward 主模型态势同步**：
  - 在 [`apps/steward/src/llm/extension.ts`](../../apps/steward/src/llm/extension.ts) 的 `buildBrief` 仓库列表行末尾，当某仓存在项目记忆或技能时，追加极简标签（如 `notes:3, skills:2`），让 Steward 在新开单还未调用 `get_thread` 时也能直观感知该仓已有沉淀。

### 4.2 闭环二：收尾唤醒顺路沉淀项目记忆 + 聊天内一键转正（Stage 2）

#### 4.2.1 `eventWakeText` 搭顺风车提取规则（零新增唤醒轮次）
修改 [`apps/steward/src/wake-text.ts`](../../apps/steward/src/wake-text.ts) 中 `ev.type === "worker_report"` 且 `r.status === "done"`（含主链与 `sibling` 只读探针）的记账指引，将原本单一的「更新摘要后收尾」升级为带严格准入阈值的两步收尾：

- **准入条件（满足任一才调用 `notes_propose` + `notes_commit`）**：
  1. 汇报中揭示了该仓库**非显而易见的构建、测试、校验或迁移命令/约束**（如 `tests.note` 提到的特殊环境变量、测试启动前置条件、禁止直接运行的命令）；
  2. 汇报带有 `blocked-by-env`、`flaky-test` 或 `needs-migration` 标签，且查明了稳定的根因或绕行方案；
  3. `decisions` 中记录了下次派单若不知道就会重复踩坑的目录边界或架构约定。
- **硬性禁令（写入唤醒提示词与 `notes.ts` 守卫）**：
  - **普通日常改动一律不记**：常规修文案、改样式、普通增删改查完成时，严禁为了记账而硬凑笔记；
  - **单次上限与参数约束**：单次汇报唤醒**最多写入 `2` 条**，每条不超过 `140` 字的一句话事实；固定传参 `layer = "project"`、`repoId = worker.repoId`、`source = "worker_reported"`、`evidence = "report:<workerId>"`；
  - **内容黑名单**：严禁写入本次任务改了哪几个业务文件、Git 分支名/Commit SHA、一次性堆栈报错，或任何密钥/令牌/账号凭据（命中 `redactText` 高危凭据模式拒绝落库）。

#### 4.2.2 聊天流内轻量记忆确认卡 `noteconfirm:<noteId>`
为了不用打开二级控制面就能把有价值的 `worker_reported` 观察一键转正（或顺手删掉噪声）：

1. **卡片触发阈值**：
   - 当 `⟦event⟧` 收尾轮次针对某个 `repoId` 新写入了 1–2 条 `confirmed = 0` 的 `worker_reported` 项目记忆时，系统随汇报静默窗口投递轻量待决项 `noteconfirm:<noteId>`（`urgency: "quiet"`，不额外鸣笛打断，与汇报消息同屏呈现；同一 Thread 单次收尾最多附带 2 条）：
   - 卡片文案示例：`记住项目观察（otto）：本仓 Vitest 需用 ./node_modules/.bin/vitest 运行，沙盒内调 pnpm 会触发 Corepack 联网阻塞`。
2. **纯确定性一键动作（零 LLM 消耗）**：
   - **`[确认有效]`（`note_confirm`）**：直接调用 `ledger.notes.confirm(noteId, "card:<actionEventId>", { reported: true })`，将 `confirmed` 置为 `1`，后续派发自动归入「已确认项目约定」，同时也可供 Steward 安全引用；
   - **`[删除]`（`note_remove`）**：直接调用 `ledger.notes.remove(noteId, "owner_card_removed")`，立即软删除归档，永不再注入后续 Worker；
   - 若用户暂不理会：卡片支持随时处理，未确认期间按 §3 第 2 条仅作为带警示前缀的轻量参考，30 天未确认自动转为 `stale` 停止注入。

### 4.3 闭环三：高摩擦任务自动甄别与「一键存 Skill」提议卡（Stage 3）

Skill 与单句项目记忆的本质区别在于：**记忆是「一句话事实/约束」，而 Skill 是「多步可复用的排障、构建、发布或验证套路（SOP）」**。因此 Skill 提议必须采用严苛得多的三级漏斗：

#### 4.3.1 三级触发阈值明细

| 关卡 | 执行位置与开销 | 精确放行条件（必须全部满足才进入下一关） | 未命中行为 |
| --- | --- | --- | --- |
| **L0 确定性门槛** | Steward 内存与 SQLite 查询（**0 Token**） | 1. `worker.workerRelation === "relay"` 且 `report.status === "done"`；<br>2. `worker.repoId !== null`，对应设备在线且声明 `capabilities.repoSkills === true`；<br>3. 当日预算健康：`!ledger.runs.budget().over`；<br>4. **频控冷却通过**：当前 `threadId` 无历史 `sh_skill_offer`；当前 `repoId` 近 `24h` 内无 `sh_skill_offer`；且该仓最近两次提议未连续被 `dismissed`（若连续 2 次被忽略则冷却期为 `72h`）；<br>5. **高摩擦信号至少命中一项**：<br>   - 拉取的 `worker_checkpoint` 轨迹满足 `toolCallCount >= 12` 或 `turnCount >= 6`；<br>   - 或 `report.labels` 含 `"blocked-by-env"` / `"flaky-test"` / `"needs-migration"`；<br>   - 或同 `threadId` 前序存在 `failed` / `interrupted` / `aborted` 的旧 Worker，由本棒排障跑通。 | 静默结束，不调模型、不发任何消息（过滤掉 85%+ 常规简单任务）。 |
| **L1 旁路严格否决器** | 异步后台调用单次 `completeSimple`（复用 `distiller.ts` 预算账本） | 向模型输入采样后的 `worker_checkpoint` 轨迹摘要 + `report` + **该仓现有 `skills` 列表（`slug + name + description`）**，强制先判 `{ worthSaving, confidence, skipReason }`：<br>1. **默认否决原则**：凡属一次性业务功能开发、常规改 Bug、简单文件增删、步骤无法脱离本次特定需求复用的，一律返回 `worthSaving: false`；<br>2. **已有技能查重**：若核心流程已被该仓现有任一 `skill` 覆盖，返回 `worthSaving: false`（`skipReason: "already_covered"`）；<br>3. **高置信度与安全校验**：仅当 `worthSaving === true && confidence === "high"`，且生成的 `slug` 合法未重名、`markdown` 字节数 `<= 32 KiB` 且通过 Connector 同款高危密钥正则扫描（无 `secret_detected`）时放行。 | 记一条内部审计日志 `audit("ambient_skill_skipped", { workerId, skipReason })`，静默结束，零用户打扰。 |
| **L2 待决卡片与一键入仓** | `sh_skill_offer` + `workspace.ts` 卡片动作（**点击确认时 0 Token**） | 写入 `sh_skill_offer(status = 'offered')`，向原事项投递一张 `skilloffer:<offerId>` 静默提议卡（`urgency: "quiet"`）。 | 等待 Owner 决定：`写入仓库技能` / `预览与编辑` / `忽略`。 |

#### 4.3.2 `sh_skill_offer` 数据表与状态流转（纳入 `043` 迁移）
在 [`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts) 的 `043_ambient_memory_and_skill_loop` 迁移中创建 `sh_skill_offer`：

- **核心字段**：
  - `id TEXT PRIMARY KEY`（`so_<ulid>`）
  - `workerId TEXT NOT NULL UNIQUE`（防同一 Worker 重复触发）
  - `threadId TEXT NOT NULL`、`deviceId TEXT NOT NULL`、`repoId TEXT NOT NULL`
  - `target TEXT NOT NULL DEFAULT 'agents-skill'`（默认通用槽位 `.agents/skills/<slug>/SKILL.md`）
  - `slug TEXT NOT NULL`、`name TEXT NOT NULL`、`description TEXT NOT NULL`
  - `summaryJson TEXT NOT NULL`（最多 3 条步骤要点数组，供卡片紧凑展示）
  - `markdown TEXT NOT NULL`（已通过脱敏与格式校验的完整 `SKILL.md` 文本）
  - `status TEXT NOT NULL`（`'offered' | 'saving' | 'saved' | 'failed' | 'dismissed'`）
  - `savedPath TEXT`、`savedSha256 TEXT`、`failureReason TEXT`
  - `createdAt INTEGER NOT NULL`、`decidedAt INTEGER`
- **索引**：`idx_sh_skill_offer_repo_created(repoId, createdAt DESC)`、`idx_sh_skill_offer_thread(threadId)`、`idx_sh_skill_offer_status(status)`。

#### 4.3.3 卡片展示与三按钮交互体验
在 Web Workspace 对话流（及外部渠道待决卡片）中，`skilloffer:<offerId>` 展示：
- **标题**：`发现可复用套路，是否存为仓库技能：「<name>」？`
- **路径与触发场景**：目标路径 `.agents/skills/<slug>/SKILL.md`（若该仓 `projectApproved === false`，温和附注：`写入后后续派单将通过按需读取索引自动对 pi / codex / claude-code 生效`）+ 一句话 `description` + 最多 3 条关键步骤预览；
- **三个操作按钮**：
  1. **`写入仓库技能`（`skill_offer_accept`）**：
     - 状态原子置为 `saving`，直接调用 `connectorProtocol.repoSkillOp(deviceId, { action: "write", scope: { kind: "repo", repoId }, target, slug, markdown, overwrite: false })`；
     - **成功**：状态置为 `saved`，记录 `savedPath` / `savedSha256` 与 `audit("ambient_skill_saved", ...)`，同步更新 `sh_repo.skillIndexJson`，下一单派往该仓的 Worker 立即能在 `renderRepoContextBrief` 中看到并按需读取这份新技能！
     - **机器离线或瞬时失败（`machine_offline` / `busy`）**：状态置为 `failed`（记录 `failureReason`），卡片在 `decisionCards` 中保持可重试打开态（对齐 `prConsent` 模型），机器恢复在线后点一下即可完成写入；
     - **同名冲突（`already_exists`）**：绝不静默覆盖已有文件，返回明确提示引导用户点击「预览与编辑」改名或在控制面合并。
  2. **`预览与编辑`（仅 Web Workspace 前端直达）**：
     - 直接拉起右侧「断点与提炼」弹窗并将 `sh_skill_offer` 中已生成的 `{ slug, target, markdown }` 原地注入编辑器（**零重复 LLM 提炼请求**），方便用户微调措辞、切换 `.claude/skills` / `.claude/commands` 槽位或选写入隔离工作树后再保存。
  3. **`忽略`（`skill_offer_decline`）**：
     - 状态置为 `dismissed` 并记录 `decidedAt`，卡片收起并纳入该仓冷却统计。

## 5. 分阶段实施路线与验证门禁

### Stage 1：派发端确定性注入（打通「存了能用上」）
1. **协议与 Connector**：在 `packages/protocol/src/messages.ts` 为 `RepoSchema` 扩展可选 `projectApproved` 与有界 `skills`（`max 25`）；在 `apps/connector/src/connector-app.ts` 构造 `hello.repos` 时调用轻量本地技能扫描填充（单文件软链异常跳过不阻塞握手）。
2. **Steward 账本与派发器**：
   - 新增 SQLite 迁移 `043_ambient_memory_and_skill_loop`（含 `sh_repo` 的 `projectApproved` / `skillIndexJson` 列及 Stage 3 所需的 `sh_skill_offer` 表，一次迁移到位避免连号碎片）；
   - 在 `connector-protocol.ts` 与 `workspace-api.ts` 的技能列表/写/删回调中实时刷新 `sh_repo.skillIndexJson`；
   - 在 `handoff.ts` 实现 `renderRepoContextBrief`（严格区分已确认约定 vs 待验证观察、过滤 `stale`、附按需 `Read` 技能索引、总长硬卡 `900` 字符并跑 `redactText` + `escapeMarkers`），接入 `Dispatcher.startNewSession`，并在 `extension.ts` 的 `buildBrief` 仓库行补充精简计数提示。
3. **Stage 1 单测门禁**：验证新开 Thread 首棒 `start_worker` 能收到已确认项目记忆与技能相对路径索引、`resumeSession` 不重复注入、`stale` 笔记被剔除、`⟦` 控制标记与敏感串被转义脱敏，且既有 `ledger.test.ts` 全绿。

### Stage 2：收尾顺路记记忆 + 聊天内一键转正（打通「平时无感攒经验」）
1. **唤醒准则升级**：更新 `apps/steward/src/wake-text.ts` 中 `worker_report(done)` 分支，加入克制的项目踩坑事实沉淀条件与硬性禁令（最多 2 条、普通改动不记、固定 `layer="project"` + `source="worker_reported"`）。
2. **轻量记忆确认卡**：
   - 在 `workspace.ts`、`report-template.ts` 与 `steward.ts` 接入 `noteconfirm:<noteId>` 待决卡及 `note_confirm` / `note_remove` 幂等动作；
   - 在 Web Workspace（`cards.js` / `i18n.js`）渲染紧凑双按钮确认条（`确认有效` / `删除`），点击后立即刷新卡片与控制面计数。
3. **Stage 2 门禁**：补齐 `noteconfirm` 确定性确认/删除/幂等重放单测，并跑通 `eval:memory`（验证未确认的 `worker_reported` 记忆绝不跨信任边界泄露或被越权用于自动代答）。

### Stage 3：高摩擦任务自动甄别与「一键存 Skill」提议卡（打通「大坑自动变 SOP」）
1. **旁路甄别引擎**：在 `apps/steward/src/distiller.ts` 新增 `triageRepoSkillCandidate`（L0 确定性门槛校验 + 现有仓库技能查重注入 + L1 `worthSaving` / `confidence === "high"` 否决器 + 写前凭据扫描），由 `steward.ts` 在 `relay` Worker `done` 落定后以非阻塞旁路触发（异常全捕获记审计日志，绝不影响主链）。
2. **`skilloffer` 卡片闭环与前端联动**：
   - 在 `ledger.ts` 实现 `ledger.skillOffers`（创建、频控/72h 退避查询、状态 CAS 流转）；
   - 在 `steward.ts` / `workspace.ts` / `report-template.ts` 接入 `skilloffer:<offerId>` 及 `skill_offer_accept` / `skill_offer_decline` 动作（确认动作直调 `repoSkillOp(write, overwrite: false)`，离线保活可重试，同名冲突安全拦截）；
   - 在 `apps/steward/ui/cards.js`、`checkpoint.js` 与 `i18n.js` 支持卡片渲染及「预览与编辑」免重算直通预填。
3. **全仓收官门禁**：
   - 5 套 TypeScript 工程 `tsc --noEmit` 零错误；
   - `ui-modules.test.ts`（DOM 安全构造、零 `innerHTML`、零内联 `style=`、中英词条与占位符 100% 对称）全绿；
   - `eval:routing:selftest`、`eval:memory`、Node 24 原生 `improvement.test.mjs` 以及 Connector + Steward 全量单测与生产构建全绿。
