// Read-only machine worktree inspection & controlled cleanup engine (Direction E).
// Invariants (ADR-0022):
// 1. Audit is strictly read-only (`git --no-optional-locks`, never runs `prune` or modifies files).
// 2. Any deletion is physically confined inside `realpath(join(stateDir, "worktrees"))` at exact
//    2-level depth `<repoName>-<pathHash>/<slug>`. External user worktrees and main checkouts are
//    immune (`forbidden_path`).
// 3. Running/queued/lost workers are immune (`worker_active`), even with `force: true`.
// 4. Live git dirty / unmerged status is re-verified immediately before removal (TOCTOU guard)
//    and requires both `target.force === true` and `confirmedRisks === true`.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, opendir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  WORKTREE_AUDIT_MAX_ITEMS,
  isValidManagedWorktreeKey,
  type RawAuditedRepo,
  type RawAuditedWorktree,
  type WorktreeAuditArgs,
  type WorktreeAuditResult,
  type WorktreeCleanupArgs,
  type WorktreeCleanupItemOutcome,
  type WorktreeCleanupResult,
  type WorktreeCleanupTarget,
} from "@isaac2ingrid/protocol";
import { HookExecutionError, repoHookCapabilitySummary } from "./hooks.ts";
import type { LocalStore, RegisteredRepo, WorkerRow } from "./store.ts";
import { managedRepoBucketName } from "./worktree.ts";

const exec = promisify(execFile);

export const DEFAULT_MAX_STAT_ENTRIES_PER_WORKTREE = 25_000;
const GIT_READ_TIMEOUT_MS = 15_000;
const GIT_MUTATE_TIMEOUT_MS = 30_000;
const ACTIVE_LOCAL_STATES = new Set(["starting", "running", "recovering", "lost", "queued"]);

interface PorcelainWorktreeEntry {
  path: string;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
}

export interface WorktreeAuditDeps {
  store: LocalStore;
  stateDir: string;
  now?: () => number;
  maxStatEntriesPerWorktree?: number;
  isLiveProcess?: (worker: WorkerRow) => boolean;
}

export interface WorktreeCleanupDeps extends WorktreeAuditDeps {
  stopIdleProcess?: (worker: WorkerRow) => Promise<void>;
  runArchiveHook?: (repo: RegisteredRepo, worker: WorkerRow, worktreePath: string) => Promise<void>;
}

