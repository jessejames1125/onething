/**
 * The Worker entry: fetch, scheduled and email.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { securityHeaders } from "./core/securityHeaders";
import runnerInstructions from "../tools/runner/RUNNER.md";
import type { AppEnv, CaptureSource, Env } from "./core/types";
import { makeCtx } from "./core/ctx";
import { authKind, login, LOGIN_RETRY_AFTER_S, logout, logoutEverywhere, requireAuth, requireSession } from "./core/auth";
import { getModules } from "./modules/registry";
import { registerCoreJobs } from "./core/coreJobs";
import { allJobs, INTERNAL_JOB_PATH, JOB_SIGNATURE_HEADER, lastHeartbeat, runDispatchedJob, runJobNow, scheduledTick } from "./core/jobs";
import { holdEmail, inbox, ingestCapture, parseEmail } from "./core/captureBus";
import { decide, pendingConfirmations } from "./core/confirmations";
import { agentOverview, claimTask, completeTask, failTask, listTasks, type AgentTaskStatusFilter } from "./core/agentTasks";
import { safeEqual } from "./core/crypto";
import { publicMessage } from "./core/errors";
import { isDemoRequest, SAMPLE_DUMP, SAMPLE_EMAIL } from "./core/demo";
import { nowForTool, nowView, tasksForTool, todoList } from "./modules/planner/now";

registerCoreJobs();

const app = new Hono<AppEnv>();

// First, so it wraps every response: API, error pages and the app's own files.
app.use("*", securityHeaders);

const MAX_BODY_BYTES = 256 * 1024;
app.use("/api/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "Request is too large." }, 413) }));

// The app's own files need no ctx: building one reads a setting from D1. Build files carry a content hash in their name, so
// the phone keeps them for a year. Not an unknown /assets/ path: the page fallback answers it, and that must stay fresh.
const APP_FILE = /^\/(?:index\.html|assets\/.+|icons\/.+|theme-init\.js|manifest\.webmanifest)?$/;
const HASHED_TTL = "public, max-age=31536000, immutable";
app.use("*", async (c, next) => {
  const m = c.req.method;
  if (!c.env.ASSETS || (m !== "GET" && m !== "HEAD") || !APP_FILE.test(c.req.path)) return next();
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const html = (res.headers.get("content-type") ?? "").includes("text/html");
  if (!c.req.path.startsWith("/assets/") || res.status !== 200 || html) return res;
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", HASHED_TTL);
  return out;
});

// Every other request gets a ctx. A GET only reads, so it remembers repeated reads (db.ts).
app.use("*", async (c, next) => {
  c.set("ctx", await makeCtx(c.env, { exec: c.executionCtx ?? null, memoReads: c.req.method === "GET", demo: isDemoRequest(c.env, c.req.url) }));
  c.set("auth", "none");
  await next();
});

// Never the error text itself: it is logged under an id and the client gets the id.
app.onError((err, c) => {
  const body = publicMessage(err, "unhandled");
  return c.json(body, body.id ? 500 : 400);
});

// ------------------------------------------------------------------ public
app.get("/api/health-check", async (c) => {
  const ctx = c.get("ctx");
  const hb = await lastHeartbeat(ctx);
  return c.json({ ok: true, heartbeatAgeMin: hb ? Math.round((ctx.now().getTime() - Date.parse(hb.started_at)) / 60000) : null });
});

app.post("/api/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { passphrase?: string };
  if (typeof body.passphrase !== "string" || !body.passphrase) return c.json({ error: "passphrase required" }, 400);
  const out = await login(c, body.passphrase);
  if (out.result === "blocked") return c.json({ error: out.message }, 429, { "Retry-After": String(LOGIN_RETRY_AFTER_S) });
  if (out.result === "wrong") return c.json({ error: "wrong passphrase" }, 401);
  return c.json({ ok: true });
});

app.post("/api/logout", async (c) => {
  logout(c);
  return c.json({ ok: true });
});

app.post("/api/logout-everywhere", requireSession, async (c) => {
  await logoutEverywhere(c);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ job fan-out (the dispatcher calling itself through SELF)
app.post(`${INTERNAL_JOB_PATH}/:id/run`, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { scheduledFor?: string };
  const out = await runDispatchedJob(c.get("ctx"), c.req.param("id"), String(body.scheduledFor ?? ""), c.req.header(JOB_SIGNATURE_HEADER) ?? "");
  return c.json(out.body, out.status);
});

// ------------------------------------------------------------------ the runner: its own token, its own routes
const requireRunner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.env.RUNNER_TOKEN) return c.json({ error: "RUNNER_TOKEN not set" }, 503);
  const h = c.req.header("authorization") ?? "";
  const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  if (!token || !safeEqual(token, c.env.RUNNER_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  c.set("auth", "bearer");
  await next();
};

const runner = new Hono<AppEnv>();
runner.use("*", requireRunner);

/** ?pass=web or ?pass=noweb. A pass sees only its own kinds, and a call without one sees neither. */
const passOf = (raw: string | undefined): { web: boolean } | null => (raw === "web" ? { web: true } : raw === "noweb" ? { web: false } : null);

