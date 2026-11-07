// The site: server-rendered screens over the same read functions as the JSON API (src/readModel.ts).
// Mounted last in src/index.ts, so every API, hooks and object route keeps its own answer. Behind
// SITE_ENABLED: switched off, every site path answers exactly as the Worker did before the site
// existed (Hono's plain "404 Not Found"), so a recorder deploy never publishes an unapproved screen.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { Env } from "../env";
import {
  countChanges,
  countRetiredPagesWithChanges,
  diffVersions,
  findPage,
  getPageRecord,
  getStats,
  getVersion,
  listChanges,
  listVersionsForDiff,
  parseTime,
  sectionPlaces,
  versionInForce,
  type VersionItem,
} from "../readModel";
import { parseAsOfInput } from "./format";
import { CompareView, diffSections, type CompareState } from "./views/compare";
import { FEED_SIZE, featuredCatch, Home } from "./views/home";
import { NotFound, ServerError } from "./views/notFound";
import { PageView, type AsOf } from "./views/page";

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
    // The hero counts what Stats.changes counts: no retired page, no layout-only change (the feed lists those).
    countChanges(c.env, { since, includeRetired: false, excludeLayoutOnly: true }),
    countRetiredPagesWithChanges(c.env),
  ]);
  // The featured catch is on the newest screen only; it reads its candidates from the feed it is shown above.
  const featured = before === null ? await featuredCatch(c.env, changes) : null;
  return render(
    c,
    <Home
      stats={stats}
      weekCount={weekCount}
      changes={changes}
      before={before}
      retiredWithChanges={retiredWithChanges}
      featured={featured}
    />,
  );
});

// --- Page view: one page's history ----------------------------------------------------------

siteRouter.get("/pages/:id", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  const pageId = c.req.param("id");
  // The page row (with its noise count) first: a page that is not there is the ledger's 404 after that one
  // read, without the stats. Then nine in all: the stats every screen's stamp and spend meter need (six)
  // beside the page's versions and runs (two), none with a text. v= and at= are resolved from the
  // versions already read.
  const head = await findPage(c.env, pageId);
  if (head === null) return render(c, <NotFound />, 404);
  const [stats, detail] = await Promise.all([getStats(c.env), getPageRecord(c.env, head)]);

  const nowMs = Date.now();
  const { versions } = detail;
  let selected: VersionItem | null = versions[0] ?? null;
  let asOf: AsOf | null = null;

  // v= picks a version and wins over at=; a version this page does not have is the ledger's 404.
  const v = c.req.query("v");
  const atRaw = c.req.query("at")?.trim();
  if (v) {
    const hit = versions.find((version) => version.id === v);
    if (hit === undefined) return render(c, <NotFound />, 404);
    selected = hit;
  } else if (atRaw && versions.length > 0) {
    const at = parseAsOfInput(atRaw);
    if (at === null) {
      asOf = { kind: "unreadable" };
    } else if (Date.parse(at) > nowMs) {
      asOf = { kind: "future", at };
    } else {
      // The same version GET /api/pages/:id/as-of answers with: the newest captured at or before `at`.
      const hit = versionInForce(versions, at);
      if (hit !== null) {
        selected = hit;
        asOf = { kind: "resolved", at };
      } else {
        selected = versions[versions.length - 1]!;
        asOf = { kind: "before_baseline", at, baselineAt: selected.captured_at };
      }
    }
  }

  // The recorded text (up to a few hundred KB) is read only when asked for: one more query.
  const text =
    c.req.query("text") === "1" && selected !== null
      ? ((await getVersion(c.env, pageId, selected.id, { withText: true }))?.text ?? null)
      : null;

  return render(c, <PageView stats={stats} detail={detail} selected={selected} asOf={asOf} text={text} nowMs={nowMs} />);
});

// --- Compare view: the diff between two versions -------------------------------------------------

siteRouter.get("/pages/:id/compare", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  const pageId = c.req.param("id");
  // As the page view: the page first, so an unknown page is the ledger's 404 after one query. Then the
  // stats (six) and the page's versions (one, no text); from= and to= are found among those versions, so a
  // version this page does not have is the 404 too, and only then is the diff read (one query when it is
  // stored, or the two texts and two counts and the cache write when it is not).
  const head = await findPage(c.env, pageId);
  if (head === null) return render(c, <NotFound />, 404);
  const [stats, versions] = await Promise.all([getStats(c.env), listVersionsForDiff(c.env, pageId)]);
  const items = versions.map((v) => v.item);

  const indexOf = (id: string | undefined): number | null => {
    if (id === undefined || id === "") return null;
    const i = versions.findIndex((v) => v.row.id === id);
    return i === -1 ? -1 : i;
  };
  let fromIndex = indexOf(c.req.query("from"));
  let toIndex = indexOf(c.req.query("to"));
  if (fromIndex === -1 || toIndex === -1) return render(c, <NotFound />, 404);

  const view = (state: CompareState) => <CompareView stats={stats} page={head.page} versions={items} state={state} />;
  if (versions.length < 2) return render(c, view({ kind: "single" }));

  // Versions are newest first. Without to=, the latest; without from=, the one just before `to` (the one
  // just after it when `to` is the first version).
  toIndex ??= 0;
  fromIndex ??= toIndex + 1 < versions.length ? toIndex + 1 : toIndex - 1;
  if (fromIndex === toIndex) return render(c, view({ kind: "same", at: items[toIndex]! }));
  // `from` is the older: a reversed pair is swapped, so the cache key is the one the JSON route uses.
  if (fromIndex < toIndex) [fromIndex, toIndex] = [toIndex, fromIndex];

  const from = versions[fromIndex]!;
  const to = versions[toIndex]!;
  const answer = await diffVersions(c.env, head.page, from.row, to.row);
  // A version deleted between the two reads.
  if (answer === null) return render(c, <NotFound />, 404);
  const diff = answer.diff;
  // Where the sections stand in the two texts, so the groups go in page order: one more query, searched in
  // D1, only when there are two sections or more to order.
  const sections = diff.blocks ? diffSections(diff.blocks) : [];
  const places = sections.length > 1 ? await sectionPlaces(c.env, from.row.id, to.row.id, sections) : null;
  return render(c, view({ kind: "diff", from: from.item, to: to.item, diff, all: c.req.query("all") === "1", places }));
});
