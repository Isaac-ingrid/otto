# Otto 从 agent-autoloop 采纳的改进方案

状态：阶段 1 实施中（2026-11-24）；共分 5 个独立可交付阶段推进。

范围与顺序决定（2026-11-24 已拍板）：
1. **双轨兼顾**：既面向日常主力 `pi` + 多 API / Coding 套餐提供方（DeepSeek、`zai-coding-cn`、OpenAI 兼容网关）落地细粒度限流挂起与活进程补报，也保留并补齐**除 Gemini CLI 以外**的外围 CLI 生态补丁（`codex`、`claude-code`、基于 ACP 的 `opencode` / `agentica`，以及通用 `command` 接入 `dsh` / `zcode` / `cursor`）。
2. **明确排除 Gemini CLI 与个人 Google OAuth 套壳**：2026 年 6 月 18 日起 Google 已停止 Gemini CLI 对免费及 AI Pro / Ultra 个人订阅的服务（[google-gemini/gemini-cli#27274](https://github.com/google-gemini/gemini-cli/discussions/27274)），并严禁第三方编排工具复用 Gemini CLI / Antigravity 个人 OAuth 登录态（[google-gemini/gemini-cli#20632](https://github.com/google-gemini/gemini-cli/discussions/20632)，违规触发 `403` 封禁）。因此本方案彻底排除 `gemini --acp` 接入及任何个人 OAuth 套壳引导。
3. **离线契约测试桩（Contract Fixtures）门禁**：针对开发机未登录 Claude / Codex 实账号的情况，所有外围 CLI 改动必须将 [KKKKhazix/agent-autoloop](https://github.com/kkkkhazix/agent-autoloop) 实测验证过的协议事件流固化到 `fake-claude.mjs`、`fake-codex.mjs` 等本地测试桩中完成确定性回归验证，并在 `hello.agents` 增加无损登录态预检，避免把任务误派给未登录的外围 CLI。
4. **实施顺序**：**阶段 1（限流冷却挂起、单次补报重写与 Codex / Claude 细节修补） → 阶段 2（OpenCode / Agentica ACP 桥与通用 Command 适配器） → 阶段 3（零 Token 本地探针 `probe`、`autoHops` 8 跳熔断与暂停 `replay`） → 阶段 4（PR Watch 卡死检测与零检出交叉盲审） → 阶段 5（飞书 `lark-cli` 免公网交互卡、Connector 桌面通知与单向 Webhook 签名审批）**。

## 1. 来源与对照基线

参考仓库为 [KKKKhazix/agent-autoloop](https://github.com/kkkkhazix/agent-autoloop)（MIT 许可证，零运行时依赖的命令行 Agent 后台调度中台）。对照的一手源码与协议文档包括：
- 内核与协议规范：[README.md](https://github.com/KKKKhazix/agent-autoloop/blob/main/README.md)、[docs/protocol.md](https://github.com/KKKKhazix/agent-autoloop/blob/main/docs/protocol.md)、[SECURITY.md](https://github.com/KKKKhazix/agent-autoloop/blob/main/SECURITY.md)、[skills/agent-autoloop/SKILL.md](https://github.com/KKKKhazix/agent-autoloop/blob/main/skills/agent-autoloop/SKILL.md)
- 插件契约与最小模板：[docs/plugins.md](https://github.com/KKKKhazix/agent-autoloop/blob/main/docs/plugins.md)、[examples/plugins/hello-agent/agent.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/examples/plugins/hello-agent/agent.ts)
- 内置 Agent 插件：[plugins/codex/agent.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/plugins/codex/agent.ts)、[plugins/acp/agent.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/plugins/acp/agent.ts)、[plugins/dsh/agent.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/plugins/dsh/agent.ts)、[plugins/command/agent.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/plugins/command/agent.ts)
- 内置通道、事件与巡检模板：[plugins/feishu/channel.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/plugins/feishu/channel.ts)、[plugins/desktop/channel.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/plugins/desktop/channel.ts)、[plugins/github/source.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/plugins/github/source.ts)、[plugins/gitlab/source.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/plugins/gitlab/source.ts)、[examples/recipes/website-watch/README.md](https://github.com/KKKKhazix/agent-autoloop/blob/main/examples/recipes/website-watch/README.md)

## 2. 现状核查：Otto 已有（不重造）与真实缺口

| 对照维度 | Otto 现状 | 位置 | 本方案处理 |
| --- | --- | --- | --- |
| 对话协调与工作区隔离 | Steward 对话主循环 + Git `worktree` 写隔离与脏目录体检（`048`）+ 实时上下文水位线（`047`）+ 三路独立停止 | [`CONTEXT.md`](../../CONTEXT.md)、[`apps/connector/src/worktree-audit.ts`](../../apps/connector/src/worktree-audit.ts) | **保持现状**，不退回静态 `rules.json` 引擎 |
| 限流与额度耗尽分类 | `classifyError` 将 `usage limit / quota` 归为 `auth`，`WorkerManager` 直接标 `broken (error:auth)`；`429` 归为 `transient`（30s 后盲目重试 2 次即 `broken`） | [`apps/connector/src/adjudication.ts`](../../apps/connector/src/adjudication.ts)、[`apps/connector/src/worker-manager.ts`](../../apps/connector/src/worker-manager.ts) | **阶段 1 改造**：拆出 `rate_limited` + `limitedUntil`，Steward 按 `(deviceId, scopeKey)` 冷却挂起、到期恢复 |
| 崩溃起点判据与漏报回执 | `pi` 已有本地 `sessionFile` 写前标记；但 `claude` 预计算 UUID 无法区分「未接提示词」与「中途崩溃」，且 `pi` / `claude` / `codex` 漏调 `report` 工具直接落 `unreported` | [`apps/connector/src/pi-adapter.ts`](../../apps/connector/src/pi-adapter.ts)、[`apps/connector/src/claude-adapter.ts`](../../apps/connector/src/claude-adapter.ts)、[`apps/connector/src/codex-adapter.ts`](../../apps/connector/src/codex-adapter.ts) | **阶段 1 改造**：补 `promptAccepted` 落盘位；三端遇无错 `unreported` 执行最多 1 次原会话只读补报 |
| Codex / Claude 边界细节 | `CodexAdapter` 仅过滤 `"Reconnecting"` 前缀错误，其他中途恢复的 `error` 事件会提前 `settle` 判败；`ClaudeAdapter` 硬编码 `readonly: false` 且结算 `usage.tokens.input` 未含缓存读写 Token | [`apps/connector/src/codex-adapter.ts`](../../apps/connector/src/codex-adapter.ts)、[`apps/connector/src/claude-adapter.ts`](../../apps/connector/src/claude-adapter.ts) | **阶段 1 改造**：修齐非致命 `error` 清除、桌面二进制路径、Windows 沙箱单文件 ACL、Claude `plan` 只读模式与缓存 Token 口径 |
| 高频巡检成本与自治跳数上限 | `RoutineService` 仅有零 LLM 的 `digest` 与每次必唤醒 Steward 的 `instruction`；`proposalDepth` 仅限制同轮只读子探针，未限制跨轮 `followup`/接力自治总跳数 | [`apps/steward/src/routines.ts`](../../apps/steward/src/routines.ts)、[`apps/steward/src/ledger.ts`](../../apps/steward/src/ledger.ts) | **阶段 3 改造**：新增零 Token 本地探针 `probe`、跨轮 `autoHops <= 8` 熔断、暂停跳过与 `replay` |
| PR 跟进与外部通知通道 | `PrWatchService` 已有 `044` CI 日志诊断与 `045` 评审/冲突分诊；`003_channel_feishu` 与 `channel/types.ts` 仅有表结构与接口定义，尚无免公网飞书卡片及本地桌面通知实现 | [`apps/steward/src/pr-watch.ts`](../../apps/steward/src/pr-watch.ts)、[`apps/steward/src/channel/types.ts`](../../apps/steward/src/channel/types.ts) | **阶段 4 & 5 改造**：补 CI 10 分钟零检查卡死提醒、裸 Git diff 盲审、飞书 `lark-cli` 长连接卡片与桌面通知 |

## 3. 阶段 1：限流冷却挂起、单次补报重写与 Codex / Claude 细节修补

### 3.1 `rate_limited` 错误分类与 `limitedUntil` 提取

- **错误分类拆分（[`apps/connector/src/agent.ts`](../../apps/connector/src/agent.ts)、[`apps/connector/src/adjudication.ts`](../../apps/connector/src/adjudication.ts)）**：
  1. `ErrorClass` 扩展为 `"auth" | "rate_limited" | "transient" | "context" | "stall" | "unknown"`。
  2. 硬性鉴权或账户欠费停机（`401`、`403`、`unauthorized`、`forbidden`、`invalid api key`、`402`、`payment required`、`billing`、`insufficient balance/credits`、`out of credits`、`credit balance`）保持分类为 `"auth"`（不自动恢复，需人工修凭据或充值）。
  3. 订阅窗口或配额速率上限（`usage_limit_reached`、`usage limit`、`quota exceeded`、`exceeded your current quota`、`rate_limit`、`rate limit`、`too many requests`、`429` 且携带窗口重置提示或超过瞬时重试阈值）分类为 `"rate_limited"`。
  4. 新增纯函数 `extractRateLimitResetAt(message: string, nowMs: number, explicitResetAt?: number | null): number | undefined`：
     - 优先采用适配器从结构化事件提取的精确时间戳（例如 Claude Code `rate_limit_event` 中的 `resetsAt` / `reset_at` ISO 或 Unix 时间戳，Codex `rate_limits` / 错误载荷中的 `resets_at` / `retry_after_seconds`）；
     - 其次解析错误文本中的 ISO 时间戳、`retry after <N>s/m/h`、`resets in <N>m/h` 或 `until <HH:mm>`；
     - 若明确命中窗口额度耗尽（如 `usage limit` / `usage_limit_reached` / Coding 套餐窗口耗尽）但未给出具体恢复时刻，默认回退为 `nowMs + 60 * 60_000`（1 小时）；
     - 边界护栏（对齐 [docs/protocol.md](https://github.com/KKKKhazix/agent-autoloop/blob/main/docs/protocol.md)）：`limitedUntil` 必须满足 `limitedUntil > nowMs` 且 `limitedUntil <= nowMs + 8 * 86_400_000`（超过 8 天视为脏解析忽略）。
- **Connector 结算行为（[`apps/connector/src/worker-manager.ts`](../../apps/connector/src/worker-manager.ts)）**：
  - `settled` 事件新增可选 `limitedUntil?: number`（毫秒时间戳）。
  - 当 `outcome === "error" && errorClass === "rate_limited"` 时，Connector **不将 Worker 标为终态 `broken`**，也不走 30 秒本地盲目 `scheduleAutoResume`，而是将 Worker 置为 `idle`（`lastOutcome = "error:rate_limited"`），保留会话文件与 worktree，释放仓库串行写槽位，将恢复调度权交给 Steward 的冷却表。

### 3.2 Steward 双粒度冷却表与到期自动恢复（迁移 `050_quota_hold_and_cooldown`）

- **表结构演进（[`apps/steward/src/schema.ts`](../../apps/steward/src/schema.ts)）**：
  - 新增迁移 `050_quota_hold_and_cooldown`，创建 `sh_agent_cooldown`：
    - `deviceId TEXT NOT NULL`
    - `scopeKey TEXT NOT NULL`（对于 `pi` 取 `pi:<provider>`，如 `pi:zai-coding-cn`、`pi:deepseek`，无模型前缀时回退 `pi:default`；对于外围 CLI 取 `agent:<kind>`，如 `agent:claude-code`、`agent:codex`）
    - `agent TEXT NOT NULL`
    - `provider TEXT`
    - `limitedUntil INTEGER NOT NULL`
    - `reason TEXT NOT NULL`
    - `notifiedAt INTEGER`
    - `parkedWorkersJson TEXT NOT NULL DEFAULT '[]'`（记录因该冷却窗口暂停待恢复的 `{ workerId, threadId }` 列表）
    - `updatedAt INTEGER NOT NULL`
    - `PRIMARY KEY (deviceId, scopeKey)`
- **归约与派发联动（[`apps/steward/src/ledger.ts`](../../apps/steward/src/ledger.ts)、[`apps/steward/src/dispatch.ts`](../../apps/steward/src/dispatch.ts)、[`apps/steward/src/steward.ts`](../../apps/steward/src/steward.ts)）**：
  1. **归约写入**：`applyEvent` 的 `case "settled"` 收到 `errorClass === "rate_limited"` 时，将 Worker 置为 `idle`（不置 `broken`），计算 `scopeKey` 并写入/延长 `sh_agent_cooldown`（同一冷却窗口内不重复推送打扰卡片，仅当新的 `limitedUntil` 晚于已记录值超过 60 秒时更新并通知）；若为主线 `relay` Worker，将其加入 `parkedWorkersJson`。
  2. **派发拦截与优雅提示**：`Dispatcher.startWorker` 派发前检查目标 `(deviceId, scopeKey)` 是否处于未过期的冷却窗口。若命中冷却，拒绝盲目下发并给出明确恢复时间（若同机有其他未冷却的可用模型/Agent，提示可切换模型或等待到期自动恢复）。
  3. **手动试跑提前解除**：若某个会话在同一 `(deviceId, scopeKey)` 下成功产出 `started` / `report`（或 `settled:reported`），自动清除对应的 `sh_agent_cooldown` 行。
  4. **DO Alarm 到期自动恢复**：`Steward` 的统一 Alarm 循环包含 `MIN(limitedUntil)`；到期后事务性清除已过期的 `sh_agent_cooldown` 行，记录 timeline，并对仍处于 `idle` + `lastOutcome = 'error:rate_limited'` 且所属 Thread 未归档/无冲突运行的 `parkedWorkers` 自动排入恢复唤醒。

### 3.3 `promptAccepted` 会话起点标记与无错 `unreported` 单次只读补报

- **`promptAccepted` 崩溃对账判据（[`apps/connector/src/store.ts`](../../apps/connector/src/store.ts)、[`apps/connector/src/worker-manager.ts`](../../apps/connector/src/worker-manager.ts)）**：
  - `LocalStore` 的 `worker` 表幂等新增 `promptAccepted INTEGER NOT NULL DEFAULT 0`。
  - 新任务 `launchWorker` 初始化时置 `0`；`PiAdapter` 在 `/otto` 提示词 RPC 返回 `handled` 时、`ClaudeAdapter` 在收到 `system/init` 时、`CodexAdapter` 在收到 `turn.started` 时回调置 `1`。
  - `reconcileWorkerTail` 对无本地 `sessionFile` 的无头适配器（`claude-code`、`codex`）不再仅凭预生成的 `sessionId` 盲目 `--resume`：若 `promptAccepted === 0`，直接判定 `startup_interrupted`（任务从未真正进入会话，避免空会话盲目恢复）；仅当 `promptAccepted === 1` 时才进入 `lost` + 原会话 `--resume`。
- **无错 `unreported` 原会话单次补报重写**：
  - 统一常量 `REWRITE_REPORT_PROMPT`：明确指示模型「上一轮已完成工作但未调用 `report` 工具提交结构化回执；请仅根据已完成事实立即调用一次 `report` 工具，严禁修改任何文件、严禁执行命令或发起新探针」。
  - **`PiAdapter`（活进程 RPC 补报）**：在 `settle()` 中，若初判为 `outcome === "unreported"`、进程仍存活、未中止且本轮尚未补报过（`!runtime.reReportAttempted`），自动向当前 `PiProcess` 发送一次 `prompt` 触发补报；补报窗口内若检测到除 `report` 外的任何工具调用（`tool_execution_start` 且 `tool !== "report"`），立即发送 `abort` 终止越界动作并按原 `lastText` 结算为 `unreported`。
  - **`ClaudeAdapter` 与 `CodexAdapter`（原会话 `--resume` 单次补报）**：当进程正常退出（无流错误、未中断、`promptAccepted === 1`）但未捕获有效 `report` 时，在适配器内部使用原 `sessionId`（Claude `--resume <uuid>`，Codex `exec resume <threadId>`）并强制只读沙箱参数自动补跑最多 1 次以回收 `reportFile`，增量 Token 累加进本轮 `usage`；若仍无 `report` 或补跑报错，保留首轮业务 `lastText` 照常结算为 `unreported`（绝不因补回执失败把已完成的业务判成错误重做）。

### 3.4 Codex 与 Claude 适配器细节修补 + 登录态无损预检

- **`CodexAdapter`（对照 [plugins/codex/agent.ts](https://github.com/KKKKhazix/agent-autoloop/blob/main/plugins/codex/agent.ts)）**：
  1. **非致命流 `error` 清除**：收到 `record.type === "error"` 时仅暂存至 `runtime.pendingStreamError`，**不立即调用 `settle()`**；若随后收到 `turn.completed`，清除该暂存错误并正常结算（修复传输层重连闪断导致的误判重跑）；仅当收到 `turn.failed` 或进程退出时尚未 `turn.completed` 才按错误结算。
  2. **macOS 桌面端内置二进制兜底**：默认命令解析找不到全局 `codex` 时，在 `darwin` 下依次回退探测 `/Applications/Codex.app/Contents/Resources/codex` 与 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`。
  3. **Windows 沙箱单文件 ACL 与配置透传**：提供可选 `reasoningEffort` / `serviceTier`（`-c model_reasoning_effort=...`、`-c service_tier=...`）透传能力；在 `win32` 下对临时附件目录按需授予 `CodexSandboxUsers` 只读 ACL，同时确保 Connector `stateDir` 收紧为仅当前用户与 `SYSTEM` 可读。
- **`ClaudeAdapter`（对照 [docs/plugins.md](https://github.com/KKKKhazix/agent-autoloop/blob/main/docs/plugins.md)）**：
  1. **解锁严格只读模式（`readonly: true`）**：当 `spec.mode === "readonly"` 时，不再传 `--dangerously-skip-permissions`，改为传 `--permission-mode plan --tools Read,Grep,Glob,LS,mcp__otto__report,mcp__otto__propose`，并将 `CLAUDE_CAPABILITIES.readonly` 升级为 `true`（使 Claude 也可安全承接只读任务与 `041` 只读探针）。
  2. **缓存输入 Token 结算口径对齐**：结算 `usage.tokens` 时，将 `cache_creation_input_tokens` 与 `cache_read_input_tokens` 计入总 `input`（同时保留 `cachedInputTokens` 明细），与上下文水位线及 Codex 统计口径保持一致。
  3. **环境变量隔离与限流事件提取**：`childEnv` 默认剥离继承自父进程的 `CLAUDE_CODE_*` 变量（防嵌套会话冲突）；流解析监听 `rate_limit_event` 记录 `resetsAt`，供 `usage_limit_reached` 结算时填入精确 `limitedUntil`。
- **无损登录态预检（`authStatus`）**：
  - `packages/protocol/src/messages.ts` 的 `AgentCapabilitySchema` 增加可选 `authStatus?: "ready" | "unauthenticated" | "unknown"`。`detectCodex` 可选附带轻量 `codex login status` 非阻塞检查，使未登录的示例 CLI 在机器面板与自动选路中一目了然，不抢占主力 `pi` 的自动路由。

## 4. 阶段 2–5 路线与设计摘要

### 阶段 2：OpenCode / Agentica ACP 适配器与通用 Command 适配器
- 提炼现有 `antigravity-adapter.ts` 的 JSON-RPC 帧与 MCP 带外回执底座为通用 `AcpAdapter`，原生支持 `opencode acp` 与 `agentica acp`：区分 `session/load`（忽略历史重放）与 `session/resume`，识别 `-32000` / `thread_active_writer` 会话占用返回可重试的 `session_in_use`，按 worktree 真实路径校验 `allow_once` 权限。显式拒绝或告警个人 Google OAuth 下的 `gemini --acp`。
- 新增受本机白名单配置约束的轻量 `CommandAdapter`：单遍回调替换 `{prompt|model|effort|cwd|context}`（防止 `$&` 二次展开），内置 `dsh`（DeepSeek Harness `0.2.2+` `step_end` 累加）与 `zcode` JSON 解析预设。

### 阶段 3：零 Token 本地脚本探针（`probe`）、`autoHops` 8 跳熔断与暂停 `replay`
- **本地探针（迁移 `051_probes_autohops_and_replay`）**：脚本限定于 `~/.otto/probes/` 并经本机 CLI 绑定 SHA-256；`RoutineService` 新增 `kind = "probe"`，探针返回 `{ triggered: false }` 时零 Token 结束，仅 `triggered: true` 时唤醒 Steward。
- **跨轮跳数熔断**：`sh_wake` 与 `sh_run` 增加 `autoHops`；自治事件链（含 `followup` 与自动续跑）逐轮 `+1`，超过 8 跳停派并推 `Needs you` 卡片，仅真人消息或卡片点击重置为 `0`。
- **暂停跳过与补跑**：`sh_routine` 支持 `pausedUntil`；新增 `/owner/in/:source` 纯同步验签 Webhook 转换器（内置 GitHub / GitLab），暂停期命中的事件写入 `sh_skipped_event` 不积压，恢复时支持按 `since` 一键去重 `replay`。

### 阶段 4：PR Watch 卡死自救卡片与零检出交叉盲审
- **CI 卡死识别（迁移 `052_pr_watch_stuck_and_review`）**：同一 `head` 处于 `waiting` 超 10 分钟且 `checks === 0` 时推送一键「转 Draft 再转 Ready」确认卡（遵守 ADR-0019，每 `head` 限一次）。
- **零检出交叉盲审**：Connector 提供裸 Git 对象 `git_pr_diff`（拒绝章鱼合并，不 checkout PR 分支、不跑 hooks）；Steward 优先选同机另一只读 Agent，若仅 `pi` 就绪则开全新零历史只读 `pi` 会话（优先切另一已验证 Provider），按 `blocking / advisory` 两级输出，连续两轮 `blocking` 转交人工拍板。

### 阶段 5：飞书 `lark-cli` 免公网通道、桌面原生通知与单向 Webhook 审批
- Connector 集成跨平台零依赖系统通知（macOS `osascript --`、Windows Base64 UTF-16LE PowerShell `NotifyIcon`、Linux `notify-send`，自动检测活跃图形会话，SSH 无头静默跳过）。
- Steward 接入基于 `@larksuite/cli` 长连接的飞书 Schema 2.0 交互卡（全宽自动换行选项容器 + 底部多行文本表单 + 原位 `patch` 失败带版本号幂等补发）。
- 新增钉钉、企微、Slack、Discord、Telegram 单向 Webhook 推送（全角转义防误触发 `@everyone`），复用 `009_web` 的 `sh_web_link` 附带 7 天有效免脚本审批链接。

## 5. 验证门禁约定

每阶段完成后均须通过：
1. 新增/更新的确定性契约单测（含 `fake-pi`、`fake-claude`、`fake-codex` 离线故障与边界报文重放）；
2. `corepack pnpm -r typecheck`（含 Steward `node-host` 类型检查）；
3. 相关包 Vitest 回归套件与 Connector 自包含打包检查（`npm pack --dry-run` 保持零运行时外部依赖）；
4. 凡触及事件归约骨架时运行 `node scripts/verification/run-tla.mjs`，凡触及前端 UI 时运行 `ui-modules.test.ts`。
