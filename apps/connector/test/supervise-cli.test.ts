// The supervised-daemon gate, end to end through the real CLI: `otto daemon` is also what a
// supervisor starts, so a process that merely *claims* to be supervised must not slip past the
// single-instance lock (ADR-0018 decisions 10 + 12). The gate runs before pairing and before any
// network traffic, so these runs need no steward and no credentials — only a state directory.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SUPERVISOR_ENV } from "../src/supervisor.ts";

const run = promisify(execFile);
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

async function daemonRun(home: string, env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await run(process.execPath, [dist, "daemon"], {
      env: { ...process.env, OTTO_HOME: home, ...env },
    });
    return { code: 0, stderr };
  } catch (err) {
    const failure = err as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
  }
}

describe("otto daemon under a supervisor", () => {
  let home = "";

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });

  it("refuses when the pid it was told about is not its parent", async () => {
    home = mkdtempSync(join(tmpdir(), "otto-supervised-"));
    const { code, stderr } = await daemonRun(home, { [SUPERVISOR_ENV]: "99999999" });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/its parent is pid \d+/);
  }, 30_000);

  it("refuses when its parent does not hold the state directory", async () => {
    home = mkdtempSync(join(tmpdir(), "otto-supervised-"));
    // This test process really is the child's parent, so the only thing missing is the lock.
    const { code, stderr } = await daemonRun(home, { [SUPERVISOR_ENV]: String(process.pid) });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/does not hold the state directory lock/);
    expect(stderr).toMatch(/no lock/);
  }, 30_000);

  it("passes the gate once its parent holds the lock, and still needs pairing", async () => {
    home = mkdtempSync(join(tmpdir(), "otto-supervised-"));
    writeFileSync(
      join(home, "daemon.lock"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: "test" }),
    );
    const { code, stderr } = await daemonRun(home, { [SUPERVISOR_ENV]: String(process.pid) });
    expect(code).not.toBe(0);
    // Past the gate, i.e. the refusal is the unpaired state directory, which is what a supervised
    // child is supposed to report to its supervisor.
    expect(stderr).toMatch(/not paired/);
    expect(stderr).not.toMatch(/refusing to run a second daemon/);
  }, 30_000);

  it("status names the child only while the lock's holder is that supervisor", async () => {
    home = mkdtempSync(join(tmpdir(), "otto-supervised-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: "test" }));
    const status = async (): Promise<string> =>
      (await run(process.execPath, [dist, "status"], { env: { ...process.env, OTTO_HOME: home } })).stdout;

    // A state file from an older supervisor (another pid) must not decorate the current holder.
    writeFileSync(
      join(home, "supervisor.json"),
      JSON.stringify({ supervisorPid: 4242, childPid: 5151, restarts: 3, startedAt: 1, updatedAt: 2 }),
    );
    expect(await status()).not.toMatch(/supervised/);

    writeFileSync(
      join(home, "supervisor.json"),
      JSON.stringify({ supervisorPid: process.pid, childPid: 5151, restarts: 2, startedAt: 1, updatedAt: 2 }),
    );
    expect(await status()).toMatch(/\[supervised: child pid 5151, 2 restarts\]/);
  }, 30_000);

  it("does not release the supervisor's lock on its way out", async () => {
    home = mkdtempSync(join(tmpdir(), "otto-supervised-"));
    const lockPath = join(home, "daemon.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: "test" }));
    await daemonRun(home, { [SUPERVISOR_ENV]: String(process.pid) });
    // The child failed, but the supervisor is still alive and still owns the directory.
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
  }, 30_000);
});
