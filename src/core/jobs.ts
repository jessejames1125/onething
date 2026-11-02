/**
 * Job dispatcher, run from the 5-minute cron. For every job it computes the current slot (local "HH:MM" today for `at`
 * jobs; the interval grid for `every` jobs), runs it once per slot (UNIQUE(job, scheduled_for) is the lock), records a
 * heartbeat in job_runs, and alerts on missed or failed runs.
 */
import type { Ctx, Env, JobDef, ModuleDef } from "./types";
import { getModules } from "../modules/registry";
import { dayOfWeek, floorToMinutes, minutesBetween, parseInterval, zonedTimeToUtc } from "./time";
import { makeCtx } from "./ctx";
import { hmacHex, safeEqual } from "./crypto";

export interface JobEntry {
  id: string; // "<module>.<name>"
  module: string;
  def: JobDef;
}

const coreJobs: JobEntry[] = [];

/** Core-owned jobs register here; modules use ModuleDef.jobs. */
export function registerCoreJob(def: JobDef): void {
  coreJobs.push({ id: `core.${def.name}`, module: "core", def });
}

export function allJobs(modules: ModuleDef[] = getModules()): JobEntry[] {
  const out: JobEntry[] = [...coreJobs];
  for (const m of modules) for (const j of m.jobs ?? []) out.push({ id: `${m.name}.${j.name}`, module: m.name, def: j });
  return out;
}

export interface SlotInfo {
  scheduledFor: Date;
  kind: "at" | "every";
}

/** The slot this job is currently in (or null when no slot is due today or today is not one of its days). */
export async function currentSlot(ctx: Ctx, def: JobDef, now: Date): Promise<SlotInfo | null> {
  const s = def.schedule;
  if (s.every) {
    const mins = parseInterval(s.every);
    return { scheduledFor: floorToMinutes(now, mins), kind: "every" };
  }
  let at = s.at;
  if (s.atSetting) at = (await ctx.settings.get(s.atSetting)) ?? at;
  if (!at) return null;
  const today = ctx.localDate(now);
  const slot = zonedTimeToUtc(today, at, ctx.tz);
  if (slot.getTime() > now.getTime()) return null; // not yet today
  if (s.days && s.days.length > 0 && !s.days.includes(dayOfWeek(slot, ctx.tz))) return null;
  return { scheduledFor: slot, kind: "at" };
}

export interface TickResult {
  ran: string[];
  skipped: string[];
  missed: string[];
  failed: string[];
  /** Jobs handed to their own invocation (fan-out); their outcome lands in job_runs, not here. */
  dispatched: string[];
}

export const tickPhase = (job: JobEntry): 0 | 1 => job.def.phase ?? 0;

/** Tick order: phase 0, then phase 1; registration order within each phase. */
export function tickOrder(jobs: JobEntry[]): JobEntry[] {
  return [0, 1].flatMap((p) => jobs.filter((j) => tickPhase(j) === p));
}

/**
 * Runs one claimed job and records the outcome on its job_runs row (the heartbeat), alerting on failure. Shared by the
 * in-process path and the fan-out endpoint, so both record exactly the same thing.
 */
export async function executeJob(ctx: Ctx, job: JobEntry, scheduledFor: string): Promise<{ ok: boolean; error?: string }> {
  const t0 = Date.now();
  try {
    await job.def.run(ctx);
    await ctx.db.run("UPDATE job_runs SET status = 'ok', finished_at = ?, ms = ? WHERE job = ? AND scheduled_for = ?", new Date().toISOString(), Date.now() - t0, job.id, scheduledFor);
    return { ok: true };
  } catch (e) {
    const err = String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 1000);
    await ctx.db.run("UPDATE job_runs SET status = 'failed', finished_at = ?, ms = ?, error = ? WHERE job = ? AND scheduled_for = ?", new Date().toISOString(), Date.now() - t0, err, job.id, scheduledFor);
    ctx.log(`[jobs] ${job.id} failed: ${err}`);
    await ctx.alert({ key: `job.failed:${job.id}:${scheduledFor}`, level: "error", module: job.module, message: `Job failed: ${job.id}: ${String(e).slice(0, 200)}` });
    return { ok: false, error: String(e) };
  }
}

// ------------------------------------------------------------------ fan-out (one invocation per job)

/** Path of the internal endpoint that runs one claimed job in its own invocation. */
export const INTERNAL_JOB_PATH = "/api/internal/jobs";
export const JOB_SIGNATURE_HEADER = "X-Job-Signature";

/** HMAC of (job, slot) under SESSION_SECRET: only this Worker can ask itself to run a claimed slot. */
export async function jobSignature(secret: string, jobId: string, scheduledFor: string): Promise<string> {
  return hmacHex(secret, `job-dispatch:${jobId}:${scheduledFor}`);
}

