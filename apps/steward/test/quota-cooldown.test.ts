// Stage 1 Quota Cooldown & Hold tests (migration 050_quota_hold_and_cooldown):
// - Dual-granularity cooldown keys: `pi:<provider>` vs `agent:<kind>`
// - Parks rate-limited workers in `idle` (`error:rate_limited`), NEVER `broken`
// - Dedupes notifications per cooldown window bucket
// - Refuses dispatches to cooled `(deviceId, scopeKey)` while allowing uncooled providers/agents on the same machine
// - Rejects out-of-bounds `limitedUntil` (> 8 days ahead) back to ordinary error handling
// - Deterministically resumes parked workers via `send` when `limitedUntil` expires in `drainWakes()`
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  configureAndBind,
  connectAndHello,
  ownerStub,
  pairDevice,
  resetLedgerState,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function connectMultiProviderMachine() {
  const { deviceId, token } = await pairDevice("mac-studio");
  const conn = await connectAndHello(deviceId, token, 1, {
    machine: { name: "mac-studio", memTotalMB: 65536, memFreeMB: 32000 },
    agents: [
      {
        kind: "pi",
        version: "1.3.0",
        capabilities: { steer: true, followUp: true, interrupt: true, resume: true, history: true, images: true, structuredReport: true, readonly: true },
        modelCatalog: {
          capabilities: {
            selection: "launch",
            discovery: "enumerated",
            customModelInput: false,
            actualModelObservation: true,
            thinkingSelection: false,
            idFormat: "qualified",
          },
          status: "ready",
          models: [
            { id: "zai-coding-cn/glm-5", name: "GLM-5 (Coding Plan)" },
            { id: "deepseek/deepseek-chat", name: "DeepSeek V3" },
          ],
        },
      },
      {
        kind: "codex",
        version: "codex-cli 0.170.0",
        authStatus: "ready",
        capabilities: { steer: false, followUp: false, interrupt: true, resume: true, history: true, images: true, structuredReport: true, readonly: true },
      },
    ],
    repos: [{ repoId: "/srv/repo-a", name: "repo-a", path: "/srv/repo-a", defaultBranch: "main", remote: "git@example:repo-a.git" }],
    limits: { maxWorkers: 4, running: 0 },
  });
  return { deviceId, ...conn };
}

function sendEvents(ws: WebSocket, batch: Array<Record<string, unknown>>): void {
  ws.send(JSON.stringify({ t: "events", id: `evt-${Math.random()}`, batch }));
}

