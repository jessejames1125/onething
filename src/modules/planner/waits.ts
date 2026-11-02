/**
 * "This waits on that": a to-do stays out of sight until the one it waits on is finished.
 */
import type { Ctx } from "../../core/types";

/** Open to-dos still waiting on another open to-do. */
export async function waitingIds(ctx: Ctx): Promise<Set<number>> {
  const rows = await ctx.db.all<{ task_id: number }>("SELECT w.task_id FROM task_waits w JOIN tasks t ON t.id = w.waits_on WHERE t.status IN ('todo','doing','held')");
  return new Set(rows.map((r) => r.task_id));
}

/** The open to-dos this one waits on. */
export async function waitsOn(ctx: Ctx, id: number): Promise<Array<{ id: number; title: string }>> {
  return ctx.db.all("SELECT t.id, t.title FROM task_waits w JOIN tasks t ON t.id = w.waits_on WHERE w.task_id = ? AND t.status IN ('todo','doing','held') ORDER BY t.id", id);
}

/** Would "id waits on on" close a loop? True when `on` already waits, however indirectly, on `id`. */
export async function hasWaitLoop(ctx: Ctx, id: number, on: number): Promise<boolean> {
  if (id === on) return true;
  const edges = await ctx.db.all<{ task_id: number; waits_on: number }>("SELECT task_id, waits_on FROM task_waits");
  const seen = new Set<number>();
  const stack = [on];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === id) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const e of edges) if (e.task_id === at) stack.push(e.waits_on);
  }
  return false;
}
