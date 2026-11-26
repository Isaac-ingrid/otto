# 2B 仓库技能受控落盘与工作台目录管理实施方案

状态：已落地（Stage 1–3 全部完成，2026-11-19）。关联前序决策：[ADR-0004](../adr/0004-web-workspace.md)（Web Workspace）、[ADR-0016](../adr/0016-dark-instrument-panel-theme.md)（暗色仪表台设计规范）、[ADR-0022](../adr/0022-report-labels-worktree-hooks-and-readonly-proposals.md)（本地信任红线与受控边界），以及已落地的 [2A 记忆与主动调度控制面](./memory-and-proactive-control-plane.md) 与 [中断任务断点快照与 Skill 提炼方案](./worker-checkpoint-and-skill-extraction.md)。

实施顺序：**Stage 1（Protocol + Connector 层：`repo_skill_*` 有界帧、三槽位白名单路径、符号链接阻断、SHA-256 CAS 原子读写与 Git 状态探测） → Stage 2（Steward 层：无状态中继、`sh_web_request` 幂等落盘 API 与只读元数据目录） → Stage 3（Web Workspace 双触点交互：断点提炼面板一键入仓 + 控制面第三标签页「仓库技能」浏览/编辑/新建/删除）**。

## 1. 背景与真实痛点

在上一阶段落地 [`distiller.ts`](../../apps/steward/src/distiller.ts) 与 [`checkpoint.js`](../../apps/steward/ui/checkpoint.js) 后，Owner 已经能从任意完成或中断的 Worker 轨迹中旁路提炼出标准 `SKILL.md` 草稿，但最后一公里仍存在三处明显断层：

1. **提炼产出与目标仓库之间仍需手工搬运**：目前 `checkpoint.js` 仅支持浏览器 `Blob` 下载 `<slug>-SKILL.md` 或复制全文。若目标仓库跑在远端开发机、VPS 或隔离的 Worker 工作树中，Owner 还需手动 SSH 创建 `.agents/skills/<slug>/SKILL.md` 或 `.claude/commands/<slug>.md`。
2. **工作台看不见已注册仓库里有哪些现成技能**：各台已连接机器的注册仓库中可能已沉淀了多份项目级技能或斜杠命令，但 Web Workspace（无论是控制面还是机器弹窗）均无只读目录视图，也看不出某份技能当前是已提交（`clean`）、本地已改（`modified`）还是未入库（`untracked`）。
3. **多编码 Agent 的技能发现与本地信任差异缺乏透明提示**：根据实测结论（[`pi-integration.md`](../research/pi-integration.md) §3），`codex` 与 `claude-code` 会在启动 `cwd` 下直接发现对应目录的技能/命令，而 `pi` 将 `.agents/skills` 列为受保护资源——在默认 `--no-approve` 下不加载，需机器本机执行 `otto repo-config <path> --approve` 后才生效。工作台需要把这一事实诚实呈现给 Owner，而不是让用户误以为写入即对所有 Agent 生效。

## 2. 现状盘点（复用既有底座，零新增 SQLite 迁移）

