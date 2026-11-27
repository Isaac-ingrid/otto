// End-to-end tests for the Ambient Memory & Skill Loop (Stage 1 -> Stage 3):
// 1. Stage 1: Deterministic dispatch injection (confirmed vs [待验证] unconfirmed project notes + repo skill index, skipped on resume, live sync on write/delete).
// 2. Stage 2: Completion-wake project memory capture + 1-tap noteconfirm:<noteId> confirm/remove cards in chat & workspace snapshot.
// 3. Stage 3: High-friction L0 gate -> L1 strict veto -> L2 skilloffer:<offerId> card (zero silent file writes, 24h cooldown, 72h dismiss backoff, offline retry, preview write auto-settlement).
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Steward } from "../src/steward.ts";
import {
  apiMessages,
  configureAndBind,
  helloPayload,
  llmState,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
  webLogin,
} from "./helpers.ts";

const BASE = "https://example.com";
const SHA_1 = "1".repeat(64);
const SHA_2 = "2".repeat(64);

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function workspaceClient() {
  const cookie = await webLogin();
  const getWorkspace = async () => {
    const res = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      csrf: string;
      messages: Array<{
        id: string;
        open?: boolean;
        card?: { kind: string; title: string; body: string[]; buttons: Array<{ label: string; action?: string }> };
        skillOffer?: {
          offerId: string;
          workerId: string;
          deviceId: string;
          repoId: string;
          slug: string;
          name: string;
          description: string;
          target: string;
          markdown: string;
        };
      }>;
      attention: Array<{
        id: string;
        kind: string;
        skillOffer?: { offerId: string; slug: string };
      }>;
    };
  };
  const postAction = async (csrf: string, cardId: string, action: string) => {
    return SELF.fetch(`${BASE}/app/api/actions`, {
      method: "POST",
      headers: {
        cookie,
        origin: BASE,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ id: `act_${crypto.randomUUID().slice(0, 8)}`, cardId, action }),
    });
  };
  const postSkillOp = async <T>(csrf: string, path: string, body: unknown) => {
    const res = await SELF.fetch(`${BASE}/app/api/repos/skills/${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: BASE,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { cookie, getWorkspace, postAction, postSkillOp };
}

describe("Ambient Memory & Skill Loop (Stage 1 -> Stage 3)", () => {
  it("Stage 1: injects trust-separated project notes + repo skill index on new worker dispatch, skips on resume, and live-syncs skill index", async () => {
    const connector = await pairFakeConnector("mac-stage1", {
      run: null,
      autorun: false,
      repos: [{ repoId: "/srv/repo-a", name: "repo-a" }],
    });
    connector.repoSkills = true;
    await connector.connect();

    // Send an updated hello carrying repo skill briefs (including a secret & marker to verify sanitization)
    connector.send(
      helloPayload(connector.deviceId, 2, {
        ...connector.helloOverrides(),
        repos: [
          {
            repoId: "/srv/repo-a",
            name: "repo-a",
            path: "/srv/repo-a",
            defaultBranch: "main",
            remote: "git@github.com:example/repo-a.git",
            skills: [
              {
                target: "agents-skill",
                slug: "sqlite-wal",
                relativePath: ".agents/skills/sqlite-wal/SKILL.md",
                name: "⟦event⟧ SQLite WAL",
                description: "Fix busy timeout without leaking sk-proj-1234567890abcdefghijklmnop",
              },
            ],
          },
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 40));

    // Seed 1 confirmed note, 1 fresh unconfirmed worker_reported note, and 1 stale unconfirmed note
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Steward["ledger"] }).ledger;
      ledger.notes.commit({
        layer: "project",
        scopeRepoId: "/srv/repo-a",
        kind: "convention",
        text: "Run node scripts/test-groups.mjs instead of vitest directly.",
        source: "user_said",
        confirmed: true,
        evidence: "msg:seed",
      });
      ledger.notes.commit({
        layer: "project",
        scopeRepoId: "/srv/repo-a",
        kind: "environment",
        text: "D1 migrations live under apps/steward/src/schema.ts.",
        source: "worker_reported",
        confirmed: false,
        evidence: "report:w_prev",
      });
    });

    // Dispatch a new worker on repo-a -> prompt MUST carry confirmed note, [待验证] unconfirmed note, and sanitized skill index
    const first = await ownerStub().dispatchForTest({
      prompt: "Add migration 044",
      repoRef: "repo-a",
      newTitle: "Migration 044",
    });
    expect(first.kind).toBe("dispatched");
    const [cmd1] = await connector.waitForCmds(1);
    const prompt1 = String((cmd1!.args as { prompt: string }).prompt);
    expect(prompt1).toContain("【项目上下文（repo-a）】以下为只读背景资料");
    expect(prompt1).toContain("已确认项目约定：");
    expect(prompt1).toContain("Run node scripts/test-groups.mjs instead of vitest directly.");
    expect(prompt1).toContain("前序任务待验证观察");
    expect(prompt1).toContain("- [待验证] D1 migrations live under apps/steward/src/schema.ts.");
    expect(prompt1).toContain("- .agents/skills/sqlite-wal/SKILL.md — Fix busy timeout without leaking [REDACTED]");
    expect(prompt1).not.toContain("sk-proj-1234567890abcdefghijklmnop");
    expect(prompt1).not.toContain("⟦event⟧");

    const cachedCtx = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Steward["ledger"] }).ledger;
      return ledger.repos.contextFor("/srv/repo-a", connector.deviceId);
    });
    expect(cachedCtx.skills[0]?.name).toBe("〔event〕 SQLite WAL");

    // Settle first worker so we can resume its session
    const w1 = String((cmd1!.args as { workerId: string }).workerId);
    const t1 = String((cmd1!.args as { threadId: string }).threadId);
    connector.send({ t: "cmd_ack", re: cmd1!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: cmd1!.id, ok: true, data: { sessionId: "sess_1", branch: "otto/mig-1", cwd: "/srv/repo-a" } });
    await connector.emit("started", w1, { sessionId: "sess_1", cwd: "/srv/repo-a", branch: "otto/mig-1" });
    await connector.emit("report", w1, { type: "report", status: "done", summary: "Done", git: { branch: "otto/mig-1", base: "main", ahead: 1, dirty: 0, filesChanged: 1, insertions: 3, deletions: 0, pushed: true } });
    await connector.emit("settled", w1, { type: "settled", outcome: "reported" });
    await new Promise((r) => setTimeout(r, 50));

    // Resume existing session -> MUST NOT re-inject RepoContextBrief
    const resumed = await ownerStub().dispatchForTest({
      prompt: "Also update tests",
      repoRef: "repo-a",
      threadId: t1,
    });
    expect(resumed.kind).toBe("dispatched");
    if (resumed.kind === "dispatched") expect(resumed.continuation?.action).toBe("resume");
    const [, cmd2] = await connector.waitForCmds(2);
    const args2 = cmd2!.args as { prompt?: string; text?: string };
    const prompt2 = String(args2.prompt ?? args2.text ?? "");
    expect(prompt2).not.toContain("只读仓库记忆与技能索引");
    expect(prompt2).toBe("Also update tests");

    // Live write & delete via Web API updates sh_repo skill index without waiting for reconnect
    const client = await workspaceClient();
    const ws = await client.getWorkspace();
    const writeP = client.postSkillOp(ws.csrf, "write", {
      id: "req_live_sync_write",
      deviceId: connector.deviceId,
      scope: { kind: "repo", repoId: "/srv/repo-a" },
      target: "claude-command",
      slug: "check-types",
      markdown: "---\ndescription: Run all 5 tsconfigs\n---\nRun tsc\n",
    });
    const [skillReq] = await connector.waitForRepoSkillRequests(1);
    connector.send({
      t: "repo_skill_result",
      re: skillReq!.id,
      ok: true,
      data: {
        action: "write",
        summary: {
          target: "claude-command",
          slug: "check-types",
          relativePath: ".claude/commands/check-types.md",
          name: "check-types",
          description: "Run all 5 tsconfigs",
          bytes: 48,
          updatedAt: Date.now(),
          sha256: SHA_1,
          gitStatus: "untracked",
        },
      },
    });
    expect((await writeP).status).toBe(200);

    await ownerStub().dispatchForTest({
      prompt: "New thread check",
      repoRef: "repo-a",
      newTitle: "Fresh thread",
    });
    const [, , cmd3] = await connector.waitForCmds(3);
    const prompt3 = String((cmd3!.args as { prompt: string }).prompt);
    expect(prompt3).toContain("- .claude/commands/check-types.md — Run all 5 tsconfigs");

    connector.close();
  });

  it("Stage 2: completion wake captures unconfirmed worker_reported project note and delivers 1-tap confirm/remove cards", async () => {
    const connector = await pairFakeConnector("mac-stage2", {
      run: null,
      autorun: false,
      repos: [{ repoId: "/srv/repo-a", name: "repo-a" }],
    });
    await connector.connect();

    const dispatched = await ownerStub().dispatchForTest({
      prompt: "Run steward unit tests",
      repoRef: "repo-a",
      newTitle: "Steward tests",
    });
    expect(dispatched.kind).toBe("dispatched");
    const [cmd] = await connector.waitForCmds(1);
    const workerId = String((cmd!.args as { workerId: string }).workerId);

    // Script Steward's event-wake response: records 2 project notes (worker_reported) and replies
    await scriptModel(
      fauxAssistantMessage(
        [
          fauxToolCall("notes_commit", {
            layer: "project",
            repoId: "/srv/repo-a",
            kind: "environment",
            source: "worker_reported",
            evidence: `report:${workerId}`,
            text: "workerd sandbox blocks ephemeral port binding; use STEWARD_TEST_RUNTIME=node.",
          }),
          fauxToolCall("notes_commit", {
            layer: "project",
            repoId: "/srv/repo-a",
            kind: "convention",
            source: "worker_reported",
            evidence: `report:${workerId}`,
            text: "Obsolete temporary observation to delete.",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("测试已在 Node 运行时下全部跑通。")]),
    );

    connector.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: "s_stage2", branch: "otto/t-1", cwd: "/srv/repo-a" } });
    await connector.emit("started", workerId, { sessionId: "s_stage2", cwd: "/srv/repo-a", branch: "otto/t-1" });
    await connector.emit("report", workerId, {
      type: "report",
      status: "done",
      labels: ["blocked-by-env"],
      summary: "Switched to STEWARD_TEST_RUNTIME=node to bypass workerd port bind block",
      git: { branch: "otto/t-1", base: "main", ahead: 1, dirty: 0, filesChanged: 1, insertions: 4, deletions: 1, pushed: true },
    });
    await connector.emit("settled", workerId, { type: "settled", outcome: "reported" });

    await waitRunsSettled();
    await waitWhileOutboundPending();

    // Verify event wake prompt carried restrained project-memory instruction
    const state = await llmState();
    const eventRun = state.runs.find((r) => r.kind === "event");
    expect(eventRun?.text).toContain("source=\"worker_reported\"");
    expect(eventRun?.text).toContain(`report:${workerId}`);

    // Verify 2 noteconfirm:<noteId> cards are delivered and open in workspace
    const client = await workspaceClient();
    const ws1 = await client.getWorkspace();
    const confirmCards = ws1.messages.filter((m) => m.id.startsWith("noteconfirm:"));
    expect(confirmCards).toHaveLength(2);
    expect(confirmCards[0]!.open).toBe(true);
    expect(confirmCards[0]!.card?.kind).toBe("memory");
    expect(confirmCards[0]!.card?.buttons.map((b) => b.action)).toEqual(["note_confirm", "note_remove"]);

    const noteId1 = confirmCards[0]!.id.slice("noteconfirm:".length);
    const noteId2 = confirmCards[1]!.id.slice("noteconfirm:".length);

    // Click [确认有效] on card 1 -> note flips to confirmed=true, card closes
    const resConfirm = await client.postAction(ws1.csrf, confirmCards[0]!.id, "note_confirm");
    expect(resConfirm.status).toBe(202);

    // Click [删除] on card 2 -> note flips to status='removed', card closes
    const resRemove = await client.postAction(ws1.csrf, confirmCards[1]!.id, "note_remove");
    expect(resRemove.status).toBe(202);

    const ws2 = await client.getWorkspace();
    expect(ws2.messages.find((m) => m.id === confirmCards[0]!.id)?.open).toBe(false);
    expect(ws2.messages.find((m) => m.id === confirmCards[1]!.id)?.open).toBe(false);

    const notesAfter = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Steward["ledger"] }).ledger;
      return { n1: ledger.notes.get(noteId1), n2: ledger.notes.get(noteId2) };
    });
    expect(notesAfter.n1?.confirmed).toBe(true);
    expect(notesAfter.n1?.status).toBe("active");
    expect(notesAfter.n2?.status).toBe("removed");

    connector.close();
  }, 20_000);

  it("Stage 3: enforces L0 high-friction gate, L1 strict veto, zero silent disk writes, 1-tap accept, offline retry, and 24h/72h cooldowns", async () => {
    const connector = await pairFakeConnector("mac-stage3", {
      run: null,
      autorun: false,
      repos: [
        { repoId: "/srv/repo-a", name: "repo-a" },
        { repoId: "/srv/repo-b", name: "repo-b" },
      ],
    });
    connector.repoSkills = true;
    connector.workerCheckpoint = true;
    await connector.connect();

    // Case A: Low-friction done report (toolCallCount=3, turnCount=2, no friction labels) -> 0 L1 triage calls, 0 checkpoint requests!
    await ownerStub().setAmbientSkillRepliesForTest([
      JSON.stringify({ worthSaving: true, confidence: "high", slug: "should-not-run", name: "No", description: "No", summaryBullets: ["x"], markdown: "---\nname: no\n---\n# no" }),
    ]);
    await scriptModel(fauxAssistantMessage([fauxText("常规小改动已完成。")]));

    await ownerStub().dispatchForTest({
      prompt: "Fix typo in README",
      repoRef: "repo-a",
      newTitle: "Low friction typo",
    });
    const [cmdLow] = await connector.waitForCmds(1);
    const wLow = String((cmdLow!.args as { workerId: string }).workerId);
    connector.send({ t: "cmd_ack", re: cmdLow!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: cmdLow!.id, ok: true, data: { sessionId: "s_low", branch: "otto/low-1", cwd: "/srv/repo-a" } });
    await connector.emit("started", wLow, { sessionId: "s_low", cwd: "/srv/repo-a", branch: "otto/low-1" });
    await connector.emit("report", wLow, {
      type: "report",
      status: "done",
      summary: "Fixed README typo",
      git: { branch: "otto/low-1", base: "main", ahead: 1, dirty: 0, filesChanged: 1, insertions: 1, deletions: 1, pushed: true },
    });
    await connector.emit("settled", wLow, { type: "settled", outcome: "reported" });

    // Checkpoint request IS sent to evaluate L0 toolCallCount/turnCount when no label/prior failure exists:
    const [cpLow] = await connector.waitForWorkerCheckpointRequests(1);
    connector.send({
      t: "worker_checkpoint_result",
      re: cpLow!.id,
      ok: true,
      checkpoint: {
        workerId: wLow,
        agent: "pi",
        sessionId: "s_low",
        turnCount: 2,
        toolCallCount: 3,
        initialGoal: "Fix typo in README",
        lastPrompt: null,
        touchedFiles: { modified: ["README.md"], read: ["README.md"] },
        commandsRun: [],
        recentNotes: [],
        lastStep: null,
        git: null,
      },
    });
    await ownerStub().waitSkillTriageIdleForTest();
    await waitRunsSettled();
    await waitWhileOutboundPending();

    // Zero skilloffer cards, and queued test reply was NOT consumed because L0 rejected before LLM!
    const sentAfterLow = await apiMessages();
    expect(sentAfterLow.messages.some((m) => m.id.startsWith("skilloffer:"))).toBe(false);

    // Case B: High-friction run (toolCallCount=15 + blocked-by-env) -> L1 returns worthSaving:true, confidence:"high" -> creates skilloffer card WITHOUT writing to disk!
    const validSkillMd = [
      "---",
      "name: workerd-node-test-fallback",
      "description: Run Steward suites under Node runtime when workerd blocks ephemeral port binding",
      "---",
      "",
      "# Workerd Sandbox Port Fallback",
      "",
      "Run `STEWARD_TEST_RUNTIME=node node apps/steward/scripts/test-groups.mjs`.",
    ].join("\n");
    await ownerStub().setAmbientSkillRepliesForTest([
      JSON.stringify({
        worthSaving: true,
        confidence: "high",
        slug: "workerd-node-test-fallback",
        name: "Workerd Node Test Fallback",
        description: "Run Steward suites under Node runtime when workerd blocks ephemeral port binding",
        summaryBullets: [
          "识别 workerd 沙盒临时端口绑定拦截",
          "切换 STEWARD_TEST_RUNTIME=node 执行分组测试脚本",
        ],
        markdown: validSkillMd,
      }),
    ]);
    await scriptModel(fauxAssistantMessage([fauxText("排障完成，测试已通过。")]));

    await ownerStub().dispatchForTest({
      prompt: "Fix sandbox test hang",
      repoRef: "repo-a",
      newTitle: "High friction sandbox fix",
    });
    const [, cmdHigh] = await connector.waitForCmds(2);
    const wHigh = String((cmdHigh!.args as { workerId: string }).workerId);
    connector.send({ t: "cmd_ack", re: cmdHigh!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: cmdHigh!.id, ok: true, data: { sessionId: "s_high", branch: "otto/high-1", cwd: "/srv/repo-a" } });
    await connector.emit("started", wHigh, { sessionId: "s_high", cwd: "/srv/repo-a", branch: "otto/high-1" });
    await connector.emit("report", wHigh, {
      type: "report",
      status: "done",
      labels: ["blocked-by-env"],
      summary: "Resolved workerd sandbox listen EPERM via STEWARD_TEST_RUNTIME=node",
      git: { branch: "otto/high-1", base: "main", ahead: 1, dirty: 0, filesChanged: 2, insertions: 12, deletions: 2, pushed: true },
    });
    await connector.emit("settled", wHigh, { type: "settled", outcome: "reported" });

    const [, cpHigh] = await connector.waitForWorkerCheckpointRequests(2);
    connector.send({
      t: "worker_checkpoint_result",
      re: cpHigh!.id,
      ok: true,
      checkpoint: {
        workerId: wHigh,
        agent: "pi",
        sessionId: "s_high",
        turnCount: 7,
        toolCallCount: 15,
        initialGoal: "Fix sandbox test hang",
        lastPrompt: null,
        touchedFiles: { modified: ["apps/steward/scripts/test-groups.mjs"], read: ["apps/steward/vitest.config.ts"] },
        commandsRun: ["STEWARD_TEST_RUNTIME=node node apps/steward/scripts/test-groups.mjs"],
        recentNotes: ["workerd sandbox blocks ephemeral port listen; Node runtime succeeds"],
        lastStep: { tool: "bash", args: "STEWARD_TEST_RUNTIME=node" },
        git: null,
      },
    });
    await ownerStub().waitSkillTriageIdleForTest();
    await waitRunsSettled();
    await waitWhileOutboundPending();

    // Crucial safety invariant: ZERO repo_skill_op frames sent before owner clicks!
    expect(connector.repoSkillRequests).toHaveLength(0);

    const client = await workspaceClient();
    const wsOffer = await client.getWorkspace();
    const offerMsg = wsOffer.messages.find((m) => m.id.startsWith("skilloffer:"));
    expect(offerMsg).toBeDefined();
    expect(offerMsg!.open).toBe(true);
    expect(offerMsg!.skillOffer).toMatchObject({
      workerId: wHigh,
      deviceId: connector.deviceId,
      repoId: "/srv/repo-a",
      slug: "workerd-node-test-fallback",
      target: "agents-skill",
      markdown: validSkillMd,
    });
    expect(wsOffer.attention.some((a) => a.id === offerMsg!.id && a.skillOffer?.slug === "workerd-node-test-fallback")).toBe(true);

    // Offline retry test: disconnect machine -> click [写入仓库技能] -> card stays open (status='failed') for retry!
    connector.close();
    const offlineAccept = await client.postAction(wsOffer.csrf, offerMsg!.id, "skill_offer_accept");
    expect(offlineAccept.status).toBe(202);
    await waitWhileOutboundPending();

    const wsAfterOffline = await client.getWorkspace();
    expect(wsAfterOffline.messages.find((m) => m.id === offerMsg!.id)?.open).toBe(true);

    // Reconnect machine -> click [写入仓库技能] again -> deterministic repo_skill_op write (overwrite: false) -> card closes!
    await connector.connect();
    const acceptPromise = client.postAction(wsAfterOffline.csrf, offerMsg!.id, "skill_offer_accept");
    const [writeReq] = await connector.waitForRepoSkillRequests(1);
    expect(writeReq).toMatchObject({
      t: "repo_skill_op",
      op: {
        action: "write",
        scope: { kind: "repo", repoId: "/srv/repo-a" },
        target: "agents-skill",
        slug: "workerd-node-test-fallback",
        markdown: validSkillMd,
        overwrite: false,
      },
    });
    connector.send({
      t: "repo_skill_result",
      re: writeReq!.id,
      ok: true,
      data: {
        action: "write",
        projectApproved: true,
        summary: {
          target: "agents-skill",
          slug: "workerd-node-test-fallback",
          relativePath: ".agents/skills/workerd-node-test-fallback/SKILL.md",
          name: "workerd-node-test-fallback",
          description: "Run Steward suites under Node runtime when workerd blocks ephemeral port binding",
          bytes: validSkillMd.length,
          updatedAt: Date.now(),
          sha256: SHA_2,
          gitStatus: "untracked",
        },
      },
    });
    expect((await acceptPromise).status).toBe(202);
    await waitWhileOutboundPending();

    const wsAfterSave = await client.getWorkspace();
    expect(wsAfterSave.messages.find((m) => m.id === offerMsg!.id)?.open).toBe(false);

    // Verify 24h repo cooldown on /srv/repo-a and 72h 2-consecutive-dismiss backoff on /srv/repo-b
    const cooldownCheck = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Steward["ledger"] }).ledger;
      const now = Date.now();
      const repoACooldown = ledger.skillOffers.cooldownStatus("t_brand_new", "/srv/repo-a", now + 60_000);

      // Simulate 2 dismissed offers >24h apart on /srv/repo-b -> 72h backoff must block within 48h and allow after 73h
      const sql = (instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql.bind(instance);
      const t0 = now - 50 * 3_600_000;
      const t1 = now - 25 * 3_600_000;
      ledger.skillOffers.create({
        id: "so_b1",
        threadId: "tb1",
        workerId: "wb1",
        deviceId: connector.deviceId,
        repoId: "/srv/repo-b",
        target: "agents-skill",
        slug: "s1",
        name: "S1",
        description: "D1",
        summaryBullets: ["x"],
        markdown: "# 1",
      });
      ledger.skillOffers.dismiss("so_b1");
      sql`UPDATE sh_skill_offer SET createdAt = ${t0}, decidedAt = ${t0 + 1000} WHERE id = 'so_b1'`;
      ledger.skillOffers.create({
        id: "so_b2",
        threadId: "tb2",
        workerId: "wb2",
        deviceId: connector.deviceId,
        repoId: "/srv/repo-b",
        target: "agents-skill",
        slug: "s2",
        name: "S2",
        description: "D2",
        summaryBullets: ["y"],
        markdown: "# 2",
      });
      ledger.skillOffers.dismiss("so_b2");
      sql`UPDATE sh_skill_offer SET createdAt = ${t1}, decidedAt = ${t1 + 1000} WHERE id = 'so_b2'`;

      const repoBBlocked = ledger.skillOffers.cooldownStatus("tb3", "/srv/repo-b", now);
      const repoBUnblocked = ledger.skillOffers.cooldownStatus("tb3", "/srv/repo-b", t1 + 73 * 3_600_000);
      return { repoACooldown, repoBBlocked, repoBUnblocked };
    });

    expect(cooldownCheck.repoACooldown).toEqual({ allowed: false, reason: "repo_24h_cooldown" });
    expect(cooldownCheck.repoBBlocked).toEqual({ allowed: false, reason: "repo_72h_dismiss_backoff" });
    expect(cooldownCheck.repoBUnblocked).toEqual({ allowed: true });

    connector.close();
  }, 30_000);

  it("Stage 4: mines cross-session recurring patterns on moderate runs and proposes lossless updates to existing skills", async () => {
    const existingSkillMd = [
      "---",
      "name: sqlite-wal-recovery",
      "description: Recover SQLite WAL corruption and online backup steps",
      "---",
      "",
      "# Steps",
      "1. Run PRAGMA integrity_check before backup.",
    ].join("\n");
    const updatedSkillMd = [
      "---",
      "name: sqlite-wal-recovery",
      "description: Recover SQLite WAL corruption and online backup steps",
      "---",
      "",
      "# Steps",
      "1. Run PRAGMA integrity_check before backup.",
      "2. Always use SQLite .backup instead of plain cp while WAL is active.",
    ].join("\n");

    const connector = await pairFakeConnector("mac-stage4", {
      run: null,
      autorun: false,
      repos: [
        {
          repoId: "/srv/repo-cross",
          name: "repo-cross",
          projectApproved: true,
        },
      ],
    });
    connector.repoSkills = true;
    connector.workerCheckpoint = true;
    await connector.connect();

    // Seed an existing repo skill + an earlier completed session on a DIFFERENT Thread in the same repo with overlapping WAL backup topic
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Steward["ledger"] }).ledger;
      const sql = (instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql.bind(instance);
      ledger.repos.syncSkillMutation(connector.deviceId, "/srv/repo-cross", {
        kind: "list",
        projectApproved: true,
        skills: [
          {
            target: "agents-skill",
            slug: "sqlite-wal-recovery",
            relativePath: ".agents/skills/sqlite-wal-recovery/SKILL.md",
            name: "sqlite-wal-recovery",
            description: "Recover SQLite WAL corruption and online backup steps",
            bytes: existingSkillMd.length,
            updatedAt: Date.now() - 86_400_000,
            sha256: SHA_1,
            gitStatus: "clean",
          },
        ],
      });
      const oldThread = ledger.threads.create({
        title: "Prior SQLite WAL backup incident",
        goal: "Fix SQLite WAL online backup script",
        repoIds: ["/srv/repo-cross"],
      });
      ledger.workers.register({
        workerId: "w_prior_wal_1",
        threadId: oldThread.threadId,
        deviceId: connector.deviceId,
        repoId: "/srv/repo-cross",
        agent: "pi",
        mode: "write",
      });
      sql`
        INSERT INTO sh_report (workerId, seq, threadId, status, summary, changes, decisions, receivedAt)
        VALUES (
          'w_prior_wal_1', 1, ${oldThread.threadId}, 'done',
          'Fixed SQLite WAL backup failure by switching from cp to sqlite3 .backup',
          ${JSON.stringify(["deploy/backup.sh"])},
          ${JSON.stringify(["Never copy live WAL files with plain cp; use sqlite3 .backup"])},
          ${Date.now() - 3_600_000}
        )
      `;
    });

    await ownerStub().setAmbientSkillRepliesForTest([
      JSON.stringify({
        worthSaving: true,
        confidence: "high",
        mode: "update",
        reason: "Recurring WAL backup pattern across 2 sessions uncovered missing .backup rule",
        evidenceSummary: "跨 2 次会话反复遇到 SQLite WAL 在线备份问题",
        slug: "sqlite-wal-recovery",
        name: "SQLite WAL 备份与恢复",
        description: "Recover SQLite WAL corruption and online backup steps",
        summaryBullets: ["补充 WAL 活跃期严禁直接 cp、必须使用 sqlite3 .backup 的步骤"],
        markdown: updatedSkillMd,
      }),
    ]);
    await scriptModel(fauxAssistantMessage([fauxText("已修复 WAL 备份脚本。")]));

    await ownerStub().dispatchForTest({
      prompt: "Fix SQLite WAL online backup in deploy/backup.sh",
      repoRef: "repo-cross",
      newTitle: "SQLite WAL backup follow-up",
    });
    const [cmdMod] = await connector.waitForCmds(1);
    const wMod = String((cmdMod!.args as { workerId: string }).workerId);
    connector.send({ t: "cmd_ack", re: cmdMod!.id, status: "accepted" });
    connector.send({ t: "cmd_result", re: cmdMod!.id, ok: true, data: { sessionId: "s_mod", branch: "otto/wal-2", cwd: "/srv/repo-cross" } });
    await connector.emit("started", wMod, { sessionId: "s_mod", cwd: "/srv/repo-cross", branch: "otto/wal-2" });
    await connector.emit("report", wMod, {
      type: "report",
      status: "done",
      summary: "Updated deploy/backup.sh to enforce sqlite3 .backup for SQLite WAL",
      changes: ["deploy/backup.sh"],
      decisions: ["Use sqlite3 .backup instead of plain cp while WAL is active"],
      git: { branch: "otto/wal-2", base: "main", ahead: 1, dirty: 0, filesChanged: 1, insertions: 8, deletions: 2, pushed: true },
    });
    await connector.emit("settled", wMod, { type: "settled", outcome: "reported" });

    // Moderate friction (only 5 tools / 3 turns, NO high-friction label) — still triggers via cross-session recurring pattern!
    const [cpMod] = await connector.waitForWorkerCheckpointRequests(1);
    connector.send({
      t: "worker_checkpoint_result",
      re: cpMod!.id,
      ok: true,
      checkpoint: {
        workerId: wMod,
        agent: "pi",
        sessionId: "s_mod",
        turnCount: 3,
        toolCallCount: 5,
        initialGoal: "Fix SQLite WAL online backup in deploy/backup.sh",
        lastPrompt: null,
        touchedFiles: { modified: ["deploy/backup.sh"], read: [] },
        commandsRun: ["sqlite3 /var/lib/otto/steward.sqlite '.backup /tmp/test.sqlite'"],
        recentNotes: ["WAL active requires sqlite3 .backup"],
        lastStep: { tool: "bash", args: "sqlite3 .backup" },
        git: null,
      },
    });

    // Steward pre-reads the matching existing agents-skill so the LLM can produce a lossless update
    const [readReq] = await connector.waitForRepoSkillRequests(1);
    expect(readReq).toMatchObject({
      t: "repo_skill_op",
      op: {
        action: "read",
        scope: { kind: "repo", repoId: "/srv/repo-cross" },
        target: "agents-skill",
        slug: "sqlite-wal-recovery",
      },
    });
    connector.send({
      t: "repo_skill_result",
      re: readReq!.id,
      ok: true,
      data: {
        action: "read",
        projectApproved: true,
        markdown: existingSkillMd,
        summary: {
          target: "agents-skill",
          slug: "sqlite-wal-recovery",
          relativePath: ".agents/skills/sqlite-wal-recovery/SKILL.md",
          name: "sqlite-wal-recovery",
          description: "Recover SQLite WAL corruption and online backup steps",
          bytes: existingSkillMd.length,
          updatedAt: Date.now() - 86_400_000,
          sha256: SHA_1,
          gitStatus: "clean",
        },
      },
    });

    await ownerStub().waitSkillTriageIdleForTest();
    await waitRunsSettled();
    await waitWhileOutboundPending();

    const client = await workspaceClient();
    const wsOffer = await client.getWorkspace();
    const offerMsg = wsOffer.messages.find((m) => m.id.startsWith("skilloffer:") && m.skillOffer?.workerId === wMod);
    expect(offerMsg).toBeDefined();
    expect(offerMsg!.open).toBe(true);
    expect(offerMsg!.card?.title).toContain("要更新这条仓库技能吗");
    expect(offerMsg!.skillOffer).toMatchObject({
      workerId: wMod,
      repoId: "/srv/repo-cross",
      offerKind: "update",
      slug: "sqlite-wal-recovery",
      evidenceCount: 2,
      evidenceSummary: "跨 2 次会话反复遇到 SQLite WAL 在线备份问题",
      baseSha256: SHA_1,
    });

    // Accepting an update offer must send overwrite: true
    const acceptPromise = client.postAction(wsOffer.csrf, offerMsg!.id, "skill_offer_accept");
    const [, writeReq] = await connector.waitForRepoSkillRequests(2);
    expect(writeReq).toMatchObject({
      t: "repo_skill_op",
      op: {
        action: "write",
        scope: { kind: "repo", repoId: "/srv/repo-cross" },
        target: "agents-skill",
        slug: "sqlite-wal-recovery",
        markdown: updatedSkillMd,
        overwrite: true,
      },
    });
    connector.send({
      t: "repo_skill_result",
      re: writeReq!.id,
      ok: true,
      data: {
        action: "write",
        projectApproved: true,
        summary: {
          target: "agents-skill",
          slug: "sqlite-wal-recovery",
          relativePath: ".agents/skills/sqlite-wal-recovery/SKILL.md",
          name: "sqlite-wal-recovery",
          description: "Recover SQLite WAL corruption and online backup steps",
          bytes: updatedSkillMd.length,
          updatedAt: Date.now(),
          sha256: SHA_2,
          gitStatus: "modified",
        },
      },
    });
    expect((await acceptPromise).status).toBe(202);
    await waitWhileOutboundPending();

    const wsAfter = await client.getWorkspace();
    expect(wsAfter.messages.find((m) => m.id === offerMsg!.id)?.open).toBe(false);
    connector.close();
  }, 20_000);
});
