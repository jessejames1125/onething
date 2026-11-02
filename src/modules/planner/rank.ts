/**
 * The ranking rule behind the one card. Pins (Claude's morning picks) first, then urgent, then due today or overdue, then
 * a score from goal weight, date pressure, how much it unblocks and energy fit. Each to-do carries one plain line saying
 * why it is where it is, so the card can always answer "why this?".
 */
import type { Ctx } from "../../core/types";
import { daysBetween } from "../../core/time";
import { TRUSTED_SOURCES } from "../../core/untrusted";
import { waitingIds } from "./waits";
import { capUrgent, saysUrgent, urgentReal } from "./triage";

export type Energy = "low" | "med" | "high";

export interface TaskRow {
  id: number;
  goal_id: number | null;
  title: string;
  notes: string | null;
  due: string | null;
  status: string;
  effort_min: number | null;
  energy: Energy | null;
  is_shallow: number;
  kind: string | null;
  remind_on: string | null;
  urgent: number | null;
  urgent_why: string | null;
  triage_by: string | null;
  snoozed_until: string | null;
  snooze_count: number;
  left_off: string | null;
  /** Capture source; null when code made it. */
  source: string | null;
  /** Open to-dos waiting on this one. */
  blocks?: number;
}

export interface GoalRow {
  id: number;
  title: string;
  weight: number;
  status: string;
}

export interface RankedTask {
  id: number;
  title: string;
  goalId: number | null;
  goalTitle: string | null;
  due: string | null;
  energy: Energy;
  effortMin: number;
  isShallow: boolean;
  isUrgent: boolean;
  isOutside: boolean;
  score: number;
  /** The line under the title. */
  reason: string;
  dueNow: boolean;
}

export interface RankContext {
  today: string;
  /** Before noon: hard work fits. */
  morning: boolean;
  /** Claude's morning picks for today: id to its own reason. */
  pins?: Map<number, string>;
}

const HIGH_RE = /\b(build|write|draft|design|code|ship|implement|prototype|research|plan|pitch|deck|slides|spec|refactor|debug|launch|finish)\b/i;
const LOW_RE = /\b(email|reply|book|call|pay|schedule|buy|renew|cancel|order|text|file|submit|sign|print|return|pick up|clean|laundry|errand|send)\b/i;

/** Fill the fields capture may have left empty, with word rules (no model call). */
export function inferEnergy(t: Pick<TaskRow, "energy" | "title" | "is_shallow">): Energy {
  if (t.energy) return t.energy;
  if (t.is_shallow) return "low";
  if (HIGH_RE.test(t.title)) return "high";
  if (LOW_RE.test(t.title)) return "low";
  return "med";
}

export function inferShallow(t: Pick<TaskRow, "is_shallow" | "title" | "energy">): boolean {
  if (t.is_shallow) return true;
  if (t.energy === "high") return false;
  return LOW_RE.test(t.title) && !HIGH_RE.test(t.title);
}

export function deadlinePressure(due: string | null, today: string): number {
  if (!due) return 0;
  const d = daysBetween(today, due.slice(0, 10));
  if (!Number.isFinite(d)) return 0;
  if (d < 0) return 1.2;
  if (d === 0) return 1;
  return 1 / (1 + d);
}

const fmtDay = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

function reasonFor(t: { pin?: string; isUrgent: boolean; urgentWhy: string | null; due: string | null; dl: number; goal: string | null; blocks: number }, today: string): string {
  if (t.pin) return `Claude's pick: ${t.pin}`;
  if (t.isUrgent) return t.urgentWhy ? `Urgent: ${t.urgentWhy.replace(/\.$/, "")}` : "Urgent";
  if (t.due && t.dl >= 1.2) return `Overdue, was due ${fmtDay(t.due)}`;
  if (t.due && t.dl >= 1) return "Due today";
  if (t.due && daysBetween(today, t.due.slice(0, 10)) === 1) return "Due tomorrow";
  if (t.blocks > 0) return t.blocks === 1 ? "One other to-do waits on this" : `${t.blocks} other to-dos wait on this`;
  if (t.due && t.dl >= 0.2) return `Due ${fmtDay(t.due)}`;
  if (t.goal) return `Moves "${t.goal}" forward`;
  return "Next on your list";
}

