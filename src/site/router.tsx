// The site: server-rendered screens over the same read functions as the JSON API (src/readModel.ts).
// Mounted last in src/index.ts, so every API, hooks and object route keeps its own answer. Behind
// SITE_ENABLED: switched off, every site path answers exactly as the Worker did before the site
// existed (Hono's plain "404 Not Found"), so a recorder deploy never publishes an unapproved screen.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { Env } from "../env";
import { countChanges, countRetiredPagesWithChanges, getStats, listChanges, parseTime } from "../readModel";
import { FEED_SIZE, Home } from "./views/home";
import { NotFound, ServerError } from "./views/notFound";

type AppContext = Context<{ Bindings: Env }>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Sent with every HTML response (the site plan's Global Constraints). */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
} as const;

export const siteEnabled = (env: Env): boolean => env.SITE_ENABLED === "1";

const render = (c: AppContext, page: Child, status: 200 | 404 | 500 = 200): Response | Promise<Response> =>
  c.html(page as string | Promise<string>, status, SECURITY_HEADERS);

const isApiPath = (path: string): boolean =>
  path === "/api" || path.startsWith("/api/") || path === "/hooks" || path.startsWith("/hooks/");

/**
 * The Worker's 404 (src/index.ts `app.notFound`). The API and the hooks answer JSON whether or not
 * the site is on; with the site on, any other path gets the ledger's 404 page; with it off, Hono's own.
 * The 404 page reads nothing from the database: every probe for /wp-login.php or /.env lands here,
 * so it renders without the stamp and the spend meter.
 */
export function notFound(c: AppContext): Response | Promise<Response> {
  if (isApiPath(c.req.path)) return c.json({ error: "not_found" }, 404);
  if (!siteEnabled(c.env)) return c.text("404 Not Found", 404);
  return render(c, <NotFound />, 404);
}

export const siteRouter = new Hono<{ Bindings: Env }>();

siteRouter.onError((err, c) => {
  console.error("site handler failed", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  return render(c, <ServerError />, 500);
});

// --- Home: the change feed -------------------------------------------------------------------

siteRouter.get("/", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  // A before= that is not a time shows the newest changes.
  const before = parseTime(c.req.query("before"));
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const [stats, changes, weekCount, retiredWithChanges] = await Promise.all([
    getStats(c.env),
    listChanges(c.env, { before: before ?? undefined, limit: FEED_SIZE + 1, includeRetired: false }),
    countChanges(c.env, { since, includeRetired: false }),
    countRetiredPagesWithChanges(c.env),
  ]);
  return render(
    c,
    <Home stats={stats} weekCount={weekCount} changes={changes} before={before} retiredWithChanges={retiredWithChanges} />,
  );
});
