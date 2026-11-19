import { SELF, runInDurableObject } from "cloudflare:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureAndBind,
  messageEvent,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitForWorkerState,
  waitRunsSettled,
  webLogin,
} from "./helpers.ts";

const ORIGIN = "https://example.com";

async function openSession() {
  const cookie = await webLogin();
  const getWorkspace = async (includeArchived = false) => {
    const url = `${ORIGIN}/app/api/workspace${includeArchived ? "?includeArchived=1" : ""}`;
    const res = await SELF.fetch(url, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      csrf: string;
      archivedCount: number;
      threads: Array<{
        id: string;
        archived: boolean;
        workers: Array<{ id: string; branch: string | null; worktreeStatus: string }>;
      }>;
    };
  };
  const snap = await getWorkspace();
  const archive = (threadId: string, body: Record<string, unknown>) =>
    SELF.fetch(`${ORIGIN}/app/api/threads/${threadId}/archive`, {
      method: "POST",
      headers: {
        cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": snap.csrf,
      },
      body: JSON.stringify(body),
    });
  return { cookie, csrf: snap.csrf, getWorkspace, archive };
}

describe("Thread 5-state archive & cleanup_worktree Outbox loop", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await configureAndBind();
  });

  it("rejects archiving active threads (409 thread_active) and auto-cleans pushed or zero-change write worktrees", async () => {
    const connector = await pairFakeConnector("mac-archive", { autorun: false });
    await connector.connect();
    const d1 = await ownerStub().dispatchForTest({
      prompt: "active task",
      repoRef: "repo-a",
      newTitle: "运行中任务",
    });
    expect(d1.kind).toBe("dispatched");
    const threadId = d1.kind === "dispatched" ? d1.threadId : "";
    const workerId = d1.kind === "dispatched" ? d1.workerId : "";
    const [startCmd] = await connector.waitForCmds(1);

    const { archive, getWorkspace } = await openSession();
    // State 1: active worker rejects with 409 thread_active
    const activeRes = await archive(threadId, { id: "req-active-01", archived: true });
    expect(activeRes.status).toBe(409);
    expect(await activeRes.json()).toMatchObject({ error: "thread_active", activeWorkers: [workerId] });

    // Finish worker as pushed & clean -> State 4 auto-cleans with force: false
    connector.send({ t: "cmd_ack", re: startCmd!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: startCmd!.id, ok: true, data: { sessionId: workerId, branch: "otto/clean-1" } });
    await connector.emit("started", workerId, { sessionId: workerId, branch: "otto/clean-1" });
    await connector.emit("report", workerId, {
      status: "done",
      summary: "已推送",
      git: { branch: "otto/clean-1", base: "main", ahead: 2, dirty: 0, filesChanged: 1, insertions: 4, deletions: 0, pushed: true },
    });
    await connector.emit("settled", workerId, { outcome: "reported" });
    await waitForWorkerState("idle");

    const okRes = await archive(threadId, { id: "req-clean-01", archived: true });
    expect(okRes.status).toBe(200);
    const archivedJson = await okRes.json();
    expect(archivedJson).toEqual({
      id: "req-clean-01",
      threadId,
      archived: true,
      cleanedWorkers: [workerId],
      queuedWorkers: [],
      keptWorkers: [],
    });
    // Idempotent retry returns exact same result without a second command
    expect(await (await archive(threadId, { id: "req-clean-01", archived: true })).json()).toEqual(archivedJson);

    const [, cleanupCmd] = await connector.waitForCmds(2);
    expect(cleanupCmd).toMatchObject({ kind: "cleanup_worktree", workerId, args: { workerId } });
    connector.send({ t: "cmd_ack", re: cleanupCmd!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: cleanupCmd!.id, ok: true, data: {} });
    await new Promise((r) => setTimeout(r, 30));

    const activeView = await getWorkspace(false);
    expect(activeView.threads).toHaveLength(0);
    expect(activeView.archivedCount).toBe(1);
    const allView = await getWorkspace(true);
    expect(allView.threads).toHaveLength(1);
    expect(allView.threads[0]).toMatchObject({ id: threadId, archived: true });
    expect(allView.threads[0]!.workers[0]!.worktreeStatus).toBe("cleaned");
  });

  it("blocks unmerged worktrees on auto (409 worktree_unmerged), supports keep/force, queues offline, and handles cmd_result secondary guard", async () => {
    const connector = await pairFakeConnector("mac-unmerged", { run: { pushed: false, ahead: 2, dirty: 1 } });
    await connector.connect();
    const d1 = await ownerStub().dispatchForTest({
      prompt: "unmerged work",
      repoRef: "repo-a",
      newTitle: "未合并分支",
    });
    expect(d1.kind).toBe("dispatched");
    const { threadId, workerId } = await waitForWorkerState("idle");
    const { archive, getWorkspace } = await openSession();

    // State 5: auto rejects with 409 worktree_unmerged + structured unmergedWorkers
    const autoRes = await archive(threadId, { id: "req-unmerged-auto", archived: true });
    expect(autoRes.status).toBe(409);
    expect(await autoRes.json()).toMatchObject({
      error: "worktree_unmerged",
      unmergedWorkers: [{ workerId, ahead: 2, dirty: 1, cleanupBlocked: false }],
    });

    // Offline machine + force: queues cleanup_worktree(force: true) in Outbox, survives sweepIdle, delivers on reconnect
    connector.close();
    await new Promise((r) => setTimeout(r, 30));
    const forceOfflineRes = await archive(threadId, {
      id: "req-unmerged-force",
      archived: true,
      cleanupPolicy: "force",
    });
    expect(forceOfflineRes.status).toBe(200);
    expect(await forceOfflineRes.json()).toMatchObject({
      archived: true,
      cleanedWorkers: [],
      queuedWorkers: [workerId],
      keptWorkers: [],
    });
    await ownerStub().sweepIdle();
    const outboxBefore = await ownerStub().outboxRow(`cleanup:${threadId}:${workerId}:req-unmerged-force`);
    expect(outboxBefore?.state).toBe("queued");

    // Reconnect: hello redelivers cleanup_worktree while keeping worktreeStatus='cleaning'
    connector.workers = [
      { workerId, agent: "pi", state: "idle", lastSeq: 4, sessionId: workerId, lastOutcome: "reported:done", hasWorktree: true },
    ];
    await connector.connect();
    const [, forceCmd] = await connector.waitForCmds(2);
    expect(forceCmd).toMatchObject({
      kind: "cleanup_worktree",
      workerId,
      args: { workerId, force: true },
    });

    // Secondary guard: if archive_hook_failed or worktree_dirty comes back, worktreeStatus -> 'cleanup_blocked'
    connector.send({ t: "cmd_ack", re: forceCmd!.id, status: "accepted" });
    connector.send({
      t: "cmd_result",
      re: forceCmd!.id,
      ok: false,
      error: { code: "archive_hook_failed", message: "hook exited 1" },
    });
    await new Promise((r) => setTimeout(r, 30));
    const blockedView = await getWorkspace(true);
    expect(blockedView.threads[0]!.workers[0]!.worktreeStatus).toBe("cleanup_blocked");

    // Unarchive then re-archive with keep -> 0 new commands, keptWorkers=[workerId]
    expect((await archive(threadId, { id: "req-unarchive-01", archived: false })).status).toBe(200);
    const keepRes = await archive(threadId, { id: "req-keep-01", archived: true, cleanupPolicy: "keep" });
    expect(keepRes.status).toBe(200);
    expect(await keepRes.json()).toMatchObject({ archived: true, keptWorkers: [workerId], cleanedWorkers: [] });
  });

  it("opens a new session with handoff brief after unarchiving a cleaned worktree, and guards archive_thread tool", async () => {
    const connector = await pairFakeConnector("mac-relay", {
      run: { pushed: false, ahead: 1, dirty: 0, branch: "otto/discarded-1" },
    });
    connector.queueRun({ pushed: true, ahead: 1, dirty: 0, branch: "otto/fresh-2" });
    await connector.connect();

    await ownerStub().dispatchForTest({
      prompt: "first attempt",
      repoRef: "repo-a",
      newTitle: "归档后续派",
    });
    const { threadId, workerId } = await waitForWorkerState("idle");
    await runInDurableObject(ownerStub(), (inst) => {
      (inst as unknown as { ctx: { storage: { sql: { exec: (q: string) => void } } } }).ctx.storage.sql.exec("DELETE FROM sh_wake");
    });
    const { archive } = await openSession();

    // LLM archive_thread refuses force when owner message did NOT ask to discard/force
    await scriptModel(
      fauxAssistantMessage(
        [
          fauxToolCall("archive_thread", {
            threadId,
            archived: true,
            cleanupPolicy: "force",
            basis: "user_explicit",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("需要你先确认是否丢弃未合并变更。"),
    );
    await postEvent(messageEvent({ msgId: "om_arch_plain", text: `把 ${threadId} 归档吧` }));
    await waitRunsSettled();
    expect((await ownerStub().debugSnapshot()).threads).toHaveLength(1); // still NOT archived

    // Owner explicitly authorizes discarding unmerged changes -> archive_thread(force) succeeds
    await scriptModel(
      fauxAssistantMessage(
        [
          fauxToolCall("archive_thread", {
            threadId,
            archived: true,
            cleanupPolicy: "force",
            basis: "user_explicit",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已按你的要求强制清理工作树并归档。"),
    );
    await postEvent(messageEvent({ msgId: "om_arch_force", text: `把 ${threadId} 强制清理丢弃未合并变更并归档` }));
    await waitRunsSettled();

    const [, cleanupCmd] = await connector.waitForCmds(2);
    connector.send({ t: "cmd_ack", re: cleanupCmd!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: cleanupCmd!.id, ok: true, data: {} });
    await new Promise((r) => setTimeout(r, 30));

    // Unarchive and continue on the same Thread: MUST start a new session (reason: worktree_cleaned)
    // and omit the force-deleted branch from `base` while still prefixing 【交接简报】
    await archive(threadId, { id: "req-reopen-02", archived: false });
    const cont = await ownerStub().dispatchForTest({
      prompt: "start fresh leg",
      repoRef: "repo-a",
      threadId,
    });
    expect(cont).toMatchObject({
      kind: "dispatched",
      threadId,
      continuation: {
        action: "new_session",
        reason: "worktree_cleaned",
        parentWorker: workerId,
        brief: true,
      },
    });
    const [, , secondStartCmd] = await connector.waitForCmds(3);
    expect(secondStartCmd!.kind).toBe("start_worker");
    expect((secondStartCmd!.args as Record<string, unknown>).base).toBeUndefined();
    expect(String((secondStartCmd!.args as Record<string, unknown>).prompt)).toContain("【交接简报】");
  });

  it("auto-cleans readonly relay worktrees and preserves pushed branches as base after unarchiving", async () => {
    const connector = await pairFakeConnector("mac-ro", {
      run: { pushed: true, ahead: 2, dirty: 0, branch: "otto/pushed-1" },
    });
    connector.queueRun({ noBranch: true, summary: "评审通过" }); // readonly review leg on base otto/pushed-1
    connector.queueRun({ pushed: false, ahead: 1, dirty: 0, branch: "otto/next-3" });
    await connector.connect();

    const w1 = await ownerStub().dispatchForTest({
      prompt: "write leg",
      repoRef: "repo-a",
      newTitle: "读写接力归档",
    });
    const threadId = w1.kind === "dispatched" ? w1.threadId : "";
    const writeWorkerId = w1.kind === "dispatched" ? w1.workerId : "";
    await waitForWorkerState("idle");

    const w2 = await ownerStub().dispatchForTest({
      prompt: "review leg",
      repoRef: "repo-a",
      threadId,
      mode: "readonly",
    });
    expect(w2.kind).toBe("dispatched");
    const roWorkerId = w2.kind === "dispatched" ? w2.workerId : "";
    await new Promise((r) => setTimeout(r, 80));

    const { archive } = await openSession();
    // Both pushed write leg and readonly detached-worktree leg auto-clean with force: false!
    const archRes = await archive(threadId, { id: "req-ro-clean", archived: true });
    expect(archRes.status).toBe(200);
    expect(await archRes.json()).toMatchObject({
      archived: true,
      cleanedWorkers: [writeWorkerId, roWorkerId],
      queuedWorkers: [],
      keptWorkers: [],
    });

    const cmds = await connector.waitForCmds(4);
    for (const c of cmds.slice(2)) {
      connector.send({ t: "cmd_ack", re: c.id, status: "accepted" });
      connector.send({ t: "cmd_result", re: c.id, ok: true, data: {} });
    }
    await new Promise((r) => setTimeout(r, 30));

    // Unarchive and continue write work: new session branches from surviving otto/pushed-1!
    await archive(threadId, { id: "req-ro-reopen", archived: false });
    const w3 = await ownerStub().dispatchForTest({
      prompt: "continue on pushed branch",
      repoRef: "repo-a",
      threadId,
      mode: "write",
    });
    expect(w3).toMatchObject({
      kind: "dispatched",
      continuation: {
        action: "new_session",
        base: "otto/pushed-1",
        brief: true,
      },
    });
  });
});