runner.get("/instructions", (c) => c.text(runnerInstructions));
runner.get("/tasks", async (c) => {
  const pass = passOf(c.req.query("pass"));
  if (!pass) return c.json({ error: "say which pass: ?pass=web or ?pass=noweb" }, 400);
  const status = (c.req.query("status") ?? "queued") as AgentTaskStatusFilter;
  // A held task is not listed in any status: it waits for the owner's tap.
  if (status !== "queued" && status !== "claimed") return c.json({ error: "status must be queued or claimed" }, 400);
  return c.json({ items: await listTasks(c.get("ctx"), status, 20, pass) });
});
runner.post("/tasks/:id/claim", async (c) => {
  const pass = passOf(c.req.query("pass"));
  if (!pass) return c.json({ error: "say which pass: ?pass=web or ?pass=noweb" }, 400);
  const out = await claimTask(c.get("ctx"), Number(c.req.param("id")), pass);
  return out.ok ? c.json(out.task) : c.json({ error: out.error }, out.status as 404 | 409);
});
runner.post("/tasks/:id/result", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { result?: unknown } | null;
  const out = await completeTask(c.get("ctx"), Number(c.req.param("id")), body?.result);
  return out.ok ? c.json({ ok: true, handled: out.handled }) : c.json({ error: out.error }, out.status as 404 | 409 | 422);
});
runner.post("/tasks/:id/fail", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { error?: string };
  const out = await failTask(c.get("ctx"), Number(c.req.param("id")), String(body.error ?? "unknown"));
  return out.ok ? c.json({ ok: true, status: out.task.status }) : c.json({ error: out.error }, out.status as 404 | 409);
});
app.route("/api/agent", runner);

// ------------------------------------------------------------------ the app and the API token
const api = new Hono<AppEnv>();
api.use("*", requireAuth);

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

api.get("/me", async (c) => {
  const ctx = c.get("ctx");
  const hb = await lastHeartbeat(ctx);
  const demo = isDemoRequest(c.env, c.req.url);
  return c.json({
    auth: c.get("auth"),
    userName: ctx.userName,
    tz: ctx.tz,
    today: ctx.localDate(),
    now: ctx.now().toISOString(),
    day: { wake: minutes(await ctx.settings.get("day.wake", "06:30")), bed: minutes(await ctx.settings.get("day.bed", "22:30")) },
    lastHeartbeat: hb,
    llm: ctx.llm.describe(),
    runner: !!c.env.RUNNER_TOKEN,
    demo: demo ? { dump: SAMPLE_DUMP, emailSubject: SAMPLE_EMAIL.subject, emailBody: SAMPLE_EMAIL.body, emailFrom: SAMPLE_EMAIL.from } : null,
  });
});

