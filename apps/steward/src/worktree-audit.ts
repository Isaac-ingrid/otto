// Steward cross-ledger worktree audit classifier & cleanup reconciler (Direction E, Stage 2).
// Pure deterministic reconciliation between Connector's read-only filesystem/Git scan and
// Steward's `sh_worker`, `sh_thread`, `sh_pr_consent`, and `sh_repo` ledger rows. Zero LLM calls.
import type {
  RawAuditedWorktree,
  WorktreeAuditPayload,
  WorktreeCleanupItemOutcome,
  WorktreeCleanupPayload,
} from "@isaac2ingrid/protocol";
import { ACTIVE_WORKER_STATES, type Ledger, type WorkerRow } from "./ledger.ts";

export const DEFAULT_AUDIT_STALE_DAYS = 7;
export const MIN_AUDIT_STALE_DAYS = 1;
export const MAX_AUDIT_STALE_DAYS = 90;

export type WorktreeAuditCategory =
  | "orphaned"
  | "stale_unmerged"
  | "recent_unmerged"
  | "idle_clean"
  | "active"
  | "external_unmanaged";

export type WorktreeOrphanReason =
  | "untracked_dir"
  | "prunable_missing"
  | "thread_missing"
  | "thread_archived";

export interface AuditedRepoPolicyView {
  repoId: string;
  name: string;
  path: string;
  capabilityKind: "git" | "plain";
  defaultBranch: string | null;
  writeIsolation: "worktree" | "in-place";
  writeConcurrency: "parallel" | "serial";
  hasSetupHook: boolean;
  hasArchiveHook: boolean;
  hooksApproved: boolean;
  projectApproved: boolean;
  prunableCount: number;
  managedWorktreeCount: number;
  managedDiskBytes: number;
  diskComplete: boolean;
  safeReclaimableBytes: number;
  orphanedCount: number;
  staleUnmergedCount: number;
}

export interface AuditedWorktreeItemView {
  itemKey: string;
  cleanupTarget:
    | { kind: "worker"; repoId: string; workerId: string; expectedBranch?: string | null }
    | { kind: "orphan_dir"; repoId: string; worktreeKey: string; expectedBranch?: string | null }
    | null;
  repoId: string;
  repoName: string;
  worktreeKey: string;
  path: string;
  category: WorktreeAuditCategory;
  orphanReason: WorktreeOrphanReason | null;
  managedByOtto: boolean;
  existsOnDisk: boolean;
  prunable: boolean;
  locked: boolean;
  detached: boolean;
  branch: string | null;
  headSha: string | null;
  baseBranch: string | null;
  dirty: boolean;
  modifiedCount: number;
  untrackedCount: number;
  ahead: number;
  pushed: boolean;
  mergedIntoBase: boolean;
  unmerged: boolean;
  highRisk: boolean;
  selectable: boolean;
  safeCleanable: boolean;
  requiresRiskConfirm: boolean;
  lastCommitAt: number | null;
  lastActiveAt: number | null;
  ageDays: number | null;
  diskBytes: number;
  diskComplete: boolean;
  workerId: string | null;
  workerState: string | null;
  workerMode: string | null;
  threadId: string | null;
  threadTitle: string | null;
  threadState: string | null;
  threadArchived: boolean;
  prUrl: string | null;
}

export interface MachineWorktreeAuditResponse {
  deviceId: string;
  machineName: string;
  online: boolean;
  maxWorkers: number;
  runningWorkers: number;
  staleDays: number;
  scannedAt: number;
  truncated: boolean;
  totals: {
    managedCount: number;
    managedDiskBytes: number;
    diskComplete: boolean;
    safeReclaimableCount: number;
    safeReclaimableBytes: number;
    orphanedCount: number;
    staleUnmergedCount: number;
    recentUnmergedCount: number;
    idleCleanCount: number;
    activeCount: number;
    externalCount: number;
    dirtyCount: number;
    prunableCount: number;
  };
  repos: AuditedRepoPolicyView[];
  items: AuditedWorktreeItemView[];
}

export function parseAuditStaleDays(raw: string | null): number | null {
  if (raw === null || raw === "") return DEFAULT_AUDIT_STALE_DAYS;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_AUDIT_STALE_DAYS || parsed > MAX_AUDIT_STALE_DAYS) {
    return null;
  }
  return parsed;
}

const LOCAL_ACTIVE_STATES = new Set<string>(["queued", "starting", "running", "recovering", "lost"]);

const CATEGORY_SORT_RANK: Readonly<Record<WorktreeAuditCategory, number>> = {
  orphaned: 0,
  stale_unmerged: 1,
  recent_unmerged: 2,
  idle_clean: 3,
  active: 4,
  external_unmanaged: 5,
};

