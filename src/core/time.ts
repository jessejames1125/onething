/**
 * Timezone-aware date math on top of Intl (no deps). All "local" values are in the given IANA tz.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(d: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(d)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" in tz. */
export function localDate(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:MM" in tz. */
export function localTime(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** 0 = Sunday ... 6 = Saturday, in tz. */
export function dayOfWeek(d: Date, tz: string): number {
  return localParts(d, tz).weekday;
}

/** Offset of tz from UTC at instant `d`, in minutes (e.g. -420 for PDT). */
export function tzOffsetMinutes(d: Date, tz: string): number {
  const p = localParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}

/**
 * The UTC instant of a local wall time: zonedTimeToUtc("2026-10-07", "07:00", "America/Los_Angeles").
 * Handles DST by iterating the offset once (the standard two-pass trick).
 */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date {
  const [y, m, dd] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, dd, hh, mm, 0);
  let offset = tzOffsetMinutes(new Date(guess), tz);
  let result = guess - offset * 60000;
  const offset2 = tzOffsetMinutes(new Date(result), tz);
  if (offset2 !== offset) {
    offset = offset2;
    result = guess - offset * 60000;
  }
  return new Date(result);
}

/** Add days to a "YYYY-MM-DD" string (calendar arithmetic, tz-free). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` ("YYYY-MM-DD" each); positive when b is later. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** Monday of the week containing `date` (for weekly metrics). */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const back = (wd + 6) % 7;
  return addDays(date, -back);
}

/** True when `dueDate` ("YYYY-MM-DD" or ISO) is today or earlier in tz. */
export function isDue(due: string | null | undefined, now: Date, tz: string): boolean {
  if (!due) return false;
  if (due.length === 10) return due <= localDate(now, tz);
  const t = Date.parse(due);
  return Number.isFinite(t) && t <= now.getTime();
}

/** Parse "15m" | "2h" | "1d" into minutes. */
export function parseInterval(s: string): number {
  const m = /^(\d+)\s*(m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`Bad interval: ${s}`);
  const n = Number(m[1]);
  return m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 1440;
}

/** Floor an instant to a multiple of `minutes` (UTC grid). */
export function floorToMinutes(d: Date, minutes: number): Date {
  const ms = minutes * 60000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

/** Minutes between two instants (b - a). */
export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60000;
}

/** Human "3 min ago" / "2 h ago". */
export function ago(from: Date | string | null | undefined, now: Date = new Date()): string {
  if (!from) return "never";
  const t = typeof from === "string" ? Date.parse(from) : from.getTime();
  const min = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
