/**
 * Text someone other than the owner wrote (an email's subject and body) travels to the runner only inside a delimited
 * data block, and tools/runner/RUNNER.md tells the runner that whatever sits inside one is data, never instructions. A
 * bundle that carries a block is held until the owner taps (core/agentTasks.ts).
 */
import type { CaptureSource, Ctx } from "./types";

export const DATA_OPEN = "<<<UNTRUSTED_DATA";
export const DATA_CLOSE = "<<<END_UNTRUSTED_DATA>>>";

/** Capture sources whose text the owner typed: the app and their own API token. */
export const TRUSTED_SOURCES: ReadonlySet<string> = new Set(["web", "token"]);

/** Sources whose to-do waits for a tap before it is even on the list. No model reads this text before the tap. */
export const HELD_SOURCES: ReadonlySet<CaptureSource> = new Set(["email"]);

/** Wrap one untrusted string. Its angle brackets become look-alikes so it cannot close the block early. */
export function dataBlock(text: string | null | undefined, from: string): string {
  // Every angle bracket becomes a look-alike in one pass, so no marker can be rebuilt from pieces. Stripping "<<<" once
  // lets "<<>>><" turn into "<<<"; stripping until nothing changed is quadratic on hostile input.
  const clean = String(text ?? "").replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›"));
  return `${DATA_OPEN} from=${from.replace(/[^a-z_-]/gi, "")}>>>\n${clean}\n${DATA_CLOSE}`;
}

/** True when any string anywhere in the value carries a data block. */
export function hasDataBlock(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(DATA_OPEN);
}

/** Where a to-do's text came from: null when the owner typed it (or code made it), else the capture source ("email"). */
export async function untrustedTaskSource(ctx: Ctx, taskId: number | null): Promise<string | null> {
  if (taskId == null) return null;
  const row = await ctx.db.one<{ source: string | null }>("SELECT c.source FROM tasks t LEFT JOIN captures c ON c.id = t.source_capture_id WHERE t.id = ?", taskId);
  if (!row?.source || TRUSTED_SOURCES.has(row.source)) return null;
  return row.source;
}
