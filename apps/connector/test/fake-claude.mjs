#!/usr/bin/env node
// fake-claude: a deterministic `claude -p --output-format stream-json` stand-in for
// connector tests (issue #17, connector-pi.md §14 "fake pi" pattern applied to the second
// agent). It enforces the two contract points the spike hit live:
//
// 1. The stdin prompt is only processed on EOF: nothing happens until stdin ends — a
//    connector that writes the prompt and forgets stdin.end() hangs forever here too.
// 2. Stream events are LF-delimited JSON: system/init first, assistant messages with
//    content blocks (tool_use names arrive MCP-namespaced, e.g. mcp__otto__report),
//    and a final `result` event that ends the run and the process.
//
// Env:
//   FAKE_CLAUDE_SCRIPT    path to the JSON scenario file (required)
//   FAKE_CLAUDE_LOG       path to append consumed prompts as JSON lines (assertions)
//   FAKE_CLAUDE_ARGV_LOG  path to append the child argv at startup (invocation-shape tests)
//   CLAUDE_CONFIG_DIR     when set, appends realistic `<CLAUDE_CONFIG_DIR>/projects/<slug>/<sessionId>.jsonl`
//                         transcript lines so session-history and full-session-history tests run end-to-end
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { join } from "node:path";

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT;
if (!scriptPath) {
  console.error("fake-claude: FAKE_CLAUDE_SCRIPT is required");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scriptPath, "utf8"));

if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, JSON.stringify(process.argv) + "\n");
}

const argv = process.argv;
function argValue(flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : null;
}
const sessionId = argValue("--session-id") ?? argValue("--resume") ?? "00000000-0000-4000-8000-000000000001";
const modelArg = argValue("--model");

function transcriptFilePath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) return null;
  let physicalCwd = process.cwd();
  try {
    physicalCwd = realpathSync(physicalCwd);
  } catch {
    // keep process.cwd()
  }
  const folder = join(configDir, "projects", physicalCwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  return join(folder, `${sessionId}.jsonl`);
}

function appendTranscriptRecord(filePath, record) {
  if (!filePath) return;
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeLine(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function logPrompt(entry) {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + "\n");
}

/** Shared cross-process run counter: `<script>.runs`. */
function nextRunIndex() {
  const counterFile = `${scriptPath}.runs`;
  const current = Number.parseInt(existsSync(counterFile) ? readFileSync(counterFile, "utf8") : "0", 10) || 0;
  writeFileSync(counterFile, String(current + 1));
  return current;
}

async function playRun(steps, runIndex, transcriptPath, parentEntryUuid) {
  const merged = Array.isArray(steps) ? steps : [];
  let resultOverride = null;
  let noResult = false;
  let lastUuid = parentEntryUuid;
  let stepSeq = 0;
  for (const step of merged) {
    if (step.delayMs) await sleep(step.delayMs);
    if (step.emit) {
      writeLine(step.emit);
      if (transcriptPath && step.emit.type === "assistant" && step.emit.message) {
        stepSeq += 1;
        const uuid = step.emit.uuid ?? `fc-a-${runIndex}-${stepSeq}`;
        appendTranscriptRecord(transcriptPath, {
          type: "assistant",
          uuid,
          parentUuid: lastUuid,
          isSidechain: false,
          sessionId,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            ...(modelArg || scenario.startup?.model ? { model: scenario.startup?.model ?? modelArg } : {}),
            ...step.emit.message,
          },
        });
        lastUuid = uuid;
      }
    }
    if (step.shell) await new Promise((r) => exec(step.shell, () => r(undefined)));
    if (step.result) resultOverride = step.result;
    if (step.noResult) noResult = true;
    if (step.exit !== undefined) process.exit(step.exit);
  }
  if (!noResult) {
    writeLine({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1200,
      result: "Task complete.",
      session_id: sessionId,
      usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0 },
      total_cost_usd: 0.012,
      ...(resultOverride ?? {}),
    });
  }
  process.exit(0);
}

async function main() {
  const startup = scenario.startup ?? {};
  if (startup.delayMs) await sleep(startup.delayMs);
  if (startup.exit !== undefined) process.exit(startup.exit);
  const runIndex = nextRunIndex();
  const transcriptPath = transcriptFilePath();
  let lastUuid = null;
  if (transcriptPath && existsSync(transcriptPath)) {
    const existing = readFileSync(transcriptPath, "utf8").trim().split("\n").filter(Boolean);
    if (existing.length > 0) {
      try {
        lastUuid = JSON.parse(existing[existing.length - 1]).uuid ?? null;
      } catch {
        lastUuid = null;
      }
    }
  }
  const userUuid = `fc-u-${runIndex}`;
  appendTranscriptRecord(transcriptPath, {
    type: "user",
    uuid: userUuid,
    parentUuid: lastUuid,
    isSidechain: false,
    sessionId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: prompt },
  });

  writeLine({
    type: "system",
    subtype: "init",
    ...(startup.model ? { model: startup.model } : {}),
    session_id: sessionId,
    mcp_servers: [{ name: "otto", status: startup.mcpStatus ?? "connected" }],
  });
  const run = scenario.runs?.[runIndex] ?? [];
  await playRun(run, runIndex, transcriptPath, userUuid);
}

// The prompt is consumed only on stdin EOF (spike-conclusions §2) — this is the assertion.
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  logPrompt({ prompt, argv: process.argv, sessionId, cwd: process.cwd(), pid: process.pid, stdinEnded: true, at: Date.now() });
  main().catch((err) => {
    console.error("fake-claude:", err);
    process.exit(3);
  });
});
