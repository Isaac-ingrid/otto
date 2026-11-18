#!/usr/bin/env node
// Fake `codex` CLI for CodexAdapter and WorkerManager contract tests.
// Simulates `codex --version`, `codex exec --json`, and `codex exec resume --json`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("codex-cli 0.170.0\n");
  process.exit(0);
}

const argvLog = process.env.FAKE_CODEX_ARGV_LOG;
if (argvLog) {
  mkdirSync(dirname(argvLog), { recursive: true });
  appendFileSync(argvLog, JSON.stringify(argv) + "\n");
}

const scriptPath = process.env.FAKE_CODEX_SCRIPT;
const scenario = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : { runs: [[]] };

let runIndex = 0;
if (scriptPath) {
  const counterPath = `${scriptPath}.run-idx`;
  if (existsSync(counterPath)) {
    runIndex = Number.parseInt(readFileSync(counterPath, "utf8"), 10) || 0;
  }
  writeFileSync(counterPath, String(runIndex + 1));
}

const isResume = argv[0] === "exec" && argv[1] === "resume";
let sessionId = "019a0000-0000-7000-8000-000000000001";
if (isResume) {
  // Resume session id sits right before trailing `-`
  const dashIdx = argv.lastIndexOf("-");
  if (dashIdx > 2 && argv[dashIdx - 1] && !argv[dashIdx - 1].startsWith("-")) {
    sessionId = argv[dashIdx - 1];
  }
} else if (scenario.startup?.threadId) {
  sessionId = scenario.startup.threadId;
}

const imagePaths = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "-i" && argv[i + 1]) {
    imagePaths.push({ path: argv[i + 1], exists: existsSync(argv[i + 1]) });
  }
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});

process.stdin.on("end", async () => {
  const promptLog = process.env.FAKE_CODEX_LOG;
  if (promptLog) {
    mkdirSync(dirname(promptLog), { recursive: true });
    appendFileSync(promptLog, JSON.stringify({ prompt, argv, imagePaths, stdinEnded: true }) + "\n");
  }

  const startup = scenario.startup ?? {};
  if (startup.delayMs) await new Promise((r) => setTimeout(r, startup.delayMs));
  if (typeof startup.exit === "number") {
    if (startup.stderr) process.stderr.write(String(startup.stderr) + "\n");
    process.exit(startup.exit);
  }
  if (startup.preInitError) {
    process.stdout.write(JSON.stringify({ type: "error", message: startup.preInitError }) + "\n");
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: sessionId }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");

  const codexHome = process.env.CODEX_HOME;
  let rolloutFile = null;
  if (codexHome) {
    const dir = join(codexHome, "sessions", "2026", "11", "18");
    mkdirSync(dir, { recursive: true });
    rolloutFile = join(dir, `rollout-2026-11-18T00-00-00-${sessionId}.jsonl`);
    appendFileSync(
      rolloutFile,
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: prompt } }) + "\n",
    );
  }

  const runs = Array.isArray(scenario.runs) ? scenario.runs : [[]];
  const steps = runs[Math.min(runIndex, Math.max(0, runs.length - 1))] ?? [];
  let customEnd = false;

  for (const step of steps) {
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (typeof step.exit === "number") {
      process.exit(step.exit);
    }
    if (step.emit) {
      process.stdout.write(JSON.stringify(step.emit) + "\n");
      if (rolloutFile && step.emit.type === "item.completed" && step.emit.item?.type === "agent_message") {
        appendFileSync(
          rolloutFile,
          JSON.stringify({
            type: "event_msg",
            payload: { type: "agent_message", message: step.emit.item.text },
          }) + "\n",
        );
      }
      if (step.emit.type === "turn.completed" || step.emit.type === "turn.failed" || step.emit.type === "error") {
        customEnd = true;
      }
    }
  }

  if (!customEnd) {
    process.stdout.write(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 420, cached_input_tokens: 100, output_tokens: 80 },
      }) + "\n",
    );
  }
});
