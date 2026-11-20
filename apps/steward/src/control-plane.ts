// Deterministic owner control plane for three-layer memory, proactive schedules, and PR watches.
// Zero LLM calls, zero worker dispatches: remains 100% operational when over daily budget or offline.
import type { BudgetState } from "./budget.ts";
import type { Ledger } from "./ledger.ts";
import { isNoteKind, type NoteKind, type NoteLayer, type NoteRow, type NotesUsageSummary } from "./notes.ts";
import type { PrWatchFailureBrief, PrWatchRow } from "./pr-watch.ts";
import { WorkspaceError } from "./workspace.ts";

const REQUEST_ID = /^[\w-]{8,128}$/;
const ENTITY_ID = /^[\w:-]{1,128}$/;
const ARCHIVE_LIST_LIMIT = 50;
const HISTORY_LIMIT = 20;

export interface ControlPlaneSummary {
  residentUsedChars: number;
  residentCapChars: number;
  unconfirmedNotes: number;
  pressureCount: number;
  activeRoutines: number;
  pausedRoutines: number;
  openFollowups: number;
  activePrWatches: number;
}

export interface ControlPlaneDeps {
  ledger: Ledger;
  tx<T>(fn: () => T): T;
  budget(): BudgetState;
  listSdkSchedules(): Promise<Array<{ id: string; time?: number }>>;
  pauseRoutine(routineId: string, paused: boolean): Promise<{ ok: true; what: string } | { ok: false; reason: string }>;
  cancelSchedule(scheduleId: string): Promise<{ ok: true; what: string } | { ok: false; reason: string }>;
  listPrWatches(): PrWatchRow[];
  summarizePrWatchFailure?(watch: PrWatchRow): PrWatchFailureBrief;
  cancelPrWatch(watchId: string): boolean;
  onChanged?(): void;
  audit(reason: string, detail: string): void;
}

export function buildControlPlaneSummary(ledger: Ledger, activePrWatches: number): ControlPlaneSummary {
  const usage = ledger.notes.usage();
  const routines = ledger.routines.list();
  const followups = ledger.followups.list();
  let activeRoutines = 0;
  let pausedRoutines = 0;
  for (const r of routines) {
    if (r.status === "active") activeRoutines += 1;
    else if (r.status === "paused") pausedRoutines += 1;
  }
  let openFollowups = 0;
  for (const f of followups) if (f.status === "open") openFollowups += 1;
  return {
    residentUsedChars: usage.resident.usedChars,
    residentCapChars: usage.resident.capChars,
    unconfirmedNotes: usage.unconfirmedCount,
    pressureCount: usage.pressure.length,
    activeRoutines,
    pausedRoutines,
    openFollowups,
    activePrWatches,
  };
}

export interface MemoryViewResult {
  notes: NoteRow[];
  usage: NotesUsageSummary;
  repos: Array<{
    id: string;
    name: string;
    machine: string | null;
    deviceId: string;
    online: boolean;
    capabilityKind: "git" | "plain";
  }>;
}

export function readMemoryControlPlane(ledger: Ledger, searchParams: URLSearchParams): MemoryViewResult {
  const rawLayer = searchParams.get("layer") ?? "active";
  if (rawLayer !== "active" && rawLayer !== "all" && rawLayer !== "resident" && rawLayer !== "project" && rawLayer !== "archive") {
    throw new WorkspaceError("bad_request", 400);
  }
  const repoId = searchParams.get("repoId")?.trim() || undefined;
  if (repoId !== undefined && !ENTITY_ID.test(repoId)) throw new WorkspaceError("bad_request", 400);
  const q = searchParams.get("q")?.trim() ?? "";
  if (q.length > 256) throw new WorkspaceError("bad_request", 400);

  let notes: NoteRow[];
  if (q.length > 0) {
    const layers: NoteLayer[] | undefined =
      rawLayer === "all" ? undefined : rawLayer === "active" ? ["resident", "project"] : [rawLayer];
    notes = ledger.notes.search(q, {
      ...(layers ? { layers } : {}),
      ...(repoId ? { repoIds: [repoId] } : {}),
    });
  } else if (rawLayer === "active") {
    notes = ledger.notes.list({ ...(repoId ? { scopeRepoId: repoId } : {}) });
  } else {
    const listed = ledger.notes.list({ layer: rawLayer, ...(repoId ? { scopeRepoId: repoId } : {}) });
    notes =
      rawLayer === "archive"
        ? [...listed].sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt)).slice(0, ARCHIVE_LIST_LIMIT)
        : listed;
  }

  const machineNames = new Map(ledger.machines.list().map((m) => [m.deviceId, m.name]));
  const repos = ledger.repos.list().map((r) => ({
    id: r.repoId,
    name: r.name,
    machine: machineNames.get(r.deviceId) ?? r.deviceId,
    deviceId: r.deviceId,
    online: r.online,
    capabilityKind: r.capabilityKind,
  }));
  return { notes, usage: ledger.notes.usage(), repos };
}

