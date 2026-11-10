// Supervisor (ADR-0018 decision 12): the restart policy, and the proof a supervised child has to
// give before it runs without taking the lock. The CLI owns the process itself (spawn, signals,
// log file), so what is asserted here is the loop's decisions with an injected world.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonLockStatus } from "../src/daemon-lock.ts";
import {
  authorizeSupervisedChild,
  backoffFor,
  clearSupervisorState,
  readSupervisorState,
  supervise,
  supervisorStatePath,
  SUPERVISOR_ENV,
  writeSupervisorState,
  type SupervisedChild,
} from "../src/supervisor.ts";

interface FakeChild extends SupervisedChild {
  killed: NodeJS.Signals[];
  /** Ends the child as if it crashed, after (optionally) advancing the fake clock. */
  die(code?: number | null, runMs?: number): void;
}

function harness() {
  let clock = 1_000;
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const spawn = (runMs: number): FakeChild => {
    let resolveExit!: (exit: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      resolveExit = resolve;
    });
    const child: FakeChild = {
      pid: 400 + children.length,
      exited,
      killed: [],
      kill(signal) {
        child.killed.push(signal);
        resolveExit({ code: null, signal });
      },
      die(code = 1, ms = runMs) {
        clock += ms;
        resolveExit({ code, signal: null });
      },
    };
    children.push(child);
    return child;
  };
  return { spawn, children, logs, now: () => clock };
}

function lockStatus(overrides: Partial<DaemonLockStatus> = {}): DaemonLockStatus {
  return {
    present: true,
    held: true,
    stale: false,
    pid: 1234,
    startedAt: Date.now(),
    version: "0.2.0",
    path: "C:\\Users\\x\\.otto\\daemon.lock",
    ...overrides,
  };
}

describe("supervisor backoff", () => {
  it("grows with consecutive restarts and stops growing at the cap", () => {
    expect(backoffFor(1)).toBe(1_000);
    expect(backoffFor(2)).toBe(2_000);
    expect(backoffFor(6)).toBe(60_000);
    expect(backoffFor(9)).toBe(60_000);
    expect(backoffFor(0)).toBe(1_000);
  });
});

describe("supervise", () => {
  it("restarts a child that keeps dying, and logs each restart", async () => {
    const h = harness();
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const run = supervise({
      spawnChild: () => {
        const child = h.spawn(5);
        // Each child dies on the next microtask, so the loop reaches the restart budget by itself.
        queueMicrotask(() => child.die(1));
        return child;
      },
      stopped,
      log: (line) => h.logs.push(line),
      sleep: async () => undefined,
      now: h.now,
      maxRestarts: 2,
    });
    const outcome = await run;
    expect(outcome).toEqual({ restarts: 2, reason: "gave-up" });
    expect(h.children).toHaveLength(3);
    expect(h.logs.filter((l) => l.startsWith("restart "))).toEqual([
      "restart 1 in 1000ms",
      "restart 2 in 2000ms",
    ]);
    expect(h.logs.at(-1)).toBe("giving up after 2 restarts");
    stop();
  });

  it("resets the backoff after a run long enough to count as healthy", async () => {
    const h = harness();
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const run = supervise({
      spawnChild: () => {
        const child = h.spawn(h.children.length === 0 ? 10 : 5_000);
        queueMicrotask(() => child.die(1));
        if (h.children.length >= 2) queueMicrotask(() => stop());
        return child;
      },
      stopped,
      log: (line) => h.logs.push(line),
      sleep: async () => undefined,
      now: h.now,
      healthyMs: 1_000,
    });
    const outcome = await run;
    expect(outcome).toEqual({ restarts: 1, reason: "stopped" });
    expect(h.children).toHaveLength(2);
    // The first (10ms) run is a crash; the second (5s) is healthy, so the next backoff starts over.
    expect(h.logs.filter((l) => l.startsWith("restart "))).toEqual([
      "restart 1 in 1000ms",
      "restart 1 in 1000ms",
    ]);
  });

  it("kills a running child when a stop is requested", async () => {
    const h = harness();
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const run = supervise({
      spawnChild: () => {
        const child = h.spawn(0);
        queueMicrotask(() => stop());
        return child;
      },
      stopped,
      log: (line) => h.logs.push(line),
      now: h.now,
    });
    const outcome = await run;
    expect(outcome).toEqual({ restarts: 0, reason: "stopped" });
    expect(h.children).toHaveLength(1);
    expect(h.children[0]!.killed).toEqual(["SIGTERM"]);
    expect(h.logs.at(-1)).toBe("stopped on request");
  });

  it("does not start another child when the stop lands during the backoff wait", async () => {
    const h = harness();
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const run = supervise({
      spawnChild: () => {
        const child = h.spawn(10);
        queueMicrotask(() => {
          child.die(1);
          // The stop arrives while the loop is sleeping between restarts.
          queueMicrotask(() => stop());
        });
        return child;
      },
      stopped,
      log: (line) => h.logs.push(line),
      sleep: () => new Promise<void>(() => undefined),
      now: h.now,
    });
    const outcome = await run;
    expect(outcome).toEqual({ restarts: 1, reason: "stopped" });
    expect(h.children).toHaveLength(1);
    expect(h.logs.at(-1)).toBe("stopped while waiting to restart");
  });

  it("reports the child to its caller, so `otto status` can name it", async () => {
    const h = harness();
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const seen: Array<[number | null, number]> = [];
    const run = supervise({
      spawnChild: () => {
        const child = h.spawn(0);
        queueMicrotask(() => stop());
        return child;
      },
      stopped,
      log: () => undefined,
      now: h.now,
      onChild: (pid, restarts) => seen.push([pid, restarts]),
    });
    await run;
    expect(seen).toEqual([
      [400, 0],
      [null, 0],
    ]);
  });
});

