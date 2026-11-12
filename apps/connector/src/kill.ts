// Process termination, connector-pi.md §9.3 / §4.4. On POSIX one signal reaches the process;
// on Windows `process.kill` maps to TerminateProcess and only ever ends the process itself —
// pi's `bash` tool children would survive as orphans, so the tree has to be ended explicitly
// (`taskkill /T`, which walks the parent chain and is the only tree facility shipped with the
// OS). Both paths are force-terminate: the polite phases (closing stdin, a first grace period)
// are owned by callers, and a Windows console child has no window to receive WM_CLOSE anyway.

import { spawnSync } from "node:child_process";

export interface KillDeps {
  platform?: NodeJS.Platform;
  /** Runs taskkill and returns its exit code (null when it could not run). Injectable for tests. */
  taskkill?: (pid: number, force: boolean) => number | null;
}

function taskkillSync(pid: number, force: boolean): number | null {
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  try {
    const res = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    return res.status;
  } catch {
    return null;
  }
}

/** Ends `pid` (and, on Windows, its whole tree). An already-exited process is harmless;
 *  unexpected signal errors still propagate. pid 0/1/4 are never signalled. */
export function terminateProcess(pid: number, signal: NodeJS.Signals = "SIGTERM", deps: KillDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  if (!Number.isFinite(pid) || pid <= (platform === "win32" ? 4 : 1) || pid === process.pid) return;
  if (platform === "win32") {
    (deps.taskkill ?? taskkillSync)(pid, signal === "SIGKILL");
    return;
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    // The process can exit between a liveness check and this signal.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** True for a platform where a single signal does not reach descendants. */
export function killNeedsTree(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}