api.post("/capture", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: string; via?: string };
  if (typeof body.text !== "string" || !body.text.trim()) return c.json({ error: "text required" }, 400);
  // The API token cannot claim to be the owner typing: its text is "token", or "mcp" when the MCP server says so.
  const source: Exclude<CaptureSource, "email"> = c.get("auth") === "bearer" ? (body.via === "mcp" ? "mcp" : "token") : "web";
  return c.json(await ingestCapture(c.get("ctx"), { text: body.text, source }));
});
api.get("/captures/inbox", async (c) => c.json({ items: await inbox(c.get("ctx")) }));

api.get("/now", async (c) => (c.get("auth") === "bearer" ? c.json(await nowForTool(c.get("ctx"))) : c.json(await nowView(c.get("ctx")))));
api.get("/tasks", async (c) => (c.get("auth") === "bearer" ? c.json({ items: await tasksForTool(c.get("ctx")) }) : c.json({ items: await todoList(c.get("ctx")) })));

api.get("/confirmations", async (c) => c.json({ items: await pendingConfirmations(c.get("ctx")) }));
api.post("/confirmations/:id/approve", async (c) => c.json(await decide(c.get("ctx"), Number(c.req.param("id")), true)));
api.post("/confirmations/:id/reject", async (c) => c.json(await decide(c.get("ctx"), Number(c.req.param("id")), false)));

api.get("/alerts", async (c) => c.json({ items: await c.get("ctx").db.all("SELECT id, level, message, created_at FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100") }));
api.post("/alerts/:id/resolve", async (c) => {
  const ctx = c.get("ctx");
  await ctx.db.update("alerts", Number(c.req.param("id")), { resolved_at: ctx.now().toISOString() });
  return c.json({ ok: true });
});

api.get("/jobs", async (c) => {
  const ctx = c.get("ctx");
  const runs = await ctx.db.all<{ job: string; started_at: string; status: string; error: string | null }>("SELECT job, started_at, status, error FROM job_runs WHERE id IN (SELECT MAX(id) FROM job_runs GROUP BY job)");
  return c.json({ items: allJobs().map((j) => ({ id: j.id, schedule: j.def.schedule, last: runs.find((r) => r.job === j.id) ?? null })) });
});
api.post("/jobs/:id/run", async (c) => c.json(await runJobNow(c.get("ctx"), c.req.param("id"))));
api.get("/system/agent", async (c) => c.json(await agentOverview(c.get("ctx"))));

// The demo's "forward a sample email" door, the same code path the real email handler takes. Loopback demo only.
api.post("/demo/email", async (c) => {
  if (!isDemoRequest(c.env, c.req.url)) return c.json({ error: "not found" }, 404);
  const held = await holdEmail(c.get("ctx"), { from: SAMPLE_EMAIL.from, subject: SAMPLE_EMAIL.subject, body: SAMPLE_EMAIL.body });
  return c.json({ ok: !!held, ...held });
});

for (const m of getModules()) {
  if (!m.routes) continue;
  const sub = new Hono<AppEnv>();
  m.routes(sub);
  api.route(`/${m.name}`, sub);
}
app.route("/api", api);

// A signed-in check for the page: never a 401, so the login screen has no console error.
app.get("/session", async (c) => c.json({ signedIn: (await authKind(c)) === "session" }));

// An unknown API path is a 404, never the app's page.
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// Everything else is the app itself.
app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("Build the app first: npm run build", 404);
});

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, exec: ExecutionContext) {
    const res = await scheduledTick(env, exec);
    console.log("tick", JSON.stringify(res));
  },

  // Cloudflare Email Routing. Every message is held for a tap: no model reads it first.
  async email(message: ForwardableEmailMessage, env: Env, exec: ExecutionContext) {
    const ctx = await makeCtx(env, { exec });
    const parsed = parseEmail(await new Response(message.raw).text());
    await holdEmail(ctx, parsed, message.headers.get("message-id"));
  },
};
