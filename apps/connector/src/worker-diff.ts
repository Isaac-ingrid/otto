// On-demand Worker Git Diff collection (`worker_diff` / `worker_diff_result`),
// docs/plan/worktree-diff-and-archive-cleanup.md §4.
//
// Collects changed file summaries (`base` vs working tree + untracked files) and unified
// diff patches with strict byte budgets, `execFile("git", ..., ["--", filePath])` argv
// isolation (zero shell), symlink/traversal guards, and secret redaction.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isSafeRelativeGitPath,
  WORKER_DIFF_INLINE_PATCH_MAX_BYTES,
  WORKER_DIFF_MAX_COMMITS,
  WORKER_DIFF_MAX_FILES,
  WORKER_DIFF_MESSAGE_MAX_BYTES,
  type WorkerDiffCommit,
  type WorkerDiffFile,
  type WorkerDiffFileStatus,
  type WorkerDiffPayload,
  type WorkerDiffResult,
} from "@isaac2ingrid/protocol";
import { redactText } from "./redact.ts";

const exec = promisify(execFile);
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 10_000, maxBuffer: GIT_MAX_BUFFER });
    return stdout;
  } catch {
    return null;
  }
}

/** Slices a UTF-8 string to at most `maxBytes` without splitting a surrogate pair / multi-byte char. */
export function sliceUtf8ByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

function readUntrackedPreview(workDir: string, relPath: string, maxBytes: number): { binary: boolean; text: string; lines: number; truncated: boolean } | null {
  const full = join(workDir, relPath);
  try {
    const st = lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const cap = Math.min(st.size, maxBytes + 4096);
    const buf = Buffer.alloc(cap);
    const fd = openSync(full, "r");
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, cap, 0);
    } finally {
      closeSync(fd);
    }
    const slice = buf.subarray(0, bytesRead);
    if (slice.includes(0)) return { binary: true, text: "", lines: 0, truncated: false };
    const decoded = slice.toString("utf8");
    const lines = decoded.length === 0 ? 0 : decoded.endsWith("\n") ? decoded.split("\n").length - 1 : decoded.split("\n").length;
    return { binary: false, text: decoded, lines, truncated: st.size > bytesRead };
  } catch {
    return null;
  }
}

