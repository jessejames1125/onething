/**
 * One-tap confirmations. Anything that needs the owner's word (today: letting outside text reach the runner) is stored
 * here, listed in the app with two buttons, and only executed by its registered handler after the tap.
 */
import type { ConfirmationHandler, ConfirmationRequest, ConfirmationRow, Ctx } from "./types";
import { getModules } from "../modules/registry";
import { parseJson } from "./db";

const DEFAULT_EXPIRY_MIN = 7 * 24 * 60;

const extraHandlers = new Map<string, ConfirmationHandler>();
const rejectHandlers = new Map<string, ConfirmationHandler>();

/** Register a handler outside a ModuleDef (core jobs, tests). `onReject` runs when the owner says no. */
export function registerConfirmationHandler(kind: string, handler: ConfirmationHandler, onReject?: ConfirmationHandler): void {
  extraHandlers.set(kind, handler);
  if (onReject) rejectHandlers.set(kind, onReject);
}

export function findConfirmationHandler(kind: string): ConfirmationHandler | null {
  if (extraHandlers.has(kind)) return extraHandlers.get(kind)!;
  for (const m of getModules()) {
    const h = m.confirmationHandlers?.[kind];
    if (h) return h;
  }
  return null;
}

export async function requestConfirmation(ctx: Ctx, req: ConfirmationRequest): Promise<{ id: number; status: ConfirmationRow["status"] }> {
  if (!findConfirmationHandler(req.kind)) throw new Error(`No confirmation handler registered for kind "${req.kind}"`);
  const now = ctx.now();
  const expires = new Date(now.getTime() + (req.expiresInMin ?? DEFAULT_EXPIRY_MIN) * 60000);
  const id = await ctx.db.insert("confirmations", {
    kind: req.kind,
    summary: req.summary,
    payload: req.payload,
    status: "pending",
    expires_at: expires.toISOString(),
    created_at: now.toISOString(),
  });
  return { id, status: "pending" };
}

export async function getConfirmation(ctx: Ctx, id: number): Promise<ConfirmationRow | null> {
  return ctx.db.one<ConfirmationRow>("SELECT * FROM confirmations WHERE id = ?", id);
}

export async function pendingConfirmations(ctx: Ctx): Promise<ConfirmationRow[]> {
  return ctx.db.all<ConfirmationRow>("SELECT * FROM confirmations WHERE status = 'pending' ORDER BY id");
}

export async function decide(ctx: Ctx, id: number, approve: boolean): Promise<{ ok: boolean; message: string }> {
  const row = await getConfirmation(ctx, id);
  if (!row) return { ok: false, message: "Unknown confirmation." };
  if (row.status !== "pending") return { ok: false, message: `Already ${row.status}.` };
  const now = ctx.now();
  if (row.expires_at && Date.parse(row.expires_at) < now.getTime()) {
    await ctx.db.update("confirmations", id, { status: "expired", decided_at: now.toISOString() });
    return { ok: false, message: "That one expired." };
  }
  if (!approve) {
    await ctx.db.update("confirmations", id, { status: "rejected", decided_at: now.toISOString() });
    await rejectHandlers.get(row.kind)?.(ctx, parseJson<Record<string, unknown>>(row.payload, {}), { ...row, status: "rejected" });
    return { ok: true, message: "Dropped. Nothing read it." };
  }
  const handler = findConfirmationHandler(row.kind);
  if (!handler) {
    await ctx.db.update("confirmations", id, { status: "failed", error: "no handler", decided_at: now.toISOString() });
    return { ok: false, message: "No handler for this confirmation." };
  }
  // Mark approved before running so a retry of the tap cannot execute twice.
  await ctx.db.update("confirmations", id, { status: "approved", decided_at: now.toISOString() });
  try {
    const result = await handler(ctx, parseJson<Record<string, unknown>>(row.payload, {}), { ...row, status: "approved" });
    await ctx.db.update("confirmations", id, { result: result === undefined ? null : JSON.stringify(result) });
    return { ok: true, message: "Okay. It's on your list and in line for Claude." };
  } catch (e) {
    await ctx.db.update("confirmations", id, { status: "failed", error: String(e).slice(0, 500) });
    await ctx.alert({ key: `confirmation.failed:${id}`, level: "error", message: `Confirmation #${id} (${row.kind}) failed: ${String(e).slice(0, 200)}` });
    return { ok: false, message: "Approved, but it failed. See System." };
  }
}

/** Core job: expire stale confirmations. */
export async function expireConfirmations(ctx: Ctx): Promise<number> {
  const now = ctx.now().toISOString();
  const res = await ctx.db.run("UPDATE confirmations SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?", now, now);
  return Number(res.meta.changes ?? 0);
}
