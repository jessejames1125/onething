import type { AlertInput, Ctx } from "./types";

/**
 * Deduped alert: inserts by key (UNIQUE). If an unresolved alert with that key exists nothing changes. A resolved alert
 * with the same key is re-opened. Alerts are listed on the System screen; nothing interrupts the owner.
 */
export async function raiseAlert(ctx: Ctx, input: AlertInput): Promise<void> {
  const level = input.level ?? "warn";
  const now = ctx.now().toISOString();
  const existing = await ctx.db.one<{ id: number; resolved_at: string | null }>("SELECT id, resolved_at FROM alerts WHERE key = ?", input.key);
  if (existing && !existing.resolved_at) return; // already open
  if (existing) {
    await ctx.db.run("UPDATE alerts SET message = ?, level = ?, module = ?, resolved_at = NULL, created_at = ? WHERE id = ?", input.message, level, input.module ?? null, now, existing.id);
  } else {
    await ctx.db.insert("alerts", { key: input.key, level, message: input.message, module: input.module ?? null, created_at: now });
  }
  ctx.log(`[alert:${level}] ${input.key}: ${input.message}`);
}

export async function resolveAlert(ctx: Ctx, key: string): Promise<void> {
  await ctx.db.run("UPDATE alerts SET resolved_at = ? WHERE key = ? AND resolved_at IS NULL", ctx.now().toISOString(), key);
}
