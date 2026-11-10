// The daemon's single-instance lock (ADR-0018 phase 2). Everything here is about the *verdict*,
// not about lock files in general: the danger is asymmetric. A wrongly refused start costs one
// retry; a wrongly granted one puts two daemons on one state directory, where the steward settles
// the duplicate connection by connEpoch and each daemon's orphan cleanup may kill the other's live
// worker children. So every unreadable or unverifiable case below asserts "refused".
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDaemonLock,
  DAEMON_LOCK_FILE,
  daemonLockPath,
  daemonLockStatus,
  readDaemonLock,
  releaseDaemonLock,
  type DaemonLockDeps,
} from "../src/daemon-lock.ts";

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-daemon-lock-"));
  return dir;
}

/** A world of fake processes: `alive` and start times are looked up in one table. */
function fakeWorld(processes: Record<number, { startTime?: string; alive?: boolean }>): DaemonLockDeps {
  return {
    // A listed pid is alive unless the entry says otherwise; an unlisted one does not exist.
    alive: (pid) => (processes[pid] === undefined ? false : (processes[pid]!.alive ?? true)),
    startTime: (pid) => processes[pid]?.startTime,
    now: () => 1_700_000_000_000,
  };
}

const SELF = { pid: 4242, startTime: "self-lstart" };

