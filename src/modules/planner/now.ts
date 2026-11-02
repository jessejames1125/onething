/**
 * The Now screen: one card, the single thing to do, with two big buttons. Under it a short list of what comes next, and
 * above it anything from outside the app that waits for a tap. Everything else lives behind the To-dos tab.
 */
import type { Ctx } from "../../core/types";
import { addDays, zonedTimeToUtc } from "../../core/time";
import { pendingConfirmations } from "../../core/confirmations";
import { parseJson } from "../../core/db";
import { RELEASE_KIND } from "../../core/agentTasks";
import { dataBlock, TRUSTED_SOURCES } from "../../core/untrusted";
import { loadAllOpen, loadGoals, loadOpenTasks, pickTop, rankTasks, type RankedTask } from "./rank";
import { waitsOn } from "./waits";

export type ItemAction = "done" | "undo" | "later" | "pick_day" | "stop" | "already" | "not_for_me";

export interface ActionButton {
  id: ItemAction;
  label: string;
  /** The screen asks for a date and posts it with the action. */
  pickDay?: boolean;
  /** The screen asks "Where did you leave off?" and posts the answer as { note }. */
  note?: boolean;
}

export interface NowCard {
  id: number;
  title: string;
  /** The to-do itself, when the title is where it was left off. */
  sub: string | null;
  /** Why this one. */
  reason: string;
  /** The text came from outside the app. */
  outside: boolean;
  primary: ActionButton[];
  more: ActionButton[];
}

export interface NowLine {
  id: number;
  title: string;
  reason: string;
  outside: boolean;
}

export interface HeldItem {
  confirmationId: number;
  todoId: number | null;
  question: string;
}

export interface NowView {
  date: string;
  card: NowCard | null;
  next: NowLine[];
  free: string | null;
  held: HeldItem[];
  /** What Claude said about the last email the owner let it read, for a day. */
  outsideNote: { lines: string[]; note: string | null } | null;
}

const LABEL: Record<ItemAction, string> = {
  done: "Done",
  undo: "Undo",
  later: "Not now",
  pick_day: "Pick a day",
  stop: "Stop here",
  already: "Already done",
  not_for_me: "Not for me",
};
const btn = (...ids: ItemAction[]): ActionButton[] => ids.map((id) => ({ id, label: LABEL[id], ...(id === "pick_day" ? { pickDay: true } : {}), ...(id === "stop" ? { note: true } : {}) }));

/**
 * Pick the to-do for the card. Once it has been put off, the card stops offering "Not now": the choice is to do it or to
 * give it a day, so nothing keeps coming back forever.
 */
function cardFor(t: RankedTask, row: { left_off: string | null; snooze_count: number }): NowCard {
  const primary = row.snooze_count >= 1 ? btn("done", "pick_day") : btn("done", "later");
  const more = row.snooze_count >= 1 ? btn("stop", "already", "not_for_me") : btn("stop", "pick_day", "already", "not_for_me");
  return { id: t.id, title: row.left_off ? `Pick up: ${row.left_off}` : t.title, sub: row.left_off ? t.title : null, reason: t.reason, outside: t.isOutside, primary, more };
}

export interface MorningPins {
  date: string;
  items: Array<{ id: number; why: string }>;
}

export async function loadPins(ctx: Ctx, date: string): Promise<Map<number, string>> {
  const p = await ctx.settings.getJSON<MorningPins | null>("planner.pins", null);
  return new Map(p && p.date === date ? p.items.map((i) => [i.id, i.why] as [number, string]) : []);
}

async function rankedNow(ctx: Ctx): Promise<{ ranked: RankedTask[]; rows: Awaited<ReturnType<typeof loadOpenTasks>> }> {
  const today = ctx.localDate();
  const [rows, goals, pins] = await Promise.all([loadOpenTasks(ctx), loadGoals(ctx), loadPins(ctx, today)]);
  return { ranked: rankTasks(rows, goals, { today, morning: ctx.localTime() < "12:00", pins }), rows };
}

async function heldItems(ctx: Ctx): Promise<HeldItem[]> {
  const pending = await pendingConfirmations(ctx);
  return pending
    .filter((c) => c.kind === RELEASE_KIND)
    .map((c) => {
      const todo = Number(parseJson<Record<string, unknown>>(c.payload, {}).todoId);
      return { confirmationId: c.id, todoId: Number.isInteger(todo) && todo > 0 ? todo : null, question: c.summary };
    });
}

