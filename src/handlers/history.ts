// The public read API over the recorded history (spec 4.7 and 4.8): one version, the version
// in force at a time, the structured diff between two times, the change feed, the full export
// and the stats. All of it is GET and JSON; CORS is added for /api/* in index.ts.
//
// The free plan allows 10 ms of CPU a request, so nothing here loops over pages with a query
// each, and no list reads a version's `text`. The one expensive answer, a diff, is computed
// once and stored in `diff_cache` under the two version ids; version rows never change their
// text, so the stored answer never goes stale and later requests only read it.
import { Hono } from "hono";
import type { Context } from "hono";
import { factsDiff, structuredDiff, type Fact, type FactsDiff, type StructuredDiff } from "../core/diff";
import { normalize } from "../core/normalize";
import { PRICES, type SpendKind } from "../core/spend";
import { getCachedDiff, putCachedDiff } from "../db/diffCache";
import { getPage, listPages } from "../db/pages";
import { countNoiseBetween } from "../db/runs";
import type { PageRow, PageStatus, VersionRow } from "../db/types";
import {
  baselineVersion,
  countVersionsBetween,
  getVersion,
  listAllVersionSummaries,
  listChanges,
  versionAsOf,
  versionSummaryAsOf,
  type VersionSummary,
} from "../db/versions";
import type { Env } from "../env";
import { pageToJson } from "./pages";

type AppContext = Context<{ Bindings: Env }>;

export const historyRouter = new Hono<{ Bindings: Env }>();

historyRouter.onError((err, c) => {
  console.error("history handler failed", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  return c.json({ error: "internal_error" }, 500);
});

// --- Helpers ----------------------------------------------------------------------------------

/**
 * A time parameter as the ISO string the database stores, or null when it is missing or not a
 * date. Stored times come from toISOString() (always ".000Z", four-digit years), so a parameter
 * is converted the same way before it is compared as text: "2026-11-02T09:15:00Z" and
 * "2026-11-02T12:15:00+03:00" then both find a version captured at 09:15:00.000Z. A year
 * outside 0000 to 9999 has no four-digit form and would not sort as text, so it is refused.
 */
function parseTime(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  return /^\d{4}-/.test(iso) ? iso : null;
}

/** The public urls of a version's stored copies (R18): null for a capture the version does not have. */
function objectUrls(
  env: Env,
  v: Pick<VersionSummary, "id" | "screenshot_key" | "html_key">,
): { screenshot_url: string | null; source_url: string | null } {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return {
    screenshot_url: v.screenshot_key ? `${base}/shots/${v.id}.jpg` : null,
    source_url: v.html_key ? `${base}/sources/${v.id}.html` : null,
  };
}

/** A version's stored facts, or null when it has none or what is stored is not a JSON array. */
function parseFacts(stored: string | null): Fact[] | null {
  if (stored === null) return null;
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) ? (value as Fact[]) : null;
  } catch {
    return null;
  }
}

const notFound = (c: AppContext): Response => c.json({ error: "not_found" }, 404);

/** The 404 for a time the page has no version for. */
async function noVersionAt(c: AppContext, pageId: string, reason: "before_baseline" | "no_versions"): Promise<Response> {
  if (reason === "before_baseline") {
    const baseline = await baselineVersion(c.env.DB, pageId);
    if (baseline) return c.json({ error: "before_baseline", baseline_at: baseline.captured_at }, 404);
  }
  return c.json({ error: "no_versions" }, 404);
}

/** A version with its text, as versions/:vid and as-of return it. */
function versionJson(env: Env, page: PageRow, v: VersionRow) {
  return {
    id: v.id,
    page_id: v.page_id,
    captured_at: v.captured_at,
    is_baseline: v.is_baseline === 1,
    text: v.text,
    facts: parseFacts(v.facts_json),
    ...objectUrls(env, v),
    live_url: page.url,
    judgment_summary: v.judgment_summary,
    capture_status: v.capture_status,
  };
}

