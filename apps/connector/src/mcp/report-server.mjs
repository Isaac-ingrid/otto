#!/usr/bin/env node
// Otto's MCP server for Claude Code, Codex CLI, and ACP v1 workers (issue #17, ADR-0022):
// a minimal stdio MCP server exposing two tools — `report` (§7.2) and `propose` (`readonly_probe`).
// LF-delimited JSON-RPC 2.0; initialize → tools/list → tools/call.
//
// Out-of-band file separation (ADR-0022 Decision 8):
// - argv[2] (`AUDIT_FILE`): single-overwrite JSON for the closing `report` tool.
// - argv[3] (`PROPOSALS_FILE`): append-only JSONL (`proposals-<workerId>.jsonl`) for validated
//   `propose` calls so ACP servers that omit MCP `rawInput` in `session/update` preserve all
//   proposals without clobbering `report` (and vice versa).
//
// Like every agent child it gets no OTTO_* env and no connector credentials, and it
// touches nothing on disk except argv[2] and argv[3].
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const AUDIT_FILE = process.argv[2] ?? null;
const PROPOSALS_FILE = process.argv[3] ?? null;
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "otto-report", version: "1.1.0" };

const PROPOSAL_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const ALLOWED_PROPOSAL_KEYS = new Set(["kind", "targetRepoRef", "prompt", "reason", "proposalKey"]);

/** §7.2 (v1) — the same fields the pi extension's `report` tool takes. */
const REPORT_TOOL = {
  name: "report",
  description:
    "Report the outcome of this task to the user via Otto. This must be your LAST " +
    "action when the task is finished, blocked, or needs a user decision. Put questions " +
    "for the user in `question` (with status needs_decision); do not ask in plain text.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["done", "blocked", "needs_decision"],
        description: "done: task complete. blocked: cannot proceed. needs_decision: the user must choose.",
      },
      summary: { type: "string", description: "One-line conclusion." },
      changes: { type: "array", items: { type: "string" }, description: "What was done, including locations." },
      decisions: { type: "array", items: { type: "string" }, description: "Key decisions and reasons (handoff-brief material)." },
      leftovers: { type: "array", items: { type: "string" }, description: "Leftover issues." },
      tests: {
        type: "object",
        properties: { ran: { type: "boolean" }, passed: { type: "boolean" }, note: { type: "string" } },
        required: ["ran"],
      },
      question: { type: "string", description: "Required when status is blocked or needs_decision." },
      next: { type: "string", description: "Suggested next step." },
      answer: {
        type: "string",
        description:
          "The full answer or finding, when this task was informational (a question, an explanation, an investigation) rather than a code change. Use this instead of `changes` when nothing was modified.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional bounded outcome tags (max 3; allowed: blocked-by-env | needs-human-verify | flaky-test | needs-migration | scope-creep).",
      },
    },
    required: ["status", "summary"],
  },
};

/** ADR-0022 Stage 3 (`readonly_probe`): non-blocking read-only probe proposal. */
const PROPOSE_TOOL = {
  name: "propose",
  description:
    "Submit a bounded read-only probe proposal (`readonly_probe`) to Otto Steward (for example, to inspect another registered repository without polluting this session). Asynchronous and non-blocking: Steward adjudicates later; never wait for or fabricate probe results.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        type: "string",
        enum: ["readonly_probe"],
        description: "Only 'readonly_probe' is allowed; write tasks cannot be proposed by workers.",
      },
      targetRepoRef: {
        type: "string",
        description: "Registered repository name, repoId, or path on this machine to inspect read-only.",
      },
      prompt: {
        type: "string",
        description: "Self-contained read-only investigation instructions for the sibling probe.",
      },
      reason: {
        type: "string",
        description: "Concise reason why an isolated read-only probe is needed.",
      },
      proposalKey: {
        type: "string",
        description: "Idempotency key matching ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$ (max 2 proposals per worker).",
      },
    },
    required: ["kind", "targetRepoRef", "prompt", "reason", "proposalKey"],
  },
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Mirrors the pi extension's execute() checks so all agents police the same contract. */
function validateReport(args) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "`arguments` must be an object.";
  if (args.status !== "done" && args.status !== "blocked" && args.status !== "needs_decision") {
    return "`status` must be one of done | blocked | needs_decision.";
  }
  if (typeof args.summary !== "string" || args.summary.trim().length === 0) {
    return "`summary` (a one-line conclusion) is required.";
  }
  if ((args.status === "blocked" || args.status === "needs_decision") && typeof args.question !== "string") {
    return "`question` is required when status is blocked or needs_decision.";
  }
  return null;
}

