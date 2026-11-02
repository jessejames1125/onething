/**
 * Agent tasks: smart work done by Claude in a "runner" process on the owner's own machine, which polls /api/agent/tasks.
 * A module queues a bundle with ctx.agent.request(); the runner claims it and posts a result. If the runner has not
 * reported by due_at, a fallback answers instead (status "fallback") so the day's plan is never late. Two fallbacks in a
 * row raise an alert.
 *
 * Three walls around outside text:
 * 1. A bundle holding a data block (core/untrusted.ts) is "held": the runner cannot list, claim or answer it until the
 *    owner taps.
 * 2. Web kinds run in a separate pass, the only one with web tools, so bundles that hold the owner's own data never share
 *    a session with web access. The server enforces this on list and claim.
 * 3. Results are checked here and when applied (core/captureReview.ts). A result can change only the items its own
 *    capture filed, and only in the owner's or the email's words.
 */
import type { AgentHandler, AgentRequestOptions, AgentResolution, AgentService, AgentTask, AgentTaskStatus, Ctx, ModuleDef, ModuleName } from "./types";
import { getModules } from "../modules/registry";
import { parseJson } from "./db";
import { arr, obj, str, ValidationError } from "./validate";
import { resolveAlert } from "./alerts";
import { DATA_OPEN, hasDataBlock } from "./untrusted";
import { registerConfirmationHandler } from "./confirmations";

export const FALLBACK_FOOTER = "Claude did not report in time, so this is the app's own pick.";
export const FALLBACK_STREAK_ALERT_KEY = "agent.fallback_streak";

export const AGENT_KINDS = ["morning_plan", "research_brief", "capture_review"] as const;

/** Kinds with no fallback: when Claude has not answered by due_at, nothing happens and a late result is refused. */
export const NO_FALLBACK_KINDS = ["capture_review"] as const;
export const hasNoFallback = (kind: string): boolean => (NO_FALLBACK_KINDS as readonly string[]).includes(kind);
const NO_FALLBACK_SQL = NO_FALLBACK_KINDS.map((k) => `'${k}'`).join(",");

/** What a capture_review action may do (tools/runner/RUNNER.md; applied by core/captureReview.ts). */
export const REVIEW_ACTIONS = ["retitle", "set_due", "clear_due", "set_urgent", "set_waits_on", "archive"] as const;

/** Kinds whose instructions use web tools. Only the web pass may see them, and that pass may see nothing else. */
export const WEB_KINDS = ["research_brief"] as const;
export const isWebKind = (kind: string): boolean => (WEB_KINDS as readonly string[]).includes(kind);
const WEB_KIND_SQL = WEB_KINDS.map((k) => `'${k}'`).join(",");

/** Confirmation kind that lets a held task go to the runner. */
export const RELEASE_KIND = "agent.release";

// ------------------------------------------------------------------ result shapes (tools/runner/RUNNER.md documents these)

type Validator = (v: unknown) => Record<string, unknown>;

/** Minimal required shape per named kind: enough to catch an empty or malformed answer. */
export const KIND_VALIDATORS: Record<string, Validator> = {
  morning_plan: (v) => {
    const o = obj(v);
    const top = arr(o.top3, "top3");
    if (top.length < 1 || top.length > 3) throw new ValidationError("top3 must have 1..3 items");
    for (const it of top) str(obj(it, "top3[]").title, "top3[].title");
    return o;
  },
  research_brief: (v) => {
    const o = obj(v);
    str(o.summary, "summary");
    const sources = arr(o.sources, "sources");
    if (sources.length === 0) throw new ValidationError("research_brief needs at least one source URL");
    for (const s of sources) str(typeof s === "object" && s ? (s as Record<string, unknown>).url : s, "sources[].url");
    return o;
  },
  // Shape only: every id, field and date is checked when the actions are applied, and a bad one is dropped there.
  capture_review: (v) => {
    const o = obj(v);
    const actions = arr(o.actions, "actions");
    if (actions.length > 40) throw new ValidationError("actions must have at most 40 items");
    for (const a of actions) {
      const x = obj(a, "actions[]");
      if (!(REVIEW_ACTIONS as readonly string[]).includes(String(x.do))) throw new ValidationError(`actions[].do must be one of ${REVIEW_ACTIONS.join(", ")}`);
      str(x.reason, "actions[].reason");
    }
    return o;
  },
};

