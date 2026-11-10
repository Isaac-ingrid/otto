// Launch resolution for an agent CLI (pi, claude) on native Windows. On POSIX the connector
// spawns the bare `pi` name and the kernel resolves it through PATH. Windows cannot do that
// twice over: npm-style installers put a `pi.cmd` batch shim on PATH, and Node refuses to
// spawn a `.cmd`/`.bat` without a shell (CVE-2024-27980 hardening), while spawning it *through*
// cmd.exe would re-quote our argv (probe/session paths, extension paths) and is the fragile
// path. So on Windows we resolve what the shim would have run — the real JavaScript entry —
// and spawn it with the connector's own node, keeping `stdio` pipes and argv byte-exact.
//
// Resolution is deliberately conservative: it only rewrites a single bare command name (the
// default `["pi"]`), never a path or an explicit argv prefix (tests, OTTO_PI_COMMAND).
import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** How the final argv was obtained; logged and surfaced by `otto doctor`. */
export type LaunchSource = "as-is" | "windows-node-entry" | "windows-exe" | "windows-shell";

export interface LaunchResolution {
  /** The argv prefix PiProcess should spawn (its own args are appended after this). */
  argv: string[];
  source: LaunchSource;
  /** The resolved file/command, for diagnostics. */
  detail?: string;
}

export interface LaunchDeps {
  platform?: NodeJS.Platform;
  /** node used to run a resolved JS entry; default process.execPath. */
  nodePath?: string;
  /** Shell used only for the last-resort shim fallback; default %ComSpec%. */
  comspec?: string;
  env?: Record<string, string | undefined>;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

/** Environment variable holding an explicit argv prefix (whitespace-separated, double quotes
 *  honoured). It is the escape hatch for installs that are not on PATH; the connector never
 *  passes OTTO_* variables down to the agent child, so it cannot leak into a worker. */
export const PI_COMMAND_ENV = "OTTO_PI_COMMAND";

/** Splits an OTTO_PI_COMMAND value into argv, honouring double quotes around one argument. */
export function splitCommandLine(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/** The argv prefix from OTTO_PI_COMMAND, or undefined when unset/blank. */
export function piCommandFromEnv(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env[PI_COMMAND_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const argv = splitCommandLine(raw).filter((part) => part.length > 0);
  return argv.length > 0 ? argv : undefined;
}

/** Windows executable search: every PATH directory that holds `<name><ext>` for one of the
 *  candidate extensions, in the order the extension list gives. No subprocess — a shim lookup
 *  must not cost a `where.exe` spawn on every doctor/launch. */
export function whichWindows(name: string, deps: LaunchDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const exists = deps.fileExists ?? existsSync;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // npm/pnpm/pi-installer shims are .cmd (and .ps1 for PowerShell); a native build is .exe.
  // .cmd first because it is the one we can read the real JS entry out of; the resolver below
  // still prefers a native .exe, which needs no shim reading at all.
  const ordered = [".cmd", ".exe", ...extensions.map((e) => e.toLowerCase()).filter((e) => e !== ".cmd" && e !== ".exe")];
  const found: string[] = [];
  for (const dir of pathValue.split(";").filter(Boolean)) {
    const clean = dir.replace(/^"|"$/g, "");
    for (const ext of [...ordered, ""]) {
      const candidate = join(clean, `${name}${ext}`);
      if (!found.includes(candidate) && exists(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** The `%~dp0` / `%dp0%` / `$basedir` root prefix a shim uses to locate its payload. */
const SHIM_ROOT = /^(?:%~?dp0%?|\$\{?basedir\}?)[\\/]?/i;

/** Resolves the real JavaScript entry a shim would run, or null when there is none (a native
 *  binary, an unreadable shim, or a target that does not exist on this machine). */
export function jsEntryFromShim(shimPath: string, deps: LaunchDeps = {}): string | null {
  const exists = deps.fileExists ?? existsSync;
  if (/\.(js|mjs|cjs)$/i.test(shimPath)) return exists(shimPath) ? shimPath : null;
  if (!exists(shimPath)) return null;

  let text: string;
  try {
    text = (deps.readFile ?? ((path: string) => readFileSync(path, "utf8")))(shimPath);
  } catch {
    return null;
  }
  const dir = dirname(shimPath);
  // Every quoted token that ends in a JS extension: npm's cmd-shim (`"%dp0%\node_modules\…"`),
  // pi's installer (`"%~dp0pi-launcher.js"`), and the POSIX sh shim (`"$basedir/pi-launcher.js"`).
  for (const match of text.matchAll(/"([^"\r\n]*?\.(?:js|mjs|cjs))"/gi)) {
    const token = match[1]!.trim();
    const rootless = token.replace(SHIM_ROOT, "");
    const full = isAbsolute(rootless) ? rootless : join(dir, rootless);
    if (exists(full)) return full;
  }
  return null;
}

/**
 * Turns a bare command name into an argv that Windows can actually spawn. Everything else —
 * an explicit argv prefix, a path, an `.exe` — is returned untouched, so tests and
 * OTTO_PI_COMMAND keep full control.
 */
export function resolveExecutableLaunch(command: string[], deps: LaunchDeps = {}): LaunchResolution {
  const name = command.length === 1 ? command[0] : undefined;
  if (!name || /[\\/]/.test(name) || /\.(js|mjs|cjs|exe|cmd|bat|ps1)$/i.test(name)) {
    return { argv: command, source: "as-is" };
  }
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { argv: command, source: "as-is" };

  const nodePath = deps.nodePath ?? process.execPath;
  const candidates = whichWindows(name, deps);

  // A native standalone build: spawn it directly, argv byte-exact, no shell.
  for (const candidate of candidates) {
    if (/\.exe$/i.test(candidate)) return { argv: [candidate], source: "windows-exe", detail: candidate };
  }
  // The normal npm/pi-installer shape: read the real JS entry out of the shim and run it with
  // our own node (>=22.18 is already enforced for the connector, so the entry always loads).
  for (const candidate of candidates) {
    const entry = jsEntryFromShim(candidate, deps);
    if (entry) return { argv: [nodePath, entry], source: "windows-node-entry", detail: entry };
  }
  // Last resort: let cmd.exe run the shim. Our argv travels as one command line, so arguments
  // containing cmd metacharacters are a known risk — hence the preference order above.
  const shim = candidates.find((candidate) => /\.(cmd|bat)$/i.test(candidate)) ?? candidates[0];
  if (shim) {
    const comspec = deps.comspec ?? (deps.env ?? process.env).ComSpec ?? "cmd.exe";
    return { argv: [comspec, "/d", "/s", "/c", shim], source: "windows-shell", detail: shim };
  }
  return { argv: command, source: "as-is" };
}
