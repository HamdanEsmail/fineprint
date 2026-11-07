// The site: server-rendered screens over the same read functions as the JSON API (src/readModel.ts).
// Mounted last in src/index.ts, so every API, hooks and object route keeps its own answer. Behind
// SITE_ENABLED: switched off, every site path answers exactly as the Worker did before the site
// existed (Hono's plain "404 Not Found"), so a recorder deploy never publishes an unapproved screen.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MAX_URL_LENGTH } from "../core/limits";
import type { Env } from "../env";
import { discover } from "../handlers/discover";
import { addPage, MAX_LABEL_LENGTH, visitorHash } from "../handlers/pages";
import {
  countChanges,
  countRetiredPagesWithChanges,
  diffVersions,
  findPage,
  getPageRecord,
  getStats,
  getVersion,
  listChanges,
  listPages,
  listVersionsForDiff,
  parseTime,
  sectionPlaces,
  versionInForce,
  type VersionItem,
} from "../readModel";
import { parseAsOfInput, webHref } from "./format";
import { About } from "./views/about";
import { CompareView, diffSections, type CompareState } from "./views/compare";
import { FEATURE_CHANGES, FEED_SIZE, featuredCatch, Home } from "./views/home";
import { NotFound, ServerError } from "./views/notFound";
import { PageView, type AsOf } from "./views/page";
import { Watchlist, type FindState, type Refusal, type WatchlistProps } from "./views/watchlist";

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

const render = (c: AppContext, page: Child, status: ContentfulStatusCode = 200): Response | Promise<Response> =>
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

// --- About: how Fineprint works ---------------------------------------------------------------------

siteRouter.get("/about", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  // Nine queries, then the featured catch's: the stats (six); the newest changes outside retired pages, which
  // the featured catch picks from as the home does (the same change, under the same caps); the newest
  // layout-only change, for the one linked example; and the page list, for the retired pages it names.
  const [stats, changes, layoutOnly, pages] = await Promise.all([
    getStats(c.env),
    listChanges(c.env, { limit: FEATURE_CHANGES, includeRetired: false }),
    listChanges(c.env, { limit: 1, includeRetired: false, layoutOnly: true }),
    listPages(c.env),
  ]);
  const featured = await featuredCatch(c.env, changes);
  return render(
    c,
    <About
      stats={stats}
      featured={featured}
      sample={changes[0] ?? null}
      layoutExample={layoutOnly[0] ?? null}
      retired={pages.filter((p) => p.status === "retired")}
      baseUrl={c.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}
      repoUrl={webHref(c.env.REPO_URL ?? "")}
    />,
  );
});

// --- Watchlist: every page, the public add and discover --------------------------------------------

/** The largest add form read (a 2,048-character url and a 200-character label, percent-encoded, fit with room). */
const MAX_FORM_BYTES = 16 * 1024;

type FormRead =
  | { ok: true; url: string; label: string }
  | { ok: false; status: 400 | 403 | 413; error: "invalid_body" | "form_too_large" | "cross_site" };

/** The request body, read up to `max` bytes; null once it is longer (the rest is not read). */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/**
 * The add form's two fields. Only a browser form is read (urlencoded, or multipart), at most MAX_FORM_BYTES;
 * a field sent as a file, or twice, counts as its text or its last value. Every other field (a `kind`, an
 * `admin` or `token` field) is ignored: the site's add is a public add, whatever the request carries.
 */
