/**
 * Auth: passphrase login gives an HMAC-signed cookie (1 year); Bearer API_TOKEN for scripts and the MCP server.
 *
 * - The cookie's signature covers a session epoch (setting auth.session_epoch) and a hash of APP_PASSPHRASE, so "Sign out
 *   everywhere" (a new epoch) and a new passphrase both end every existing session.
 * - POST /api/login is rate limited per IP and overall (login_failures table).
 * - The API token reaches only the routes in TOKEN_ROUTES. It can read the list and add to it, nothing else.
 * - A cookie-authenticated change must carry the app's X-Requested-With header or a JSON body, and a same-site Origin.
 * - Demo mode (core/demo.ts) counts as a session on a loopback host only.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, AuthKind, Ctx, Env } from "./types";
import { hmacHex, randomId, safeEqual, sha256Hex } from "./crypto";
import { isDemoRequest } from "./demo";

export const COOKIE_NAME = "onething_session";
const ONE_YEAR_S = 365 * 24 * 3600;
export const SESSION_EPOCH_KEY = "auth.session_epoch";

async function sessionSig(env: Env, epoch: string, exp: number): Promise<string> {
  const pass = await sha256Hex(env.APP_PASSPHRASE ?? "");
  return hmacHex(env.SESSION_SECRET!, `session:v2:${epoch}:${pass}:${exp}`);
}

export async function makeSessionCookie(env: Env, now = new Date(), epoch = "0"): Promise<string> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET not set");
  const exp = Math.floor(now.getTime() / 1000) + ONE_YEAR_S;
  return `${exp}.${await sessionSig(env, epoch, exp)}`;
}

export async function verifySessionCookie(env: Env, value: string | undefined, now = new Date(), epoch = "0"): Promise<boolean> {
  if (!value || !env.SESSION_SECRET) return false;
  const [expStr, sig] = value.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || !sig) return false;
  if (exp * 1000 < now.getTime()) return false;
  return safeEqual(sig, await sessionSig(env, epoch, exp));
}

async function sessionEpoch(c: Context<AppEnv>): Promise<string> {
  return c.get("ctx").settings.get(SESSION_EPOCH_KEY, "0");
}

async function hasSession(c: Context<AppEnv>): Promise<boolean> {
  if (isDemoRequest(c.env, c.req.url)) return true;
  const value = getCookie(c, COOKIE_NAME);
  if (!value) return false;
  return verifySessionCookie(c.env, value, new Date(), await sessionEpoch(c));
}

export function bearerOk(env: Env, req: Request): boolean {
  const h = req.headers.get("authorization") ?? "";
  if (!h.toLowerCase().startsWith("bearer ")) return false;
  const token = h.slice(7).trim();
  return !!env.API_TOKEN && safeEqual(token, env.API_TOKEN);
}

export async function authKind(c: Context<AppEnv>): Promise<AuthKind> {
  if (bearerOk(c.env, c.req.raw)) return "bearer";
  if (await hasSession(c)) return "session";
  return "none";
}

/** Everything the API token may call. */
export const TOKEN_ROUTES = new Set(["POST /api/capture", "GET /api/now", "GET /api/tasks"]);

function tokenAllowed(c: Context<AppEnv>): boolean {
  return TOKEN_ROUTES.has(`${c.req.method.toUpperCase()} ${c.req.path.replace(/\/+$/, "")}`);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A browser sends the cookie on a cross-site form post too. A change is accepted only when it carries what a form cannot:
 * the app's X-Requested-With header or a JSON content type. A foreign Origin is refused outright.
 */
export function csrfRefusal(c: Context<AppEnv>): string | null {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) return null;
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return "cross-site request refused";
  if ((c.req.header("sec-fetch-site") ?? "").toLowerCase() === "cross-site") return "cross-site request refused";
  const xrw = !!c.req.header("x-requested-with");
  const json = (c.req.header("content-type") ?? "").toLowerCase().includes("application/json");
  if (!xrw && !json) return "missing X-Requested-With header";
  return null;
}

