// Background service management (issue #26, ADR-0001 decision 10): `connect` installs the
// connector as a launchd agent on macOS, a systemd user unit on Linux, or — since ADR-0018
// decision 11 — a per-user Run-key launcher on Windows, so it keeps running and starts at login.
//
// All three run `<node> <bin>/otto.js daemon`; credentials stay in the LocalStore (never in the
// unit file), and the log directory is under the state dir. macOS and Linux restart a crashed
// daemon from the service manager itself (launchd `KeepAlive`, systemd `Restart=on-failure`); the
// Windows launcher asks for `--supervise` instead, because a Run value cannot restart anything
// (ADR-0018 decision 12) — see the Windows section at the end of this file.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";
import { clearStaleDaemonLock, daemonLockStatus, type DaemonLockDeps } from "./daemon-lock.ts";
import { terminateProcess, type KillDeps } from "./kill.ts";

const realExecFile = promisify(execFile);

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

/** execFile that never throws: non-zero exits and spawn failures come back as {code, stderr}. */
export const defaultExec: Exec = async (file, args) => {
  try {
    const { stdout, stderr } = await realExecFile(file, args, { encoding: "utf8" });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 127,
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: (e.stderr ? String(e.stderr) : "") || (e.message ?? `${file} failed`),
    };
  }
};

export const OTTO_LABEL = "dev.otto.connector";

export interface ServiceSpec {
  /** Reverse-DNS label (launchd) and unit basename (systemd). */
  label: string;
  /** Absolute path of the node binary to run (process.execPath at install time). */
  nodePath: string;
  /** Absolute path of the otto bin wrapper the service should run. */
  entryPath: string;
  /** Extra argv after the entry (["daemon"]). */
  args?: string[];
  /** Environment for the daemon: PATH (to find `pi`/`git`) and optionally OTTO_HOME. */
  env: Record<string, string>;
  /** ~/.otto (or $OTTO_HOME) — where logs and the store live. */
  stateDir: string;
  logDir: string;
}

export interface ServiceStatus {
  manager: "launchd" | "systemd" | "windows";
  /** Unit/plist file present on disk. */
  installed: boolean;
  /** The service manager reports the service as running right now. */
  running: boolean;
  pid?: number;
  /** Raw state for display (e.g. launchd "state = running", systemd "active"). */
  detail: string;
}

export interface ServiceInstaller {
  readonly kind: "launchd" | "systemd" | "windows";
  /** Human-readable install notes (e.g. the lingering hint on systemd); filled by install(). */
  readonly notes: string[];
  /** Writes the unit, loads and enables it (starts now, and at login). Idempotent. */
  install(): Promise<void>;
  /** Starts now (after `stop`). */
  start(): Promise<void>;
  /** Stops now and disables start-at-login (until `start`/`install` again). */
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Stops and removes the unit. Does not touch ~/.otto data. */
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  /** Refuses *before* a pairing code is spent when this machine cannot host the service at
   *  all: `connect` redeems the code once (protocol §5.2), so anything that makes `install()`
   *  fail costs the owner a fresh code for every retry. Only facts that would fail the install
   *  outright belong here — an unreachable systemd user bus, an unreachable launchd domain —
   *  never a preference. Optional so a test double need not answer it. */
  preflight?(): Promise<void>;
  /** Absolute path of the unit/plist file (for `status` output). */
  readonly unitPath: string;
}