describe("supervisor state file", () => {
  it("round-trips and clears", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-supervisor-"));
    writeSupervisorState(dir, { supervisorPid: 1, childPid: 2, restarts: 3, startedAt: 4 });
    const state = readSupervisorState(dir);
    expect(state).toMatchObject({ supervisorPid: 1, childPid: 2, restarts: 3, startedAt: 4 });
    expect(state!.updatedAt).toBeGreaterThan(0);
    expect(readFileSync(supervisorStatePath(dir), "utf8").endsWith("\n")).toBe(true);
    clearSupervisorState(dir);
    expect(readSupervisorState(dir)).toBeNull();
  });

  it("returns null for a missing, corrupt or foreign file instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-supervisor-"));
    expect(readSupervisorState(dir)).toBeNull();
    writeFileSync(supervisorStatePath(dir), "{not json");
    expect(readSupervisorState(dir)).toBeNull();
    writeFileSync(supervisorStatePath(dir), JSON.stringify({ supervisorPid: "mine" }));
    expect(readSupervisorState(dir)).toBeNull();
  });
});

describe("authorizeSupervisedChild", () => {
  const env = { [SUPERVISOR_ENV]: "1234" };

  it("accepts a child whose parent holds the lock", () => {
    expect(
      authorizeSupervisedChild("dir", { env, ppid: 1234, lockStatus: () => lockStatus() }),
    ).toEqual({ ok: true });
  });

  it("refuses without a pid in the environment", () => {
    const result = authorizeSupervisedChild("dir", { env: {}, ppid: 1234, lockStatus: () => lockStatus() });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(SUPERVISOR_ENV);
    expect(authorizeSupervisedChild("dir", { env: { [SUPERVISOR_ENV]: "nobody" }, ppid: 1 }).ok).toBe(false);
  });

  it("refuses when the named supervisor is not the parent", () => {
    const result = authorizeSupervisedChild("dir", { env, ppid: 99, lockStatus: () => lockStatus() });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("its parent is pid 99");
  });

  it("refuses when the supervisor does not hold the lock, or holds it elsewhere", () => {
    const none = authorizeSupervisedChild("dir", {
      env,
      ppid: 1234,
      lockStatus: () => lockStatus({ present: false, held: false, pid: null }),
    });
    expect(none.ok).toBe(false);
    expect(none.reason).toContain("no lock");
    const other = authorizeSupervisedChild("dir", {
      env,
      ppid: 1234,
      lockStatus: () => lockStatus({ pid: 4321 }),
    });
    expect(other.ok).toBe(false);
    expect(other.reason).toContain("held by pid 4321");
    const unreadable = authorizeSupervisedChild("dir", {
      env,
      ppid: 1234,
      lockStatus: () => lockStatus({ pid: null }),
    });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.reason).toContain("unreadable owner");
  });
});
