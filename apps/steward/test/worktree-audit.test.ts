// Direction E Stage 2 unit & DO integration tests:
// - `048_repo_policy_and_worktree_audit` write-policy caching (readable even while machine is offline)
// - Steward cross-ledger classifier (`orphaned`, `stale_unmerged`, `recent_unmerged`, `idle_clean`, `active`, `external_unmanaged`)
// - `GET /app/api/machines/:deviceId/worktrees/audit` & `POST /app/api/machines/:deviceId/worktrees/cleanup`
//   CSRF/Origin gates, risk-confirmation gate, active-worker immunity, `sh_web_request` idempotency,
//   and `sh_worker.worktreeStatus = 'cleaned'` + Thread timeline reconciliation.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ledger, LedgerSql } from "../src/ledger.ts";
import { MIGRATIONS, runMigrations } from "../src/schema.ts";
import type { Steward } from "../src/steward.ts";
import { parseAuditStaleDays, type MachineWorktreeAuditResponse } from "../src/worktree-audit.ts";
import {
  configureAndBind,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitForWorkerState,
  webLogin,
} from "./helpers.ts";

const ORIGIN = ["https:", "", "example.com"].join("/");
const appUrl = (path: string): string => `${ORIGIN}${path}`;

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

describe("048_repo_policy_and_worktree_audit and Steward worktree audit/cleanup APIs (Direction E, Stage 2)", () => {
  it("caches repo write policies across offline transitions and classifies all worktree states accurately", async () => {
    const fake = await pairFakeConnector("mac-pro", {
      autorun: false,
      repos: [
        {
          repoId: "/srv/repo-serial",
          name: "repo-serial",
          path: "/srv/repo-serial",
          defaultBranch: "main",
          writePolicy: { isolation: "worktree", concurrency: "serial" },
          hasSetupHook: true,
          hasArchiveHook: true,
          approved: true,
          projectApproved: true,
        },
        {
          repoId: "/srv/plain-notes",
          name: "plain-notes",
          path: "/srv/plain-notes",
          capabilityKind: "plain",
          writePolicy: { isolation: "in-place", concurrency: "serial" },
        },
      ],
    });
    fake.worktreeAudit = true;
    await fake.connect();

    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: LedgerSql }).sql.bind(instance);
      expect(() => runMigrations(sql, MIGRATIONS)).not.toThrow();
    });

    // Seed real Steward threads & workers to cross-reference against Connector's scan:
    // 1. Active running worker (`w_running` on `t_running`)
    await ownerStub().dispatchForTest({
      prompt: "正在执行的任务",
      repoRef: "repo-serial",
      newTitle: "活跃任务",
    });
    const [cmdRun] = await fake.waitForCmds(1);
    const runningWorkerId = String((cmdRun!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmdRun!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmdRun!.id, ok: true, data: { sessionId: runningWorkerId, cwd: "/srv/repo-serial" } });
    await fake.emit("started", runningWorkerId, { sessionId: runningWorkerId, cwd: "/srv/repo-serial", branch: "otto/active-1" });
    await waitForWorkerState("running");

    const now = Date.now();
    let archivedWorkerId = "";
    let staleWorkerId = "";
    let cleanIdleWorkerId = "";
    let archivedThreadId = "";
    let cleanIdleThreadId = "";

    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const sql = (instance as unknown as { sql: LedgerSql }).sql.bind(instance);

      // 2. Archived thread whose worktree was kept (`orphan_archived`)
      const tArch = ledger.threads.create({ title: "已归档旧功能", goal: "旧实验", repoIds: ["/srv/repo-serial"] });
      archivedThreadId = tArch.threadId;
      archivedWorkerId = "w_arch_kept";
      ledger.workers.register({
        workerId: archivedWorkerId,
        threadId: tArch.threadId,
        deviceId: fake.deviceId,
        repoId: "/srv/repo-serial",
        agent: "pi",
        mode: "write",
        hasWorktree: true,
      });
      sql`UPDATE sh_worker SET state = 'idle', branch = 'otto/arch-1', updatedAt = ${now - 2 * 86_400_000} WHERE workerId = ${archivedWorkerId}`;
      ledger.threads.setArchived(tArch.threadId, true);

      // 3. Stale unmerged thread (> 10 days old, unarchived, idle)
      const tStale = ledger.threads.create({ title: "十天前未合并实验", goal: "实验特性", repoIds: ["/srv/repo-serial"] });
      staleWorkerId = "w_stale_unmerged";
      const tenDaysAgo = now - 10 * 86_400_000;
      ledger.workers.register({
        workerId: staleWorkerId,
        threadId: tStale.threadId,
        deviceId: fake.deviceId,
        repoId: "/srv/repo-serial",
        agent: "pi",
        mode: "write",
        hasWorktree: true,
      });
      sql`UPDATE sh_worker SET state = 'idle', branch = 'otto/stale-1', createdAt = ${tenDaysAgo}, lastEventAt = ${tenDaysAgo}, updatedAt = ${tenDaysAgo} WHERE workerId = ${staleWorkerId}`;
      sql`UPDATE sh_thread SET lastActivityAt = ${tenDaysAgo} WHERE threadId = ${tStale.threadId}`;

      // 4. Clean merged idle thread
      const tClean = ledger.threads.create({ title: "已合入主干任务", goal: "修复拼写", repoIds: ["/srv/repo-serial"] });
      cleanIdleThreadId = tClean.threadId;
      cleanIdleWorkerId = "w_clean_idle";
      ledger.workers.register({
        workerId: cleanIdleWorkerId,
        threadId: tClean.threadId,
        deviceId: fake.deviceId,
        repoId: "/srv/repo-serial",
        agent: "pi",
        mode: "write",
        hasWorktree: true,
      });
      sql`UPDATE sh_worker SET state = 'idle', branch = 'otto/merged-1', updatedAt = ${now - 86_400_000} WHERE workerId = ${cleanIdleWorkerId}`;
    });

    const cookie = await webLogin();
    const snapRes = await SELF.fetch(appUrl("/app/api/workspace"), { headers: { cookie } });
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      csrf: string;
      machines: Array<{
        id: string;
        online: boolean;
        repoPolicies: Array<{
          repoId: string;
          writeIsolation: string;
          writeConcurrency: string;
          hooksApproved: boolean;
          projectApproved: boolean;
        }>;
      }>;
    };
    const machineView = snap.machines.find((m) => m.id === fake.deviceId)!;
    expect(machineView.repoPolicies).toEqual([
      expect.objectContaining({
        repoId: "/srv/plain-notes",
        writeIsolation: "in-place",
        writeConcurrency: "serial",
      }),
      expect.objectContaining({
        repoId: "/srv/repo-serial",
        writeIsolation: "worktree",
        writeConcurrency: "serial",
        hooksApproved: true,
        projectApproved: true,
      }),
    ]);

    // Trigger GET /app/api/machines/:deviceId/worktrees/audit?staleDays=7
    const auditPromise = SELF.fetch(appUrl(`/app/api/machines/${fake.deviceId}/worktrees/audit?staleDays=7`), {
      headers: { cookie },
    });
    const [auditReq] = await fake.waitForWorktreeAuditRequests(1);
    const tenDaysAgo = now - 10 * 86_400_000;
    fake.send({
      t: "worktree_audit_result",
      re: auditReq!.id,
      ok: true,
      audit: {
        scannedAt: now,
        repos: [
          {
            repoId: "/srv/repo-serial",
            name: "repo-serial",
            path: "/srv/repo-serial",
            capabilityKind: "git",
            defaultBranch: "main",
            writeIsolation: "worktree",
            writeConcurrency: "serial",
            hasSetupHook: true,
            hasArchiveHook: true,
            hooksApproved: true,
            projectApproved: true,
            prunableCount: 1,
          },
        ],
        worktrees: [
          {
            repoId: "/srv/repo-serial",
            worktreeKey: "repo-serial-12345678/active-1",
            path: "/Users/dev/.otto/worktrees/repo-serial-12345678/active-1",
            managedByOtto: true,
            existsOnDisk: true,
            prunable: false,
            locked: false,
            detached: false,
            branch: "otto/active-1",
            headSha: "1".repeat(40),
            baseBranch: "main",
            dirty: true,
            modifiedCount: 2,
            untrackedCount: 0,
            ahead: 1,
            pushed: false,
            mergedIntoBase: false,
            lastCommitAt: now,
            diskBytes: 10_000_000,
            diskComplete: true,
            localWorkerId: runningWorkerId,
            localThreadId: null,
            localMode: "write",
            localState: "running",
            localLiveProcess: true,
            localUpdatedAt: now,
          },
          {
            repoId: "/srv/repo-serial",
            worktreeKey: "repo-serial-12345678/arch-1",
            path: "/Users/dev/.otto/worktrees/repo-serial-12345678/arch-1",
            managedByOtto: true,
            existsOnDisk: true,
            prunable: false,
            locked: false,
            detached: false,
            branch: "otto/arch-1",
            headSha: "2".repeat(40),
            baseBranch: "main",
            dirty: false,
            modifiedCount: 0,
            untrackedCount: 0,
            ahead: 0,
            pushed: true,
            mergedIntoBase: true,
            lastCommitAt: now - 3 * 86_400_000,
            diskBytes: 50_000_000,
            diskComplete: true,
            localWorkerId: archivedWorkerId,
            localThreadId: archivedThreadId,
            localMode: "write",
            localState: "idle",
            localLiveProcess: false,
            localUpdatedAt: now - 3 * 86_400_000,
          },
          {
            repoId: "/srv/repo-serial",
            worktreeKey: "repo-serial-12345678/crash-orphan",
            path: "/Users/dev/.otto/worktrees/repo-serial-12345678/crash-orphan",
            managedByOtto: true,
            existsOnDisk: true,
            prunable: false,
            locked: false,
            detached: true,
            branch: null,
            headSha: "3".repeat(40),
            baseBranch: "main",
            dirty: false,
            modifiedCount: 0,
            untrackedCount: 0,
            ahead: 0,
            pushed: true,
            mergedIntoBase: true,
            lastCommitAt: tenDaysAgo,
            diskBytes: 20_000_000,
            diskComplete: true,
            localWorkerId: null,
            localThreadId: null,
            localMode: null,
            localState: null,
            localLiveProcess: false,
            localUpdatedAt: null,
          },
          {
            repoId: "/srv/repo-serial",
            worktreeKey: "repo-serial-12345678/stale-1",
            path: "/Users/dev/.otto/worktrees/repo-serial-12345678/stale-1",
            managedByOtto: true,
            existsOnDisk: true,
            prunable: false,
            locked: false,
            detached: false,
            branch: "otto/stale-1",
            headSha: "4".repeat(40),
            baseBranch: "main",
            dirty: true,
            modifiedCount: 1,
            untrackedCount: 2,
            ahead: 3,
            pushed: false,
            mergedIntoBase: false,
            lastCommitAt: tenDaysAgo,
            diskBytes: 80_000_000,
            diskComplete: false,
            localWorkerId: staleWorkerId,
            localThreadId: null,
            localMode: "write",
            localState: "idle",
            localLiveProcess: false,
            localUpdatedAt: tenDaysAgo,
          },
          {
            repoId: "/srv/repo-serial",
            worktreeKey: "repo-serial-12345678/merged-1",
            path: "/Users/dev/.otto/worktrees/repo-serial-12345678/merged-1",
            managedByOtto: true,
            existsOnDisk: true,
            prunable: false,
            locked: false,
            detached: false,
            branch: "otto/merged-1",
            headSha: "5".repeat(40),
            baseBranch: "main",
            dirty: false,
            modifiedCount: 0,
            untrackedCount: 0,
            ahead: 2,
            pushed: true,
            mergedIntoBase: true,
            lastCommitAt: now - 86_400_000,
            diskBytes: 30_000_000,
            diskComplete: true,
            localWorkerId: cleanIdleWorkerId,
            localThreadId: cleanIdleThreadId,
            localMode: "write",
            localState: "idle",
            localLiveProcess: false,
            localUpdatedAt: now - 86_400_000,
          },
          {
            repoId: "/srv/repo-serial",
            worktreeKey: "ext:abcdef012345",
            path: "/Users/dev/manual-wt",
            managedByOtto: false,
            existsOnDisk: true,
            prunable: false,
            locked: false,
            detached: false,
            branch: "feat/manual",
            headSha: "6".repeat(40),
            baseBranch: "main",
            dirty: true,
            modifiedCount: 1,
            untrackedCount: 0,
            ahead: 1,
            pushed: false,
            mergedIntoBase: false,
            lastCommitAt: now,
            diskBytes: 15_000_000,
            diskComplete: true,
            localWorkerId: null,
            localThreadId: null,
            localMode: null,
            localState: null,
            localLiveProcess: false,
            localUpdatedAt: null,
          },
        ],
      },
    });

    const auditRes = await auditPromise;
    expect(auditRes.status).toBe(200);
    const body = (await auditRes.json()) as MachineWorktreeAuditResponse;

    expect(body.totals).toMatchObject({
      managedCount: 5,
      managedDiskBytes: 190_000_000,
      diskComplete: false,
      safeReclaimableCount: 3, // arch-1 (50M) + crash-orphan (20M) + merged-1 (30M)
      safeReclaimableBytes: 100_000_000,
      orphanedCount: 2,
      staleUnmergedCount: 1,
      idleCleanCount: 1,
      activeCount: 1,
      externalCount: 1,
      dirtyCount: 2,
      prunableCount: 1,
    });

    const byKey = new Map(body.items.map((i) => [i.worktreeKey, i]));
    expect(byKey.get("repo-serial-12345678/active-1")).toMatchObject({
      category: "active",
      selectable: false,
      safeCleanable: false,
    });
    expect(byKey.get("repo-serial-12345678/arch-1")).toMatchObject({
      category: "orphaned",
      orphanReason: "thread_archived",
      selectable: true,
      safeCleanable: true,
      requiresRiskConfirm: false,
    });
    expect(byKey.get("repo-serial-12345678/crash-orphan")).toMatchObject({
      category: "orphaned",
      orphanReason: "untracked_dir",
      selectable: true,
      safeCleanable: true,
      cleanupTarget: { kind: "orphan_dir", repoId: "/srv/repo-serial", worktreeKey: "repo-serial-12345678/crash-orphan" },
    });
    expect(byKey.get("repo-serial-12345678/stale-1")).toMatchObject({
      category: "stale_unmerged",
      selectable: true,
      safeCleanable: false,
      requiresRiskConfirm: true,
      highRisk: true,
    });
    expect(byKey.get("repo-serial-12345678/merged-1")).toMatchObject({
      category: "idle_clean",
      selectable: true,
      safeCleanable: true,
      requiresRiskConfirm: false,
    });
    expect(byKey.get("ext:abcdef012345")).toMatchObject({
      category: "external_unmanaged",
      selectable: false,
      cleanupTarget: null,
    });

    // Cleanup gate checks:
    const postHeaders = {
      cookie,
      origin: ORIGIN,
      "x-csrf-token": snap.csrf,
      "content-type": "application/json",
    };

    // 1) Missing Origin or CSRF -> 403 forbidden
    const noOrigin = await SELF.fetch(appUrl(`/app/api/machines/${fake.deviceId}/worktrees/cleanup`), {
      method: "POST",
      headers: { cookie, "x-csrf-token": snap.csrf, "content-type": "application/json" },
      body: JSON.stringify({ id: "req_no_origin_1", pruneRepoIds: ["/srv/repo-serial"] }),
    });
    expect(noOrigin.status).toBe(403);

    // 2) force: true WITHOUT confirmedRisks: true -> 400 risk_confirmation_required
    const noRiskAck = await SELF.fetch(appUrl(`/app/api/machines/${fake.deviceId}/worktrees/cleanup`), {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify({
        id: "req_missing_risk_ack",
        confirmedRisks: false,
        targets: [{ kind: "worker", repoId: "/srv/repo-serial", workerId: staleWorkerId, force: true }],
      }),
    });
    expect(noRiskAck.status).toBe(400);
    expect(await noRiskAck.json()).toEqual({ error: "risk_confirmation_required" });

    // 3) Active running worker -> 409 worker_active before hitting connector
    const activeCleanAttempt = await SELF.fetch(appUrl(`/app/api/machines/${fake.deviceId}/worktrees/cleanup`), {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify({
        id: "req_active_block",
        confirmedRisks: true,
        targets: [{ kind: "worker", repoId: "/srv/repo-serial", workerId: runningWorkerId, force: true }],
      }),
    });
    expect(activeCleanAttempt.status).toBe(409);
    expect(await activeCleanAttempt.json()).toMatchObject({ error: "worker_active", workerId: runningWorkerId });

    // 4) Valid safe cleanup + idempotency replay + ledger reconciliation (`worktreeStatus = 'cleaned'` + timeline note)
    const cleanPromise = SELF.fetch(appUrl(`/app/api/machines/${fake.deviceId}/worktrees/cleanup`), {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify({
        id: "req_clean_safe_batch_1",
        confirmedRisks: false,
        pruneRepoIds: ["/srv/repo-serial"],
        targets: [
          { kind: "worker", repoId: "/srv/repo-serial", workerId: archivedWorkerId, force: false },
          { kind: "orphan_dir", repoId: "/srv/repo-serial", worktreeKey: "repo-serial-12345678/crash-orphan", force: false },
        ],
      }),
    });
    const [cleanReq] = await fake.waitForWorktreeCleanupRequests(1);
    fake.send({
      t: "worktree_cleanup_result",
      re: cleanReq!.id,
      ok: true,
      result: {
        prunedRepoIds: ["/srv/repo-serial"],
        items: [
          {
            targetKey: `worker:${archivedWorkerId}`,
            kind: "worker",
            repoId: "/srv/repo-serial",
            workerId: archivedWorkerId,
            worktreeKey: "repo-serial-12345678/arch-1",
            branch: "otto/arch-1",
            status: "cleaned",
            freedBytes: 50_000_000,
          },
          {
            targetKey: "orphan:repo-serial-12345678/crash-orphan",
            kind: "orphan_dir",
            repoId: "/srv/repo-serial",
            workerId: null,
            worktreeKey: "repo-serial-12345678/crash-orphan",
            branch: null,
            status: "cleaned",
            freedBytes: 20_000_000,
          },
        ],
      },
    });

    const cleanRes = await cleanPromise;
    expect(cleanRes.status).toBe(200);
    const cleanBody = (await cleanRes.json()) as {
      ok: boolean;
      cleanedCount: number;
      freedBytes: number;
      prunedRepoIds: string[];
    };
    expect(cleanBody).toMatchObject({
      ok: true,
      cleanedCount: 2,
      freedBytes: 70_000_000,
      prunedRepoIds: ["/srv/repo-serial"],
    });

    // Retrying same request ID returns cached response without sending a 2nd frame to Connector
    const replayRes = await SELF.fetch(appUrl(`/app/api/machines/${fake.deviceId}/worktrees/cleanup`), {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify({
        id: "req_clean_safe_batch_1",
        confirmedRisks: false,
        pruneRepoIds: ["/srv/repo-serial"],
        targets: [
          { kind: "worker", repoId: "/srv/repo-serial", workerId: archivedWorkerId, force: false },
          { kind: "orphan_dir", repoId: "/srv/repo-serial", worktreeKey: "repo-serial-12345678/crash-orphan", force: false },
        ],
      }),
    });
    expect(replayRes.status).toBe(200);
    expect(fake.worktreeCleanupRequests).toHaveLength(1);

    // Verify Steward updated sh_worker.worktreeStatus and Thread timeline
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      expect(ledger.workers.get(archivedWorkerId)?.worktreeStatus).toBe("cleaned");
      const entries = ledger.timeline.list(archivedThreadId);
      expect(entries.some((e) => e.text.includes("已通过机器巡检清理工作树") && e.text.includes(archivedWorkerId))).toBe(true);
    });

    // Disconnect machine -> audit returns 409 machine_offline, while workspace snapshot STILL preserves repoPolicies!
    fake.close();
    await new Promise((r) => setTimeout(r, 50));

    const offlineAudit = await SELF.fetch(appUrl(`/app/api/machines/${fake.deviceId}/worktrees/audit`), {
      headers: { cookie },
    });
    expect(offlineAudit.status).toBe(409);
    expect(await offlineAudit.json()).toEqual({ error: "machine_offline" });

    const offlineSnapRes = await SELF.fetch(appUrl("/app/api/workspace"), { headers: { cookie } });
    const offlineSnap = (await offlineSnapRes.json()) as typeof snap;
    const offlineMachine = offlineSnap.machines.find((m) => m.id === fake.deviceId)!;
    expect(offlineMachine.online).toBe(false);
    expect(offlineMachine.repoPolicies).toHaveLength(2);

    expect(parseAuditStaleDays(null)).toBe(7);
    expect(parseAuditStaleDays("14")).toBe(14);
    expect(parseAuditStaleDays("0")).toBeNull();
    expect(parseAuditStaleDays("999")).toBeNull();
  });
});
