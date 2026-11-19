import { describe, expect, it } from "vitest";
import {
  HelloMessageSchema,
  isSafeRelativeGitPath,
  WORKER_DIFF_MESSAGE_MAX_BYTES,
  WorkerDiffMessageSchema,
  WorkerDiffResultMessageSchema,
} from "../src/index.ts";

describe("worker_diff / worker_diff_result protocol schemas & path safety", () => {
  it("accepts safe relative Git paths and rejects traversal, absolute, drive, and NUL paths", () => {
    for (const ok of ["src/index.ts", "apps/connector/src/worker-diff.ts", ".github/workflows/ci.yml", "README.md"]) {
      expect(isSafeRelativeGitPath(ok), ok).toBe(true);
    }
    for (const bad of ["", "/etc/passwd", "\\windows\\system32", "C:\\foo.ts", "../secret", "src/../../etc/passwd", "./foo", "src//bar.ts", "foo\0bar"]) {
      expect(isSafeRelativeGitPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("validates worker_diff requests, bounded worker_diff_result payloads, and hello capabilities", () => {
    expect(
      WorkerDiffMessageSchema.safeParse({
        t: "worker_diff",
        id: "req-1",
        workerId: "w-1",
        filePath: "src/app.ts",
        contextLines: 3,
      }).success,
    ).toBe(true);

    expect(
      WorkerDiffMessageSchema.safeParse({
        t: "worker_diff",
        id: "req-2",
        workerId: "w-1",
        extraUnknown: true,
      }).success,
    ).toBe(false);

    const okMsg = WorkerDiffResultMessageSchema.safeParse({
      t: "worker_diff_result",
      re: "req-1",
      ok: true,
      diff: {
        base: "abc1234",
        branch: "otto/t1-1",
        head: "def5678",
        dirty: 1,
        ahead: 2,
        pushed: false,
        commits: [{ sha: "def5678", subject: "feat: add diff" }],
        files: [{ path: "src/app.ts", status: "M", insertions: 10, deletions: 2, binary: false }],
        filesTruncated: false,
        patch: "diff --git a/src/app.ts b/src/app.ts\n",
        patchTruncated: false,
      },
    });
    expect(okMsg.success).toBe(true);

    const oversized = WorkerDiffResultMessageSchema.safeParse({
      t: "worker_diff_result",
      re: "req-big",
      ok: true,
      diff: {
        base: "abc",
        branch: "otto/t1-1",
        dirty: 0,
        ahead: 0,
        pushed: false,
        commits: [],
        files: [],
        filesTruncated: false,
        patch: "x".repeat(WORKER_DIFF_MESSAGE_MAX_BYTES + 1024),
        patchTruncated: true,
      },
    });
    expect(oversized.success).toBe(false);

    expect(
      WorkerDiffResultMessageSchema.safeParse({
        t: "worker_diff_result",
        re: "req-err",
        ok: false,
        code: "invalid_path",
      }).success,
    ).toBe(true);

    const helloSample = HelloMessageSchema.safeParse({
      t: "hello",
      id: "h-1",
      protocol: { min: 1, max: 1 },
      deviceId: "dev-1",
      bootId: "boot-1",
      connEpoch: 1,
      connector: { version: "0.2.1", os: "darwin", arch: "arm64", node: "v24.0.0" },
      capabilities: { directoryBrowse: true, workerDiff: true },
      machine: { name: "mac", memTotalMB: 16384, memFreeMB: 8192 },
      agents: [],
      repos: [],
      limits: { maxWorkers: 4, running: 0 },
      workers: [{ workerId: "w-1", agent: "pi", state: "idle", lastSeq: 3, sessionId: "s-1", lastOutcome: "reported", hasWorktree: true }],
      pendingAcks: [],
    });
    expect(helloSample.success).toBe(true);
  });
});
