// Tests for Direction 2A: deterministic Memory, Proactive Schedules, and PR Watch control plane.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import { RESIDENT_CAP } from "../src/notes.ts";
import { configureAndBind, ownerStub, pairFakeConnector, resetLedgerState, webLogin } from "./helpers.ts";

const BASE = "https://example.com";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function controlBrowser() {
  const cookie = await webLogin();
  const wsRes = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
  const ws = (await wsRes.json()) as {
    csrf: string;
    controlPlaneSummary: {
      residentUsedChars: number;
      residentCapChars: number;
      unconfirmedNotes: number;
      pressureCount: number;
      activeRoutines: number;
      pausedRoutines: number;
      openFollowups: number;
      activePrWatches: number;
    };
  };
  const getJson = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await SELF.fetch(`${BASE}/app/api/${path}`, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as T };
  };
  const postJson = async <T>(
    path: string,
    body: unknown,
    opts: { csrf?: string; origin?: string | null } = {},
  ): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = {
      cookie,
      "content-type": "application/json",
      "x-csrf-token": opts.csrf ?? ws.csrf,
    };
    if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
    const res = await SELF.fetch(`${BASE}/app/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { cookie, csrf: ws.csrf, summary: ws.controlPlaneSummary, getJson, postJson };
}

describe("control plane security & auth gates", () => {
  it("enforces session, same-origin Origin, CSRF, and request-id idempotency", async () => {
    expect((await SELF.fetch(`${BASE}/app/api/memory`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/app/api/schedules`)).status).toBe(401);

    const b = await controlBrowser();
    const noOrigin = await b.postJson("memory", { id: "req_sec_0001", action: "create", layer: "resident", kind: "preference", text: "Always run vitest" }, { origin: null });
    expect(noOrigin.status).toBe(403);

    const badCsrf = await b.postJson("memory", { id: "req_sec_0002", action: "create", layer: "resident", kind: "preference", text: "Always run vitest" }, { csrf: "wrong" });
    expect(badCsrf.status).toBe(403);

    const created = await b.postJson<{ ok: boolean; note: { noteId: string; pinned: boolean } }>("memory", {
      id: "req_idem_0001",
      action: "create",
      layer: "resident",
      kind: "preference",
      text: "Prefer concise commits",
      pinned: true,
    });
    expect(created.status).toBe(200);
    expect(created.body.note.pinned).toBe(true);

    const replayed = await b.postJson<{ ok: boolean; note: { noteId: string } }>("memory", {
      id: "req_idem_0001",
      action: "create",
      layer: "resident",
      kind: "preference",
      text: "Prefer concise commits",
      pinned: true,
    });
    expect(replayed.status).toBe(200);
    expect(replayed.body.note.noteId).toBe(created.body.note.noteId);

    const conflict = await b.postJson<{ error: string }>("memory", {
      id: "req_idem_0001",
      action: "create",
      layer: "resident",
      kind: "preference",
      text: "Different payload",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("id_conflict");
  });
});