async function gitRead(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["--no-optional-locks", ...args], {
      cwd,
      timeout: GIT_READ_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function gitMutate(cwd: string, args: string[]): Promise<void> {
  await exec("git", args, {
    cwd,
    timeout: GIT_MUTATE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export function parsePorcelainWorktreeList(raw: string): PorcelainWorktreeEntry[] {
  const entries: PorcelainWorktreeEntry[] = [];
  const blocks = raw.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    let wtPath: string | null = null;
    let headSha: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let locked = false;
    let prunable = false;
    let bare = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        headSha = line.slice("HEAD ".length).trim() || null;
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "detached") {
        detached = true;
      } else if (line === "locked" || line.startsWith("locked ")) {
        locked = true;
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        prunable = true;
      } else if (line === "bare") {
        bare = true;
      }
    }
    if (wtPath) {
      entries.push({ path: wtPath, headSha, branch, detached, locked, prunable, bare });
    }
  }
  return entries;
}

async function canonicalPathOrResolved(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

function isStrictPrefixDir(parentDir: string, childPath: string): boolean {
  const prefix = parentDir.endsWith(sep) ? parentDir : `${parentDir}${sep}`;
  return childPath.startsWith(prefix);
}

/**
 * Verifies whether `candidatePath` is strictly a 2-level managed child directory
 * `<worktreesRoot>/<expectedBucket>/<slug>`, with no symlink escape and never equal to `repoPath`.
 */
async function inspectManagedContainment(
  worktreesRoot: string,
  expectedBucket: string,
  repoPath: string,
  candidatePath: string,
): Promise<{ managed: boolean; worktreeKey: string; exists: boolean; isSymlink: boolean }> {
  const resolvedRoot = resolve(worktreesRoot);
  const canonicalRoot = await canonicalPathOrResolved(resolvedRoot);
  const canonicalRepo = await canonicalPathOrResolved(repoPath);
  const resolvedCandidate = resolve(candidatePath);

  let exists = false;
  let isSymlink = false;
  try {
    const st = await lstat(resolvedCandidate);
    isSymlink = st.isSymbolicLink();
    exists = st.isDirectory() && !isSymlink;
  } catch {
    exists = false;
  }

  const extKey = () => `ext:${createHash("sha256").update(resolvedCandidate).digest("hex").slice(0, 12)}`;
  if (isSymlink) {
    return { managed: false, worktreeKey: extKey(), exists: false, isSymlink: true };
  }

  const slug = basename(resolvedCandidate);
  if (
    !slug ||
    slug === "." ||
    slug === ".." ||
    resolvedCandidate === resolve(repoPath)
  ) {
    return { managed: false, worktreeKey: extKey(), exists, isSymlink: false };
  }

  const canonicalBucket = await canonicalPathOrResolved(join(canonicalRoot, expectedBucket));
  const canonicalParent = await canonicalPathOrResolved(dirname(resolvedCandidate));
  if (canonicalParent !== canonicalBucket) {
    return { managed: false, worktreeKey: extKey(), exists, isSymlink: false };
  }

  const candidateKey = `${expectedBucket}/${slug}`;
  if (!isValidManagedWorktreeKey(candidateKey)) {
    return { managed: false, worktreeKey: extKey(), exists, isSymlink: false };
  }

  if (exists) {
    const canonicalCandidate = await canonicalPathOrResolved(resolvedCandidate);
    if (
      canonicalCandidate === canonicalRepo ||
      !isStrictPrefixDir(canonicalRoot, canonicalCandidate) ||
      dirname(canonicalCandidate) !== canonicalBucket
    ) {
      return { managed: false, worktreeKey: extKey(), exists, isSymlink: false };
    }
  }

  return { managed: true, worktreeKey: candidateKey, exists, isSymlink: false };
}

export async function measureDirectoryBytesBounded(
  dirPath: string,
  maxEntries = DEFAULT_MAX_STAT_ENTRIES_PER_WORKTREE,
): Promise<{ diskBytes: number; diskComplete: boolean }> {
  let diskBytes = 0;
  let seenEntries = 0;
  const stack: string[] = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let dir;
    try {
      dir = await opendir(current);
    } catch {
      continue;
    }
    try {
      for await (const dirent of dir) {
        seenEntries += 1;
        if (seenEntries > maxEntries) {
          return { diskBytes, diskComplete: false };
        }
        if (dirent.isSymbolicLink()) continue;
        const full = join(current, dirent.name);
        if (dirent.isDirectory()) {
          stack.push(full);
        } else if (dirent.isFile()) {
          try {
            const st = await lstat(full);
            if (!st.isSymbolicLink() && st.isFile()) {
              diskBytes += st.size;
            }
          } catch {
            // Transiently removed file during read-only scan: ignore safely.
          }
        }
      }
    } catch {
      // Directory closed or unreadable: continue remaining branches.
    }
  }

  return { diskBytes, diskComplete: true };
}

interface LiveGitWorktreeState {
  validGitWorktree: boolean;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  modifiedCount: number;
  untrackedCount: number;
  ahead: number;
  pushed: boolean;
  mergedIntoBase: boolean;
  lastCommitAt: number | null;
}

async function inspectLiveGitWorktreeState(
  repoPath: string,
  wtPath: string,
  baseBranch: string | null,
  repoDefaultBranch: string | null,
): Promise<LiveGitWorktreeState> {
  const inside = (await gitRead(wtPath, ["rev-parse", "--is-inside-work-tree"]))?.trim();
  if (inside !== "true") {
    // Broken or half-removed orphan folder with no valid `.git` link: treat non-empty files as
    // untracked dirty files so cleanup never wipes leftover content without explicit confirmation.
    let looseFiles = 0;
    try {
      const items = await readdir(wtPath);
      looseFiles = items.filter((name) => name !== ".git").length;
    } catch {
      looseFiles = 0;
    }
    return {
      validGitWorktree: false,
      headSha: null,
      branch: null,
      detached: true,
      dirty: looseFiles > 0,
      modifiedCount: 0,
      untrackedCount: looseFiles,
      ahead: 0,
      pushed: false,
      mergedIntoBase: looseFiles === 0,
      lastCommitAt: null,
    };
  }

  const [headRaw, symBranchRaw, statusRaw, commitTsRaw] = await Promise.all([
    gitRead(wtPath, ["rev-parse", "HEAD"]),
    gitRead(wtPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitRead(wtPath, ["status", "--porcelain=v1", "-uall"]),
    gitRead(wtPath, ["log", "-1", "--format=%ct"]),
  ]);

  const headSha = headRaw?.trim() || null;
  const branch = symBranchRaw?.trim() || null;
  const detached = branch === null;

  let modifiedCount = 0;
  let untrackedCount = 0;
  if (statusRaw !== null) {
    for (const line of statusRaw.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("?? ")) untrackedCount += 1;
      else modifiedCount += 1;
    }
  }
  const dirty = modifiedCount + untrackedCount > 0;

  const parsedSec = commitTsRaw ? Number(commitTsRaw.trim()) : NaN;
  const lastCommitAt = Number.isFinite(parsedSec) && parsedSec > 0 ? Math.trunc(parsedSec * 1000) : null;

  let ahead = 0;
  let mergedIntoBase = false;
  const compareRef = baseBranch || repoDefaultBranch;
  if (headSha && compareRef) {
    const resolvedBase = (await gitRead(repoPath, ["rev-parse", "--verify", "--quiet", `${compareRef}^{commit}`]))?.trim();
    if (resolvedBase) {
      const aheadRaw = await gitRead(wtPath, ["rev-list", "--count", `${resolvedBase}..HEAD`]);
      const parsedAhead = aheadRaw ? Number(aheadRaw.trim()) : NaN;
      ahead = Number.isFinite(parsedAhead) && parsedAhead >= 0 ? Math.trunc(parsedAhead) : 0;
      if (ahead === 0) {
        mergedIntoBase = true;
      }
    }
  }
  if (!mergedIntoBase && headSha && repoDefaultBranch && repoDefaultBranch !== branch) {
    const resolvedDefault = (
      await gitRead(repoPath, ["rev-parse", "--verify", "--quiet", `${repoDefaultBranch}^{commit}`])
    )?.trim();
    if (resolvedDefault) {
      const defaultAheadRaw = await gitRead(repoPath, ["rev-list", "--count", `${resolvedDefault}..${headSha}`]);
      if (defaultAheadRaw?.trim() === "0") {
        mergedIntoBase = true;
      }
    }
  }

  let pushed = ahead === 0;
  if (!pushed && headSha) {
    const remoteContains = (await gitRead(wtPath, ["branch", "-r", "--contains", headSha]))?.trim() ?? "";
    pushed = remoteContains.length > 0;
  }

  return {
    validGitWorktree: true,
    headSha,
    branch,
    detached,
    dirty,
    modifiedCount,
    untrackedCount,
    ahead,
    pushed,
    mergedIntoBase,
    lastCommitAt,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function collectWorktreeAudit(
  deps: WorktreeAuditDeps,
  args: WorktreeAuditArgs = {},
): Promise<WorktreeAuditResult> {
  const now = deps.now ?? Date.now;
  const maxEntries = deps.maxStatEntriesPerWorktree ?? DEFAULT_MAX_STAT_ENTRIES_PER_WORKTREE;
  const worktreesRoot = join(deps.stateDir, "worktrees");

  let repos = deps.store.listRepos();
  if (args.repoId !== undefined) {
    const target = deps.store.getRepo(args.repoId);
    if (!target) return { ok: false, code: "not_registered_repo" };
    repos = [target];
  }

  const allWorkers = deps.store.listWorkers();
  const workerByNormalizedPath = new Map<string, WorkerRow>();
  for (const w of allWorkers) {
    if (!w.worktree) continue;
    workerByNormalizedPath.set(resolve(w.worktree), w);
  }

  const auditedRepos: RawAuditedRepo[] = [];
  const candidateJobs: Array<{
    repo: RegisteredRepo;
    repoDefaultBranch: string | null;
    bucket: string;
    path: string;
    porcelain: PorcelainWorktreeEntry | null;
  }> = [];

  for (const repo of repos) {
    const hookSummary = repoHookCapabilitySummary(repo, deps.stateDir);
    const repoDefaultBranch = repo.capability.kind === "git" ? repo.capability.defaultBranch : null;
    let prunableCount = 0;

    if (repo.capability.kind === "git") {
      const bucket = managedRepoBucketName(repo.path);
      const canonicalRepoPath = await canonicalPathOrResolved(repo.path);
      const seenPaths = new Set<string>();

      const rawList = await gitRead(repo.path, ["worktree", "list", "--porcelain"]);
      const parsedEntries = rawList ? parsePorcelainWorktreeList(rawList) : [];
      for (const entry of parsedEntries) {
        if (entry.bare) continue;
        const canonicalEntryPath = await canonicalPathOrResolved(entry.path);
        if (canonicalEntryPath === canonicalRepoPath || resolve(entry.path) === resolve(repo.path)) {
          // Primary working directory of the registered repository — never a worktree candidate.
          continue;
        }
        const exists = existsSync(entry.path);
        if (entry.prunable || !exists) {
          prunableCount += 1;
        }
        const norm = resolve(entry.path);
        seenPaths.add(canonicalEntryPath);
        seenPaths.add(norm);
        candidateJobs.push({
          repo,
          repoDefaultBranch,
          bucket,
          path: norm,
          porcelain: entry,
        });
      }

      // Also scan `<stateDir>/worktrees/<bucket>/*` on disk for leftover directories that are no
      // longer in `git worktree list` (e.g. partial creation crash or manual `git worktree prune`).
      const bucketDir = join(worktreesRoot, bucket);
      try {
        const dirents = await readdir(bucketDir, { withFileTypes: true });
        for (const dirent of dirents) {
          if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
          const full = resolve(bucketDir, dirent.name);
          const canonicalFull = dirent.isSymbolicLink() ? full : await canonicalPathOrResolved(full);
          if (seenPaths.has(full) || seenPaths.has(canonicalFull)) continue;
          seenPaths.add(full);
          seenPaths.add(canonicalFull);
          candidateJobs.push({
            repo,
            repoDefaultBranch,
            bucket,
            path: full,
            porcelain: null,
          });
        }
      } catch {
        // Bucket directory does not exist yet when no worktrees were ever created for this repo.
      }
    }

    auditedRepos.push({
      repoId: repo.repoId,
      name: repo.name,
      path: repo.path,
      capabilityKind: hookSummary.capabilityKind,
      defaultBranch: repoDefaultBranch,
      writeIsolation: repo.writePolicy.isolation,
      writeConcurrency: repo.writePolicy.concurrency,
      hasSetupHook: hookSummary.hasSetupHook,
      hasArchiveHook: hookSummary.hasArchiveHook,
      hooksApproved: hookSummary.approved,
      projectApproved: repo.approved === true,
      prunableCount,
    });
  }

  const truncated = candidateJobs.length > WORKTREE_AUDIT_MAX_ITEMS;
  const boundedJobs = candidateJobs.slice(0, WORKTREE_AUDIT_MAX_ITEMS);

  const auditedWorktrees = await mapWithConcurrency(boundedJobs, 3, async (job): Promise<RawAuditedWorktree> => {
    const containment = await inspectManagedContainment(
      worktreesRoot,
      job.bucket,
      job.repo.path,
      job.path,
    );

    let matchedWorker = workerByNormalizedPath.get(job.path) ?? null;
    if (!matchedWorker && containment.exists) {
      const canonicalCandidate = await canonicalPathOrResolved(job.path);
      for (const w of allWorkers) {
        if (!w.worktree) continue;
        if ((await canonicalPathOrResolved(w.worktree)) === canonicalCandidate) {
          matchedWorker = w;
          break;
        }
      }
    }

    const baseBranch = matchedWorker?.base ?? job.repoDefaultBranch ?? null;

    let liveGit: LiveGitWorktreeState = {
      validGitWorktree: false,
      headSha: job.porcelain?.headSha ?? null,
      branch: job.porcelain?.branch ?? matchedWorker?.branch ?? null,
      detached: job.porcelain?.detached ?? false,
      dirty: false,
      modifiedCount: 0,
      untrackedCount: 0,
      ahead: 0,
      pushed: false,
      mergedIntoBase: !containment.exists,
      lastCommitAt: null,
    };
    let diskBytes = 0;
    let diskComplete = true;

    if (containment.exists) {
      const [inspectedGit, measuredDisk] = await Promise.all([
        inspectLiveGitWorktreeState(job.repo.path, job.path, baseBranch, job.repoDefaultBranch),
        measureDirectoryBytesBounded(job.path, maxEntries),
      ]);
      liveGit = {
        ...inspectedGit,
        branch: inspectedGit.branch ?? job.porcelain?.branch ?? matchedWorker?.branch ?? null,
        headSha: inspectedGit.headSha ?? job.porcelain?.headSha ?? null,
      };
      diskBytes = measuredDisk.diskBytes;
      diskComplete = measuredDisk.diskComplete;
    }

    const localMode =
      matchedWorker?.mode === "readonly"
        ? "readonly"
        : matchedWorker?.mode === "write"
          ? "write"
          : null;
    const localLiveProcess = matchedWorker ? Boolean(deps.isLiveProcess?.(matchedWorker)) : false;

    return {
      repoId: job.repo.repoId,
      worktreeKey: containment.worktreeKey,
      path: job.path,
      managedByOtto: containment.managed,
      existsOnDisk: containment.exists,
      prunable: Boolean(job.porcelain?.prunable) || !containment.exists,
      locked: Boolean(job.porcelain?.locked),
      detached: liveGit.detached,
      branch: liveGit.branch,
      headSha: liveGit.headSha,
      baseBranch,
      dirty: liveGit.dirty,
      modifiedCount: liveGit.modifiedCount,
      untrackedCount: liveGit.untrackedCount,
      ahead: liveGit.ahead,
      pushed: liveGit.pushed,
      mergedIntoBase: liveGit.mergedIntoBase,
      lastCommitAt: liveGit.lastCommitAt,
      diskBytes,
      diskComplete,
      localWorkerId: matchedWorker?.workerId ?? null,
      localThreadId: matchedWorker?.threadId ?? null,
      localMode,
      localState: matchedWorker?.state ?? null,
      localLiveProcess,
      localUpdatedAt: matchedWorker?.updatedAt ?? matchedWorker?.createdAt ?? null,
    };
  });

  return {
    ok: true,
    audit: {
      scannedAt: now(),
      repos: auditedRepos,
      worktrees: auditedWorktrees,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

export async function executeWorktreeCleanup(
  deps: WorktreeCleanupDeps,
  args: WorktreeCleanupArgs,
): Promise<WorktreeCleanupResult> {
  const worktreesRoot = join(deps.stateDir, "worktrees");
  const confirmedRisks = args.confirmedRisks === true;
  const allWorkers = deps.store.listWorkers();
  const outcomes: WorktreeCleanupItemOutcome[] = [];
  const reposToPrune = new Set<string>();

  for (const repoId of args.pruneRepoIds ?? []) {
    const repo = deps.store.getRepo(repoId);
    if (repo && repo.capability.kind === "git") {
      reposToPrune.add(repo.repoId);
    }
  }

  for (const target of args.targets) {
    outcomes.push(
      await cleanupSingleTarget({
        deps,
        worktreesRoot,
        confirmedRisks,
        allWorkers,
        target,
        reposToPrune,
      }),
    );
  }

  const prunedRepoIds: string[] = [];
  for (const repoId of reposToPrune) {
    const repo = deps.store.getRepo(repoId);
    if (!repo || repo.capability.kind !== "git") continue;
    try {
      await gitMutate(repo.path, ["worktree", "prune"]);
      prunedRepoIds.push(repoId);
    } catch {
      // Best-effort prune after individual target outcomes are settled.
    }
  }

  return {
    ok: true,
    result: {
      items: outcomes,
      prunedRepoIds,
    },
  };
}

async function cleanupSingleTarget(input: {
  deps: WorktreeCleanupDeps;
  worktreesRoot: string;
  confirmedRisks: boolean;
  allWorkers: WorkerRow[];
  target: WorktreeCleanupTarget;
  reposToPrune: Set<string>;
}): Promise<WorktreeCleanupItemOutcome> {
  const { deps, worktreesRoot, confirmedRisks, allWorkers, target, reposToPrune } = input;
  const targetKey = target.kind === "worker" ? `worker:${target.workerId}` : `orphan:${target.worktreeKey}`;

  const repo = deps.store.getRepo(target.repoId);
  if (!repo || repo.capability.kind !== "git") {
    return {
      targetKey,
      kind: target.kind,
      repoId: target.repoId,
      workerId: target.kind === "worker" ? target.workerId : null,
      worktreeKey: target.kind === "orphan_dir" ? target.worktreeKey : null,
      branch: null,
      status: "not_registered_repo",
    };
  }

  const expectedBucket = managedRepoBucketName(repo.path);
  const repoDefaultBranch = repo.capability.defaultBranch;

  let matchedWorker: WorkerRow | null = null;
  let candidatePath: string | null = null;

  if (target.kind === "worker") {
    matchedWorker = deps.store.getWorker(target.workerId);
    if (!matchedWorker || matchedWorker.repoId !== repo.repoId) {
      return {
        targetKey,
        kind: "worker",
        repoId: repo.repoId,
        workerId: target.workerId,
        worktreeKey: null,
        branch: null,
        status: "already_gone",
      };
    }
    if (ACTIVE_LOCAL_STATES.has(matchedWorker.state)) {
      return {
        targetKey,
        kind: "worker",
        repoId: repo.repoId,
        workerId: matchedWorker.workerId,
        worktreeKey: null,
        branch: matchedWorker.branch ?? null,
        status: "worker_active",
      };
    }
    if (!matchedWorker.worktree) {
      return {
        targetKey,
        kind: "worker",
        repoId: repo.repoId,
        workerId: matchedWorker.workerId,
        worktreeKey: null,
        branch: matchedWorker.branch ?? null,
        status: "already_gone",
      };
    }
    candidatePath = resolve(matchedWorker.worktree);
  } else {
    if (!isValidManagedWorktreeKey(target.worktreeKey)) {
      return {
        targetKey,
        kind: "orphan_dir",
        repoId: repo.repoId,
        workerId: null,
        worktreeKey: target.worktreeKey,
        branch: null,
        status: "forbidden_path",
      };
    }
    const [bucketPart, slugPart, ...extra] = target.worktreeKey.split("/");
    if (extra.length > 0 || bucketPart !== expectedBucket || !slugPart) {
      return {
        targetKey,
        kind: "orphan_dir",
        repoId: repo.repoId,
        workerId: null,
        worktreeKey: target.worktreeKey,
        branch: null,
        status: "forbidden_path",
      };
    }
    candidatePath = resolve(worktreesRoot, expectedBucket, slugPart);
    matchedWorker =
      allWorkers.find((w) => w.worktree && resolve(w.worktree) === candidatePath) ?? null;
    if (matchedWorker && ACTIVE_LOCAL_STATES.has(matchedWorker.state)) {
      return {
        targetKey,
        kind: "orphan_dir",
        repoId: repo.repoId,
        workerId: matchedWorker.workerId,
        worktreeKey: target.worktreeKey,
        branch: matchedWorker.branch ?? null,
        status: "worker_active",
      };
    }
  }

  const containment = await inspectManagedContainment(worktreesRoot, expectedBucket, repo.path, candidatePath);
  if (!containment.managed || containment.isSymlink) {
    return {
      targetKey,
      kind: target.kind,
      repoId: repo.repoId,
      workerId: matchedWorker?.workerId ?? null,
      worktreeKey: target.kind === "orphan_dir" ? target.worktreeKey : null,
      branch: matchedWorker?.branch ?? null,
      status: "forbidden_path",
    };
  }

  reposToPrune.add(repo.repoId);

  if (!containment.exists) {
    if (matchedWorker) {
      deps.store.clearWorkerWorktree(matchedWorker.workerId);
    }
    return {
      targetKey,
      kind: target.kind,
      repoId: repo.repoId,
      workerId: matchedWorker?.workerId ?? null,
      worktreeKey: containment.worktreeKey,
      branch: matchedWorker?.branch ?? null,
      status: "already_gone",
    };
  }

  // Live TOCTOU re-inspection immediately before mutating anything on disk:
  const baseBranch = matchedWorker?.base ?? repoDefaultBranch ?? null;
  const [liveGit, measuredDisk] = await Promise.all([
    inspectLiveGitWorktreeState(repo.path, candidatePath, baseBranch, repoDefaultBranch),
    measureDirectoryBytesBounded(candidatePath, DEFAULT_MAX_STAT_ENTRIES_PER_WORKTREE),
  ]);

  const effectiveBranch = liveGit.branch ?? matchedWorker?.branch ?? null;
  if (
    target.expectedBranch !== undefined &&
    target.expectedBranch !== null &&
    effectiveBranch !== null &&
    target.expectedBranch !== effectiveBranch
  ) {
    return {
      targetKey,
      kind: target.kind,
      repoId: repo.repoId,
      workerId: matchedWorker?.workerId ?? null,
      worktreeKey: containment.worktreeKey,
      branch: effectiveBranch,
      status: "branch_mismatch",
    };
  }

  const isReadonlyDetached = matchedWorker?.mode === "readonly" && liveGit.detached;
  const unmerged = !isReadonlyDetached && liveGit.ahead > 0 && !liveGit.mergedIntoBase;
  const allowHighRisk = target.force === true && confirmedRisks === true;

  if (!allowHighRisk) {
    if (liveGit.dirty) {
      return {
        targetKey,
        kind: target.kind,
        repoId: repo.repoId,
        workerId: matchedWorker?.workerId ?? null,
        worktreeKey: containment.worktreeKey,
        branch: effectiveBranch,
        status: "blocked_dirty",
      };
    }
    if (unmerged) {
      return {
        targetKey,
        kind: target.kind,
        repoId: repo.repoId,
        workerId: matchedWorker?.workerId ?? null,
        worktreeKey: containment.worktreeKey,
        branch: effectiveBranch,
        status: "blocked_unmerged",
      };
    }
  }

  // Reclaim any idle-hot agent process holding `cwd` inside this settled worktree.
  if (matchedWorker && deps.stopIdleProcess) {
    await deps.stopIdleProcess(matchedWorker).catch(() => undefined);
    const refreshed = deps.store.getWorker(matchedWorker.workerId);
    if (refreshed && ACTIVE_LOCAL_STATES.has(refreshed.state)) {
      return {
        targetKey,
        kind: target.kind,
        repoId: repo.repoId,
        workerId: matchedWorker.workerId,
        worktreeKey: containment.worktreeKey,
        branch: effectiveBranch,
        status: "worker_active",
      };
    }
  }

  // Run approved local archive hook for write worktrees (preserving worktree if hook fails).
  if (
    matchedWorker &&
    matchedWorker.mode === "write" &&
    Boolean(effectiveBranch) &&
    repo.hooks.archiveHook !== null &&
    deps.runArchiveHook
  ) {
    try {
      await deps.runArchiveHook(repo, matchedWorker, candidatePath);
    } catch (err) {
      const msg =
        err instanceof HookExecutionError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        targetKey,
        kind: target.kind,
        repoId: repo.repoId,
        workerId: matchedWorker.workerId,
        worktreeKey: containment.worktreeKey,
        branch: effectiveBranch,
        status: "hook_failed",
        message: msg.slice(0, 320),
      };
    }
  }

  try {
    if (liveGit.validGitWorktree) {
      await gitMutate(repo.path, ["worktree", "remove", "--force", candidatePath]).catch(async () => {
        // Fallback when git's administrative link is already broken: safe because `containment`
        // proved `candidatePath` is strictly `<worktreesRoot>/<bucket>/<slug>` and not a symlink.
        await rm(candidatePath, { recursive: true, force: true });
      });
    } else {
      await rm(candidatePath, { recursive: true, force: true });
    }
    if (existsSync(candidatePath)) {
      await rm(candidatePath, { recursive: true, force: true });
    }
  } catch (err) {
    return {
      targetKey,
      kind: target.kind,
      repoId: repo.repoId,
      workerId: matchedWorker?.workerId ?? null,
      worktreeKey: containment.worktreeKey,
      branch: effectiveBranch,
      status: "failed",
      message: (err instanceof Error ? err.message : String(err)).slice(0, 320),
    };
  }

  if (
    effectiveBranch &&
    effectiveBranch.startsWith("otto/") &&
    (liveGit.mergedIntoBase || liveGit.ahead === 0 || allowHighRisk)
  ) {
    await gitMutate(repo.path, ["branch", "-D", effectiveBranch]).catch(() => undefined);
  }

  if (matchedWorker) {
    deps.store.clearWorkerWorktree(matchedWorker.workerId);
  }

  return {
    targetKey,
    kind: target.kind,
    repoId: repo.repoId,
    workerId: matchedWorker?.workerId ?? null,
    worktreeKey: containment.worktreeKey,
    branch: effectiveBranch,
    status: "cleaned",
    freedBytes: measuredDisk.diskBytes,
  };
}
