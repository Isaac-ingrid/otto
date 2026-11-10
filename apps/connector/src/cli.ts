#!/usr/bin/env node
// `npx @isaac2ingrid/otto <command>` (ADR-0014; npm scope: ADR-0013).
//
//   connect <url> <code>   redeem a pairing code, then install + start the background
//                          service (launchd agent on macOS, systemd --user unit on Linux,
//                          a per-user Run key on Windows); --foreground runs the daemon
//                          in this terminal instead;
//                          --proxy <url> routes fetch/ws/git/workers through an HTTP
//                          proxy (issue #68) and stores it for the service
//   status                 service state, pairing, workers, installed assets
//   proxy [<url>|--clear]  show / set / clear the stored proxy (loopback never proxied)
//   doctor                 pairing, service, proxy, and reachability diagnosis
//   logs [-n N] [name]     tail ~/.otto/logs/<name> (default connector.log)
//   start | stop | restart control the background service (stop also disables start-at-login)
//   uninstall              stop the service and remove its unit (keeps ~/.otto data)
//   upgrade [--version V]  npm-install @isaac2ingrid/otto (default @latest) and restart the
//                          service; the fresh daemon rewrites the versioned pi assets
//   repo-config <path> [--isolation worktree|in-place] [--concurrency parallel|serial]
//                          [--approve|--no-approve]
//                          per-repo local settings (§8.2/§13): how write tasks get a
//                          directory, and whether pi runs with --approve there. Never
//                          settable by a remote command — only here, on the machine
//   daemon                 internal: the background service's entry point; refuses to start
//                          when another daemon already holds this state directory (ADR-0018
//                          decision 10), as does `connect --foreground`
import { existsSync, readdirSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { runDaemon } from "./daemon.ts";
import {
  acquireDaemonLock,
  DAEMON_LOCK_FILE,
  daemonLockStatus,
  releaseDaemonLock,
} from "./daemon-lock.ts";
import { installAssets } from "./install.ts";
import { tailFile } from "./logger.ts";
import { connect } from "./pairing.ts";
import {
  applyProxy,
  effectiveNoProxy,
  normalizeProxyConfig,
  proxyLogFields,
  resolveProxyConfig,
  type ProxyConfig,
} from "./proxy.ts";
import { getServiceInstaller, OTTO_LABEL, type ServiceInstaller, type ServiceSpec } from "./service.ts";
import { launchCheck, PI_COMMAND_ENV, piCommandFromEnv, resolveExecutableLaunch } from "./pi-launch.ts";
import { LocalStore } from "./store.ts";
import { identifyWorkspace } from "./worktree.ts";
import { runUpgrade } from "./upgrade.ts";
import { VERSION } from "./version.ts";
import { isConcurrency, isIsolation } from "./write-policy.ts";
import type { RepoCapability } from "@isaac2ingrid/protocol";

const exec = promisify(execFile);

const DEFAULT_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function stateDir(): string {
  // An empty value means unset. `??` alone would hand the store a bare "connector.sqlite",
  // i.e. create and read credentials in whatever directory the command happened to run in —
  // the same class of surprise the OTTO_HOME guard above exists to prevent.
  const configured = process.env.OTTO_HOME?.trim();
  return configured ? configured : join(homedir(), ".otto");
}

/** The bin wrapper this package ships; both src/cli.ts (dev) and dist/cli.js sit one
 * directory below the package root, so ../bin/otto.js is correct in either layout. */
export function binEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "otto.js");
}

const USAGE = `otto ${VERSION} — the Otto connector

usage:
  otto connect <url> <code> [--proxy <url>] [--foreground]
                                          pair and install the background service; --proxy
                                          routes both channels through an HTTP proxy
                                          (issue #68; also captured from HTTPS_PROXY)
  otto status                                 service, pairing, workers, assets
  otto proxy [<url> | --clear] [--no-proxy <list>]
                                          show / set / clear the stored proxy (no_proxy
                                          bypasses hosts; loopback always bypassed)
  otto doctor                                 pairing, service, proxy, and reachability check
  otto logs [-n <lines>] [name]               tail ~/.otto/logs (default connector.log)
  otto start | stop | restart                 control the background service
  otto uninstall                              remove the service (keeps ~/.otto data)
  otto upgrade [--version <version>]          replace the package and restart the service
  otto repo-config <path> [options]           per-repo local settings (write isolation,
                                                  concurrency, project trust); never settable
                                                  remotely
  otto daemon                                 internal: run the connector daemon

Register repositories in the web workspace under Machines > Add directory.

environment:
  OTTO_HOME         state directory (default ~/.otto)
  OTTO_MACHINE_NAME machine name reported to the steward
  HTTPS_PROXY      captured into the stored proxy by 'otto connect' when no --proxy is given`;

