// Admin is a single bearer token in a Worker secret (spec 4.8). There are no sessions
// and no user accounts: a request is admin only when it carries
// `Authorization: Bearer <ADMIN_TOKEN>`. Everything else is a public caller.
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./env";

const BEARER = /^Bearer[ \t]+(.+)$/i;
const encoder = new TextEncoder();

/**
 * Compares two strings in time that depends on their lengths only, not on where they
 * first differ. Different lengths never match, but still cost one full comparison.
 * Use it for every secret comparison (admin token, webhook path secret).
 */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.byteLength !== y.byteLength) {
    crypto.subtle.timingSafeEqual(x, x);
    return false;
  }
  return crypto.subtle.timingSafeEqual(x, y);
}

/** True when the request carries the admin token. A Worker with no ADMIN_TOKEN set has no admin. */
export function isAdmin(c: Context<{ Bindings: Env }>): boolean {
  const expected = c.env.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected === "") return false;
  const match = BEARER.exec(c.req.header("Authorization") ?? "");
  if (!match) return false;
  return safeEqual(match[1]!.trim(), expected);
}

/** The origin the Worker calls itself on through its SELF binding (the hourly job's own invocations). */
export const SELF_ORIGIN = "https://fineprint.internal";

/**
 * True when the request reached the deployed Worker: through its SELF binding (SELF_ORIGIN's host) or on
 * PUBLIC_BASE_URL's host. A preview URL (`wrangler versions upload`) runs another version on another host.
 */
export function onProductionHost(c: Context<{ Bindings: Env }>): boolean {
  const host = new URL(c.req.url).hostname;
  if (host === new URL(SELF_ORIGIN).hostname) return true;
  try {
    return host === new URL(c.env.PUBLIC_BASE_URL).hostname;
  } catch {
    return false;
  }
}

/**
 * Refuses with 403 `{error: "not_production"}` unless the request reached the deployed Worker (onProductionHost).
 * For a route whose work depends on which version runs it: a preview's version id is another stamp, so its sweep
 * of the stored screens would take production's current copies for an earlier deploy's. Goes after adminOnly.
 */
export const productionHostOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!onProductionHost(c)) return c.json({ error: "not_production" }, 403);
  await next();
};

/** Refuses with 401 `{error: "admin_required"}` unless the request is admin. */
export const adminOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!isAdmin(c)) return c.json({ error: "admin_required" }, 401);
  await next();
};
