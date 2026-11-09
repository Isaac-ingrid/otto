// Thread subscription (issue #1, P4): a watcher follows one Thread instead of polling
// `GET /api/messages` and diffing it. The frames carry the timeline rows themselves — the same
// facts the workspace renders (steward.md §5 timeline) — and `sh_timeline.id` doubles as the
// resume cursor, so a reconnect asks for the gap rather than the whole history.
//
// This is the owner socket, not a public surface: no SSE endpoint, no webhook delivery, and no
// model involvement (it must work with the model unavailable, like the rest of the workspace).
import { z } from "zod";

/** One `sh_timeline` row as a watcher sees it. */
export const ThreadEventSchema = z.object({
  id: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  kind: z.string(),
  text: z.string(),
  refs: z.string().nullable().optional(),
});
export type ThreadEvent = z.infer<typeof ThreadEventSchema>;

/** browser → DO: follow `threadId`.
 *  - `after` omitted: the Thread's most recent page, then live (a fresh watcher).
 *  - `after: <last id seen>`: only what came after it, then live (a reconnecting watcher). */
export const SubscribeThreadMessageSchema = z.object({
  t: z.literal("subscribe_thread"),
  threadId: z.string().min(1),
  after: z.number().int().nonnegative().optional(),
});
export type SubscribeThreadMessage = z.infer<typeof SubscribeThreadMessageSchema>;

/** browser → DO: stop following. Frames stop at once; the row is not replayed on reconnect. */
export const UnsubscribeThreadMessageSchema = z.object({
  t: z.literal("unsubscribe_thread"),
});
export type UnsubscribeThreadMessage = z.infer<typeof UnsubscribeThreadMessageSchema>;

/** DO → browser: rows for the subscribed Thread, oldest first. Used for both the subscribe
 *  backfill and every incremental push, so a watcher has one code path. `more: true` means the
 *  page was capped and the remainder follows in the next frame (it is never dropped). */
export const ThreadEventsMessageSchema = z.object({
  t: z.literal("thread_events"),
  threadId: z.string().min(1),
  events: z.array(ThreadEventSchema),
  more: z.literal(true).optional(),
});
export type ThreadEventsMessage = z.infer<typeof ThreadEventsMessageSchema>;
