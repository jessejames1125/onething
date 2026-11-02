/**
 * The runner's second look at what was just filed. Filing is done by a small model or by word rules, in a moment; this
 * pass lets Claude fix what it got wrong. It may change only the to-dos its own capture filed, only when nobody has
 * changed them since, and only in the words the capture already holds. Every change is listed and can be undone.
 *
 * A review of outside text (an email) can do one thing: retitle its own to-do, always labelled "Email:". It cannot set a
 * date, urgency or order, so an email can never put itself at the top of the list.
 */
import type { Ctx } from "./types";
import { addDays } from "./time";
import { arr, obj, optStr, ValidationError } from "./validate";
import { parseJson } from "./db";
import { keepsOwnWords } from "./brainDump";
import { dataBlock } from "./untrusted";
import { hasWaitLoop } from "../modules/planner/waits";

const REVIEW_WINDOW_MIN = 30;
const HOLD_WINDOW_MS = 7 * 24 * 3600_000;

export const OUTSIDE_ACTIONS: ReadonlySet<string> = new Set(["retitle"]);

interface SnapshotItem {
  id: number;
  title: string;
  due: string | null;
  urgent: number;
  status: string;
  updated_at: string;
}

interface Step {
  task_id: number;
  before: Record<string, unknown>;
  /** Waits link added: Undo removes it. */
  waits_on?: number;
  /** The row's updated_at after this review, so Undo can tell the owner has changed it since. */
  after: string;
}

export interface ReviewRow {
  id: number;
  agent_task_id: number;
  capture_ids: string;
  snapshot: string;
  untrusted: number;
  status: "queued" | "applied" | "no_changes" | "late" | "failed" | "undone";
  lines: string | null;
  steps: string | null;
  dropped: string | null;
  note: string | null;
  created_at: string;
  updated_at: string | null;
}

async function filedBy(ctx: Ctx, captureIds: number[]): Promise<SnapshotItem[]> {
  const marks = captureIds.map(() => "?").join(",");
  return ctx.db.all<SnapshotItem>(`SELECT id, title, due, urgent, status, updated_at FROM tasks WHERE source_capture_id IN (${marks})`, ...captureIds);
}

/** Queue a review of the owner's own captures. No runner set up, nothing queued. */
export async function queueReview(ctx: Ctx, captureIds: number[]): Promise<number | null> {
  if (!ctx.env.RUNNER_TOKEN || !captureIds.length) return null;
  const items = await filedBy(ctx, captureIds);
  if (!items.length) return null;
  const marks = captureIds.map(() => "?").join(",");
  const captures = await ctx.db.all<{ id: number; raw_text: string | null }>(`SELECT id, raw_text FROM captures WHERE id IN (${marks})`, ...captureIds);
  const now = ctx.now();
  const agentTaskId = await ctx.agent.request(
    "capture_review",
    { today: ctx.localDate(), captures: captures.map((c) => ({ id: c.id, text: c.raw_text })), items },
    { module: "capture", dueAt: new Date(now.getTime() + REVIEW_WINDOW_MIN * 60_000) },
  );
  await ctx.db.insert("capture_reviews", { agent_task_id: agentTaskId, capture_ids: captureIds, snapshot: items, untrusted: 0, status: "queued", created_at: now.toISOString() });
  return agentTaskId;
}

/** The bundle for one held email. Everything from the email sits inside a data block, its code-made title too. */
export async function queueEmailReview(ctx: Ctx, captureId: number, raw: string, todoId: number, title: string): Promise<number> {
  const now = ctx.now();
  const agentTaskId = await ctx.agent.request(
    "capture_review",
    { today: ctx.localDate(), captures: [{ id: captureId, text: dataBlock(raw, "email") }], items: [{ id: todoId, title: dataBlock(title, "email") }] },
    { module: "capture", dueAt: new Date(now.getTime() + HOLD_WINDOW_MS), releasePayload: { todoId } },
  );
  const row = await ctx.db.one<SnapshotItem>("SELECT id, title, due, urgent, status, updated_at FROM tasks WHERE id = ?", todoId);
  await ctx.db.insert("capture_reviews", { agent_task_id: agentTaskId, capture_ids: [captureId], snapshot: [row], untrusted: 1, status: "queued", created_at: now.toISOString() });
  return agentTaskId;
}

const realDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

interface Applied {
  lines: string[];
  steps: Step[];
  dropped: string[];
}

/** Applies what passes the checks; a bad action is dropped and listed, it never stops the good ones. */
export async function applyReview(ctx: Ctx, review: ReviewRow, result: Record<string, unknown>): Promise<Applied> {
  const out: Applied = { lines: [], steps: [], dropped: [] };
  const snapshot = parseJson<SnapshotItem[]>(review.snapshot, []);
  const ids = new Set(snapshot.map((s) => s.id));
  const captureIds = parseJson<number[]>(review.capture_ids, []);
  const marks = captureIds.map(() => "?").join(",");
  const texts = await ctx.db.all<{ raw_text: string | null }>(`SELECT raw_text FROM captures WHERE id IN (${marks})`, ...captureIds);
  const words = texts.map((t) => t.raw_text ?? "").join("\n");
  const today = ctx.localDate();
  const untrusted = review.untrusted === 1;
  const drop = (why: string) => out.dropped.push(why);

  for (const raw of arr(result.actions, "actions")) {
    const a = obj(raw, "actions[]");
    const what = String(a.do);
    const id = Number(a.task_id);
    if (untrusted && !OUTSIDE_ACTIONS.has(what)) {
      drop(`${what}: a review of outside text can only retitle`);
      continue;
    }
    if (!ids.has(id)) {
      drop(`${what} #${a.task_id}: not filed by this capture`);
      continue;
    }
    const before = snapshot.find((s) => s.id === id)!;
    const current = await ctx.db.one<SnapshotItem>("SELECT id, title, due, urgent, status, updated_at FROM tasks WHERE id = ?", id);
    if (!current) {
      drop(`${what} #${id}: gone`);
      continue;
    }
    // After a tap the held to-do has moved to the list: that move is not the owner changing it.
    if (current.title !== before.title || current.due !== before.due || current.urgent !== before.urgent || (current.status !== before.status && before.status !== "held")) {
      drop(`${what} #${id}: changed since it was filed`);
      continue;
    }
    const now = ctx.now().toISOString();
    const reason = (optStr(a.reason) ?? "").slice(0, 120);
    const apply = async (fields: Record<string, unknown>, line: string, extra: Partial<Step> = {}) => {
      const prior = Object.fromEntries(Object.keys(fields).map((k) => [k, (current as unknown as Record<string, unknown>)[k] ?? null]));
      await ctx.db.update("tasks", id, { ...fields, updated_at: now });
      out.steps.push({ task_id: id, before: prior, after: now, ...extra });
      out.lines.push(reason ? `${line}: ${reason}` : line);
    };
    if (what === "retitle") {
      const title = (optStr(a.title) ?? "").replace(/\s+/g, " ").trim();
      if (!title || title.length > 160) {
        drop(`retitle #${id}: empty or too long`);
      } else if (!keepsOwnWords(title, words)) {
        drop(`retitle #${id}: adds words the capture does not hold`);
      } else {
        const final = untrusted && !/^email:/i.test(title) ? `Email: ${title}` : title;
        await apply({ title: final }, `Renamed to "${final}"`);
      }
    } else if (what === "set_due") {
      const due = String(a.due ?? "");
      if (!realDate(due) || due < today || due > addDays(today, 730)) drop(`set_due #${id}: bad date ${due.slice(0, 20)}`);
      else await apply({ due }, `Due ${due}`);
    } else if (what === "clear_due") {
      await apply({ due: null }, "Date removed");
    } else if (what === "set_urgent") {
      const urgent = a.urgent === false ? 0 : 1;
      await apply({ urgent, urgent_why: urgent ? reason.slice(0, 120) || null : null, triage_by: "ai" }, urgent ? "Marked urgent" : "Not urgent");
    } else if (what === "set_waits_on") {
      const on = Number(a.waits_on);
      if (!ids.has(on) || on === id) {
        drop(`set_waits_on #${id}: ${a.waits_on} was not filed by this capture`);
      } else if (await hasWaitLoop(ctx, id, on)) {
        drop(`set_waits_on #${id}: would make a loop`);
      } else {
        await ctx.db.run("INSERT OR IGNORE INTO task_waits (task_id, waits_on) VALUES (?, ?)", id, on);
        await apply({}, `Waits on #${on}`, { waits_on: on });
      }
    } else if (what === "archive") {
      await apply({ status: "archived", closed_as: "review" }, `Set aside "${current.title}"`);
    } else {
      drop(`${what}: unknown action`);
    }
  }
  return out;
}

