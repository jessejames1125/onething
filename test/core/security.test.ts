import { describe, expect, it } from "vitest";
import { api, BASE, env, makeTestCtx, TEST } from "../helpers";
import { makeSessionCookie, SESSION_EPOCH_KEY, verifySessionCookie } from "../../src/core/auth";
import { contentSecurityPolicy } from "../../src/core/securityHeaders";
import { GENERIC_ERROR, publicMessage } from "../../src/core/errors";
import { ValidationError } from "../../src/core/validate";

const login = (passphrase: string, ip = "198.51.100.7") => api("/api/login", { body: { passphrase }, headers: { "cf-connecting-ip": ip } }, "none");

describe("sign-in", () => {
  it("the right passphrase sets an HttpOnly cookie; the wrong one does not", async () => {
    const ok = await login(TEST.passphrase);
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("onething_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const bad = await login("wrong");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("five wrong tries lock that address out, and the right passphrase does not get through", async () => {
    for (let i = 0; i < 5; i++) expect((await login("wrong")).status).toBe(401);
    const locked = await login(TEST.passphrase);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    expect((await login(TEST.passphrase, "198.51.100.8")).status).toBe(200);
  });

  it("30 wrong tries from many addresses pause sign-in for everyone and raise an alert", async () => {
    for (let i = 0; i < 30; i++) await login("wrong", `203.0.113.${i}`);
    expect((await login(TEST.passphrase, "203.0.113.200")).status).toBe(429);
    const alert = await env.DB.prepare("SELECT id FROM alerts WHERE key = 'auth.login_locked'").first();
    expect(alert).not.toBeNull();
  });

  it("a tampered or expired cookie is refused", async () => {
    const good = await makeSessionCookie(env);
    expect(await verifySessionCookie(env, good)).toBe(true);
    expect(await verifySessionCookie(env, `${good}x`)).toBe(false);
    const [exp, sig] = good.split(".");
    expect(await verifySessionCookie(env, `${Number(exp) + 1000}.${sig}`)).toBe(false);
    expect(await verifySessionCookie(env, good, new Date(Date.now() + 2 * 365 * 24 * 3600_000))).toBe(false);
  });

  it("a new passphrase ends every existing session", async () => {
    const cookie = await makeSessionCookie(env);
    expect(await verifySessionCookie({ ...env, APP_PASSPHRASE: "changed" }, cookie)).toBe(false);
  });

  it("'sign out everywhere' ends every cookie issued so far", async () => {
    const before = await makeSessionCookie(env);
    const res = await api("/api/logout-everywhere", { method: "POST" });
    expect(res.status).toBe(200);
    const ctx = await makeTestCtx();
    const epoch = await ctx.settings.get(SESSION_EPOCH_KEY, "0");
    expect(epoch).not.toBe("0");
    const refused = await api("/api/now", { headers: { cookie: `onething_session=${before}` } }, "none");
    expect(refused.status).toBe(401);
  });
});

describe("a cross-site page cannot drive the app", () => {
  const cookie = async () => `onething_session=${await makeSessionCookie(env)}`;

  it("a form post with the cookie but no header or JSON is refused", async () => {
    const res = await api("/api/capture", { method: "POST", headers: { cookie: await cookie(), "content-type": "application/x-www-form-urlencoded" } }, "none");
    expect(res.status).toBe(403);
  });

  it("a foreign Origin is refused even with the header", async () => {
    const res = await api("/api/capture", { body: { text: "x" }, headers: { cookie: await cookie(), origin: "https://attacker.example", "x-requested-with": "onething" } }, "none");
    expect(res.status).toBe(403);
    expect(await (await api("/api/capture", { body: { text: "water the plants" }, headers: { cookie: await cookie(), origin: BASE, "x-requested-with": "onething" } }, "none")).json()).toMatchObject({ items: expect.any(Array) });
  });

  it("sec-fetch-site cross-site is refused", async () => {
    const res = await api("/api/capture", { body: { text: "x" }, headers: { cookie: await cookie(), "sec-fetch-site": "cross-site", "x-requested-with": "onething" } }, "none");
    expect(res.status).toBe(403);
  });
});

describe("headers and errors", () => {
  it("every response carries the security headers, errors included", async () => {
    for (const path of ["/api/now", "/api/health-check", "/api/nope"]) {
      const res = await api(path, {}, "none");
      expect(res.headers.get("content-security-policy"), path).toBe(contentSecurityPolicy());
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
  });

  it("the policy allows the app's own origin and nothing else", () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/https?:/);
    expect(csp.match(/script-src[^;]*/)![0]).not.toContain("unsafe");
  });

  it("an oversized body is refused before any handler reads it", async () => {
    const res = await api("/api/capture", { body: { text: "x".repeat(300 * 1024) } });
    expect(res.status).toBe(413);
  });

  it("internal error text never reaches the client", () => {
    expect(publicMessage(new ValidationError("A goal needs a title.")).error).toBe("A goal needs a title.");
    expect(publicMessage(new Error("Nothing to save.")).error).toBe("Nothing to save.");
    for (const leak of ["D1_ERROR: no such table: tasks", "SQLITE_CONSTRAINT: constraint failed", "fetch failed https://internal.example/x", "at handler (src/index.ts:12:3)"]) {
      const out = publicMessage(new Error(leak));
      expect(out.error).toBe(GENERIC_ERROR);
      expect(out.id).toBeTruthy();
    }
    expect(publicMessage(new TypeError("x is not a function")).error).toBe(GENERIC_ERROR);
  });

  it("an unknown API path is a 404, never the app's page", async () => {
    const res = await api("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("json");
  });
});
