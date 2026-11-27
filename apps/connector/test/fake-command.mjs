#!/usr/bin/env node
// Offline contract fixture for `CommandAdapter` (`dsh` 0.2.2+ `headless --json` NDJSON
// `session` / `step_end` / `final` stream and `zcode -p ... --mode edit|plan --json` presets).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("dsh 0.2.4-fake\n");
  process.exit(0);
}

const logFile = process.env.FAKE_CMD_LOG;
if (logFile) {
  appendFileSync(
    logFile,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      hasOttoToken: Object.keys(process.env).some(
        (k) => k.startsWith("OTTO_") && k !== "OTTO_REPORT_FILE" && k !== "OTTO_PROPOSALS_FILE",
      ),
      reportFile: process.env.OTTO_REPORT_FILE ?? null,
    }) + "\n",
  );
}

const scenario = process.env.FAKE_CMD_SCENARIO
  ? JSON.parse(readFileSync(process.env.FAKE_CMD_SCENARIO, "utf8"))
  : {};

if (typeof scenario.rawStdout === "string") {
  process.stdout.write(scenario.rawStdout);
} else if (Array.isArray(scenario.lines)) {
  for (const line of scenario.lines) {
    process.stdout.write((typeof line === "string" ? line : JSON.stringify(line)) + "\n");
  }
}

if (scenario.reportFilePayload && process.env.OTTO_REPORT_FILE) {
  writeFileSync(process.env.OTTO_REPORT_FILE, JSON.stringify(scenario.reportFilePayload));
}

if (scenario.stderr) {
  process.stderr.write(String(scenario.stderr) + "\n");
}

process.exit(scenario.exitCode ?? 0);
