/**
 * Making a to-do from a capture. Duplicates are caught by plain word match: the same words, or all the words of one inside
 * the other, means it is already on the list. A wrong "duplicate" would hide a to-do, so the smaller side needs two words.
 */
import type { CaptureSource, Ctx } from "../../core/types";
import { dueInWords } from "../../core/captureRules";
import { TRUSTED_SOURCES } from "../../core/untrusted";
import { saysUrgent } from "./triage";
import { inferEnergy, inferShallow } from "./rank";

export interface DupeOf {
  id: number;
  title: string;
}

const FILLER = new Set("a an the to my of on for and or in at with it this that some all i need want remember soon again today tomorrow".split(" "));

export function dupeWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !FILLER.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return new Set(words);
}

function wordsContained(a: Set<string>, b: Set<string>): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size < 2) return small.size === 1 && big.size === 1 && [...small][0] === [...big][0];
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

export async function findDuplicateTask(ctx: Ctx, title: string): Promise<DupeOf | null> {
  const open = await ctx.db.all<DupeOf>("SELECT id, title FROM tasks WHERE status IN ('todo','doing') ORDER BY id DESC LIMIT 200");
  const mine = dupeWords(title);
  return open.find((t) => wordsContained(mine, dupeWords(t.title))) ?? null;
}

export interface AddTask {
  /** The words it came from: urgency and dates are read from these. */
  text: string;
  title: string;
  captureId: number;
  source: CaptureSource;
  fields?: Record<string, unknown>;
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function addTask(ctx: Ctx, input: AddTask): Promise<{ id: number; title: string; duplicateOf?: DupeOf }> {
  const title = typeof input.fields?.title === "string" && input.fields.title.trim() ? input.fields.title.trim().slice(0, 160) : input.title;
  const dupe = await findDuplicateTask(ctx, title);
  if (dupe) return { id: dupe.id, title: dupe.title, duplicateOf: dupe };
  const now = ctx.now().toISOString();
  const today = ctx.localDate();
  const trusted = TRUSTED_SOURCES.has(input.source);
  const hinted = input.fields?.today === true ? today : isDate(input.fields?.due) && input.fields.due >= today ? input.fields.due : null;
  const due = trusted ? dueInWords(input.text, today) ?? hinted : null;
  const urgent = trusted && saysUrgent({ title, notes: input.text });
  const minutes = typeof input.fields?.minutes === "number" ? input.fields.minutes : null;
  const notes = input.text.trim() !== title ? input.text.trim() : null;
  const shape = { title, is_shallow: 0, energy: null };
  const id = await ctx.db.insert("tasks", {
    title,
    notes,
    due,
    effort_min: minutes,
    energy: inferEnergy(shape),
    is_shallow: inferShallow(shape) ? 1 : 0,
    urgent: urgent ? 1 : 0,
    urgent_why: urgent ? "you wrote that it can't wait" : null,
    triage_by: urgent ? "guess" : null,
    source_capture_id: input.captureId,
    created_at: now,
    updated_at: now,
  });
  return { id, title };
}
