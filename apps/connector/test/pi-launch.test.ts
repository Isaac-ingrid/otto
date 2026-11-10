// Launch resolution (pi-launch.ts): the Windows branch must find the real JS entry behind an
// npm/pi-installer shim, and must never rewrite an explicit argv prefix. Everything is driven
// through injected deps so the whole matrix runs on Linux CI too.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PI_COMMAND_ENV,
  checkLaunchSpawnable,
  jsEntryFromShim,
  launchCheck,
  piCommandFromEnv,
  resolveExecutableLaunch,
  splitCommandLine,
  whichWindows,
  type LaunchDeps,
} from "../src/pi-launch.ts";

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const BIN = "C:\\tools";

/** A deps object that serves a fixed virtual filesystem. */
function fsDeps(files: Record<string, string>, env: Record<string, string> = {}): LaunchDeps {
  return {
    platform: "win32",
    nodePath: NODE,
    env: { PATH: BIN, ...env },
    fileExists: (path) => Object.hasOwn(files, path),
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
  };
}

describe("splitCommandLine / OTTO_PI_COMMAND", () => {
  it("splits on whitespace and keeps a quoted argument whole", () => {
    expect(splitCommandLine("pi")).toEqual(["pi"]);
    expect(splitCommandLine('"C:\\Program Files\\x\\pi.cmd" --flag')).toEqual(['C:\\Program Files\\x\\pi.cmd', "--flag"]);
    expect(splitCommandLine("  a   b  ")).toEqual(["a", "b"]);
  });

  it("reads the escape hatch from the environment, ignoring blank values", () => {
    expect(piCommandFromEnv({ [PI_COMMAND_ENV]: "pi --model x" })).toEqual(["pi", "--model", "x"]);
    expect(piCommandFromEnv({ [PI_COMMAND_ENV]: "   " })).toBeUndefined();
    expect(piCommandFromEnv({})).toBeUndefined();
  });
});

describe("resolveExecutableLaunch: what is left alone", () => {
  it("keeps a bare name on POSIX and never touches an explicit argv prefix", () => {
    expect(resolveExecutableLaunch(["pi"], { platform: "linux" })).toEqual({ argv: ["pi"], source: "as-is" });
    const explicit = [process.execPath, "/tmp/fake-pi.mjs"];
    expect(resolveExecutableLaunch(explicit, { platform: "win32" })).toEqual({ argv: explicit, source: "as-is" });
    // A command that already names a path or an extension is the caller's business.
    expect(resolveExecutableLaunch([".\\bin\\pi.cmd"], { platform: "win32" }).source).toBe("as-is");
    expect(resolveExecutableLaunch(["pi.exe"], { platform: "win32" }).source).toBe("as-is");
  });

  it("degrades to the bare name when nothing on PATH matches", () => {
    const deps = fsDeps({});
    expect(resolveExecutableLaunch(["pi"], deps)).toEqual({ argv: ["pi"], source: "as-is" });
  });
});

describe("resolveExecutableLaunch: Windows shim resolution", () => {
  const shim = join(BIN, "pi.cmd");
  const launcher = join(BIN, "pi-launcher.js");

  it("runs the JS entry a pi-installer shim points at, with the connector's own node", () => {
    // The real pi.cmd: `"%node%" "%~dp0pi-launcher.js" %*` — the token carries its own separator.
    const deps = fsDeps({ [shim]: '@ECHO off\nSET "node=node"\n"%node%" "%~dp0pi-launcher.js" %*\n', [launcher]: "//pi" });
    expect(resolveExecutableLaunch(["pi"], deps)).toEqual({ argv: [NODE, launcher], source: "windows-node-entry", detail: launcher });
  });

  it("reads the POSIX sh shim pi also installs, locating its payload through $basedir", () => {
    const bare = join(BIN, "pi");
    const deps = fsDeps({ [bare]: '#!/bin/sh\nbasedir=$(dirname "$0")\nexec "$node" "$basedir/pi-launcher.js" "$@"\n', [launcher]: "" });
    expect(resolveExecutableLaunch(["pi"], deps).argv).toEqual([NODE, launcher]);
  });

  it("reads an npm cmd-shim (%dp0%) and resolves its target relative to the shim", () => {
    const npmShim = join(BIN, "pi.cmd");
    const relative = "node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js";
    const entryPath = join(BIN, relative); // what the shim's `%dp0%\…` resolves to
    const deps = fsDeps({ [npmShim]: `@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\${relative}" %*\r\n`, [entryPath]: "" });
    expect(jsEntryFromShim(npmShim, deps)).toBe(entryPath);
    expect(resolveExecutableLaunch(["pi"], deps)).toEqual({ argv: [NODE, entryPath], source: "windows-node-entry", detail: entryPath });
  });

  it("prefers a native .exe over any shim", () => {
    const exe = join(BIN, "pi.exe");
    const deps = fsDeps({ [exe]: "", [join(BIN, "pi.cmd")]: '"%~dp0pi-launcher.js"', [launcher]: "" });
    expect(resolveExecutableLaunch(["pi"], deps)).toEqual({ argv: [exe], source: "windows-exe", detail: exe });
  });

  it("refuses a shim whose JS entry cannot be read, instead of handing argv to cmd.exe (§4.4)", () => {
    const cmd = join(BIN, "mystery.cmd");
    const deps = fsDeps({ [cmd]: "@echo off\nrem no js here\n" });
    const resolved = resolveExecutableLaunch(["mystery"], deps);
    expect(resolved.source).toBe("windows-unresolved");
    expect(resolved.detail).toBe(cmd);
    // argv stays the untouched command: the resolution is a diagnosis, not a launch.
    expect(resolved.argv).toEqual(["mystery"]);
    expect(resolved.error).toContain(cmd);
    expect(resolved.error).toContain(PI_COMMAND_ENV);
    // The verdict status/doctor print must carry that reason, not the argv probe's "on PATH".
    expect(launchCheck(resolved, deps)).toEqual({ ok: false, detail: resolved.error });
  });

  it("refuses an extensionless shim the same way, and still names the fix", () => {
    const sh = join(BIN, "pi"); // the git-bash style shim some CI machines carry
    const deps = fsDeps({ [sh]: "#!/bin/sh" });
    const resolved = resolveExecutableLaunch(["pi"], deps);
    expect(resolved.source).toBe("windows-unresolved");
    expect(resolved.argv).toEqual(["pi"]);
    expect(resolved.error).toContain(PI_COMMAND_ENV);
  });

  it("ignores a shim that names a JS file which does not exist", () => {
    const deps = fsDeps({ [shim]: '"%~dp0pi-launcher.js"' }); // launcher.js absent
    expect(jsEntryFromShim(shim, deps)).toBeNull();
  });
});