/** Validate a runner or fallback result for a kind. Throws ValidationError with a readable message. */
export function validateResult(kind: string, value: unknown): Record<string, unknown> {
  const v = KIND_VALIDATORS[kind];
  return v ? v(value) : obj(value, "result");
}

// ------------------------------------------------------------------ rows

interface RawRow {
  id: number;
  kind: string;
  module: string | null;
  input: string;
  output_schema: string | null;
  status: AgentTaskStatus;
  result: string | null;
  error: string | null;
  due_at: string | null;
  attempts: number;
  created_at: string;
  claimed_at: string | null;
  done_at: string | null;
  handled_at: string | null;
}

function parseRow(r: RawRow): AgentTask {
  return {
    ...r,
    input: parseJson<Record<string, unknown>>(r.input, {}),
    output_schema: r.output_schema ? parseJson<unknown>(r.output_schema, r.output_schema) : null,
    result: r.result ? parseJson<Record<string, unknown> | null>(r.result, null) : null,
  };
}

export async function getTask(ctx: Ctx, id: number): Promise<AgentTask | null> {
  const r = await ctx.db.one<RawRow>("SELECT * FROM agent_tasks WHERE id = ?", id);
  return r ? parseRow(r) : null;
}

export type AgentTaskStatusFilter = AgentTaskStatus | "all";

/** `web`: true = only WEB_KINDS, false = everything else, undefined = both. */
export async function listTasks(ctx: Ctx, status: AgentTaskStatusFilter = "queued", limit = 50, opts: { web?: boolean } = {}): Promise<AgentTask[]> {
  const kinds = opts.web === undefined ? "" : ` AND kind ${opts.web ? "IN" : "NOT IN"} (${WEB_KIND_SQL})`;
  const rows =
    status === "all"
      ? await ctx.db.all<RawRow>(`SELECT * FROM agent_tasks WHERE 1 = 1${kinds} ORDER BY id DESC LIMIT ?`, limit)
      : await ctx.db.all<RawRow>(`SELECT * FROM agent_tasks WHERE status = ?${kinds} ORDER BY due_at IS NULL, due_at, id LIMIT ?`, status, limit);
  return rows.map(parseRow);
}

// ------------------------------------------------------------------ queue side (modules)

function toIso(d: Date | string | undefined, fallback: Date): string {
  if (!d) return fallback.toISOString();
  const t = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(t.getTime())) throw new Error(`agent.request: bad dueAt ${String(d)}`);
  return t.toISOString();
}

export async function requestTask(ctx: Ctx, kind: string, input: Record<string, unknown>, opts: AgentRequestOptions<unknown> = {}): Promise<number> {
  if (!kind || /\s/.test(kind)) throw new Error("agent.request: kind must be a non-empty word");
  obj(input, "input");
  const now = ctx.now();
  const dueAt = toIso(opts.dueAt, new Date(now.getTime() + 24 * 3600_000));
  // Text someone else wrote never reaches the runner on its own: the task waits for the owner's tap.
  const held = hasDataBlock(input) && !opts.tapped;
  const id = await ctx.db.insert("agent_tasks", {
    kind,
    module: opts.module ?? null,
    input,
    output_schema: opts.outputSchema === undefined ? null : typeof opts.outputSchema === "string" ? opts.outputSchema : JSON.stringify(opts.outputSchema),
    status: held ? "held" : "queued",
    due_at: dueAt,
    created_at: now.toISOString(),
  });
  if (held) {
    registerReleaseHandler();
    await ctx.confirm({ kind: RELEASE_KIND, summary: releaseSummary(kind, input), payload: { taskId: id, ...(opts.releasePayload ?? {}) } });
  }
  return id;
}

function firstBlock(v: unknown): string | null {
  if (typeof v === "string") return v.includes(DATA_OPEN) ? v.slice(v.indexOf(DATA_OPEN)) : null;
  if (v && typeof v === "object") for (const x of Object.values(v)) { const b = firstBlock(x); if (b) return b; }
  return null;
}