describe("daemon lock: single instance (ADR-0018 phase 2)", () => {
  it("claims a free lock and records the holder's identity", () => {
    const dir = tempState();
    try {
      const res = acquireDaemonLock(dir, "0.2.0", { self: () => SELF, ...fakeWorld({}) });
      expect(res.ok).toBe(true);
      const raw = JSON.parse(readFileSync(daemonLockPath(dir), "utf8"));
      expect(raw).toEqual({ pid: 4242, startTime: "self-lstart", startedAt: 1_700_000_000_000, version: "0.2.0" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses while the process named by the lock is still alive and is the same process", () => {
    const dir = tempState();
    try {
      writeFileSync(daemonLockPath(dir), JSON.stringify({ pid: 111, startTime: "t1", startedAt: 1700, version: "0.1.0" }));
      const before = readFileSync(daemonLockPath(dir), "utf8");
      const res = acquireDaemonLock(dir, "0.2.0", { self: () => SELF, ...fakeWorld({ 111: { startTime: "t1" } }) });
      expect(res).toMatchObject({ ok: false, error: "daemon_running", reason: "held", pid: 111, startedAt: 1700, version: "0.1.0" });
      // The refusal must not touch the holder's lock file.
      expect(readFileSync(daemonLockPath(dir), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes over a lock whose process is gone", () => {
    const dir = tempState();
    try {
      writeFileSync(daemonLockPath(dir), JSON.stringify({ pid: 111, startTime: "t1", startedAt: 1700, version: "0.1.0" }));
      const res = acquireDaemonLock(dir, "0.2.0", { self: () => SELF, ...fakeWorld({ 111: { alive: false } }) });
      expect(res.ok).toBe(true);
      expect(readDaemonLock(dir)).toMatchObject({ state: "held", content: { pid: 4242 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes over a lock whose pid was reused by a different process (start time differs)", () => {
    const dir = tempState();
    try {
      writeFileSync(daemonLockPath(dir), JSON.stringify({ pid: 111, startTime: "t1", startedAt: 1700, version: "0.1.0" }));
      const res = acquireDaemonLock(dir, "0.2.0", { self: () => SELF, ...fakeWorld({ 111: { startTime: "t2" } }) });
      expect(res.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when the holder's start time cannot be read — unknown is held, not free (§4.3)", () => {
    const dir = tempState();
    try {
      writeFileSync(daemonLockPath(dir), JSON.stringify({ pid: 111, startTime: "t1", startedAt: 1700, version: "0.1.0" }));
      // Alive, but the probe (a ps / Win32_Process subprocess) returned nothing this time.
      const res = acquireDaemonLock(dir, "0.2.0", { self: () => SELF, ...fakeWorld({ 111: {} }) });
      expect(res).toMatchObject({ ok: false, error: "daemon_running", reason: "held", pid: 111 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unreadable lock file instead of assuming it is free", () => {
    const dir = tempState();
    try {
      for (const junk of ["", "{ not json", JSON.stringify({ pid: 0 }), JSON.stringify({ startTime: "t1" }), JSON.stringify({ pid: -5 })]) {
        writeFileSync(daemonLockPath(dir), junk);
        const read = readDaemonLock(dir);
        expect(read.state).toBe("unreadable");
        const res = acquireDaemonLock(dir, "0.2.0", { self: () => SELF, ...fakeWorld({}) });
        expect(res).toMatchObject({ ok: false, error: "daemon_running", reason: "unreadable", path: daemonLockPath(dir) });
        // …and the file it refused on is left in place for the operator to inspect.
        expect(readFileSync(daemonLockPath(dir), "utf8")).toBe(junk);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases only its own lock, so a superseded daemon cannot delete the new holder's", () => {
    const dir = tempState();
    try {
      writeFileSync(daemonLockPath(dir), JSON.stringify({ pid: 999, startTime: "other", startedAt: 1700, version: "0.2.0" }));
      expect(releaseDaemonLock(dir, { self: () => SELF })).toBe(false);
      expect(readDaemonLock(dir).state).toBe("held");

      acquireDaemonLock(dir, "0.2.0", { self: () => SELF, ...fakeWorld({}) });
      expect(releaseDaemonLock(dir, { self: () => SELF })).toBe(true);
      expect(readDaemonLock(dir).state).toBe("absent");
      expect(releaseDaemonLock(dir, { self: () => SELF })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases its own lock, but not a pid-reused one that only looks like ours", () => {
    const dir = tempState();
    try {
      // Same pid, different start time: the pid was reused, so this is not our lock to delete.
      writeFileSync(daemonLockPath(dir), JSON.stringify({ pid: 4242, startTime: "reused", startedAt: 1700, version: "0.2.0" }));
      expect(releaseDaemonLock(dir, { self: () => SELF })).toBe(false);
      expect(readDaemonLock(dir).state).toBe("held");

      // Same pid and no recorded start time (it was unreadable when written): still ours —
      // the pid is all either side had.
      writeFileSync(daemonLockPath(dir), JSON.stringify({ pid: 4242, startedAt: 1700, version: "0.2.0" }));
      expect(releaseDaemonLock(dir, { self: () => SELF })).toBe(true);
      expect(readDaemonLock(dir).state).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports status: absent, held, and stale — the three answers `otto status` can print", () => {
    const dir = tempState();
    try {
      expect(daemonLockStatus(dir, fakeWorld({}))).toMatchObject({ present: false, held: false, stale: false });

      writeFileSync(daemonLockPath(dir), JSON.stringify({ pid: 111, startTime: "t1", startedAt: 1700, version: "0.2.0" }));
      expect(daemonLockStatus(dir, fakeWorld({ 111: { startTime: "t1" } }))).toMatchObject({ present: true, held: true, stale: false, pid: 111 });
      expect(daemonLockStatus(dir, fakeWorld({ 111: { alive: false } }))).toMatchObject({ present: true, held: false, stale: true, pid: 111 });

      writeFileSync(daemonLockPath(dir), "{ truncated");
      // An unreadable lock reads as held: the honest answer is "something is there".
      expect(daemonLockStatus(dir, fakeWorld({}))).toMatchObject({ present: true, held: true, stale: false, pid: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a second claim by a live process, using the real pid + start-time probe", () => {
    const dir = tempState();
    try {
      // No injected identity or world: this is the real thing, against this test process.
      const first = acquireDaemonLock(dir, "0.2.0");
      expect(first.ok).toBe(true);
      const second = acquireDaemonLock(dir, "0.2.0");
      expect(second).toMatchObject({ ok: false, error: "daemon_running", pid: process.pid });
      expect(releaseDaemonLock(dir)).toBe(true);
      expect(readDaemonLock(dir).state).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the lock out of the worker lock directory, so a stale-lock sweep cannot touch it", () => {
    const dir = tempState();
    try {
      acquireDaemonLock(dir, "0.2.0", { self: () => SELF, ...fakeWorld({}) });
      expect(daemonLockPath(dir)).toBe(join(dir, DAEMON_LOCK_FILE));
      expect(DAEMON_LOCK_FILE).not.toContain("locks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