const parseIdList = (raw: unknown): string[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 50 || raw.some((v) => typeof v !== "string" || !ENTITY_ID.test(v))) {
    throw new WorkspaceError("bad_request", 400);
  }
  return raw as string[];
};

function checkReplay<T>(ledger: Ledger, key: string, reqSig: string): T | null {
  const previous = ledger.webRequests.get(key);
  if (!previous) return null;
  const parsed = JSON.parse(previous.payload) as { req?: string; res?: T };
  if (parsed.req !== reqSig) throw new WorkspaceError("id_conflict", 409);
  if (previous.status === "done" && parsed.res !== undefined) return parsed.res;
  return null;
}

function saveReplay(ledger: Ledger, key: string, reqSig: string, res: unknown): void {
  ledger.webRequests.start(key, JSON.stringify({ req: reqSig, res }));
  ledger.webRequests.complete(key);
}

export function mutateMemoryControlPlane(deps: Pick<ControlPlaneDeps, "ledger" | "tx" | "audit" | "onChanged">, body: Record<string, unknown>): unknown {
  const { id, action } = body;
  if (typeof id !== "string" || !REQUEST_ID.test(id) || typeof action !== "string") {
    throw new WorkspaceError("bad_request", 400);
  }
  const { id: _ignored, ...rest } = body;
  const key = `mem:${id}`;
  const reqSig = JSON.stringify(rest);
  const replayed = checkReplay<unknown>(deps.ledger, key, reqSig);
  if (replayed !== null) return replayed;

  const { notes } = deps.ledger;
  const commitOrThrow = (
    draft: Parameters<typeof notes.commit>[0],
    supersedes?: string[],
    evicts?: string[],
  ) => {
    const res = notes.commit(draft, {
      ...(supersedes ? { supersedes } : {}),
      ...(evicts ? { evicts } : {}),
      reported: true,
      noParkPressure: true,
    });
    if (!res.ok) {
      if (res.code === "capacity") {
        throw new WorkspaceError("capacity_exceeded", 409, {
          message: res.message,
          needsEviction: res.needsEviction,
        });
      }
      throw new WorkspaceError(res.code === "trust" ? "trust_violation" : res.code, 400, { message: res.message });
    }
    return res;
  };

  const result = deps.tx(() => {
    switch (action) {
      case "create": {
        const { layer, scopeRepoId, kind, text, pinned, supersedes, evicts } = body;
        if ((layer !== "resident" && layer !== "project") || typeof kind !== "string" || !isNoteKind(kind) || typeof text !== "string") {
          throw new WorkspaceError("bad_request", 400);
        }
        if (scopeRepoId !== undefined && (typeof scopeRepoId !== "string" || !ENTITY_ID.test(scopeRepoId))) {
          throw new WorkspaceError("bad_request", 400);
        }
        if (pinned !== undefined && typeof pinned !== "boolean") throw new WorkspaceError("bad_request", 400);
        const committed = commitOrThrow(
          {
            text,
            kind: kind as NoteKind,
            source: "user_said",
            layer,
            ...(layer === "project" && typeof scopeRepoId === "string" ? { scopeRepoId } : {}),
            evidence: "web:owner",
            confirmed: true,
          },
          parseIdList(supersedes),
          parseIdList(evicts),
        );
        if (pinned === true && !committed.note.pinned) {
          notes.pin(committed.note.noteId, true, { reported: true });
        }
        return { ok: true, id, note: notes.get(committed.note.noteId)!, bumped: committed.bumped };
      }
      case "pin": {
        const { noteId, pinned } = body;
        if (typeof noteId !== "string" || !ENTITY_ID.test(noteId) || typeof pinned !== "boolean") {
          throw new WorkspaceError("bad_request", 400);
        }
        const res = notes.pin(noteId, pinned, { reported: true });
        if (!res.ok) throw new WorkspaceError("note_not_found", 404);
        const updated = notes.get(noteId);
        if (!updated || updated.status === "removed") throw new WorkspaceError("note_not_found", 404);
        return { ok: true, id, note: updated };
      }
      case "confirm": {
        const { noteId } = body;
        if (typeof noteId !== "string" || !ENTITY_ID.test(noteId)) throw new WorkspaceError("bad_request", 400);
        const res = notes.confirm(noteId, "web:owner_confirm", { reported: true });
        if (!res.ok) {
          if (res.reason === "missing") throw new WorkspaceError("note_not_found", 404);
          if (res.reason === "removed" || res.reason === "superseded") throw new WorkspaceError("note_inactive", 409);
        }
        return { ok: true, id, note: notes.get(noteId)! };
      }
      case "promote": {
        const { noteId, evicts } = body;
        if (typeof noteId !== "string" || !ENTITY_ID.test(noteId)) throw new WorkspaceError("bad_request", 400);
        const basis = notes.get(noteId);
        if (!basis) throw new WorkspaceError("note_not_found", 404);
        if (basis.status !== "active") throw new WorkspaceError("note_inactive", 409);
        if (basis.layer === "resident") throw new WorkspaceError("already_resident", 400);
        if (basis.source === "connector") throw new WorkspaceError("connector_cannot_promote", 400);
        const wasPinned = basis.pinned;
        if (wasPinned) notes.pin(basis.noteId, false, { reported: true });
        if (!basis.confirmed) notes.confirm(basis.noteId, "web:owner_promote", { reported: true });
        const committed = commitOrThrow(
          {
            text: basis.text,
            kind: basis.kind,
            source: basis.source,
            layer: "resident",
            evidence: basis.confirmedBy ?? basis.evidence ?? `web:promote:${basis.noteId}`,
            confirmed: true,
          },
          [basis.noteId],
          parseIdList(evicts),
        );
        if (wasPinned && !committed.note.pinned) {
          notes.pin(committed.note.noteId, true, { reported: true });
        }
        return { ok: true, id, note: notes.get(committed.note.noteId)!, bumped: committed.bumped };
      }
      case "archive": {
        const { noteId } = body;
        if (typeof noteId !== "string" || !ENTITY_ID.test(noteId)) throw new WorkspaceError("bad_request", 400);
        const res = notes.archiveByOwner(noteId);
        if (!res.ok) {
          if (res.reason === "missing") throw new WorkspaceError("note_not_found", 404);
          if (res.reason === "pinned") throw new WorkspaceError("note_pinned", 409);
          throw new WorkspaceError("note_inactive", 409);
        }
        return { ok: true, id, note: notes.get(noteId)! };
      }
      case "remove": {
        const { noteId } = body;
        if (typeof noteId !== "string" || !ENTITY_ID.test(noteId)) throw new WorkspaceError("bad_request", 400);
        const res = notes.remove(noteId, { reported: true });
        if (!res.ok) throw new WorkspaceError("note_not_found", 404);
        return { ok: true, id, noteId };
      }
      case "dismiss_pressure": {
        const { pressureId } = body;
        if (!Number.isSafeInteger(pressureId) || (pressureId as number) < 1) {
          throw new WorkspaceError("bad_request", 400);
        }
        return { ok: true, id, dismissed: notes.dismissPressure(pressureId as number) };
      }
      default:
        throw new WorkspaceError("bad_request", 400);
    }
  });

  deps.tx(() => saveReplay(deps.ledger, key, reqSig, result));
  deps.audit("web_memory_mutated", action);
  deps.onChanged?.();
  return result;
}