/** 'Let Claude read this? It came from an email, so it waited for your OK: "..."' */
function releaseSummary(kind: string, input: Record<string, unknown>): string {
  const block = firstBlock(input) ?? "";
  const from = /from=([a-z_-]+)/i.exec(block)?.[1] ?? "outside";
  const whole = block.split("\n").slice(1, -1).join(" ").replace(/\s+/g, " ").trim();
  const text = whole.length > 200 ? `${whole.slice(0, 200).replace(/\s+\S*$/, "")}...` : whole;
  const what = isWebKind(kind) ? "look this up on the web" : "read this";
  return `Let Claude ${what}? It came from ${from === "email" ? "an email" : `outside the app (${from})`}, so it waited for your OK: "${text}"`;
}

/** Called by registerCoreJobs (and lazily above); never at import time, which would race the confirmations import cycle. */
export function registerReleaseHandler(): void {
  registerConfirmationHandler(RELEASE_KIND, releaseHeldTask, dropHeldTask);
}

/** The tap: the held task joins the queue with the same time window it was given, and its to-do joins the list. */
export async function releaseHeldTask(ctx: Ctx, payload: Record<string, unknown>): Promise<unknown> {
  const task = await getTask(ctx, Number(payload.taskId));
  if (!task || task.status !== "held") return { released: false, status: task?.status ?? "missing" };
  const windowMs = Math.max(30 * 60_000, (task.due_at ? Date.parse(task.due_at) : 0) - Date.parse(task.created_at));
  await ctx.db.update("agent_tasks", task.id, { status: "queued", due_at: new Date(ctx.now().getTime() + windowMs).toISOString() });
  const todo = Number(payload.todoId);
  if (Number.isInteger(todo) && todo > 0) await ctx.db.run("UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ? AND status = 'held'", ctx.now().toISOString(), todo);
  return { released: true, taskId: task.id };
}

/** The other button: the task never runs and its to-do never joins the list (kept, archived, for the record). */
export async function dropHeldTask(ctx: Ctx, payload: Record<string, unknown>): Promise<unknown> {
  const now = ctx.now().toISOString();
  await ctx.db.run("UPDATE agent_tasks SET status = 'failed', error = 'not released: the owner said no', done_at = ? WHERE id = ? AND status = 'held'", now, Number(payload.taskId));
  const todo = Number(payload.todoId);
  if (Number.isInteger(todo) && todo > 0) await ctx.db.run("UPDATE tasks SET status = 'archived', closed_as = 'not_released', updated_at = ? WHERE id = ? AND status = 'held'", now, todo);
  return { released: false };
}

/** The generic fallback: the stored bundle and shape hint through the smart tier. */
export async function genericFallback(ctx: Ctx, task: AgentTask): Promise<Record<string, unknown>> {
  const shape = task.output_schema ?? defaultShapeHint(task.kind);
  return ctx.llm.json<Record<string, unknown>>({
    tier: "smart",
    purpose: `agent.fallback.${task.kind}`,
    system: "You help one person plan their day. Work only from the bundle given; never invent facts, numbers or events that are not in it. Answer with JSON only.",
    prompt: `Task kind: ${task.kind}\n\nInput bundle (JSON):\n${JSON.stringify(task.input, null, 2)}\n\nProduce the output JSON for this task.`,
    shape,
    validate: (v) => validateResult(task.kind, v),
    maxTokens: 1500,
  });
}

function defaultShapeHint(kind: string): unknown {
  switch (kind) {
    case "morning_plan":
      return { top3: [{ title: "string", why: "string", task_id: "number|null" }], note: "string" };
    case "research_brief":
      return { summary: "string", findings: [{ claim: "string", source_url: "string" }], sources: ["url"] };
    case "capture_review":
      return { actions: [{ do: "retitle", task_id: 12, title: "string", reason: "string" }], note: "string|null" };
    default:
      return { result: "object" };
  }
}

async function fallbackStreak(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.all<{ status: string }>("SELECT status FROM agent_tasks WHERE status IN ('done','fallback') ORDER BY done_at DESC, id DESC LIMIT 10");
  let n = 0;
  for (const r of rows) {
    if (r.status !== "fallback") break;
    n += 1;
  }
  return n;
}

