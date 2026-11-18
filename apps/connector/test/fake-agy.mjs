#!/usr/bin/env node
// fake-agy: a deterministic `agy acp` (Agent Client Protocol v1 over stdio JSON-RPC 2.0)
// stand-in for connector tests. Also answers `--version` and `acp --help` for `detectAntigravity`.
//
// Env:
//   FAKE_AGY_SCRIPT    path to the JSON scenario file (required for `acp` runtime)
//   FAKE_AGY_LOG       path to append JSON lines of RPC events/prompts/permissions
//   FAKE_AGY_ARGV_LOG  path to append process.argv on each spawn
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { exec, spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.5.3 (Antigravity CLI)");
  process.exit(0);
}
if (args[0] === "acp" && args.includes("--help")) {
  console.log("Usage: agy acp [flags]");
  process.exit(0);
}

if (process.env.FAKE_AGY_ARGV_LOG) {
  appendFileSync(process.env.FAKE_AGY_ARGV_LOG, JSON.stringify(process.argv) + "\n");
}

const scriptPath = process.env.FAKE_AGY_SCRIPT;
if (!scriptPath) {
  console.error("fake-agy: FAKE_AGY_SCRIPT is required");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scriptPath, "utf8"));
const startup = scenario.startup ?? {};

function logEvent(entry) {
  if (process.env.FAKE_AGY_LOG) {
    appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + "\n");
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function notifyUpdate(sessionId, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

/** Shared cross-process prompt counter (`<script>.runs`) so cold relaunches advance across runs. */
function nextRunIndex() {
  const counterFile = `${scriptPath}.runs`;
  const current = Number.parseInt(existsSync(counterFile) ? readFileSync(counterFile, "utf8") : "0", 10) || 0;
  writeFileSync(counterFile, String(current + 1));
  return current;
}

/** Shared cross-process session counter so first `session/new` gets a deterministic sessionId. */
function nextSessionId() {
  if (typeof startup.sessionId === "string") return startup.sessionId;
  const counterFile = `${scriptPath}.sessions`;
  const current = Number.parseInt(existsSync(counterFile) ? readFileSync(counterFile, "utf8") : "0", 10) || 0;
  writeFileSync(counterFile, String(current + 1));
  return `agy-sess-${current + 1}`;
}

let authenticated = !startup.requireAuth;
let currentModel = typeof startup.model === "string" ? startup.model : null;
let sessionMcpServers = [];
let nextServerReqId = 100;
const pendingClientResponses = new Map();
let activeCancelSignal = null;

function requestClient(method, params) {
  const id = nextServerReqId++;
  return new Promise((resolve, reject) => {
    pendingClientResponses.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function cancellableSleep(ms, cancelState) {
  return new Promise((resolve) => {
    if (cancelState.cancelled && !cancelState.ignoreCancel) {
      resolve("cancelled");
      return;
    }
    const timer = setTimeout(() => {
      cancelState.onCancel = null;
      resolve("done");
    }, ms);
    cancelState.onCancel = () => {
      if (cancelState.ignoreCancel) return;
      clearTimeout(timer);
      resolve("cancelled");
    };
  });
}

/** Spawns Otto's real `report-server.mjs` from `session/new`'s `mcpServers` and calls a tool. */
async function invokeRealMcpTool(mcpServer, toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(mcpServer.command, mcpServer.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: toolName, arguments: toolArgs },
            }) + "\n",
          );
        } else if (msg.id === 2) {
          child.stdin.end();
          resolve(msg.result);
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-agy", version: "1.0.0" } },
      }) + "\n",
    );
  });
}

function buildConfigOptions() {
  if (!currentModel) return undefined;
  return [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: currentModel, name: currentModel },
        { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro (High)" },
        { value: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
        { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      ],
    },
  ];
}