export interface ServiceDeps {
  exec?: Exec;
  /** Overrides for tests; default os.homedir()/process.getuid()/process.platform. */
  homeDir?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  /** Budget for launchd bootstrap retries (tests shorten it). Default 5s. */
  bootstrapRetryMs?: number;
  /** Windows: %SystemRoot%, where wscript.exe lives. Defaults to the environment. */
  systemRoot?: string;
  /** Windows: how `start`/`install` launches the generated launcher, and how long it waits for
   *  the daemon lock to appear. Injectable so the Windows branch is testable off-Windows. */
  spawnDetached?: (file: string, args: string[]) => Promise<void>;
  startTimeoutMs?: number;
  /** Windows: how the running daemon gets ended (kill.ts's taskkill). */
  taskkill?: KillDeps["taskkill"];
  /** Windows: identity probes for the daemon lock (`status`, `start`, `stop` read it instead of
   *  asking the service manager, which does not know about `otto daemon`). */
  lockDeps?: DaemonLockDeps;
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/** Picks the platform installer. Never null on a platform this package installs on; the null
 *  return remains for a platform with no service manager at all (a test double, or a future
 *  port that has not landed yet). */
export function getServiceInstaller(spec: ServiceSpec, deps: ServiceDeps = {}): ServiceInstaller | null {
  const plat = deps.platform ?? platform();
  if (plat === "darwin") return new LaunchdService(spec, deps);
  if (plat === "linux") return new SystemdService(spec, deps);
  if (plat === "win32") return new WindowsService(spec, deps);
  return null;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- launchd (macOS user agent) -------------------------------------------------------------

class LaunchdService implements ServiceInstaller {
  readonly kind = "launchd" as const;
  readonly notes: string[] = [];
  private readonly plistPath: string;
  private readonly target: string;
  private readonly exec: Exec;
  private readonly bootstrapRetryMs: number;

  constructor(
    private readonly spec: ServiceSpec,
    deps: ServiceDeps = {},
  ) {
    const home = deps.homeDir ?? homedir();
    this.exec = deps.exec ?? defaultExec;
    this.bootstrapRetryMs = deps.bootstrapRetryMs ?? 5000;
    this.plistPath = join(home, "Library", "LaunchAgents", `${spec.label}.plist`);
    this.target = `gui/${deps.uid ?? currentUid()}/${spec.label}`;
  }

  get unitPath(): string {
    return this.plistPath;
  }

  private async launchctl(args: string[]): Promise<ExecResult> {
    return this.exec("launchctl", args);
  }

  private async loaded(): Promise<boolean> {
    return (await this.launchctl(["print", this.target])).code === 0;
  }

  plistContent(): string {
    const env = Object.entries(this.spec.env)
      .map(([key, value]) => `        <key>${xmlEscape(key)}</key>\n        <string>${xmlEscape(value)}</string>`)
      .join("\n");
    const args = [this.spec.nodePath, this.spec.entryPath, ...(this.spec.args ?? ["daemon"])]
      .map((a) => `        <string>${xmlEscape(a)}</string>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(this.spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(this.spec.logDir, "launchd.out.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(this.spec.logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
  }

  async preflight(): Promise<void> {
    // The agent is bootstrapped into gui/<uid>, which needs a GUI session for this uid: over
    // SSH, or before the first desktop login, that domain does not exist and bootstrap fails.
    // One `print` settles it, and it is the same domain install() targets.
    const res = await this.launchctl(["print", this.targetDomain()]);
    if (res.code !== 0) {
      throw new Error(
        `launchctl print ${this.targetDomain()} failed (${res.code}): ${res.stderr.trim()} — ` +
          `the connector's launchd agent lives in the gui domain, which needs a logged-in ` +
          `session for this user; run \`otto connect … --foreground\` from the desktop instead`,
      );
    }
  }

  async install(): Promise<void> {
    mkdirSync(this.spec.logDir, { recursive: true });
    mkdirSync(dirname(this.plistPath), { recursive: true });
    writeFileSync(this.plistPath, this.plistContent(), { mode: 0o644 });

    // bootstrap starts the agent immediately (RunAtLoad) and at every login. When already
    // loaded (re-pair, upgrade), bootout first — and wait for the unload to actually settle,
    // or bootstrap races launchd's teardown and fails with EIO.
    if (await this.loaded()) {
      await this.launchctl(["bootout", this.target]);
      await this.waitUnloaded(3000);
    }
    // Enable before bootstrap: a disabled service (a previous `stop`) cannot be bootstrapped.
    await this.launchctl(["enable", this.target]);
    await this.bootstrapWithRetry();
  }

  /** Bootstrap, retrying through launchd's asynchronous-teardown window (EIO right after a
   * bootout of the same label — e.g. `stop` immediately followed by `restart`). */
  private async bootstrapWithRetry(): Promise<void> {
    const deadline = Date.now() + this.bootstrapRetryMs;
    let last: ExecResult = { code: -1, stdout: "", stderr: "" };
    while (Date.now() < deadline) {
      last = await this.launchctl(["bootstrap", this.targetDomain(), this.plistPath]);
      if (last.code === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`launchctl bootstrap failed (${last.code}): ${last.stderr.trim()}`);
  }

  /** Polls until `launchctl print` stops finding the service (bootout is asynchronous). */
  private async waitUnloaded(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.loaded())) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async start(): Promise<void> {
    await this.launchctl(["enable", this.target]);
    if (await this.loaded()) {
      await this.launchctl(["kickstart", this.target]);
    } else {
      await this.bootstrapWithRetry();
    }
  }

  async stop(): Promise<void> {
    // disable keeps it from starting at the next login; bootout stops it now. The unload
    // is asynchronous — wait for it so an immediately following status() reads clean.
    await this.launchctl(["disable", this.target]);
    await this.launchctl(["bootout", this.target]);
    await this.waitUnloaded(3000);
  }

  async restart(): Promise<void> {
    // enable first: bootstrap of a disabled service fails with EIO, and `stop` disables.
    await this.launchctl(["enable", this.target]);
    if (await this.loaded()) {
      await this.launchctl(["kickstart", "-k", this.target]);
    } else {
      await this.bootstrapWithRetry();
    }
  }

  async uninstall(): Promise<void> {
    await this.launchctl(["bootout", this.target]);
    // Clear any `disable` mark so a future install starts fresh.
    await this.launchctl(["enable", this.target]);
    rmSync(this.plistPath, { force: true });
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.plistPath);
    const res = await this.launchctl(["print", this.target]);
    if (res.code !== 0) {
      return { manager: "launchd", installed, running: false, detail: "not loaded" };
    }
    const pid = /^\s*pid = (\d+)\s*$/m.exec(res.stdout);
    const state = /^\s*state = (\S+)\s*$/m.exec(res.stdout);
    const running = pid !== null;
    return {
      manager: "launchd",
      installed,
      running,
      pid: pid ? Number(pid[1]) : undefined,
      detail: state ? state[1]! : running ? "running" : res.stdout.split("\n")[0]?.trim() || "loaded",
    };
  }

