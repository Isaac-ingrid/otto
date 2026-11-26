# Otto

A personal agent steward that remembers ongoing work and coordinates coding agents across the owner’s machines. The owner talks to it through one continuous conversation: the web workspace on top, the owner API underneath.

## Language

**Otto**:
The product name, and the lowercase wordmark that stands for it. It is a name, not an acronym. Previously called Sig (whose ∑ mark came from Sigma) and, before that, Shepherd.
_Avoid_: Sig, Shepherd or Pip as the current product name.

**Steward**:
Otto’s coordinating role: the agent that owns the conversation, memory and Threads, and directs worker sessions. The interface calls it Otto.
_Avoid_: 总管 in interface copy.

**Owner**:
The single user of a deployment. Browser access uses the deployment login password or a registered passkey. Existing deployments can also use their explicit SERVER_KEY for the owner API. See ADR-0010 for initialization, recovery, and key ownership.
_Avoid_: "bound owner", open_id.

**Owner API**:
The optional SERVER_KEY-gated HTTP surface for programmatic access: messages in, sent messages and button actions back, pairing, login links, typed PR-watch list/create/cancel operations, inbound webhook source configuration/pause/replay (`/api/inbound-sources`), and outbound webhook registration (`/api/outbound-webhooks`). Its client sends a deliberate programmatic command, and that command is its own authorization for those typed operations. Fresh deployments use the browser without requiring this API credential.
_Avoid_: calling it "the bot" or "the webhook".

**Message**:
One rendered item the owner reads (text plus optional opaque-action buttons) — an outbound row settled locally; a quiet-merged group shares one id and reads as one message.
_Avoid_: "card" for anything chat-provider-specific.

**Turn**:
One owner message together with the steward’s answer to it, from the moment it is queued to the moment it is answered. Turns in the root conversation are **serial** ([ADR-0017](docs/adr/0017-turns-are-serial-and-cancellable.md)): a message sent while one is running queues behind it, and the owner can end the running turn, which cancels it — a cancelled turn is not a failed one, and work already dispatched keeps running. A turn is durable before it can run, so a queued turn survives a restart.
_Avoid_: request, job; a *task* is the work a worker does.

**Thread (事项)**:
An ongoing matter with a goal and history, potentially carried by several worker sessions. It remains available for follow-up when idle.
_Avoid_: A separate chat, completed task.

**Worker session**:
One coding agent’s execution session (`pi`, Claude Code, Codex CLI, Antigravity, ACP v1 `opencode` / `agentica`, or locally allowlisted `dsh` / `zcode` / `command` presets) started by Otto on a machine, attached to a Thread. The interface calls it an **Agent session**. Workers record `promptAccepted` before recovery can `--resume` headless sessions, run at most one read-only report-salvage pass on clean `unreported` exits, and may emit live context/compaction/tool telemetry, deterministic checkpoints, and bounded `readonly_probe` proposals.
_Avoid_: Another steward.

**Session record**:
The agent’s own file on a machine in which a worker session is written down. Otto reads it on demand and never keeps a copy.
_Avoid_: Transcript, raw process, log.

**Machine (机器)**:
One of the owner’s computers, with available agents (and non-intrusive `authStatus` prechecks), locally approved probe names, the directories the owner added, per-repo local write policies, and execution capacity.

**Connector**:
Otto’s program on one of the owner’s machines: it holds one outbound connection, receives commands, runs local agent adapters (`pi`, `claude`, `codex`, `antigravity`, ACP `opencode`/`agentica`, and allowlisted `CommandAdapter` presets), and handles controlled local relays (worktree diff/audit/cleanup, zero-checkout `git_pr_diff`, SHA-256-approved local `probe` scripts, worker checkpoints, sandboxed repo skills, and optional OS desktop notifications). The complete coding-agent session records stay on that machine.
_Avoid_: calling the connector an agent, or a worker session.

**Quota cooldown (额度冷却挂起)**:
Dual-granularity rate-limit suspension (`pi:<provider>` vs `agent:<kind>`) recorded in `sh_agent_cooldown` when a worker hits a quota or rate-limit window (`error:rate_limited`). Unlike credential or billing failures (`error:auth`), the worker parks in `idle` with its session and worktree preserved, releases serial repository slots, blocks blind re-dispatch to that throttled scope until `limitedUntil`, and resumes automatically via a zero-LLM alarm when the window resets.

**Directory & Write Policy (目录与写入策略)**:
A folder on a machine that the owner added from the workspace so Otto may assign work in it; a Thread can be routed to one. Each directory carries a connector-local write policy (`worktree`/`in-place` isolation, `parallel`/`serial` concurrency, project approval, and optional SHA-256-approved hooks) that cannot be altered remotely.

**Worktree audit (Worktree 体检)**:
A read-only inventory of Otto-managed git worktrees on an online machine, cross-referenced with Steward's ledger (active/orphaned/dirty/locked state and disk usage). Cleanup is owner-initiated and requires explicit path confirmation whenever dirty or unmerged changes exist.

