/**
 * Cheap rules around the model's filing, so a small model's mistakes do not reach the list:
 * - an obvious to-do is a task, whatever the model says (the model still supplies title and due when it agrees);
 * - "question" needs an actual question: a question mark, a question word first, "I wonder", or "look into / research".
 */
import { addDays } from "./time";

/** "look into", "research", "find out": the explicit asks that make something a question to research. */
const RESEARCH_RE = /\b(?:look(?:ing)? into|research|look(?:ing)? up|find out|read up on|dig into)\b/i;
/** A question word first ("how do tides work", "is it worth..."). */
const QUESTION_START_RE = /^(?:who|what|when|where|why|how|which|whose|is|are|was|were|can|could|should|would|will|does|do|did|am)\b/i;
const WONDER_RE = /\b(?:i wonder|wondering|curious (?:about|whether|if|why|how)|whether)\b/i;
/** To-do phrasing anywhere in the text. */
const TODO_RE = /\b(?:needs? to|have to|has to|got to|gotta|remember to|don'?t forget|remind me to|finish|sign(?:ing)? up|at some point|to-?do)\b/i;
/** A leading imperative verb. Verbs that read as a log or an idea when they open a note are left to the model. */
const IMPERATIVE_RE =
  /^(?:please\s+)?(?:book|buy|call|email|e-mail|text|send|pay|fix|finish|draft|write|schedule|reschedule|pick up|drop off|clean|sign up|renew|cancel|order|submit|file|reply to|follow up|return|print|mail|register|apply for|ask|tell|remind|bring|get|prepare|confirm|refill|wash|pack|wrap up|set up|install|update)\b/i;

/** The text holds an actual question (or an explicit "look into / research"), so "question" is allowed. */
export function questionAllowed(text: string): boolean {
  const t = text.trim();
  return t.includes("?") || QUESTION_START_RE.test(t) || WONDER_RE.test(t) || RESEARCH_RE.test(t);
}

/**
 * The rule layer before the model: "task" when the text is an obvious to-do and holds no question, else null (the model
 * decides). A question mark, a question word first or "look into / research" always leaves it to the model.
 */
export function ruleKind(text: string): "task" | null {
  const t = text.trim();
  if (!t || questionAllowed(t)) return null;
  return TODO_RE.test(t) || IMPERATIVE_RE.test(t) ? "task" : null;
}

const LEADS: RegExp[] = [
  /^(?:ok(?:ay)?|so|oh|hey|also|and|btw)[,\s]+/i,
  /^(?:i\s+)?(?:really\s+)?(?:need(?:s)? to|have to|has to|got to|gotta|should|want to|wanna)\s+/i,
  /^(?:remember|don'?t forget|remind me)(?:\s+to)?\s+/i,
  /^(?:at some point|sometime|soon)[,\s]+/i,
  /^to\s+/i,
  /^(?:to-?do|task)\s*[:\-]\s*/i,
];

/**
 * A to-do's title in the owner's words, without the "I need to remember at some point soon to" around it:
 * "i need to remember at some point soon to renew my library card" -> "Renew my library card".
 */
export function todoTitle(text: string): string {
  let t = text.split(/\n/)[0].trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of LEADS) {
      const next = t.replace(re, "");
      if (next !== t) {
        t = next;
        changed = true;
      }
    }
  }
  t = t
    .replace(/\s+(?:at some point|soon|sometime)(?=[\s,.!]*$)/i, "")
    .replace(/[.!,\s]+$/, "")
    .trim();
  if (!t) t = text.trim();
  t = t.length > 120 ? `${t.slice(0, 119)}…` : t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * A due date from plain words, read by code so it works with no model: "soon" is three days out, "today", "tomorrow", and
 * a weekday name means the next one ("friday", "before friday").
 */
export function dueInWords(text: string, today: string): string | null {
  if (/\btoday\b|\btonight\b/i.test(text)) return today;
  if (/\btomorrow\b/i.test(text)) return addDays(today, 1);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}(?:'s)?\\b`, "i").test(text)) return addDays(today, ((i - dow + 7) % 7) || 7);
  }
  return /\bsoon\b/i.test(text) ? addDays(today, 3) : null;
}