function formatUntrackedPatch(relPath: string, content: string): string {
  if (content.length === 0) {
    return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n`;
  }
  const rawLines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const body = rawLines.map((l) => `+${l}`).join("\n");
  return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${rawLines.length} @@\n${body}\n`;
}

function parseTrackedFiles(nameStatusZ: string, numstatZ: string): Map<string, WorkerDiffFile> {
  const byPath = new Map<string, WorkerDiffFile>();
  const nsTokens = nameStatusZ.split("\0");
  for (let i = 0; i < nsTokens.length; ) {
    const statusRaw = nsTokens[i++] ?? "";
    if (!statusRaw) break;
    const code = statusRaw[0]!;
    if (code === "R" || code === "C") {
      const oldPath = nsTokens[i++] ?? "";
      const newPath = nsTokens[i++] ?? "";
      if (newPath) byPath.set(newPath, { path: newPath, ...(oldPath ? { oldPath } : {}), status: "R", insertions: 0, deletions: 0, binary: false });
    } else {
      const filePath = nsTokens[i++] ?? "";
      const status: WorkerDiffFileStatus = code === "A" ? "A" : code === "D" ? "D" : "M";
      if (filePath) byPath.set(filePath, { path: filePath, status, insertions: 0, deletions: 0, binary: false });
    }
  }

  const numTokens = numstatZ.split("\0");
  for (let i = 0; i < numTokens.length; ) {
    const token = numTokens[i++] ?? "";
    if (!token) break;
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const [addStr, delStr, inlinePath] = parts as [string, string, string];
    let targetPath = inlinePath;
    let oldPath: string | undefined;
    if (inlinePath === "") {
      oldPath = numTokens[i++] ?? "";
      targetPath = numTokens[i++] ?? "";
    }
    if (!targetPath) continue;
    const binary = addStr === "-" || delStr === "-";
    const insertions = !binary && /^\d+$/.test(addStr) ? Number(addStr) : 0;
    const deletions = !binary && /^\d+$/.test(delStr) ? Number(delStr) : 0;
    const existing = byPath.get(targetPath);
    if (existing) {
      existing.insertions = insertions;
      existing.deletions = deletions;
      existing.binary = binary;
      if (oldPath && !existing.oldPath) existing.oldPath = oldPath;
    } else {
      byPath.set(targetPath, { path: targetPath, ...(oldPath ? { oldPath } : {}), status: "M", insertions, deletions, binary });
    }
  }
  return byPath;
}

export interface CollectWorkerDiffOptions {
  workDir: string;
  base: string;
  filePath?: string;
  contextLines?: number;
  extraSecrets?: readonly string[];
}

export async function collectWorkerDiff(opts: CollectWorkerDiffOptions): Promise<WorkerDiffResult> {
  if (opts.filePath !== undefined && !isSafeRelativeGitPath(opts.filePath)) {
    return { ok: false, code: "invalid_path" };
  }
  if (!existsSync(opts.workDir)) {
    return { ok: false, code: "no_worktree" };
  }
  const inside = await git(opts.workDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") {
    return { ok: false, code: "not_git_repo" };
  }
  const baseShaRaw = await git(opts.workDir, ["rev-parse", "--verify", opts.base]);
  const baseSha = baseShaRaw?.trim();
  if (!baseSha) {
    return { ok: false, code: "diff_failed" };
  }

  const ctx = Math.min(20, Math.max(0, opts.contextLines ?? 3));
  const [branchOut, aheadOut, statusOut, remoteRefs, headOut, commitsOut, nameStatusZ, numstatZ, untrackedZ] =
    await Promise.all([
      git(opts.workDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(opts.workDir, ["rev-list", "--count", `${baseSha}..HEAD`]),
      git(opts.workDir, ["status", "--porcelain"]),
      git(opts.workDir, ["branch", "--all", "--contains", "HEAD"]),
      git(opts.workDir, ["rev-parse", "HEAD"]),
      git(opts.workDir, ["log", "--format=%H%x09%s", `-n`, String(WORKER_DIFF_MAX_COMMITS), `${baseSha}..HEAD`]),
      git(opts.workDir, ["diff", "--name-status", "-M", "-z", baseSha]),
      git(opts.workDir, ["diff", "--numstat", "-M", "-z", baseSha]),
      git(opts.workDir, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);

  const byPath = parseTrackedFiles(nameStatusZ ?? "", numstatZ ?? "");
  const untrackedPaths = (untrackedZ ?? "").split("\0").filter((p) => p.length > 0 && isSafeRelativeGitPath(p));
  const untrackedSet = new Set(untrackedPaths);
  for (const rel of untrackedPaths) {
    if (byPath.has(rel)) continue;
    const preview = readUntrackedPreview(opts.workDir, rel, 64 * 1024);
    byPath.set(rel, {
      path: rel,
      status: "U",
      insertions: preview && !preview.binary ? preview.lines : 0,
      deletions: 0,
      binary: preview?.binary ?? false,
    });
  }

  const allFiles = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const filesTruncated = allFiles.length > WORKER_DIFF_MAX_FILES;
  const files = allFiles.slice(0, WORKER_DIFF_MAX_FILES);

  const commits: WorkerDiffCommit[] = (commitsOut ?? "")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, WORKER_DIFF_MAX_COMMITS)
    .map((line) => {
      const tab = line.indexOf("\t");
      const sha = tab === -1 ? line.trim() : line.slice(0, tab).trim();
      const subject = tab === -1 ? "" : redactText(line.slice(tab + 1), opts.extraSecrets ?? []);
      return { sha, subject: subject.slice(0, 500) };
    });

  let patch = "";
  let patchTruncated = false;

  if (opts.filePath !== undefined) {
    if (untrackedSet.has(opts.filePath)) {
      const preview = readUntrackedPreview(opts.workDir, opts.filePath, WORKER_DIFF_INLINE_PATCH_MAX_BYTES);
      if (preview && !preview.binary) {
        const redacted = redactText(formatUntrackedPatch(opts.filePath, preview.text), opts.extraSecrets ?? []);
        const sliced = sliceUtf8ByBytes(redacted, WORKER_DIFF_INLINE_PATCH_MAX_BYTES);
        patch = sliced.text;
        patchTruncated = preview.truncated || sliced.truncated;
      } else if (preview?.binary) {
        patch = `diff --git a/${opts.filePath} b/${opts.filePath}\nnew file mode 100644\nBinary files /dev/null and b/${opts.filePath} differ\n`;
      }
    } else {
      const rawDiff = (await git(opts.workDir, ["diff", "--no-ext-diff", `--unified=${ctx}`, "-M", baseSha, "--", opts.filePath])) ?? "";
      const redacted = redactText(rawDiff, opts.extraSecrets ?? []);
      const sliced = sliceUtf8ByBytes(redacted, WORKER_DIFF_INLINE_PATCH_MAX_BYTES);
      patch = sliced.text;
      patchTruncated = sliced.truncated;
    }
  } else {
    const rawTracked = (await git(opts.workDir, ["diff", "--no-ext-diff", `--unified=${ctx}`, "-M", baseSha])) ?? "";
    if (Buffer.byteLength(rawTracked, "utf8") > WORKER_DIFF_INLINE_PATCH_MAX_BYTES) {
      patch = "";
      patchTruncated = true;
    } else {
      let combined = rawTracked;
      let overBudget = false;
      for (const rel of untrackedPaths) {
        const preview = readUntrackedPreview(opts.workDir, rel, WORKER_DIFF_INLINE_PATCH_MAX_BYTES);
        if (!preview) continue;
        const block = preview.binary
          ? `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary files /dev/null and b/${rel} differ\n`
          : formatUntrackedPatch(rel, preview.text);
        if (preview.truncated || Buffer.byteLength(combined, "utf8") + Buffer.byteLength(block, "utf8") > WORKER_DIFF_INLINE_PATCH_MAX_BYTES) {
          overBudget = true;
          break;
        }
        combined += (combined && !combined.endsWith("\n") ? "\n" : "") + block;
      }
      if (overBudget) {
        patch = "";
        patchTruncated = true;
      } else {
        const redacted = redactText(combined, opts.extraSecrets ?? []);
        if (Buffer.byteLength(redacted, "utf8") <= WORKER_DIFF_INLINE_PATCH_MAX_BYTES) {
          patch = redacted;
        } else {
          patch = "";
          patchTruncated = true;
        }
      }
    }
  }

  const basePayload: Omit<WorkerDiffPayload, "patch" | "patchTruncated"> = {
    base: baseSha,
    branch: (branchOut ?? "").trim() || "unknown",
    ...(headOut?.trim() ? { head: headOut.trim() } : {}),
    dirty: (statusOut ?? "").split("\n").filter((l) => l.trim().length > 0).length,
    ahead: Number((aheadOut ?? "0").trim()) || 0,
    pushed: (remoteRefs ?? "").split("\n").some((ref) => ref.trim().startsWith("remotes/")),
    commits,
    files,
    filesTruncated,
  };

  let candidate: WorkerDiffPayload = { ...basePayload, patch, patchTruncated };
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > WORKER_DIFF_MESSAGE_MAX_BYTES) {
    if (opts.filePath !== undefined) {
      const overhead = Buffer.byteLength(JSON.stringify({ ...basePayload, patch: "", patchTruncated: true }), "utf8") + 1024;
      const room = Math.max(0, WORKER_DIFF_MESSAGE_MAX_BYTES - overhead);
      const sliced = sliceUtf8ByBytes(patch, room);
      candidate = { ...basePayload, patch: sliced.text, patchTruncated: true };
    } else {
      candidate = { ...basePayload, patch: "", patchTruncated: true };
    }
  }

  return { ok: true, diff: candidate };
}
