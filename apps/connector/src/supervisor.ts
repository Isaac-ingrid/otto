// Restart-on-failure for the platforms whose service manager cannot do it (ADR-0018 decision 12,
// phase 2 step 3). launchd (`KeepAlive`) and systemd (`Restart=on-failure`) bring a crashed daemon
// back on their own; the Windows logon launcher is a Run value, which has no such notion, so the
// process that the launcher starts is a supervisor that owns the daemon lock and restarts the
// daemon behind it. It is platform-independent on purpose — `otto daemon --supervise` also gives a
// container or a foreground dev box the same behaviour.
//
// Two invariants matter more than the restart policy itself:
//
//   1. The lock belongs to the supervisor, because the supervisor is what stays alive (decision 10's
//      identity discipline is pid + start time, and the pid in the lock is what `otto stop` and
//      `otto status` act on). The supervised child therefore must NOT take the lock, and it proves
//      it is legitimate rather than trusting an environment variable (authorizeSupervisedChild).
//   2. A restart must never be the reason a stop does not take. Every wait races the stop request,
//      and stopping kills the child before the supervisor exits.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonLockStatus, type DaemonLockStatus } from "./daemon-lock.ts";

/** Set by the supervisor for its child; the value is the supervisor's pid. */
export const SUPERVISOR_ENV = "OTTO_SUPERVISED_BY";

/** The supervisor's own state, in the state-dir root next to `daemon.lock`. It exists so
 *  `otto status` can name the child: the lock only knows the supervisor. */
export const SUPERVISOR_FILE = "supervisor.json";

/** Backoff between restarts, indexed by consecutive failed runs (capped at the last entry). */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

/** A child that stayed up this long was not crash-looping, so the backoff starts over. */
export const HEALTHY_RUN_MS = 60_000;

/** How long a stopping supervisor waits for the child to honour SIGTERM before leaving it. */
export const STOP_GRACE_MS = 5_000;

export function backoffFor(restarts: number, table: readonly number[] = BACKOFF_MS): number {
  const index = Math.min(Math.max(Math.trunc(restarts), 1), table.length) - 1;
  return table[index]!;
}

export interface SupervisedChild {
  pid?: number;
  /** Resolves once the child is gone. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal: NodeJS.Signals): void;
}

export interface SupervisorDeps {
  /** Starts one daemon process (the CLI owns executable, argv, environment and stdio). */
  spawnChild: () => SupervisedChild;
  /** Resolves when the operator asked this supervisor to stop (CLI: SIGTERM/SIGINT). */
  stopped: Promise<void>;
  /** Synchronous view of the same thing, for a stop that arrived during a spawn. */
  isStopping?: () => boolean;
  log: (line: string) => void;
  /** Called after every state change, so the caller can persist what `otto status` reads. */
  onChild?: (childPid: number | null, restarts: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  healthyMs?: number;
  backoff?: readonly number[];
  stopGraceMs?: number;
  /** Stop supervising after this many consecutive restarts (tests; production never gives up:
   *  a hidden autostart has nobody to tell, and a machine at the logon screen has no operator). */
  maxRestarts?: number;
}

export interface SupervisorOutcome {
  restarts: number;
  reason: "stopped" | "gave-up";
}

/** Runs the child, restarts it with backoff while it keeps dying, and returns once a stop was
 *  requested (or the optional restart budget ran out). Never throws for a child that fails. */
export async function supervise(deps: SupervisorDeps): Promise<SupervisorOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const healthyMs = deps.healthyMs ?? HEALTHY_RUN_MS;
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  let restarts = 0;

  for (;;) {
    const child = deps.spawnChild();
    deps.onChild?.(child.pid ?? null, restarts);
    deps.log(`child pid ${child.pid ?? "unknown"} started`);
    const startedAt = now();

    const outcome = await Promise.race([
      child.exited.then((exit) => ({ kind: "exit" as const, exit })),
      deps.stopped.then(() => ({ kind: "stop" as const })),
    ]);

    if (outcome.kind === "stop" || deps.isStopping?.()) {
      // Polite first, then gone: a child that ignores SIGTERM is for `otto stop`/taskkill to deal
      // with, and a supervisor that waits on it forever would keep the state directory claimed.
      child.kill("SIGTERM");
      await Promise.race([child.exited, sleep(stopGraceMs)]);
      deps.onChild?.(null, restarts);
      deps.log("stopped on request");
      return { restarts, reason: "stopped" };
    }

    const ranMs = now() - startedAt;
    deps.log(
      `child pid ${child.pid ?? "unknown"} exited after ${ranMs}ms ` +
        `(code ${outcome.exit.code ?? "none"}, signal ${outcome.exit.signal ?? "none"})`,
    );
    if (ranMs >= healthyMs) restarts = 0;
    restarts += 1;
    if (deps.maxRestarts !== undefined && restarts > deps.maxRestarts) {
      deps.log(`giving up after ${restarts - 1} restarts`);
      deps.onChild?.(null, restarts - 1);
      return { restarts: restarts - 1, reason: "gave-up" };
    }
    const delay = backoffFor(restarts, deps.backoff ?? BACKOFF_MS);
    deps.log(`restart ${restarts} in ${delay}ms`);
    const raced = await Promise.race([
      deps.stopped.then(() => "stop" as const),
      sleep(delay).then(() => "slept" as const),
    ]);
    if (raced === "stop" || deps.isStopping?.()) {
      deps.onChild?.(null, restarts);
      deps.log("stopped while waiting to restart");
      return { restarts, reason: "stopped" };
    }
  }
}

