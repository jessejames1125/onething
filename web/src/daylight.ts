/**
 * Daylight: the top of Now takes the colour of the sky at this hour of your day, a sun rides one arc from wake-up to
 * bedtime, and in "Follow the day" mode light and dark follow the same clock. Pure helpers here (tested in
 * test/web/daylight.test.ts), plus a small per-device cache of the day's bounds so the theme is right before /api/me answers.
 *
 *   phase:  "night" before wake-up and from the wind-down on, then "morning", "day", "dusk" across the waking day.
 *   dark:   dusk and night. Light: morning and day.
 *
 * web/public/theme-init.js repeats phaseAt before first paint; keep the two in step.
 */
export type SkyPhase = "morning" | "day" | "dusk" | "night";

/** Minutes after midnight, local. */
export interface DayBounds {
  wake: number;
  bed: number;
}

export const DEFAULT_BOUNDS: DayBounds = { wake: 6 * 60 + 30, bed: 22 * 60 + 30 };
export const WIND_DOWN_MIN = 60;
/** Where morning ends and dusk starts, as a share of the waking day. */
export const MORNING_END = 0.3;
export const DUSK_START = 0.72;

export const DAY_KEY = "onething.day";

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** How far through the waking day `min` is: 0 at wake-up, 1 at bedtime, clamped. */
export function dayProgress(min: number, b: DayBounds): number {
  return clamp((min - b.wake) / (b.bed - b.wake), 0, 1);
}

export function phaseAt(min: number, b: DayBounds): SkyPhase {
  if (min < b.wake || min >= b.bed - WIND_DOWN_MIN) return "night";
  const f = dayProgress(min, b);
  return f < MORNING_END ? "morning" : f < DUSK_START ? "day" : "dusk";
}

export const isDark = (p: SkyPhase) => p === "dusk" || p === "night";

/** The arc, in the 358 x 50 box Sky.tsx draws in: a quadratic curve, so x moves evenly with time. */
export const ARC = { x0: 4, y0: 46, cx: 179, cy: -22, x1: 354, y1: 46, w: 358, h: 50 } as const;

/** The sun's point at progress t, and the control point of the part already behind it (for the solid trail). */
export function arcAt(t: number): { x: number; y: number; qx: number; qy: number } {
  const { x0, y0, cx, cy, x1, y1 } = ARC;
  const qx = x0 + (cx - x0) * t;
  const qy = y0 + (cy - y0) * t;
  const rx = cx + (x1 - cx) * t;
  const ry = cy + (y1 - cy) * t;
  return { x: qx + (rx - qx) * t, y: qy + (ry - qy) * t, qx, qy };
}

/** Minutes after midnight -> "6:30 AM". */
export function clock12(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = String(min % 60).padStart(2, "0");
  return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? "AM" : "PM"}`;
}

export const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

const okBounds = (b: unknown): b is DayBounds => !!b && typeof (b as DayBounds).wake === "number" && typeof (b as DayBounds).bed === "number" && (b as DayBounds).bed > (b as DayBounds).wake;

export function readBounds(): DayBounds {
  try {
    const v = JSON.parse(localStorage.getItem(DAY_KEY) ?? "null") as unknown;
    return okBounds(v) ? v : DEFAULT_BOUNDS;
  } catch {
    return DEFAULT_BOUNDS;
  }
}

export function writeBounds(b: DayBounds) {
  try {
    localStorage.setItem(DAY_KEY, JSON.stringify(b));
  } catch {
    /* private mode: the defaults hold */
  }
}

// The clock the screen shows: the server's time in the owner's timezone, so the demo's fixed clock reads the same anywhere.
let offsetMs = 0;
let zone: string | null = null;

export function setAppClock(serverNow: string, tz: string) {
  offsetMs = Date.parse(serverNow) - Date.now();
  zone = tz;
}

/** A Date whose local fields read as the owner's wall clock. */
export function appNow(real: Date = new Date(Date.now() + offsetMs)): Date {
  if (!zone) return real;
  try {
    return new Date(real.toLocaleString("en-US", { timeZone: zone }));
  } catch {
    return real;
  }
}

/** Everything the screen needs for one moment. */
export interface DayNow {
  at: Date;
  min: number;
  bounds: DayBounds;
  phase: SkyPhase;
  t: number;
}

export function dayNow(at: Date = appNow(), bounds: DayBounds = readBounds()): DayNow {
  const min = minutesOf(at);
  return { at, min, bounds, phase: phaseAt(min, bounds), t: dayProgress(min, bounds) };
}
