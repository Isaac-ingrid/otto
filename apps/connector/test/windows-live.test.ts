// Real-machine acceptance for the Windows autostart installer (ADR-0018 decision 11). Skipped
// by default: it writes the machine's real HKCU Run value and asks the real wscript.exe to start
// a real hidden process. Run it on a Windows box with:
//
//   OTTO_WIN_LIVE_INSTALL=1 CI=1 node node_modules/vitest/vitest.mjs run test/windows-live.test.ts
//
// It uses a throwaway state directory and a throwaway entry script, so nothing here needs
// credentials or a steward. It refuses to run while `dev.otto.connector` is already in the Run
// key: this is a test of the installer, not a way to overwrite a working installation.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getServiceInstaller, OTTO_LABEL, WINDOWS_RUN_KEY, type ServiceSpec } from "../src/service.ts";
import { LocalStore } from "../src/store.ts";

const run = promisify(execFile);
const live = process.platform === "win32" && process.env.OTTO_WIN_LIVE_INSTALL === "1";

/** reg.exe query → the value's data, or null when the value is not there. */
async function runValueFromRegistry(): Promise<string | null> {
  const res = await run("reg.exe", ["query", WINDOWS_RUN_KEY, "/v", OTTO_LABEL]).catch((e: unknown) => e as { stdout?: string });
  const stdout = (res as { stdout?: string }).stdout ?? "";
  const match = new RegExp(`^\\s+${OTTO_LABEL}\\s+REG_\\w+\\s+(.*)$`, "m").exec(stdout);
  return match ? match[1]!.trim() : null;
}

