# Personal Agents, 2026: The Landscape, and What Otto Takes From It

Date: 2026-11-12. Subject: the Personal Agent category as it stands today — what one strong
industry survey says the category actually is, what has shipped since that survey, and which parts
are already true of Otto, which are worth adding, and which are not Otto's problem. **Survey only:
no code changed.**

Starting point is 郑天 (Alibaba Cloud) 的《Personal Agent 产品技术与商业观察》, published 2026-10-18 and
collected into the [AI Agent Handbook](https://github.com/aliyun/ai-agent-handbook) (`06-case-study/Personal Agent 专题/`).
That survey is the frame; §3 is everything that moved after it, through 2026-11-12.

Evidence falls into three classes:

- **Source/docs** — the survey, vendor pages and posts, release notes, and papers read during
  retrieval on 2026-11-12. Vendor blog posts about their own products are *claims*; where a number
  comes from a vendor it is marked.
- **Repo/cross-check** — an arXiv ID or a release note checked against a second independent source,
  or resolved to a real paper. Marked inline.
- **Unverified** — marked inline. Nothing here was measured by me.

## 0. This is Otto's own category

Otto is a personal agent: one owner, Threads that stay available for follow-up, worker sessions on
the owner's machines, memory that persists across conversations, decisions that wait as *Needs you*,
and a Workspace as the everyday entry. So this literature is not background — it is a description of
the product Otto already is, written by people building the same thing with far more users and
money. The useful reading is comparative: **which of these mechanisms does Otto already have, which
is it missing, and which does it deliberately not want.**

## 1. The survey's frame

Two claims carry the whole document.

**1. A Personal Agent is four parts, not one.**

| Part | What it is | Otto's counterpart |
|---|---|---|
| Runtime core | model + harness: planning, memory, scheduling, tool calls | the steward on its Durable Object; model via ADR-0001 decision 11 |
| Its own execution environment | a computer it operates like a person (browser, tabs, resource limits) | the owner's **Machines**, driven through connectors — a real machine, not an emulated one |
| Tool and service ecosystem | the connectors that make tasks completable | connectors, agent launch, worker sessions |
| Digital identity | accounts, payment, phone number that the outside world can recognize and authorize | device pairing and worker sessions; **deliberately no independent identity** (§6) |

**2. "Always on" is a runtime change, not a smarter model.** The survey's example is the one worth
remembering: *"watch this purchase; if the supplier slips, find alternatives, but ask me before
switching."* The owner closes the window and the work does not end. The next day an email wakes it,
it prepares alternatives, requests approval, waits, and on approval continues — the same
commission, not a new conversation.

The mechanism is that everything long-lived moves **out of the session**: the task ledger, memory,
permissions, credentials, triggers, and the record of side effects already emitted. A new email,
calendar event, or missed call can then wake the process. The survey puts it as: *上一代 Agent 的规划、
浏览和写稿，基本都绑在当次会话的上下文里。窗口一关，任务、权限和中间结果就跟着丢了。*

Otto is already built this way — durable turns (ADR-0017), a ledger, Threads that stay available,
notes that outlive the conversation. That is worth stating plainly: on this axis Otto is not behind
the funded products. The gap is elsewhere (§4).

The survey's secondary claims, each of which matters later:

- **Persistent state is not RAG.** Episodic / semantic / procedural memory plus a working memory;
  the progression is *store trajectories → reflect on them → abstract them into reusable
  experience*. Always-on needs the third step. Otto's notes module is a governed version of step 2–3.
- **Execution state is itself memory.** Cannot keep the full history in context, and compression
  loses details whose relevance appears later.
- **Identity must survive a runtime change** — new model, new harness, new host, still the same agent.
- **Triggers are a control loop, not a timer.** Only a satisfied condition wakes the machine; the
  outside-facing effects (a sent email, a payment) are committed, unrecoverable side effects and must
  be booked separately from internal plans.
- **Which actor acted, and when a permission expires.** Borrowing the owner's login gets every
  action recorded as the owner's own. OpenClaw's 2026-09-21 audit note is the rule to keep:
  **permission travels with the request, authorization binds to the resource actually accessed, and
  revoking must reach tasks already running.**
- **Completion cannot rest on the agent's self-report.** Order placed, mail delivered, calendar
  changed, file present, PR green — external state is the evidence.
- **The cost metric that matters is attention**: how often the owner has to come back to check
  progress, correct a step, or re-supply context.

## 2. The products the survey covers

As of 2026-11-12, in the survey's own groupings:

| Product | Maker | First shipped | Distinguishing mechanism |
|---|---|---|---|
| **Muse** | Meta | 2026-09-08 | Secure VM per user; agent runs in a `systemd-nspawn` container with creds/approval outside it; `authd` hands the model substitute tokens; Sentinel checks connector actions and egress; eBPF for traffic and taint; browser broker, sub-agents read the accessibility tree |
| **dots** | OpenAI | 2026-09-29 | One primary dot; separate task context / ChatGPT memory / its own persistent context; isolated Linux+Chrome workspace; passwords enter the browser without entering model context; an Auto-review pass over actions that touch the outside world |
| **Grok Bot** | xAI | 2026-08-11 | Bots share one cloud computer and can be grouped with roles; `skill` = how, `routine` = when; "Teach a task" records up to 10 minutes of screen operations into a skill draft. **No isolation between Bots** — same files, browser sessions and app logins |
| **Gemini Spark → Task** | Google | 2026-05-19 (I/O) | Deepest Workspace integration; three trigger classes (time, Gmail condition, topic event); up to 50 active schedules, 15 concurrent tasks; later uses Chrome's signed-in state and saved passwords |
| **Claude Duet** | Anthropic | 2026-10-21 | Explicitly **not** an errand runner: briefs, dashboards, forecasting; asks before sending, paying, signing, deleting; cannot show browser use live |
| **Cue** | Manus | 2026-09-28 | Each agent gets its own email, phone number, wallet and computer; can be created by scanning a merchant QR code |
| **Fo** | Wajo | 2026-08-25 | Self-owned phone, email, voice, and single-use payment cards; a **formal handoff to a trained human assistant** when automation stalls, with the result written back into the task |
| **OpenClaw** | OpenClaw Foundation | 2026-01 (as Clawd, 2025-11) | Self-hosted runtime: long-lived Gateway, WebSocket clients, serialized turns per session with a global concurrency cap, memory in `USER.md`/`MEMORY.md`/dated notes with a SQLite index, background *dreaming* consolidation, heartbeat, cron, webhooks. Sandboxing was **off by default** in the early docs |
| **Today** | 齐俊元 | 2026 (restart) | Memory surfaced in the UI: owner can read, edit, delete each fact; two daily anchors (morning brief, evening wrap); no send, no calendar move, no message without explicit confirmation. Its cloud computer is a sandbox, not a full cloud desktop |
| **Instinct** | — | — | Independent email/phone/payment identity (cited in passing by the survey and by Anthropic) |

The survey's own verdicts, which are opinions and are marked as such here: Grok Bot has the highest
completeness (genuinely runs 24h); dots' advantage is Codex integration and unlimited Pro usage;
Muse's traction comes from its avatar/tone plus model quality. Two of these I would not lean on:
the "AA ranked second" model claim and all price/availability details.

## 3. What moved after 2026-10-18

### 3.1 Product moves

| Date | What | Why it matters |
|---|---|---|
| 10-21/23 | **Claude Duet** research preview (US Pro/Max/Ultra, Opus 5.5; waitlist) | The first major product to position *against* the errand-runner framing: Anthropic says it is not good at errands or ticket booking. Evidence the category is splitting |
| 10-12 → 11 | **Spark renamed "Task"**, folded into the main Gemini chat, "Spark" leaves the nav drawer, new Scheduled page | Google shipped first and spread furthest; the rename churn is its own warning about surface stability |
| 11-02 | **Grok Bot 1.0** out of beta | Multiplayer teammates; **proactive teammates** that spot unclaimed work and offer to take it; joins Google Meet / Zoom / Teams calls, answers in meeting chat, sends a summary |
| 11-05/06/10 | **Muse**: voice + expressive avatars in the US; **Spaces** (describe a custom experience, place it in the sidebar or main tabs, schedule when it shows); on Apple Watch and Wear OS | Three fronts at once: modality, customization, and wearables — matching the "proactive that knows you" pitch |
| 11-04 | **dots** for Enterprise/Edu/Healthcare (admin preview to 11-18, on by default after); GPT-6.1 Terra added 11-03; reply from an iOS notification | dots enters organisations, not just individuals |
| 11-09/11 | **dots can split work across multiple connected local computers** — connect machines via the desktop app, separate task threads on different machines, one computer per thread at a time, cloud computer stays connected | The first credible "distribute across the owner's own machines" move from a major vendor — structurally the closest thing to Otto's Machines |
| 11-06 | **OpenClaw Multiplayer**: several people share one agent, workspace and context, and see/modify the same task; shared queue coordinates requests | The Foundation's answer to agent silos; single-owner by design, so not Otto's problem |
| 11-08/10 | **OpenClaw 2026.11.2 and .11.3** | See §3.4 — .11.3 is labelled a security release |
| 11-10 | **Nod** (n8n Labs) research preview | Standalone personal agent that runs on your own computer, works in your apps and on websites, **asks before it acts**, bring-your-own model |
| 11-05 | **Toki** relaunch | Was an AI calendar; now a personal agent that finds what you care about and carries it through. The pivot is the category's pull |

Also: Manus raised over $500M in October 2026 (reported), and Cue's iPhone app went live on the App
Store 2026-10-08 under Butterfly Effect Pte. Ltd., invitation code required, also on Google Play and
the Microsoft Store. These come from secondary aggregator sites, not vendor pages.

### 3.2 China

The survey predicted "生态内嵌 + 信任变现" rather than one general assistant winning. November
supports the second half and complicates the first:

| Date | What | Note |
|---|---|---|
| 11-06/09 | **中国电信 星辰超级智能体 TeleAgent V3.0** — "智能体 + 云电脑", cloud computer aligned with real PC specs, desktop/mobile/web all driving the same host, memory sync | First domestic product to make "the agent has its own computer" the headline |
| 11-10 | **魅族 超级 Aicy** live — call answering on your behalf, flight/hotel booking, ride-hailing, Feishu office suite, stocks, scheduled tasks, "问屏", 130+ system atom capabilities, a capability store | A phone vendor making the **system** the agent, not an app |
| 11-06 | **12580 个人智能助理** — cloud memory, autonomous execution, multiple entry points; "帮您办/盯/看/找/记/想" | Carrier-side entry, same shape |
| 11-11 | **Momoding** — open-source personal agent living in an Android phone; every app it builds gets its own Bot with its own conversation and project memory | The app-making loop is the interesting part |
| 11-11 | ByteDance project **"Spell"** reported to be accelerating toward launch, benchmarked internally against Meta Muse, deeply integrated with 豆包, led by the 豆包手机助手 team, in internal beta since April | Reported, not announced. The "accelerated because of Muse" framing is the market reading |
| — | **Today** under scrutiny: an 界面新闻 piece (10-27) argues the product is still a *tool*, not a *partner* — the owner must maintain the data before the agent can help, and memory transparency shifts maintenance cost onto the owner rather than removing it | The sharpest critique of the whole category, and it applies to any memory-as-UI design |

### 3.3 Research since 2026-10-18

The survey cites FlowState, PAI-Bench and RIPA; all three resolve to real papers
(**repo/cross-check**), and a review of FlowState flags that its generality claim rests on the
full-context baseline only and its ablation is weaker than the headline. The survey's roughly
+4.6pp / +14pp and ~40% token figures are close to the paper's +4.55pp (MemoryArena) and +13.95pp
(τ3-Bench) and ~43% token reduction.

New work in the window, all of which bears on *Always on*:

- **Prospective Memory for Proactive LLM Agents** (arXiv 2611.05731, 2026-11-03, UIUC) — the
  distinction Otto's reminder design lives on: a memory system that only looks backwards can
  retrieve a past fact but cannot hold a *future-directed intention* and act when the opportunity
  appears. Recalling the intention is not the same as acting at the right moment; a related
  observation may mean wait, a later cue may mean act.
- **Deep Personalization: Continuous Context Observation for Local Proactive Agents**
  (arXiv 2611.13457, 2026-11-10) — proactivity requires observing real activity and choosing
  *intervention timing*, not just detecting opportunities.
- **VibeLifeBench** (arXiv 2608.10875, 2026-11-06; 小红书 Dots Studio with Evolvent AI) — a
  simulated living world where the world changes while nobody prompts, and later tasks depend on
  those changes. Notably: this is an ecosystem-specific agent lab from a content platform, i.e. the
  survey's prediction arriving on schedule.
- **Avatar Intelligence: Amplifying Human Agency Through Persistent Personal Agents**
  (arXiv 2611.03092, 2026-11-02).
- **A Life of Its Own: How Agentic AI Companions Are Configured, Experienced as Autonomous Others,
  and Held Accountable** (arXiv 2611.12076, 2026-11-09) — accountability for what an agent records
  about a user while the user is away.
- **Claw-Anything** (arXiv 2605.26086) — a benchmark for always-on assistants with broad access to
  the user's digital world (Huawei, BIT, PKU). Pre-dates the window but is the closest existing
  benchmark to Otto's shape.

On memory evaluation, two findings that should change how anyone reads a memory score:

- **LongMemEval-V2** (UCLA) — five memory abilities, 451 questions, up to 500 trajectories, up to
  115M tokens; asks whether memory can turn long histories into *reusable environment experience*.
- **Deletion is essentially unsolved.** A 2026-11-07 survey of the field reports that across
  deletion and cross-user probes, **no system passed more than 1.5% of forget requests end to end**
  (`aievals.co`, secondary). Whatever a product claims about memory, forgetting is the open problem
  — which is precisely the property Otto's notes module treats as a first-class state
  (`active` / `superseded` / `removed`).
- A **failure-attribution rubric** for LongMemEval (Zenodo, 2026-10-11) separates outcome
  correctness, evidence availability, attribution confidence and judge confidence. Same instinct as
  proposal D in [`rsi-2026.md`](rsi-2026.md).
- `tau-bench` 2.0.0 (2026-10-19) is flagged as not comparable with 1.x — a reminder to pin
  benchmark versions when quoting scores.

### 3.4 Security, which is where October–November actually got loud

This is the most important section for Otto, because every one of these is an attack on a personal
agent's *outside* surface:

- **An email worm that targets assistants** (Ironscales, 2026-11-11): a legitimate-looking event
  invitation carries a hidden block instructing the assistant that reads the mailbox to forward the
  message to coworkers and then go looking for wallet seed phrases. Self-propagating, and designed
  against the assistant, not the human.
- **Codex's npm publish pipeline** (Depi, 2026-11-11): one crafted prompt injection gave code
  execution inside the agent sandbox, which chained into OpenAI's development infrastructure and
  ultimately control over what could be published to its official npm package.
- **Public bug reports as injection carriers** (Radware, 2026-11-05): coding agents read text
  anyone on the internet can write.
- Week 46 (Nov 9–15) is tracked at 25 AI-security stories, 10 with CVEs, including four MCP/agent
  flaws in VS Code (CVE-2026-120779, CVSS 9.6) and an SGLang flaw exposing 100 accounts and 18
  agents; most-affected vendors were Claude apps, Claude Code and Codex.
- **OpenClaw 2026.11.3** is a security release: private sub-agent results leaking, **tool failures
  recorded as successes**, and credentials sent to the wrong destination. 2026.11.2 is even more
  instructive for its *class*: an updater that wedged itself, and **scheduled reminders that
  silently disappeared**. The October note beside it — certificate verification skipped for worker
  transfers with blank fingerprints — is the same shape: **a check that passes when its input is
  absent.**

The last one generalises into a review question worth asking about Otto's own connector protocol,
independent of OpenClaw: for each credential or identity check on the worker path, does a missing or
empty field **fail closed**? Not verified here; it is a cheap thing to confirm by reading, and the
class of bug is exactly the kind that survives a typecheck and every happy-path test.

## 4. Otto against the frame

| Mechanism | Otto |
|---|---|
| State outside the session (ledger, memory, triggers) | **Has it.** Durable turns (ADR-0017), ledger, Threads, notes |
| Task state machine with resumable steps | **Has it**, though the survey's finer distinctions (§5.3) are not exposed |
| Triggers as a control loop | **Partly.** Reminders, follow-ups, routines exist; whether each is a condition or a timer is worth auditing against the survey's rule |
| Verified completion from external state | **Partly, and correctly biased.** Worker reports enter notes as `worker_reported`, a LOW_TRUST source, and must be confirmed — the same instinct as "completion cannot rest on self-report" |
| Memory governance (source, scope, expiry, removal) | **Has it**, in more detail than most products surveyed: layers, source weights, similarity dedup, capacity caps, supersede/remove |
| Forgetting | **Ahead of the field.** Deletion being <1.5% solved industry-wide makes the `removed` state a real feature, not housekeeping |
| Permission travels with the request; revocation reaches running work | **Worth auditing.** ADR-0017 makes turns cancellable and says work already dispatched keeps running; the survey's rule is that revocation must reach already-dispatched work too. Those two can be in tension and the resolution should be deliberate |
| Identity across runtime change | **N/A by design** — one owner, paired devices, no independent identity (§6) |
| Attention cost as the metric | **Missing, and cheap.** Nothing counts how often the owner returns to a Thread to check, correct or re-supply context |
| Independent email/phone/wallet | **Deliberately absent** (§6) |
| Cloud desktop the agent drives | **Not wanted.** Otto drives the owner's real Machines through connectors; a browser-emulating fake computer is strictly worse here |

## 5. What to take

Ordered by value to Otto, not by cost.

### 5.1 Count the owner's returns to a Thread

The survey's one clearly actionable metric: *how often the owner comes back to check progress,
correct a step, or re-supply context.* More returns means the background execution saved less
attention than it looks like it did. Otto has the raw material already — Thread history, queueing,
cancelled turns, *Needs you* items — and a count is far more honest than a completion rate for a
product whose whole promise is that the owner can stop watching.

### 5.2 The three-way stop, because "stop" is not one thing

dots separates *pause the main task*, *stop a sub-task*, and *cancel future plans*. This is a direct
fit for Otto's model: a cancelled **Turn**, work already dispatched to a **worker session**, and a
scheduled follow-up are three different things, and one button implies they are one. The owner does
not cancel a future plan by ending a turn. Worth making explicit in the Workspace language.

### 5.3 Distinguish a trigger from a timer

The survey's rule — a trigger is a *condition* evaluated against incoming events; only its
satisfaction wakes the machine — is a design check, not a feature. Applied to Otto's reminders and
routines: which of them are conditions, which are timers, and is that visible to the owner?

### 5.4 An interruption policy, written down

Low-risk information batches into a digest; a high-risk action pauses before executing; when the
condition is uncertain, investigate first; when a human decision is needed, offer few clear options.
Otto already implements most of this — the routing eval's ask rules are the same judgement — but it
lives in the prompt, not as a stated policy. The value of writing it down is that it becomes
testable, which is what the routing eval's ask thresholds already try to do.

### 5.5 Prospective memory as a named capability

From arXiv 2611.05731: remembering an intention and *acting at the right time* are different
abilities, and a purely retrospective memory layer has neither. Otto's follow-ups are exactly
future-directed intentions held across sessions. Naming it as its own capability makes the failure
mode visible: the intention survives, the moment does not, or vice versa.

## 6. What not to take

- **An independent email, phone number or wallet.** Cue, Fo and Muse all add one, and the survey's
  own reporting shows the cost: phone numbers priced per month that turn out not to be free, SMS
  unavailable in major countries, the number's country bound to the current proxy IP, sandbox IPs
  that change region on restart. For a single-owner product whose worker identity is the owner's own
  paired machine, this buys nothing and imports an unreliable third-party identity.
- **A cloud desktop the agent drives with a browser.** Otto's premise is that the owner's real
  machines are the execution environment. Emulating a computer is a step down in capability and a
  step up in attack surface.
- **Avatar, voice and plush personality.** Muse's traction is real; none of it is Otto's pitch.
- **Multi-user sharing.** OpenClaw Multiplayer targets a different problem.
- **Any memory surface that shifts maintenance onto the owner without removing it.** That is the
  Today critique, and it is the design trap in §2's "memory surfaced in the UI".

## 7. Open questions

- Does a missing or empty credential field fail closed on Otto's worker path? (§3.4)
- When a permission is revoked, what reaches work already dispatched to a worker session? (§4)
- Is there a defensible "return to Thread" metric that counts attention without counting healthy
  interaction — and where would it live so it never becomes a gate?
- The category's differentiating claims are all self-reported (Fo's 71% completion / 94% trust from
  the developer's own preprint; Grok Bot's procurement anecdote; Muse's model ranking). What would
  count as independent evidence for a personal agent at all?

## Sources

- 郑天, 《Personal Agent 产品技术与商业观察》, 2026-10-18 — `github.com/aliyun/ai-agent-handbook`,
  `06-case-study/Personal Agent 专题/`. The frame in §1–§2.
- Vendor: `about.fb.com` (Muse Spaces, 2026-11-06; Muse voice, 2026-11-05), `techcrunch.com`
  (Muse on watchOS/Wear OS, 2026-11-10), `openai.com` (introducing dots, 2026-09-29; release notes),
  `learn.chatgpt.com` (November 2–6, 2026), `x.ai` (Grok Bot 1.0, 2026-11-02; changelog 1.0.1,
  2026-11-11), `claude.com` (Claude Duet, 2026-10-21), `9to5google.com` and `androidpolice.com`
  (Spark → Task), `n8n.io` (Nod, 2026-11-10), `toki.com` (2026-11-05).
- China: `chinatelecom.com.cn` (TeleAgent V3.0, 2026-11-09), `ithome.com` (超级 Aicy, 2026-11-10;
  12580, 2026-11-06), `xiaoyi.vc` (Momoding, 2026-11-11), `zhitongcaijing.com` (字节 "Spell",
  2026-11-11, reported), `jiemian.com` (Today critique, 2026-10-27), `today.ai` (privacy and
  permission articles, 2026-10).
- Security: `ironscales.com` (email-assistant worm, 2026-11-11), `depi.security` (Codex npm
  pipeline, 2026-11-11), `radware.com` (2026-11-05), `theinjection.dev/week/2026-w46`,
  `docs.openclaw.ai/releases/2026.11.3` and `.11.2`, `original.ifeng.com` (OpenClaw Multiplayer,
  2026-11-06).
- Papers: Prospective Memory for Proactive LLM Agents (arXiv 2611.05731); Deep Personalization
  (arXiv 2611.13457); VibeLifeBench (arXiv 2608.10875); Avatar Intelligence (arXiv 2611.03092);
  A Life of Its Own (arXiv 2611.12076); Claw-Anything (arXiv 2605.26086); FlowState
  (arXiv 2609.34565); PAI-Bench (arXiv 2609.13637); Runtime-Independent Persistent Agents
  (arXiv 2609.00546); LongMemEval-V2 (`xiaowu0162.github.io/longmemeval-v2/`).
- Secondary aggregators, used only where vendor pages publish nothing: `personalagentatlas.com`,
  `personalagentbench.com`, `nohacks.co`, `ai.zj.fyi`, `aievals.co`, `sugra.systems`.
