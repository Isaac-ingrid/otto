#!/usr/bin/env node
/**
 * Read-only production verification suite for Otto Steward (VPS) + Local Connector (`pnpm verify:prod`).
 *
 * Checks (zero secrets read or printed):
 * 1. Local Connector daemon status, approved zero-token probes (`otto probe list`), and desktop
 *    notification state (`otto notify status`).
 * 2. Local vs. remote `steward-node.mjs` SHA-256 bundle alignment.
 * 3. Remote VPS `/opt/otto/doctor.sh` health check (systemd services, TLS cert window, SQLite backup, outbox).
 * 4. Remote SQLite migrations (`050`–`053` tables) and connected machine snapshot (`sh_machine`).
 * 5. Zero-secret loopback route liveness checks (`/api/inbound-sources`, `/api/outbound-webhooks`,
 *    and `/owner/in/github` returning 401 auth/signature gates rather than 404).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ottoCli = join(rootDir, "apps", "connector", "bin", "otto.js");
const stewardBundle = join(rootDir, "apps", "steward", "dist", "node", "steward-node.mjs");
const remoteSh = join(rootDir, "deploy", "remote.sh");
const aliyunEnvPath = join(rootDir, "deploy", "aliyun.env");

let failures = 0;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function pass(msg) {
  console.log(`  [OK]   ${msg}`);
}

function warn(msg) {
  console.log(`  [WARN] ${msg}`);
}

function failCheck(msg) {
  console.error(`  [FAIL] ${msg}`);
  failures += 1;
}

// 1. Local Connector checks
section("1/4 Local Connector Status & Stage 3/5 CLI");
try {
  const statusOut = execFileSync(process.execPath, [ottoCli, "status"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  for (const line of statusOut.trim().split("\n")) {
    console.log(`    ${line}`);
  }
  if (statusOut.includes("daemon:   running")) {
    pass("Local Connector daemon is running");
  } else {
    warn("Local Connector daemon is not running (`pnpm connector:restart` to start/reload)");
  }
  const probeOut = execFileSync(process.execPath, [ottoCli, "probe", "list"], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
  console.log(`    ${probeOut}`);
  const notifyOut = execFileSync(process.execPath, [ottoCli, "notify", "status"], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
  console.log(`    ${notifyOut}`);
  pass("`otto probe` and `otto notify` CLI commands operational");
} catch (err) {
  failCheck(`Local Connector check failed: ${err instanceof Error ? err.message : String(err)}`);
}

if (!existsSync(aliyunEnvPath)) {
  failCheck("Missing deploy/aliyun.env — cannot verify remote VPS");
  process.exit(1);
}

// 2. Bundle hash & remote doctor.sh
section("2/4 Cloud VPS Bundle Hash & doctor.sh Health Check");
const localSha16 = existsSync(stewardBundle)
  ? createHash("sha256").update(readFileSync(stewardBundle)).digest("hex").slice(0, 16)
  : "not_built";

try {
  const remoteScript = [
    "set -euo pipefail",
    "REMOTE_SHA=$(sha256sum /opt/otto/dist/node/steward-node.mjs | awk '{print substr($1,1,16)}')",
    'echo "REMOTE_SHA=$REMOTE_SHA"',
    "bash /opt/otto/doctor.sh",
  ].join("\n");
  const doctorOut = execFileSync("bash", [remoteSh, remoteScript], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const m = /^REMOTE_SHA=([0-9a-f]+)/m.exec(doctorOut);
  const remoteSha16 = m ? m[1] : "unknown";
  console.log(`    local  steward-node.mjs: ${localSha16}`);
  console.log(`    remote steward-node.mjs: ${remoteSha16}`);
  if (localSha16 !== "not_built" && localSha16 === remoteSha16) {
    pass("Remote VPS Steward bundle matches latest local build");
  } else {
    warn("Remote Steward bundle differs from latest local build — run `pnpm deploy:vps` to sync latest code");
  }
  for (const line of doctorOut.trim().split("\n")) {
    if (!line.startsWith("REMOTE_SHA=")) console.log(`    ${line}`);
  }
  pass("Remote /opt/otto/doctor.sh passed");
} catch (err) {
  failCheck(`Remote doctor.sh check failed: ${err instanceof Error ? err.message : String(err)}`);
}

// 3. SQLite migrations (050–053) & machine state
section("3/4 Cloud SQLite Migrations (050–053) & Machine Snapshot");
try {
  const expectedTables = [
    "sh_agent_cooldown",
    "sh_inbound_source",
    "sh_outbound_webhook",
    "sh_pr_blind_review",
    "sh_skipped_event",
  ];
  const sqlScript = [
    "set -euo pipefail",
    `sudo -u otto sqlite3 -readonly /var/lib/otto/steward.sqlite "SELECT 'TABLE:' || name FROM sqlite_master WHERE type='table' AND name IN ('sh_agent_cooldown','sh_inbound_source','sh_skipped_event','sh_pr_blind_review','sh_outbound_webhook') ORDER BY name;"`,
    `sudo -u otto sqlite3 -readonly /var/lib/otto/steward.sqlite "SELECT 'MACHINE:' || name || '|online=' || online || '|agents=' || COALESCE(agents,'[]') || '|probes=' || COALESCE(approvedProbes,'[]') FROM sh_machine;"`,
  ].join("\n");
  const sqlOut = execFileSync("bash", [remoteSh, sqlScript], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const foundTables = [];
  for (const line of sqlOut.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith("TABLE:")) {
      foundTables.push(line.slice("TABLE:".length));
    } else if (line.startsWith("MACHINE:")) {
      console.log(`    ${line.slice("MACHINE:".length)}`);
    }
  }
  const missing = expectedTables.filter((t) => !foundTables.includes(t));
  if (missing.length === 0) {
    pass(`All 5 Stage 1–5 SQLite tables present (${expectedTables.join(", ")})`);
  } else {
    failCheck(`Missing SQLite tables on VPS: ${missing.join(", ")} (run \`pnpm deploy:vps\` to apply migrations 050–053)`);
  }
} catch (err) {
  failCheck(`Remote SQLite inspection failed: ${err instanceof Error ? err.message : String(err)}`);
}

// 4. Zero-secret loopback route gate verification via Node http.request
section("4/4 Loopback Route Registration & Signature Gate Smoke Test");
try {
  const probeJs = [
    "const http = require('node:http');",
    "const check = (method, path) => new Promise((res, rej) => {",
    "  const req = http.request({ host: 'localhost', port: 8787, method, path }, (r) => res(r.statusCode));",
    "  req.on('error', rej);",
    "  if (method === 'POST') req.write('{}');",
    "  req.end();",
    "});",
    "Promise.all([check('GET','/api/inbound-sources'),check('GET','/api/outbound-webhooks'),check('POST','/owner/in/github')]).then(s=>console.log('STATUSES='+s.join(',')));",
  ].join(" ");
  const smokeOut = execFileSync("bash", [remoteSh, `node -e "${probeJs}"`], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const m = /STATUSES=(\d+),(\d+),(\d+)/.exec(smokeOut);
  if (!m) {
    failCheck(`Unexpected HTTP smoke output: ${smokeOut.trim()}`);
  } else {
    const [, s1, s2, s3] = m;
    if (s1 === "401") pass("GET /api/inbound-sources registered & auth-gated (HTTP 401 without token)");
    else failCheck(`GET /api/inbound-sources -> HTTP ${s1} (expected 401; 404 means older Steward bundle)`);

    if (s2 === "401") pass("GET /api/outbound-webhooks registered & auth-gated (HTTP 401 without token)");
    else failCheck(`GET /api/outbound-webhooks -> HTTP ${s2} (expected 401; 404 means older Steward bundle)`);

    if (s3 === "401") pass("POST /owner/in/github registered & HMAC-gated (HTTP 401 without signature)");
    else failCheck(`POST /owner/in/github -> HTTP ${s3} (expected 401; 404 means older Steward bundle)`);
  }
} catch (err) {
  failCheck(`Remote HTTP smoke test failed: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`\nVerification complete (${failures} failure${failures === 1 ? "" : "s"}).`);
process.exit(failures === 0 ? 0 : 1);