/** Session cookie, or Bearer API_TOKEN on its few routes. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const kind = await authKind(c);
  if (kind === "none") return c.json({ error: "unauthorized" }, 401);
  if (kind === "bearer" && !tokenAllowed(c)) return c.json({ error: "the API token cannot call this endpoint" }, 403);
  if (kind === "session") {
    const refused = csrfRefusal(c);
    if (refused) return c.json({ error: refused }, 403);
  }
  c.set("auth", kind);
  await next();
};

/** App session only. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await hasSession(c))) return c.json({ error: "unauthorized" }, 401);
  const refused = csrfRefusal(c);
  if (refused) return c.json({ error: refused }, 403);
  c.set("auth", "session");
  await next();
};

// ------------------------------------------------------------------ login rate limit

const WINDOW_MIN = 15;
const PER_IP = 5;
const GLOBAL = 30;

export function clientIp(c: Context<AppEnv>): string {
  return (c.req.header("cf-connecting-ip") ?? "unknown").slice(0, 64);
}

/** Null when this IP may try a passphrase; else the message for the 429. */
export async function loginBlocked(ctx: Ctx, ip: string): Promise<string | null> {
  const since = new Date(ctx.now().getTime() - WINDOW_MIN * 60_000).toISOString();
  const mine = await ctx.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at >= ?", ip, since);
  if (Number(mine?.n ?? 0) >= PER_IP) return `Too many wrong passphrases. Try again in ${WINDOW_MIN} minutes.`;
  const all = await ctx.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM login_failures WHERE at >= ?", since);
  if (Number(all?.n ?? 0) >= GLOBAL) {
    await ctx.alert({ key: "auth.login_locked", level: "warn", module: "core", message: `Sign-in is paused: ${GLOBAL}+ wrong passphrases in ${WINDOW_MIN} minutes from many addresses.` });
    return `Sign-in is paused after many wrong passphrases. Try again in ${WINDOW_MIN} minutes.`;
  }
  return null;
}

async function recordLoginFailure(ctx: Ctx, ip: string): Promise<void> {
  const now = ctx.now();
  await ctx.db.run("INSERT INTO login_failures (ip, at) VALUES (?, ?)", ip, now.toISOString());
  await ctx.db.run("DELETE FROM login_failures WHERE at < ?", new Date(now.getTime() - 24 * 3600_000).toISOString());
}

export const LOGIN_RETRY_AFTER_S = WINDOW_MIN * 60;

/** "ok" sets the cookie; "wrong" counts a failure; "blocked" answers 429 without checking the passphrase. */
export async function login(c: Context<AppEnv>, passphrase: string): Promise<{ result: "ok" } | { result: "wrong" } | { result: "blocked"; message: string }> {
  const env = c.env;
  const ctx = c.get("ctx");
  const ip = clientIp(c);
  const blocked = await loginBlocked(ctx, ip);
  if (blocked) return { result: "blocked", message: blocked };
  if (!env.APP_PASSPHRASE || !env.SESSION_SECRET || !safeEqual(passphrase.trim(), env.APP_PASSPHRASE)) {
    await recordLoginFailure(ctx, ip);
    return { result: "wrong" };
  }
  await ctx.db.run("DELETE FROM login_failures WHERE ip = ?", ip);
  const value = await makeSessionCookie(env, new Date(), await sessionEpoch(c));
  setCookie(c, COOKIE_NAME, value, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: ONE_YEAR_S,
  });
  return { result: "ok" };
}

export function logout(c: Context<AppEnv>): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

/** A new epoch: every cookie issued so far, on every device, stops working. */
export async function logoutEverywhere(c: Context<AppEnv>): Promise<void> {
  await c.get("ctx").settings.set(SESSION_EPOCH_KEY, randomId(8));
  logout(c);
}