export interface SupervisorState {
  supervisorPid: number;
  /** The daemon's pid, or null while it is between restarts. */
  childPid: number | null;
  restarts: number;
  startedAt: number;
  updatedAt: number;
}

export function supervisorStatePath(stateDir: string): string {
  return join(stateDir, SUPERVISOR_FILE);
}

export function writeSupervisorState(
  stateDir: string,
  state: Omit<SupervisorState, "updatedAt"> & { updatedAt?: number },
): void {
  const payload: SupervisorState = { ...state, updatedAt: state.updatedAt ?? Date.now() };
  try {
    const path = supervisorStatePath(stateDir);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // `otto status` losing a nicety must never take the daemon down.
  }
}

/** The state file, or null when it is absent, unreadable or not the shape we wrote (a stale file
 *  from a killed supervisor is expected and must not throw). */
export function readSupervisorState(stateDir: string): SupervisorState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(supervisorStatePath(stateDir), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const state = parsed as Partial<SupervisorState>;
    if (!Number.isInteger(state.supervisorPid)) return null;
    return {
      supervisorPid: state.supervisorPid as number,
      childPid: Number.isInteger(state.childPid) ? (state.childPid as number) : null,
      restarts: Number.isInteger(state.restarts) ? (state.restarts as number) : 0,
      startedAt: Number.isFinite(state.startedAt) ? (state.startedAt as number) : 0,
      updatedAt: Number.isFinite(state.updatedAt) ? (state.updatedAt as number) : 0,
    };
  } catch {
    return null;
  }
}

export function clearSupervisorState(stateDir: string): void {
  try {
    rmSync(supervisorStatePath(stateDir), { force: true });
  } catch {
    // Same as writeSupervisorState: best-effort.
  }
}

export interface ChildAuthorisation {
  ok: boolean;
  reason?: string;
}

export interface ChildAuthorisationDeps {
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  lockStatus?: (stateDir: string) => DaemonLockStatus;
}

/** Whether this process really is the child of the supervisor that owns the state directory.
 *  An environment variable alone would be a footgun: anything could set it, and a second daemon
 *  sharing one `~/.otto` is exactly what the lock exists to prevent. So the child has to prove
 *  three things — that it was told to be supervised, that the named supervisor is its parent, and
 *  that this parent holds the lock — and fails closed when any of them is missing. */
export function authorizeSupervisedChild(
  stateDir: string,
  deps: ChildAuthorisationDeps = {},
): ChildAuthorisation {
  const env = deps.env ?? process.env;
  const raw = env[SUPERVISOR_ENV];
  const supervisorPid = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) {
    return {
      ok: false,
      reason:
        `${SUPERVISOR_ENV} is not a pid — start the daemon with \`otto daemon\` (or, to be ` +
        `supervised, \`otto daemon --supervise\`, which is what the service and the Windows ` +
        `logon launcher do)`,
    };
  }
  const ppid = deps.ppid ?? process.ppid;
  if (ppid !== supervisorPid) {
    return {
      ok: false,
      reason:
        `this process was told it is supervised by pid ${supervisorPid}, but its parent is ` +
        `pid ${ppid} — refusing to run a daemon that does not match the process holding ` +
        `the state directory`,
    };
  }
  const lock = (deps.lockStatus ?? ((dir: string) => daemonLockStatus(dir)))(stateDir);
  if (!lock.held || lock.pid !== supervisorPid) {
    return {
      ok: false,
      reason:
        `the supervisor (pid ${supervisorPid}) does not hold the state directory lock ` +
        `(${lock.held ? `held by pid ${lock.pid ?? "an unreadable owner"}` : "no lock"}) — ` +
        `refusing to run a second daemon over the same state directory`,
    };
  }
  return { ok: true };
}
