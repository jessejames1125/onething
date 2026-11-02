/**
 * Follow the day / light / dark, per device. A manual choice is data-theme on <html>, which theme.css lets override
 * everything else. "auto" leaves data-theme off and sets data-day from the clock (daylight.ts: dark at dusk and at night).
 * data-sky (the phase) is always set: the sky on Now follows the clock whatever the theme.
 */
import { dayNow, isDark } from "./daylight";

export type ThemeChoice = "auto" | "light" | "dark";

export const THEME_KEY = "onething.theme";
export const THEME_CHOICES: ThemeChoice[] = ["auto", "light", "dark"];
export const THEME_LABEL: Record<ThemeChoice, string> = { auto: "Follow the day", light: "Light", dark: "Dark" };

const listeners = new Set<(t: ThemeChoice) => void>();

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

function apply(t: ThemeChoice) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const day = dayNow();
  root.dataset.sky = day.phase;
  const dayMode = isDark(day.phase) ? "dark" : "light";
  if (t === "auto") {
    delete root.dataset.theme;
    root.dataset.day = dayMode;
  } else {
    root.dataset.theme = t;
    delete root.dataset.day;
  }
  const shown = t === "auto" ? dayMode : t;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const media = m.dataset.media ?? m.getAttribute("media") ?? "";
    m.dataset.media = media;
    m.setAttribute("media", media.includes(shown) ? "all" : "not all");
  });
}

export function setTheme(t: ThemeChoice) {
  apply(t);
  try {
    if (t === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    /* private mode: the theme still applies for this visit */
  }
  listeners.forEach((fn) => fn(t));
}

export function refreshDay() {
  apply(getTheme());
}

let ticking = false;
export function applySavedTheme() {
  refreshDay();
  if (ticking || typeof document === "undefined") return;
  ticking = true;
  setInterval(refreshDay, 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshDay());
}

export function onThemeChange(fn: (t: ThemeChoice) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
