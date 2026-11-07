/**
 * Durable Object SQL API over `node:sqlite`.
 *
 * The Agents SDK and the steward's own code talk to `ctx.storage.sql` through one method,
 * `exec(query, ...bindings)`, and read the result as a cursor: iterable, `.toArray()`,
 * `.one()`, `.raw()`, `.rowsRead`/`.rowsWritten`, `.columnNames`. workerd's SQLite is
 * synchronous; so is `node:sqlite`, which keeps the port faithful (and keeps
 * `storage.transactionSync` genuinely synchronous, as the schema runner requires).
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

/** A materialized cursor, matching the subset of `SqlStorageCursor` both callers rely on. */
export class SqlCursor<T extends SqlRow = SqlRow> implements Iterable<T> {
  readonly rows: T[];
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;

  constructor(rows: T[], columnNames: string[], rowsRead: number, rowsWritten: number) {
    this.rows = rows;
    this.columnNames = columnNames;
    this.rowsRead = rowsRead;
    this.rowsWritten = rowsWritten;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.rows[Symbol.iterator]();
  }

  /** workerd's cursor is its own iterator: `exec(sql).next()` is how callers take one row. */
  next(): IteratorResult<T> {
    return this.rows[Symbol.iterator]().next();
  }

  toArray(): T[] {
    return this.rows;
  }

  one(): T {
    if (this.rows.length !== 1) {
      throw new Error(`Expected exactly one row, got ${this.rows.length}`);
    }
    return this.rows[0] as T;
  }

  *raw<T = SqlValue[]>(): Iterable<T> {
    for (const row of this.rows) yield Object.values(row) as unknown as T;
  }

  get length(): number {
    return this.rows.length;
  }
}

function normalize(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "object") {
    throw new TypeError(`Unsupported SQL binding: ${Object.prototype.toString.call(value)}`);
  }
  return value as SqlValue;
}

/** True when the text holds more than one statement (workerd accepts the whole batch). */
function isMultiStatement(query: string): boolean {
  const withoutStrings = query
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const parts = withoutStrings.split(";").map((part) => part.trim()).filter(Boolean);
  return parts.length > 1;
}

export class SqlStore {
  readonly db: DatabaseSync;
  #changes: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.#changes = db.prepare("SELECT total_changes() AS n");
  }

  #totalChanges(): number {
    const row = this.#changes.get() as { n: number | bigint } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Run one statement with bindings, or a whole batch when the text holds several. */
  exec<T extends SqlRow = SqlRow>(query: string, ...bindings: unknown[]): SqlCursor<T> {
    const params = bindings.map(normalize);
    if (isMultiStatement(query)) {
      if (params.length > 0) {
        throw new Error("Durable Object SQL: multi-statement queries cannot take bindings");
      }
      const before = this.#totalChanges();
      this.db.exec(query);
      const written = this.#totalChanges() - before;
      return new SqlCursor<T>([], [], 0, written);
    }
    const statement = this.db.prepare(query);
    const columns = statement.columns().map((column) => column.name);
    if (columns.length === 0) {
      const before = this.#totalChanges();
      statement.run(...(params as SqlValue[]));
      return new SqlCursor<T>([], [], 0, this.#totalChanges() - before);
    }
    // `all()` returns null-prototype rows; copy them so callers can spread/assign freely.
    const rows = statement.all(...(params as SqlValue[])).map((row) => ({ ...row }) as T);
    return new SqlCursor<T>(rows, columns, rows.length, 0);
  }
}
