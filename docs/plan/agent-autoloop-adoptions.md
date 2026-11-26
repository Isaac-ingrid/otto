# Otto 从 agent-autoloop 采纳的改进方案

状态：阶段 1–5 已全部落地并通过生产环境验收（2026-11-25，`050`–`053` 迁移落表，`pnpm verify:prod` 0 失败）。

范围与顺序决定（2026-11-24 拍板，2026-11-25 验收收口）：
1. **双轨兼顾**：既面向日常主力 `pi` + 多 API / Coding 套餐提供方（DeepSeek、`zai-coding-cn`、OpenAI 兼容网关）落地细粒度限流挂起与活进程补报，也补齐外围 CLI 生态（`codex`、`claude-code`、基于 ACP v1 的 `opencode` / `agentica`，以及本机白名单 `CommandAdapter` 接入 `dsh` / `zcode` / `command`）。
2. **收敛本地 Agent 范围**：仅保留实际使用的编码引擎（`pi`、`claude-code`、`codex`、通用 `opencode` / `agentica` ACP 与白名单 `CommandAdapter`），不保留无关外围 CLI 的本地适配、配置命令或冗余防御分支。
3. **离线契约测试桩（Contract Fixtures）门禁**：针对开发机未登录部分外围 CLI 实账号的情况，外围协议流统一固化在 `fake-pi.mjs`、`fake-claude.mjs`、`fake-codex.mjs`、`fake-acp.mjs`、`fake-command.mjs` 中完成确定性回归验证，并在 `hello.agents` 附带无损 `authStatus` 预检。
4. **已交付阶段**：**阶段 1（`050` 双粒度限流冷却挂起、`promptAccepted` 对账判据、单次只读补报与 Codex / Claude 细节修补） → 阶段 2（通用 `AcpAdapter` 支持 `opencode` / `agentica` 与 `shell: false` 的 `CommandAdapter`） → 阶段 3（`051` 零 Token 本地 SHA-256 探针 `otto probe`、`autoHops <= 8` 熔断与 GitHub/GitLab 验签入站 Webhook 暂停补放） → 阶段 4（`052` PR Watch 2 小时停滞确认卡与零检出 `git_pr_diff` 跨引擎/净空盲审） → 阶段 5（`053` `otto notify` 零依赖桌面通知、飞书 Schema 2.0 卡片与 SSRF 防护签名出站 Webhook）**。

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

## 4. 阶段 2–5 最终落地摘要

### 阶段 2：OpenCode / Agentica ACP 适配器与通用 Command 适配器
- 通用 `AcpAdapter`（`apps/connector/src/acp-adapter.ts`）原生支持 `opencode` 与 `agentica`：区分 `session/load`（跳过历史重放）与 `session/resume`，识别 `-32000` / `thread_active_writer` 会话占用返回可重试的 `session_in_use`，按 worktree 真实路径校验 `allow_once` 权限；Gemini CLI 直接剔除，不留无效防御代码。
- 轻量 `CommandAdapter`（`apps/connector/src/command-adapter.ts`）受本机存储白名单约束，强制 `shell: false`，单遍回调替换 `{prompt|model|effort|cwd|context}`（防止 `$&` 二次展开），内置 `dsh`（DeepSeek Harness `0.2.2+` JSONL `step_end` 累加）与 `zcode` 解析预设。

### 阶段 3：零 Token 本地脚本探针（`probe`）、`autoHops` 8 跳熔断与入站 Webhook 暂停 `replay`
- **本地探针（迁移 `051_probes_autohops_and_replay`）**：脚本限定于 `~/.otto/probes/` 并经本机 `otto probe approve <name>` 绑定 SHA-256；`RoutineService` 支持 `probe` 类型例行任务，返回 `{ triggered: false }` 时零 Token 结束，仅 `triggered: true` 时唤醒 Steward。
- **跨轮跳数熔断**：`sh_wake`、`sh_run` 与 `sh_thread` 维护 `autoHops`；自治事件链（含 `followup` 与自动续跑）逐轮累加，超过 `MAX_AUTO_HOPS = 8` 立即停派并推送熔断提醒，仅真人发消息或点击卡片重置为 `0`。
- **验签入站与暂停补跑**：新增 `POST /owner/in/github`（HMAC-SHA256）与 `POST /owner/in/gitlab`（常量时间 Token 校验）同步转换器及 `/api/inbound-sources` 管理接口；`pausedUntil` 暂停窗口内的事件落入 `sh_skipped_event` 去重暂存，支持一键 `replay`。

### 阶段 4：PR Watch 停滞提醒与零检出交叉盲审
- **停滞确认卡（迁移 `052_pr_watch_stuck_and_review`）**：同一 `head` 在 `waiting`、`conflicted` 或 `changes_requested` 状态停滞超过 2 小时（`PR_WATCH_STUCK_THRESHOLD_MS`）时，每 `head` 最多推送一次去重确认卡 `prWatchStuckCard`（`[派发只读探针诊断]` / `[继续等待]` / `[取消此 PR 跟进]`），绝不自动合并或改写远端 PR。
- **零检出交叉盲审（`pr-blind-review.ts` + `pr-diff.ts`）**：点击确认后，Connector 以 `-c core.hooksPath=/dev/null` 从裸 Git 对象直接计算 `git_pr_diff`（拒绝 `parentCount > 2` 的章鱼合并，不切换分支、不污染本地脏工作树）；Steward 剥离原作者全部对话与推理，优先调度同机另一家族只读引擎（如 `claude-code -> codex`），仅单引擎可用时退回全新零历史只读会话。

### 阶段 5：桌面原生通知、飞书 Schema 2.0 卡片与签名出站 Webhook
- **本机桌面通知（`desktop-notify.ts`、`otto notify`）**：跨平台零外部依赖系统通知（macOS `osascript`、Windows Base64 UTF-16LE PowerShell `NotifyIcon`、Linux `notify-send`，SSH 无图形会话自动静默跳过）。
- **飞书 Schema 2.0 渲染器（`channel/feishu-card-v2.ts`）**：将本地消息与操作按钮渲染为飞书 V2 交互卡片，附带 `sh_web_link` 生成的 7 天有效单次登录直达链接（首次访问 HTTP 303 种下 `otto_session`，二次访问 HTTP 410 防重放）。
- **签名出站 Webhook（迁移 `053_outbound_webhooks`，`channel/webhooks.ts`、`/api/outbound-webhooks`）**：内置严格 SSRF 校验（生产强制 HTTPS 并拦截回环/私网/元数据地址），支持 `feishu`（HMAC-SHA256 签名）、`generic`（`X-Otto-Signature-256`）、`dingtalk`、`wecom` 与 `slack` 非阻塞并发推送。

## 5. 验证与生产验收记录

1. 全量确定性契约单测与集成测试（`autoloop-stage1.test.ts`、`autoloop-stage2.test.ts`、`autoloop-stage3-5-connector.test.ts`、`quota-cooldown.test.ts`、`autoloop-stage3.test.ts`、`autoloop-stage4-5.test.ts`）全部通过；
2. `corepack pnpm -r typecheck`、`typecheck:node-host` 与 `apps/connector` `npm pack --dry-run`（零运行时外部依赖）全部通过；
3. `pnpm deploy:vps` 与零密钥生产冒烟脚本 `pnpm verify:prod`（`scripts/verify-prod.mjs`）实测 `0 failures`，确认云端 `050`–`053` 全部落表、本机探针 SHA-256 篡改拦截、脏工作树零检出 PR Diff、系统桌面通知及飞书 V2 单次链接防重放均符合预期。