describe("memory control plane invariants", () => {
  it("writes audit rows with reported=true (no stale chat echo), enforces anti-poisoning, and handles capacity eviction", async () => {
    const fake = await pairFakeConnector("mac-mini", { run: null, autorun: false });
    await fake.connect();
    const stub = ownerStub();
    let connectorNoteId = "";
    let workerNoteId = "";
    await runInDurableObject(stub, async (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Steward["ledger"] }).ledger;
      const repoId = ledger.repos.list()[0]!.repoId;
      const c = ledger.notes.commit({
        text: "Repo uses pnpm workspaces",
        kind: "convention",
        source: "connector",
        layer: "project",
        scopeRepoId: repoId,
      });
      if (c.ok) connectorNoteId = c.note.noteId;
      const w = ledger.notes.commit({
        text: "Build requires Node 24+",
        kind: "environment",
        source: "worker_reported",
        layer: "project",
        scopeRepoId: repoId,
      });
      if (w.ok) workerNoteId = w.note.noteId;
      ledger.notes.drainPendingForReply();
    });
    fake.close();

    const b = await controlBrowser();
    const view1 = await b.getJson<{ notes: Array<{ noteId: string; confirmed: boolean }>; usage: { unconfirmedCount: number } }>("memory?layer=active");
    expect(view1.status).toBe(200);
    expect(view1.body.usage.unconfirmedCount).toBe(1);

    // Connector note can never be promoted to resident
    const badPromote = await b.postJson<{ error: string }>("memory", {
      id: "req_mem_conn_promote",
      action: "promote",
      noteId: connectorNoteId,
    });
    expect(badPromote.status).toBe(400);
    expect(badPromote.body.error).toBe("connector_cannot_promote");

    // Promoting an unconfirmed worker_reported note atomically confirms + supersedes to resident preserving source
    const okPromote = await b.postJson<{ ok: boolean; note: { noteId: string; layer: string; source: string; confirmed: boolean } }>("memory", {
      id: "req_mem_worker_promote",
      action: "promote",
      noteId: workerNoteId,
    });
    expect(okPromote.status).toBe(200);
    expect(okPromote.body.note.layer).toBe("resident");
    expect(okPromote.body.note.source).toBe("worker_reported");
    expect(okPromote.body.note.confirmed).toBe(true);

    // Fill resident near RESIDENT_CAP and verify 409 capacity_exceeded does NOT pollute sh_note_pressure
    const fillerA = await b.postJson<{ note: { noteId: string } }>("memory", {
      id: "req_mem_fill_a",
      action: "create",
      layer: "resident",
      kind: "fact",
      text: "A".repeat(1200),
    });
    expect(fillerA.status).toBe(200);
    const fillerB = await b.postJson<{ note: { noteId: string } }>("memory", {
      id: "req_mem_fill_b",
      action: "create",
      layer: "resident",
      kind: "fact",
      text: "B".repeat(1100),
    });
    expect(fillerB.status).toBe(200);

    const overflow = await b.postJson<{ error: string; needsEviction: Array<{ noteId: string }> }>("memory", {
      id: "req_mem_overflow_1",
      action: "create",
      layer: "resident",
      kind: "preference",
      text: "C".repeat(300),
    });
    expect(overflow.status).toBe(409);
    expect(overflow.body.error).toBe("capacity_exceeded");
    expect(overflow.body.needsEviction.length).toBeGreaterThan(0);

    const afterOverflow = await b.getJson<{ usage: { resident: { capChars: number }; pressure: unknown[] } }>("memory");
    expect(afterOverflow.body.usage.resident.capChars).toBe(RESIDENT_CAP);
    expect(afterOverflow.body.usage.pressure).toHaveLength(0);

    // Retry with explicit evicts succeeds atomically
    const withEvict = await b.postJson<{ ok: boolean; note: { noteId: string } }>("memory", {
      id: "req_mem_overflow_2",
      action: "create",
      layer: "resident",
      kind: "preference",
      text: "C".repeat(300),
      evicts: [fillerB.body.note.noteId],
    });
    expect(withEvict.status).toBe(200);

    // Pin blocks archive until unpinned; archive keeps status=active and FTS-searchable
    await b.postJson("memory", { id: "req_mem_pin_1", action: "pin", noteId: withEvict.body.note.noteId, pinned: true });
    const pinnedArchive = await b.postJson<{ error: string }>("memory", {
      id: "req_mem_arch_blocked",
      action: "archive",
      noteId: withEvict.body.note.noteId,
    });
    expect(pinnedArchive.status).toBe(409);
    expect(pinnedArchive.body.error).toBe("note_pinned");

    await b.postJson("memory", { id: "req_mem_unpin_1", action: "pin", noteId: withEvict.body.note.noteId, pinned: false });
    const archived = await b.postJson<{ ok: boolean; note: { layer: string; status: string } }>("memory", {
      id: "req_mem_arch_ok",
      action: "archive",
      noteId: withEvict.body.note.noteId,
    });
    expect(archived.status).toBe(200);
    expect(archived.body.note.layer).toBe("archive");
    expect(archived.body.note.status).toBe("active");

    // Verify zero unreported pending reply echo from all Web UI actions
    await runInDurableObject(stub, async (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Steward["ledger"] }).ledger;
      expect(ledger.notes.renderPendingForReply().text).toBe("");
    });
  });
});

