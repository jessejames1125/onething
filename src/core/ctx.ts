import type { Ctx, Env } from "./types";
import { makeDb } from "./db";
import { makeSettings } from "./settings";
import { makeLlm } from "./llm";
import { localDate, localTime } from "./time";
import { raiseAlert } from "./alerts";
import { requestConfirmation } from "./confirmations";
import { makeAgentService } from "./agentTasks";
import { demoLlm } from "./demo";

export interface MakeCtxOptions {
  /** ExecutionContext from fetch, scheduled or email; optional in tests. */
  exec?: { waitUntil(p: Promise<unknown>): void } | null;
  /** Fix the time (tests, the job dispatcher passing the slot time). */
  now?: () => Date;
  /** Override the timezone (otherwise settings.timezone, then env.TIMEZONE). */
  tz?: string;
  log?: (...args: unknown[]) => void;
  /** Remember repeated SELECTs for this ctx's life (db.ts). GET requests only (src/index.ts). */
  memoReads?: boolean;
  /** This request is in demo mode (core/demo.ts): canned model, fixed clock. */
  demo?: boolean;
}

/** Build a Ctx. One per request or job tick; cheap. */
export async function makeCtx(env: Env, opts: MakeCtxOptions = {}): Promise<Ctx> {
  const db = makeDb(env.DB, { memoReads: opts.memoReads });
  const settings = makeSettings(db);
  const log = opts.log ?? ((...a: unknown[]) => console.log(...a));
  const tz = opts.tz ?? (await settings.get("timezone", env.TIMEZONE || "UTC"));
  const fixed = opts.demo && env.DEMO_NOW ? new Date(env.DEMO_NOW) : null;
  const now = opts.now ?? (() => (fixed ? new Date(fixed) : new Date()));
  const pending: Promise<unknown>[] = [];

  const ctx: Ctx = {
    env,
    db,
    settings,
    llm: opts.demo ? demoLlm() : makeLlm(env, db, settings),
    tz,
    userName: (env.USER_NAME ?? "").trim() || "there",
    now,
    localDate: (d) => localDate(d ?? now(), tz),
    localTime: (d) => localTime(d ?? now(), tz),
    confirm: (req) => requestConfirmation(ctx, req),
    alert: (input) => raiseAlert(ctx, input),
    agent: null as unknown as Ctx["agent"], // filled below (needs ctx)
    waitUntil: (p) => {
      if (opts.exec) opts.exec.waitUntil(p.catch((e) => log("waitUntil error", e)));
      else pending.push(p.catch((e) => log("waitUntil error", e)));
    },
    log,
  };
  ctx.agent = makeAgentService(ctx);
  // Tests without an ExecutionContext can await everything that was deferred.
  (ctx as Ctx & { __pending: Promise<unknown>[] }).__pending = pending;
  return ctx;
}

/** Await deferred work (tests). */
export async function flushCtx(ctx: Ctx): Promise<void> {
  const pending = (ctx as Ctx & { __pending?: Promise<unknown>[] }).__pending ?? [];
  while (pending.length) await Promise.all(pending.splice(0));
}
