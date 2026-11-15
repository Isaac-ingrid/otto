// Shared types between Steward and its extracted service modules (phase 5 split).
// Kept in a separate file to avoid circular imports: the service modules import these
// types, and Steward imports the service modules.
import type { ConnState } from "./history-subscriptions.ts";

export type { ConnState };

/** A snapshot of one outbox row — the shape the DO's SQL helper returns when selecting from
 *  `outbox`. Used by the connector-protocol module and by Steward's own outbox methods. */
export interface OutboxRow {
  cmdId: string;
  deviceId: string;
  workerId: string | null;
  cseq: number;
  kind: string;
  payload: string;
  notAfter: number | null;
  state: string;
  failReason: string | null;
  attempts: number;
  sentAt: number | null;
  ackDeadline: number | null;
  result: string | null;
  createdAt: number;
}
