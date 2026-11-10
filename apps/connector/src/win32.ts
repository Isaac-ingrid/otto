// Windows process introspection, the counterpart of the `ps`/`/proc` reads the connector uses
// on macOS and Linux. There is no portable API for "list the process table with parentage" in
// Node, so this asks the OS the only way that is still supported on current Windows: a CIM
// query through PowerShell (`Get-CimInstance Win32_Process`; wmic was removed in Windows 11
// 24H2). Everything the connector needs — parentage (orphan snapshots), creation time (pid
// reuse), cumulative CPU (stall watchdog) and the command line (session holders) — comes from
// one query, so a single cache serves all four callers.
//
// The query is comparatively expensive (~0.5–1.5 s), hence the short shared cache: a worker
// snapshot loop plus a lock check must not each pay for their own table. Failure degrades to
// "no data" exactly like a missing `ps`: never a wrong kill, never a false stall.
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One row of the Win32_Process table, normalized. */
export interface Win32Row {
  pid: number;
  ppid: number;
  /** ISO-8601 UTC creation time — the pid-reuse identity, matching the `ps lstart=` role. */
  created?: string;
  /** Cumulative CPU (user + kernel) in milliseconds. */
  cpuMs?: number;
  commandLine?: string;
}

export interface Win32Deps {
  platform?: NodeJS.Platform;
  /** Async runner (execFile shape); injectable for tests. */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  /** Sync runner (spawnSync shape); injectable for tests. */
  execSync?: (file: string, args: string[]) => { stdout: string };
  now?: () => number;
  /** How long a table stays fresh. Default 1000 ms. */
  cacheMs?: number;
}

/** PowerShell hosts to try, in order: Windows PowerShell always exists; pwsh may not. */
const SHELLS = ["powershell.exe", "pwsh"];

/** The CIM projection. CreationDate is coerced to ISO in the query so the JSON never depends
 *  on how ConvertTo-Json would serialize a DateTime; CPU is converted from 100 ns ticks. */
export function win32Script(commandLine: boolean): string {
  const created =
    "@{n='Created';e={try{([datetime]$_.CreationDate).ToUniversalTime().ToString('o')}catch{''}}}";
  const cpu =
    "@{n='CpuMs';e={try{[math]::Round(([double]$_.UserModeTime+[double]$_.KernelModeTime)/10000,1)}catch{''}}}";
  const extra = commandLine ? ",CommandLine" : "";
  return (
    "Get-CimInstance Win32_Process | " +
    `Select-Object ProcessId,ParentProcessId,${created},${cpu}${extra} | ` +
    "ConvertTo-Json -Compress"
  );
}

/** Parses ConvertTo-Json output (one object for a single row, an array otherwise). Rows that
 *  do not carry a usable pid are dropped; a document that is not JSON throws. */
export function parseWin32Table(text: string): Win32Row[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parsed: unknown = JSON.parse(trimmed);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const rows: Win32Row[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const pid = Number(raw.ProcessId);
    const ppid = Number(raw.ParentProcessId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const created = typeof raw.Created === "string" && raw.Created !== "" ? raw.Created : undefined;
    // An unreadable sample (the query's `catch` prints "") must be absent, not zero: a zero
    // CPU reading is a positive claim the stall watchdog would act on.
    const cpuRaw = raw.CpuMs;
    const cpuMs =
      typeof cpuRaw === "number" ? cpuRaw : typeof cpuRaw === "string" && cpuRaw.trim() !== "" ? Number(cpuRaw) : Number.NaN;
    rows.push({
      pid,
      ppid: Number.isFinite(ppid) ? ppid : 0,
      ...(created ? { created } : {}),
      ...(Number.isFinite(cpuMs) ? { cpuMs } : {}),
      ...(typeof raw.CommandLine === "string" ? { commandLine: raw.CommandLine } : {}),
    });
  }
  return rows;
}

interface CacheEntry {
  at: number;
  rows: Win32Row[];
}

/** Light and full tables are cached separately: the command line is only needed for the
 *  session-holder check, and asking for it costs ~an order of magnitude more bytes. */
const caches = { light: null as CacheEntry | null, full: null as CacheEntry | null };
let workingShell: string | null = null;

/** Test support: drop the table and shell caches. */
export function resetWin32Cache(): void {
  caches.light = null;
  caches.full = null;
  workingShell = null;
}

function isWin32(deps: Win32Deps): boolean {
  return (deps.platform ?? process.platform) === "win32";
}

function fresh(entry: CacheEntry | null, deps: Win32Deps): boolean {
  if (!entry) return false;
  return (deps.now ?? Date.now)() - entry.at < (deps.cacheMs ?? 1000);
}

function shells(deps: Win32Deps): string[] {
  return workingShell ? [workingShell, ...SHELLS.filter((s) => s !== workingShell)] : SHELLS;
}

/** The process table, async. [] on any failure (unreadable, no PowerShell, non-Windows). */
export async function win32Table(deps: Win32Deps = {}, opts: { commandLine?: boolean } = {}): Promise<Win32Row[]> {
  if (!isWin32(deps)) return [];
  const key = opts.commandLine ? "full" : "light";
  const cached = caches[key];
  if (fresh(cached, deps)) return cached!.rows;
  const script = win32Script(opts.commandLine === true);
  const run = deps.exec ?? ((file, args) => execFileAsync(file, args, { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }));
  for (const shell of shells(deps)) {
    try {
      const { stdout } = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script]);
      const rows = parseWin32Table(String(stdout));
      workingShell = shell;
      caches[key] = { at: (deps.now ?? Date.now)(), rows };
      return rows;
    } catch {
      // try the next shell; a shell that fails entirely leaves the cache untouched
    }
  }
  return [];
}

/** The process table, sync — for callers that cannot await (the lock identity check). */
export function win32TableSync(deps: Win32Deps = {}, opts: { commandLine?: boolean } = {}): Win32Row[] {
  if (!isWin32(deps)) return [];
  const key = opts.commandLine ? "full" : "light";
  const cached = caches[key];
  if (fresh(cached, deps)) return cached!.rows;
  const script = win32Script(opts.commandLine === true);
  const run =
    deps.execSync ??
    ((file: string, args: string[]) =>
      spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }));
  for (const shell of shells(deps)) {
    const res = run(shell, ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (typeof res?.stdout !== "string" || res.stdout.trim() === "") continue;
    try {
      const rows = parseWin32Table(res.stdout);
      workingShell = shell;
      caches[key] = { at: (deps.now ?? Date.now)(), rows };
      return rows;
    } catch {
      // malformed output: try the next shell
    }
  }
  return [];
}

/** Creation time of one process, or undefined when the table cannot be read or lacks the pid. */
export function win32ProcessCreated(pid: number, deps: Win32Deps = {}): string | undefined {
  return win32TableSync(deps).find((row) => row.pid === pid)?.created;
}