export async function resolveTask<TResult>(
  ctx: Ctx,
  taskId: number,
  opts: { fallback?: (ctx: Ctx, task: AgentTask) => Promise<TResult>; force?: boolean } = {},
  sameInvocationFallbacks?: Map<number, (ctx: Ctx, task: AgentTask) => Promise<unknown>>,
): Promise<AgentResolution<TResult>> {
  const task = await getTask(ctx, taskId);
  if (!task) throw new Error(`agent.resolve: no task ${taskId}`);
  const base = { taskId, kind: task.kind };
  if (task.status === "done") return { ...base, status: "done", result: task.result as TResult, viaFallback: false, footer: null };
  if (task.status === "fallback") return { ...base, status: "fallback", result: task.result as TResult, viaFallback: true, footer: FALLBACK_FOOTER };
  // Held for the owner's tap: wait for it (sweepTasks fails the task once they say no or let it expire).
  if (task.status === "held" && !opts.force) return { ...base, status: "pending", result: null, viaFallback: false, footer: null };

  const now = ctx.now();
  const due = task.due_at ? Date.parse(task.due_at) : 0;
  if (!opts.force && due > now.getTime()) return { ...base, status: "pending", result: null, viaFallback: false, footer: null };

  const fb = opts.fallback ?? sameInvocationFallbacks?.get(taskId) ?? genericFallback;
  let result: unknown;
  try {
    result = await fb(ctx, task);
    result = validateResult(task.kind, result);
  } catch (e) {
    const err = `fallback failed: ${String(e).slice(0, 500)}`;
    await ctx.db.update("agent_tasks", taskId, { status: "failed", error: [task.error, err].filter(Boolean).join(" | "), done_at: now.toISOString() });
    await ctx.alert({ key: `agent.failed:${taskId}`, level: "error", module: task.module ?? "core", message: `Agent task ${task.kind} #${taskId}: no runner result and the fallback failed (${String(e).slice(0, 120)}).` });
    return { ...base, status: "failed", result: null, viaFallback: true, footer: FALLBACK_FOOTER };
  }
  await ctx.db.update("agent_tasks", taskId, { status: "fallback", result, done_at: now.toISOString() });
  ctx.log(`[agent] ${task.kind} #${taskId} resolved by the fallback (runner status was ${task.status})`);

  const streakLimit = await ctx.settings.getNumber("agent.fallback_alert_streak", 2);
  const streak = await fallbackStreak(ctx);
  if (streak >= streakLimit) {
    await ctx.alert({
      key: FALLBACK_STREAK_ALERT_KEY,
      level: "warn",
      module: "core",
      message: `The runner has not reported for ${streak} tasks in a row, so the app's own pick is standing in. Check that the runner is running.`,
    });
  }
  return { ...base, status: "fallback", result: result as TResult, viaFallback: true, footer: FALLBACK_FOOTER };
}

/** Build the ctx.agent service. */
export function makeAgentService(ctx: Ctx): AgentService {
  const sameInvocation = new Map<number, (ctx: Ctx, task: AgentTask) => Promise<unknown>>();
  return {
    async request(kind, input, opts = {}) {
      const id = await requestTask(ctx, kind, input, opts as AgentRequestOptions<unknown>);
      if (opts.fallback) sameInvocation.set(id, opts.fallback as (ctx: Ctx, task: AgentTask) => Promise<unknown>);
      return id;
    },
    resolve: (taskId, opts) => resolveTask(ctx, taskId, opts, sameInvocation),
    get: (taskId) => getTask(ctx, taskId),
  };
}

// ------------------------------------------------------------------ runner side (POST /api/agent/tasks/...)

/** `web` (the runner pass): a pass claims only its own kinds, so a web-enabled session never reads a private bundle. */
export async function claimTask(ctx: Ctx, id: number, opts: { web?: boolean } = {}): Promise<{ ok: true; task: AgentTask } | { ok: false; status: number; error: string }> {
  if (opts.web !== undefined) {
    const t = await getTask(ctx, id);
    if (!t) return { ok: false, status: 404, error: "no such task" };
    if (isWebKind(t.kind) !== opts.web) return { ok: false, status: 409, error: `a ${opts.web ? "web" : "no-web"} run cannot take ${t.kind} tasks` };
  }
  const now = ctx.now().toISOString();
  const res = await ctx.db.run("UPDATE agent_tasks SET status = 'claimed', claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'", now, id);
  if (Number(res.meta.changes ?? 0) === 0) {
    const t = await getTask(ctx, id);
    if (!t) return { ok: false, status: 404, error: "no such task" };
    return { ok: false, status: 409, error: `task is ${t.status}, not queued` };
  }
  return { ok: true, task: (await getTask(ctx, id))! };
}