function usage(code = 2): never {
  console.error(USAGE);
  process.exit(code);
}

function fail(message: string): never {
  console.error(`otto: ${message}`);
  process.exit(1);
}

/** Removes one `--flag [value]` pair from argv, returning [present, value, rest]. `value`
 *  is undefined both when the flag is absent and when it trails the argv without a value —
 *  `present` tells the two apart so a missing value can fail loudly. */
function takeFlag(argv: string[], flag: string): { present: boolean; value?: string; rest: string[] } {
  const index = argv.indexOf(flag);
  if (index === -1) return { present: false, rest: argv };
  const value = argv[index + 1];
  const rest = [...argv.slice(0, index), ...(value === undefined ? [] : argv.slice(index + 2))];
  return { present: true, value, rest };
}

/** Fails when this machine cannot run the background service at all, or cannot reach the
 *  service manager that would run it. Called from `connect` *before* pairing, because the
 *  pairing code is single-use: `otto connect` used to redeem the code and only then discover
 *  that install() could not work here (a platform with no autostart, a headless Linux session
 *  with no user bus, a Windows box with the Run key disabled by policy), so each retry needed a
 *  freshly generated code. */
async function preflightService(): Promise<void> {
  const installer = requireInstaller();
  await installer.preflight?.();
}

function requireInstaller(): ServiceInstaller {
  const spec = serviceSpec(binEntryPath());
  const installer = getServiceInstaller(spec);
  if (!installer) {
    fail(
      `background services are not supported on ${process.platform} ` +
        `(launchd on macOS / systemd on Linux / the Run key on Windows) — ` +
        `run \`otto connect <url> <code> --foreground\``,
    );
  }
  return installer;
}

function serviceSpec(entryPath: string): ServiceSpec {
  const dir = stateDir();
  const env: Record<string, string> = { PATH: process.env.PATH ?? DEFAULT_PATH, OTTO_HOME: dir };
  const machineName = process.env.OTTO_MACHINE_NAME;
  if (machineName) env.OTTO_MACHINE_NAME = machineName;
  return {
    label: OTTO_LABEL,
    nodePath: process.execPath,
    entryPath,
    args: ["daemon"],
    env,
    stateDir: dir,
    logDir: join(dir, "logs"),
  };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") usage(command ? 0 : 2);
  if (command === "-v" || command === "--version") {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case "connect":
      return connectCommand(rest);
    case "status":
      return statusCommand();
    case "proxy":
      return proxyCommand(rest);
    case "doctor":
      return doctorCommand();
    case "logs":
      return logsCommand(rest);
    case "start":
    case "stop":
    case "restart":
      return serviceCommand(command);
    case "uninstall":
      return uninstallCommand();
    case "upgrade":
      return upgradeCommand(rest);
    case "repo-config":
      return repoConfig(rest);
    case "daemon":
      return daemonCommand();
    default:
      usage();
  }
}

// --- connect ---------------------------------------------------------------------------------

