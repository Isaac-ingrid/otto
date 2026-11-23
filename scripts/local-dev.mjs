#!/usr/bin/env node
/**
 * One-command local isolated Steward + Connector dev/test stack manager.
 *
 * Isolates all local test state under `/tmp/otto-local-test` (or `$OTTO_LOCAL_DIR`) so your
 * production `~/.otto` Connector (paired to your cloud server) is NEVER touched or repointed.
 *
 * Usage:
 *   pnpm local:up [steward|connector] [--no-build]   Build & start isolated Steward + auto-paired Connector
 *   pnpm local:restart [steward|connector] [--no-build] Rebuild & restart one or both processes cleanly
 *   pnpm local:down [steward|connector]              Stop isolated local process(es)
 *   pnpm local:status                                Check PIDs, HTTP health, Connector status & fresh login link
 *   pnpm local:logs [steward|connector]              Show recent Steward & Connector logs
 *   pnpm local:reset                                 Stop, wipe `/tmp/otto-local-test`, and start fresh
 *
 * Environment overrides:
 *   OTTO_LOCAL_DIR      Base state dir (default: /tmp/otto-local-test)
 *   HOST                Bind host (default: 127.0.0.1)
 *   PORT                Bind port (default: 8787)
 *   OTTO_MACHINE_NAME   Local test connector name (default: mac-local-dev)
 *   LOGIN_PASSWORD      Initial browser password (>= 15 chars; auto-generated & saved if unset)
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseDir = resolve(process.env.OTTO_LOCAL_DIR?.trim() || "/tmp/otto-local-test");
const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const origin = `http://${host}:${port}`;
const machineName = process.env.OTTO_MACHINE_NAME?.trim() || "mac-local-dev";

const configDir = join(baseDir, "config");
const devVarsPath = join(configDir, ".dev.vars");
const stewardDbPath = join(baseDir, "steward.sqlite");
const connectorHome = join(baseDir, "connector");
const pidDir = join(baseDir, "pids");
const logDir = join(baseDir, "logs");

const stewardBundle = join(rootDir, "apps", "steward", "dist", "node", "steward-node.mjs");
const connectorCli = join(rootDir, "apps", "connector", "bin", "otto.js");

const rawArgs = process.argv.slice(2);
const noBuild = rawArgs.includes("--no-build");
const positional = rawArgs.filter((a) => !a.startsWith("--"));
const action = positional[0] || "status";
const targetArg = positional[1] || "all";

if (!["up", "start", "restart", "down", "stop", "status", "logs", "reset", "help"].includes(action)) {
  console.error(
    `local-dev: unknown command '${action}' (expected: up | restart | down | status | logs | reset)`,
  );
  process.exit(2);
}
if (!["all", "steward", "connector"].includes(targetArg)) {
  console.error(`local-dev: unknown target '${targetArg}' (expected: all | steward | connector)`);
  process.exit(2);
}

const wantSteward = targetArg === "all" || targetArg === "steward";
const wantConnector = targetArg === "all" || targetArg === "connector";

function ensureDirs() {
  for (const dir of [baseDir, configDir, connectorHome, pidDir, logDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

function parseSimpleVars(filePath) {
  const out = {};
  if (!existsSync(filePath)) return out;
  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function ensureDevVars() {
  ensureDirs();
  const existing = parseSimpleVars(devVarsPath);
  const serverKey = existing.SERVER_KEY || process.env.SERVER_KEY || randomBytes(32).toString("hex");
  let loginPassword = process.env.LOGIN_PASSWORD?.trim() || existing.LOGIN_PASSWORD || "";
  if ([...loginPassword].length < 15) {
    loginPassword = `OttoLocal-${randomBytes(9).toString("base64url")}`;
  }
  const merged = {
    ...existing,
    SERVER_KEY: serverKey,
    LOGIN_PASSWORD: loginPassword,
    OTTO_PUBLIC_ORIGIN: origin,
  };
  for (const optionalKey of ["STEWARD_MODEL", "MODEL_KEY", "DAILY_BUDGET_USD", "OTTO_GITHUB_READ_TOKEN"]) {
    if (process.env[optionalKey] && !merged[optionalKey]) {
      merged[optionalKey] = process.env[optionalKey];
    }
  }
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  writeFileSync(devVarsPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  return merged;
}

function pidFileFor(name) {
  return join(pidDir, `${name}.pid`);
}

function logFileFor(name) {
  return join(logDir, `${name}.log`);
}

function readLivePid(name) {
  const pFile = pidFileFor(name);
  if (!existsSync(pFile)) return null;
  const pid = Number(readFileSync(pFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    try {
      unlinkSync(pFile);
    } catch {}
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopProcess(name) {
  const pid = readLivePid(name);
  if (!pid) {
    console.log(`[${name}] already stopped`);
    return;
  }
  console.log(`[${name}] stopping pid ${pid}…`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    try {
      process.kill(pid, 0);
    } catch {
      try {
        unlinkSync(pidFileFor(name));
      } catch {}
      console.log(`[${name}] stopped cleanly`);
      return;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  try {
    unlinkSync(pidFileFor(name));
  } catch {}
  console.log(`[${name}] force-killed pid ${pid}`);
}

function buildBundles() {
  if (noBuild) return;
  if (wantConnector) {
    console.log("==> Building Connector (apps/connector/dist/cli.js)…");
    execFileSync(process.execPath, ["build.mjs"], {
      cwd: join(rootDir, "apps", "connector"),
      stdio: "inherit",
    });
  }
  if (wantSteward) {
    console.log("==> Building Steward Node bundle (apps/steward/dist/node/steward-node.mjs)…");
    execFileSync(process.execPath, ["scripts/build-node.mjs"], {
      cwd: join(rootDir, "apps", "steward"),
      stdio: "inherit",
    });
  }
}

function loopbackRequest(method, path, headers = {}, bodyObj) {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        hostname: host,
        port,
        path,
        method,
        headers: {
          ...(payload !== null
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
        timeout: 4000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolvePromise({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", rejectPromise);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function waitForStewardHttp(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await loopbackRequest("GET", "/");
      if (res.status > 0) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

function spawnDetached(name, args, envExtra) {
  ensureDirs();
  const logPath = logFileFor(name);
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...envExtra },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  if (!child.pid) throw new Error(`failed to spawn ${name}`);
  writeFileSync(pidFileFor(name), `${child.pid}\n`);
  child.unref();
  return child.pid;
}

function connectorAlreadyPaired() {
  const dbFile = join(connectorHome, "connector.sqlite");
  if (!existsSync(dbFile)) return false;
  try {
    const db = new DatabaseSync(dbFile, { open: true, readOnly: true });
    const row = db
      .prepare("SELECT serverUrl, deviceId, token FROM credentials WHERE id = 1")
      .get();
    db.close();
    return Boolean(row && row.deviceId && row.token && row.serverUrl === origin);
  } catch {
    return false;
  }
}

async function startSteward(vars) {
  const existingPid = readLivePid("steward");
  if (existingPid) {
    console.log(`[steward] already running (pid ${existingPid}) at ${origin}`);
    return existingPid;
  }
  if (!existsSync(stewardBundle)) {
    execFileSync(process.execPath, ["scripts/build-node.mjs"], {
      cwd: join(rootDir, "apps", "steward"),
      stdio: "inherit",
    });
  }
  const pid = spawnDetached("steward", [stewardBundle], {
    OTTO_DB_PATH: stewardDbPath,
    OTTO_CONFIG_DIR: configDir,
    HOST: host,
    PORT: String(port),
    LOGIN_PASSWORD: vars.LOGIN_PASSWORD,
    SERVER_KEY: vars.SERVER_KEY,
    OTTO_PUBLIC_ORIGIN: origin,
  });
  const ready = await waitForStewardHttp(10_000);
  if (!ready || !readLivePid("steward")) {
    console.error(`[steward] failed to start! Recent log (${logFileFor("steward")}):`);
    if (existsSync(logFileFor("steward"))) {
      console.error(readFileSync(logFileFor("steward"), "utf8").split("\n").slice(-25).join("\n"));
    }
    process.exit(1);
  }
  console.log(`[steward] started (pid ${pid}) -> ${origin}`);
  return pid;
}

async function startConnector(vars) {
  const existingPid = readLivePid("connector");
  if (existingPid) {
    console.log(`[connector] already running (pid ${existingPid}, machine: ${machineName})`);
    return existingPid;
  }
  if (!existsSync(join(rootDir, "apps", "connector", "dist", "cli.js"))) {
    execFileSync(process.execPath, ["build.mjs"], {
      cwd: join(rootDir, "apps", "connector"),
      stdio: "inherit",
    });
  }
  const paired = connectorAlreadyPaired();
  let cliArgs;
  if (!paired) {
    const stewardUp = await waitForStewardHttp(3000);
    if (!stewardUp) {
      console.error(
        `[connector] local Steward is not reachable at ${origin} yet — run 'pnpm local:up' to start both and auto-pair.`,
      );
      process.exit(1);
    }
    const pairRes = await loopbackRequest("POST", "/api/pairing", {
      authorization: `Bearer ${vars.SERVER_KEY}`,
    });
    if (pairRes.status !== 200) {
      throw new Error(`failed to mint local pairing code (${pairRes.status}): ${pairRes.text}`);
    }
    const { code } = JSON.parse(pairRes.text);
    console.log(`[connector] auto-pairing '${machineName}' against ${origin}…`);
    cliArgs = [connectorCli, "connect", origin, code, "--foreground"];
  } else {
    cliArgs = [connectorCli, "daemon"];
  }

  const pid = spawnDetached("connector", cliArgs, {
    OTTO_HOME: connectorHome,
    OTTO_MACHINE_NAME: machineName,
  });
  await sleep(600);
  if (!readLivePid("connector")) {
    console.error(`[connector] exited early! Recent log (${logFileFor("connector")}):`);
    if (existsSync(logFileFor("connector"))) {
      console.error(readFileSync(logFileFor("connector"), "utf8").split("\n").slice(-25).join("\n"));
    }
    process.exit(1);
  }
  console.log(`[connector] started (pid ${pid}, OTTO_HOME=${connectorHome})`);
  return pid;
}

async function mintLoginLink(vars) {
  try {
    const res = await loopbackRequest("POST", "/api/login-link", {
      authorization: `Bearer ${vars.SERVER_KEY}`,
    });
    if (res.status === 200) {
      return JSON.parse(res.text).url || null;
    }
  } catch {}
  return null;
}

function tailLines(filePath, n = 30) {
  if (!existsSync(filePath)) return "(no log file yet)";
  const lines = readFileSync(filePath, "utf8").trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

async function printSummary(vars) {
  const sPid = readLivePid("steward");
  const cPid = readLivePid("connector");
  const httpUp = sPid ? await waitForStewardHttp(1200) : false;
  const loginLink = httpUp ? await mintLoginLink(vars) : null;

  console.log("\n=== Otto Local Isolated Dev Stack ===");
  console.log(`State dir:       ${baseDir}  (production ~/.otto untouched)`);
  console.log(`Steward:         ${sPid ? `running (pid ${sPid})` : "stopped"} · ${origin}/app`);
  console.log(`Connector:       ${cPid ? `running (pid ${cPid}, ${machineName})` : "stopped"} · ${connectorHome}`);
  console.log(`Login password:  ${vars.LOGIN_PASSWORD}`);
  if (loginLink) {
    console.log(`1-click sign-in: ${loginLink}`);
  }
  console.log(`Logs:            pnpm local:logs   (${logDir})`);
}

async function main() {
  if (action === "help") {
    console.log(
      "Usage: pnpm local:up | pnpm local:restart [steward|connector] | pnpm local:down | pnpm local:status | pnpm local:logs | pnpm local:reset",
    );
    return;
  }

  if (action === "reset") {
    await stopProcess("connector");
    await stopProcess("steward");
    rmSync(baseDir, { recursive: true, force: true });
    console.log(`Wiped ${baseDir}`);
    buildBundles();
    const vars = ensureDevVars();
    await startSteward(vars);
    await startConnector(vars);
    await printSummary(vars);
    return;
  }

  if (action === "down" || action === "stop") {
    if (wantConnector) await stopProcess("connector");
    if (wantSteward) await stopProcess("steward");
    return;
  }

  if (action === "logs") {
    if (wantSteward) {
      console.log(`==> Steward log (${logFileFor("steward")}) <==`);
      console.log(tailLines(logFileFor("steward"), 40));
    }
    if (wantConnector) {
      console.log(`\n==> Connector log (${join(connectorHome, "logs", "connector.log")}) <==`);
      const jsonl = join(connectorHome, "logs", "connector.log");
      console.log(existsSync(jsonl) ? tailLines(jsonl, 30) : tailLines(logFileFor("connector"), 30));
    }
    return;
  }

  const vars = ensureDevVars();

  if (action === "status") {
    await printSummary(vars);
    if (existsSync(join(connectorHome, "connector.sqlite"))) {
      console.log("\n--- Connector CLI status ---");
      execFileSync(process.execPath, [connectorCli, "status"], {
        cwd: rootDir,
        env: { ...process.env, OTTO_HOME: connectorHome, OTTO_MACHINE_NAME: machineName },
        stdio: "inherit",
      });
    }
    return;
  }

  if (action === "restart") {
    buildBundles();
    if (wantConnector) await stopProcess("connector");
    if (wantSteward) await stopProcess("steward");
    if (wantSteward) await startSteward(vars);
    if (wantConnector) await startConnector(vars);
    await printSummary(vars);
    return;
  }

  if (action === "up" || action === "start") {
    buildBundles();
    if (wantSteward) await startSteward(vars);
    if (wantConnector) await startConnector(vars);
    await printSummary(vars);
  }
}

main().catch((err) => {
  console.error(`local-dev: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
