// The workspace's half of the Thread subscription (protocol §6.9, issues #1 and #4): the pure
// bits that turn `thread_events` / `thread_state` frames into what the page already knows how to
// render. workspace.js keeps the socket, the state and the DOM; every decision made here is
// testable without a browser.
//
// The snapshot from /app/api/workspace stays authoritative — these functions only merge what the
// steward pushed since, and are safe to call with rows the snapshot already carries (id is the
// cursor, so a row is never rendered twice).

/** A `sh_timeline` row as the workspace renders it (the shape workspace.ts builds from the same
 *  table, so a pushed row and a fetched one are indistinguishable). */
export function timelineEntry(event) {
  return { id: event.id, at: event.ts, kind: event.kind, text: event.text };
}

/** The id to resume from: the newest row already on screen, or undefined for a Thread with none.
 *  Undefined means "no cursor" — the subscriber then gets the Thread's most recent page. */
export function lastTimelineId(timeline) {
  return timeline && timeline.length ? timeline[timeline.length - 1].id : undefined;
}

/** Merges pushed rows into the timeline on screen. A row already present is left exactly as it
 *  was (the same id is never rendered twice, however the frames and the snapshot interleave);
 *  the result stays ordered by id, which is the table's own order and the resume cursor. */
export function mergeTimeline(timeline, events) {
  const seen = new Set(timeline.map((entry) => entry.id));
  const merged = [...timeline];
  for (const event of events ?? []) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(timelineEntry(event));
  }
  return merged.sort((left, right) => left.id - right.id);
}

/** Applies a `thread_state` frame: the chip's state, the state of every worker it names, and how
 *  many questions are open. A frame naming a worker this page has never seen cannot be merged —
 *  the rest of that worker (agent, branch, machine…) only comes with a snapshot, so the caller is
 *  told to refetch instead of inventing one. */
export function applyThreadState(thread, frame) {
  const known = new Set(thread.workers.map((worker) => worker.id));
  const patches = new Map((frame.workers ?? []).map((worker) => [worker.workerId, worker]));
  return {
    thread: {
      ...thread,
      state: frame.state,
      openQuestions: frame.openQuestions,
      workers: thread.workers.map((worker) => {
        const patch = patches.get(worker.id);
        if (!patch) return worker;
        return {
          ...worker,
          state: patch.state,
          ...(patch.contextPercent !== undefined ? { contextPercent: patch.contextPercent } : {}),
          ...(patch.contextTokens !== undefined ? { contextTokens: patch.contextTokens } : {}),
          ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
          ...(patch.compactionCount !== undefined ? { compactionCount: patch.compactionCount } : {}),
          ...(patch.lastToolDurationMs !== undefined ? { lastToolDurationMs: patch.lastToolDurationMs } : {}),
        };
      }),
    },
    unknownWorkers: (frame.workers ?? []).some((worker) => !known.has(worker.workerId)),
  };
}
