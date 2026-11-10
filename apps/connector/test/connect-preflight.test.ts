// `otto connect` must not spend a pairing code on a machine that cannot install the background
// service. The code is single-use (protocol §5.2: the first successful /pair redeems it), so a
// failure found *after* pairing costs the owner a freshly generated code — which is what a
// Windows machine did on every retry before the preflight existed.
//
// The URL points at a closed local port, so where the run stopped is visible from the error:
// the preflight's refusal (no traffic was attempted) versus `fetch failed` from a /pair call
// (by which point a reachable server would already have redeemed the code).
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
// 9 (discard) is closed here; nothing listens, so a fetch would be refused immediately.
const CLOSED = "http://127.0.0.1:9";

describe.runIf(process.platform === "win32")("connect preflight on a platform with no service", () => {
  it("refuses before pairing, and leaves the state directory untouched", async () => {
    // A private HOME keeps the real ~/.otto out of it, while OTTO_HOME stays unset so the
    // state-dir guard is not what refuses (it would otherwise fire first and prove nothing).
    const home = mkdtempSync(join(tmpdir(), "otto-preflight-"));
    try {
      const err = await run(process.execPath, [dist, "connect", CLOSED, "DUMMY1234"], {
        env: { ...process.env, USERPROFILE: home, HOME: home, OTTO_HOME: undefined },
      }).catch((e: unknown) => e as { stderr?: string; message?: string });
      const text = `${(err as { stderr?: string }).stderr ?? ""}${(err as { message?: string }).message ?? ""}`;

      expect(text).toMatch(/background services are not supported on win32/);
      expect(text).toMatch(/--foreground/);
      // Neither shape of "the code was spent" happened: no /pair fetch, and no credentials,
      // not even a store file — the refusal lands before the state dir is created.
      expect(text).not.toMatch(/ECONNREFUSED|fetch failed|pair/i);
      expect(existsSync(join(home, ".otto"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

// `otto connect --foreground` runs the daemon in this terminal, and on Windows that is the
// supported shape — so it is also the shape where a second connector is most likely: the same
// command run twice, or a forgotten terminal. The lock is checked before pairing for the same
// reason the service preflight is (the code is single-use), so the refusal must land without a
// /pair attempt. Platform-independent: it is the daemon lock, not the service manager.
describe("connect --foreground refuses while another daemon holds the state directory", () => {
  it("refuses a held lock before pairing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-lock-held-"));
    try {
      // A live pid with no recorded start time is "held" without needing a ps/Win32 probe to
      // agree on the format — the same fail-closed reading the worker locks use.
      const lockPath = join(dir, "daemon.lock");
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 1_700_000_000_000, version: "0.2.0" }));
      const err = await run(process.execPath, [dist, "connect", CLOSED, "DUMMY1234", "--foreground"], {
        env: { ...process.env, OTTO_HOME: dir },
      }).catch((e: unknown) => e as { stderr?: string; message?: string });
      const text = `${(err as { stderr?: string }).stderr ?? ""}${(err as { message?: string }).message ?? ""}`;

      expect(text).toMatch(/already running/);
      expect(text).toContain(lockPath);
      expect(text).not.toMatch(/ECONNREFUSED|fetch failed|pair/i);
      // The refusal must not steal the lock from its holder.
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses an unreadable lock file, and reaches /pair when the lock is free", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-lock-junk-"));
    try {
      const lockPath = join(dir, "daemon.lock");
      writeFileSync(lockPath, "{ truncated");
      const refused = await run(process.execPath, [dist, "connect", CLOSED, "DUMMY1234", "--foreground"], {
        env: { ...process.env, OTTO_HOME: dir },
      }).catch((e: unknown) => e as { stderr?: string; message?: string });
      const refusedText = `${(refused as { stderr?: string }).stderr ?? ""}${(refused as { message?: string }).message ?? ""}`;
      expect(refusedText).toMatch(/does not name a process/);
      expect(refusedText).not.toMatch(/ECONNREFUSED|fetch failed/);
      expect(readFileSync(lockPath, "utf8")).toBe("{ truncated");

      // Contrast case, so the assertions above are about the lock and not about a command that
      // refuses everything: with no lock file the same command gets as far as the /pair fetch.
      rmSync(lockPath);
      const past = await run(process.execPath, [dist, "connect", CLOSED, "DUMMY1234", "--foreground"], {
        env: { ...process.env, OTTO_HOME: dir },
      }).catch((e: unknown) => e as { stderr?: string; message?: string });
      const pastText = `${(past as { stderr?: string }).stderr ?? ""}${(past as { message?: string }).message ?? ""}`;
      expect(pastText).toMatch(/fetch failed|ECONNREFUSED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
