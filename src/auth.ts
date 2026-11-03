// Admin is a single bearer token in a Worker secret (spec 4.8). There are no sessions
// and no user accounts: a request is admin only when it carries
// `Authorization: Bearer <ADMIN_TOKEN>`. Everything else is a public caller.
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./env";

const BEARER = /^Bearer[ \t]+(.+)$/i;
const encoder = new TextEncoder();

// Compares two strings in time that depends on their lengths only, not on where they
// first differ. Different lengths never match, but still cost one full comparison.
function safeEqual(a: string, b: string): boolean {
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

/** Refuses with 401 `{error: "admin_required"}` unless the request is admin. */
export const adminOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!isAdmin(c)) return c.json({ error: "admin_required" }, 401);
  await next();
};