// --- One version and as-of --------------------------------------------------------------------

historyRouter.get("/pages/:id/versions/:vid", async (c) => {
  const page = await getPage(c.env.DB, c.req.param("id"));
  if (!page) return notFound(c);
  const version = await getVersion(c.env.DB, c.req.param("vid"));
  if (!version || version.page_id !== page.id) return notFound(c);
  return c.json(versionJson(c.env, page, version));
});

historyRouter.get("/pages/:id/as-of", async (c) => {
  const page = await getPage(c.env.DB, c.req.param("id"));
  if (!page) return notFound(c);
  const at = parseTime(c.req.query("at"));
  if (at === null) return c.json({ error: "invalid_at" }, 400);

  const version = await versionAsOf(c.env.DB, page.id, at);
  if (typeof version === "string") return noVersionAt(c, page.id, version);
  return c.json(versionJson(c.env, page, version));
});

// --- Diff -------------------------------------------------------------------------------------

type DiffEnd = { version_id: string; captured_at: string; screenshot_url: string | null; source_url: string | null };

type DiffJson = {
  page: { id: string; url: string; label: string };
  from: DiffEnd;
  to: DiffEnd;
  summary: string | null;
  blocks: StructuredDiff;
  facts: FactsDiff | null;
  hops: number;
  noise_suppressed_between: number;
};

const diffEnd = (env: Env, v: VersionSummary): DiffEnd => ({
  version_id: v.id,
  captured_at: v.captured_at,
  ...objectUrls(env, v),
});

/**
 * The diff of two resolved versions (spec 4.7), or null if a version is gone. `hops` counts the
 * versions captured in (from, to] and `noise_suppressed_between` the suppressed runs received in
 * the same interval. Blocks come from the normalized texts, normalized with the page's current
 * ignore patterns, as the change gate does. One version on both sides is an empty diff and reads
 * no text.
 */
async function buildDiff(env: Env, page: PageRow, from: VersionSummary, to: VersionSummary): Promise<DiffJson | null> {
  let blocks: StructuredDiff = { added: [], removed: [], changed: [] };
  let hops = 0;
  let noiseBetween = 0;

  if (from.id !== to.id) {
    const db = env.DB;
    const [fromFull, toFull, hopCount, noiseCount] = await Promise.all([
      getVersion(db, from.id),
      getVersion(db, to.id),
      countVersionsBetween(db, page.id, from.captured_at, to.captured_at),
      countNoiseBetween(db, page.id, from.captured_at, to.captured_at),
    ]);
    if (!fromFull || !toFull) return null;
    const patterns = pageToJson(page).ignore_patterns;
    blocks = structuredDiff(normalize(fromFull.text, patterns).text, normalize(toFull.text, patterns).text);
    hops = hopCount;
    noiseBetween = noiseCount;
  }

  return {
    page: { id: page.id, url: page.url, label: page.label },
    from: diffEnd(env, from),
    to: diffEnd(env, to),
    summary: to.judgment_summary,
    blocks,
    facts: factsDiff(parseFacts(from.facts_json), parseFacts(to.facts_json)),
    hops,
    noise_suppressed_between: noiseBetween,
  };
}

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

  // A stored answer is served as it was stored: the viewer never recomputes.
  const cached = await getCachedDiff(db, from.id, to.id);
  if (cached !== null) return c.body(cached, 200, { "Content-Type": "application/json" });

  const diff = await buildDiff(c.env, page, from, to);
  if (diff === null) return notFound(c);
  const json = JSON.stringify(diff);
  try {
    await putCachedDiff(db, from.id, to.id, json);
  } catch (err) {
    // The answer is right whether or not it could be kept; the next request computes it again.
    console.error("diff cache write failed", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  }
  return c.body(json, 200, { "Content-Type": "application/json" });
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

  const rows = await listChanges(c.env.DB, since, readLimit(c.req.query("limit")));
  return c.json({
    changes: rows.map((row) => ({
      version_id: row.id,
      page_id: row.page_id,
      page_label: row.page_label,
      url: row.url,
      captured_at: row.captured_at,
      summary: row.judgment_summary,
      screenshot_url: objectUrls(c.env, row).screenshot_url,
    })),
  });
});