export async function completeTask(ctx: Ctx, id: number, rawResult: unknown, modules: ModuleDef[] = getModules()): Promise<{ ok: true; task: AgentTask; handled: boolean } | { ok: false; status: number; error: string }> {
  const task = await getTask(ctx, id);
  if (!task) return { ok: false, status: 404, error: "no such task" };
  if (task.status === "done" || task.status === "fallback") return { ok: false, status: 409, error: `task already resolved (${task.status})` };
  if (task.status === "held") return { ok: false, status: 409, error: "task is waiting for the owner's OK" };
  // No fallback ran, but the moment has passed: what was filed stands.
  if (hasNoFallback(task.kind) && task.due_at && Date.parse(task.due_at) < ctx.now().getTime()) {
    await ctx.db.update("agent_tasks", id, { status: "failed", error: "deadline passed; nothing applied", done_at: ctx.now().toISOString() });
    await ctx.db.run("UPDATE capture_reviews SET status = 'late', updated_at = ? WHERE agent_task_id = ? AND status = 'queued'", ctx.now().toISOString(), id);
    return { ok: false, status: 409, error: "deadline passed; the result was not applied" };
  }
  let result: Record<string, unknown>;
  try {
    result = validateResult(task.kind, rawResult);
  } catch (e) {
    return { ok: false, status: 422, error: `result does not match the ${task.kind} shape: ${String(e instanceof Error ? e.message : e)}` };
  }
  const now = ctx.now().toISOString();
  await ctx.db.update("agent_tasks", id, { status: "done", result, error: null, done_at: now });
  await resolveAlert(ctx, FALLBACK_STREAK_ALERT_KEY);
  const done = (await getTask(ctx, id))!;
  const handled = await dispatchHandler(ctx, done, modules);
  return { ok: true, task: done, handled };
}

export async function failTask(ctx: Ctx, id: number, error: string): Promise<{ ok: true; task: AgentTask } | { ok: false; status: number; error: string }> {
  const task = await getTask(ctx, id);
  if (!task) return { ok: false, status: 404, error: "no such task" };
  if (task.status === "done" || task.status === "fallback") return { ok: false, status: 409, error: `task already resolved (${task.status})` };
  if (task.status === "held") return { ok: false, status: 409, error: "task is waiting for the owner's OK" };
  const maxAttempts = await ctx.settings.getNumber("agent.max_attempts", 3);
  // Retry while attempts remain and the deadline has not passed; otherwise it stays failed and resolve() falls back.
  const due = task.due_at ? Date.parse(task.due_at) : Infinity;
  const retry = task.attempts < maxAttempts && due > ctx.now().getTime();
  await ctx.db.update("agent_tasks", id, { status: retry ? "queued" : "failed", error: error.slice(0, 1000) });
  return { ok: true, task: (await getTask(ctx, id))! };
}

/** Call the owning module's agentHandlers[kind] once per result. Failures alert; they never block the runner's response. */
async function dispatchHandler(ctx: Ctx, task: AgentTask, modules: ModuleDef[]): Promise<boolean> {
  const handler = findHandler(task, modules);
  if (!handler) return false;
  try {
    await handler(ctx, task);
    await ctx.db.update("agent_tasks", task.id, { handled_at: ctx.now().toISOString() });
    return true;
  } catch (e) {
    ctx.log(`[agent] handler for ${task.kind} #${task.id} failed: ${String(e)}`);
    await ctx.alert({ key: `agent.handler_failed:${task.id}`, level: "error", module: task.module ?? "core", message: `Handling the ${task.kind} result #${task.id} failed: ${String(e).slice(0, 200)}` });
    return false;
  }
}

function findHandler(task: AgentTask, modules: ModuleDef[]): AgentHandler | null {
  const own = task.module ? modules.find((m) => m.name === (task.module as ModuleName)) : undefined;
  if (own?.agentHandlers?.[task.kind]) return own.agentHandlers[task.kind];
  for (const m of modules) if (m.agentHandlers?.[task.kind]) return m.agentHandlers[task.kind];
  return null;
}

// ------------------------------------------------------------------ housekeeping (core job, every 15 min)

/**
 * Stale claims go back to the queue (or fail after max attempts); queued tasks a day past due are failed; held tasks the
 * owner turned down, or that waited a week, are failed and their to-dos archived, so nothing keeps waiting on them.
 */