async function lastOutsideNote(ctx: Ctx): Promise<NowView["outsideNote"]> {
  const since = new Date(ctx.now().getTime() - 24 * 3600_000).toISOString();
  const r = await ctx.db.one<{ lines: string | null; note: string | null }>("SELECT lines, note FROM capture_reviews WHERE untrusted = 1 AND status IN ('applied','no_changes') AND updated_at >= ? ORDER BY id DESC LIMIT 1", since);
  return r ? { lines: parseJson<string[]>(r.lines, []), note: r.note } : null;
}

export async function nowView(ctx: Ctx): Promise<NowView> {
  const date = ctx.localDate();
  const { ranked, rows } = await rankedNow(ctx);
  const top = pickTop(ranked, 5);
  const first = top[0] ?? null;
  const card = first ? cardFor(first, rows.find((r) => r.id === first.id)!) : null;
  const next = top.slice(1, 5).map((t) => ({ id: t.id, title: t.title, reason: t.reason, outside: t.isOutside }));
  return { date, card, next, free: card ? null : "Nothing else today", held: await heldItems(ctx), outsideNote: await lastOutsideNote(ctx) };
}

export interface TodoLine {
  id: number;
  title: string;
  reason: string;
  urgent: boolean;
  due: string | null;
  /** Put off, or waiting on another to-do, with the line that says so. */
  asleep: string | null;
  /** The text came from outside the app. */
  outside: boolean;
}

/** Everything open, in rank order, sleeping ones last and saying when they come back. */
export async function todoList(ctx: Ctx): Promise<TodoLine[]> {
  const today = ctx.localDate();
  const [rows, goals, pins, awakeRows] = await Promise.all([loadAllOpen(ctx), loadGoals(ctx), loadPins(ctx, today), loadOpenTasks(ctx)]);
  const awake = new Set(awakeRows.map((r) => r.id));
  const ranked = rankTasks(rows, goals, { today, morning: ctx.localTime() < "12:00", pins });
  const line = (t: RankedTask): TodoLine => {
    const row = rows.find((r) => r.id === t.id)!;
    const asleep = awake.has(t.id) ? null : row.snoozed_until && row.snoozed_until > ctx.now().toISOString() ? `Back ${ctx.localDate(new Date(row.snoozed_until))}` : "Waiting on another to-do";
    return { id: t.id, title: t.title, reason: t.reason, urgent: t.isUrgent, due: t.due, asleep, outside: t.isOutside };
  };
  const lines = ranked.map(line);
  return [...lines.filter((l) => !l.asleep), ...lines.filter((l) => l.asleep)];
}

// ------------------------------------------------------------------ detail

export interface ItemDetail {
  id: number;
  title: string;
  notes: string | null;
  why: string;
  due: string | null;
  status: "open" | "done" | "not_for_me" | "held";
  urgent: boolean;
  urgentBy: string | null;
  goalId: number | null;
  /** "email" when the text came from outside the app. */
  outside: string | null;
  leftOff: string | null;
  waitsOn: Array<{ id: number; title: string }>;
  actions: ActionButton[];
}

interface TaskFull {
  id: number;
  title: string;
  notes: string | null;
  due: string | null;
  status: string;
  goal_id: number | null;
  left_off: string | null;
  urgent: number;
  triage_by: string | null;
  snooze_count: number;
  closed_as: string | null;
  completed_at: string | null;
  source: string | null;
}

const getTask = (ctx: Ctx, id: number) =>
  ctx.db.one<TaskFull>("SELECT t.id, t.title, t.notes, t.due, t.status, t.goal_id, t.left_off, t.urgent, t.triage_by, t.snooze_count, t.closed_as, t.completed_at, c.source AS source FROM tasks t LEFT JOIN captures c ON c.id = t.source_capture_id WHERE t.id = ?", id);

const isOpen = (t: { status: string }) => t.status === "todo" || t.status === "doing";

export async function itemDetail(ctx: Ctx, id: number): Promise<ItemDetail | null> {
  const t = await getTask(ctx, id);
  if (!t) return null;
  const { ranked } = await rankedNow(ctx);
  const open = isOpen(t);
  const outside = t.source && !TRUSTED_SOURCES.has(t.source) ? t.source : null;
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    why: ranked.find((r) => r.id === id)?.reason ?? (outside ? `It came from outside the app (${outside}).` : "You added this."),
    due: t.due,
    status: t.status === "held" ? "held" : open ? "open" : t.closed_as === "not_for_me" ? "not_for_me" : "done",
    urgent: t.urgent === 1,
    urgentBy: t.triage_by,
    goalId: t.goal_id,
    outside,
    leftOff: t.left_off,
    waitsOn: open ? await waitsOn(ctx, id) : [],
    actions: open ? btn("done", "later", "stop", "pick_day", "already", "not_for_me") : t.status === "done" ? btn("undo") : [],
  };
}