async function waitForPredicate<T>(fn: () => Promise<T>, pred: (val: T) => boolean, label: string, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const val = await fn();
    if (pred(val)) return val;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(val)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("050_quota_hold_and_cooldown — dual-granularity quota hold & auto-resume", () => {
  it("parks `pi:zai-coding-cn` in idle cooldown without blocking `pi:deepseek` or `codex` on the same machine, dedupes notifications, and resumes on expiry", async () => {
    const { deviceId, ws, reader } = await connectMultiProviderMachine();

    // 1. Dispatch Worker 1 on `pi` using `zai-coding-cn/glm-5`.
    const d1 = await ownerStub().dispatchForTest({
      prompt: "Implement feature A",
      repoRef: "repo-a",
      newTitle: "Feature A",
      model: "zai-coding-cn/glm-5",
      modelSource: "override",
    });
    expect(d1.kind).toBe("dispatched");
    const cmd1 = await reader.nextWhere((m) => m.t === "cmd" && m.kind === "start_worker");
    const w1 = String((cmd1.args as Record<string, unknown>).workerId);

    const limitedUntil = Date.now() + 30 * 60_000; // +30 minutes
    sendEvents(ws, [
      {
        workerId: w1,
        seq: 1,
        ts: Date.now(),
        type: "started",
        sessionId: w1,
        branch: "otto/feature-a",
        launchObservedModel: { id: "zai-coding-cn/glm-5", source: "state", observedAt: Date.now() },
      },
      {
        workerId: w1,
        seq: 2,
        ts: Date.now(),
        type: "settled",
        outcome: "error",
        errorClass: "rate_limited",
        limitedUntil,
        errorMessage: "usage_limit_reached: Coding Plan 5-hour window exhausted",
      },
    ]);

    const snap1 = await waitForPredicate(
      () => ownerStub().debugSnapshot(),
      (s) => s.threads[0]?.workers[0]?.lastOutcome === "error:rate_limited",
      "w1 rate_limited reduction",
    );
    const workerRow1 = snap1.threads[0]!.workers[0]!;
    // Crucial invariant: worker is parked `idle`, NEVER `broken`, and no failure question blocks it!
    expect(workerRow1.state).toBe("idle");
    expect(workerRow1.lastOutcome).toBe("error:rate_limited");
    expect(snap1.questions.filter((q) => q.workerId === w1)).toHaveLength(0);

    // 2. Dispatching a new task to `zai-coding-cn/glm-5` on the same machine is refused with exact alternatives,
    //    while `deepseek/deepseek-chat` (`pi:deepseek`) and `codex` (`agent:codex`) succeed immediately!
    const refusedZai = await ownerStub().dispatchForTest({
      prompt: "Another zai task",
      repoRef: "repo-a",
      newTitle: "Blocked Zai",
      model: "zai-coding-cn/glm-5",
      modelSource: "override",
    });
    expect(refusedZai.kind).toBe("refused");
    if (refusedZai.kind === "refused") {
      expect(refusedZai.reason).toContain("pi (zai-coding-cn)");
      expect(refusedZai.reason).toContain("pi (deepseek)");
      expect(refusedZai.reason).toContain("codex");
    }

    const allowedDeepseek = await ownerStub().dispatchForTest({
      prompt: "Run on DeepSeek instead",
      repoRef: "repo-a",
      newTitle: "DeepSeek Task",
      model: "deepseek/deepseek-chat",
      modelSource: "override",
    });
    expect(allowedDeepseek.kind).toBe("dispatched");
    await reader.nextWhere(
      (m) => m.t === "cmd" && m.kind === "start_worker" && (m.args as Record<string, unknown>).model === "deepseek/deepseek-chat",
    );

    const allowedCodex = await ownerStub().dispatchForTest({
      prompt: "Run on Codex CLI",
      repoRef: "repo-a",
      newTitle: "Codex Task",
      agent: "codex",
    });
    expect(allowedCodex.kind).toBe("dispatched");
    await reader.nextWhere(
      (m) => m.t === "cmd" && m.kind === "start_worker" && (m.args as Record<string, unknown>).agent === "codex",
    );

    // 3. Deduplication check: another `zai-coding-cn` settle in the same minute bucket does not create a 2nd quota_hold notify!
    const notifyCountBefore = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: <T>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql.bind(instance);
      return sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_notify WHERE kind = 'quota_hold'`[0]!.n;
    });
    expect(notifyCountBefore).toBe(1);

    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const res = (instance as unknown as { ledger: Steward["ledger"] }).ledger.cooldowns.record({
        deviceId,
        agent: "pi",
        provider: "zai-coding-cn",
        scopeKey: "pi:zai-coding-cn",
        limitedUntil,
        reason: "duplicate hit in same window",
        workerId: w1,
      });
      expect(res.shouldNotify).toBe(false);
    });

    // 4. Simulate cooldown expiry and run `drainWakes()`: Steward deterministically sends `send` (`intent: "auto"`)
    //    to resume `w1`'s original session without burning Steward LLM calls!
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: <T>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql.bind(instance);
      const past = Date.now() - 1000;
      sql`UPDATE sh_agent_cooldown SET limitedUntil = ${past} WHERE deviceId = ${deviceId} AND scopeKey = 'pi:zai-coding-cn'`;
      sql`UPDATE sh_wake SET dueAt = ${past} WHERE operationId LIKE 'cooldown:%'`;
      await instance.drainWakes();
    });

    const resumeCmd = await reader.nextWhere((m) => m.t === "cmd" && m.kind === "send" && m.workerId === w1);
    expect(resumeCmd.args).toMatchObject({
      workerId: w1,
      intent: "auto",
    });
    expect(String((resumeCmd.args as Record<string, unknown>).text)).toContain("额度冷却窗口已恢复");

    // Cooldown row is now cleared!
    const remainingCooldowns = await runInDurableObject(ownerStub(), (instance: Steward) =>
      (instance as unknown as { ledger: Steward["ledger"] }).ledger.cooldowns.listActive(deviceId),
    );
    expect(remainingCooldowns).toHaveLength(0);
    ws.close();
  });

  it("rejects distant limitedUntil (> 8 days) back to ordinary broken failure handling", async () => {
    const { ws, reader } = await connectMultiProviderMachine();
    const d = await ownerStub().dispatchForTest({
      prompt: "Bad timestamp test",
      repoRef: "repo-a",
      newTitle: "Out of bounds reset",
    });
    expect(d.kind).toBe("dispatched");
    const cmd = await reader.nextWhere((m) => m.t === "cmd" && m.kind === "start_worker");
    const workerId = String((cmd.args as Record<string, unknown>).workerId);

    sendEvents(ws, [
      { workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId },
      {
        workerId,
        seq: 2,
        ts: Date.now(),
        type: "settled",
        outcome: "error",
        errorClass: "rate_limited",
        limitedUntil: Date.now() + 12 * 86_400_000, // 12 days (> 8-day max)
        errorMessage: "Bogus 12-day timestamp",
      },
    ]);

    const snap = await waitForPredicate(
      () => ownerStub().debugSnapshot(),
      (s) => s.threads[0]?.workers[0]?.state === "broken",
      "distant timestamp falls back to broken",
    );
    expect(snap.threads[0]!.workers[0]!.lastOutcome).toBe("error:unknown");
    ws.close();
  });
});