describe("schedules & PR watches deterministic control plane", () => {
  it("lists routines, followups, and PR watches with nextRunAt and mutates while over limit", async () => {
    const stub = ownerStub();
    let routineId = "";
    let followupId = "";
    const watchId = "watch_ctrl_1";
    const prUrl = ["https://github.com", "example", "project", "pull", "42"].join("/");

    await runInDurableObject(stub, async (instance: Steward) => {
      const internal = instance as unknown as {
        ledger: Steward["ledger"];
        routineService: {
          create(input: Record<string, unknown>): Promise<{ routine?: { routineId: string } }>;
          setFollowup(input: Record<string, unknown>): Promise<{ followup?: { followupId: string } }>;
        };
        prWatches: { create(input: Record<string, unknown>): unknown };
      };
      const thread = internal.ledger.threads.create({ title: "Release v0.3", goal: "Ship release" });
      const r = await internal.routineService.create({
        routineId: "r_ctrl_1",
        kind: "digest",
        scheduleKind: "cron",
        cron: "0 9 * * *",
        instruction: "Morning summary",
        createdFromMsg: "user:msg_1",
        threadId: thread.threadId,
      });
      routineId = r.routine!.routineId;
      const f = await internal.routineService.setFollowup({
        followupId: "f_ctrl_1",
        threadId: thread.threadId,
        afterMinutes: 60,
        reason: "Check deployment health",
        createdBy: "user",
        sourceRef: "user:msg_1",
      });
      followupId = f.followup!.followupId;
      internal.prWatches.create({ id: watchId, threadId: thread.threadId, url: prUrl, intervalSeconds: 300 });
      internal.ledger.budget.add({ costUsd: 500, tokens: 100_000 }, Date.now());
    });

    const b = await controlBrowser();
    expect(b.summary.activeRoutines).toBe(1);
    expect(b.summary.openFollowups).toBe(1);
    expect(b.summary.activePrWatches).toBe(1);

    const sched = await b.getJson<{
      routines: Array<{ routineId: string; status: string; nextRunAt: number | null; threadTitle: string | null }>;
      followups: Array<{ followupId: string; status: string }>;
      prWatches: Array<{ id: string; status: string }>;
      budget: { over: boolean };
    }>("schedules");
    expect(sched.status).toBe(200);
    expect(sched.body.budget.over).toBe(true);
    expect(sched.body.routines[0]?.routineId).toBe(routineId);
    expect(sched.body.routines[0]?.nextRunAt).toBeTypeOf("number");
    expect(sched.body.routines[0]?.threadTitle).toBe("Release v0.3");

    const paused = await b.postJson<{ routine: { status: string } }>("schedules", {
      id: "req_sched_pause_1",
      action: "pause_routine",
      routineId,
      paused: true,
    });
    expect(paused.status).toBe(200);
    expect(paused.body.routine.status).toBe("paused");

    const resumed = await b.postJson<{ routine: { status: string } }>("schedules", {
      id: "req_sched_resume_1",
      action: "pause_routine",
      routineId,
      paused: false,
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.routine.status).toBe("active");

    expect((await b.postJson("schedules", { id: "req_sched_cancel_r", action: "cancel_routine", routineId })).status).toBe(200);
    expect((await b.postJson("schedules", { id: "req_sched_cancel_f", action: "cancel_followup", followupId })).status).toBe(200);
    expect((await b.postJson("schedules", { id: "req_sched_cancel_w", action: "cancel_pr_watch", watchId })).status).toBe(200);

    const after = await b.getJson<{
      routines: Array<{ routineId: string; status: string }>;
      followups: Array<{ followupId: string; status: string }>;
      prWatches: Array<{ id: string; status: string }>;
    }>("schedules");
    expect(after.body.routines.find((r) => r.routineId === routineId)?.status).toBe("cancelled");
    expect(after.body.followups.find((f) => f.followupId === followupId)?.status).toBe("cancelled");
    expect(after.body.prWatches.find((w) => w.id === watchId)?.status).toBe("cancelled");
  });
});
