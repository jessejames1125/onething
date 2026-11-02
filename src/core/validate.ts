/**
 * Tiny validators for llm.json(). Each throws on a bad value, so a failed parse triggers a retry.
 * Example:
 *   validate: (v) => { const o = obj(v); return { kind: oneOf(o.kind, KINDS), confidence: num(o.confidence, 0, 1) }; }
 */

export class ValidationError extends Error {}

export function obj(v: unknown, label = "value"): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ValidationError(`${label} must be an object`);
  return v as Record<string, unknown>;
}

export function arr(v: unknown, label = "value"): unknown[] {
  if (!Array.isArray(v)) throw new ValidationError(`${label} must be an array`);
  return v;
}

export function str(v: unknown, label = "value"): string {
  if (typeof v !== "string") throw new ValidationError(`${label} must be a string`);
  return v;
}

export function optStr(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string") return String(v);
  return v;
}

export function num(v: unknown, min = -Infinity, max = Infinity, label = "value"): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ValidationError(`${label} must be a number`);
  if (n < min || n > max) throw new ValidationError(`${label} out of range ${min}..${max}`);
  return n;
}

export function optNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function bool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1) return true;
  if (v === "false" || v === 0) return false;
  return fallback;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], label = "value"): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new ValidationError(`${label} must be one of ${allowed.join("|")}`);
  return v as T;
}

/** "YYYY-MM-DD" or null. */
export function optDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : null;
}