describe("whichWindows", () => {
  it("walks PATH in order and honours PATHEXT, ignoring duplicates", () => {
    const a = "C:\\a";
    const b = "C:\\b";
    const deps: LaunchDeps = {
      platform: "win32",
      env: { PATH: `${a};${b}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: (path) => [join(a, "pi.cmd"), join(b, "pi.exe")].includes(path),
    };
    expect(whichWindows("pi", deps)).toEqual([join(a, "pi.cmd"), join(b, "pi.exe")]);
  });

  it("tolerates quoted PATH entries", () => {
    const deps: LaunchDeps = {
      platform: "win32",
      env: { PATH: '"C:\\Program Files\\nodejs"' },
      fileExists: (path) => path === join("C:\\Program Files\\nodejs", "pi.cmd"),
    };
    expect(whichWindows("pi", deps)).toEqual([join("C:\\Program Files\\nodejs", "pi.cmd")]);
  });
});

// `otto status` / `otto doctor` ask this before a task is dispatched: a launch that cannot be
// spawned is the difference between "unknown error inside a worker" and "your env var is wrong".
describe("checkLaunchSpawnable", () => {
  it("accepts an existing path and reports a truncated one", () => {
    const deps = fsDeps({ [NODE]: "" });
    expect(checkLaunchSpawnable([NODE, "C:\bin\pi-launcher.js"], deps)).toMatchObject({ ok: true, detail: NODE });
    // The 2026-11-10 shape: OTTO_PI_COMMAND split at the space, so argv[0] is "C:\Program".
    const broken = checkLaunchSpawnable(["C:\Program", "Files\nodejs\node.exe"], deps);
    expect(broken.ok).toBe(false);
    expect(broken.detail).toContain("C:\Program");
  });

  it("treats a bare name that only resolves to a shim as unspawnable", () => {
    const cmd = join(BIN, "pi.cmd");
    const deps = fsDeps({ [cmd]: "@echo off" });
    const check = checkLaunchSpawnable(["pi"], deps);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(cmd);
  });

  it("resolves a bare name through PATH on Windows and skips the check on POSIX", () => {
    const deps: LaunchDeps = {
      platform: "win32",
      env: { PATH: "C:\tools", PATHEXT: ".EXE" },
      fileExists: (path) => path === join("C:\tools", "node.exe"),
    };
    expect(checkLaunchSpawnable(["node", "x.js"], deps)).toMatchObject({ ok: true });
    // Callers pass the whole resolution; with no refusal inside it, it is the argv probe.
    expect(launchCheck({ argv: ["node", "x.js"], source: "as-is" }, deps)).toMatchObject({ ok: true });
    expect(checkLaunchSpawnable(["nope"], deps)).toMatchObject({ ok: false, detail: "not on PATH: nope" });
    // POSIX: the kernel resolves the bare name; there is nothing to check here.
    expect(checkLaunchSpawnable(["pi"], { platform: "linux" })).toMatchObject({ ok: true });
    expect(checkLaunchSpawnable([], { platform: "linux" })).toMatchObject({ ok: false, detail: "empty argv" });
  });
});
