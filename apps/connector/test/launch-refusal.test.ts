// The launch *refusal* (pi-launch.ts §4.2, ADR-0018 decision 1). A Windows install whose shim
// is neither a native binary nor readable as a JavaScript entry resolves to `windows-unresolved`
// with its reason. Neither adapter may spawn that: an unstartable bare name reached the user as
// `spawn pi ENOENT` inside a worker's stderr log, after a task was already dispatched.
//
// The resolution is injected, so this runs on every platform — the platform that *produces* a
// refusal is covered by pi-launch.test.ts.
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterError, type StartSpec } from "../src/agent.ts";
import { PiAdapter } from "../src/pi-adapter.ts";
import { ClaudeAdapter } from "../src/claude-adapter.ts";
import { launchCheck, type LaunchResolution } from "../src/pi-launch.ts";

const REFUSAL: LaunchResolution = {
  argv: ["pi"],
  source: "windows-unresolved",
  detail: "C:\\tools\\pi.cmd",
  error: "C:\\tools\\pi.cmd is not a native executable and its JavaScript entry could not be read",
};

const SPEC: StartSpec = {
  workerId: "w_launch_refusal",
  threadId: "t_launch_refusal",
  cwd: process.cwd(),
  mode: "readonly",
  prompt: "hello",
  commandId: "c_launch_refusal",
};

const dirs: string[] = [];
function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-launch-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a refused launch is not spawned", () => {
  it("PiAdapter.start reports the resolution's reason", async () => {
    const stateDir = tempStateDir();
    const adapter = new PiAdapter({ stateDir, launch: REFUSAL });
    const first = await adapter.start({ ...SPEC }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(AdapterError);
    expect((first as AdapterError).code).toBe("launch_unresolved");
    expect((first as AdapterError).message).toContain("JavaScript entry could not be read");
    expect(adapter.launchResolution).toBe(REFUSAL);
    // Nothing was installed and no worker was registered: the refusal is the first thing touched.
    expect(existsSync(join(stateDir, "ext"))).toBe(false);
    expect(readdirSync(stateDir)).toEqual([]);
    // A second start is refused identically, not admitted as a lock conflict.
    await expect(adapter.start({ ...SPEC })).rejects.toMatchObject({ code: "launch_unresolved" });
  });

  it("ClaudeAdapter.start does the same, with a code the worker manager can report", async () => {
    const stateDir = tempStateDir();
    const claudeRefusal: LaunchResolution = {
      argv: ["claude"],
      source: "windows-unresolved",
      detail: "C:\\tools\\claude.cmd",
      error: "C:\\tools\\claude.cmd is not a native executable and its JavaScript entry could not be read",
    };
    const adapter = new ClaudeAdapter({ stateDir, launch: claudeRefusal });
    const err = await adapter.start({ ...SPEC }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe("launch_unresolved");
    expect((err as AdapterError).message).toBe(claudeRefusal.error);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("an injected launch that is fine still resolves, and the verdict stays the argv probe", async () => {
    const adapter = new PiAdapter({ stateDir: tempStateDir(), launch: { argv: [process.execPath], source: "as-is" } });
    expect(adapter.launchResolution.source).toBe("as-is");
    expect(launchCheck(adapter.launchResolution).ok).toBe(true);
  });
});
