#!/usr/bin/env node
// Offline contract fixture for generic ACP v1 agents (`opencode acp`, `agentica acp`).
// Supports:
// - `--version` & `acp --help` probes
// - `initialize` with configurable `sessionCapabilities.resume` vs `loadSession: true`
// - `session/load` replaying historical `session/update` chunks BEFORE responding (verifying
//   AcpAdapter ignores history notifications while `window.open === false`)
// - `-32000` `thread_active_writer` session lock contention simulation
// - `session/request_permission` round-trip (`allow_once` vs `reject_once` verification)
// - Out-of-band MCP `report-server.mjs` report write or inline `mcp__otto__report` `tool_call`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("opencode 0.14.2-fake\n");
  process.exit(0);
}
if (args[0] === "acp" && args.includes("--help")) {
  process.stdout.write("Usage: opencode acp\n");
  process.exit(0);
}

const scenario = process.env.FAKE_ACP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_ACP_SCENARIO, "utf8")) : {};
const logFile = process.env.FAKE_ACP_LOG;
const log = (entry) => {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + "\n");
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let pendingPermissionResolver = null;
let currentReportFile = null;

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log({ dir: "in", msg });

  // Client response to our `session/request_permission`
  if (msg.id !== undefined && !msg.method) {
    if (pendingPermissionResolver) {
      const fn = pendingPermissionResolver;
      pendingPermissionResolver = null;
      fn(msg.result);
    }
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: scenario.loadSession !== false,
          promptCapabilities: { image: true },
          sessionCapabilities: scenario.supportResume
            ? { resume: {}, close: {} }
            : { close: {} },
        },
      },
    });
    return;
  }

  if (msg.method === "session/new" || msg.method === "session/resume" || msg.method === "session/load") {
    if (scenario.activeWriterError) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32000,
          message: "thread_active_writer: session is currently locked by another active process",
        },
      });
      return;
    }

    const mcpServers = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
    const ottoMcp = mcpServers.find((s) => s.name === "otto");
    if (ottoMcp && Array.isArray(ottoMcp.args) && ottoMcp.args[1]) {
      currentReportFile = ottoMcp.args[1];
    }

    if (msg.method === "session/load" && Array.isArray(scenario.replayHistoryDuringLoad)) {
      for (const item of scenario.replayHistoryDuringLoad) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: msg.params.sessionId, update: item },
        });
      }
    }

    const sessionId = msg.params?.sessionId ?? scenario.sessionId ?? "ses_acp_001";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId,
        models: { currentModelId: scenario.observedModel ?? "deepseek/deepseek-chat" },
      },
    });
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    if (Array.isArray(scenario.permissionChecks)) {
      for (let i = 0; i < scenario.permissionChecks.length; i++) {
        const check = scenario.permissionChecks[i];
        const reqId = `perm_${i + 1}`;
        const permOutcome = await new Promise((resolve) => {
          pendingPermissionResolver = resolve;
          send({
            jsonrpc: "2.0",
            id: reqId,
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: check.toolCall,
              options: [
                { optionId: "opt_allow_always", kind: "allow_always" },
                { optionId: "opt_allow_once", kind: "allow_once" },
                { optionId: "opt_reject_once", kind: "reject_once" },
              ],
            },
          });
        });
        log({ dir: "permission_result", toolCall: check.toolCall, permOutcome });
      }
    }

    if (scenario.assistantText) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "msg_1",
            content: { type: "text", text: scenario.assistantText },
          },
        },
      });
    }

    if (scenario.report) {
      if (currentReportFile && scenario.writeReportFile !== false) {
        writeFileSync(currentReportFile, JSON.stringify(scenario.report));
      } else {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc_report",
              name: "mcp__otto__report",
              rawInput: scenario.report,
              status: "completed",
            },
          },
        });
      }
    }

    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        stopReason: scenario.stopReason ?? "end_turn",
        usage: scenario.usage ?? { input_tokens: 120, cache_read_input_tokens: 80, output_tokens: 40 },
      },
    });
    return;
  }

  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
});
