// Tests for Stage 2: Steward worker_checkpoint relay, offline fallback, handoff unreportedStop,
// and out-of-band completeSimple distillation (handoff compaction & SKILL.md extraction).
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { Steward } from "../src/steward.ts";
import { renderHandoffBrief } from "../src/handoff.ts";
import { configureAndBind, ownerStub, pairFakeConnector, resetLedgerState, scriptModel, webLogin } from "./helpers.ts";

const BASE = "https://example.com";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function authedClient() {
  const cookie = await webLogin();
  const ws = (await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json()) as { csrf: string };
  const post = async <T>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
    const res = await SELF.fetch(`${BASE}/app/api/${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: BASE,
        "content-type": "application/json",
        "x-csrf-token": ws.csrf,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { post };
}

describe("worker_checkpoint relay, offline fallback, and handoff unreportedStop", () => {
  it("relays online checkpoint, degrades gracefully offline, and surfaces unreported stop in handoff brief", async () => {
    const connector = await pairFakeConnector("mac-dev", { run: null, autorun: false });
    connector.workerCheckpoint = true;
    await connector.connect();

    await ownerStub().dispatchForTest({ prompt: "Refactor auth middleware", repoRef: "repo-a", newTitle: "Auth refactor" });
    const [cmd] = await connector.waitForCmds(1);
    const workerId = String(cmd!.workerId);
    const threadId = String((cmd!.args as Record<string, unknown>).threadId);

    // Simulate interrupted worker with progress and outcome, without a formal `report`
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: Steward["sql"] }).sql.bind(instance);
      sql`UPDATE sh_worker SET state = 'idle', lastOutcome = 'cancelled', lastProgress = ${JSON.stringify({ tool: "Edit", target: "src/auth.ts" })} WHERE workerId = ${workerId}`;
      const ledger = (instance as unknown as { ledger: Steward["ledger"] }).ledger;
      const brief = ledger.handoff.build(threadId, workerId);
      expect(brief?.unreportedStop).toEqual({ outcome: "cancelled", lastStep: "Edit src/auth.ts" });
      expect(renderHandoffBrief(brief!)).toContain("前一棒停机现场（未完成正式汇报）：结束态 cancelled，最后动作 Edit src/auth.ts");
    });

    const client = await authedClient();
    const onlinePromise = client.post<{
      workerId: string;
      turnCount: number;
      touchedFiles: { modified: string[] };
      offlineFallback?: boolean;
    }>(`workers/${workerId}/checkpoint`, {});

    const [req] = await connector.waitForWorkerCheckpointRequests(1);
    expect(req).toMatchObject({ t: "worker_checkpoint", workerId });
    connector.send({
      t: "worker_checkpoint_result",
      re: req!.id,
      ok: true,
      checkpoint: {
        workerId,
        agent: "pi",
        sessionId: "sess_live",
        turnCount: 2,
        toolCallCount: 4,
        initialGoal: "Refactor auth middleware",
        lastPrompt: null,
        recentNotes: ["Updated token parser, about to run tests"],
        touchedFiles: { read: ["src/index.ts"], modified: ["src/auth.ts"] },
        commandsRun: ["pnpm typecheck"],
        lastStep: { tool: "Edit", args: "src/auth.ts" },
        git: null,
      },
    });

    const onlineRes = await onlinePromise;
    expect(onlineRes.status).toBe(200);
    expect(onlineRes.body.touchedFiles.modified).toEqual(["src/auth.ts"]);
    expect(onlineRes.body.offlineFallback).toBeUndefined();

    // Disconnect machine -> checkpoint automatically falls back to ledger state instead of 409!
    connector.close();
    await new Promise((r) => setTimeout(r, 50));
    const offlineRes = await client.post<{ offlineFallback?: boolean; lastStep: { tool: string; args?: string } | null }>(
      `workers/${workerId}/checkpoint`,
      {},
    );
    expect(offlineRes.status).toBe(200);
    expect(offlineRes.body.offlineFallback).toBe(true);
    expect(offlineRes.body.lastStep).toEqual({ tool: "Edit", args: "src/auth.ts" });
  });
});

describe("out-of-band L2 distillation (handoff compaction & SKILL.md extraction)", () => {
  it("distills handoff brief and SKILL.md + suggestedNotes idempotently, and blocks when over limit", async () => {
    const connector = await pairFakeConnector("mac-skill", { run: null, autorun: false });
    await connector.connect();
    await ownerStub().dispatchForTest({ prompt: "Fix sqlite busy lock", repoRef: "repo-a", newTitle: "SQLite busy fix" });
    const [cmd] = await connector.waitForCmds(1);
    const workerId = String(cmd!.workerId);
    connector.close();

    await scriptModel(
      fauxAssistantMessage([
        fauxText(
          JSON.stringify({
            summary: "Added WAL pragma and busy_timeout",
            accomplished: ["Enabled WAL journal_mode", "Configured 5000ms busy_timeout"],
            deadEnds: ["Manual retry loop caused starvation"],
            stoppedAt: "Paused before running stress test",
            nextSteps: ["Run sqlite concurrency test"],
            continuationPrompt: "Continue from WAL setup and run the concurrency stress test.",
          }),
        ),
      ]),
      fauxAssistantMessage([
        fauxText(
          JSON.stringify({
            skill: {
              slug: "sqlite-wal-tuning",
              name: "SQLite WAL Tuning",
              description: "Configure Node SQLite WAL and busy_timeout safely.",
              markdown: "# Steps\n1. Enable WAL\n2. Set busy_timeout = 5000",
            },
            suggestedNotes: [
              { kind: "convention", text: "Always set PRAGMA busy_timeout = 5000 on SQLite connections." },
            ],
          }),
        ),
      ]),
    );

    const client = await authedClient();
    const handoffRes = await client.post<{
      mode: string;
      accomplished: string[];
      continuationPrompt: string;
    }>(`workers/${workerId}/distill`, { id: "req_distill_h1", mode: "handoff" });
    expect(handoffRes.status).toBe(200);
    expect(handoffRes.body.mode).toBe("handoff");
    expect(handoffRes.body.accomplished).toHaveLength(2);
    expect(handoffRes.body.continuationPrompt).toContain("concurrency stress test");

    const replayRes = await client.post<{ continuationPrompt: string }>(`workers/${workerId}/distill`, {
      id: "req_distill_h1",
      mode: "handoff",
    });
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.continuationPrompt).toBe(handoffRes.body.continuationPrompt);

    const skillRes = await client.post<{
      mode: string;
      skill: { slug: string; markdown: string };
      suggestedNotes: Array<{ kind: string; text: string }>;
    }>(`workers/${workerId}/distill`, { id: "req_distill_s1", mode: "skill" });
    expect(skillRes.status).toBe(200);
    expect(skillRes.body.skill.slug).toBe("sqlite-wal-tuning");
    expect(skillRes.body.skill.markdown).toContain("---\nname: sqlite-wal-tuning");
    expect(skillRes.body.suggestedNotes).toEqual([
      { kind: "convention", text: "Always set PRAGMA busy_timeout = 5000 on SQLite connections." },
    ]);

    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Steward["ledger"] }).ledger;
      ledger.budget.add({ costUsd: 500, tokens: 100_000 }, Date.now());
    });
    const blocked = await client.post<{ error: string }>(`workers/${workerId}/distill`, {
      id: "req_distill_blocked",
      mode: "handoff",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("over_budget");
    expect((await client.post(`workers/${workerId}/checkpoint`, {})).status).toBe(200);
  });
});