export async function readSchedulesControlPlane(deps: ControlPlaneDeps) {
  const sdkSchedules = await deps.listSdkSchedules();
  const nextByScheduleId = new Map<string, number>();
  for (const s of sdkSchedules) {
    if (typeof s.id === "string" && typeof s.time === "number" && Number.isFinite(s.time)) {
      nextByScheduleId.set(s.id, Math.round(s.time * 1000));
    }
  }
  const repoNames = new Map(deps.ledger.repos.list().map((r) => [r.repoId, r.name]));
  const threadTitle = (threadId: string | null): string | null =>
    threadId ? (deps.ledger.threads.get(threadId)?.title ?? null) : null;

  const allRoutines = deps.ledger.routines.list();
  const liveRoutines = allRoutines
    .filter((r) => r.status === "active" || r.status === "paused")
    .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || b.createdAt - a.createdAt);
  const pastRoutines = allRoutines
    .filter((r) => r.status === "done" || r.status === "cancelled")
    .sort((a, b) => (b.lastRunAt ?? b.createdAt) - (a.lastRunAt ?? a.createdAt))
    .slice(0, HISTORY_LIMIT);
  const routines = [...liveRoutines, ...pastRoutines].map((r) => ({
    ...r,
    nextRunAt:
      r.status === "active"
        ? ((r.scheduleId ? nextByScheduleId.get(r.scheduleId) : undefined) ?? r.onceAt ?? null)
        : null,
    repoName: r.repoId ? (repoNames.get(r.repoId) ?? r.repoId) : null,
    threadTitle: threadTitle(r.threadId),
  }));

  const allFollowups = deps.ledger.followups.list();
  const openFollowups = allFollowups.filter((f) => f.status === "open").sort((a, b) => a.dueAt - b.dueAt);
  const pastFollowups = allFollowups
    .filter((f) => f.status !== "open")
    .sort((a, b) => (b.firedAt ?? b.createdAt) - (a.firedAt ?? a.createdAt))
    .slice(0, HISTORY_LIMIT);
  const followups = [...openFollowups, ...pastFollowups].map((f) => ({
    ...f,
    threadTitle: threadTitle(f.threadId),
  }));

  const prWatches = deps.listPrWatches().map((w) => ({
    ...w,
    threadTitle: threadTitle(w.threadId),
    ...(deps.summarizePrWatchFailure ? deps.summarizePrWatchFailure(w) : {}),
  }));

  const budget = deps.budget();
  return {
    routines,
    followups,
    prWatches,
    budget: {
      costUsd: budget.costUsd,
      limitUsd: budget.budgetUsd,
      over: budget.over,
      resetsAt: budget.resetsAt,
    },
  };
}