/**
 * Sends one claimed job to its own invocation. Each invocation gets its own subrequest and CPU budget on the Workers
 * free plan, so one busy tick cannot starve the rest. Resolves when that invocation has finished the job.
 */
export type JobDispatcher = (job: JobEntry, scheduledFor: string) => Promise<void>;

/**
 * The dispatcher for this env, or null to run in-process. Fan-out needs the SELF service binding (a Worker fetching its
 * own workers.dev URL does not route back to itself) and SESSION_SECRET. Setting jobs.fan_out = "0" switches it off.
 */
export async function selfDispatcher(ctx: Ctx): Promise<JobDispatcher | null> {
  const self = ctx.env.SELF;
  const secret = ctx.env.SESSION_SECRET;
  if (!self || !secret) return null;
  if ((await ctx.settings.get("jobs.fan_out", "1")) === "0") return null;
  return async (job, scheduledFor) => {
    const res = await self.fetch(
      new Request(`https://onething.internal${INTERNAL_JOB_PATH}/${encodeURIComponent(job.id)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", [JOB_SIGNATURE_HEADER]: await jobSignature(secret, job.id, scheduledFor) },
        body: JSON.stringify({ scheduledFor }),
      }),
    );
    if (!res.ok) throw new Error(`dispatch returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

/**
 * Handler body for POST /api/internal/jobs/:id/run. Runs the job only for a slot the dispatcher claimed and that has not
 * finished, so a replay cannot run it twice after it completed.
 */
export async function runDispatchedJob(ctx: Ctx, jobId: string, scheduledFor: string, signature: string, modules: ModuleDef[] = getModules()): Promise<{ status: 200 | 401 | 404 | 409 | 503; body: Record<string, unknown> }> {
  const secret = ctx.env.SESSION_SECRET;
  if (!secret) return { status: 503, body: { error: "SESSION_SECRET not set" } };
  if (!scheduledFor || !signature || !safeEqual(signature, await jobSignature(secret, jobId, scheduledFor))) return { status: 401, body: { error: "unauthorized" } };
  const job = allJobs(modules).find((j) => j.id === jobId);
  if (!job) return { status: 404, body: { error: `unknown job ${jobId}` } };
  const row = await ctx.db.one<{ status: string; finished_at: string | null }>("SELECT status, finished_at FROM job_runs WHERE job = ? AND scheduled_for = ?", job.id, scheduledFor);
  if (!row || row.status !== "running" || row.finished_at) return { status: 409, body: { error: "slot not claimed or already finished", status_now: row?.status ?? null } };
  const out = await executeJob(ctx, job, scheduledFor);
  return { status: 200, body: { ok: out.ok, job: job.id, scheduledFor, error: out.error } };
}

/** A dispatch that never reached the job (binding error, crash, non-2xx): fail the still-running slot and alert. */
async function dispatchFailed(ctx: Ctx, job: JobEntry, scheduledFor: string, e: unknown): Promise<void> {
  const err = `dispatch failed: ${String(e instanceof Error ? e.message : e)}`.slice(0, 1000);
  const upd = await ctx.db.run("UPDATE job_runs SET status = 'failed', finished_at = ?, error = ? WHERE job = ? AND scheduled_for = ? AND status = 'running'", new Date().toISOString(), err, job.id, scheduledFor);
  ctx.log(`[jobs] ${job.id} ${err}`);
  if (Number(upd.meta.changes ?? 0) > 0) await ctx.alert({ key: `job.failed:${job.id}:${scheduledFor}`, level: "error", module: job.module, message: `Job failed: ${job.id}: ${err.slice(0, 200)}` });
}

// ------------------------------------------------------------------ the tick

export interface RunDueOptions {
  /** Fan-out dispatcher; null or undefined = run every job in this invocation (tests, no SELF binding). */
  dispatch?: JobDispatcher | null;
}

/**
 * One cron tick. Idempotent: repeated ticks within a slot do nothing. With a dispatcher, every claimed job runs in its
 * own invocation, one wave per phase, under ctx.waitUntil, and the result lists them as `dispatched`; without one, jobs
 * run here one after another.
 */
export async function runDue(ctx: Ctx, modules: ModuleDef[] = getModules(), opts: RunDueOptions = {}): Promise<TickResult> {
  const result: TickResult = { ran: [], skipped: [], missed: [], failed: [], dispatched: [] };
  const now = ctx.now();
  const defaultGrace = await ctx.settings.getNumber("jobs.missed_grace_min", 20);
  const dispatch = opts.dispatch ?? null;
  const claimed: Array<{ job: JobEntry; scheduledFor: string }> = [];

  for (const job of tickOrder(allJobs(modules))) {
    let slot: SlotInfo | null;
    try {
      slot = await currentSlot(ctx, job.def, now);
    } catch (e) {
      ctx.log(`[jobs] bad schedule for ${job.id}: ${String(e)}`);
      continue;
    }
    if (!slot) continue;
    const scheduledFor = slot.scheduledFor.toISOString();
    const existing = await ctx.db.one<{ status: string }>("SELECT status FROM job_runs WHERE job = ? AND scheduled_for = ?", job.id, scheduledFor);
    if (existing) {
      result.skipped.push(job.id);
      continue;
    }
    const late = minutesBetween(slot.scheduledFor, now);
    const grace = job.def.graceMin ?? defaultGrace;
    if (slot.kind === "at" && late > grace) {
      // Too late to run it now; record the miss so it is not retried, and alert once.
      const ins = await ctx.db.run(
        "INSERT OR IGNORE INTO job_runs (job, scheduled_for, started_at, finished_at, status, error) VALUES (?, ?, ?, ?, 'missed', ?)",
        job.id,
        scheduledFor,
        now.toISOString(),
        now.toISOString(),
        `missed by ${Math.round(late)} min`,
      );
      if (Number(ins.meta.changes ?? 0) > 0) {
        result.missed.push(job.id);
        await ctx.alert({ key: `job.missed:${job.id}:${scheduledFor}`, level: "warn", module: job.module, message: `Missed run: ${job.id} scheduled ${ctx.localTime(slot.scheduledFor)} (${Math.round(late)} min ago).` });
      }
      continue;
    }
    // Claim the slot. If another tick claimed it first, the INSERT is ignored and we skip.
    const claim = await ctx.db.run("INSERT OR IGNORE INTO job_runs (job, scheduled_for, started_at, status) VALUES (?, ?, ?, 'running')", job.id, scheduledFor, now.toISOString());
    if (Number(claim.meta.changes ?? 0) === 0) {
      result.skipped.push(job.id);
      continue;
    }
    if (dispatch) {
      claimed.push({ job, scheduledFor });
      result.dispatched.push(job.id);
      continue;
    }
    const out = await executeJob(ctx, job, scheduledFor);
    (out.ok ? result.ran : result.failed).push(job.id);
  }

  if (dispatch && claimed.length) {
    const send = (c: { job: JobEntry; scheduledFor: string }) => dispatch(c.job, c.scheduledFor).catch((e) => dispatchFailed(ctx, c.job, c.scheduledFor, e));
    ctx.waitUntil(
      (async () => {
        // One wave per phase: each wave's jobs run side by side, and the next wave waits for the previous one.
        for (const phase of [0, 1]) await Promise.all(claimed.filter((c) => tickPhase(c.job) === phase).map(send));
      })(),
    );
  }
  return result;
}

/** Last heartbeat of any job (for /api/health-check). */
export async function lastHeartbeat(ctx: Ctx): Promise<{ job: string; started_at: string; status: string } | null> {
  return ctx.db.one("SELECT job, started_at, status FROM job_runs ORDER BY started_at DESC LIMIT 1");
}

/** Run a job by id right now, outside its schedule (System screen, tests). Records a heartbeat with scheduled_for = now. */
export async function runJobNow(ctx: Ctx, jobId: string, modules: ModuleDef[] = getModules()): Promise<{ ok: boolean; error?: string }> {
  const job = allJobs(modules).find((j) => j.id === jobId);
  if (!job) return { ok: false, error: `unknown job ${jobId}` };
  const scheduledFor = ctx.now().toISOString();
  await ctx.db.run("INSERT OR IGNORE INTO job_runs (job, scheduled_for, started_at, status) VALUES (?, ?, ?, 'running')", job.id, scheduledFor, scheduledFor);
  return executeJob(ctx, job, scheduledFor);
}

/** Entry point for the `scheduled` handler. Builds a ctx and runs one tick; also pings the watchdog if one is set. */
export async function scheduledTick(env: Env, exec: ExecutionContext, now?: Date, opts: RunDueOptions = {}): Promise<TickResult> {
  const ctx = await makeCtx(env, { exec, now: now ? () => now : undefined });
  // opts.dispatch: undefined = decide from env (SELF binding); null = in-process (tests); a function = that dispatcher.
  const dispatch = opts.dispatch === undefined ? await selfDispatcher(ctx) : opts.dispatch;
  const res = await runDue(ctx, getModules(), { dispatch });
  if (env.HEALTHCHECK_URL) {
    exec.waitUntil(fetch(env.HEALTHCHECK_URL, { method: "GET" }).catch((e) => ctx.log("healthcheck ping failed", e)));
  }
  return res;
}
