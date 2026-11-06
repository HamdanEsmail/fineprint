// The public read API over the recorded history (spec 4.7 and 4.8): one version, the version
// in force at a time, the structured diff between two times, the change feed, the full export
// and the stats. All of it is GET and JSON; CORS is added for /api/* in index.ts.
//
// The free plan allows 10 ms of CPU a request, so nothing here loops over pages with a query
// each, and no list reads a version's `text`. The one expensive answer, a diff, is computed and
// stored in `diff_cache` by src/readModel.ts (diffVersions), which the site's compare view calls
// too; see there for when a diff is kept. Every version is shown through the one mapper in
// ./versionJson.ts.
import { Hono } from "hono";
import type { Context } from "hono";
import { getPage, listPages } from "../db/pages";
import { baselineVersion, listAllVersionSummaries, versionSummaryAsOf, type VersionSummary, type WithTrigger } from "../db/versions";
import type { Env } from "../env";
import { diffVersions, getStats, getVersion as readVersion, getVersionAsOf, listChanges, parseTime } from "../readModel";
import { pageToJson } from "./pages";
import { versionSummaryJson } from "./versionJson";

type AppContext = Context<{ Bindings: Env }>;

export const historyRouter = new Hono<{ Bindings: Env }>();

historyRouter.onError((err, c) => {
  console.error("history handler failed", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  return c.json({ error: "internal_error" }, 500);
});

// --- Helpers ----------------------------------------------------------------------------------

const notFound = (c: AppContext): Response => c.json({ error: "not_found" }, 404);

/** The 404 for a time the page has no version for. */
async function noVersionAt(c: AppContext, pageId: string, reason: "before_baseline" | "no_versions"): Promise<Response> {
  if (reason === "before_baseline") {
    const baseline = await baselineVersion(c.env.DB, pageId);
    if (baseline) return c.json({ error: "before_baseline", baseline_at: baseline.captured_at }, 404);
  }
  return c.json({ error: "no_versions" }, 404);
}

// --- One version and as-of --------------------------------------------------------------------

historyRouter.get("/pages/:id/versions/:vid", async (c) => {
  // Unknown page, unknown version and a version of another page are all not_found.
  const version = await readVersion(c.env, c.req.param("id"), c.req.param("vid"), { withText: true });
  return version ? c.json(version) : notFound(c);
});

historyRouter.get("/pages/:id/as-of", async (c) => {
  const pageId = c.req.param("id");
  const at = parseTime(c.req.query("at"));
  // An unknown page is not_found whatever the time says, as it was before the read model.
  if (at === null) return (await getPage(c.env.DB, pageId)) ? c.json({ error: "invalid_at" }, 400) : notFound(c);

  const result = await getVersionAsOf(c.env, pageId, at);
  if (result === null) return notFound(c);
  if ("error" in result) return c.json(result, 404);
  return c.json(result);
});

// --- Diff -------------------------------------------------------------------------------------

historyRouter.get("/pages/:id/diff", async (c) => {
  const db = c.env.DB;
  const page = await getPage(db, c.req.param("id"));
  if (!page) return notFound(c);

  const fromAt = parseTime(c.req.query("from"));
  if (fromAt === null) return c.json({ error: "invalid_from" }, 400);
  const toAt = parseTime(c.req.query("to"));
  if (toAt === null) return c.json({ error: "invalid_to" }, 400);

  const [from, to] = await Promise.all([versionSummaryAsOf(db, page.id, fromAt), versionSummaryAsOf(db, page.id, toAt)]);
  if (typeof from === "string") return noVersionAt(c, page.id, from);
  if (typeof to === "string") return noVersionAt(c, page.id, to);
  // Both ends are the latest version at or before their time, so `from` comes later than `to`
  // only when the range is reversed (R19). Two ends in one version are an empty diff.
  if (from.id !== to.id && from.captured_at > to.captured_at) return c.json({ error: "invalid_range" }, 400);

  // The same diff, from the same cache, as the site's compare view (src/readModel.ts diffVersions): a stored
  // answer is served as the text it was stored with.
  const answer = await diffVersions(c.env, pageToJson(page), from, to);
  if (answer === null) return notFound(c);
  return c.body(answer.json, 200, { "Content-Type": "application/json" });
});

// --- Change feed ------------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** `limit`: 50 when absent or not a number, otherwise clamped to 1..200. */
function readLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

historyRouter.get("/changes", async (c) => {
  const sinceRaw = c.req.query("since");
  const since = sinceRaw === undefined ? null : parseTime(sinceRaw);
  if (sinceRaw !== undefined && since === null) return c.json({ error: "invalid_since" }, 400);
  const beforeRaw = c.req.query("before");
  const before = beforeRaw === undefined ? null : parseTime(beforeRaw);
  if (beforeRaw !== undefined && before === null) return c.json({ error: "invalid_before" }, 400);

  const items = await listChanges(c.env, {
    since: since ?? undefined,
    before: before ?? undefined,
    limit: readLimit(c.req.query("limit")),
    // retired=0 leaves out the pages retired for unreliable reads; without it they stay in.
    includeRetired: c.req.query("retired") !== "0",
  });
  return c.json({ changes: items });
});

// --- Export -----------------------------------------------------------------------------------

historyRouter.get("/export.json", async (c) => {
  // Two queries however many pages there are: the pages, then every version without its text,
  // grouped here. Versions are newest first, as in /api/pages/:id.
  const [pages, versions] = await Promise.all([listPages(c.env.DB), listAllVersionSummaries(c.env.DB)]);
  const byPage = new Map<string, WithTrigger<VersionSummary>[]>();
  for (const version of versions) {
    const list = byPage.get(version.page_id);
    if (list) list.push(version);
    else byPage.set(version.page_id, [version]);
  }

  return c.json({
    generated_at: new Date().toISOString(),
    pages: pages.map((page) => ({
      ...pageToJson(page),
      versions: (byPage.get(page.id) ?? []).map((v) => versionSummaryJson(c.env, v)),
    })),
  });
});

// --- Stats ------------------------------------------------------------------------------------

historyRouter.get("/stats", async (c) => c.json(await getStats(c.env)));