// --- Export -----------------------------------------------------------------------------------

historyRouter.get("/export.json", async (c) => {
  // Two queries however many pages there are: the pages, then every version without its text,
  // grouped here. Versions are newest first, as in /api/pages/:id.
  const [pages, versions] = await Promise.all([listPages(c.env.DB), listAllVersionSummaries(c.env.DB)]);
  const byPage = new Map<string, VersionSummary[]>();
  for (const version of versions) {
    const list = byPage.get(version.page_id);
    if (list) list.push(version);
    else byPage.set(version.page_id, [version]);
  }

  return c.json({
    generated_at: new Date().toISOString(),
    pages: pages.map((page) => ({
      ...pageToJson(page),
      versions: (byPage.get(page.id) ?? []).map((v) => ({
        id: v.id,
        captured_at: v.captured_at,
        is_baseline: v.is_baseline === 1,
        summary: v.judgment_summary,
        ...objectUrls(c.env, v),
        facts: parseFacts(v.facts_json),
        capture_status: v.capture_status,
      })),
    })),
  });
});

// --- Stats ------------------------------------------------------------------------------------

const SPEND_KINDS = Object.keys(PRICES) as SpendKind[];
const PAGE_STATUSES: readonly PageStatus[] = ["active", "paused", "failed", "expired"];

/** Money rounded to six decimals, so adding floats leaves no drift (0.1 + 0.2 is 0.3). */
const dollars = (amount: number): number => Math.round(amount * 1e6) / 1e6;

historyRouter.get("/stats", async (c) => {
  const db = c.env.DB;
  const [totals, spendRows, statusRows] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM pages) AS pages,
           (SELECT COUNT(*) FROM runs) AS runs,
           (SELECT COUNT(*) FROM versions) AS versions,
           (SELECT COUNT(*) FROM versions WHERE is_baseline = 0) AS catches,
           (SELECT COUNT(*) FROM runs WHERE noise_suppressed = 1) AS noise_suppressed,
           (SELECT COALESCE(SUM(amount_usd), 0) FROM spend) AS spend_usd`,
      )
      .first<{ pages: number; runs: number; versions: number; catches: number; noise_suppressed: number; spend_usd: number }>(),
    db.prepare("SELECT kind, SUM(amount_usd) AS usd FROM spend GROUP BY kind").all<{ kind: string; usd: number | null }>(),
    db.prepare("SELECT status, COUNT(*) AS n FROM pages GROUP BY status").all<{ status: string | null; n: number }>(),
  ]);

  const spendByKind = Object.fromEntries(SPEND_KINDS.map((kind) => [kind, 0])) as Record<SpendKind, number>;
  for (const row of spendRows.results) {
    if ((SPEND_KINDS as string[]).includes(row.kind)) spendByKind[row.kind as SpendKind] = dollars(row.usd ?? 0);
  }
  const monitors = Object.fromEntries(PAGE_STATUSES.map((status) => [status, 0])) as Record<PageStatus, number>;
  for (const row of statusRows.results) {
    if ((PAGE_STATUSES as readonly (string | null)[]).includes(row.status)) monitors[row.status as PageStatus] = row.n;
  }

  const spend = totals?.spend_usd ?? 0;
  const catches = totals?.catches ?? 0;
  return c.json({
    pages: totals?.pages ?? 0,
    runs: totals?.runs ?? 0,
    versions: totals?.versions ?? 0,
    noise_suppressed: totals?.noise_suppressed ?? 0,
    spend_usd: dollars(spend),
    spend_by_kind: spendByKind,
    monitors,
    // A catch is a real change, not a baseline.
    cost_per_catch_usd: catches > 0 ? dollars(spend / catches) : null,
  });
});
