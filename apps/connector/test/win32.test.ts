// win32.ts: the PowerShell/CIM process table that stands in for `ps`/`/proc`. The parser and
// the loader's cache/shell-fallback behaviour are driven through injected runners so they run
// everywhere; one live case exercises the real CIM query on an actual Windows runner.
import { describe, expect, it, vi } from "vitest";
import { parseWin32Table, resetWin32Cache, win32ProcessCreated, win32Script, win32Table, win32TableSync } from "../src/win32.ts";

const ROW = { ProcessId: 100, ParentProcessId: 50, Created: "2026-01-02T03:04:05.0000000Z", CpuMs: 12.5 };

describe("win32Script", () => {
  it("asks for the command line only when it is needed", () => {
    expect(win32Script(false)).not.toContain("CommandLine");
    expect(win32Script(true)).toContain(",CommandLine");
    // CreationDate is coerced in the query, so the JSON shape never depends on the host's
    // ConvertTo-Json DateTime serialization.
    expect(win32Script(false)).toContain("([datetime]$_.CreationDate)");
    expect(win32Script(false)).toContain("UserModeTime");
  });
});

describe("parseWin32Table", () => {
  it("accepts an array and a lone object (ConvertTo-Json emits both)", () => {
    expect(parseWin32Table(JSON.stringify([ROW]))).toEqual([
      { pid: 100, ppid: 50, created: ROW.Created, cpuMs: 12.5 },
    ]);
    expect(parseWin32Table(JSON.stringify(ROW))).toEqual([{ pid: 100, ppid: 50, created: ROW.Created, cpuMs: 12.5 }]);
  });

  it("keeps the command line when the query carried one", () => {
    const rows = parseWin32Table(JSON.stringify({ ...ROW, CommandLine: '"C:\\node.exe" "C:\\pi.js" --mode rpc' }));
    expect(rows[0]!.commandLine).toBe('"C:\\node.exe" "C:\\pi.js" --mode rpc');
    expect(parseWin32Table(JSON.stringify(ROW))[0]!.commandLine).toBeUndefined();
  });

  it("treats an empty document as no processes and rejects a malformed one", () => {
    expect(parseWin32Table("   ")).toEqual([]);
    expect(() => parseWin32Table("<html>error</html>")).toThrow();
  });

  it("drops rows without a usable pid and omits empty/unparseable fields", () => {
    const rows = parseWin32Table(
      JSON.stringify([
        { ProcessId: 0, ParentProcessId: 0 },
        { ProcessId: "nope" },
        { ProcessId: 5, ParentProcessId: null, Created: "", CpuMs: "" },
      ]),
    );
    expect(rows).toEqual([{ pid: 5, ppid: 0 }]);
  });
});

describe("win32Table loading", () => {
  it("is a no-op off Windows", async () => {
    const exec = vi.fn();
    expect(await win32Table({ platform: "linux", exec })).toEqual([]);
    expect(win32TableSync({ platform: "linux" })).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("queries PowerShell once per cache window and reuses the table", async () => {
    resetWin32Cache();
    const exec = vi.fn(async (_file: string, _args: string[]) => ({ stdout: JSON.stringify([ROW]) }));
    const deps = { platform: "win32" as const, exec, now: () => 1_000, cacheMs: 1_000 };
    expect(await win32Table(deps)).toHaveLength(1);
    expect(await win32Table(deps)).toHaveLength(1); // still fresh
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(exec.mock.calls[0]?.[1]).toContain("-NoProfile");
  });

  it("caches the light and command-line tables separately", async () => {
    resetWin32Cache();
    const exec = vi.fn(async (_file: string, args: string[]) => ({
      stdout: JSON.stringify(args.join(" ").includes("CommandLine") ? [{ ...ROW, CommandLine: "pi --mode rpc" }] : [ROW]),
    }));
    const deps = { platform: "win32" as const, exec, now: () => 5_000, cacheMs: 1_000 };
    expect((await win32Table(deps))[0]!.commandLine).toBeUndefined();
    expect((await win32Table(deps, { commandLine: true }))[0]!.commandLine).toBe("pi --mode rpc");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("falls back to pwsh when Windows PowerShell is unavailable, and degrades to [] when both fail", async () => {
    resetWin32Cache();
    const shells: string[] = [];
    const exec = async (file: string) => {
      shells.push(file);
      if (file === "powershell.exe") throw new Error("not found");
      return { stdout: JSON.stringify([ROW]) };
    };
    expect(await win32Table({ platform: "win32", exec, now: () => 0, cacheMs: 0 })).toHaveLength(1);
    expect(shells).toEqual(["powershell.exe", "pwsh"]);

    resetWin32Cache();
    const failing = vi.fn(async () => {
      throw new Error("no powershell");
    });
    expect(await win32Table({ platform: "win32", exec: failing, cacheMs: 0 })).toEqual([]);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("reports a creation time from the sync table (the lock identity)", () => {
    resetWin32Cache();
    const execSync = vi.fn(() => ({ stdout: JSON.stringify([ROW]) }));
    expect(win32ProcessCreated(100, { platform: "win32", execSync, now: () => 0, cacheMs: 1_000 })).toBe(ROW.Created);
    expect(win32ProcessCreated(999, { platform: "win32", execSync, now: () => 0, cacheMs: 1_000 })).toBeUndefined();
  });

  it("ignores a sync shell that prints nothing usable", () => {
    resetWin32Cache();
    const execSync = vi.fn((file: string) => ({ stdout: file === "powershell.exe" ? "" : JSON.stringify([ROW]) }));
    expect(win32ProcessCreated(100, { platform: "win32", execSync, now: () => 0, cacheMs: 0 })).toBe(ROW.Created);
  });
});

describe.runIf(process.platform === "win32")("live Windows process table", () => {
  it("finds this test process with a creation timestamp", async () => {
    resetWin32Cache();
    const rows = await win32Table({ cacheMs: 0 });
    expect(rows.length).toBeGreaterThan(1);
    const self = rows.find((row) => row.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.created).toBeTruthy();
    expect(Number.isNaN(Date.parse(self!.created!))).toBe(false);
    // The parent is a real pid, so `collectDescendants` can walk a tree on Windows.
    expect(self!.ppid).toBeGreaterThan(0);
    // Sync and async read the same table.
    expect(win32ProcessCreated(process.pid, { cacheMs: 0 })).toBe(self!.created);
  }, 30_000);
});
