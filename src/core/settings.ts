import type { Db, Settings } from "./types";

/**
 * Groups read whole on first use: building Now read 17 "planner." keys one at a time (17 D1 round trips). Only
 * small, fixed groups belong here, never one that grows by date (capture.tension_review.<date>).
 */
const GROUPS = ["planner."];

/** Settings table access with a per-ctx cache (one request / one job tick). */
export function makeSettings(db: Db): Settings {
  const cache = new Map<string, string | null>();
  const groups = new Map<string, Promise<void>>();

  function loadGroup(prefix: string): Promise<void> {
    let p = groups.get(prefix);
    if (!p) {
      // Every key from "planner." up to "planner/" ("/" sorts right after "."): the group's keys, on the primary key.
      p = db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key >= ? AND key < ?", prefix, prefix.slice(0, -1) + "/").then((rows) => {
        for (const r of rows) if (!cache.has(r.key)) cache.set(r.key, r.value);
      });
      groups.set(prefix, p);
      p.catch(() => groups.delete(prefix));
    }
    return p;
  }

  async function read(key: string): Promise<string | null> {
    if (cache.has(key)) return cache.get(key)!;
    const group = GROUPS.find((g) => key.startsWith(g));
    if (group) {
      await loadGroup(group);
      if (!cache.has(key)) cache.set(key, null);
      return cache.get(key)!;
    }
    const row = await db.one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    const v = row?.value ?? null;
    cache.set(key, v);
    return v;
  }

  const settings = {
    async get(key: string, fallback?: string) {
      const v = await read(key);
      return v ?? fallback ?? null;
    },
    async getJSON<T>(key: string, fallback: T): Promise<T> {
      const v = await read(key);
      if (v == null) return fallback;
      try {
        return JSON.parse(v) as T;
      } catch {
        return fallback;
      }
    },
    async getNumber(key: string, fallback: number) {
      const v = await read(key);
      const n = v == null ? NaN : Number(v);
      return Number.isFinite(n) ? n : fallback;
    },
    async set(key: string, value: string) {
      await db.run(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        key,
        value,
        new Date().toISOString(),
      );
      cache.set(key, value);
    },
    async setJSON(key: string, value: unknown) {
      await settings.set(key, JSON.stringify(value));
    },
  };
  return settings as Settings;
}