export async function mutateSchedulesControlPlane(deps: ControlPlaneDeps, body: Record<string, unknown>): Promise<unknown> {
  const { id, action } = body;
  if (typeof id !== "string" || !REQUEST_ID.test(id) || typeof action !== "string") {
    throw new WorkspaceError("bad_request", 400);
  }
  const { id: _ignored, ...rest } = body;
  const key = `sched:${id}`;
  const reqSig = JSON.stringify(rest);
  const replayed = checkReplay<unknown>(deps.ledger, key, reqSig);
  if (replayed !== null) return replayed;

  let result: unknown;
  switch (action) {
    case "pause_routine": {
      const { routineId, paused } = body;
      if (typeof routineId !== "string" || !/^r_[\w-]{1,120}$/.test(routineId) || typeof paused !== "boolean") {
        throw new WorkspaceError("bad_request", 400);
      }
      const res = await deps.pauseRoutine(routineId, paused);
      if (!res.ok) {
        const exists = deps.ledger.routines.get(routineId) !== null;
        throw new WorkspaceError(exists ? "routine_inactive" : "not_found", exists ? 409 : 404, { message: res.reason });
      }
      result = { ok: true, id, routine: deps.ledger.routines.get(routineId) };
      break;
    }
    case "cancel_routine": {
      const { routineId } = body;
      if (typeof routineId !== "string" || !/^r_[\w-]{1,120}$/.test(routineId)) {
        throw new WorkspaceError("bad_request", 400);
      }
      const res = await deps.cancelSchedule(routineId);
      if (!res.ok) throw new WorkspaceError("not_found", 404, { message: res.reason });
      result = { ok: true, id, routine: deps.ledger.routines.get(routineId) };
      break;
    }
    case "cancel_followup": {
      const { followupId } = body;
      if (typeof followupId !== "string" || !/^f_[\w-]{1,120}$/.test(followupId)) {
        throw new WorkspaceError("bad_request", 400);
      }
      const res = await deps.cancelSchedule(followupId);
      if (!res.ok) throw new WorkspaceError("not_found", 404, { message: res.reason });
      result = { ok: true, id, followup: deps.ledger.followups.get(followupId) };
      break;
    }
    case "cancel_pr_watch": {
      const { watchId } = body;
      if (typeof watchId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(watchId)) {
        throw new WorkspaceError("bad_request", 400);
      }
      const cancelled = deps.cancelPrWatch(watchId);
      if (!cancelled) throw new WorkspaceError("not_found", 404);
      result = { ok: true, id, watchId };
      break;
    }
    default:
      throw new WorkspaceError("bad_request", 400);
  }

  deps.tx(() => saveReplay(deps.ledger, key, reqSig, result));
  deps.audit("web_schedule_mutated", action);
  deps.onChanged?.();
  return result;
}
