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
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getServiceInstaller, OTTO_LABEL, WINDOWS_RUN_KEY, type ServiceSpec } from "../src/service.ts";

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