/** agentHandlers.capture_review: the runner has posted a checked-shape result. */
export async function onReviewResult(ctx: Ctx, taskId: number, result: Record<string, unknown>): Promise<void> {
  const review = await ctx.db.one<ReviewRow>("SELECT * FROM capture_reviews WHERE agent_task_id = ?", taskId);
  if (!review) throw new ValidationError(`no review for task ${taskId}`);
  if (review.status !== "queued") return;
  const applied = await applyReview(ctx, review, result);
  await ctx.db.update("capture_reviews", review.id, {
    status: applied.steps.length ? "applied" : "no_changes",
    lines: applied.lines,
    steps: applied.steps,
    dropped: applied.dropped,
    note: optStr(result.note)?.slice(0, 400) ?? null,
    updated_at: ctx.now().toISOString(),
  });
}

/** The newest reviews that did something, or said something, for "What Claude changed". */
export async function listReviews(ctx: Ctx, limit = 20): Promise<Array<{ id: number; status: string; lines: string[]; dropped: string[]; note: string | null; untrusted: boolean; at: string }>> {
  const rows = await ctx.db.all<ReviewRow>("SELECT * FROM capture_reviews WHERE status IN ('applied','no_changes','undone') ORDER BY id DESC LIMIT ?", limit);
  return rows.map((r) => ({ id: r.id, status: r.status, lines: parseJson<string[]>(r.lines, []), dropped: parseJson<string[]>(r.dropped, []), note: r.note, untrusted: r.untrusted === 1, at: r.updated_at ?? r.created_at }));
}

/** Put back what a review changed. A to-do the owner has changed since stays as they left it. */
export async function undoReview(ctx: Ctx, id: number): Promise<{ ok: boolean; message: string }> {
  const review = await ctx.db.one<ReviewRow>("SELECT * FROM capture_reviews WHERE id = ?", id);
  if (!review) return { ok: false, message: "No such change." };
  if (review.status !== "applied") return { ok: false, message: review.status === "undone" ? "Already undone." : "Nothing to undo." };
  const steps = parseJson<Step[]>(review.steps, []);
  const now = ctx.now().toISOString();
  let kept = 0;
  for (const s of [...steps].reverse()) {
    const row = await ctx.db.one<{ updated_at: string }>("SELECT updated_at FROM tasks WHERE id = ?", s.task_id);
    if (!row || row.updated_at !== s.after) {
      kept += 1;
      continue;
    }
    if (s.waits_on != null) await ctx.db.run("DELETE FROM task_waits WHERE task_id = ? AND waits_on = ?", s.task_id, s.waits_on);
    await ctx.db.update("tasks", s.task_id, { ...s.before, updated_at: now });
  }
  await ctx.db.update("capture_reviews", id, { status: "undone", updated_at: now });
  return { ok: true, message: kept ? `Undone, except ${kept} you changed since.` : "Undone." };
}
