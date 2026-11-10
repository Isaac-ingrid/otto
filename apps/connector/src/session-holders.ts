// Session-holder detection, connector-pi.md §10 / §4.3: before relaunching a session the
// connector checks (best effort) whether another live pi process is already using it. Two
// sources are consulted:
//
//  - process arguments (`ps` on macOS, `/proc/<pid>/cmdline` on Linux): `--session-id <id>`,
//    `--session <path|id-prefix>`, or a positional session file path. pi itself rewrites its
//    process title to `pi`/`pi-rpc` (libuv replaces the visible argv), which hides the
//    session arguments of a *retitled* process — so a pi-looking process with no readable
//    session reference is NOT treated as a holder, and `--continue`/`--resume` invocations
//    (which name no session in argv at all) are inherently invisible to this check.
//  - the §4.3 lock file already names our own tracked processes; callers exclude them.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pidAlive } from "./locks.ts";
import { win32Table, type Win32Deps, type Win32Row } from "./win32.ts";

const exec = promisify(execFile);
const psTimeout = { timeout: 5000 };

export type ProcessArgumentsSource = "linux-procfs" | "ps" | "win32-cim";

/** Parses `ps -axo pid=,args=` style output into pid + argument lines. */
export function parseProcessArguments(output: string): Array<{ pid: number; args: string }> {
  const rows: Array<{ pid: number; args: string }> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), args: match[2]!.trim() });
  }
  return rows;
}

/** Splits an argument line into tokens, keeping quoted runs (a Windows path with spaces) whole
 *  and dropping the quotes. A bare split on whitespace would cut `"C:\Program Files\…"` in
 *  half, so the session path it names would never compare equal. */
export function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let inToken = false;
  for (const ch of args) {
    if (ch === '"') {
      quoted = !quoted;
      inToken = true; // "" is still an argument, just an empty one
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    inToken = true;
    current += ch;
  }
  if (inToken) tokens.push(current);
  return tokens.filter((token) => token.length > 0);
}

/** The executable name in one token: `pi`, `pi.exe`, `/usr/bin/pi` and `C:\\bin\\pi.exe` all
 *  reduce to `pi`, so the viewer denylist matches regardless of how the process was started. */
export function commandBasename(token: string): string {
  const name = token.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.(exe|com|cmd|bat|ps1)$/i, "");
}

export interface ProcessArgumentsDeps {
  platform?: NodeJS.Platform;
  /** Win32 table seam (tests inject a canned process table). */
  win32Table?: (deps?: Win32Deps, opts?: { commandLine?: boolean }) => Promise<Win32Row[]>;
  win32Deps?: Win32Deps;
  /** Aliveness seam; default pidAlive. Injectable so the Windows branch is testable off-Windows. */
  alive?: (pid: number) => boolean;
}

/** The whole process table's argument lines; [] when nothing could be read. */
export async function listProcessArguments(deps: ProcessArgumentsDeps = {}): Promise<{
  source: ProcessArgumentsSource;
  processes: Array<{ pid: number; args: string }>;
}> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    // The CIM query is the only supported way to read another process's command line on
    // current Windows; a failure yields [] and the check degrades to "no holder found".
    const rows = await (deps.win32Table ?? win32Table)(deps.win32Deps ?? {}, { commandLine: true });
    const processes = rows
      .filter((row): row is Win32Row & { commandLine: string } => typeof row.commandLine === "string" && row.commandLine.length > 0)
      .map((row) => ({ pid: row.pid, args: row.commandLine }));
    return { source: "win32-cim", processes };
  }
  if (platform === "linux") {
    try {
      const processes = await listProcfsArguments();
      if (processes.length > 0) return { source: "linux-procfs", processes };
    } catch {
      // fall through to ps
    }
  }
  try {
    const { stdout } = await exec("ps", ["-axo", "pid=,args="], psTimeout);
    return { source: "ps", processes: parseProcessArguments(stdout) };
  } catch {
    return { source: "ps", processes: [] };
  }
}

async function listProcfsArguments(): Promise<Array<{ pid: number; args: string }>> {
  const { readdirSync, readFileSync } = await import("node:fs");
  const processes: Array<{ pid: number; args: string }> = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let args: string;
    try {
      args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    } catch {
      continue; // not ours to read, or already gone
    }
    if (args) processes.push({ pid: Number(name), args });
  }
  return processes;
}

/** Viewer commands whose appearance in `args` must not count as holding the session. */
const NON_SESSION_COMMANDS = new Set([
  "cat", "grep", "rg", "tail", "head", "less", "more", "vi", "vim", "nvim", "emacs", "nano", "bat", "code", "jq", "wc", "sed", "awk", "diff",
]);

export interface SessionHolder {
  pid: number;
  args: string;
}

/** Whether one process's arguments reference this session in a form that implies using it:
 *  `--session-id <id>`, `--session <path>`, `--session=<…>`, or a positional session path.
 *  Bare session *ids* match only as an explicit flag value; paths match as flag values or
 *  positional tokens (never as a bare id-like word in the middle of unrelated text). */
export function referencesSession(args: string, workerId: string, sessionFile: string): boolean {
  const tokens = tokenizeArgs(args);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--session-id") {
      const next = tokens[i + 1];
      if (next !== undefined && (next === workerId || next === sessionFile)) return true;
    } else if (token === "--session") {
      const next = tokens[i + 1];
      if (next !== undefined && (next === workerId || next === sessionFile)) return true;
      // pi matches a non-path --session value by id prefix; only a long, unambiguous prefix counts.
      if (
        next !== undefined && !next.includes("/") && !next.endsWith(".jsonl") &&
        workerId.length >= 8 && next.length >= 8 && workerId.startsWith(next)
      ) {
        return true;
      }
    } else if (token.startsWith("--session=")) {
      const value = token.slice("--session=".length);
      if (value === workerId || value === sessionFile) return true;
    } else if (token === sessionFile) {
      return true; // positional session path
    }
  }
  return false;
}

/**
 * Live processes, other than the excluded ones, whose arguments reference this session.
 * Best effort by design (§10): a miss never blocks a launch.
 */
export async function findSessionHolders(
  workerId: string,
  sessionFile: string | null | undefined,
  excludePids: number[] = [],
  deps: ProcessArgumentsDeps = {},
): Promise<SessionHolder[]> {
  if (!sessionFile) return [];
  const excluded = new Set(excludePids.filter((pid) => pid > 0));
  excluded.add(process.pid);
  const { processes } = await listProcessArguments(deps);
  const alive = deps.alive ?? pidAlive;
  const holders: SessionHolder[] = [];
  for (const proc of processes) {
    if (excluded.has(proc.pid) || !alive(proc.pid)) continue;
    if (!referencesSession(proc.args, workerId, sessionFile)) continue;
    const first = commandBasename(tokenizeArgs(proc.args)[0] ?? "");
    if (NON_SESSION_COMMANDS.has(first)) continue; // a viewer, not a session user
    if (proc.args.includes("fake-pi.mjs")) continue; // this repo's test double, never a session user
    holders.push({ pid: proc.pid, args: proc.args });
  }
  return holders;
}
