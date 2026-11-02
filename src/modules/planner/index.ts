/**
 * The planner module: the Now card, to-dos, goals, and Claude's morning pick.
 *
 * The morning runs as two jobs so the plan is never late. 06:35 queues a bundle for the runner, holding only to-dos the
 * owner typed. 07:00 takes the runner's answer, or if it has not reported, the app's own ranking stands (two misses in a
 * row raise an alert).
 */
import type { AgentTask, Ctx, FiledCapture, ModuleDef } from "../../core/types";
import { todoTitle } from "../../core/captureRules";
import { obj, optStr, ValidationError } from "../../core/validate";
import { TRUSTED_SOURCES } from "../../core/untrusted";
import { addTask } from "./tasks";
import { loadGoals, loadOpenTasks, pickTop, rankTasks } from "./rank";
import { itemAction, itemDetail, todoList, type ItemAction, type MorningPins } from "./now";
import { hasWaitLoop } from "./waits";

const ACTIONS: readonly ItemAction[] = ["done", "undo", "later", "pick_day", "stop", "already", "not_for_me"];
const MORNING_TASK_KEY = "planner.morning_task";

async function onCapture(ctx: Ctx, filed: FiledCapture) {
  const added = await addTask(ctx, { text: filed.text, title: todoTitle(filed.text), captureId: filed.capture.id, source: filed.capture.source, fields: filed.fields });
  if (added.duplicateOf) return { refTable: "tasks", refId: added.duplicateOf.id, receipt: `That's already on your list: ${added.duplicateOf.title}`, duplicateOf: added.duplicateOf };
  return { refTable: "tasks", refId: added.id, receipt: `On your list: ${added.title}` };
}

/** Only what the owner typed goes in the morning bundle. A to-do from outside the app stays out of it. */
export async function morningBundle(ctx: Ctx): Promise<Record<string, unknown>> {
  const today = ctx.localDate();
  const rows = (await loadOpenTasks(ctx)).filter((t) => t.source == null || TRUSTED_SOURCES.has(t.source));
  const goals = await loadGoals(ctx);
  const ranked = rankTasks(rows, goals, { today, morning: true });
  return {
    today,
    goals: goals.map((g) => ({ id: g.id, title: g.title, weight: g.weight })),
    tasks: ranked.slice(0, 30).map((t) => ({ id: t.id, title: t.title, due: t.due, urgent: t.isUrgent, reason: t.reason, goal: t.goalTitle })),
  };
}

async function morningQueue(ctx: Ctx): Promise<void> {
  if (!ctx.env.RUNNER_TOKEN) return;
  const today = ctx.localDate();
  const id = await ctx.agent.request("morning_plan", await morningBundle(ctx), {
    module: "planner",
    dueAt: new Date(ctx.now().getTime() + 25 * 60_000),
    outputSchema: { top3: [{ task_id: 12, title: "string", why: "one plain line" }], note: "string" },
  });
  await ctx.settings.setJSON(MORNING_TASK_KEY, { date: today, id });
}

/** The app's own pick stands in when the runner has not reported. */
async function codePick(ctx: Ctx): Promise<Record<string, unknown>> {
  const rows = (await loadOpenTasks(ctx)).filter((t) => t.source == null || TRUSTED_SOURCES.has(t.source));
  const ranked = rankTasks(rows, await loadGoals(ctx), { today: ctx.localDate(), morning: true });
  const top = pickTop(ranked, 3);
  if (!top.length) return { top3: [{ title: "Nothing on the list", task_id: null, why: "" }], note: "Empty list." };
  return { top3: top.map((t) => ({ task_id: t.id, title: t.title, why: t.reason })), note: "The app's own pick." };
}

async function savePins(ctx: Ctx, result: Record<string, unknown>, viaFallback: boolean): Promise<void> {
  // Without the runner the ranking already orders the day: pins are for Claude's answer.
  if (viaFallback) return;
  const today = ctx.localDate();
  // A pick cannot be an outside to-do: an email never reaches the top of Now by way of a fooled answer.
  const open = new Set((await loadOpenTasks(ctx)).filter((t) => t.source == null || TRUSTED_SOURCES.has(t.source)).map((t) => t.id));
  const items: MorningPins["items"] = [];
  for (const raw of (result.top3 as unknown[]) ?? []) {
    const o = obj(raw, "top3[]");
    const id = Number(o.task_id);
    if (open.has(id)) items.push({ id, why: (optStr(o.why) ?? "best fit for today").slice(0, 160) });
  }
  await ctx.settings.setJSON("planner.pins", { date: today, items } satisfies MorningPins);
}

async function morningApply(ctx: Ctx): Promise<void> {
  const saved = await ctx.settings.getJSON<{ date: string; id: number } | null>(MORNING_TASK_KEY, null);
  if (!saved || saved.date !== ctx.localDate()) return;
  const res = await ctx.agent.resolve(saved.id, { force: true, fallback: (c) => codePick(c) });
  if (res.result) await savePins(ctx, res.result, res.viaFallback);
}

