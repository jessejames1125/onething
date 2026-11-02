/**
 * What counts as urgent. Urgent goes first, so it has to be real: the owner set it, or it is flagged and their own words
 * or a date within two days back it up. At most two at a time. Text from outside the app never makes itself urgent.
 */
import { daysBetween } from "../../core/time";

export const URGENT_MAX = 2;
const URGENT_WORDS_RE = /\b(?:urgent|urgently|asap|right away|immediately)\b/i;

export interface UrgentFacts {
  title: string;
  notes?: string | null;
  due?: string | null;
  kind?: string | null;
  urgent?: number | boolean | null;
  triage_by?: string | null;
  /** The text came from outside the app. */
  outside?: boolean;
}

export const saysUrgent = (t: Pick<UrgentFacts, "title" | "notes">): boolean => URGENT_WORDS_RE.test(`${t.title} ${t.notes ?? ""}`);

/** Due within 2 days of today (local dates), or overdue. */
export const dueWithin2 = (due: string | null | undefined, today: string): boolean => !!due && daysBetween(today, due.slice(0, 10)) <= 2;

/** Whether a to-do may show as urgent today (before the cap). */
export function urgentReal(t: UrgentFacts, today: string): boolean {
  if ((t.kind ?? "todo") !== "todo") return false;
  const flagged = t.urgent === 1 || t.urgent === true;
  if (t.triage_by === "you") return flagged;
  if (t.outside) return false;
  return flagged && (saysUrgent(t) || dueWithin2(t.due, today));
}

/** The cap: the ones the owner set or wrote urgent first, then soonest due, then oldest. Returns the ids that stay. */
export function capUrgent<T extends { id: number; due?: string | null; mine: boolean }>(urgent: T[]): Set<number> {
  const order = [...urgent].sort((a, b) => Number(b.mine) - Number(a.mine) || (a.due ?? "9999").slice(0, 10).localeCompare((b.due ?? "9999").slice(0, 10)) || a.id - b.id);
  return new Set(order.slice(0, URGENT_MAX).map((t) => t.id));
}