async function connectCommand(argv: string[]): Promise<void> {
  const { present: proxyPresent, value: proxyFlag, rest: afterProxy } = takeFlag(argv, "--proxy");
  const foreground = afterProxy.includes("--foreground");
  const [url, code] = afterProxy.filter((a) => a !== "--foreground");
  if (!url || !code) usage();
  if (proxyPresent && !proxyFlag) fail("--proxy needs a value, e.g. --proxy http://127.0.0.1:7890");
  const dir = stateDir();
  // A non-default state directory must stop before anything else: the launchd/systemd unit or
  // the Run key is shared machine state (fixed label), so installing from a private state
  // directory would silently repoint the machine's own connector at it.
  if (process.env.OTTO_HOME && !foreground) {
    fail(
      "OTTO_HOME is set to a private state directory; installing the shared background service would repoint this machine's connector. Use --foreground, or unset it.",
    );
  }
  const machineName = process.env.OTTO_MACHINE_NAME ?? hostname();

  // 1. Refuse before spending the code. Pairing is single-use (protocol §5.2: the first
  //    successful /pair redeems it), and both shapes below are facts about this machine, not
  //    preferences — no autostart on this platform, a service manager this session cannot
  //    reach (systemd bus, launchd gui domain, a Run key disabled by policy), or another daemon
  //    already holding this state directory (`--foreground`). Discovering any of them *after*
  //    pairing costs the owner a fresh code for every retry. `--foreground` is the escape hatch
  //    for the first two.
  //
  //    The daemon-lock check is only for `--foreground`: on the service path the installer
  //    restarts the machine's one daemon (which releases the lock on SIGTERM), so refusing
  //    there would break a legitimate re-pair.
  if (foreground) refuseIfDaemonRunning(dir);
  else await preflightService();

  // 2. Proxy (issue #68), resolved before pairing so the /pair fetch itself goes through
  //    it. An explicit --proxy wins; a stored config is kept; otherwise the shell's
  //    HTTPS_PROXY is captured into storage — the background service never depends on an
  //    inherited environment. Git children and pi workers follow via process.env.
  const store = new LocalStore(join(dir, "connector.sqlite"));
  const resolvedProxy = resolveProxyConfig({ flag: proxyFlag, stored: store.getProxyConfig(), env: process.env });
  let proxiedFetch: typeof fetch | undefined;
  if (resolvedProxy.config) {
    // The pairing fetch below goes through the proxy via undici's own fetch — the built-in
    // fetch and a bundled dispatcher can mismatch handler protocols across Node versions.
    const application = applyProxy(resolvedProxy.config);
    proxiedFetch = application.fetch;
    store.setProxyConfig(resolvedProxy.config);
    const fields = proxyLogFields(resolvedProxy.config);
    console.log(
      `proxy: ${fields.proxy} (no_proxy: ${fields.noProxy}, from ${resolvedProxy.source}) — stored; the service, git, and workers inherit it`,
    );
  }

  // 3. Pair (protocol §5.2): redeem the code once, persist credentials in the LocalStore.
  let deviceId: string;
  try {
    ({ deviceId } = await connect(url, code, machineName, { store, fetchImpl: proxiedFetch }));
  } catch (err) {
    store.close();
    fail(err instanceof Error ? err.message : String(err));
  }
  store.close();

  // 4. Write this version's pi assets so even a foreground run is ready to start workers.
  installAssets(dir);

  // 5. Install and start the background service. `--foreground` keeps the old behavior:
  //    hold the connection in this terminal (dev boxes, containers, unsupported platforms).
  if (foreground) {
    console.log(`paired as ${deviceId}; running in foreground (Ctrl-C to stop)`);
    console.log(`next: open ${new URL("/app/machines", url)} to add a Git directory`);
    return runDaemonAttached(dir, machineName);
  }

  const installer = requireInstaller();
  try {
    await installer.install();
  } catch (err) {
    fail(
      `${err instanceof Error ? err.message : String(err)}\n` +
        `  the service could not be installed; pair again with --foreground to run attached instead`,
    );
  }
  const status = await installer.status();
  console.log(`paired as ${deviceId}`);
  console.log(
    `background service ${status.running ? "installed and running" : "installed"} ` +
      `(${installer.kind}: ${installer.unitPath})`,
  );
  for (const note of installer.notes) console.log(`note: ${note}`);
  console.log(`logs: ${join(dir, "logs", "connector.log")}`);
  console.log(`next: open ${new URL("/app/machines", url)} to add a Git directory · otto status · otto logs`);
}

// --- status / logs ---------------------------------------------------------------------------

// --- proxy / doctor (issue #68) ---------------------------------------------------------------

/** `otto proxy [url] | --clear [--no-proxy <list>]`: show, set, or clear the stored proxy.
 *  The running service picks the change up on its next start (`otto restart`). */
