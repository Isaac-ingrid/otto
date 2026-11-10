// `otto install` puts the background service in place for a machine that is **already paired**,
// so it takes no code and must never write anything on a machine that cannot use the service.
// Both refusals are asserted here through the real CLI with a private HOME (the state directory
// becomes <home>/.otto, while OTTO_HOME stays unset so the state-dir guard is not what refuses —
// it has its own case). The happy path needs the machine's real Run key, so it lives in
// test/windows-live.test.ts behind OTTO_WIN_LIVE_INSTALL=1 (ADR-0018 decision 11's rule).
//
// Each refusal case parks a **tripwire** in the way of the next step, so that if the check under
// test ever stops refusing, the run dies before it can write this machine's real Run value: a test
// that removes a guard must not be able to install anything (see the comments in the cases).
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { OTTO_LABEL, WINDOWS_RUN_KEY } from "../src/service.ts";

const run = promisify(execFile);
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

async function cli(args: string[], env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [dist, ...args], { env: { ...process.env, ...env } });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

/** The Run value is shared machine state: every refusal must leave it exactly as it was. */
async function ottoRunValue(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const res = await run("reg.exe", ["query", WINDOWS_RUN_KEY, "/v", OTTO_LABEL]).catch((e: unknown) => e as { stdout?: string });
  const stdout = (res as { stdout?: string }).stdout ?? "";
  return new RegExp(`^\\s+${OTTO_LABEL}\\s+REG_\\w+\\s+(.*)$`, "m").exec(stdout)?.[1]?.trim() ?? null;
}

describe("otto install", () => {
  let home = "";
  let privateDir = "";

  afterEach(async () => {
    // A mutation under test could still have installed something: never leave it behind.
    if ((await ottoRunValue()) !== null && process.platform === "win32") {
      await run("reg.exe", ["delete", WINDOWS_RUN_KEY, "/v", OTTO_LABEL, "/f"]).catch(() => undefined);
    }
    for (const dir of [home, privateDir]) if (dir) rmSync(dir, { recursive: true, force: true });
    home = "";
    privateDir = "";
  });

  it("refuses an unpaired machine, and says it never needs a pairing code", async () => {
    home = mkdtempSync(join(tmpdir(), "otto-install-unpaired-"));
    // Tripwire: the state directory path is a *file*, so anything that got past the pairing check
    // would die in installAssets (mkdir <dir>/ext → ENOTDIR) instead of writing a real Run value.
    writeFileSync(join(home, ".otto"), "");

    const { code, stdout, stderr } = await cli(["install"], { OTTO_HOME: undefined, USERPROFILE: home, HOME: home });

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/not paired yet/);
    expect(stderr).toMatch(/`otto connect <url> <code>` first/);
    expect(stderr).toMatch(/never needs a pairing code/);
    expect(await ottoRunValue()).toBeNull();
    // The refusal is about the local credential, not about a server: nothing is dialed, and the
    // help text is not printed as if the command were wrong.
    expect(stdout).not.toMatch(/installed/);
    expect(stderr).not.toMatch(/usage:/);
  }, 30_000);

  it("refuses a private state directory instead of repointing the machine's connector", async () => {
    privateDir = mkdtempSync(join(tmpdir(), "otto-install-private-"));
    // Same idea: with the guard removed, the *pairing* check is the next refusal, so a private,
    // unpaired directory still cannot end in an install.
    const { code, stdout, stderr } = await cli(["install"], { OTTO_HOME: privateDir });

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/would repoint this machine's connector/);
    expect(stderr).toMatch(/--foreground/);
    expect(stdout).not.toMatch(/installed/);
    expect(await ottoRunValue()).toBeNull();
    // Nothing was written into it, and no store was even created.
    expect(readdirSync(privateDir)).toEqual([]);
  }, 30_000);

  it("takes no arguments — there is no code and no URL to pass", async () => {
    const { code, stderr } = await cli(["install", "DUMMY1234"], { OTTO_HOME: undefined });
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage:/);
    // The command is where `otto uninstall` is, so the usage text has to name what it is for.
    expect(stderr).toMatch(/otto install\s+install \(or repair\) the background service for a/);
    expect(stderr).toMatch(/pairing code/);
  }, 30_000);
});
