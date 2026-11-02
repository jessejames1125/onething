import type { Db, SqlParam } from "./types";

function coerce(v: unknown): SqlParam {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && !(v instanceof ArrayBuffer) && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v as SqlParam;
}

export interface MakeDbOptions {
  /**
   * Remember the answer to a repeated SELECT (same SQL, same values) for this Db's life. Only for one GET request
   * (src/index.ts): one Now load asked D1 the same question up to 11 times, and each D1 round trip costs ~20 ms live.
   * Any write through this Db forgets everything, before and after it runs; callers get their own copy of the rows.
   */
  memoReads?: boolean;
}

const READ = /^\s*select\b/i;

export function makeDb(d1: D1Database, opts: MakeDbOptions = {}): Db {
  const bind = (sql: string, params: SqlParam[]) => d1.prepare(sql).bind(...params.map(coerce));
  const memo = opts.memoReads ? new Map<string, Promise<unknown>>() : null;

  /** A write: forget every remembered read before it starts and after it ends (a read racing it may be stale). */
  async function write<R>(go: () => Promise<R>): Promise<R> {
    memo?.clear();
    try {
      return await go();
    } finally {
      memo?.clear();
    }
  }

  async function read<R>(kind: string, sql: string, params: SqlParam[], go: () => Promise<R>): Promise<R> {
    if (!memo) return go();
    // one()/all() also run the odd INSERT ... RETURNING: anything but a plain SELECT counts as a write.
    if (!READ.test(sql)) return write(go);
    const values = params.map(coerce);
    if (values.some((v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v))) return go();
    const key = `${kind}\u0000${sql}\u0000${JSON.stringify(values)}`;
    let p = memo.get(key) as Promise<R> | undefined;
    if (!p) {
      p = go();
      memo.set(key, p);
      p.catch(() => memo.get(key) === p && memo.delete(key));
    }
    return structuredClone(await p);
  }

  return {
    raw: d1,
    async one<T>(sql: string, ...params: SqlParam[]) {
      return read("one", sql, params, async () => ((await bind(sql, params).first<T>()) ?? null) as T | null);
    },
    async all<T>(sql: string, ...params: SqlParam[]) {
      return read("all", sql, params, async () => (await bind(sql, params).all<T>()).results ?? []);
    },
    async run(sql: string, ...params: SqlParam[]) {
      return write(() => bind(sql, params).run());
    },
    async batch(stmts) {
      if (stmts.length === 0) return [];
      return write(() => d1.batch(stmts.map(([sql, params]) => bind(sql, params ?? []))));
    },
    async insert(table, row) {
      const keys = Object.keys(row).filter((k) => row[k] !== undefined);
      const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
      const res = await write(() => bind(sql, keys.map((k) => coerce(row[k]))).run());
      return Number(res.meta.last_row_id);
    },
    async update(table, id, fields, idColumn = "id") {
      const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
      if (keys.length === 0) return;
      const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${idColumn} = ?`;
      await write(() => bind(sql, [...keys.map((k) => coerce(fields[k])), id]).run());
    },
  };
}

/** ISO-8601 UTC timestamp, the format every *_at column uses. */
export function nowIso(d: Date = new Date()): string {
  return d.toISOString();
}

/** Parse a JSON column safely. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
