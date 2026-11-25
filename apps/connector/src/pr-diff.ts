// Stage 4 Zero-Checkout PR Bare Git Diff (`git_pr_diff`).
//
// Security & isolation invariants:
// 1. Zero working-tree mutation: never runs `git checkout`, `git switch`, `git merge`, or `git reset`.
// 2. Zero repository hook execution: passes `-c core.hooksPath=/dev/null` on every git command.
// 3. Octopus merge guard: inspects `git rev-list --parents -n 1 <headSha>`; commits with >2
//    parents (`parentCount > 2`) are explicitly refused (`octopus_merge_refused`) so multi-parent
//    diffs can never misreport or hide changes.
// 4. Optional PR ref fetch: when `prNumber` is provided and `headSha` is not yet in the local
//    object store, fetches `refs/pull/<prNumber>/head` without tags or submodules into `FETCH_HEAD`
//    only (leaving local branches untouched).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_GIT_PR_DIFF_MAX_BYTES,
  type GitPrDiffArgs,
  type GitPrDiffResult,
} from "@isaac2ingrid/protocol";
import { childEnv } from "./pi-adapter.ts";
import { proxyEnvFor, type ProxyConfig } from "./proxy.ts";

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER_BYTES = 16 * 1024 * 1024;
const NULL_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export interface GitExecFn {
  (args: string[], cwd: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<{
    stdout: string;
    stderr: string;
  }>;
}

const defaultGitExec: GitExecFn = async (args, cwd, env, timeoutMs) => {
  const res = await execFileAsync("git", ["-c", `core.hooksPath=${NULL_HOOKS_PATH}`, ...args], {
    cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: MAX_GIT_BUFFER_BYTES,
    windowsHide: true,
  });
  return { stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
};

export async function collectZeroCheckoutPrDiff(options: {
  repoPath: string;
  defaultBranch: string | null;
  args: GitPrDiffArgs;
  proxy?: ProxyConfig | null;
  timeoutMs?: number;
  gitExec?: GitExecFn;
}): Promise<GitPrDiffResult> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const maxBytes = options.args.maxBytes ?? DEFAULT_GIT_PR_DIFF_MAX_BYTES;
  const runGit = options.gitExec ?? defaultGitExec;
  const env = childEnv(process.env, {
    ...(options.proxy ? proxyEnvFor(options.proxy) : {}),
    GIT_TERMINAL_PROMPT: "0",
  });

  let targetCommit = options.args.headSha?.trim() ?? "";

  const commitExistsLocally = async (rev: string): Promise<string | null> => {
    if (!rev) return null;
    try {
      const { stdout } = await runGit(["rev-parse", "--verify", `${rev}^{commit}`], options.repoPath, env, timeoutMs);
      const resolved = stdout.trim();
      return /^[0-9a-f]{40,64}$/i.test(resolved) ? resolved : null;
    } catch {
      return null;
    }
  };

  let resolvedHead = await commitExistsLocally(targetCommit);

  if (!resolvedHead && options.args.prNumber !== undefined) {
    try {
      await runGit(
        [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--quiet",
          "origin",
          `refs/pull/${options.args.prNumber}/head`,
        ],
        options.repoPath,
        env,
        timeoutMs,
      );
      resolvedHead = await commitExistsLocally(targetCommit || "FETCH_HEAD");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: "fetch_failed",
        message: `failed to fetch PR #${options.args.prNumber}: ${detail}`.slice(0, 360),
      };
    }
  } else if (!resolvedHead && targetCommit) {
    try {
      await runGit(
        ["fetch", "--no-tags", "--no-recurse-submodules", "--quiet", "origin", targetCommit],
        options.repoPath,
        env,
        timeoutMs,
      );
      resolvedHead = await commitExistsLocally(targetCommit);
    } catch {
      // fall through to commit_not_found below
    }
  }

  if (!resolvedHead) {
    return {
      ok: false,
      code: "commit_not_found",
      message: `PR commit '${targetCommit || `pull/${options.args.prNumber ?? "?"}`}' was not found in repository object store`,
    };
  }

  // Inspect commit parents directly — explicitly reject octopus merges (>2 parents).
  let parents: string[] = [];
  try {
    const { stdout } = await runGit(["rev-list", "--parents", "-n", "1", resolvedHead], options.repoPath, env, timeoutMs);
    const tokens = stdout.trim().split(/\s+/).filter(Boolean);
    parents = tokens.slice(1);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "diff_failed", message: detail.slice(0, 360) };
  }

  if (parents.length > 2) {
    return {
      ok: false,
      code: "octopus_merge_refused",
      message: `commit ${resolvedHead.slice(0, 12)} is an octopus merge (${parents.length} parents); automatic blind diff is refused`,
    };
  }
  if (parents.length === 0) {
    return {
      ok: false,
      code: "diff_failed",
      message: `commit ${resolvedHead.slice(0, 12)} is a root commit with no parent to diff against`,
    };
  }

  // Resolve base commit: prefer merge-base against `baseRef` / `origin/<defaultBranch>` / `<defaultBranch>`,
  // falling back cleanly to `parents[0]` (first parent — exact base for 2-parent GitHub merge commits too!).
  let baseSha = parents[0]!;
  const candidateBaseRefs = [
    options.args.baseRef,
    options.defaultBranch ? `origin/${options.defaultBranch}` : undefined,
    options.defaultBranch ?? undefined,
  ].filter((r): r is string => Boolean(r && r.trim()));

  for (const ref of candidateBaseRefs) {
    try {
      const { stdout } = await runGit(["merge-base", ref, resolvedHead], options.repoPath, env, timeoutMs);
      const mb = stdout.trim();
      if (/^[0-9a-f]{40,64}$/i.test(mb)) {
        baseSha = mb;
        break;
      }
    } catch {
      // try next ref or keep parents[0]
    }
  }

  try {
    const namesRes = await runGit(
      ["diff", "--name-only", "--no-ext-diff", baseSha, resolvedHead, "--"],
      options.repoPath,
      env,
      timeoutMs,
    );
    const allFiles = namesRes.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const patchRes = await runGit(
      ["diff", "--unified=3", "--no-color", "--no-ext-diff", baseSha, resolvedHead, "--"],
      options.repoPath,
      env,
      timeoutMs,
    );
    const rawPatch = patchRes.stdout;
    const rawBytes = Buffer.byteLength(rawPatch, "utf8");
    let patch = rawPatch;
    let truncated = false;
    if (rawBytes > maxBytes) {
      truncated = true;
      patch = Buffer.from(rawPatch, "utf8").subarray(0, maxBytes).toString("utf8") + "\n…[diff truncated]\n";
    }

    return {
      ok: true,
      diff: {
        headSha: resolvedHead,
        baseSha,
        parentCount: Math.max(1, Math.min(2, parents.length)),
        filesChanged: allFiles.length,
        changedFiles: allFiles.slice(0, 200),
        patch,
        truncated,
      },
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "diff_failed", message: detail.slice(0, 360) };
  }
}