| 模块 | 已有能力 | 本轮复用方式 | 代码位置 |
| --- | --- | --- | --- |
| Skill 草稿提炼 | `POST /app/api/workers/:workerId/distill`（`mode: "skill"`）已返回 `{ repoId, skill: { slug, name, description, markdown } }` | 直接在 `checkpoint.js` 复用 `repoId`、`slug` 与编辑器中的 `skillMarkdownDraft` 发起受控入仓 | [`apps/steward/src/distiller.ts`](../../apps/steward/src/distiller.ts)、[`apps/steward/ui/checkpoint.js`](../../apps/steward/ui/checkpoint.js) |
| 仓库注册与信任摘要 | `040_repo_hook_capabilities` 已在 `sh_repo` 持久化 `capabilityKind`（`git` / `plain`）与 `approved` 布尔位，并随 `hello.repos` 同步 | 零新增数据库表或迁移：磁盘仓库本身就是技能唯一事实源，Steward 不双写技能正文到 SQLite | [`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)、[`packages/protocol/src/messages.ts`](../../packages/protocol/src/messages.ts) |
| 有界 WS 请求中继 | `ConnectorProtocol` 已成熟运行 `directory_list`、`worker_diff`、`worker_checkpoint` 有界请求/响应模式（`32` 并发上限 + 超时回收 + 断线快退） | 同构扩展 `repoSkills` 能力位与有界读写中继，机器离线时立即返回 `409 machine_offline` 而非盲目入队 | [`apps/steward/src/connector-protocol.ts`](../../apps/steward/src/connector-protocol.ts) |
| 控制面弹窗骨架 | `control-plane.js` 已挂载 `#dialog.control-dialog`（含 `记忆` 与 `主动调度与盯盘` 双标签及仓库选择器） | 在同一控制面弹窗平滑新增第 3 个标签页「仓库技能」，无需在顶栏增加新入口图标 | [`apps/steward/ui/control-plane.js`](../../apps/steward/ui/control-plane.js) |

## 3. 核心安全边界、信任红线与排除范围

因为仓库技能文件会被后续编码 Agent（`pi`、`claude-code`、`codex`）直接读入系统提示词或命令上下文，其写权限等价于**跨会话持久化指令注入面**，必须执行以下 7 条硬性边界：

1. **严格限定已注册目录与活动写工作树，严禁触碰用户主目录**：
   - Connector 仅允许操作 `LocalStore.getRepo(repoId)` 中已注册仓库的规范化根目录（`writeScope: "repo"`），或属于该仓库且处于未清理状态的写模式 Worker 隔离工作树（`writeScope: "worktree"`）。
   - **严禁读写机器全局目录**（如 `~/.claude/skills`、`~/.codex/skills`、`~/.pi/agent/skills`、`~/.otto/hooks`），防止单项目操作污染整机全局 Agent 行为。
2. **三槽位固定白名单 + 纯单文件 Markdown（零可执行脚本）**：
   - 仅允许下表 3 类受控目标槽位（`RepoSkillTarget`），禁止任意自定义相对路径，禁止附带 `.sh` / `.py` / `.js` 脚本，禁止触碰 `.pi/extensions`、`.pi/mcp.json`、`.claude/settings.json` 或 `.git/`：
     - `"agents-skill"`（默认推荐）：`<root>/.agents/skills/<slug>/SKILL.md`（通用 Agent Skills 标准，`codex` 原生识别，`pi` 在 `approved=true` 时识别，亦与本仓既有 `.agents/skills/` 约定一致）；
     - `"claude-skill"`：`<root>/.claude/skills/<slug>/SKILL.md`（Claude Code 项目级 Skill）；
     - `"claude-command"`：`<root>/.claude/commands/<slug>.md`（Claude Code 项目斜杠命令）。
   - `slug` 强校验正则：`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`（1–64 位小写字母、数字与连字符，天然阻断 `..`、`/`、`\`、隐藏前缀 `.` 与空白字符）。
3. **逐段 `lstat` 符号链接阻断与 `realpath` 逃逸校验**：
   - 写入、读取或删除前，先对 `root` 取 `realpath`；随后逐级 `lstat` 检查 `.agents`、`.agents/skills`、`.agents/skills/<slug>`（或 `.claude/...`）及目标文件本身。
   - 只要任一已存在中间目录或目标文件本身为符号链接（`isSymbolicLink() === true`），或已存在父目录 `realpath` 越出 `root + sep`，立即拒绝并返回 `symlink_forbidden`，彻底封死恶意仓库通过软链指向 `~/.ssh` 或系统文件的越界读写。
4. **Owner Web UI 独占写删权限（零 Steward LLM 写工具）**：
   - Steward 主对话模型（含用户轮次、`⟦event⟧`、`⟦routine⟧`、`⟦followup⟧`）**不挂载任何写入或删除技能的工具**，杜绝模型被不可信网页或报错日志诱导后自行持久化篡改仓库技能。
   - 所有写入（`POST /app/api/repos/skills/write`）与删除（`POST /app/api/repos/skills/delete`）仅能由登录后的 Owner 在浏览器通过同源 `Origin` + `X-CSRF-Token` + 请求幂等键发起。
5. **SHA-256 乐观并发控制（CAS），绝不静默覆盖**：
   - 新建/提炼入仓默认 `overwrite: false`：若目标文件已存在，Connector 返回 `409 already_exists` 及当前文件的 `sha256`，前端显式弹出覆盖确认后携带 `expectedSha256` 重试；
   - 在线编辑保存与删除均强制携带读取时的 `expectedSha256`：若磁盘文件期间被本地编辑器或 `git pull` 修改导致哈希不一致，立即返回 `409 sha256_conflict` 阻止误覆盖。
6. **写前凭据泄露拦截与只读脱敏**：
   - Connector 在落盘前对待写入 Markdown 运行敏感串检测（覆盖 Connector 设备令牌与 `redact.ts` 高置信密钥模式）：命中则拒绝落盘并返回 `400 secret_detected`（防误把明文 API Key 写进会入 Git 的 `SKILL.md`）；
   - 若为 Steward 提供只读目录查询，仅暴露截断后的 `slug`、`name`、`description` 元数据并经 `redactText` + `escapeMarkers` 清洗。
7. **恪守 ADR-0022 本地信任不变量**：
   - 写入 `.agents/skills/<slug>/SKILL.md` 绝不顺带修改 `connector.sqlite` 中的 `repo.approved`；若 `repo.approved === false`，前端仅展示清晰的本机授权命令提示（`otto repo-config <path> --approve`）。

### 明确不做（排除项）
- **不做多文件离线技能压缩包（ZIP/目录递归上传）或远程 Skill 市场拉取**：聚焦纯文本单文件 `SKILL.md` / 命令模板的可控沉淀与维护。
- **不在机器离线时将文件写删排入持久化 `outbox` 延迟执行**：避免数小时后机器上线时静默覆盖用户离线期间的本地修改；离线一律即时返回 `409 machine_offline`（前端保留本地下载 `SKILL.md` 兜底）。

## 4. 模块一：Protocol 与 Connector 受控技能读写引擎（Stage 1）

### 4.1 协议契约（[`packages/protocol/src/repo-skills.ts`](../../packages/protocol/src/index.ts)）
对齐 `worker_diff` 与 `worker_checkpoint`，在 `HelloMessage.capabilities` 新增 `repoSkills: z.boolean().optional()`，并定义统一的有界操作帧对 `repo_skill_op` → `repo_skill_result`（单文件体积上限 `REPO_SKILL_MAX_BYTES = 32 * 1024`，列表上限 `REPO_SKILL_MAX_ITEMS = 100`，列表总字节上限 `48 * 1024`，单次超时 `REPO_SKILL_TIMEOUT_MS = 8_000`）：

- **目标槽位枚举 `RepoSkillTarget`**：`"agents-skill" | "claude-skill" | "claude-command"`
- **目标范围 `RepoSkillScope`**：
  - `{ kind: "repo", repoId: string }`（直接作用于注册仓库根目录 `repo.path`）
  - `{ kind: "worktree", repoId: string, workerId: string }`（仅作用于归属该 `repoId` 且存在未清理写模式工作树的 `worker.worktree`）
- **四类原子动作（`action` 判别联合）**：
  1. **`list`**：扫描该根目录下的三个标准槽位，解析每份技能的 YAML frontmatter（提取 `name`、`description`；若无 frontmatter 则回退首个一级标题与首段摘要），返回 `RepoSkillSummary[]`：
     - `{ target, slug, relativePath, name, description, bytes, updatedAt, sha256, gitStatus: "clean" | "modified" | "untracked" | "plain" }`
  2. **`read`**：按 `{ scope, target, slug }` 读取单份技能完整 UTF-8 文本，返回 `{ summary: RepoSkillSummary, markdown: string }`（超 `32 KiB` 返回 `too_large`）。
  3. **`write`**：按 `{ scope, target, slug, markdown, overwrite?: boolean, expectedSha256?: string }` 受控落盘：
     - 校验 `markdown` UTF-8 字节数（非空且不超 `32 KiB`），归一化 LF 换行并确保末尾单个 `\n`；
     - 执行敏感凭据扫描（命中设备令牌或高置信密钥串返回 `secret_detected`）；
     - 若文件不存在：创建白名单父目录（`0755`，仅当父路径无软链）并通过同目录临时文件 `.<slug>.<ulid>.otto-tmp` + `rename` 原子落盘（`0644`）；
     - 若文件已存在：当 `expectedSha256` 存在时比对当前磁盘文件 SHA-256（不匹配返回 `sha256_conflict`）；当未传 `expectedSha256` 且 `overwrite !== true` 时返回 `already_exists`（附当前 `existingSha256`）；匹配或显式确认覆盖后原子替换，返回最新 `RepoSkillSummary`。
  4. **`delete`**：按 `{ scope, target, slug, expectedSha256 }` 校验当前磁盘 SHA-256 一致后删除目标 Markdown 文件；若为 `agents-skill` 或 `claude-skill` 且其专属 `<slug>/` 子目录删除后为空，顺带调用 `rmdir` 回收空目录（若含其他文件则保留目录不误删）。

- **标准错误码集合**：
  `"not_found" | "not_registered_repo" | "no_worktree" | "invalid_slug" | "symlink_forbidden" | "too_large" | "secret_detected" | "already_exists" | "sha256_conflict" | "busy" | "io_failed"`。

### 4.2 Connector 路径安全与 Git 状态采集（`apps/connector/src/repo-skills.ts`）
1. **零软链逐段校验器 `resolveSafeSkillPath(rootDir, target, slug)`**：
   - 先校验 `SKILL_SLUG_RE.test(slug)`，映射出固定相对路径段（如 `[".agents", "skills", slug, "SKILL.md"]`）；
   - `realRoot = await realpath(rootDir)`；随后从 `realRoot` 起逐段 `lstat`：凡已存在的段若 `isSymbolicLink()` 为真立即抛 `symlink_forbidden`；对已存在的最深父目录再做一次 `realpath` 前缀断言（必须等于 `realRoot` 或以 `realRoot + sep` 开头）。
2. **轻量单目录 Git 状态聚合**：
   - 若对应仓库 `capability.kind === "git"`，在 `list` / `write` 时调用单次 `execFile("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".agents/skills", ".claude/skills", ".claude/commands"], { cwd: rootDir, timeout: 3000 })`（无 `shell: true`）：
     - 输出以 `??` 开头记为 `"untracked"`；输出含 `M` / `A` / `R` 记为 `"modified"`；无输出记为 `"clean"`；
   - 非 Git 普通目录（`capability.kind === "plain"`）统一返回 `"plain"`。

## 5. 模块二：Steward 中继、Web API 与只读感知（Stage 2）

### 5.1 `ConnectorProtocol` 有界中继与断线回收
在 [`connector-protocol.ts`](../../apps/steward/src/connector-protocol.ts) 新增 `repoSkillOps` 挂起表（共享 `32` 并发上限、`8s` 超时，并在 `cancelReadsForConnection` / `cancelReadsForDevice` 中统一挂断返回 `machine_offline`）：
- 路由校验：Steward 先在账本核验 `sh_repo` 是否真实归属某台未吊销设备（若 `scope.kind === "worktree"`，还核验 `worker.repoId === repoId` 且 `worker.deviceId` 一致），再将帧发往对应设备的在线连接；若连接不存在返回 `409 machine_offline`，若旧版 Connector 未上报 `capabilities.repoSkills` 返回 `409 unsupported`。

### 5.2 Web Workspace 受控路由（[`apps/steward/src/workspace-api.ts`](../../apps/steward/src/workspace-api.ts)）
全部置于会话 Cookie + 同源 `Origin`（加入 `requireOrigin` 强制名单）+ `X-CSRF-Token` 门禁之后：

| 路由 | 方法 | 幂等与预算规则 | 用途 |
| --- | --- | --- | --- |
| `/app/api/repos/skills/list` | `POST` | 纯确定性只读、零模型消耗、预算超限仍可用 | 列出指定 `{ deviceId, repoId, workerId? }` 下的全部仓库技能摘要及该仓库 `approved` / `capabilityKind` 状态 |
| `/app/api/repos/skills/read` | `POST` | 纯确定性只读、零模型消耗 | 读取单份技能全文与当前 `sha256` 供在线预览或编辑 |
| `/app/api/repos/skills/write` | `POST` | 强制校验客户端请求幂等键 `id`（记入 `sh_web_request` `skill-write:<id>`）并写入 `audit("web_repo_skill_written", ...)` | 将提炼草稿、新建模板或编辑后的 `SKILL.md` 受控落盘（冲突透传 `409 already_exists` / `409 sha256_conflict`） |
| `/app/api/repos/skills/delete` | `POST` | 强制校验请求幂等键 `id`（`skill-delete:<id>`）+ `expectedSha256` + `audit("web_repo_skill_deleted", ...)` | 安全移除指定技能文件并回收空子目录 |

同时，在 [`control-plane.ts`](../../apps/steward/src/control-plane.ts) 的 `readMemoryControlPlane` 中为每个已注册仓库补齐 `{ id, name, deviceId, machine, online, capabilityKind, approved }` 字段，使前端无需猜测某仓库是否在线或是否已在 `pi` 中开启 `--approve`。

### 5.3 Steward 只读感知工具（严守零写边界）
在 [`extension.ts`](../../apps/steward/src/llm/extension.ts) 仅新增一个**纯只读工具** `list_repo_skills(repoRef)`（`replay: "safe"`，不计入 `externalActionTools`）：
- 当用户在对话中询问「这个仓库里现在有哪些 skill 可以用？」时，Steward 可向在线机器查询该仓库的技能摘要列表（仅返回 `slug`、`target`、`name` 与截断至 160 字且经 `redactText` + `escapeMarkers` 清洗的 `description`，不拉取全文），据此准确回答或在派工 `prompt` 中点名使用对应技能；
- Steward **没有任何写/改/删技能的工具**，任何修改诉求均引导用户在控制面「仓库技能」或「断点与提炼」面板确认落盘。

## 6. 模块三：Web Workspace 双触点交互设计（Stage 3）

全部前端实现严格遵循 [`dom.js`](../../apps/steward/ui/dom.js) 的 `h()` 纯文本节点构造、零 `innerHTML`、零内联 `style=` 属性以及 [`ui-modules.test.ts`](../../apps/steward/test/ui-modules.test.ts) 的中英词条与占位符 100% 对称门禁。

### 6.1 触点 A：断点与提炼弹窗内「一键写入仓库」（[`apps/steward/ui/checkpoint.js`](../../apps/steward/ui/checkpoint.js)）
在 `renderDistillSection()` 的 `SKILL.md` 预览编辑框下方（紧邻现有的「下载 SKILL.md」与「复制全文」）：
1. **当该 Worker 绑定的仓库已注册且所在机器在线时**，展示紧凑的入仓工具条：
   - **技能标识输入框（`slug`）**：默认带入 `sd.skill.slug`，前端实时按 `SKILL_SLUG_RE` 归一化提示；
   - **槽位下拉框（`target`）**：默认 `.agents/skills/<slug>/SKILL.md`（标注通用推荐），可选 `.claude/skills/<slug>/SKILL.md` 或 `.claude/commands/<slug>.md`；
   - **写入位置选择（`scope`）**：默认「写入主仓库目录」；若当前 Worker 为写模式且隔离工作树仍处于 `active` 状态，额外可选「仅写入当前 Worker 工作树（随分支 PR 提交）」，不污染主检出区；
   - **`pi` 本地信任透明提示**：若选定 `.agents/skills` 且该仓库 `approved === false`，展示温和提示条说明 `Codex 可直接识别；pi 需在本机执行 otto repo-config <path> --approve 后加载项目技能`。
2. **同名冲突二次确认**：若首次保存返回 `409 already_exists`（带 `existingSha256`），在按钮下方就地展开「仓库已存在同名技能：确认覆盖 / 修改名称」操作条，用户点击「确认覆盖」后携带 `expectedSha256` 完成 CAS 替换。
3. **机器离线降级**：当机器离线时禁用入仓按钮并提示「机器当前离线，可先下载本地 `SKILL.md`」。

### 6.2 触点 B：控制面弹窗第 3 标签页「仓库技能」（[`apps/steward/ui/control-plane.js`](../../apps/steward/ui/control-plane.js)）
在 `#dialog.control-dialog` 顶部标签栏并列呈现 **`记忆` | `主动调度与盯盘` | `仓库技能`**（并在「机器 / Machines」弹窗的已注册仓库行旁提供「查看技能」快捷跳转，一键切到该仓库）：
1. **顶部仓库筛选与状态栏**：
   - 仓库下拉选择器（展示 `仓库名 (机器名)` 及在线绿点 / 离线灰点）；
   - 状态徽章：展示 `Git / Plain` 类型、发现的技能总数，以及 `pi 项目信任：已授权 / 未授权（--no-approve）` 徽章。
2. **技能清单卡片流**：
   - 每张卡片展示 `name`（及 `slug`）、目标路径徽章（`.agents/skills` / `.claude/skills` / `.claude/commands`）、Git 状态徽章（`已提交` / `未提交修改` / `未跟踪`）、字节数与最后修改时间，以及 `description` 摘要；
   - 卡片操作：**查看 / 编辑**（就地展开纯文本 `textarea` 编辑器，保存时自动附带读取时的 `sha256` 做 CAS 保护）、**复制全文**、**下载导出**、**删除**（就地二次确认，附带 `expectedSha256` 安全删除并回收空目录）。
3. **新建 / 导入外部技能表单**：
   - 点击顶部 **「+ 新建技能」** 展开轻量表单（填写 `slug`、选择 `target` 槽位、预填标准 YAML frontmatter 模板或粘贴现成 `SKILL.md`），一键受控落盘至目标仓库。

## 7. 分阶段实施路线与验证门禁

1. **Stage 1（Protocol + Connector 层）**：
   - 新增 `packages/protocol/src/repo-skills.ts`（Zod schema、帧常量与 `HelloMessage.capabilities.repoSkills`）；
   - 新增 `apps/connector/src/repo-skills.ts` 实现三槽位白名单映射、逐段 `lstat` 软链阻断、UTF-8 体积与凭据泄露检查、SHA-256 CAS 原子写入/空目录回收及 `git status --porcelain` 状态聚合，接入 `ConnectorClient`；
   - 补齐 `apps/connector/test/repo-skills.test.ts`：覆盖三槽位列表/读取/新建/CAS 编辑/删除空目录回收、非法 `slug`（`..`、`/`、大写、空串）拦截、父级或文件软链越界拦截（`symlink_forbidden`）、并发修改 `sha256_conflict` 拦截及明文 Token 写入拦截（`secret_detected`）。
2. **Stage 2（Steward 中继、Web API 与只读感知层）**：
   - 在 `connector-protocol.ts` 接入 `repoSkillOps` 有界中继与断线清理；
   - 在 `workspace-api.ts` 落地 `/app/api/repos/skills/{list,read,write,delete}` 四条路由（含同源 `Origin`、CSRF、`sh_web_request` 请求幂等键与审计日志），并在 `control-plane.ts` 补齐注册仓库的 `online` / `approved` / `capabilityKind` 元数据；
   - 在 `extension.ts` 挂载只读工具 `list_repo_skills(repoRef)`（严格无写/删工具）；补齐 `apps/steward/test/repo-skills.test.ts` 与 `routes-audit.test.ts` 未登录鉴权门禁。
3. **Stage 3（Web Workspace 双触点 UI 与全仓门禁）**：
   - 扩展 `apps/steward/ui/checkpoint.js` 支持提炼结果一键入仓（主仓库 / 当前工作树切换、同名覆盖确认、`pi` 信任提示）；
   - 扩展 `apps/steward/ui/control-plane.js` 新增「仓库技能」标签页（浏览、在线 CAS 编辑、新建、下载与二次确认删除）及 `workspace.js` 机器弹窗跳转入口，补齐 `i18n.js` 中英双语词条；
   - 跑通 `ui-modules.test.ts`（注意不在 `t(...)` 内嵌单引号字面量）、5 套 `tsc --noEmit`、Node 原生 `improvement.test.mjs`、Connector + Steward 生产打包及核心回归套件。