/** A process is gone within a second or two of taskkill; poll rather than sleep a fixed time. */
async function waitForGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await run("tasklist.exe", ["/FI", `PID eq ${pid}`, "/NH"]).catch(() => ({ stdout: "ERROR" }));
    if (!res.stdout.includes(String(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

describe.runIf(live)("the Windows installer on the real machine", () => {
  let stateDir = "";
  let childPid: number | undefined;

  afterEach(async () => {
    // Never leave a Run value, a hidden child or a launcher behind, whatever failed above.
    if (childPid !== undefined) await run("taskkill.exe", ["/PID", String(childPid), "/T", "/F"]).catch(() => undefined);
    if (stateDir) {
      const installer = getServiceInstaller(specOf(stateDir));
      await installer?.uninstall().catch(() => undefined);
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  function specOf(dir: string): ServiceSpec {
    return {
      label: OTTO_LABEL,
      nodePath: process.execPath,
      // An entry script that reports the environment the launcher gave it, claims the daemon
      // lock with its own pid (so `start` sees the connector come up) and then stays alive.
      entryPath: join(dir, "entry.mjs"),
      args: [],
      env: {
        PATH: `C:\\otto-live-bin;${process.env.PATH ?? ""}`,
        OTTO_HOME: dir,
        OTTO_LIVE_MARKER: "otto-live-ok",
      },
      stateDir: dir,
      logDir: join(dir, "logs"),
    };
  }

  it("installs, launches hidden with the pinned environment, stops and uninstalls", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "otto-live-"));
    mkdirSync(join(stateDir, "logs"), { recursive: true });
    writeFileSync(
      join(stateDir, "entry.mjs"),
      `import { writeFileSync } from "node:fs";\n` +
        `import { join } from "node:path";\n` +
        `const dir = process.env.OTTO_HOME;\n` +
        `writeFileSync(join(dir, "child.json"), JSON.stringify({\n` +
        `  pid: process.pid, ottoHome: process.env.OTTO_HOME, marker: process.env.OTTO_LIVE_MARKER ?? null,\n` +
        `  pathHead: (process.env.PATH ?? "").split(";")[0], cwd: process.cwd(),\n` +
        `}));\n` +
        `writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: "live" }));\n` +
        `setTimeout(() => {}, 120000);\n`,
    );

    expect(await runValueFromRegistry()).toBeNull();
    const installer = getServiceInstaller(specOf(stateDir))!;
    const launcher = join(stateDir, "otto-daemon.vbs");

    await installer.install();

    // The registry really has it, and it points at wscript + the generated launcher.
    expect(existsSync(launcher)).toBe(true);
    expect(await runValueFromRegistry()).toBe(`${process.env.SystemRoot}\\System32\\wscript.exe "${launcher}"`);

    // The launcher really ran: the child wrote what the VBS environment gave it.
    const childPath = join(stateDir, "child.json");
    const deadline = Date.now() + 20_000;
    while (!existsSync(childPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(childPath)).toBe(true);
    const child = JSON.parse(readFileSync(childPath, "utf8")) as Record<string, string | number>;
    childPid = child.pid as number;
    expect(child.ottoHome).toBe(stateDir);
    expect(child.marker).toBe("otto-live-ok");
    // `sh.Environment("PROCESS")` writes are what the child inherits — the risky assumption here.
    expect(child.pathHead).toBe("C:\\otto-live-bin");
    expect(String(child.cwd).toLowerCase()).toBe(stateDir.toLowerCase());

    // `start` waited for the daemon lock, so status must agree that it is running.
    expect(await installer.status()).toMatchObject({ installed: true, running: true, pid: childPid });

    await installer.stop();

    expect(await runValueFromRegistry()).toBeNull();
    expect(await waitForGone(childPid)).toBe(true);
    expect(existsSync(join(stateDir, "daemon.lock"))).toBe(false);
    expect(await installer.status()).toMatchObject({ installed: false, running: false });

    // A second install works after a stop, and uninstall removes the launcher but keeps the data.
    rmSync(childPath, { force: true });
    await installer.install();
    const secondPath = join(stateDir, "child.json");
    const deadline2 = Date.now() + 20_000;
    while (!existsSync(secondPath) && Date.now() < deadline2) await new Promise((resolve) => setTimeout(resolve, 200));
    childPid = (JSON.parse(readFileSync(secondPath, "utf8")) as { pid: number }).pid;
    writeFileSync(join(stateDir, "connector.sqlite"), "credentials");

    await installer.uninstall();

    expect(existsSync(launcher)).toBe(false);
    expect(await runValueFromRegistry()).toBeNull();
    expect(readFileSync(join(stateDir, "connector.sqlite"), "utf8")).toBe("credentials");
    expect(await waitForGone(childPid)).toBe(true);
  }, 120_000);
});

// `otto install` is the second way to get a service and the only one that needs no pairing code:
// it writes the unit for the credential that is already in the state directory. This runs the real
// CLI against a throwaway HOME, so <home>/.otto is the state directory and the machine's own
// ~/.otto stays out of it — only the Run value is shared machine state, which is why this block
// refuses to run while one is already set (an install run by hand is not a test fixture).
describe.runIf(live)("`otto install` on the real machine", () => {
  let home = "";
  let supervisorPid: number | undefined;
  let childPid: number | undefined;

  const cliEnv = (): NodeJS.ProcessEnv => ({ ...process.env, OTTO_HOME: undefined, USERPROFILE: home, HOME: home });

  async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
    try {
      const { stdout, stderr } = await run(process.execPath, [dist, ...args], { env: cliEnv() });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const failure = err as { code?: number; stdout?: string; stderr?: string };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
    }
  }

  /** Poll the real CLI until its output matches, so a slow launcher is not a failure. */
  async function statusUntil(pattern: RegExp, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      const { stdout } = await cli(["status"]);
      last = stdout;
      if (pattern.test(stdout)) return stdout;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`status never matched ${pattern}; last output:\n${last}`);
  }

  afterEach(async () => {
    // Never leave a Run value, a hidden supervisor tree or a temp home behind, whatever failed.
    if (supervisorPid !== undefined) await run("taskkill.exe", ["/PID", String(supervisorPid), "/T", "/F"]).catch(() => undefined);
    if (childPid !== undefined) await run("taskkill.exe", ["/PID", String(childPid), "/T", "/F"]).catch(() => undefined);
    if (home) {
      await cli(["uninstall"]).catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
      home = "";
    }
  });

  it("installs for a paired machine without a pairing code, and is idempotent", async () => {
    home = mkdtempSync(join(tmpdir(), "otto-live-home-"));
    const stateDir = join(home, ".otto");
    mkdirSync(stateDir, { recursive: true });
    // The only thing `otto install` needs: a credential for an unreachable server (nothing here
    // contacts it — the daemon retries in the background and the lock is what we assert on).
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    store.saveCredentials({ serverUrl: "http://127.0.0.1:9", deviceId: "dev_live_install", token: "live-token" });
    store.close();

    expect(await runValueFromRegistry()).toBeNull();

    const installed = await cli(["install"]);
    expect(installed.code).toBe(0);

    const launcher = join(stateDir, "otto-daemon.vbs");
    expect(installed.stdout).toMatch(/^installed windows dev\.otto\.connector \(/m);
    expect(installed.stdout).toContain(launcher);
    // The Run value really points at the generated launcher, and the launcher really ran.
    expect(existsSync(launcher)).toBe(true);
    // The service runs *this* package: installing it also wrote the versioned pi assets, or the
    // daemon would come up and fail every worker.
    expect(existsSync(join(stateDir, "ext", "otto-pi-0.2.0.ts"))).toBe(true);
    expect(await runValueFromRegistry()).toBe(`${process.env.SystemRoot}\\System32\\wscript.exe "${launcher}"`);
    // The hint a hidden autostart owes its owner (ADR-0018 decision 12) and where the credential
    // came from, so the command is honest about what it just did.
    expect(installed.stdout).toMatch(/note: .*--supervise[\s\S]*logs\/supervisor\.log/);
    expect(installed.stdout).toMatch(/paired:   dev_live_install → http:\/\/127\.0\.0\.1:9/);
    expect(installed.stdout).toMatch(/logs: {5}/);

    // `install` starts it and waits, so the service line must already agree, and the supervisor
    // must name its child once the first one is up.
    const status = await statusUntil(/^service: {2}windows dev\.otto\.connector — running pid \d+/m);
    expect(status).toMatch(/^daemon: {3}running pid \d+/m);
    const supervised = await statusUntil(/\[supervised: child pid \d+/);
    const lockPid = Number(/daemon: {3}running pid (\d+)/.exec(supervised)![1]);
    supervisorPid = lockPid;
    const state = JSON.parse(readFileSync(join(stateDir, "supervisor.json"), "utf8")) as { supervisorPid: number; childPid: number };
    expect(state.supervisorPid).toBe(lockPid);
    childPid = state.childPid;

    // Idempotent: a second install refreshes the same service instead of starting a second daemon.
    const again = await cli(["install"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^refreshed windows dev\.otto\.connector \(/m);
    const stillThere = await cli(["status"]);
    expect(stillThere.stdout).toMatch(new RegExp(`daemon: {3}running pid ${lockPid}\\b`));

    const removed = await cli(["uninstall"]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("removed");
    expect(await runValueFromRegistry()).toBeNull();
    expect(existsSync(launcher)).toBe(false);
    // The stop half of uninstall killed the whole tree, and the data stayed.
    expect(await waitForGone(lockPid)).toBe(true);
    expect(await waitForGone(state.childPid)).toBe(true);
    const after = await cli(["status"]);
    expect(after.stdout).toMatch(/windows dev\.otto\.connector — not installed/);
    expect(after.stdout).toMatch(/daemon: {3}not running/);
    expect(existsSync(join(stateDir, "connector.sqlite"))).toBe(true);
  }, 120_000);
});