// ------------------------------------------------------------------ actions

/** The start of the owner's day, as an instant. */
async function dayStart(ctx: Ctx, date: string): Promise<string> {
  return zonedTimeToUtc(date, await ctx.settings.get("planner.day_start", "08:00"), ctx.tz).toISOString();
}

export async function itemAction(ctx: Ctx, id: number, action: ItemAction, opts: { date?: string | null; note?: string | null } = {}): Promise<{ ok: boolean; message: string }> {
  const t = await getTask(ctx, id);
  if (!t) return { ok: false, message: "That's gone." };
  // A held to-do has one way forward: the tap on its confirmation.
  if (t.status === "held") return { ok: false, message: "This one waits for your OK first." };
  const now = ctx.now().toISOString();
  const today = ctx.localDate();
  if (action === "undo") {
    if (t.status !== "done" && t.closed_as !== "not_for_me") return { ok: true, message: "Nothing to undo." };
    await ctx.db.update("tasks", id, { status: "todo", completed_at: null, closed_as: null, updated_at: now });
    return { ok: true, message: "Back on your list." };
  }
  if (!isOpen(t)) return { ok: true, message: "Already closed." };
  switch (action) {
    case "done":
      await ctx.db.update("tasks", id, { status: "done", completed_at: now, closed_as: "done", snoozed_until: null, left_off: null, updated_at: now });
      return { ok: true, message: "Done." };
    case "later": {
      await ctx.db.update("tasks", id, { snoozed_until: await dayStart(ctx, addDays(today, 1)), snooze_count: t.snooze_count + 1, updated_at: now });
      return { ok: true, message: "Okay, tomorrow." };
    }
    case "pick_day": {
      const date = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) && opts.date > today ? opts.date : addDays(today, 1);
      await ctx.db.update("tasks", id, { due: date, snoozed_until: await dayStart(ctx, date), snooze_count: 0, updated_at: now });
      return { ok: true, message: `Okay, back on ${date}.` };
    }
    case "stop": {
      const note = opts.note?.trim().replace(/\s+/g, " ").slice(0, 140) || null;
      await ctx.db.update("tasks", id, { ...(note ? { left_off: note } : {}), snoozed_until: await dayStart(ctx, addDays(today, 1)), updated_at: now });
      return { ok: true, message: "Saved. Back tomorrow." };
    }
    case "already":
      await ctx.db.update("tasks", id, { status: "done", completed_at: null, closed_as: "already_done", snoozed_until: null, updated_at: now });
      return { ok: true, message: "Got it." };
    case "not_for_me":
      await ctx.db.update("tasks", id, { status: "archived", closed_as: "not_for_me", updated_at: now });
      return { ok: true, message: "Okay, it won't come up again." };
    default:
      return { ok: false, message: "Unknown action." };
  }
}

// ------------------------------------------------------------------ what the API token may read

/** A title with an outside source goes to another AI inside a data block, so it reads as data there too. */
export const titleForTool = (title: string, source: string | null): string => (source && !TRUSTED_SOURCES.has(source) ? dataBlock(title, source) : title);

export async function nowForTool(ctx: Ctx): Promise<Record<string, unknown>> {
  const view = await nowView(ctx);
  const rows = await loadAllOpen(ctx);
  const wrap = (id: number, title: string) => titleForTool(title, rows.find((r) => r.id === id)?.source ?? null);
  return {
    date: view.date,
    now: view.card ? { id: view.card.id, title: wrap(view.card.id, view.card.title), why: view.card.reason } : null,
    next: view.next.map((l) => ({ id: l.id, title: wrap(l.id, l.title), why: l.reason })),
  };
}

export async function tasksForTool(ctx: Ctx): Promise<Array<Record<string, unknown>>> {
  const lines = await todoList(ctx);
  const rows = await loadAllOpen(ctx);
  return lines.map((l) => ({ id: l.id, title: titleForTool(l.title, rows.find((r) => r.id === l.id)?.source ?? null), why: l.reason, due: l.due, urgent: l.urgent, asleep: l.asleep }));
}