  private targetDomain(): string {
    return this.target.substring(0, this.target.lastIndexOf("/"));
  }
}

// --- systemd (Linux user unit) ---------------------------------------------------------------

class SystemdService implements ServiceInstaller {
  readonly kind = "systemd" as const;
  readonly notes: string[] = [];
  private readonly unitFile: string;
  private readonly unitName: string;
  private readonly exec: Exec;

  constructor(
    private readonly spec: ServiceSpec,
    deps: ServiceDeps = {},
  ) {
    const home = deps.homeDir ?? homedir();
    this.exec = deps.exec ?? defaultExec;
    this.unitName = `${spec.label}.service`;
    this.unitFile = join(home, ".config", "systemd", "user", this.unitName);
  }

  get unitPath(): string {
    return this.unitFile;
  }

  private async systemctl(args: string[]): Promise<ExecResult> {
    const res = await this.exec("systemctl", ["--user", ...args]);
    if (res.code !== 0 && /Failed to connect to bus|DBUS_SESSION/i.test(res.stderr)) {
      throw new Error(
        `systemctl --user ${args.join(" ")} could not reach the user session bus. ` +
          `Run from a logged-in session (SSH users need XDG_RUNTIME_DIR, or use --foreground).`,
      );
    }
    return res;
  }

  unitContent(): string {
    const env = Object.entries(this.spec.env)
      .map(([key, value]) => `Environment="${key}=${value.replace(/"/g, '\\"')}"`)
      .join("\n");
    const execStart = [this.spec.nodePath, this.spec.entryPath, ...(this.spec.args ?? ["daemon"])]
      .map((part) => (part.includes(" ") ? `"${part}"` : part))
      .join(" ");
    return `[Unit]
Description=Otto connector daemon
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${execStart}
${env}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
  }

  async preflight(): Promise<void> {
    // A user unit cannot be written or enabled without the session bus, and install() only
    // finds that out after the unit file is on disk. The same call also fails when systemctl
    // is missing entirely (containers) — both are `--foreground` cases, refused before pairing.
    const res = await this.systemctl(["show-environment"]);
    if (res.code !== 0) {
      throw new Error(
        `systemctl --user show-environment failed (${res.code}): ${res.stderr.trim()} — ` +
          `the connector's user unit needs a systemd user session; run \`otto connect … ` +
          `--foreground\` instead, or fix the session first`,
      );
    }
  }

  async install(): Promise<void> {
    mkdirSync(this.spec.logDir, { recursive: true });
    mkdirSync(dirname(this.unitPath), { recursive: true });
    writeFileSync(this.unitPath, this.unitContent(), { mode: 0o644 });
    await this.systemctl(["daemon-reload"]);
    const res = await this.systemctl(["enable", "--now", this.unitName]);
    if (res.code !== 0) throw new Error(`systemctl enable --now failed (${res.code}): ${res.stderr.trim()}`);
    // User units only run while a session exists; lingering starts them at boot.
    const linger = await this.exec("loginctl", ["enable-linger"]);
    if (linger.code !== 0) {
      this.notes.push(
        "loginctl enable-linger failed: the connector will start at first login instead of at boot.",
      );
    }
  }

  async start(): Promise<void> {
    const res = await this.systemctl(["enable", "--now", this.unitName]);
    if (res.code !== 0) throw new Error(`systemctl enable --now failed (${res.code}): ${res.stderr.trim()}`);
  }

  async stop(): Promise<void> {
    await this.systemctl(["disable", "--now", this.unitName]);
  }

  async restart(): Promise<void> {
    const res = await this.systemctl(["restart", this.unitName]);
    if (res.code !== 0) throw new Error(`systemctl restart failed (${res.code}): ${res.stderr.trim()}`);
  }

  async uninstall(): Promise<void> {
    await this.systemctl(["disable", "--now", this.unitName]);
    rmSync(this.unitPath, { force: true });
    await this.systemctl(["daemon-reload"]);
    await this.systemctl(["reset-failed", this.unitName]);
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.unitFile);
    let active: ExecResult;
    try {
      active = await this.systemctl(["is-active", this.unitName]);
    } catch {
      // Headless hosts (no user session bus): status is informational and must not throw.
      return { manager: "systemd", installed, running: false, detail: "user session bus unreachable" };
    }
    const running = active.stdout.trim() === "active";
    let pid: number | undefined;
    if (running) {
      const show = await this.systemctl(["show", this.unitName, "-p", "MainPID", "--value"]);
      const parsed = Number(show.stdout.trim());
      if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
    }
    return {
      manager: "systemd",
      installed,
      running,
      pid,
      detail: active.stdout.trim() || "unknown",
    };
  }
}


