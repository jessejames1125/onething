/**
 * Brain dump. One capture that holds several things is split into separate items here; captureBus files each one.
 *
 * The cheap model splits (purpose capture.split). When it fails, a plain split on lines, commas, ";", "and", "also",
 * "then" and the "wanna / want to / need to / gotta" lead-ins takes over, but only when the text clearly is a list (two
 * or more lead-ins, or list lines), so a meal like "eggs, toast, coffee" is never turned into three to-dos.
 */
import type { Ctx } from "./types";
import { arr, bool, obj, optNum, str } from "./validate";

export interface DumpItem {
  /** The item in the owner's words. */
  text: string;
  /** 1-4 words for the receipt ("laundry"). */
  short: string;
  /** They said today (or the whole dump is about today). */
  today: boolean;
  /** Rough minutes, when the model could tell. */
  minutes: number | null;
  /** Too fuzzy to schedule as written. */
  vague: boolean;
}

const LEAD_RE = /\b(?:wanna|want to|need to|gotta|got to|have to|should|i'?d like to|going to|gonna)\b/gi;
const LIST_LINE_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * "strong": surely a list (split even without the model). "weak": maybe a list (ask the model). null: one thing.
 * One paragraph of sentences is one thing (an idea, a plan, a note), however many commas it has. Commas alone only count
 * in a short line with no sentence break, like "coffee, toast, eggs".
 */
export function dumpSignal(text: string): "strong" | "weak" | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const leads = (text.match(LEAD_RE) ?? []).length;
  const listLines = lines.filter((l) => LIST_LINE_RE.test(l)).length;
  if (leads >= 2 || listLines >= 2) return "strong";
  if (lines.length >= 2) return "weak";
  const commas = (text.match(/[,;]/g) ?? []).length;
  const prose = /[.?!]\s+\S/.test(text.trim()) || text.length > 160;
  return commas >= 2 && !prose ? "weak" : null;
}

const FILLER_WORDS = new Set("a an the of to on in at for with and or but my our your some this that it its is are be do get i we me so etc".split(" "));
const wordsOf = (t: string) => t.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/**
 * An item the model returned is still in the source's words: at most one of its words is missing from the source (a word
 * counts when its first five letters start one of the source's, so "automate" matches "automated"), and filler words do
 * not count. A model that adds "Implement ... rule" around an idea has written a to-do nobody asked for.
 */
export function keepsOwnWords(item: string, source: string): boolean {
  const theirs = wordsOf(source);
  const own = wordsOf(item).filter((w) => !FILLER_WORDS.has(w));
  const fresh = own.filter((w) => !theirs.some((h) => h.startsWith(w.slice(0, 5))));
  return fresh.length <= 1 && fresh.length * 2 <= own.length;
}

const FILLER_RE = /^(?:(?:ok|okay|and|also|then|plus|oh|etc\.?)[,\s]+)*(?:(?:today|tonight|tomorrow)\s+)?(?:i\s+)?(?:(?:really\s+)?(?:wanna|want to|need to|gotta|got to|have to|should|'?d like to|would like to|am going to|going to|gonna)\s+)?(?:get\s+(?=\w+\s+done))?/i;

function clean(part: string): string {
  return part
    .replace(LIST_LINE_RE, "")
    .replace(FILLER_RE, "")
    .replace(/\b(?:a bit|some|etc\.?|lol)\s*$/i, "")
    .replace(/[.!\s]+$/, "")
    .trim();
}

function shortOf(text: string): string {
  const words = text
    .replace(/\b(?:do|get|some|a|an|the|bit|this|my|with|all|through)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return (words.slice(0, 3).join(" ") || text.slice(0, 20)).toLowerCase();
}

/** The fallback split. Exported for tests. */
export function heuristicSplit(text: string): DumpItem[] {
  const allToday = /\btoday\b/i.test(text);
  const parts = text
    .split(/\r?\n|[;,]|\s+(?:and also|and then|also|then|and)\s+(?=(?:i\s+)?(?:wanna|want to|need to|gotta|got to|have to|should|do|clean|get|call|book|buy|figure|finish|write|send|pay|fix|go)\b)/i)
    .flatMap((p) => p.split(/\s+(?=(?:i\s+)?(?:wanna|want to|need to|gotta)\b)/i))
    .map(clean)
    .filter((p) => p.length >= 3 && !/^(?:etc|and|also|then|today|tonight|tomorrow|i)$/i.test(p));
  return parts.map((p) => ({ text: p, short: shortOf(p), today: allToday || /\btoday\b/i.test(p), minutes: null, vague: false }));
}

const SPLIT_SYSTEM = `The owner of a to-do app sometimes sends a brain dump: several things to do, in one message. Split it into separate items.
Rules:
- One item per separate thing to do. Keep their words in "text" (drop filler like "wanna", "i want to", "etc").
- "short": 1-3 lowercase words naming it ("laundry", "clean", "taxes").
- "today": true if they say today/tonight for that item or for the whole message.
- "minutes": your rough estimate of how long it takes (laundry 45, clean a bit 30, a big planning job 90-120).
- "vague": true only if it is too fuzzy to schedule at all (no action you could put on a calendar).
- If the message is really one thing (one meal, one feeling, one note, one task), return exactly one item.
- An idea, a plan, or a description of how something would work is ONE item, even with several sentences and commas.
- Never add words they did not write (no "implement", "create", "set up" in front of their words).`;

/** Split with the cheap model. Throws when the model fails (the caller falls back). */
export async function splitWithModel(ctx: Ctx, text: string): Promise<DumpItem[]> {
  const res = await ctx.llm.json<{ items: DumpItem[] }>({
    tier: "cheap",
    purpose: "capture.split",
    system: SPLIT_SYSTEM,
    prompt: `Today is ${ctx.localDate()}.\nMessage:\n"""${text.slice(0, 2000)}"""`,
    shape: { items: [{ text: "do some laundry", short: "laundry", today: true, minutes: 45, vague: false }] },
    maxTokens: 600,
    validate: (v) => {
      const items = arr(obj(v).items, "items").slice(0, 12).map((x) => {
        const o = obj(x);
        const t = str(o.text, "text").trim();
        const minutes = optNum(o.minutes);
        return {
          text: t,
          short: (typeof o.short === "string" && o.short.trim() ? o.short.trim() : shortOf(t)).slice(0, 30),
          today: bool(o.today),
          minutes: minutes != null && minutes > 0 && minutes <= 600 ? Math.round(minutes) : null,
          vague: bool(o.vague),
        };
      });
      if (!items.length) throw new Error("no items");
      return { items };
    },
  });
  return res.items;
}

/** Items when the text is a dump of two or more things, else null (file it as one capture). */
export async function splitDump(ctx: Ctx, text: string): Promise<DumpItem[] | null> {
  const signal = dumpSignal(text);
  if (!signal) return null;
  let items: DumpItem[] | null = null;
  try {
    items = await splitWithModel(ctx, text);
    // A split that rewords the owner is not a split of their message: it is filed as one capture instead.
    if (items.some((i) => !keepsOwnWords(i.text, text))) {
      ctx.log("[dump] the model's split reworded the message; filed as one");
      return null;
    }
  } catch (e) {
    ctx.log(`[dump] model split failed: ${String(e).slice(0, 160)}`);
    items = signal === "strong" ? heuristicSplit(text) : null;
  }
  return items && items.length >= 2 ? items : null;
}