async function readAddForm(c: AppContext): Promise<FormRead> {
  const contentType = c.req.header("content-type") ?? "";
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded" && type !== "multipart/form-data") return { ok: false, status: 400, error: "invalid_body" };
  const tooLarge = { ok: false, status: 413, error: "form_too_large" } as const;
  if (Number(c.req.header("content-length")) > MAX_FORM_BYTES) return tooLarge;
  let form: FormData;
  try {
    const body = await readCapped(c.req.raw, MAX_FORM_BYTES);
    if (body === null) return tooLarge;
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  const text = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  return { ok: true, url: text("url"), label: text("label") };
}

/** The watchlist screen over the stats (six queries) and the page list (one), with `status`. */
function watchlist(
  c: AppContext,
  read: { stats: WatchlistProps["stats"]; pages: WatchlistProps["pages"] },
  rest: Omit<WatchlistProps, "stats" | "pages" | "nowMs">,
  status: ContentfulStatusCode = 200,
): Response | Promise<Response> {
  return render(c, <Watchlist stats={read.stats} pages={read.pages} nowMs={Date.now()} {...rest} />, status);
}

siteRouter.get("/watchlist", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  // url= and label= fill the add form (a Watch this page link); they are only shown, so they cost nothing.
  const url = c.req.query("url") ?? "";
  const label = c.req.query("label") ?? "";
  const typed = c.req.query("domain")?.trim() ?? "";
  const [stats, pages] = await Promise.all([getStats(c.env), listPages(c.env)]);

  // domain= searches, through the discover() of POST /api/discover: the same parsing, the same ten lookups a day
  // for the visitor, matched against the pages read above. Only the search form sends it; no link on the site does.
  // Hono answers HEAD with this handler, and a HEAD (a link checker, a preview fetcher) shows nobody the results,
  // so it searches nothing and takes none of the visitor's lookups.
  let find: FindState | null = null;
  if (typed !== "" && c.req.method !== "HEAD") {
    const answer =
      typed.length > MAX_URL_LENGTH
        ? ({ ok: false, status: 400, error: "invalid_domain" } as const)
        : await discover(c.env, typed, { admin: false, ipHash: () => visitorHash(c) }, pages);
    find = { typed: typed.slice(0, MAX_URL_LENGTH), answer };
  }
  return watchlist(
    c,
    { stats, pages },
    {
      form: { url: url.slice(0, MAX_URL_LENGTH), label: label.slice(0, MAX_LABEL_LENGTH) },
      refusal: null,
      find,
      noindex: url !== "" || label !== "" || typed !== "",
    },
    find !== null && !find.answer.ok ? find.answer.status : 200,
  );
});

/**
 * A post another site made a browser send: `Sec-Fetch-Site: cross-site`, or an `Origin` that is not this
 * host's (`null` included). A request with neither header (an older browser, a script) is let through: the
 * add's own caps and daily limit hold whoever sends it, and there is no cookie or session to ride on.
 */
function fromAnotherSite(c: AppContext): boolean {
  if (c.req.header("sec-fetch-site")?.toLowerCase() === "cross-site") return true;
  const origin = c.req.header("origin");
  return origin !== undefined && origin !== new URL(c.req.url).origin;
}

siteRouter.post("/watchlist", async (c) => {
  if (!siteEnabled(c.env)) return c.notFound();
  // A post from another site is refused before its body is read.
  const form: FormRead = fromAnotherSite(c) ? { ok: false, status: 403, error: "cross_site" } : await readAddForm(c);
  let refusal: Refusal;
  let status: ContentfulStatusCode;
  if (!form.ok) {
    refusal = { error: form.error };
    status = form.status;
  } else {
    // Always a public add (`admin: false`), counted by the visitor key POST /api/pages uses: the site never
    // takes the admin token, whatever header or field arrives. An empty label is no label (the page's title).
    const result = await addPage(
      c.env,
      { waitUntil: (work) => c.executionCtx.waitUntil(work) },
      { url: form.url, label: form.label.trim() === "" ? undefined : form.label },
      { admin: false, ipHash: () => visitorHash(c) },
    );
    // Task 3's page view takes over: the baseline, then the screenshot, with its pending copy and refresh. The
    // fragment is the version card's: without one, the browser would keep the form's #add.
    if (result.ok) return c.redirect(`/pages/${encodeURIComponent(result.page.id)}#version`, 303);
    refusal = result;
    status = result.status;
  }
  // Refused: the screen again, read only now (a successful add reads nothing more), with the add's own status,
  // the reason beside the form and what was typed kept, cut to the fields' lengths.
  const [stats, pages] = await Promise.all([getStats(c.env), listPages(c.env)]);
  return watchlist(
    c,
    { stats, pages },
    {
      form: form.ok ? { url: form.url.slice(0, MAX_URL_LENGTH), label: form.label.slice(0, MAX_LABEL_LENGTH) } : { url: "", label: "" },
      refusal,
      find: null,
      noindex: true,
    },
    status,
  );
});
