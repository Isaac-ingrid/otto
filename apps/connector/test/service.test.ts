// Service installers (issue #26): launchd agent on macOS, systemd user unit on Linux.
// All manager commands go through an injected exec, so these tests assert the unit files'
// content and the exact launchctl/systemctl invocations without touching the real system.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getServiceInstaller,
  OTTO_LABEL,
  WINDOWS_RUN_KEY,
  type Exec,
  type ExecResult,
  type ServiceSpec,
} from "../src/service.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "otto-service-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Call {
  file: string;
  args: string[];
}

/** Records every invocation; `handler` decides results (default: success). */
function recordingExec(handler?: (file: string, args: string[]) => ExecResult | undefined): {
  calls: Call[];
  exec: Exec;
} {
  const calls: Call[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    return handler?.(file, args) ?? { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    label: OTTO_LABEL,
    nodePath: "/usr/local/bin/node",
    entryPath: "/opt/pkg/bin/otto.js",
    args: ["daemon"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    stateDir: join(home, ".otto"),
    logDir: join(home, ".otto", "logs"),
    ...overrides,
  };
}

describe("getServiceInstaller", () => {
  it("maps platforms to installers", () => {
    expect(getServiceInstaller(spec(), { platform: "darwin", exec: recordingExec().exec })?.kind).toBe("launchd");
    expect(getServiceInstaller(spec(), { platform: "linux", exec: recordingExec().exec })?.kind).toBe("systemd");
    expect(getServiceInstaller(spec(), { platform: "win32", exec: recordingExec().exec })?.kind).toBe("windows");
  });
});

describe("LaunchdService", () => {
  const deps = (exec: Exec, extra: Record<string, unknown> = {}) => ({
    platform: "darwin" as const,
    exec,
    homeDir: home,
    uid: 501,
    bootstrapRetryMs: 300,
    ...extra,
  });

  it("writes the plist and bootstraps it in the gui domain", async () => {
    const { calls, exec } = recordingExec((file, args) =>
      file === "launchctl" && args[0] === "print" ? { code: 3, stdout: "", stderr: "" } : undefined,
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();

    const plist = join(home, "Library", "LaunchAgents", `${OTTO_LABEL}.plist`);
    expect(existsSync(plist)).toBe(true);
    const content = readFileSync(plist, "utf8");
    expect(content).toContain(`<string>${OTTO_LABEL}</string>`);
    expect(content).toContain("<string>/usr/local/bin/node</string>");
    expect(content).toContain("<string>/opt/pkg/bin/otto.js</string>");
    expect(content).toContain("<string>daemon</string>");
    expect(content).toContain("<key>KeepAlive</key>");
    expect(content).toContain("<true/>");
    expect(content).toContain("<key>PATH</key>");
    expect(content).toContain(join(home, ".otto", "logs", "launchd.out.log"));

    expect(calls[0]).toEqual({ file: "launchctl", args: ["print", `gui/501/${OTTO_LABEL}`] });
    expect(calls[1]).toEqual({ file: "launchctl", args: ["enable", `gui/501/${OTTO_LABEL}`] });
    expect(calls[2]).toEqual({ file: "launchctl", args: ["bootstrap", "gui/501", plist] });
  });

  it("bootouts a loaded agent and bootstraps the new unit (re-pair/upgrade)", async () => {
    let bootedOut = false;
    let bootstraps = 0;
    const { calls, exec } = recordingExec((file, args) => {
      if (file === "launchctl" && args[0] === "bootout") bootedOut = true;
      if (file === "launchctl" && args[0] === "print") {
        return bootedOut ? { code: 3, stdout: "", stderr: "" } : { code: 0, stdout: "state = running", stderr: "" };
      }
      if (file === "launchctl" && args[0] === "bootstrap") {
        bootstraps += 1;
        return bootedOut ? undefined : { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();

    const bootouts = calls.filter((c) => c.args[0] === "bootout");
    expect(bootouts).toEqual([{ file: "launchctl", args: ["bootout", `gui/501/${OTTO_LABEL}`] }]);
    expect(bootstraps).toBe(1); // the retry never runs: bootout settled first
  });

  it("start retries bootstrap through launchd's teardown window (stop → start race)", async () => {
    let bootstraps = 0;
    const { exec } = recordingExec((file, args) => {
      if (file === "launchctl" && args[0] === "print") return { code: 3, stdout: "", stderr: "" };
      if (file === "launchctl" && args[0] === "bootstrap") {
        bootstraps += 1;
        // EIO while launchd is still unloading the previous bootout, then success.
        return bootstraps < 3 ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : undefined;
      }
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.start();
    expect(bootstraps).toBe(3);
  });

  it("throws when bootstrap keeps failing", async () => {
    const { exec } = recordingExec((file, args) =>
      file === "launchctl" && args[0] === "bootstrap"
        ? { code: 5, stdout: "", stderr: "Bootstrap failed" }
        : args[0] === "print"
          ? { code: 3, stdout: "", stderr: "" }
          : undefined,
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;
    await expect(installer.install()).rejects.toThrow(/bootstrap failed \(5\)/);
  });

  it("stop disables the agent and boots it out; start re-enables and kickstarts", async () => {
    let bootedOut = false;
    const { calls, exec } = recordingExec((file, args) => {
      if (file === "launchctl" && args[0] === "bootout") bootedOut = true;
      if (file === "launchctl" && args[0] === "print") {
        return bootedOut
          ? { code: 3, stdout: "", stderr: "" }
          : { code: 0, stdout: "pid = 1\nstate = running", stderr: "" };
      }
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.stop();
    expect(calls.map((c) => `${c.args[0]}`)).toEqual(["disable", "bootout", "print"]);

    calls.length = 0;
    await installer.start();
    // after stop the agent is unloaded, so start bootstraps again
    expect(calls.map((c) => `${c.args[0]}`)).toEqual(["enable", "print", "bootstrap"]);
    expect(calls[2]).toEqual({ file: "launchctl", args: ["bootstrap", "gui/501", installer.unitPath] });
  });

  it("restart kickstarts a loaded agent", async () => {
    const { calls, exec } = recordingExec((file, args) =>
      file === "launchctl" && args[0] === "print" ? { code: 0, stdout: "\tstate = running", stderr: "" } : undefined,
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.restart();
    expect(calls).toEqual([
      { file: "launchctl", args: ["enable", `gui/501/${OTTO_LABEL}`] },
      { file: "launchctl", args: ["print", `gui/501/${OTTO_LABEL}`] },
      { file: "launchctl", args: ["kickstart", "-k", `gui/501/${OTTO_LABEL}`] },
    ]);
  });

  it("uninstall removes the plist and clears the disable mark", async () => {
    const { calls, exec } = recordingExec(
      (file, args) => (file === "launchctl" && args[0] === "print" ? { code: 3, stdout: "", stderr: "" } : undefined),
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;
    const plist = installer.unitPath;

    await installer.install();
    await installer.uninstall();

    expect(existsSync(plist)).toBe(false);
    expect(calls.some((c) => c.args[0] === "bootout")).toBe(true);
    expect(calls.some((c) => c.args[0] === "enable")).toBe(true);
  });

  it("status parses pid and state from launchctl print", async () => {
    let started = false;
    const { exec } = recordingExec((file, args) => {
      if (file === "launchctl" && args[0] === "print") {
        return started
          ? { code: 0, stdout: "domain = gui/501\n\tpid = 4242\n\tstate = running", stderr: "" }
          : { code: 3, stdout: "", stderr: "" };
      }
      if (file === "launchctl" && args[0] === "bootstrap") {
        started = true;
      }
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();
    const status = await installer.status();
    expect(status).toMatchObject({ manager: "launchd", installed: true, running: true, pid: 4242, detail: "running" });
  });

  it("status reports not loaded when print fails", async () => {
    const { exec } = recordingExec(() => ({ code: 3, stdout: "", stderr: "" }));
    const installer = getServiceInstaller(spec(), deps(exec))!;
    const status = await installer.status();
    expect(status).toMatchObject({ installed: false, running: false, detail: "not loaded" });
  });

  it("preflight asks about the gui domain install() targets, and refuses without one", async () => {
    const { calls, exec } = recordingExec((file, args) =>
      file === "launchctl" && args[0] === "print"
        ? { code: 113, stdout: "", stderr: "Could not find domain for\n" }
        : undefined,
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await expect(installer.preflight?.()).rejects.toThrow(/gui\/501.*--foreground/s);
    // The probe is the same domain bootstrap uses, and nothing was written: preflight only reads.
    expect(calls).toEqual([{ file: "launchctl", args: ["print", "gui/501"] }]);
    expect(existsSync(join(home, "Library/LaunchAgents", `${OTTO_LABEL}.plist`))).toBe(false);
  });

  it("preflight passes when the gui domain answers", async () => {
    const { exec } = recordingExec(() => ({ code: 0, stdout: "domain = gui/501\n", stderr: "" }));
    const installer = getServiceInstaller(spec(), deps(exec))!;
    await expect(installer.preflight?.()).resolves.toBeUndefined();
  });
});

describe("SystemdService", () => {
  const deps = (exec: Exec) => ({ platform: "linux" as const, exec, homeDir: home });

  it("writes the unit, reloads, and enables it now", async () => {
    const { calls, exec } = recordingExec();
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();

    const unit = join(home, ".config/systemd/user", `${OTTO_LABEL}.service`);
    expect(existsSync(unit)).toBe(true);
    const content = readFileSync(unit, "utf8");
    expect(content).toContain("ExecStart=/usr/local/bin/node /opt/pkg/bin/otto.js daemon");
    expect(content).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
    expect(content).toContain("Restart=on-failure");
    expect(content).toContain("WantedBy=default.target");

    expect(calls[0]).toEqual({ file: "systemctl", args: ["--user", "daemon-reload"] });
    expect(calls[1]).toEqual({ file: "systemctl", args: ["--user", "enable", "--now", `${OTTO_LABEL}.service`] });
    expect(calls.some((c) => c.file === "loginctl")).toBe(true); // best-effort lingering
  });

  it("records a note when enable-linger fails", async () => {
    const { exec } = recordingExec((file) =>
      file === "loginctl" ? { code: 1, stdout: "", stderr: "not allowed" } : undefined,
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;
    await installer.install();
    expect(installer.notes.length).toBe(1);
  });

  it("stop disables; start re-enables", async () => {
    const { calls, exec } = recordingExec();
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.stop();
    expect(calls[0]).toEqual({ file: "systemctl", args: ["--user", "disable", "--now", `${OTTO_LABEL}.service`] });

    calls.length = 0;
    await installer.start();
    expect(calls[0]).toEqual({ file: "systemctl", args: ["--user", "enable", "--now", `${OTTO_LABEL}.service`] });
  });

  it("uninstall removes the unit and reloads the manager", async () => {
    const { calls, exec } = recordingExec();
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();
    const unit = installer.unitPath;
    await installer.uninstall();

    expect(existsSync(unit)).toBe(false);
    expect(calls.some((c) => c.file === "systemctl" && c.args.includes("daemon-reload"))).toBe(true);
  });

  it("status degrades gracefully when the user session bus is unreachable", async () => {
    const { exec } = recordingExec(() => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }));
    const installer = getServiceInstaller(spec(), deps(exec))!;
    const status = await installer.status();
    expect(status).toMatchObject({ manager: "systemd", running: false, detail: "user session bus unreachable" });
  });

  it("status maps is-active to running and reads MainPID", async () => {
    const { exec } = recordingExec((file, args) => {
      if (file === "systemctl" && args.includes("is-active")) return { code: 0, stdout: "active\n", stderr: "" };
      if (file === "systemctl" && args.includes("MainPID")) return { code: 0, stdout: "5150\n", stderr: "" };
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;
    const status = await installer.status();
    expect(status).toMatchObject({ manager: "systemd", running: true, pid: 5150, detail: "active" });
  });

  it("throws a friendly error when the user bus is unreachable", async () => {
    const { exec } = recordingExec(() => ({
      code: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No medium found",
    }));
    const installer = getServiceInstaller(spec(), deps(exec))!;
    await expect(installer.install()).rejects.toThrow(/logged-in session/);
  });

  it("preflight surfaces the bus message before any unit file is written", async () => {
    const { calls, exec } = recordingExec(() => ({
      code: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No medium found",
    }));
    const installer = getServiceInstaller(spec(), deps(exec))!;

    const err = await installer.preflight?.().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/systemctl --user show-environment/);
    expect((err as Error).message).toMatch(/logged-in session/);
    expect(calls).toEqual([{ file: "systemctl", args: ["--user", "show-environment"] }]);
    expect(existsSync(join(home, ".config/systemd/user", `${OTTO_LABEL}.service`))).toBe(false);
  });

  it("preflight refuses a host where systemctl is missing entirely (containers)", async () => {
    const { exec } = recordingExec(() => ({ code: 127, stdout: "", stderr: "spawn systemctl ENOENT" }));
    const installer = getServiceInstaller(spec(), deps(exec))!;
    await expect(installer.preflight?.()).rejects.toThrow(/needs a systemd user session/);
  });
});

// --- Windows (ADR-0018 decision 11) ----------------------------------------------------------
//
// The installer is Windows-only in production but injected in tests: `reg.exe`, the detached
// launch, taskkill and the daemon-lock probes all go through deps, so the launcher's content and
// the exact registry calls are assertable on Linux CI. The daemon lock stands in for "is a
// connector running" — the Run key only says it *would* be started at the next logon.
describe("WindowsService", () => {
  const systemRoot = "C:\\Windows";
  const wscript = join(systemRoot, "System32", "wscript.exe");
  const dir = () => join(home, ".otto");
  const launcherPath = () => join(dir(), "otto-daemon.vbs");
  const runValue = () => `${wscript} "${launcherPath()}"`;

  /** A reg.exe that keeps the one Run value in memory, so query/add/delete agree with each
   *  other; every other key (the policies the preflight reads) is absent. */
  function fakeReg(seed?: string): { calls: Call[]; exec: Exec; value: () => string | null } {
    const calls: Call[] = [];
    let value: string | null = seed ?? null;
    const absent = { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
    const exec: Exec = async (file, args) => {
      calls.push({ file, args });
      if (file !== "reg.exe") return { code: 0, stdout: "", stderr: "" };
      const [verb, key, ...rest] = args;
      if (key === WINDOWS_RUN_KEY && rest[rest.indexOf("/v") + 1] === OTTO_LABEL) {
        if (verb === "query") {
          return value === null
            ? absent
            : { code: 0, stdout: `\r\n${WINDOWS_RUN_KEY}\r\n    ${OTTO_LABEL}    REG_SZ    ${value}\r\n\r\n`, stderr: "" };
        }
        if (verb === "add") {
          value = args[args.indexOf("/d") + 1]!;
          return { code: 0, stdout: "The operation completed successfully.\r\n", stderr: "" };
        }
        if (verb === "delete") {
          value = null;
          return { code: 0, stdout: "The operation completed successfully.\r\n", stderr: "" };
        }
      }
      return absent;
    };
    return { calls, exec, value: () => value };
  }

  /** A lock naming this (live) test process and no start time: held without a ps/Win32 probe
   *  having to agree on a format — the same fail-closed reading connect's lock check uses. */
  function writeLock(pid = 4242): string {
    const path = join(dir(), "daemon.lock");
    writeFileSync(path, JSON.stringify({ pid, startedAt: 1_700_000_000_000, version: "0.2.0" }));
    return path;
  }

  /** An installer with everything external injected. `installed` means "the launcher and the Run
   *  value are already there"; `launchWritesLock` mimics the daemon claiming the state directory
   *  as it starts, and `alive` is what the injected taskkill turns off. */
  function harness(
    opts: {
      spec?: Partial<ServiceSpec>;
      installed?: boolean;
      launchWritesLock?: boolean;
      startTimeoutMs?: number;
      alive?: boolean;
    } = {},
  ) {
    const reg = fakeReg(opts.installed ? runValue() : undefined);
    const launches: { file: string; args: string[] }[] = [];
    const kills: number[] = [];
    const alive = { now: opts.alive ?? true };
    if (opts.installed) {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(launcherPath(), "' launcher\n");
    }
    const installer = getServiceInstaller(spec({ stateDir: dir(), logDir: join(dir(), "logs"), ...opts.spec }), {
      platform: "win32",
      homeDir: home,
      systemRoot,
      startTimeoutMs: opts.startTimeoutMs ?? 500,
      exec: reg.exec,
      spawnDetached: async (file, args) => {
        launches.push({ file, args });
        if (opts.launchWritesLock !== false) writeLock();
      },
      taskkill: (pid) => {
        kills.push(pid);
        alive.now = false;
        return 0;
      },
      lockDeps: { alive: () => alive.now },
    })!;
    return { installer, reg, launches, kills, alive };
  }

  function launcherContent(overrides: Partial<ServiceSpec> = {}): string {
    const { installer } = harness({ spec: overrides });
    return (installer as unknown as { launcherContent(): string }).launcherContent();
  }

  it("is the installer for win32, and null for a platform with no service manager", () => {
    expect(getServiceInstaller(spec(), { platform: "win32", exec: fakeReg().exec })?.kind).toBe("windows");
    expect(getServiceInstaller(spec(), { platform: "freebsd" as NodeJS.Platform })).toBeNull();
  });

  it("writes a launcher that sets the daemon's environment and hides the window", () => {
    const content = launcherContent();

    expect(content).toContain('Set env = sh.Environment("PROCESS")');
    expect(launcherContent({ env: { ...spec().env, OTTO_HOME: dir() } })).toContain(`env("OTTO_HOME") = "${dir()}"`);
    expect(content).toContain(`env("PATH") = "/usr/local/bin:/usr/bin:/bin"`);
    // Each argv part goes through Chr(34): on a real machine node.exe and the entry are absolute
    // paths with spaces, and an unquoted spaced path is how `spawn C:\Program` ENOENT happens.
    expect(content).toContain(
      `cmd = Chr(34) & "/usr/local/bin/node" & Chr(34) & " " & Chr(34) & "/opt/pkg/bin/otto.js" & Chr(34) & " " & Chr(34) & "daemon" & Chr(34) & " " & Chr(34) & "--supervise" & Chr(34)`,
    );
    expect(content).toContain(`sh.CurrentDirectory = "${dir()}"`);
    // 0 is the hidden window; a Run value pointing straight at node.exe would open a console.
    expect(content).toContain("sh.Run cmd, 0, False");
    expect(content).not.toMatch(/token|secret|passw/i);
  });

  it("quotes a spaced node and entry path in the launcher (the acceptance failure mode)", () => {
    const content = launcherContent({ nodePath: "C:\\Program Files\\nodejs\\node.exe", entryPath: "C:\\otto bin\\otto.js" });
    expect(content).toContain(`Chr(34) & "C:\\Program Files\\nodejs\\node.exe" & Chr(34)`);
    expect(content).toContain(`Chr(34) & "C:\\otto bin\\otto.js" & Chr(34)`);
  });

  it("install writes the launcher, adds the Run value, then starts the daemon detached", async () => {
    const { installer, reg, launches } = harness();

    await installer.install();

    expect(existsSync(launcherPath())).toBe(true);
    expect(reg.value()).toBe(runValue());
    expect(reg.calls).toContainEqual({
      file: "reg.exe",
      args: ["add", WINDOWS_RUN_KEY, "/v", OTTO_LABEL, "/t", "REG_SZ", "/d", runValue(), "/f"],
    });
    expect(launches).toEqual([{ file: wscript, args: [launcherPath()] }]);
    // Honest about what Windows cannot do itself (no KeepAlive/Restart= counterpart): the
    // launcher starts the supervisor, which is what actually restarts a crashed daemon.
    expect(installer.notes.join(" ")).toMatch(/--supervise[\s\S]*logs\/supervisor\.log/);
  });

  it("start refuses a machine that never paired instead of leaving a dead Run value", async () => {
    const { installer, reg, launches } = harness();
    await expect(installer.start()).rejects.toThrow(/launcher is not installed[\s\S]*`otto install`[\s\S]*otto connect/);
    expect(reg.value()).toBeNull();
    expect(launches).toEqual([]);
  });

  it("start only re-enables autostart when a daemon already holds the state directory", async () => {
    const { installer, reg, launches } = harness({ installed: true });
    writeLock();

    await installer.start();

    expect(reg.value()).toBe(runValue());
    expect(launches).toEqual([]);
  });

  it("start fails with a pointer to the log when nothing comes up", async () => {
    const { installer } = harness({ installed: true, launchWritesLock: false, startTimeoutMs: 0 });
    await expect(installer.start()).rejects.toThrow(/did not come up within 0s.*connector\.log/);
  });

  it("stop removes the Run value, kills the daemon named by the lock, and clears the lock", async () => {
    const { installer, reg, kills } = harness({ installed: true });
    const path = writeLock();

    await installer.stop();

    expect(reg.value()).toBeNull();
    expect(kills).toEqual([4242]);
    // A forced kill cannot run the daemon's SIGTERM handler, so its lock file outlives it —
    // left alone it would make `otto status` claim a connector that is not there.
    expect(existsSync(path)).toBe(false);
  });

  it("stop on a machine with nothing installed is not an error", async () => {
    const { installer, reg, kills } = harness();

    await installer.stop();

    expect(kills).toEqual([]);
    expect(reg.calls.filter((call) => call.args[0] === "delete")).toEqual([]);
  });

  it("uninstall stops, removes the launcher and keeps the state data", async () => {
    const { installer, reg } = harness();
    await installer.install();
    writeFileSync(join(dir(), "connector.sqlite"), "credentials");
    expect(existsSync(launcherPath())).toBe(true);

    await installer.uninstall();

    expect(existsSync(launcherPath())).toBe(false);
    expect(reg.value()).toBeNull();
    expect(readFileSync(join(dir(), "connector.sqlite"), "utf8")).toBe("credentials");
  });

  it("status tells the Run key, the lock and the pid apart", async () => {
    const { installer } = harness();
    expect(await installer.status()).toMatchObject({ manager: "windows", installed: false, running: false, detail: "not in the Run key" });

    // Autostart installed but nothing running: the honest reading is "starts at the next logon".
    const installed = harness({ installed: true }).installer;
    expect(await installed.status()).toMatchObject({ installed: true, running: false, pid: undefined, detail: "starts at the next logon" });

    writeLock();
    expect(await installed.status()).toMatchObject({ installed: true, running: true, pid: 4242, detail: "Run key + otto-daemon.vbs" });

    // A Run value whose launcher is gone is not an install: the value would fail silently at logon.
    rmSync(launcherPath());
    expect(await installed.status()).toMatchObject({ installed: false, detail: /Run key present but .* is missing/ });
  });

  it("preflight refuses a policy-disabled Run key or a disabled script host", async () => {
    const wscriptDir = join(home, "System32");
    mkdirSync(wscriptDir, { recursive: true });
    writeFileSync(join(wscriptDir, "wscript.exe"), "");
    const { exec } = fakeReg();
    const withSystemRoot = (root: string, execImpl: Exec) =>
      getServiceInstaller(spec(), { platform: "win32", homeDir: home, systemRoot: root, exec: execImpl })!;
    const policy = (key: string, data: string): Exec => async (file, args) => {
      if (file === "reg.exe" && args[1] === key) return { code: 0, stdout: `    ${args[3]}    REG_DWORD    ${data}\r\n`, stderr: "" };
      return exec(file, args);
    };

    // Clean machine: nothing to refuse, and nothing is written either (read-only checks).
    await expect(withSystemRoot(home, exec).preflight?.()).resolves.toBeUndefined();
    expect(existsSync(launcherPath())).toBe(false);

    const noRun = withSystemRoot(home, policy("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer", "0x1"));
    await expect(noRun.preflight?.()).rejects.toThrow(/Run key is disabled by policy[\s\S]*--foreground/);

    const wshOff = withSystemRoot(home, policy("HKLM\\SOFTWARE\\Microsoft\\Windows Script Host\\Settings", "0x0"));
    await expect(wshOff.preflight?.()).rejects.toThrow(/Windows Script Host is disabled by policy[\s\S]*--foreground/);

    const noWscript = withSystemRoot(join(home, "nope"), exec);
    await expect(noWscript.preflight?.()).rejects.toThrow(/needs Windows Script Host[\s\S]*--foreground/);
  });
});