export function buildMachineWorktreeAuditResponse(input: {
  ledger: Ledger;
  deviceId: string;
  machineName: string;
  audit: WorktreeAuditPayload;
  staleDays: number;
  now: number;
}): MachineWorktreeAuditResponse {
  const { ledger, deviceId, machineName, audit, staleDays, now } = input;
  const machine = ledger.machines.get(deviceId);
  const maxWorkers = machine?.maxWorkers ?? 1;
  const runningWorkers = ledger.machines.runningCount(deviceId);
  const staleThresholdMs = staleDays * 86_400_000;

  const repoNameMap = new Map<string, string>();
  for (const r of audit.repos) repoNameMap.set(r.repoId, r.name);

  // Index Steward workers on this device for fast workerId & branch fallback lookup.
  const deviceWorkers: WorkerRow[] = [];
  for (const thread of ledger.threads.list({ includeArchived: true })) {
    for (const w of ledger.workers.listByThread(thread.threadId)) {
      if (w.deviceId === deviceId) {
        deviceWorkers.push(w);
      }
    }
  }
  const workerById = new Map(deviceWorkers.map((w) => [w.workerId, w]));

  const resolveStewardWorker = (wt: RawAuditedWorktree): WorkerRow | null => {
    if (wt.localWorkerId) {
      const exact = workerById.get(wt.localWorkerId);
      if (exact) return exact;
    }
    if (wt.branch) {
      const byBranch = deviceWorkers.filter(
        (w) => w.repoId === wt.repoId && w.branch === wt.branch && w.worktreeStatus !== "cleaned",
      );
      if (byBranch.length > 0) {
        return byBranch.sort((a, b) => b.createdAt - a.createdAt)[0]!;
      }
    }
    return null;
  };

  const items: AuditedWorktreeItemView[] = audit.worktrees.map((wt) => {
    const stewardWorker = resolveStewardWorker(wt);
    const resolvedThreadId = stewardWorker?.threadId ?? wt.localThreadId ?? null;
    const thread = resolvedThreadId ? ledger.threads.get(resolvedThreadId) : null;
    const prUrl = stewardWorker ? ledger.prConsent.branchState(stewardWorker.workerId).url : null;

    const effectiveMode = stewardWorker?.mode ?? wt.localMode ?? null;
    const isReadonlyDetached = effectiveMode === "readonly" && wt.detached;
    const unmerged = !isReadonlyDetached && wt.ahead > 0 && !wt.mergedIntoBase;
    const highRisk = wt.existsOnDisk && (wt.dirty || unmerged);

    const timestamps = [
      wt.lastCommitAt ?? 0,
      wt.localUpdatedAt ?? 0,
      stewardWorker?.lastEventAt ?? 0,
      stewardWorker?.createdAt ?? 0,
      thread?.lastActivityAt ?? 0,
    ].filter((v) => v > 0);
    const lastActiveAt = timestamps.length > 0 ? Math.max(...timestamps) : null;
    const ageMs = lastActiveAt !== null ? Math.max(0, now - lastActiveAt) : null;
    const ageDays = ageMs !== null ? Math.floor(ageMs / 86_400_000) : null;

    const isLocalActive = wt.localState !== null && LOCAL_ACTIVE_STATES.has(wt.localState);
    const isStewardActive =
      stewardWorker !== null && (ACTIVE_WORKER_STATES as readonly string[]).includes(stewardWorker.state);
    const isThreadBusy =
      thread !== null && !thread.archived && (thread.state === "running" || thread.state === "waiting_you");

    let category: WorktreeAuditCategory;
    let orphanReason: WorktreeOrphanReason | null = null;

    if (!wt.managedByOtto) {
      category = "external_unmanaged";
    } else if (isLocalActive || isStewardActive || isThreadBusy) {
      category = "active";
    } else if (!wt.existsOnDisk && !stewardWorker) {
      category = "orphaned";
      orphanReason = "prunable_missing";
    } else if (!stewardWorker && !wt.localWorkerId) {
      category = "orphaned";
      orphanReason = "untracked_dir";
    } else if (!thread) {
      category = "orphaned";
      orphanReason = stewardWorker || wt.localWorkerId ? "thread_missing" : "untracked_dir";
    } else if (thread.archived) {
      category = "orphaned";
      orphanReason = "thread_archived";
    } else if (highRisk) {
      const isStale = ageMs === null || ageMs >= staleThresholdMs;
      category = isStale ? "stale_unmerged" : "recent_unmerged";
    } else {
      category = "idle_clean";
    }

    const effectiveBranch = wt.branch ?? stewardWorker?.branch ?? null;
    const branchGuard = effectiveBranch ? { expectedBranch: effectiveBranch } : {};
    const cleanupTarget: AuditedWorktreeItemView["cleanupTarget"] =
      !wt.managedByOtto || category === "active"
        ? null
        : wt.localWorkerId
          ? { kind: "worker", repoId: wt.repoId, workerId: wt.localWorkerId, ...branchGuard }
          : wt.existsOnDisk
            ? { kind: "orphan_dir", repoId: wt.repoId, worktreeKey: wt.worktreeKey, ...branchGuard }
            : stewardWorker
              ? { kind: "worker", repoId: wt.repoId, workerId: stewardWorker.workerId, ...branchGuard }
              : null;

    const selectable = cleanupTarget !== null && !wt.locked;
    const safeCleanable =
      selectable &&
      !highRisk &&
      (category === "orphaned" || category === "idle_clean");
    const requiresRiskConfirm = selectable && highRisk;

    const itemKey =
      cleanupTarget?.kind === "worker"
        ? `worker:${cleanupTarget.workerId}`
        : `wt:${wt.repoId}:${wt.worktreeKey}`;

    return {
      itemKey,
      cleanupTarget,
      repoId: wt.repoId,
      repoName: repoNameMap.get(wt.repoId) ?? wt.repoId,
      worktreeKey: wt.worktreeKey,
      path: wt.path,
      category,
      orphanReason,
      managedByOtto: wt.managedByOtto,
      existsOnDisk: wt.existsOnDisk,
      prunable: wt.prunable,
      locked: wt.locked,
      detached: wt.detached,
      branch: effectiveBranch,
      headSha: wt.headSha,
      baseBranch: wt.baseBranch,
      dirty: wt.dirty,
      modifiedCount: wt.modifiedCount,
      untrackedCount: wt.untrackedCount,
      ahead: wt.ahead,
      pushed: wt.pushed,
      mergedIntoBase: wt.mergedIntoBase,
      unmerged,
      highRisk,
      selectable,
      safeCleanable,
      requiresRiskConfirm,
      lastCommitAt: wt.lastCommitAt,
      lastActiveAt,
      ageDays,
      diskBytes: wt.diskBytes,
      diskComplete: wt.diskComplete,
      workerId: stewardWorker?.workerId ?? wt.localWorkerId ?? null,
      workerState: stewardWorker?.state ?? wt.localState ?? null,
      workerMode: effectiveMode,
      threadId: thread?.threadId ?? resolvedThreadId,
      threadTitle: thread?.title ?? null,
      threadState: thread?.state ?? null,
      threadArchived: thread?.archived ?? false,
      prUrl,
    };
  });

  items.sort((a, b) => {
    const rankDiff = CATEGORY_SORT_RANK[a.category] - CATEGORY_SORT_RANK[b.category];
    if (rankDiff !== 0) return rankDiff;
    if (b.diskBytes !== a.diskBytes) return b.diskBytes - a.diskBytes;
    return a.path.localeCompare(b.path);
  });

  const repoAgg = new Map<
    string,
    {
      managedWorktreeCount: number;
      managedDiskBytes: number;
      diskComplete: boolean;
      safeReclaimableBytes: number;
      orphanedCount: number;
      staleUnmergedCount: number;
    }
  >();
  for (const r of audit.repos) {
    repoAgg.set(r.repoId, {
      managedWorktreeCount: 0,
      managedDiskBytes: 0,
      diskComplete: true,
      safeReclaimableBytes: 0,
      orphanedCount: 0,
      staleUnmergedCount: 0,
    });
  }

  let managedCount = 0;
  let managedDiskBytes = 0;
  let diskComplete = true;
  let safeReclaimableCount = 0;
  let safeReclaimableBytes = 0;
  let orphanedCount = 0;
  let staleUnmergedCount = 0;
  let recentUnmergedCount = 0;
  let idleCleanCount = 0;
  let activeCount = 0;
  let externalCount = 0;
  let dirtyCount = 0;

  for (const item of items) {
    if (!item.managedByOtto) {
      externalCount += 1;
      continue;
    }
    const agg = repoAgg.get(item.repoId);
    if (item.existsOnDisk) {
      managedCount += 1;
      managedDiskBytes += item.diskBytes;
      if (!item.diskComplete) diskComplete = false;
      if (agg) {
        agg.managedWorktreeCount += 1;
        agg.managedDiskBytes += item.diskBytes;
        if (!item.diskComplete) agg.diskComplete = false;
      }
    }
    if (item.dirty) dirtyCount += 1;
    if (item.safeCleanable) {
      safeReclaimableCount += 1;
      safeReclaimableBytes += item.diskBytes;
      if (agg) agg.safeReclaimableBytes += item.diskBytes;
    }
    switch (item.category) {
      case "orphaned":
        orphanedCount += 1;
        if (agg) agg.orphanedCount += 1;
        break;
      case "stale_unmerged":
        staleUnmergedCount += 1;
        if (agg) agg.staleUnmergedCount += 1;
        break;
      case "recent_unmerged":
        recentUnmergedCount += 1;
        break;
      case "idle_clean":
        idleCleanCount += 1;
        break;
      case "active":
        activeCount += 1;
        break;
      default:
        break;
    }
  }

  const prunableCount = audit.repos.reduce((sum, r) => sum + r.prunableCount, 0);

  const repos: AuditedRepoPolicyView[] = audit.repos.map((r) => {
    const agg = repoAgg.get(r.repoId)!;
    return {
      repoId: r.repoId,
      name: r.name,
      path: r.path,
      capabilityKind: r.capabilityKind,
      defaultBranch: r.defaultBranch,
      writeIsolation: r.writeIsolation,
      writeConcurrency: r.writeConcurrency,
      hasSetupHook: r.hasSetupHook,
      hasArchiveHook: r.hasArchiveHook,
      hooksApproved: r.hooksApproved,
      projectApproved: r.projectApproved,
      prunableCount: r.prunableCount,
      managedWorktreeCount: agg.managedWorktreeCount,
      managedDiskBytes: agg.managedDiskBytes,
      diskComplete: agg.diskComplete,
      safeReclaimableBytes: agg.safeReclaimableBytes,
      orphanedCount: agg.orphanedCount,
      staleUnmergedCount: agg.staleUnmergedCount,
    };
  });

  return {
    deviceId,
    machineName,
    online: true,
    maxWorkers,
    runningWorkers,
    staleDays,
    scannedAt: audit.scannedAt,
    truncated: Boolean(audit.truncated),
    totals: {
      managedCount,
      managedDiskBytes,
      diskComplete,
      safeReclaimableCount,
      safeReclaimableBytes,
      orphanedCount,
      staleUnmergedCount,
      recentUnmergedCount,
      idleCleanCount,
      activeCount,
      externalCount,
      dirtyCount,
      prunableCount,
    },
    repos,
    items,
  };
}

