// kill.ts: termination has to end pi's whole tree on Windows (a single signal reaches only
// node), while POSIX keeps the plain signal. The routing and the never-touch-system-pids
// guards run everywhere; one live case terminates a real child.
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { killNeedsTree, terminateProcess } from "../src/kill.ts";

describe("terminateProcess routing", () => {
  it("uses taskkill /T on Windows, forcing only for SIGKILL", () => {
    const taskkill = vi.fn(() => 0);
    terminateProcess(4242, "SIGTERM", { platform: "win32", taskkill });
    terminateProcess(4242, "SIGKILL", { platform: "win32", taskkill });
    expect(taskkill.mock.calls).toEqual([
      [4242, false],
      [4242, true],
    ]);
  });

  it("never signals the system pids or itself, on either platform", () => {
    const taskkill = vi.fn(() => 0);
    for (const pid of [0, 1, 2, 4, process.pid]) {
      terminateProcess(pid, "SIGKILL", { platform: "win32", taskkill });
    }
    expect(taskkill).not.toHaveBeenCalled();
  });

  it("knows which platforms need the tree walk", () => {
    expect(killNeedsTree("win32")).toBe(true);
    expect(killNeedsTree("linux")).toBe(false);
    expect(killNeedsTree("darwin")).toBe(false);
  });
});

describe("terminateProcess against a real child", () => {
  it("ends a spawned process and reports the exit", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    terminateProcess(child.pid!, "SIGKILL");
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("child survived termination")), 10_000)),
    ]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 20_000);
});
