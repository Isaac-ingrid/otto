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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