async function handleRequest(msg) {
  const { id, method, params = {} } = msg;
  logEvent({ direction: "in", id, method, params, envLeak: Object.keys(process.env).filter((k) => k.startsWith("OTTO_")) });

  switch (method) {
    case "initialize": {
      if (startup.delayMs) await new Promise((r) => setTimeout(r, startup.delayMs));
      if (startup.exit !== undefined) process.exit(startup.exit);
      reply(id, {
        protocolVersion: 1,
        agentInfo: { name: "antigravity-cli", title: "Antigravity CLI", version: "1.5.3" },
        authMethods: startup.authMethods ?? [
          { id: "oauth-personal", name: "Google Account" },
          { id: "gemini-api-key", name: "Gemini API Key" },
        ],
        agentCapabilities: {
          loadSession: startup.loadSession ?? true,
          promptCapabilities: { image: startup.image ?? true, audio: false, embeddedContext: true },
          sessionCapabilities: {
            ...(startup.sessionResume ? { resume: {} } : {}),
            ...(startup.closeSession !== false ? { close: {} } : {}),
            ...(startup.systemPrompt !== false ? { systemPrompt: {} } : {}),
          },
        },
      });
      return;
    }
    case "authenticate": {
      if (startup.failAuth) {
        replyError(id, -32000, "Authentication failed: invalid credentials");
        return;
      }
      authenticated = true;
      reply(id, {});
      return;
    }
    case "session/new": {
      if (!authenticated) {
        replyError(id, -32000, "Authentication required");
        return;
      }
      if (startup.systemPrompt === false && params.systemPrompt !== undefined) {
        replyError(id, -32602, "Invalid params: systemPrompt not supported by this agent");
        return;
      }
      sessionMcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
      const sessionId = nextSessionId();
      const configOptions = buildConfigOptions();
      reply(id, {
        sessionId,
        ...(configOptions ? { configOptions } : {}),
      });
      return;
    }
    case "session/load": {
      if (!authenticated) {
        replyError(id, -32000, "Authentication required");
        return;
      }
      sessionMcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
      const sessionId = params.sessionId;
      if (startup.replayHistoryOnLoad) {
        // Replay prior conversation updates BEFORE answering session/load, per ACP v1 spec.
        notifyUpdate(sessionId, {
          sessionUpdate: "user_message_chunk",
          messageId: "hist-u1",
          content: { type: "text", text: "Old user prompt" },
        });
        notifyUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "hist-call-1",
          name: "mcp__otto__report",
          title: "Old report from previous run",
          kind: "other",
          status: "completed",
          rawInput: { status: "done", summary: "STALE_REPLAYED_REPORT_MUST_BE_IGNORED" },
        });
        notifyUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          messageId: "hist-a1",
          content: { type: "text", text: "Old assistant answer" },
        });
      }
      const configOptions = buildConfigOptions();
      reply(id, {
        ...(configOptions ? { configOptions } : {}),
      });
      return;
    }
    case "session/resume": {
      if (!authenticated) {
        replyError(id, -32000, "Authentication required");
        return;
      }
      sessionMcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
      const configOptions = buildConfigOptions();
      reply(id, {
        ...(configOptions ? { configOptions } : {}),
      });
      return;
    }
    case "session/set_config_option": {
      if (params.configId === "model" && typeof params.value === "string") {
        currentModel = params.value;
      }
      reply(id, { configOptions: buildConfigOptions() ?? [] });
      return;
    }
    case "session/close": {
      reply(id, {});
      return;
    }
    case "session/prompt": {
      const sessionId = params.sessionId;
      const steps = scenario.runs?.[nextRunIndex()] ?? [];
      const cancelState = { cancelled: false, ignoreCancel: false, onCancel: null };
      activeCancelSignal = cancelState;
      let stopReason = "end_turn";
      let promptUsage = undefined;

      for (const step of steps) {
        if (step.ignoreCancel) cancelState.ignoreCancel = true;
        if (cancelState.cancelled && !cancelState.ignoreCancel) {
          stopReason = "cancelled";
          break;
        }
        if (step.delayMs) {
          const outcome = await cancellableSleep(step.delayMs, cancelState);
          if (outcome === "cancelled") {
            stopReason = "cancelled";
            break;
          }
        }
        if (step.configModelUpdate) {
          currentModel = step.configModelUpdate;
          notifyUpdate(sessionId, {
            sessionUpdate: "config_option_update",
            configOptions: buildConfigOptions() ?? [],
          });
        }
        if (step.thought) {
          notifyUpdate(sessionId, {
            sessionUpdate: "agent_thought_chunk",
            messageId: step.messageId ?? "thought-1",
            content: { type: "text", text: step.thought },
          });
        }
        if (step.text !== undefined) {
          notifyUpdate(sessionId, {
            sessionUpdate: "agent_message_chunk",
            messageId: step.messageId ?? "msg-1",
            content: { type: "text", text: step.text },
          });
        }
        if (step.toolCall) {
          notifyUpdate(sessionId, {
            sessionUpdate: "tool_call",
            ...step.toolCall,
          });
        }
        if (step.toolUpdate) {
          notifyUpdate(sessionId, {
            sessionUpdate: "tool_call_update",
            ...step.toolUpdate,
          });
        }
        if (step.requestPermission) {
          const permRes = await requestClient("session/request_permission", {
            sessionId,
            ...step.requestPermission,
          });
          logEvent({ direction: "permission_outcome", outcome: permRes?.outcome });
          if (permRes?.outcome?.outcome === "cancelled") {
            stopReason = "cancelled";
            break;
          }
        }
        if (step.elicitation) {
          const elicRes = await requestClient("elicitation/create", {
            sessionId,
            mode: "form",
            message: step.elicitation,
            requestedSchema: { type: "object", properties: {} },
          });
          logEvent({ direction: "elicitation_outcome", action: elicRes?.action });
        }
        if (step.callMcpPropose) {
          const ottoServer = sessionMcpServers.find((s) => s.name === "otto");
          if (!ottoServer) {
            replyError(id, -32603, "otto MCP server was not passed in mcpServers");
            activeCancelSignal = null;
            return;
          }
          await invokeRealMcpTool(ottoServer, "propose", step.callMcpPropose);
          // Deliberately omit `rawInput` so `AntigravityAdapter` must recover from `argv[3]` JSONL!
          notifyUpdate(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: `mcp-propose-${Date.now()}`,
            title: "Call otto propose",
            kind: "other",
            status: "completed",
          });
        }
        if (step.callMcpReport) {
          const ottoServer = sessionMcpServers.find((s) => s.name === "otto");
          if (!ottoServer) {
            replyError(id, -32603, "otto MCP server was not passed in mcpServers");
            activeCancelSignal = null;
            return;
          }
          await invokeRealMcpTool(ottoServer, "report", step.callMcpReport);
          // Deliberately emit tool_call WITHOUT rawInput to prove disk audit file pickup works!
          notifyUpdate(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "mcp-real-1",
            title: "Call otto report",
            kind: "other",
            status: "completed",
          });
        }
        if (step.usageUpdate) {
          notifyUpdate(sessionId, {
            sessionUpdate: "usage_update",
            ...step.usageUpdate,
          });
        }
        if (step.shell) {
          await new Promise((r) => exec(step.shell, { cwd: process.cwd() }, () => r(undefined)));
        }
        if (step.exit !== undefined) {
          process.exit(step.exit);
        }
        if (step.rpcError) {
          activeCancelSignal = null;
          replyError(id, step.rpcError.code ?? -32603, step.rpcError.message ?? "RPC error", step.rpcError.data);
          return;
        }
        if (step.stopReason) stopReason = step.stopReason;
        if (step.usage) promptUsage = step.usage;
      }

      activeCancelSignal = null;
      reply(id, {
        stopReason,
        ...(promptUsage ? { usage: promptUsage } : {}),
      });
      if (stepExitAfterReply(steps)) {
        process.exit(0);
      }
      return;
    }
    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

function stepExitAfterReply(steps) {
  return Array.isArray(steps) && steps.some((s) => s.exitAfterReply === true);
}

function handleNotification(msg) {
  logEvent({ direction: "in_notify", method: msg.method, params: msg.params });
  if (msg.method === "session/cancel" && activeCancelSignal) {
    activeCancelSignal.cancelled = true;
    if (activeCancelSignal.onCancel) activeCancelSignal.onCancel();
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
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if ("id" in msg && !("method" in msg)) {
      const waiter = pendingClientResponses.get(msg.id);
      if (waiter) {
        pendingClientResponses.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message));
        else waiter.resolve(msg.result);
      }
    } else if ("id" in msg && typeof msg.method === "string") {
      void handleRequest(msg);
    } else if (typeof msg.method === "string") {
      handleNotification(msg);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
