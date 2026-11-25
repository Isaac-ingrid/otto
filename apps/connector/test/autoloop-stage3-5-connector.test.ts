import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  computeProbeApprovalDigest,
  normalizeProbeScriptInput,
  parseProbeStdout,
  runApprovedProbe,
  verifyProbeApproval,
  type StoredProbeConfig,
} from "../src/probes.ts";
import { collectZeroCheckoutPrDiff } from "../src/pr-diff.ts";
import {
  buildDesktopNotificationCommand,
  encodePowerShellUtf16LeBase64,
  hasActiveDesktopSession,
} from "../src/desktop-notify.ts";

describe("Agent Autoloop Stages 3-5 Connector modules", () => {
  it("verifies SHA-256 approved local probes, rejects tampered scripts, and parses structured output", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "otto-probe-test-"));
    try {
      const probesDir = join(stateDir, "probes");
      mkdirSync(probesDir, { recursive: true });
      const scriptPath = join(probesDir, "check-site.mjs");
      writeFileSync(
        scriptPath,
        `#!/usr/bin/env node\nconsole.log(JSON.stringify({ triggered: false, summary: "no change" }));\n`,
        "utf8",
      );
      chmodSync(scriptPath, 0o755);

      const norm = normalizeProbeScriptInput(stateDir, "check-site.mjs");
      expect(norm.canonicalScript).toBe("check-site.mjs");
      expect(() => normalizeProbeScriptInput(stateDir, "../escape.mjs")).toThrow();

      const digest = computeProbeApprovalDigest(stateDir, "check-site", norm.canonicalScript);
      expect(digest.ok).toBe(true);
      if (!digest.ok) throw new Error("expected digest ok");
      const config: StoredProbeConfig = {
        probeName: "check-site",
        script: norm.canonicalScript,
        approvedSha256: digest.sha256,
        approvedAt: Date.now(),
      };
      expect(verifyProbeApproval(stateDir, config).approved).toBe(true);

      const silentRes = await runApprovedProbe({ stateDir, config });
      expect(silentRes.ok).toBe(true);
      if (silentRes.ok) {
        expect(silentRes.probeName).toBe("check-site");
        expect(silentRes.output).toEqual({ triggered: false, summary: "no change" });
      }

      // Tampering invalidates SHA-256 approval immediately
      writeFileSync(
        scriptPath,
        `#!/usr/bin/env node\nconsole.log(JSON.stringify({ triggered: true, summary: "changed!" }));\n`,
        "utf8",
      );
      const tamperedRes = await runApprovedProbe({ stateDir, config });
      expect(tamperedRes.ok).toBe(false);
      if (!tamperedRes.ok) expect(tamperedRes.code).toBe("unapproved");

      // Plain-text fallback parsing
      expect(parseProbeStdout("")).toEqual({ triggered: false });
      expect(parseProbeStdout("New release v2.4.0 found")).toEqual({
        triggered: true,
        summary: "New release v2.4.0 found",
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("collects zero-checkout PR diff without touching dirty working tree and refuses octopus merges", async () => {
    const root = mkdtempSync(join(tmpdir(), "otto-prdiff-test-"));
    try {
      const remoteBare = join(root, "remote.git");
      const upstreamWork = join(root, "upstream");
      const localClone = join(root, "local");

      execFileSync("git", ["init", "--bare", "-b", "main", remoteBare]);
      execFileSync("git", ["clone", remoteBare, upstreamWork]);
      execFileSync("git", ["-C", upstreamWork, "config", "user.email", "dev@example.com"]);
      execFileSync("git", ["-C", upstreamWork, "config", "user.name", "Dev"]);
      writeFileSync(join(upstreamWork, "app.ts"), "export const v = 1;\n", "utf8");
      execFileSync("git", ["-C", upstreamWork, "add", "."]);
      execFileSync("git", ["-C", upstreamWork, "commit", "-m", "init"]);
      execFileSync("git", ["-C", upstreamWork, "push", "origin", "main"]);

      // Create PR #7 ref on bare remote
      execFileSync("git", ["-C", upstreamWork, "checkout", "-b", "feat-pr"]);
      writeFileSync(join(upstreamWork, "app.ts"), "export const v = 2;\nexport const added = true;\n", "utf8");
      execFileSync("git", ["-C", upstreamWork, "commit", "-am", "feat: bump v to 2"]);
      const prHeadSha = execFileSync("git", ["-C", upstreamWork, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", upstreamWork, "push", "origin", `HEAD:refs/pull/7/head`]);

      // Clone locally and dirty the working tree
      execFileSync("git", ["clone", remoteBare, localClone]);
      writeFileSync(join(localClone, "app.ts"), "// UNCOMMITTED LOCAL EDIT\n", "utf8");

      const diffRes = await collectZeroCheckoutPrDiff({
        repoPath: localClone,
        defaultBranch: "main",
        args: {
          repoId: "repo_test",
          prNumber: 7,
          headSha: prHeadSha,
        },
      });
      expect(diffRes.ok).toBe(true);
      if (diffRes.ok) {
        expect(diffRes.diff.headSha).toBe(prHeadSha);
        expect(diffRes.diff.patch).toContain("+export const added = true;");
        expect(diffRes.diff.changedFiles).toContain("app.ts");
      }
      // Local dirty working tree must be 100% untouched!
      const dirtyStatus = execFileSync("git", ["-C", localClone, "diff"], { encoding: "utf8" });
      expect(dirtyStatus).toContain("// UNCOMMITTED LOCAL EDIT");

      // Create an octopus merge (3 parents) on PR #8 and verify refusal
      execFileSync("git", ["-C", upstreamWork, "checkout", "main"]);
      execFileSync("git", ["-C", upstreamWork, "checkout", "-b", "side-a"]);
      writeFileSync(join(upstreamWork, "a.txt"), "a\n", "utf8");
      execFileSync("git", ["-C", upstreamWork, "add", "a.txt"]);
      execFileSync("git", ["-C", upstreamWork, "commit", "-m", "side a"]);

      execFileSync("git", ["-C", upstreamWork, "checkout", "main"]);
      execFileSync("git", ["-C", upstreamWork, "checkout", "-b", "side-b"]);
      writeFileSync(join(upstreamWork, "b.txt"), "b\n", "utf8");
      execFileSync("git", ["-C", upstreamWork, "add", "b.txt"]);
      execFileSync("git", ["-C", upstreamWork, "commit", "-m", "side b"]);

      execFileSync("git", ["-C", upstreamWork, "checkout", "feat-pr"]);
      execFileSync("git", ["-C", upstreamWork, "merge", "--no-edit", "side-a", "side-b"]);
      execFileSync("git", ["-C", upstreamWork, "push", "origin", `HEAD:refs/pull/8/head`]);

      const octoRes = await collectZeroCheckoutPrDiff({
        repoPath: localClone,
        defaultBranch: "main",
        args: {
          repoId: "repo_test",
          prNumber: 8,
        },
      });
      expect(octoRes.ok).toBe(false);
      if (!octoRes.ok) {
        expect(octoRes.code).toBe("octopus_merge_refused");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("escapes OS desktop notifications safely across macOS/Windows/Linux and suppresses SSH/headless", () => {
    expect(hasActiveDesktopSession("darwin", { SSH_CONNECTION: "1.2.3.4 55 1.2.3.5 22" })).toBe(false);
    expect(hasActiveDesktopSession("linux", {})).toBe(false);
    expect(hasActiveDesktopSession("linux", { DISPLAY: ":0" })).toBe(true);

    const macCmd = buildDesktopNotificationCommand(
      `Otto "$(rm -rf /)"`,
      "PR #12 ready 'single'",
      "darwin",
      {},
    );
    expect(macCmd?.file).toBe("osascript");
    expect(macCmd?.args.slice(0, 3)).toEqual(["-e", expect.stringContaining("on run argv"), "--"]);
    // Title and body are passed purely as positional argv after `--`, never interpolated into AppleScript!
    expect(macCmd?.args[3]).toContain(`"$(rm -rf /)"`);

    const winCmd = buildDesktopNotificationCommand(
      "Otto Alert",
      "Line 1 `$(calc.exe)` 'quote'",
      "win32",
      {},
    );
    expect(winCmd?.file).toBe("powershell.exe");
    expect(winCmd?.args).toContain("-EncodedCommand");
    const encoded = winCmd!.args[winCmd!.args.indexOf("-EncodedCommand") + 1]!;
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toContain("System.Windows.Forms.NotifyIcon");
    expect(winCmd?.env?.OTTO_NOTIFY_TITLE).toBe("Otto Alert");
    expect(winCmd?.env?.OTTO_NOTIFY_BODY).toContain("$(calc.exe)");
    expect(encodePowerShellUtf16LeBase64("AB")).toBe(Buffer.from("AB", "utf16le").toString("base64"));
  });
});
