/**
 * Security headers on every response, the app's own files included (wrangler.jsonc sends every request through the
 * Worker: assets.run_worker_first = true). The app talks to its own origin and nothing else, so the policy is one line
 * of 'self', and no inline script is allowed.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./types";

export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Inline style attributes stay allowed (React style={...}); scripts do not.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const FIXED: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const res = c.res;
  const headers: Record<string, string> = { ...FIXED };
  // Browsers copy a 304's headers onto the cached page: keep the cached policy.
  if (res.status !== 304) headers["Content-Security-Policy"] = contentSecurityPolicy();
  // A fresh response every time: ASSETS responses have immutable headers.
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  c.res = undefined;
  c.res = out;
};