// --- Windows (per-user Run key + a generated launcher) ---------------------------------------
//
// ADR-0018 decision 11. There is no launchd/systemd equivalent that can host an interactive
// agent: a Windows *Service* runs in session 0, without the user's profile, desktop or PATH, and
// the agent it spawns is a user-profile program. What is left is the per-user autostart:
//
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run
//     dev.otto.connector = C:\Windows\System32\wscript.exe "…\.otto\otto-daemon.vbs"
//
// A Task Scheduler logon trigger would be the structural analogue (a unit on disk, hidden,
// restart-on-failure) but creating one is refused from an unelevated shell — measured on Windows
// 11 26100 with `schtasks /Create /SC ONLOGON` — so it cannot be what `otto connect` does. The
// Run key needs no elevation, is visible to the user in Task Manager's startup tab, and removal
// is one value.
//
// The indirection through wscript is not optional: `node.exe` is a console program, so a Run
// value pointing at it opens a console window that the user can close. The launcher sets the
// daemon's environment (the logon environment knows nothing of PATH additions or OTTO_HOME) and
// starts it with window style 0. It is the Windows analogue of the plist/unit file: generated on
// install, listed by `otto status`, removed by `otto uninstall`.
//
// Restart-on-failure is not a Run-key property, so the launcher does not start the daemon itself:
// it starts `otto daemon --supervise`, and that supervisor owns the lock and restarts the daemon
// behind it (ADR-0018 decision 12, supervisor.ts). Nothing is claimed here about what the
// supervisor can do that a pre-supervisor installation could not — `otto status` reports the
// child, and the launcher is rewritten by the next `otto connect`/`otto upgrade`.

export const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/** Explorer's per-user policy that hides the Run key entirely. */
const WINDOWS_POLICY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer";
/** Windows Script Host can be turned off per user or per machine; either disables the launcher. */
const WSH_SETTINGS_KEYS = [
  "HKCU\\Software\\Microsoft\\Windows Script Host\\Settings",
  "HKLM\\SOFTWARE\\Microsoft\\Windows Script Host\\Settings",
];
export const WINDOWS_LAUNCHER_FILE = "otto-daemon.vbs";