async function onMorningResult(ctx: Ctx, task: AgentTask): Promise<void> {
  if (task.result) await savePins(ctx, task.result, false);
}

const planner: ModuleDef = {
  name: "planner",
  captureKinds: ["task"],
  onCapture,
  agentHandlers: { morning_plan: onMorningResult },
  jobs: [
    { name: "morning_queue", schedule: { at: "06:35" }, run: morningQueue },
    { name: "morning_apply", schedule: { at: "07:00" }, run: morningApply },
  ],
  routes(app) {
    app.get("/todos", async (c) => c.json({ items: await todoList(c.get("ctx")) }));
    app.get("/tasks/:id", async (c) => {
      const item = await itemDetail(c.get("ctx"), Number(c.req.param("id")));
      return item ? c.json(item) : c.json({ error: "not found" }, 404);
    });
    app.post("/tasks/:id/action", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { action?: string; date?: string; note?: string };
      if (!ACTIONS.includes(body.action as ItemAction)) return c.json({ error: "unknown action" }, 400);
      return c.json(await itemAction(c.get("ctx"), Number(c.req.param("id")), body.action as ItemAction, { date: body.date, note: body.note }));
    });
    // The owner's own call: it sticks, and it is the only way a to-do from outside the app can become urgent.
    app.post("/tasks/:id/urgent", async (c) => {
      const ctx = c.get("ctx");
      const body = (await c.req.json().catch(() => ({}))) as { urgent?: boolean };
      const urgent = body.urgent === true;
      const id = Number(c.req.param("id"));
      await ctx.db.run("UPDATE tasks SET urgent = ?, urgent_why = ?, triage_by = 'you', updated_at = ? WHERE id = ? AND status IN ('todo','doing')", urgent ? 1 : 0, urgent ? "you said so" : null, ctx.now().toISOString(), id);
      return c.json({ ok: true });
    });
    app.post("/tasks/:id/goal", async (c) => {
      const ctx = c.get("ctx");
      const body = (await c.req.json().catch(() => ({}))) as { goalId?: number | null };
      const goalId = body.goalId == null ? null : Number(body.goalId);
      if (goalId != null && !(await ctx.db.one("SELECT id FROM goals WHERE id = ?", goalId))) return c.json({ error: "no such goal" }, 400);
      await ctx.db.run("UPDATE tasks SET goal_id = ?, updated_at = ? WHERE id = ?", goalId, ctx.now().toISOString(), Number(c.req.param("id")));
      return c.json({ ok: true });
    });
    app.post("/tasks/:id/waits", async (c) => {
      const ctx = c.get("ctx");
      const id = Number(c.req.param("id"));
      const on = Number(((await c.req.json().catch(() => ({}))) as { waitsOn?: number }).waitsOn);
      if (!Number.isInteger(on) || !(await ctx.db.one("SELECT id FROM tasks WHERE id = ?", on))) return c.json({ error: "no such to-do" }, 400);
      if (await hasWaitLoop(ctx, id, on)) return c.json({ error: "that would make a loop" }, 409);
      await ctx.db.run("INSERT OR IGNORE INTO task_waits (task_id, waits_on) VALUES (?, ?)", id, on);
      return c.json({ ok: true });
    });
    app.get("/goals", async (c) => c.json({ items: await c.get("ctx").db.all("SELECT id, title, weight, status FROM goals WHERE status != 'done' ORDER BY weight DESC, id") }));
    app.post("/goals", async (c) => {
      const ctx = c.get("ctx");
      const body = (await c.req.json().catch(() => ({}))) as { title?: string; weight?: number };
      const title = (body.title ?? "").trim().slice(0, 120);
      if (!title) throw new ValidationError("A goal needs a title.");
      const now = ctx.now().toISOString();
      const weight = Number.isFinite(body.weight) ? Math.max(0.1, Math.min(3, Number(body.weight))) : 1;
      return c.json({ id: await ctx.db.insert("goals", { title, weight, created_at: now, updated_at: now }) });
    });
    app.post("/goals/:id", async (c) => {
      const ctx = c.get("ctx");
      const body = (await c.req.json().catch(() => ({}))) as { title?: string; weight?: number; status?: string };
      const fields: Record<string, unknown> = { updated_at: ctx.now().toISOString() };
      if (typeof body.title === "string" && body.title.trim()) fields.title = body.title.trim().slice(0, 120);
      if (Number.isFinite(body.weight)) fields.weight = Math.max(0.1, Math.min(3, Number(body.weight)));
      if (body.status === "active" || body.status === "paused" || body.status === "done") fields.status = body.status;
      await ctx.db.update("goals", Number(c.req.param("id")), fields);
      return c.json({ ok: true });
    });
  },
};

export default planner;
