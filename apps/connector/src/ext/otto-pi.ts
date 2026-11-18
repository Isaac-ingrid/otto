// Otto's injected pi extension, docs/design/connector-pi.md §7.1 and ADR-0001.
//
// The connector writes this file into ~/.otto/ext/ with each version and loads it via
// `--extension`; it never references in-repo files, so project content cannot swap it out.
// It does exactly three things:
//
// 1. Register the `report` tool (§7.2 fields).
// 2. In `agent_before_settle`, when this run window completed without any `report` call and
//    has not been reminded yet, append a `otto.report-reminder` custom message with
//    `continue: true`, forcing one more model request. At most one reminder per window.
//    (Measured: 5/6 → 6/6 report call rate, no duplicate calls — research #11.)
// 3. Write the steward `commandId` into a `custom` session entry (ADR-0001), replacing the
//    old "last user message text matches" ambiguity heuristic (connector-pi.md §15.2).
//    The connector delivers prompts as `/otto <commandId>\n<text>`; this command records
//    the marker and re-sends the clean text as a normal user message. Steer/follow_up
//    deliveries cannot be extension commands, so they carry a `[otto:command <id>]`
//    preamble that the input handler below strips and persists as the same custom entry.

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** `custom` entry customType for the command marker (ADR-0001). */
export const COMMAND_ENTRY_TYPE = "otto.command";
/** `custom_message` customType for the forced re-report reminder (§7.1). */
export const REMINDER_ENTRY_TYPE = "otto.report-reminder";
/** Extension command name; prompts are delivered as `/<name> <commandId>\n<text>`. */
export const COMMAND_NAME = "otto";

/** §6.3 steer/follow_up marker preamble: `[otto:command <commandId>]\n<text>`. */
export const MARKER_PREAMBLE = "[otto:command ";

function appendCommandEntry(pi: ExtensionAPI, commandId: string): void {
  pi.appendEntry(COMMAND_ENTRY_TYPE, { commandId, at: Date.now() });
}

const REMINDER_TEXT =
  "[Otto] You finished without calling the `report` tool. Call `report` now as your " +
  "final action: status (done | blocked | needs_decision), summary, changes " +
  "(or `answer` when nothing was modified), decisions, " +
  "leftovers, and — when blocked or needs_decision — the question for the user in `question`. " +
  "Do not answer this reminder in plain text.";

const reportParameters = Type.Object({
  status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs_decision")], {
    description: "done: task complete. blocked: cannot proceed. needs_decision: the user must choose.",
  }),
  summary: Type.String({ description: "One-line conclusion." }),
  changes: Type.Optional(Type.Array(Type.String(), { description: "What was done, including locations." })),
  decisions: Type.Optional(
    Type.Array(Type.String(), { description: "Key decisions and reasons (handoff-brief material)." }),
  ),
  leftovers: Type.Optional(Type.Array(Type.String(), { description: "Leftover issues." })),
  tests: Type.Optional(
    Type.Object({
      ran: Type.Boolean(),
      passed: Type.Optional(Type.Boolean()),
      note: Type.Optional(Type.String()),
    }),
  ),
  question: Type.Optional(Type.String({ description: "Required when status is blocked or needs_decision." })),
  next: Type.Optional(Type.String({ description: "Suggested next step." })),
  answer: Type.Optional(
    Type.String({
      description:
        "The full answer or finding, when this task was informational (a question, an explanation, an investigation) rather than a code change. Use this instead of `changes` when nothing was modified.",
    }),
  ),
  labels: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional bounded outcome tags (max 3; allowed: blocked-by-env | needs-human-verify | flaky-test | needs-migration | scope-creep).",
    }),
  ),
});

const PROPOSAL_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

const proposeParameters = Type.Object({
  kind: Type.Literal("readonly_probe", {
    description: "Only 'readonly_probe' is allowed; write tasks cannot be proposed by workers.",
  }),
  targetRepoRef: Type.String({
    description: "Registered repository name, repoId, or path on this machine to inspect read-only.",
  }),
  prompt: Type.String({
    description: "Self-contained read-only investigation instructions for the sibling probe.",
  }),
  reason: Type.String({
    description: "Concise reason why an isolated read-only probe is needed.",
  }),
  proposalKey: Type.String({
    description: "Idempotency key matching ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$ (max 2 proposals per worker).",
  }),
});

interface WindowState {
  reportCalled: boolean;
  reminded: boolean;
}