function validateProposal(args) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { error: "`arguments` must be an object." };
  }
  for (const key of Object.keys(args)) {
    if (!ALLOWED_PROPOSAL_KEYS.has(key)) {
      return { error: `unexpected field '${key}'; only kind, targetRepoRef, prompt, reason, proposalKey are allowed.` };
    }
  }
  if (args.kind !== "readonly_probe") {
    return { error: "`kind` must be 'readonly_probe'." };
  }
  const targetRepoRef = typeof args.targetRepoRef === "string" ? args.targetRepoRef.trim() : "";
  if (targetRepoRef.length === 0 || targetRepoRef.length > 256) {
    return { error: "`targetRepoRef` must be 1..256 non-whitespace characters." };
  }
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (prompt.length === 0 || prompt.length > 4000) {
    return { error: "`prompt` must be 1..4000 non-whitespace characters." };
  }
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (reason.length === 0 || reason.length > 500) {
    return { error: "`reason` must be 1..500 non-whitespace characters." };
  }
  const proposalKey = typeof args.proposalKey === "string" ? args.proposalKey.trim() : "";
  if (!PROPOSAL_KEY_RE.test(proposalKey)) {
    return { error: "`proposalKey` must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$." };
  }
  return {
    value: {
      kind: "readonly_probe",
      targetRepoRef,
      prompt,
      reason,
      proposalKey,
    },
  };
}

async function handle(request) {
  // Notifications (no id) — notifications/initialized and friends — get no response.
  if (request.id === undefined || request.id === null) return;
  switch (request.method) {
    case "initialize":
      reply(request.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return;
    case "ping":
      reply(request.id, {});
      return;
    case "tools/list":
      reply(request.id, { tools: [REPORT_TOOL, PROPOSE_TOOL] });
      return;
    case "tools/call": {
      const params = request.params ?? {};
      if (params.name === "report") {
        const invalid = validateReport(params.arguments);
        if (invalid) {
          // A tool-level error (isError), not a protocol error: the model sees it and retries.
          reply(request.id, { content: [{ type: "text", text: `Invalid report: ${invalid} Call report again with the fix.` }], isError: true });
          return;
        }
        if (AUDIT_FILE) {
          try {
            mkdirSync(dirname(AUDIT_FILE), { recursive: true });
            writeFileSync(AUDIT_FILE, JSON.stringify(params.arguments) + "\n");
          } catch {
            // Audit trail only — never fail the tool call over it.
          }
        }
        reply(request.id, {
          content: [{ type: "text", text: `Report received (status: ${params.arguments.status}). You can end your turn now.` }],
          isError: false,
        });
        return;
      }
      if (params.name === "propose") {
        const checked = validateProposal(params.arguments);
        if (checked.error) {
          reply(request.id, {
            content: [{ type: "text", text: `Invalid proposal: ${checked.error}` }],
            isError: true,
          });
          return;
        }
        if (PROPOSALS_FILE) {
          try {
            mkdirSync(dirname(PROPOSALS_FILE), { recursive: true });
            appendFileSync(PROPOSALS_FILE, JSON.stringify(checked.value) + "\n");
          } catch {
            // Best-effort out-of-band JSONL recovery log.
          }
        }
        reply(request.id, {
          content: [
            {
              type: "text",
              text:
                `queued_for_steward_decision (proposalKey: ${checked.value.proposalKey}). ` +
                "Steward has NOT adjudicated or run this probe yet; do NOT wait for or fabricate probe results. Continue your task and call `report` when done.",
            },
          ],
          isError: false,
        });
        return;
      }
      replyError(request.id, -32602, `unknown tool: ${String(params.name)}`);
      return;
    }
    default:
      replyError(request.id, -32601, `method not found: ${String(request.method)}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    let line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      // An unparseable line is dropped, never fatal (§9.4 tolerance).
    }
  }
});
// The parent closing stdin ends the server.
process.stdin.on("end", () => process.exit(0));