async function proxyCommand(argv: string[]): Promise<void> {
  const { present: noProxyPresent, value: noProxyFlag, rest: afterNoProxy } = takeFlag(argv, "--no-proxy");
  const clear = afterNoProxy.includes("--clear");
  const positional = afterNoProxy.filter((a) => !a.startsWith("--"));
  if (clear && positional.length > 0) usage();
  if (positional.length > 1) usage();
  if (!clear && positional.length === 0 && noProxyPresent) usage();
  if (noProxyPresent && !noProxyFlag) fail("--no-proxy needs a value, e.g. --no-proxy localhost,.corp.example");
  const dbPath = join(stateDir(), "connector.sqlite");
  if (!existsSync(dbPath)) {
    if (positional.length === 0 && !clear) {
      console.log("proxy: none (not paired yet)");
      return;
    }
    fail("not paired yet — pair with `otto connect <url> <code>` first");
  }
  const store = new LocalStore(dbPath);
  try {
    if (clear) {
      store.clearProxyConfig();
      console.log("proxy: cleared");
    } else if (positional[0]) {
      const config = normalizeProxyConfig(positional[0], noProxyFlag);
      store.setProxyConfig(config);
      const fields = proxyLogFields(config);
      console.log(`proxy: ${fields.proxy} (no_proxy: ${fields.noProxy}) stored`);
    } else {
      const config = store.getProxyConfig();
      if (config) {
        const fields = proxyLogFields(config);
        console.log(`proxy: ${fields.proxy} (no_proxy: ${fields.noProxy})`);
      } else {
        console.log("proxy: none");
      }
    }
  } finally {
    store.close();
  }
  await noteServiceRestart();
}

/** One-line reminder when the background service is up: it re-reads the proxy on start. */
async function noteServiceRestart(): Promise<void> {
  try {
    const installer = getServiceInstaller(serviceSpec(binEntryPath()));
    if (!installer) return;
    const status = await installer.status();
    if (status.installed && status.running) console.log("note: run `otto restart` for the running service to pick this up");
  } catch {
    // Service state is a nicety here, never a failure of the command itself.
  }
}

/** `otto doctor`: pairing, service, proxy, and reachability of the steward — direct vs via
 *  the configured proxy — with the next action spelled out. Exits non-zero when no path
 *  to the steward works. */
