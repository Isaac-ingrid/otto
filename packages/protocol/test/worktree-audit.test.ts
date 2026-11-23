import { describe, expect, it } from "vitest";
import {
  HelloMessageSchema,
  RepoWritePolicySchema,
  WORKTREE_AUDIT_MAX_ITEMS,
  WORKTREE_CLEANUP_MAX_TARGETS,
  WorktreeAuditMessageSchema,
  WorktreeAuditResultMessageSchema,
  WorktreeCleanupMessageSchema,
  WorktreeCleanupResultMessageSchema,
  isValidManagedWorktreeKey,
} from "../src/index.ts";

describe("worktree_audit / worktree_cleanup protocol schemas & managed key validation", () => {
  it("accepts strictly 2-level managed worktree keys and rejects traversal or external keys", () => {
    for (const ok of [
      "otto-a1b2c3d4/fix-auth-1",
      "my_repo.v2-01234567/task_99",
      "a-deadbeef/x",
    ]) {
      expect(isValidManagedWorktreeKey(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "ext:abcdef012345",
      "otto/fix-auth-1",
      "otto-a1b2c3d4/../escape",
      "otto-a1b2c3d4/nested/deep",
      "/abs/otto-a1b2c3d4/slug",
      "otto-xyz/slug",
    ]) {
      expect(isValidManagedWorktreeKey(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("validates RepoWritePolicy, hello capabilities, worktree_audit, and worktree_cleanup wire frames", () => {
    expect(RepoWritePolicySchema.safeParse({ isolation: "worktree", concurrency: "parallel" }).success).toBe(true);
    expect(RepoWritePolicySchema.safeParse({ isolation: "in-place", concurrency: "serial" }).success).toBe(true);
    expect(RepoWritePolicySchema.safeParse({ isolation: "invalid", concurrency: "parallel" }).success).toBe(false);

    expect(WorktreeAuditMessageSchema.safeParse({ t: "worktree_audit", id: "req-1" }).success).toBe(true);
    expect(
      WorktreeAuditMessageSchema.safeParse({ t: "worktree_audit", id: "req-2", repoId: "/srv/repo" }).success,
    ).toBe(true);

    expect(
      WorktreeAuditResultMessageSchema.safeParse({
        t: "worktree_audit_result",
        re: "req-1",
        ok: true,
        audit: {
          scannedAt: Date.now(),
          repos: [
            {
              repoId: "/srv/repo",
              name: "repo",
              path: "/srv/repo",
              capabilityKind: "git",
              defaultBranch: "main",
              writeIsolation: "worktree",
              writeConcurrency: "parallel",
              hasSetupHook: false,
              hasArchiveHook: true,
              hooksApproved: true,
              projectApproved: true,
              prunableCount: 0,
            },
          ],
          worktrees: [],
        },
      }).success,
    ).toBe(true);

    expect(
      WorktreeAuditResultMessageSchema.safeParse({
        t: "worktree_audit_result",
        re: "req-over",
        ok: true,
        audit: {
          scannedAt: 1,
          repos: [],
          worktrees: new Array(WORKTREE_AUDIT_MAX_ITEMS + 1).fill(null),
        },
      }).success,
    ).toBe(false);

    expect(
      WorktreeCleanupMessageSchema.safeParse({
        t: "worktree_cleanup",
        id: "clean-1",
        op: {
          confirmedRisks: true,
          pruneRepoIds: ["/srv/repo"],
          targets: [
            { kind: "worker", repoId: "/srv/repo", workerId: "w-1", expectedBranch: "otto/t1-1", force: true },
            { kind: "orphan_dir", repoId: "/srv/repo", worktreeKey: "repo-12345678/orphan-1", force: false },
          ],
        },
      }).success,
    ).toBe(true);

    expect(
      WorktreeCleanupMessageSchema.safeParse({
        t: "worktree_cleanup",
        id: "clean-bad-key",
        op: {
          targets: [
            { kind: "orphan_dir", repoId: "/srv/repo", worktreeKey: "../outside", force: false },
          ],
        },
      }).success,
    ).toBe(false);

    expect(
      WorktreeCleanupMessageSchema.safeParse({
        t: "worktree_cleanup",
        id: "clean-too-many",
        op: {
          targets: Array.from({ length: WORKTREE_CLEANUP_MAX_TARGETS + 1 }, (_, i) => ({
            kind: "worker" as const,
            repoId: "/srv/repo",
            workerId: `w-${i}`,
            force: false,
          })),
        },
      }).success,
    ).toBe(false);

    expect(
      WorktreeCleanupResultMessageSchema.safeParse({
        t: "worktree_cleanup_result",
        re: "clean-1",
        ok: true,
        result: {
          prunedRepoIds: ["/srv/repo"],
          items: [
            {
              targetKey: "worker:w-1",
              kind: "worker",
              repoId: "/srv/repo",
              workerId: "w-1",
              worktreeKey: "repo-12345678/t1-1",
              branch: "otto/t1-1",
              status: "blocked_locked",
            },
            {
              targetKey: "worker:w-2",
              kind: "worker",
              repoId: "/srv/repo",
              workerId: "w-2",
              worktreeKey: "repo-12345678/t2-1",
              branch: "otto/other",
              status: "branch_mismatch",
            },
          ],
        },
      }).success,
    ).toBe(true);

    expect(
      HelloMessageSchema.safeParse({
        t: "hello",
        id: "h-1",
        protocol: { min: 1, max: 1 },
        deviceId: "dev-1",
        bootId: "boot-1",
        connEpoch: 1,
        connector: { version: "0.2.1", os: "darwin", arch: "arm64", node: "v24.0.0" },
        capabilities: { directoryBrowse: true, workerDiff: true, worktreeAudit: true },
        machine: { name: "mac", memTotalMB: 16384, memFreeMB: 8192 },
        agents: [],
        repos: [
          {
            repoId: "/srv/repo",
            name: "repo",
            path: "/srv/repo",
            defaultBranch: "main",
            remote: "",
            capabilityKind: "git",
            writePolicy: { isolation: "worktree", concurrency: "serial" },
          },
        ],
        limits: { maxWorkers: 4, running: 0 },
        workers: [],
        pendingAcks: [],
      }).success,
    ).toBe(true);
  });
});
