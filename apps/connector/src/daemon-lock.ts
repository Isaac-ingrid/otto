// The daemon's own single-instance lock, ADR-0018 phase 2: <stateDir>/daemon.lock.
//
// Why it is a prerequisite for any autostart rather than a nicety: the steward does not catch a
// second daemon on the same machine. A duplicate `hello` is settled by `connEpoch` (the newer
// connection supersedes the older, steward.ts), so two daemons would take turns superseding each
// other while both run reconcile, orphan cleanup and the stall watchdog over one state directory
// and one set of pi process trees. Startup orphan cleanup kills what the shared store's snapshots
// name, and that guard (alive + start time) only rules out pid reuse — it cannot tell another
// daemon's live worker children from its own.
//
// Held with the same identity discipline as the worker locks (locks.ts): pid + process start time,
// and an unreadable lock is *held*, never free. This file deliberately lives in the state-dir root
// and not in locks/: the worker sweep (`removeStaleLocks`) and the test helper that fakes a crash
// rewrite every `*.lock` in that directory, and neither should ever touch the daemon's own lock.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockVerdict, pidAlive, processStartTime } from "./locks.ts";

export const DAEMON_LOCK_FILE = "daemon.lock";

export interface DaemonLockContent {
  pid: number;
  /** Start time of `pid` as recordable on this platform (locks.ts's format); guards pid reuse. */
  startTime?: string;
  startedAt: number;
  /** Connector version that took the lock — diagnostic only, never a compatibility gate. */
  version: string;
}

export interface DaemonLockDeps {
  /** The identity to claim/release with. Defaults to this process. Tests inject a fake. */
  self?: () => { pid: number; startTime?: string };
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | undefined;
  now?: () => number;
}

export type DaemonLockRead =
  | { state: "absent" }
  /** A well-formed lock. Whether it is *held* still depends on pid + start time. */
  | { state: "held"; content: DaemonLockContent }
  /** Present but not usable as a lock (truncated or hand-edited). Callers fail closed. */
  | { state: "unreadable"; reason: string };

export type DaemonLockResult =
  | { ok: true; path: string; content: DaemonLockContent }
  | {
      ok: false;
      error: "daemon_running";
      reason: "held" | "unreadable";
      pid: number | null;
      startedAt: number | null;
      version: string | null;
      path: string;
      detail?: string;
    };

export function daemonLockPath(stateDir: string): string {
  return join(stateDir, DAEMON_LOCK_FILE);
}

function selfIdentity(deps: DaemonLockDeps): { pid: number; startTime?: string } {
  if (deps.self) return deps.self();
  return { pid: process.pid, startTime: processStartTime(process.pid) };
}

export function readDaemonLock(stateDir: string): DaemonLockRead {
  const path = daemonLockPath(stateDir);
  if (!existsSync(path)) return { state: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  const candidate = parsed as Partial<DaemonLockContent>;
  if (typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid) || candidate.pid <= 0) {
    return { state: "unreadable", reason: "no usable pid in the lock file" };
  }
  return {
    state: "held",
    content: {
      pid: candidate.pid,
      startTime: typeof candidate.startTime === "string" ? candidate.startTime : undefined,
      startedAt: typeof candidate.startedAt === "number" ? candidate.startedAt : 0,
      version: typeof candidate.version === "string" ? candidate.version : "unknown",
    },
  };
}

/** Whether the live process the lock names is still the process that wrote it (locks.ts §4.3:
 *  a dead pid is no lock, a live pid with a different start time is a reused pid — no lock, and
 *  a live pid whose start time cannot be read is *unknown* and counts as held). */
export function daemonLockHeld(content: DaemonLockContent, deps: DaemonLockDeps = {}): boolean {
  const alive = deps.alive ?? pidAlive;
  const startTime = deps.startTime ?? processStartTime;
  return lockVerdict(content.startTime, alive(content.pid), () => startTime(content.pid));
}

/** Claims the lock for this process. Refuses while another daemon holds it, and refuses an
 *  unreadable lock file the same way (fail closed — the holder cannot be checked at all). A stale
 *  lock (dead pid, or a reused pid) is replaced, atomically, via tmp + rename. */
export function acquireDaemonLock(stateDir: string, version: string, deps: DaemonLockDeps = {}): DaemonLockResult {
  const path = daemonLockPath(stateDir);
  const existing = readDaemonLock(stateDir);
  if (existing.state === "held" && daemonLockHeld(existing.content, deps)) {
    return {
      ok: false,
      error: "daemon_running",
      reason: "held",
      pid: existing.content.pid,
      startedAt: existing.content.startedAt || null,
      version: existing.content.version,
      path,
    };
  }
  if (existing.state === "unreadable") {
    return {
      ok: false,
      error: "daemon_running",
      reason: "unreadable",
      pid: null,
      startedAt: null,
      version: null,
      path,
      detail: existing.reason,
    };
  }

  const self = selfIdentity(deps);
  const content: DaemonLockContent = {
    pid: self.pid,
    startTime: self.startTime,
    startedAt: (deps.now ?? Date.now)(),
    version,
  };
  mkdirSync(stateDir, { recursive: true });
  const tmp = join(stateDir, `.daemon.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(content) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return { ok: true, path, content };
}

/** Releases the lock, but only while it is still *ours*: a daemon that lost a race (or was
 *  superseded after a stale takeover) must not delete the new holder's lock on its way out.
 *  Returns whether a lock was removed. */
export function releaseDaemonLock(stateDir: string, deps: DaemonLockDeps = {}): boolean {
  const existing = readDaemonLock(stateDir);
  if (existing.state !== "held") return false;
  const self = selfIdentity(deps);
  if (existing.content.pid !== self.pid) return false;
  if (existing.content.startTime !== undefined && existing.content.startTime !== self.startTime) return false;
  rmSync(daemonLockPath(stateDir), { force: true });
  return true;
}

export interface DaemonLockStatus {
  present: boolean;
  /** Someone holds it right now (pid alive and start time matches, or unreadable). */
  held: boolean;
  /** Present but pointing at a process that is gone — the next start replaces it. */
  stale: boolean;
  pid: number | null;
  startedAt: number | null;
  version: string | null;
  path: string;
}

export function daemonLockStatus(stateDir: string, deps: DaemonLockDeps = {}): DaemonLockStatus {
  const path = daemonLockPath(stateDir);
  const existing = readDaemonLock(stateDir);
  if (existing.state === "absent") return { present: false, held: false, stale: false, pid: null, startedAt: null, version: null, path };
  if (existing.state === "unreadable") {
    return { present: true, held: true, stale: false, pid: null, startedAt: null, version: null, path };
  }
  const held = daemonLockHeld(existing.content, deps);
  return {
    present: true,
    held,
    stale: !held,
    pid: existing.content.pid,
    startedAt: existing.content.startedAt || null,
    version: existing.content.version,
    path,
  };
}