function vbsEscape(text: string): string {
  return text.replace(/"/g, '""').replace(/\r?\n/g, " ");
}

async function spawnDetached(file: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

class WindowsService implements ServiceInstaller {
  readonly kind = "windows" as const;
  readonly notes: string[] = [];
  private readonly launcherPath: string;
  private readonly exec: Exec;
  private readonly spawnDetached: (file: string, args: string[]) => Promise<void>;
  private readonly startTimeoutMs: number;
  private readonly taskkill: KillDeps["taskkill"];
  private readonly lockDeps: DaemonLockDeps;
  private readonly systemRoot: string;

  constructor(
    private readonly spec: ServiceSpec,
    deps: ServiceDeps = {},
  ) {
    this.exec = deps.exec ?? defaultExec;
    this.spawnDetached = deps.spawnDetached ?? spawnDetached;
    this.startTimeoutMs = deps.startTimeoutMs ?? 10_000;
    this.taskkill = deps.taskkill;
    this.lockDeps = deps.lockDeps ?? {};
    this.systemRoot = deps.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
    this.launcherPath = join(spec.stateDir, WINDOWS_LAUNCHER_FILE);
  }

  get unitPath(): string {
    return this.launcherPath;
  }

  private get wscriptPath(): string {
    return join(this.systemRoot, "System32", "wscript.exe");
  }

  /** The Run value: an absolute wscript (a bare name would let the current directory's own
   *  `wscript.exe` win CreateProcess's search order) plus the launcher path. */
  private runValueData(): string {
    return `${this.wscriptPath} "${this.launcherPath}"`;
  }

  /** What the launcher runs: the daemon, under the supervisor that a Run key cannot be (decision
   *  12). Appended rather than required of the caller, so a spec built elsewhere cannot silently
   *  install an autostart that never comes back from a crash. */
  private daemonArgs(): string[] {
    const args = this.spec.args ?? ["daemon"];
    return args.includes("--supervise") ? args : [...args, "--supervise"];
  }

  launcherContent(): string {
    const env = Object.entries(this.spec.env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `env("${vbsEscape(key)}") = "${vbsEscape(value)}"`)
      .join("\n");
    const argv = [this.spec.nodePath, this.spec.entryPath, ...this.daemonArgs()];
    const cmd = argv.map((part) => `Chr(34) & "${vbsEscape(part)}" & Chr(34)`).join(' & " " & ');
    return `' Generated by otto for this machine's logon autostart (ADR-0018 decision 11).
' Rewritten by \`otto connect\`, removed by \`otto uninstall\` — do not edit, and never put a
' credential in here: the daemon reads its own from the state directory.
Option Explicit
Dim sh, env, cmd
Set sh = CreateObject("WScript.Shell")
' The logon environment has no OTTO_HOME and may not have the node/git directory on PATH.
Set env = sh.Environment("PROCESS")
${env}
cmd = ${cmd}
sh.CurrentDirectory = "${vbsEscape(this.spec.stateDir)}"
' 0 = hidden window: a console program would otherwise open one the user can close.
sh.Run cmd, 0, False
`;
  }

  private async reg(args: string[]): Promise<ExecResult> {
    return this.exec("reg.exe", args);
  }

  /** The Run value's data, or null when the value is not there. */
  private async runValue(): Promise<string | null> {
    const res = await this.reg(["query", WINDOWS_RUN_KEY, "/v", this.spec.label]);
    if (res.code !== 0) return null;
    const escaped = this.spec.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^\\s+${escaped}\\s+REG_\\w+\\s+(.*)$`, "m").exec(res.stdout);
    return match ? match[1]!.trim() : "";
  }

  private async writeRunValue(): Promise<void> {
    const res = await this.reg([
      "add",
      WINDOWS_RUN_KEY,
      "/v",
      this.spec.label,
      "/t",
      "REG_SZ",
      "/d",
      this.runValueData(),
      "/f",
    ]);
    if (res.code !== 0) throw new Error(`reg add ${WINDOWS_RUN_KEY} failed (${res.code}): ${res.stderr.trim()}`);
  }

  /** Removes the Run value; false when there was nothing to remove (a repeated `stop`). */
  private async deleteRunValue(): Promise<boolean> {
    if ((await this.runValue()) === null) return false;
    const res = await this.reg(["delete", WINDOWS_RUN_KEY, "/v", this.spec.label, "/f"]);
    if (res.code !== 0) throw new Error(`reg delete ${WINDOWS_RUN_KEY} failed (${res.code}): ${res.stderr.trim()}`);
    return true;
  }

  async preflight(): Promise<void> {
    // Read-only facts that would make the install pointless, and so belong before the one-time
    // pairing code is spent (decision 9). Not checked: whether the registry write itself will
    // succeed — that cannot be known without writing, and HKCU is the user's own hive.
    if (!existsSync(this.wscriptPath)) {
      throw new Error(
        `${this.wscriptPath} is missing — the logon launcher needs Windows Script Host; ` +
          `run \`otto connect … --foreground\` instead`,
      );
    }
    const noRun = await this.reg(["query", WINDOWS_POLICY_KEY, "/v", "NoRun"]);
    if (noRun.code === 0 && /REG_DWORD\s+0x1\b/i.test(noRun.stdout)) {
      throw new Error(
        `the Run key is disabled by policy (${WINDOWS_POLICY_KEY}\\NoRun=1), so an autostart ` +
          `entry would never run; run \`otto connect … --foreground\` instead`,
      );
    }
    for (const key of WSH_SETTINGS_KEYS) {
      const res = await this.reg(["query", key, "/v", "Enabled"]);
      if (res.code === 0 && /REG_DWORD\s+0x0\b/i.test(res.stdout)) {
        throw new Error(
          `Windows Script Host is disabled by policy (${key}\\Enabled=0), so the launcher ` +
            `would never run; run \`otto connect … --foreground\` instead`,
        );
      }
    }
  }

  async install(): Promise<void> {
    mkdirSync(this.spec.logDir, { recursive: true });
    writeFileSync(this.launcherPath, this.launcherContent(), { mode: 0o600 });
    await this.start();
    this.notes.push(
      "the launcher starts the daemon under `otto daemon --supervise`, so a crash comes back " +
        "with backoff (up to 60s between attempts) and the child's console output is appended " +
        "to logs/supervisor.log; a stop stays stopped until `otto start`.",
    );
  }

  async start(): Promise<void> {
    // The launcher is the unit file here, and unlike launchd/systemd we could regenerate it — but
    // `otto start` on a machine that never paired would then leave a Run value pointing at a
    // daemon with no credentials. Refuse like the service managers do ("unit not found").
    if (!existsSync(this.launcherPath)) {
      throw new Error(`the connector's launcher is not installed (${this.launcherPath}) — run \`otto connect <url> <code>\` first`);
    }
    await this.writeRunValue();
    // Another daemon already owns this state directory: that is the desired end state, and
    // launching a second one would only log a refusal.
    if (this.lock().held) return;
    await this.spawnDetached(this.wscriptPath, [this.launcherPath]);
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (this.lock().held) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `the connector did not come up within ${Math.round(this.startTimeoutMs / 1000)}s — ` +
        `check ${join(this.spec.logDir, "connector.log")}, and \`otto daemon\` in this terminal to see why`,
    );
  }

  async stop(): Promise<void> {
    // Disable the autostart first, like launchd's `disable` before `bootout`: a stopped connector
    // must stay stopped across the next logon until `otto start`.
    await this.deleteRunValue();
    const lock = this.lock();
    if (lock.held && lock.pid) {
      terminateProcess(lock.pid, "SIGKILL", { taskkill: this.taskkill });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && this.lock().held) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    // A forced kill never reaches the daemon's signal handler, so its lock file outlives it.
    clearStaleDaemonLock(this.spec.stateDir, this.lockDeps);
  }

  /** The daemon lock, i.e. "is a connector actually running" — the Run key only says it *would*
   *  be started at the next logon, and no Windows facility reports the daemon otherwise. */
  private lock() {
    return daemonLockStatus(this.spec.stateDir, this.lockDeps);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async uninstall(): Promise<void> {
    await this.stop();
    rmSync(this.launcherPath, { force: true });
  }

  async status(): Promise<ServiceStatus> {
    const value = await this.runValue();
    const launcher = existsSync(this.launcherPath);
    const installed = value !== null && launcher;
    const lock = this.lock();
    const running = lock.held;
    return {
      manager: "windows",
      installed,
      running,
      pid: running && lock.pid ? lock.pid : undefined,
      detail:
        value === null
          ? "not in the Run key"
          : !launcher
            ? `Run key present but ${this.launcherPath} is missing`
            : running
              ? `Run key + ${WINDOWS_LAUNCHER_FILE}`
              : "starts at the next logon",
    };
  }
}
