// The state-dir guard: connect may not install the shared service from a private state dir
// (OTTO_HOME). The guard fires before any pairing traffic, so a dummy code never reaches the
// network.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

describe("connect with a private state directory", () => {
  it("refuses to install the shared service from OTTO_HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "otto-guard-"));
    try {
      const p = run(process.execPath, [dist, "connect", "https://example.com", "DUMMY1234"], {
        env: { ...process.env, OTTO_HOME: home },
      });
      await expect(p).rejects.toThrow(/would repoint this machine's connector/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("reads an empty OTTO_HOME as unset, never as the working directory", async () => {
    // A shell that exports an empty OTTO_HOME (`OTTO_HOME= otto status`) used to resolve the
    // state dir to "", so the store path became a bare relative "connector.sqlite": whatever
    // file happens to sit in the current directory is then read as this machine's credentials
    // store. We plant a file that is not a database, which that path trips over; the fix reads
    // the real ~/.otto (here a fresh home) and reports an unpaired machine instead.
    const home = mkdtempSync(join(tmpdir(), "otto-guard-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "otto-guard-cwd-"));
    try {
      writeFileSync(join(cwd, "connector.sqlite"), "not a database");
      const { stdout } = await run(process.execPath, [dist, "status"], {
        cwd,
        env: { ...process.env, OTTO_HOME: "", USERPROFILE: home, HOME: home },
      });
      expect(stdout).toMatch(/paired:\s+not paired/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