async function doctorCommand(): Promise<void> {
  let healthy = true;
  console.log(`otto ${VERSION} · node ${process.version} · ${process.platform}/${process.arch}`);

  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number, ...number[]];
  const nodeOk = major > 22 || (major === 22 && minor >= 18);
  console.log(`node ≥ 22.18:        ${nodeOk ? "ok" : "FAIL — upgrade Node"}`);
  if (!nodeOk) healthy = false;

  // The agent launch, checked for spawnability: a wrong OTTO_PI_COMMAND (unquoted path with a
  // space) used to fail only inside a worker's stderr log, after a task was already dispatched.
  const pi = resolveExecutableLaunch(piCommandFromEnv() ?? ["pi"]);
  const piCheck = launchCheck(pi);
  console.log(
    `pi:                 ${pi.source}${pi.detail ? ` — ${pi.detail}` : ""}${piCheck.ok ? "" : ` — FAIL: ${piCheck.detail}`}`,
  );
  if (!piCheck.ok) {
    healthy = false;
    if (!pi.error) console.log(`                    ${PI_COMMAND_ENV} paths with a space need inner quotes: "C:\\Program Files\\nodejs\\node.exe" <launcher.js> …`);
  }

  const dbPath = join(stateDir(), "connector.sqlite");
  let serverUrl: string | null = null;
  let config: ProxyConfig | null = null;
  if (!existsSync(dbPath)) {
    console.log("paired:             not paired — `otto connect <url> <code>`");
    healthy = false;
  } else {
    const store = new LocalStore(dbPath);
    try {
      const credentials = store.getCredentials();
      if (!credentials) {
        console.log("paired:             no credentials — `otto connect <url> <code>`");
        healthy = false;
      } else {
        serverUrl = credentials.serverUrl;
        console.log(`paired:             ${credentials.deviceId} → ${credentials.serverUrl}`);
      }
      config = store.getProxyConfig();
    } finally {
      store.close();
    }
  }

  try {
    const installer = getServiceInstaller(serviceSpec(binEntryPath()));
    if (installer) {
      const status = await installer.status();
      const detail = status.installed
        ? status.running
          ? `running${status.pid ? ` (pid ${status.pid})` : ""}`
          : "installed, not running — `otto start`"
        : "not installed";
      console.log(`service:            ${detail} (${installer.kind})`);
    } else {
      console.log("service:            not supported on this platform — use `otto connect --foreground`");
    }
  } catch (err) {
    console.log(`service:            unknown (${err instanceof Error ? err.message : String(err)})`);
  }

  if (config) {
    const fields = proxyLogFields(config);
    console.log(`proxy:              ${fields.proxy} (no_proxy: ${fields.noProxy})`);
  } else {
    console.log("proxy:              none");
  }

  if (serverUrl) {
    // Any HTTP response proves the path (401 is the expected unauthenticated gate). The
    // probes go through undici's own fetch — same package as the dispatchers, so the
    // request-handler protocol can't mismatch Node's built-in fetch across versions.
    const probe = async (dispatcher: Dispatcher): Promise<{ ok: boolean; detail: string }> => {
      try {
        const res = await undiciFetch(`${serverUrl}/app`, {
          dispatcher,
          signal: AbortSignal.timeout(8000),
        });
        return { ok: true, detail: `HTTP ${res.status}` };
      } catch (err) {
        const cause = (err as { cause?: { code?: string } })?.cause?.code;
        return { ok: false, detail: cause ?? (err instanceof Error ? err.message : String(err)) };
      }
    };
    // A fresh Agent bypasses any active global dispatcher — the direct probe must be direct.
    const direct = await probe(new Agent({ connect: { timeout: 5000 } }));
    console.log(`reach direct:       ${direct.ok ? "ok" : "FAIL"} (${direct.detail})`);
    let viaProxy: { ok: boolean; detail: string } | null = null;
    if (config) {
      viaProxy = await probe(
        new EnvHttpProxyAgent({ httpProxy: config.url, httpsProxy: config.url, noProxy: effectiveNoProxy(config) }),
      );
      console.log(`reach via proxy:    ${viaProxy.ok ? "ok" : "FAIL"} (${viaProxy.detail})`);
    }
    if (direct.ok) {
      console.log("the steward answers directly — the proxy is optional");
    } else if (viaProxy?.ok) {
      console.log("direct is blocked but the configured proxy works — expected on filtered networks");
    } else if (!config) {
      healthy = false;
      console.log(`cannot reach ${serverUrl} directly and no proxy is configured — on filtered networks: otto proxy http://127.0.0.1:7890`);
    } else {
      healthy = false;
      console.log("neither direct nor the configured proxy reaches the steward — check the proxy client is running and its port");
    }
  }

  process.exitCode = healthy ? 0 : 1;
}

