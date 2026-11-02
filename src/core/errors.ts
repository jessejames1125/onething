/**
 * What an error may say to a client. A ValidationError, or a plain Error whose message reads like a sentence, is shown
 * as is. Anything else (database errors, TypeErrors, messages carrying SQL, URLs or stack frames) is logged with a short
 * reference id and the client gets only "Something went wrong" plus that id, which matches the line in the Worker log.
 */
import { randomId } from "./crypto";
import { ValidationError } from "./validate";

export const GENERIC_ERROR = "Something went wrong";

// D1 and SQLite text, SQL fragments, URLs, file paths and stack frames never leave the Worker.
const INTERNAL = /D1_|SQLITE|\bSQL\b|no such (table|column)|constraint failed|syntax error|https?:\/\/|\bat \S+ \(|\.[cm]?[jt]s:\d+|\n\s+at /i;

export interface PublicError {
  error: string;
  /** Present when the real error was hidden: the id in the log line. */
  id?: string;
}

/** Log `e` under a fresh id and return the generic message. */
export function hiddenError(e: unknown, where = "error"): PublicError {
  const id = randomId(6);
  console.error(`[${where} ${id}]`, e);
  return { error: GENERIC_ERROR, id };
}

export function publicMessage(e: unknown, where?: string): PublicError {
  if (e instanceof ValidationError) return { error: e.message };
  if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype && e.message && e.message.length <= 200 && !INTERNAL.test(e.message)) return { error: e.message };
  return hiddenError(e, where);
}
