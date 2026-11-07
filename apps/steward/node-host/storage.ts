/**
 * `DurableObjectStorage` over `node:sqlite`.
 *
 * The steward and the Agents SDK touch three parts of the storage surface:
 *
 *  - `sql` — the DO SQL API (see ./sqlite.ts);
 *  - `transactionSync` — the schema runner wraps every migration in one, so it must be
 *    genuinely synchronous and must not itself be awaited; `transaction` (async) is what
 *    pi-durable's SQLite adapter uses for its sessions;
 *  - `setAlarm`/`getAlarm`/`deleteAlarm` — the Agents scheduler and the steward's own
 *    `this.schedule()` both ride on the single platform alarm, which we persist so a
 *    process restart still wakes up on time.
 *
 * The key/value half (`get`/`put`/`delete`/`list`) is here for the SDK's bookkeeping tables;
 * the steward keeps all durable state in SQL.
 */
import type { DatabaseSync } from "node:sqlite";
import { SqlStore } from "./sqlite.ts";

export interface DurableObjectTransactionLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T = unknown>(options?: { prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
  rollback(): void;
}

export interface StorageOptions {
  /** Called whenever the persisted alarm changes so the host can re-arm its timer. */
  onAlarmChange?: () => void;
}

type AlarmListener = () => void;

export class NodeDurableObjectStorage implements DurableObjectTransactionLike {
  readonly sql: SqlStore;
  #db: DatabaseSync;
  #options: StorageOptions;
  #transactionDepth = 0;
  #alarmChange: AlarmListener | undefined;

  constructor(db: DatabaseSync, options: StorageOptions = {}) {
    this.#db = db;
    this.#options = options;
    this.sql = new SqlStore(db);
    this.sql.exec("CREATE TABLE IF NOT EXISTS __host_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS __host_alarm (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)");
  }

  // -- transactions -------------------------------------------------------------------

  /** DO semantics: the callback is synchronous and runs inside one SQLite transaction. */
  transactionSync<T>(callback: () => T): T {
    if (this.#transactionDepth > 0) {
      // workerd forbids nesting; savepoints keep the port tolerant of the SDK's layering.
      const name = `sp_${this.#transactionDepth}`;
      this.#db.exec(`SAVEPOINT ${name}`);
      this.#transactionDepth += 1;
      try {
        const result = callback();
        this.#db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.#db.exec(`ROLLBACK TO ${name}`);
        this.#db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.#transactionDepth -= 1;
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#transactionDepth = 1;
    try {
      const result = callback();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // A failed COMMIT has already ended the transaction; keep the original error.
      }
      throw error;
    } finally {
      this.#transactionDepth = 0;
    }
  }

  /** Async transactions are only ever started from the top level (pi-durable sessions). */
  async transaction<T>(callback: (tx: DurableObjectTransactionLike) => Promise<T>): Promise<T> {
    if (this.#transactionDepth > 0) return callback(this);
    this.#db.exec("BEGIN IMMEDIATE");
    this.#transactionDepth = 1;
    try {
      const result = await callback(this);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Keep the original error; the transaction is already gone.
      }
      throw error;
    } finally {
      this.#transactionDepth = 0;
    }
  }

  rollback(): void {
    if (this.#transactionDepth === 0) throw new Error("No transaction is active");
    throw new Error("rollback() is not supported from this handle");
  }

  // -- key/value ----------------------------------------------------------------------

  /**
   * The synchronous key/value API (`ctx.storage.kv`) the Agents SDK's schema bookkeeping
   * uses. Values are JSON here rather than structured-clone; both sides are plain records.
   */
  readonly kv = {
    get: <T = unknown>(key: string): T | undefined => {
      const rows = this.sql.exec<{ value: string }>("SELECT value FROM __host_kv WHERE key = ?", key).toArray();
      if (rows.length === 0) return undefined;
      return JSON.parse(rows[0]!.value) as T;
    },
    put: <T = unknown>(key: string, value: T): void => {
      this.sql.exec(
        "INSERT INTO __host_kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        key,
        JSON.stringify(value ?? null),
      );
    },
    delete: (key: string): boolean => {
      const existed = this.kv.get(key) !== undefined;
      this.sql.exec("DELETE FROM __host_kv WHERE key = ?", key);
      return existed;
    },
    list: <T = unknown>(options: { prefix?: string; limit?: number; reverse?: boolean } = {}): Map<string, T> => {
      const result = new Map<string, T>();
      const rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM __host_kv ORDER BY key").toArray();
      for (const row of options.reverse ? rows.reverse() : rows) {
        if (options.prefix !== undefined && !row.key.startsWith(options.prefix)) continue;
        result.set(row.key, JSON.parse(row.value) as T);
        if (options.limit !== undefined && result.size >= options.limit) break;
      }
      return result;
    },
  };

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM __host_kv WHERE key = ?", key).toArray();
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0]!.value) as T;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.sql.exec(
      "INSERT INTO __host_kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value ?? null),
    );
  }

  /** The SDK calls both `put` and `set` in different places. */
  async set<T = unknown>(key: string, value: T): Promise<void> {
    return this.put(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(key) ? key : [key];
    let deleted = 0;
    for (const entry of keys) {
      const before = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM __host_kv WHERE key = ?", entry).one().n;
      this.sql.exec("DELETE FROM __host_kv WHERE key = ?", entry);
      deleted += before;
    }
    return Array.isArray(key) ? deleted : deleted > 0;
  }

  async list<T = unknown>(options: { prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean } = {}): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    const rows = this.sql.exec<{ key: string; value: string }>(
      "SELECT key, value FROM __host_kv ORDER BY key",
    ).toArray();
    const entries = options.reverse ? rows.reverse() : rows;
    for (const row of entries) {
      if (options.prefix !== undefined && !row.key.startsWith(options.prefix)) continue;
      if (options.start !== undefined && row.key < options.start) continue;
      if (options.end !== undefined && row.key >= options.end) continue;
      result.set(row.key, JSON.parse(row.value) as T);
      if (options.limit !== undefined && result.size >= options.limit) break;
    }
    return result;
  }

  // -- alarms -------------------------------------------------------------------------

  /** Register the host callback that re-arms its physical timer. */
  onAlarmChange(listener: AlarmListener | undefined): void {
    this.#alarmChange = listener ?? this.#options.onAlarmChange;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    const at = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    this.sql.exec(
      "INSERT INTO __host_alarm (id, at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at",
      at,
    );
    this.#alarmChange?.();
  }

  async getAlarm(): Promise<number | null> {
    const rows = this.sql.exec<{ at: number }>("SELECT at FROM __host_alarm WHERE id = 1").toArray();
    return rows.length === 0 ? null : rows[0]!.at;
  }

  async deleteAlarm(): Promise<void> {
    this.sql.exec("DELETE FROM __host_alarm WHERE id = 1");
    this.#alarmChange?.();
  }

  /** workerd flushes automatically; here every statement is already durable. */
  sync(): void {}

  /** Claim a due alarm: workerd clears the alarm before invoking `alarm()`. */
  takeDueAlarm(now: number): number | null {
    const at = this.sql.exec<{ at: number }>("SELECT at FROM __host_alarm WHERE id = 1").toArray()[0]?.at ?? null;
    if (at === null || at > now) return null;
    this.sql.exec("DELETE FROM __host_alarm WHERE id = 1");
    return at;
  }

  /** Peek at the armed alarm without consuming it. */
  peekAlarm(): number | null {
    return this.sql.exec<{ at: number }>("SELECT at FROM __host_alarm WHERE id = 1").toArray()[0]?.at ?? null;
  }

  get inTransaction(): boolean {
    return this.#transactionDepth > 0;
  }
}