export interface ReconciledWorktreeCleanupResponse {
  ok: true;
  id: string;
  deviceId: string;
  items: WorktreeCleanupItemOutcome[];
  prunedRepoIds: string[];
  cleanedCount: number;
  freedBytes: number;
}

/**
 * Synchronizes settled cleanup outcomes from Connector back into Steward's `sh_worker`
 * (`worktreeStatus = 'cleaned'`) and `sh_timeline`.
 */
export function reconcileWorktreeCleanupOutcomes(
  ledger: Ledger,
  deviceId: string,
  requestId: string,
  payload: WorktreeCleanupPayload,
): ReconciledWorktreeCleanupResponse {
  let cleanedCount = 0;
  let freedBytes = 0;

  for (const item of payload.items) {
    if (item.status === "cleaned") {
      cleanedCount += 1;
      freedBytes += item.freedBytes ?? 0;
    }
    if (item.status !== "cleaned" && item.status !== "already_gone") continue;

    let worker: WorkerRow | null = item.workerId ? ledger.workers.get(item.workerId) : null;
    if (worker && worker.deviceId !== deviceId) worker = null;

    if (!worker && item.branch) {
      for (const thread of ledger.threads.list({ includeArchived: true })) {
        const match = ledger.workers
          .listByThread(thread.threadId)
          .find(
            (w) =>
              w.deviceId === deviceId &&
              w.repoId === item.repoId &&
              w.branch === item.branch &&
              w.worktreeStatus !== "cleaned",
          );
        if (match) {
          worker = match;
          break;
        }
      }
    }

    if (worker && worker.worktreeStatus !== "cleaned" && worker.worktreeStatus !== "none") {
      ledger.workers.setWorktreeStatus(worker.workerId, "cleaned");
      const branchLabel = item.branch ?? worker.branch;
      ledger.timeline.add(
        worker.threadId,
        "note",
        `已通过机器巡检清理工作树 ${worker.workerId}${branchLabel ? `（分支 ${branchLabel}）` : ""}`,
        {
          requestId,
          workerId: worker.workerId,
          cleanedViaAudit: true,
        },
      );
    }
  }

  return {
    ok: true,
    id: requestId,
    deviceId,
    items: payload.items,
    prunedRepoIds: payload.prunedRepoIds,
    cleanedCount,
    freedBytes,
  };
}