async function statusCommand(): Promise<void> {
  const dir = stateDir();
  console.log(`otto ${VERSION} (node ${process.version}, ${process.platform})`);

  const installer = getServiceInstaller(serviceSpec(binEntryPath()));
  if (installer) {
    const status = await installer.status();
    const pid = status.pid ? ` pid ${status.pid}` : "";
    console.log(
      `service:  ${installer.kind} ${OTTO_LABEL} — ${status.installed ? (status.running ? `running${pid} (${status.detail})` : `not running (${status.detail})`) : "not installed"}`,
    );
  } else {
    console.log(`service:  not supported on ${process.platform} — run \`otto connect --foreground\``);
  }

  // The daemon's own lock, not the service manager's view: the two answer different questions
  // (the lock also covers `otto daemon` and `connect --foreground`, which install nothing), and
  // it is the only way to tell a running connector from a stale lock file.
  const lock = daemonLockStatus(dir);
  if (!lock.present) {
    console.log(`daemon:   not running (no ${DAEMON_LOCK_FILE})`);
  } else if (lock.held) {
    const since = lock.startedAt ? ` since ${new Date(lock.startedAt).toLocaleString()}` : "";
    const version = lock.version ? ` (v${lock.version})` : "";
    console.log(`daemon:   running pid ${lock.pid ?? "?"}${since}${version}`);
  } else {
    console.log(`daemon:   stale lock on pid ${lock.pid ?? "?"} — the next start replaces it`);
  }

  // What the connector will actually spawn for the agent. On Windows this is not the bare
  // `pi` name: the `pi.cmd` shim is resolved to its real JS entry (pi-launch.ts), and seeing
  // that here is how a "pi works in my shell but not from otto" report gets diagnosed.
  const pi = resolveExecutableLaunch(piCommandFromEnv() ?? ["pi"]);
  const piCheck = launchCheck(pi);
  console.log(
    `pi:       ${pi.source}${pi.detail ? ` — ${pi.detail}` : ""}${piCheck.ok ? "" : ` — NOT SPAWNABLE: ${piCheck.detail}`}`,
  );
  if (!piCheck.ok) {
    if (!pi.error) console.log(`          ${PI_COMMAND_ENV} paths that contain a space need quotes around them: "C:\\Program Files\\nodejs\\node.exe" <launcher.js> …`);
  }

  const dbPath = join(dir, "connector.sqlite");
  if (!existsSync(dbPath)) {
    console.log("paired:   not paired (run `otto connect <url> <code>`)");
    return;
  }
  const store = new LocalStore(dbPath);
  try {
    const credentials = store.getCredentials();
    if (credentials) {
      console.log(`paired:   ${credentials.deviceId} → ${credentials.serverUrl} (connEpoch ${credentials.connEpoch})`);
    } else {
      console.log("paired:   no credentials (run `otto connect <url> <code>`)");
    }
    const workers = store.listWorkers();
    const byState = new Map<string, number>();
    for (const worker of workers) byState.set(worker.state, (byState.get(worker.state) ?? 0) + 1);
    const summary =
      workers.length === 0
        ? "none"
        : [...byState.entries()].map(([state, count]) => `${count} ${state}`).join(", ");
    console.log(`workers:  ${summary}`);
    const repos = store.listRepos();
    const repoLine =
      repos.length === 0
        ? "none (web workspace: Machines > Add directory)"
        : repos.map((r) => `${r.name}[${r.writePolicy.isolation}/${r.writePolicy.concurrency}${r.approved ? ", approved" : ""}]`).join(", ");
    console.log(`repos:    ${repoLine}`);
  } finally {
    store.close();
  }

  const extDir = join(dir, "ext");
  const promptDir = join(dir, "prompts");
  const exts = existsSync(extDir) ? readdirSync(extDir).sort() : [];
  const prompts = existsSync(promptDir) ? readdirSync(promptDir).sort() : [];
  console.log(`assets:   ${exts.length ? exts.join(", ") : "none installed"}`);
  if (prompts.length) console.log(`          ${prompts.join(", ")}`);
  console.log(`logs:     ${join(dir, "logs")}`);
}

async function logsCommand(argv: string[]): Promise<void> {
  const { value: count, rest } = takeFlag(argv, "-n");
  const lines = count && /^\d+$/.test(count) ? Number(count) : 50;
  const dir = stateDir();
  const logDir = join(dir, "logs");

  // Only plain file names — never a path — so `logs` cannot read outside the log directory.
  const name = rest[0] ? basename(rest[0]).replace(/[^\w.-]/g, "_") : "connector.log";
  const path = join(logDir, name);
  if (!existsSync(path)) {
    const available = existsSync(logDir) ? readdirSync(logDir).join(", ") : "none yet";
    fail(`no log file '${name}' in ${logDir} (available: ${available})`);
  }
  const tail = tailFile(path, lines);
  if (tail) console.log(tail);
}

// --- service control -------------------------------------------------------------------------