export async function sweepTasks(ctx: Ctx): Promise<{ requeued: number; failed: number; expired: number }> {
  const now = ctx.now();
  const timeoutMin = await ctx.settings.getNumber("agent.claim_timeout_min", 30);
  const maxAttempts = await ctx.settings.getNumber("agent.max_attempts", 3);
  const cutoff = new Date(now.getTime() - timeoutMin * 60_000).toISOString();
  const requeued = await ctx.db.run("UPDATE agent_tasks SET status = 'queued', error = 'claim timed out' WHERE status = 'claimed' AND claimed_at < ? AND attempts < ?", cutoff, maxAttempts);
  const failed = await ctx.db.run("UPDATE agent_tasks SET status = 'failed', error = 'claim timed out after max attempts' WHERE status = 'claimed' AND claimed_at < ? AND attempts >= ?", cutoff, maxAttempts);
  // A kind with no fallback closes at its deadline, not a day later.
  const late = await ctx.db.run(
    `UPDATE agent_tasks SET status = 'failed', error = 'deadline passed; nothing applied', done_at = ? WHERE kind IN (${NO_FALLBACK_SQL}) AND status IN ('queued','claimed') AND due_at IS NOT NULL AND due_at < ?`,
    now.toISOString(),
    now.toISOString(),
  );
  if (Number(late.meta.changes ?? 0) > 0) {
    await ctx.db.run("UPDATE capture_reviews SET status = 'late', updated_at = ? WHERE status = 'queued' AND agent_task_id IN (SELECT id FROM agent_tasks WHERE status = 'failed')", now.toISOString());
  }
  const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const expired = await ctx.db.run("UPDATE agent_tasks SET status = 'failed', error = 'expired: no result a day past due_at', done_at = ? WHERE status = 'queued' AND due_at IS NOT NULL AND due_at < ?", now.toISOString(), dayAgo);
  const notReleased = await ctx.db.run(
    `UPDATE agent_tasks SET status = 'failed', error = 'not released: the owner did not OK the outside text', done_at = ?
     WHERE status = 'held' AND id IN (SELECT CAST(json_extract(payload, '$.taskId') AS INTEGER) FROM confirmations WHERE kind = ? AND status IN ('rejected','expired','failed'))`,
    now.toISOString(),
    RELEASE_KIND,
  );
  // A held task nobody answered for 7 days is dropped.
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const stale = await ctx.db.run("UPDATE agent_tasks SET status = 'failed', error = 'not released within 7 days', done_at = ? WHERE status = 'held' AND created_at < ?", now.toISOString(), weekAgo);
  // Their to-dos go with them: a held to-do whose release is gone would otherwise wait forever.
  await ctx.db.run(
    `UPDATE tasks SET status = 'archived', closed_as = 'not_released', updated_at = ?
     WHERE status = 'held' AND id NOT IN (SELECT CAST(json_extract(payload, '$.todoId') AS INTEGER) FROM confirmations WHERE kind = ? AND status = 'pending' AND json_extract(payload, '$.todoId') IS NOT NULL)`,
    now.toISOString(),
    RELEASE_KIND,
  );
  return {
    requeued: Number(requeued.meta.changes ?? 0),
    failed: Number(failed.meta.changes ?? 0) + Number(notReleased.meta.changes ?? 0),
    expired: Number(expired.meta.changes ?? 0) + Number(stale.meta.changes ?? 0) + Number(late.meta.changes ?? 0),
  };
}

/** Summary for the System screen. */
export async function agentOverview(ctx: Ctx): Promise<Record<string, unknown>> {
  const counts = await ctx.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM agent_tasks GROUP BY status");
  const last = await ctx.db.one<{ done_at: string | null; kind: string; status: string }>("SELECT done_at, kind, status FROM agent_tasks WHERE status = 'done' ORDER BY done_at DESC LIMIT 1");
  const recent = await listTasks(ctx, "all", 20);
  return {
    runnerConfigured: !!ctx.env.RUNNER_TOKEN,
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    lastRunnerResult: last ?? null,
    fallbackStreak: await fallbackStreak(ctx),
    recent: recent.map((t) => ({ id: t.id, kind: t.kind, module: t.module, status: t.status, due_at: t.due_at, created_at: t.created_at, done_at: t.done_at, attempts: t.attempts, error: t.error, note: t.result && typeof t.result.note === "string" ? t.result.note : null })),
  };
}
