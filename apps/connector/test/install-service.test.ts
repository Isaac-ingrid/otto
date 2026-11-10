// The order inside `otto install` (ADR-0018 decisions 9 and 12): a machine that is already paired
// gets the service only through `installService` — preflight (install-blocking facts, nothing
// written before it passes), this version's pi assets, the unit itself. Each of those steps is
// one line, and each one removed or reordered is a real bug: an install past a preflight can leave
// a Run value pointing at a service that cannot start, and a service installed without the assets
// comes up and fails every worker. Hence the sequence is asserted here rather than only in the
// gated real-machine test.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installService, type ServiceInstaller, type ServiceStatus } from "../src/service.ts";
import { VERSION } from "../src/version.ts";

const NOT_INSTALLED: ServiceStatus = { manager: "windows", installed: false, running: false, detail: "not in the Run key" };
const RUNNING: ServiceStatus = { manager: "windows", installed: true, running: true, pid: 4242, detail: "Run key" };

/** A double that records what it was asked to do, in order. */
function fakeInstaller(
  options: { preflight?: () => Promise<void>; install?: () => Promise<void>; statuses?: ServiceStatus[] } = {},
): { installer: ServiceInstaller; calls: string[] } {
  const calls: string[] = [];
  const statuses = options.statuses ?? [NOT_INSTALLED, RUNNING];
  const installer: ServiceInstaller = {
    kind: "windows",
    unitPath: "C:\\fake\\otto-daemon.vbs",
    notes: [],
    install: async () => {
      calls.push("install");
      await options.install?.();
    },
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
    restart: async () => {
      calls.push("restart");
    },
    uninstall: async () => {
      calls.push("uninstall");
    },
    status: async () => {
      calls.push("status");
      return statuses.shift() ?? RUNNING;
    },
  };
  if (options.preflight) {
    const preflight = options.preflight;
    installer.preflight = async () => {
      calls.push("preflight");
      await preflight();
    };
  }
  return { installer, calls };
}

describe("installService", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("preflights, writes the assets, installs the unit, and reports both sides of the status", async () => {
    dir = mkdtempSync(join(tmpdir(), "otto-install-service-"));
    const { installer, calls } = fakeInstaller({ preflight: async () => undefined });

    const result = await installService(installer, dir, () => calls.push("assets"));

    expect(calls).toEqual(["preflight", "status", "assets", "install", "status"]);
    expect(result.before).toEqual(NOT_INSTALLED);
    expect(result.after).toEqual(RUNNING);
  }, 30_000);

  it("writes this version's pi assets by default, so the service it installs can run a worker", async () => {
    dir = mkdtempSync(join(tmpdir(), "otto-install-assets-"));
    const { installer } = fakeInstaller();

    await installService(installer, dir);

    expect(existsSync(join(dir, "ext", `otto-pi-${VERSION}.ts`))).toBe(true);
    expect(existsSync(join(dir, "prompts", `worker-${VERSION}.md`))).toBe(true);
  }, 30_000);

  it("a refused preflight installs nothing at all", async () => {
    dir = mkdtempSync(join(tmpdir(), "otto-install-refused-"));
    const { installer, calls } = fakeInstaller({
      preflight: async () => {
        throw new Error("the Run key is disabled by policy");
      },
    });

    await expect(installService(installer, dir)).rejects.toThrow(/Run key is disabled by policy/);
    // No status read, no unit, and not even the assets: the refusal is the whole run.
    expect(calls).toEqual(["preflight"]);
    expect(readdirSync(dir)).toEqual([]);
  }, 30_000);

  it("installs for an installer that has no preflight to offer", async () => {
    dir = mkdtempSync(join(tmpdir(), "otto-install-nopreflight-"));
    const { installer, calls } = fakeInstaller();

    await installService(installer, dir);

    expect(calls).toEqual(["status", "install", "status"]);
  }, 30_000);

  it("an asset that cannot be written stops the install before the unit is touched", async () => {
    dir = mkdtempSync(join(tmpdir(), "otto-install-assets-fail-"));
    const { installer, calls } = fakeInstaller();

    await expect(
      installService(installer, dir, () => {
        throw new Error("EACCES: permission denied, mkdir 'ext'");
      }),
    ).rejects.toThrow(/EACCES/);
    expect(calls).toEqual(["status"]);
  }, 30_000);
});