async function serviceCommand(action: "start" | "stop" | "restart"): Promise<void> {
  const installer = requireInstaller();
  try {
    await installer[action]();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const status = await installer.status();
  console.log(
    `${OTTO_LABEL}: ${status.running ? `running${status.pid ? ` (pid ${status.pid})` : ""}` : `not running (${status.detail})`}`,
  );
}

async function uninstallCommand(): Promise<void> {
  const installer = requireInstaller();
  try {
    await installer.uninstall();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`removed ${installer.unitPath}`);
  console.log(`kept ${stateDir()} (credentials, workers, logs); delete it to purge everything`);
}

// --- upgrade ---------------------------------------------------------------------------------

async function upgradeCommand(argv: string[]): Promise<void> {
  const { value: version, rest } = takeFlag(argv, "--version");
  if (rest.length > 0) usage();
  try {
    await runUpgrade((line) => console.log(line), {
      version,
      currentVersion: VERSION,
      currentEntry: binEntryPath(),
      getService: (entryPath) => getServiceInstaller(serviceSpec(entryPath)),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// --- daemon ----------------------------------------------------------------------------------

/** What the operator needs to act on when this state directory is already owned by a daemon, or
 *  when the lock cannot be read at all (refused the same way — see daemon-lock.ts). */
interface DaemonBusy {
  path: string;
  pid: number | null;
  startedAt: number | null;
  version: string | null;
  detail?: string;
}

function daemonRunningMessage(busy: DaemonBusy): string {
  if (busy.pid === null) {
    return (
      `${busy.path} is present but does not name a process this run can check ` +
      `(${busy.detail ?? "unreadable"}) — refusing to start a second connector; check for one ` +
      `already running, and delete that file if there is none`
    );
  }
  const since = busy.startedAt ? `, started ${new Date(busy.startedAt).toLocaleString()}` : "";
  const version = busy.version ? `, v${busy.version}` : "";
  return (
    `another otto connector daemon is already running (pid ${busy.pid}${since}${version}) — ` +
    `stop it with \`otto stop\` (or Ctrl-C the terminal running it), or delete ${busy.path} if it is gone`
  );
}

/** The read-only half of the same check, for the `--foreground` pairing path: it must not spend
 *  the one-time code only to be refused by the lock a step later. The claim itself still decides
 *  (runDaemonAttached), so a race here costs nothing but the ordering. */
function refuseIfDaemonRunning(dir: string): void {
  const status = daemonLockStatus(dir);
  if (!status.held) return;
  fail(daemonRunningMessage(status));
}

/** Runs the daemon in this process while holding the single-instance lock (ADR-0018 phase 2):
 *  two daemons would share ~/.otto and the steward would not catch them, because a duplicate
 *  `hello` is settled by connEpoch — so they would take turns superseding each other while both
 *  ran reconcile and the watchdog over the same pi processes. Both entry points go through here:
 *  `otto daemon` (what a service manager or the Windows logon launcher starts) and
 *  `otto connect --foreground` (the escape hatch everywhere, and the only shape that shows
 *  the daemon's own output in the terminal). */
async function runDaemonAttached(dir: string, machineName: string): Promise<void> {
  const lock = acquireDaemonLock(dir, VERSION);
  if (!lock.ok) fail(daemonRunningMessage(lock));
  let handle;
  try {
    handle = await runDaemon({ stateDir: dir, machineName });
  } catch (err) {
    // Nothing is running, so nothing should still be claimed.
    releaseDaemonLock(dir);
    fail(err instanceof Error ? err.message : String(err));
  }

  const shutdown = () => {
    handle!
      .stop()
      .catch(() => undefined)
      .finally(() => {
        releaseDaemonLock(dir);
        process.exit(0);
      });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The ConnectorApp's sockets/timers hold the event loop open; nothing else to do.
  await new Promise<void>(() => {});
}

async function daemonCommand(): Promise<void> {
  return runDaemonAttached(stateDir(), process.env.OTTO_MACHINE_NAME ?? hostname());
}

// --- repo-config -----------------------------------------------------------------------------

/** One line naming the repo's detected capability (issue #88): plain Git-ness for a Git repo,
 *  so the read-only print doesn't leave it implicit in the isolation/concurrency values alone. */
function describeCapability(capability: RepoCapability): string {
  if (capability.kind === "git") {
    return `git (origin: ${capability.remote ?? "none"}, default branch: ${capability.defaultBranch ?? "unknown"})`;
  }
  return "plain (no Git)";
}

/** Parses repo-config argv: positional path + `--isolation worktree|in-place` +
 * `--concurrency parallel|serial` (also the `--flag=value` form for either) +
 * `--approve|--no-approve`. Unknown flags fail loudly instead of silently degrading into a
 * read-only invocation (review finding 4). */
function parseRepoConfigArgv(
  argv: string[],
): { path?: string; isolation?: string; concurrency?: string; approve?: boolean } {
  // Expand `--flag=value` into `--flag value` so both spellings share one path.
  const expanded: string[] = [];
  for (const token of argv) {
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq !== -1) expanded.push(token.slice(0, eq), token.slice(eq + 1));
    else expanded.push(token);
  }
  const { value: isolation, rest: afterIsolation } = takeFlag(expanded, "--isolation");
  if (expanded.includes("--isolation") && isolation === undefined) {
    fail("--isolation requires a value: worktree | in-place");
  }
  const { value: concurrency, rest } = takeFlag(afterIsolation, "--concurrency");
  if (afterIsolation.includes("--concurrency") && concurrency === undefined) {
    fail("--concurrency requires a value: parallel | serial");
  }
  if (rest.includes("--approve") && rest.includes("--no-approve")) {
    fail("--approve and --no-approve are mutually exclusive");
  }
  const approve = rest.includes("--approve") ? true : rest.includes("--no-approve") ? false : undefined;
  const positional = rest.filter((token) => !token.startsWith("--"));
  const knownBooleans = new Set(["--approve", "--no-approve"]);
  const unknown = rest.filter((token) => token.startsWith("--") && !knownBooleans.has(token));
  if (unknown.length > 0) {
    fail(`unknown option(s): ${unknown.join(" ")} (expected --isolation, --concurrency, --approve, or --no-approve)`);
  }
  return { path: positional[0], isolation, concurrency, approve };
}

/** `otto repo-config <path> [--isolation worktree|in-place] [--concurrency parallel|serial]
 * [--approve|--no-approve]` (§8.2/§13, issue #16): the per-repo settings that live only in the
 * connector's local store. A command from the steward carrying them is rejected; this is the
 * only writer. With no settings flags it just prints the current configuration. Works on a
 * plain (non-Git) workspace too (issue #88) — identity resolves via `identifyWorkspace`, not
 * a Git-or-throw lookup. */
async function repoConfig(argv: string[]): Promise<void> {
  const { path, isolation, concurrency, approve } = parseRepoConfigArgv(argv);
  if (!path) usage();
  if (isolation !== undefined && !isIsolation(isolation)) {
    fail(`unknown isolation '${isolation}' (expected one of: worktree | in-place)`);
  }
  if (concurrency !== undefined && !isConcurrency(concurrency)) {
    fail(`unknown concurrency '${concurrency}' (expected one of: parallel | serial)`);
  }

  const identity = await identifyWorkspace(path);
  const store = new LocalStore(join(stateDir(), "connector.sqlite"));
  try {
    const repo = store.getRepo(identity.repoId);
    if (!repo) {
      fail(`${identity.repoId} is not registered; open the web workspace and use Machines > Add directory first`);
    }
    if (isolation === undefined && concurrency === undefined && approve === undefined) {
      // Read-only invocation: show the current settings.
      console.log(`${repo.name} (${repo.repoId})`);
      console.log(`capability:  ${describeCapability(repo.capability)}`);
      console.log(`isolation:   ${repo.writePolicy.isolation}`);
      console.log(`concurrency: ${repo.writePolicy.concurrency}`);
      console.log(`approved:    ${repo.approved ? "yes (pi runs with --approve)" : "no (pi runs with --no-approve)"}`);
      return;
    }
    if (isolation !== undefined || concurrency !== undefined) {
      try {
        store.setWritePolicy(identity.repoId, { isolation, concurrency });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    }
    if (approve !== undefined) store.setApproved(identity.repoId, approve);
    const updated = store.getRepo(identity.repoId)!;
    console.log(
      `${updated.name}: isolation=${updated.writePolicy.isolation}, concurrency=${updated.writePolicy.concurrency}, approved=${updated.approved ? "yes" : "no"}`,
    );
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
