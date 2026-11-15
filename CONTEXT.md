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
The optional SERVER_KEY-gated HTTP surface for programmatic access: messages in, sent messages and button actions back, pairing, login links, and the typed PR-watch list/create/cancel operations. Its client sends a deliberate programmatic command, and that command is its own authorization for those typed operations. Fresh deployments use the browser without requiring this API credential.
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
One coding agent’s execution session started by Otto on a machine, attached to a Thread. The interface calls it an **Agent session**.
_Avoid_: Another steward.

**Session record**:
The agent’s own file on a machine in which a worker session is written down. Otto reads it on demand and never keeps a copy.
_Avoid_: Transcript, raw process, log.

**Machine (机器)**:
One of the owner’s computers, with available agents, the directories the owner added, and execution capacity.

**Connector**:
Otto’s program on one of the owner’s machines: it holds one outbound connection, receives commands, and starts worker sessions in the added directories. The complete coding-agent session records stay on that machine.
_Avoid_: calling the connector an agent, or a worker session.

**Directory**:
A folder on a machine that the owner added from the workspace so Otto may assign work in it; a Thread can be routed to one. Its contents can be browsed only while that machine is online.

**Note (备注)**:
A durable piece of knowledge Otto keeps outside the conversation — a preference, project convention or fact — in a resident, project or archive layer. Each note carries its source (owner-stated, connector-observed, worker-reported, or inferred) and whether the owner confirmed it. Replacing an outdated fact (`supersedes`) and making room for a new one (`evicts`) are different changes, and neither is silent. The workspace shows the decision card about one as **Memory** (记忆).
_Avoid_: using "memory" for raw conversation history or the ledger; a blanket "fact" where provenance decides what may be trusted.

**Routine (例行任务)**:
Work or a report the owner scheduled by conversation: a recurring digest rendered straight from the ledger, or a recurring instruction that wakes Otto. Deterministic code fires it. A routine *suggestion* only offers a card; the owner’s tap creates the routine.
_Avoid_: cron job, reminder — a one-off reminder for a Thread is a follow-up.

**Follow-up**:
A one-off check-in or deadline Otto holds for a single Thread; when it fires, it wakes Otto on that Thread rather than asking the owner directly.
_Avoid_: routine (a follow-up is one-shot and Thread-scoped; a routine is a schedule).

**PR watch**:
A read-only commission to follow one GitHub pull request for a Thread: the server polls external checks and status without keeping a coding agent running. A conversational create or cancel only proposes a decision; a dedicated owner button applies it ([ADR-0019](docs/adr/0019-pr-watch-owner-confirmation.md)). The Owner API keeps typed, authenticated create/cancel operations.
_Avoid_: "monitor" or "subscription" as the noun; cancelling a watch is a separate operation from stopping a worker or a turn, and neither implies the other.

**Needs you (待处理)**:
A decision awaiting the owner, such as a question, PR-watch confirmation, offline arrangement, routine offer, or memory suggestion. Several decisions may belong to one Thread; some belong to no Thread.
_Avoid_: A separate inbox.

**Workspace (工作台)**:
The web view of Otto’s conversation, Threads, worker sessions, decisions, and machines — the owner’s everyday entry. It is a view of the same conversation the owner API serves, not a second one.

**Channel**:
Where the owner and Otto talk. Everything is the one local channel for now; the workspace and the owner API are two faces of it.
_Avoid_: A separate conversation per channel or per surface.