export function rankTasks(tasks: TaskRow[], goals: GoalRow[], rc: RankContext): RankedTask[] {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const out: Array<RankedTask & { mine: boolean; tier: number; urgentWhy: string | null; dl: number; blocks: number }> = [];
  for (const t of tasks) {
    if (t.status !== "todo" && t.status !== "doing") continue;
    if (t.kind === "ongoing" || (t.kind === "reminder" && !!t.remind_on && t.remind_on.slice(0, 10) > rc.today)) continue;
    const due = t.due ?? (t.kind === "reminder" ? t.remind_on : null);
    const outside = t.source != null && !TRUSTED_SOURCES.has(t.source);
    const energy = inferEnergy(t);
    const shallow = inferShallow(t);
    const goal = t.goal_id != null ? byId.get(t.goal_id) : undefined;
    const gw = goal ? goal.weight : 0.5;
    const dl = deadlinePressure(due, rc.today);
    const blocks = t.blocks ?? 0;
    const fit = energy === "high" ? (rc.morning ? 1 : 0.5) : energy === "low" ? 0.7 : 0.8;
    const isUrgent = urgentReal({ ...t, due, outside }, rc.today);
    const mine = t.triage_by === "you" || (!outside && saysUrgent(t));
    const urgentWhy = !isUrgent ? null : t.urgent_why ?? (mine ? "you said so" : null);
    out.push({
      id: t.id,
      title: t.title,
      goalId: t.goal_id,
      goalTitle: goal?.title ?? null,
      due,
      energy,
      effortMin: t.effort_min ?? (shallow ? 15 : 60),
      isShallow: shallow,
      isUrgent,
      isOutside: outside,
      score: Math.round((gw + 1.5 * dl + 0.5 * (Math.min(5, blocks) / 5) + 0.5 * fit) * 1000) / 1000,
      reason: "",
      dueNow: dl >= 1,
      mine,
      tier: 0,
      urgentWhy,
      dl,
      blocks,
    });
  }
  const keep = capUrgent(out.filter((r) => r.isUrgent).map((r) => ({ id: r.id, due: r.due, mine: r.mine })));
  for (const r of out) {
    if (r.isUrgent && !keep.has(r.id)) {
      r.isUrgent = false;
      r.urgentWhy = null;
    }
    const pin = rc.pins?.get(r.id);
    r.tier = pin !== undefined ? 6 : r.isUrgent ? 5 + (r.mine ? 0.75 : 0) + (r.dueNow ? 0.5 : 0) : r.dueNow ? 3 : 0;
    r.reason = reasonFor({ pin, isUrgent: r.isUrgent, urgentWhy: r.urgentWhy, due: r.due, dl: r.dl, goal: r.goalTitle, blocks: r.blocks }, rc.today);
  }
  out.sort((a, b) => b.tier - a.tier || b.score - a.score || a.id - b.id);
  return out;
}

/** Top N, with at most one quick errand unless it is urgent or due now, so the list is not all small stuff. */
export function pickTop(ranked: RankedTask[], n: number): RankedTask[] {
  const out: RankedTask[] = [];
  let shallow = 0;
  for (const t of ranked) {
    if (out.length >= n) break;
    if (t.isShallow && !t.isUrgent && !t.dueNow) {
      if (shallow >= 1) continue;
      shallow += 1;
    }
    out.push(t);
  }
  return out;
}

// ------------------------------------------------------------------ data loading

const OPEN_SQL = `SELECT t.id, t.goal_id, t.title, t.notes, t.due, t.status, t.effort_min, t.energy, t.is_shallow, t.kind, t.remind_on, t.urgent, t.urgent_why,
  t.triage_by, t.snoozed_until, t.snooze_count, t.left_off, c.source AS source,
  (SELECT COUNT(*) FROM task_waits w JOIN tasks x ON x.id = w.task_id WHERE w.waits_on = t.id AND x.status IN ('todo','doing')) AS blocks
  FROM tasks t LEFT JOIN captures c ON c.id = t.source_capture_id WHERE t.status IN ('todo','doing') ORDER BY t.id LIMIT 500`;

/** Everything open, snoozed or not. Held rows are not open: they are not on the list until the tap. */
export async function loadAllOpen(ctx: Ctx): Promise<TaskRow[]> {
  return ctx.db.all<TaskRow>(OPEN_SQL);
}

/** What may be picked right now: awake, and not waiting on another open to-do. */
export async function loadOpenTasks(ctx: Ctx): Promise<TaskRow[]> {
  const rows = await loadAllOpen(ctx);
  const waiting = await waitingIds(ctx);
  const now = ctx.now().toISOString();
  return rows.filter((t) => !waiting.has(t.id) && (!t.snoozed_until || t.snoozed_until <= now));
}

export async function loadGoals(ctx: Ctx): Promise<GoalRow[]> {
  return ctx.db.all<GoalRow>("SELECT id, title, weight, status FROM goals WHERE status = 'active'");
}