**Note (备注)**:
A durable piece of knowledge Otto keeps outside the conversation — a preference, project convention or fact — in a resident, project or archive layer. Each note carries its source (owner-stated, connector-observed, worker-reported, or inferred) and whether the owner confirmed it. Replacing an outdated fact (`supersedes`) and making room for a new one (`evicts`) are different changes, and neither is silent. The workspace shows the decision card about one as **Memory** (记忆).
_Avoid_: using "memory" for raw conversation history or the ledger; a blanket "fact" where provenance decides what may be trusted.

**Checkpoint & Repo skill (检查点与仓库技能)**:
A **checkpoint** is a deterministic summary of a worker's progress and git state relayed from the connector for handoff or compaction. A **repo skill** is a whitelisted `SKILL.md` entry discovered or distilled in a repository under sandboxed connector rules and indexed in the Control Plane. Steward also aggregates recent repo sessions to detect recurring patterns and proposes either creating a new skill or incrementally updating an existing one (`offerKind: create | update`) only when evidence is sufficient and never writes to disk before owner confirmation.

**Routine & Local probe (例行任务与本地探针)**:
Work or a report the owner scheduled by conversation: a recurring `digest` rendered straight from the ledger, a recurring `instruction` that wakes Otto, or a scheduled local `probe` executing a SHA-256-approved script under `~/.otto/probes/` on a machine (`triggered: false` finishes at zero LLM tokens; `triggered: true` wakes Otto). Deterministic code fires routines and honors `pausedUntil` snooze windows. A routine *suggestion* only offers a card; the owner’s tap creates the routine.
_Avoid_: cron job, reminder — a one-off reminder for a Thread is a follow-up.

**Follow-up & Auto-hops breaker (定时回看与自动跳数熔断)**:
A **follow-up** is a one-off check-in or deadline Otto holds for a single Thread; when it fires, it wakes Otto on that Thread rather than asking the owner directly. Across autonomous wakes (`event`, `followup`, and automatic continuations), Steward increments `autoHops` and trips a circuit breaker above `MAX_AUTO_HOPS` (8 hops), pausing unattended loops until an owner message or card action resets the counter to `0`.
_Avoid_: routine (a follow-up is one-shot and Thread-scoped; a routine is a schedule).

**PR watch & Blind PR review (PR 跟进与零检出盲审)**:
A read-only commission to follow one GitHub pull request for a Thread: the server polls external checks and status, diagnoses CI failure logs, detects merge conflicts, triages trusted reviews, and emits a deduplicated stuck-watch consent card when a PR head stalls past 2 hours without keeping a coding agent running. With explicit owner consent, Otto can run a **zero-checkout blind PR review**: the connector extracts `git_pr_diff` directly from git objects (`core.hooksPath=/dev/null`, refusing octopus merges and leaving dirty local worktrees untouched) and dispatches a cross-engine (or clean-session) read-only reviewer stripped of the author worker's reasoning. Conversational watch create/cancel proposals require a dedicated owner button ([ADR-0019](docs/adr/0019-pr-watch-owner-confirmation.md)).
_Avoid_: "monitor" or "subscription" as the noun; cancelling a watch is a separate operation from stopping a worker or a turn, and neither implies the other.

**Inbound & Outbound Webhooks (入站事件源与签名出站通知)**:
**Inbound sources** (`/owner/in/github`, `/owner/in/gitlab`) verify HMAC-SHA256 or token headers synchronously, sanitize untrusted text against Steward wake markers, record events in `sh_skipped_event` while paused, and support deduplicated replay. **Outbound webhooks** (`sh_outbound_webhook`) fan out non-blocking notifications with SSRF protection to Feishu Schema 2.0 interactive cards (carrying single-use 7-day `sh_web_link` URLs), Generic HMAC-SHA256 endpoints, DingTalk, WeCom, and Slack.

**Three-way stop (三路独立停止)**:
Stopping an in-progress Steward **turn**, stopping or inline-interrupting a running **worker** (with 5-state stop diagnostics), and cancelling a **PR watch** are strictly separate actions; none implicitly triggers the others.

**Budget & Telemetry (预算与遥测)**:
Dual-ledger accounting that keeps Steward's own LLM spend separate from local coding-agent worker token/cost usage, surfaced alongside live worker context watermarks and compaction counts.

**Needs you (待处理)**:
A decision awaiting the owner, such as a question, PR-watch confirmation, PR stuck action, cross-machine probe approval, offline arrangement, routine offer, or memory/skill suggestion. Several decisions may belong to one Thread; some belong to no Thread.
_Avoid_: A separate inbox.

**Workspace (工作台)**:
The web view of Otto’s conversation, Threads, worker sessions, decisions, `Cmd/Ctrl+K` hybrid FTS5 search, 5-tab Control Plane (Memory, Schedules, Repo Skills, Budget & Telemetry, Machines & Worktree Audit), and machines — the owner’s everyday entry. It is a view of the same conversation the owner API serves, not a second one.

**Channel**:
Where the owner and Otto talk. Everything centers on the single local channel: the workspace and the owner API are two faces of it, while optional Web Push, local desktop notifications (`otto notify`), and signed outbound webhooks surface alerts and single-use workspace links back into that same channel.
_Avoid_: A separate conversation per channel or per surface.