export default function ottoExtension(pi: ExtensionAPI): void {
  // In-memory run-window state. A new user prompt opens a new window; the reminder's forced
  // continuation deliberately does not (it is part of the same window, so `reportCalled` and
  // `reminded` persist across it — that is what makes the reminder fire at most once).
  let window: WindowState = { reportCalled: false, reminded: false };

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") window = { reportCalled: false, reminded: false };
    return undefined;
  });

  pi.registerTool({
    name: "report",
    label: "Report",
    description:
      "Report the outcome of this task to the user via Otto. This must be your LAST " +
      "action when the task is finished, blocked, or needs a user decision. Put questions " +
      "for the user in `question` (with status needs_decision); do not ask in plain text.",
    parameters: reportParameters,
    async execute(_toolCallId, params) {
      window.reportCalled = true;
      if ((params.status === "blocked" || params.status === "needs_decision") && !params.question) {
        throw new Error("`question` is required when status is blocked or needs_decision");
      }
      return {
        content: [{ type: "text", text: `Report received (status: ${params.status}). You can end your turn now.` }],
        details: { status: params.status },
      };
    },
  });

  pi.registerTool({
    name: "propose",
    label: "Propose Read-Only Probe",
    description:
      "Submit a bounded read-only probe proposal (`readonly_probe`) to Otto Steward (for example, to inspect another registered repository without polluting this session). Asynchronous and non-blocking: Steward adjudicates later; never wait for or fabricate probe results.",
    parameters: proposeParameters,
    async execute(_toolCallId, params) {
      if (params.kind !== "readonly_probe") {
        throw new Error("`kind` must be 'readonly_probe'");
      }
      const targetRepoRef = typeof params.targetRepoRef === "string" ? params.targetRepoRef.trim() : "";
      const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const proposalKey = typeof params.proposalKey === "string" ? params.proposalKey.trim() : "";
      if (!targetRepoRef || targetRepoRef.length > 256) {
        throw new Error("`targetRepoRef` must be 1..256 characters");
      }
      if (!prompt || prompt.length > 4000) {
        throw new Error("`prompt` must be 1..4000 characters");
      }
      if (!reason || reason.length > 500) {
        throw new Error("`reason` must be 1..500 characters");
      }
      if (!PROPOSAL_KEY_PATTERN.test(proposalKey)) {
        throw new Error("`proposalKey` must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$");
      }
      return {
        content: [
          {
            type: "text",
            text:
              `queued_for_steward_decision (proposalKey: ${proposalKey}). ` +
              "Steward has NOT adjudicated or run this probe yet; do NOT wait for or fabricate probe results. Continue your task and call `report` when done.",
          },
        ],
        details: { status: "queued_for_steward_decision", proposalKey },
      };
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Internal: deliver a Otto-dispatched prompt with its command marker.",
    handler: async (args: string) => {
      const newline = args.indexOf("\n");
      const commandId = newline === -1 ? null : args.slice(0, newline).trim();
      const text = newline === -1 ? args : args.slice(newline + 1);
      if (commandId) appendCommandEntry(pi, commandId);
      pi.sendUserMessage(text, { expandPromptTemplates: false });
    },
  });

  // §6.3: steer/follow_up deliveries arrive with a marker preamble (extension commands are
  // not allowed there). The input handler runs before the message is queued or persisted, so
  // it strips the preamble and appends the commandId custom entry in the same synchronous
  // step — when the connector later crashes mid-`sending`, the presence of this entry in the
  // session tail means the queued message was delivered, and its absence is evidence too.
  pi.on("input", (event) => {
    const text = typeof event.text === "string" ? event.text : null;
    if (!text || !text.startsWith(MARKER_PREAMBLE)) return undefined;
    const newline = text.indexOf("\n");
    const commandId = newline === -1 ? null : text.slice(MARKER_PREAMBLE.length, newline).replace(/\]$/, "").trim();
    if (!commandId || /[\r\n]/.test(commandId)) return undefined;
    appendCommandEntry(pi, commandId);
    return { action: "transform" as const, text: newline === -1 ? "" : text.slice(newline + 1) };
  });

  pi.on("agent_before_settle", (event) => {
    // Fire at most once per window, and only for a run that completed without an error and
    // without a report call (§7.1: outcome == completed; `outcome` is provided by pi).
    if (event.outcome !== "completed" || window.reportCalled || window.reminded) return undefined;
    if (!event.context.canContinue) return undefined;
    window.reminded = true;
    return {
      entries: [
        ...event.entries,
        { type: "custom_message", customType: REMINDER_ENTRY_TYPE, content: REMINDER_TEXT, display: false },
      ],
      continue: true,
    };
  });
}
