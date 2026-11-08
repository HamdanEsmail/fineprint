// The read side shared by the JSON API and the site: one function per public shape, so a screen and
// the endpoint behind the same data can never disagree. The JSON handlers in src/handlers call these
// and serialize what they return; the site's views render it.
//
// Nothing here reads a version's `text` unless the caller asks for it by name (getVersion and
// getVersionAsOf, for the JSON version endpoints and the page view's `text=1`): the free plan's 10 ms of
// CPU a request has no room for it.
import { factsDiff, structuredDiff, type Delta, type FactsDiff, type StructuredDiff } from "./core/diff";
import { FACTS_PAUSE_USD, PUBLIC_SLOTS, SPEND_PAUSE_USD } from "./core/limits";
import { normalize } from "./core/normalize";
import { PRICES, type SpendKind } from "./core/spend";
import { getCachedDiff, hasCachedDiff, putCachedDiff } from "./db/diffCache";
import { getPage, getPageWithNoiseCount, listPages as listPageRows, publicSlotUsageFrom, publicSlotUsageStatement, type PageListRow } from "./db/pages";
import {
  countNoiseBetween,
  noiseByReasonFrom,
  noiseByReasonStatement,
  runsByTriggerFrom,
  runsByTriggerStatement,
  runsOfPageStatement,
  type PageRunRow,
} from "./db/runs";
import type { CaptureStatus, FactsStatus, PageKind, PageRow, PageStatus, SummarySource, TriggerKind } from "./db/types";
import {
  baselineVersion,
  countChanges as countChangeRows,
  countChangesStatement,
  countVersionsBetween,
  getVersion as getVersionRow,
  getVersionOfPage,
  LAYOUT_ONLY_SQL,
  listChanges as listChangeRows,
  listVersions,
  NOT_RETIRED_SQL,
  PREVIOUS_OF_V,
  previousVersionOf,
  versionAsOf,
  versionsOfPageStatement,
  type ChangeFilter,
  type VersionSummary,
  type WithTrigger,
} from "./db/versions";
import type { Env } from "./env";
import { objectUrls, parseDelta, parseFacts, thumbUrl, versionJson, versionSummaryJson } from "./handlers/versionJson";

// --- Times ------------------------------------------------------------------------------------

/**
 * A time parameter as the ISO string the database stores, or null when it is missing or not a
 * date. Stored times come from toISOString() (millisecond precision, a "Z", four-digit years), so
 * a parameter is converted the same way before it is compared as text. Left as typed,
 * "2026-11-02T09:15:00Z" would sort after "2026-11-02T09:15:00.123Z" ("Z" is above "."), and a
 * version captured 123 ms after that moment would be taken as already in force; converted, it is
 * "2026-11-02T09:15:00.000Z" and the version is correctly later. "2026-11-02T12:15:00+03:00"
 * becomes the same instant. A year outside 0000 to 9999 has no four-digit form and would not
 * sort as text, so it is refused.
 */
export function parseTime(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  return /^\d{4}-/.test(iso) ? iso : null;
}

// --- Change feed ------------------------------------------------------------------------------

/**
 * One real change (a version that is not a baseline), as `/api/changes` lists it: with the page's `kind`,
 * the change's `delta` (null until it is computed out of band) and its thumbnail beside the screenshot.
 */
export type ChangeItem = {
  version_id: string;
  page_id: string;
  page_label: string;
  url: string;
  captured_at: string;
  summary: string | null;
  summary_source: SummarySource | null;
  screenshot_url: string | null;
  trigger: TriggerKind | null;
  facts_status: FactsStatus;
  /** The page's kind; null for a page stored without one. */
  kind: PageKind | null;
  /** The change in counts against the version before it, with the layout-only label; null until computed. */
  delta: Delta | null;
  /** The 640 by 400 thumbnail, or null when there is none (show `screenshot_url` instead). */
  thumb_url: string | null;
};

/**
 * Real changes across all pages, newest first: captured at or after `since` and strictly before
 * `before` when given (both ISO, as parseTime returns them), at most `limit`. Retired pages are in
 * unless `includeRetired` is false; `layoutOnly` keeps only the changes labelled layout only.
 */
export async function listChanges(
  env: Env,
  opts: { since?: string; before?: string; limit: number; includeRetired?: boolean; layoutOnly?: boolean },
): Promise<ChangeItem[]> {
  const rows = await listChangeRows(env.DB, opts.since ?? null, opts.limit, {
    beforeIso: opts.before ?? null,
    includeRetired: opts.includeRetired ?? true,
    onlyLayoutOnly: opts.layoutOnly ?? false,
  });
  return rows.map((row) => ({
    version_id: row.id,
    page_id: row.page_id,
    page_label: row.page_label,
    url: row.url,
    captured_at: row.captured_at,
    summary: row.summary,
    summary_source: row.summary_source,
    screenshot_url: objectUrls(env, row).screenshot_url,
    trigger: row.trigger_kind,
    facts_status: row.facts_status,
    kind: row.kind,
    delta: parseDelta(row.delta_json),
    thumb_url: thumbUrl(env, row),
  }));
}

/**
 * How many real changes `listChanges` would list for `since` (inclusive) with no limit, in one COUNT.
 * Retired pages are in unless `includeRetired` is false; layout-only changes are in unless
 * `excludeLayoutOnly` is true (the home screen's count, which then agrees with Stats.changes).
 */
export function countChanges(env: Env, opts: CountOptions): Promise<number> {
  return countChangeRows(env.DB, changeFilter(opts));
}

type CountOptions = { since?: string; includeRetired?: boolean; excludeLayoutOnly?: boolean };

const changeFilter = (opts: CountOptions): ChangeFilter => ({
  sinceIso: opts.since ?? null,
  includeRetired: opts.includeRetired ?? true,
  excludeLayoutOnly: opts.excludeLayoutOnly ?? false,
});

const RETIRED_WITH_CHANGES_SQL = `SELECT COUNT(*) AS n FROM pages p
  WHERE p.status = 'retired' AND EXISTS (SELECT 1 FROM versions v WHERE v.page_id = p.id AND v.is_baseline = 0)`;

/** How many retired pages hold at least one real change: their record is kept, out of the feed. */
export async function countRetiredPagesWithChanges(env: Env): Promise<number> {
  const row = await env.DB.prepare(RETIRED_WITH_CHANGES_SQL).first<{ n: number }>();
  return row?.n ?? 0;
}

// --- The home's counts and its as-of example -----------------------------------------------------

/** A page to show "what did this page say on a date" with: its first two versions' times. */
export type AsOfExample = { page_id: string; label: string; first_at: string; second_at: string };

/**
 * The page that is not retired with the most versions (two at least, so a time between its first two has a
 * version in force that is not the newest), the newest page on a tie, with the times of its first two
 * versions. No text is read.
 */
const AS_OF_EXAMPLE_SQL = `SELECT p.id AS page_id, p.label AS label,
    (SELECT w.captured_at FROM versions w WHERE w.page_id = p.id ORDER BY w.captured_at, w.rowid LIMIT 1) AS first_at,
    (SELECT w.captured_at FROM versions w WHERE w.page_id = p.id ORDER BY w.captured_at, w.rowid LIMIT 1 OFFSET 1) AS second_at
  FROM pages p JOIN (SELECT page_id, COUNT(*) AS n FROM versions GROUP BY page_id HAVING COUNT(*) >= 2) c ON c.page_id = p.id
  WHERE ${NOT_RETIRED_SQL}
  ORDER BY c.n DESC, p.created_at DESC, p.rowid DESC
  LIMIT 1`;

/** The home's as-of example (see AS_OF_EXAMPLE_SQL), or null when no page has two versions. One query. */
export async function asOfExample(env: Env): Promise<AsOfExample | null> {
  return (await env.DB.prepare(AS_OF_EXAMPLE_SQL).first<AsOfExample>()) ?? null;
}

/** What the newest home screen reads besides the stats and the feed. */
export type HomeCounts = { weekCount: number; retiredWithChanges: number; asOf: AsOfExample | null };

/**
 * The newest home screen's three small reads, sent to D1 as one batch (one round trip): the real changes
 * since `sinceIso` (countChanges with retired pages and layout-only changes left out, so it counts what
 * Stats.changes counts), countRetiredPagesWithChanges and asOfExample, each with the same SQL as alone.
 */
export async function homeCounts(env: Env, sinceIso: string): Promise<HomeCounts> {
  const db = env.DB;
  const [week, retired, example] = await db.batch<Record<string, unknown>>([
    countChangesStatement(db, changeFilter({ since: sinceIso, includeRetired: false, excludeLayoutOnly: true })),
    db.prepare(RETIRED_WITH_CHANGES_SQL),
    db.prepare(AS_OF_EXAMPLE_SQL),
  ]);
  const n = (result: D1Result<Record<string, unknown>> | undefined): number => Number(result?.results[0]?.n ?? 0);
  return {
    weekCount: n(week),
    retiredWithChanges: n(retired),
    asOf: (example?.results[0] as AsOfExample | undefined) ?? null,
  };
}

// --- Stats ------------------------------------------------------------------------------------

const SPEND_KINDS = Object.keys(PRICES) as SpendKind[];
const PAGE_STATUSES: readonly PageStatus[] = ["active", "paused", "failed", "expired", "retired"];

/** Money rounded to six decimals, so adding floats leaves no drift (0.1 + 0.2 is 0.3). */
const dollars = (amount: number): number => Math.round(amount * 1e6) / 1e6;

/** The record so far, as `/api/stats` returns it. */
export type Stats = {
  pages: number;
  runs: number;
  versions: number;
  noise_suppressed: number;
  /** Versions whose screenshot and source are stored but whose price facts could not be taken. */
  facts_unavailable: number;
  /** Versions whose price-table run cannot start because spending on price tables is paused (`facts_status` paused). */
  facts_paused_versions: number;
  /** Versions with a full-page screenshot stored (TinyFish Browser). */
  versions_with_screenshot: number;
  /** Versions with their HTML source stored (TinyFish Fetch). */
  versions_with_source: number;
  /** Versions whose price table was read and stored (TinyFish Agent, `facts_status` ok). */
  versions_with_facts: number;
  /** Versions with a 640 by 400 thumbnail made from the screenshot. */
  thumbnails: number;
  noise_by_reason: Record<string, number>;
  spend_usd: number;
  /** No check, capture or pull starts from SPEND_PAUSE_USD on. */
  spend_paused: boolean;
  /** No facts run starts from FACTS_PAUSE_USD on. */
  facts_paused: boolean;
  spend_by_kind: Record<SpendKind, number>;
  monitors: Record<PageStatus, number>;
  /** Spend over every real change (retired pages' included), or null before the first one. */
  cost_per_catch_usd: number | null;
  /** Which way the runs arrived: the add-page baselines, scheduled runs by webhook, overdue checks pulled. */
  runs_by_trigger: Record<TriggerKind, number>;
  /** Real changes (versions that are not baselines) on pages that are not retired, leaving out layout-only ones. */
  changes: number;
  /** Changes on pages that are not retired that are labelled layout only (same words and figures, new structure). */
  layout_only: number;
  /** When the first page was added (the earliest page `created_at`); null before any page. */
  recording_since: string | null;
  /** The public add slots: how many there are, how many hold a page now, and when the next one frees (null when none is held). */
  public_slots: { total: number; used: number; next_free_at: string | null };
};

/** The record so far: six aggregates, sent to D1 as one batch (one round trip); the evidence counts are in the first. */
export async function getStats(env: Env): Promise<Stats> {
  const db = env.DB;
  const [totalsResult, spendResult, statusResult, triggerResult, noiseResult, slotsResult] = await db.batch<Record<string, unknown>>([
    db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM pages) AS pages,
           (SELECT COUNT(*) FROM runs) AS runs,
           (SELECT COUNT(*) FROM versions) AS versions,
           (SELECT COUNT(*) FROM versions WHERE is_baseline = 0) AS catches,
           (SELECT COUNT(*) FROM versions v JOIN pages p ON p.id = v.page_id
              WHERE v.is_baseline = 0 AND ${NOT_RETIRED_SQL} AND ${LAYOUT_ONLY_SQL} = 0) AS changes,
           (SELECT COUNT(*) FROM versions v JOIN pages p ON p.id = v.page_id
              WHERE v.is_baseline = 0 AND ${NOT_RETIRED_SQL} AND ${LAYOUT_ONLY_SQL} = 1) AS layout_only,
           (SELECT MIN(created_at) FROM pages) AS recording_since,
           (SELECT COUNT(*) FROM runs WHERE noise_suppressed = 1) AS noise_suppressed,
           (SELECT COUNT(*) FROM versions WHERE facts_status = 'unavailable') AS facts_unavailable,
           (SELECT COUNT(*) FROM versions WHERE facts_status = 'paused') AS facts_paused_versions,
           (SELECT COUNT(*) FROM versions WHERE screenshot_key IS NOT NULL) AS versions_with_screenshot,
           (SELECT COUNT(*) FROM versions WHERE html_key IS NOT NULL) AS versions_with_source,
           (SELECT COUNT(*) FROM versions WHERE facts_status = 'ok') AS versions_with_facts,
           (SELECT COUNT(*) FROM versions WHERE thumb_key IS NOT NULL) AS thumbnails,
           (SELECT COALESCE(SUM(amount_usd), 0) FROM spend) AS spend_usd`),
    db.prepare("SELECT kind, SUM(amount_usd) AS usd FROM spend GROUP BY kind"),
    db.prepare("SELECT status, COUNT(*) AS n FROM pages GROUP BY status"),
    runsByTriggerStatement(db),
    noiseByReasonStatement(db),
    publicSlotUsageStatement(db),
  ]);
  const totals = totalsResult?.results[0] as
    | {
        pages: number;
        runs: number;
        versions: number;
        catches: number;
        changes: number;
        layout_only: number;
        recording_since: string | null;
        noise_suppressed: number;
        facts_unavailable: number;
        facts_paused_versions: number;
        versions_with_screenshot: number;
        versions_with_source: number;
        versions_with_facts: number;
        thumbnails: number;
        spend_usd: number;
      }
    | undefined;
  const spendRows = { results: (spendResult?.results ?? []) as { kind: string; usd: number | null }[] };
  const statusRows = { results: (statusResult?.results ?? []) as { status: string | null; n: number }[] };
  const runsByTrigger = runsByTriggerFrom((triggerResult?.results ?? []) as { trigger_kind: string; n: number }[]);
  const noiseReasons = noiseByReasonFrom((noiseResult?.results ?? []) as { noise_reason: string | null; n: number }[]);
  const slots = publicSlotUsageFrom(slotsResult?.results[0] as { used: number; next_free_at: string | null } | undefined);

  const spendByKind = Object.fromEntries(SPEND_KINDS.map((kind) => [kind, 0])) as Record<SpendKind, number>;
  for (const row of spendRows.results) {
    if ((SPEND_KINDS as string[]).includes(row.kind)) spendByKind[row.kind as SpendKind] = dollars(row.usd ?? 0);
  }
  const monitors = Object.fromEntries(PAGE_STATUSES.map((status) => [status, 0])) as Record<PageStatus, number>;
  for (const row of statusRows.results) {
    if ((PAGE_STATUSES as readonly (string | null)[]).includes(row.status)) monitors[row.status as PageStatus] = row.n;
  }

  // The four reasons are always present; a reason this code does not know is counted under its own key.
  const noiseByReason: Record<string, number> = { normalized_identical: 0, partial_render: 0, flap: 0, layout_hold: 0, ...noiseReasons };

  const spend = totals?.spend_usd ?? 0;
  const catches = totals?.catches ?? 0;
  return {
    pages: totals?.pages ?? 0,
    runs: totals?.runs ?? 0,
    versions: totals?.versions ?? 0,
    noise_suppressed: totals?.noise_suppressed ?? 0,
    facts_unavailable: totals?.facts_unavailable ?? 0,
    facts_paused_versions: totals?.facts_paused_versions ?? 0,
    versions_with_screenshot: totals?.versions_with_screenshot ?? 0,
    versions_with_source: totals?.versions_with_source ?? 0,
    versions_with_facts: totals?.versions_with_facts ?? 0,
    thumbnails: totals?.thumbnails ?? 0,
    noise_by_reason: noiseByReason,
    spend_usd: dollars(spend),
    // The two pauses, read from the same total the Worker's own checks use.
    spend_paused: spend >= SPEND_PAUSE_USD,
    facts_paused: spend >= FACTS_PAUSE_USD,
    spend_by_kind: spendByKind,
    monitors,
    // A catch is a real change, not a baseline.
    cost_per_catch_usd: catches > 0 ? dollars(spend / catches) : null,
    runs_by_trigger: runsByTrigger,
    changes: totals?.changes ?? 0,
    layout_only: totals?.layout_only ?? 0,
    recording_since: totals?.recording_since ?? null,
    public_slots: { total: PUBLIC_SLOTS, used: slots.used, next_free_at: slots.next_free_at },
  };
}

// --- Pages ------------------------------------------------------------------------------------

/** A page row as the API returns it: `ignore_patterns` is an array, every other column as stored. */
export type PageJson<T extends PageRow = PageRow> = Omit<T, "ignore_patterns"> & { ignore_patterns: string[] };

function parsePatterns(stored: string): string[] {
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The one mapping from a page row to API JSON (R33). Works for a plain row and for a `listPages` row
 * (the extra count columns pass through). Exported again from src/handlers/pages.ts.
 */
export function pageToJson<T extends PageRow>(row: T): PageJson<T> {
  return { ...row, ignore_patterns: parsePatterns(row.ignore_patterns) };
}

/** A page as `GET /api/pages` lists it: its row as the API gives it, with its version count, noise count and newest version time. */
export type PageSummary = PageJson<PageListRow>;

/** Every page, ordered by when it was added, as `GET /api/pages` lists them and the watchlist shows them. One query. */
export async function listPages(env: Env): Promise<PageSummary[]> {
  return (await listPageRows(env.DB)).map(pageToJson);
}

// --- One page, one version, as-of -------------------------------------------------------------

/** The page detail answer carries at most this many of the page's runs. */
export const MAX_RUNS_SHOWN = 100;

/** A version without its text, in the shape every endpoint gives one (versionSummaryJson). */
export type VersionItem = ReturnType<typeof versionSummaryJson>;

/**
 * One run of a page. `noise_reason` says why a suppressed run made no version (normalized_identical,
 * partial_render, flap, layout_hold), or why a fetch failed (fetch_error, not counted as suppressed).
 */
export type RunItem = {
  id: string;
  monitor_run_id: string;
  trigger: TriggerKind;
  outcome: string;
  received_at: string;
  noise_suppressed: boolean;
  noise_reason: string | null;
};

/** A page as the page detail reads it first: its row as the API gives it, and how many of its runs were noise. */
export type PageHead = {
  page: PageJson;
  /** Every run of the page suppressed as noise, not only the newest MAX_RUNS_SHOWN (listPages's `noise_count`). */
  noiseCount: number;
};

/**
 * A page with its whole record, as `GET /api/pages/:id` returns it (`page`, `versions`, `runs`), plus two
 * things the JSON leaves out: `noiseCount` (the page's noise events, uncapped) and `versionByRun` (a
 * version's JSON never shows its run id): for each run that made a version, that version's id. The page
 * view's check log tells a recorded change from the rest by it.
 */
export type PageDetail = PageHead & {
  /** Every version, newest first (the baseline last), without text. */
  versions: VersionItem[];
  /** The newest MAX_RUNS_SHOWN runs, newest first. */
  runs: RunItem[];
  versionByRun: Record<string, string>;
};

/** A version with its text (null when the caller did not ask for it) and the page's live url, as versions/:vid and as-of return it. */
export type VersionDetail = ReturnType<typeof versionJson>;

/** Why an as-of time has no version: every version is later (with the baseline's time), or the page has none. */
export type AsOfMiss = { error: "before_baseline"; baseline_at: string } | { error: "no_versions" };

/**
 * The first read of a page detail: the page row with its noise count, one query; null for an unknown page.
 * A caller that has more to read (the page view's stats) starts it only once this says the page exists, so
 * a request for a page that is not there reads one row and nothing else.
 */
export async function findPage(env: Env, pageId: string): Promise<PageHead | null> {
  const row = await getPageWithNoiseCount(env.DB, pageId);
  if (!row) return null;
  const { noise_count: noiseCount, ...page } = row;
  return { page: pageToJson(page), noiseCount };
}

/**
 * The rest of a page detail for a page findPage found: its versions and its newest runs, two queries sent to D1
 * as one batch (one round trip), neither reads a text.
 */
export async function getPageRecord(env: Env, head: PageHead): Promise<PageDetail> {
  const db = env.DB;
  const [versionsResult, runsResult] = await db.batch<Record<string, unknown>>([
    versionsOfPageStatement(db, head.page.id),
    runsOfPageStatement(db, head.page.id, MAX_RUNS_SHOWN),
  ]);
  const versions = (versionsResult?.results ?? []) as unknown as WithTrigger<VersionSummary>[];
  const runs = (runsResult?.results ?? []) as unknown as PageRunRow[];
  const versionByRun: Record<string, string> = {};
  for (const v of versions) if (v.run_id !== null) versionByRun[v.run_id] = v.id;
  return {
    ...head,
    versions: versions.map((v) => versionSummaryJson(env, v)),
    runs: runs.map((r) => ({
      id: r.id,
      monitor_run_id: r.monitor_run_id,
      trigger: r.trigger_kind,
      outcome: r.outcome,
      received_at: r.received_at,
      noise_suppressed: r.noise_suppressed === 1,
      noise_reason: r.noise_reason,
    })),
    versionByRun,
  };
}

/** The page, its noise count, its versions and its newest runs; null for an unknown page (one query, then two). */
export async function getPageDetail(env: Env, pageId: string): Promise<PageDetail | null> {
  const head = await findPage(env, pageId);
  return head === null ? null : getPageRecord(env, head);
}

/**
 * One version of one page, as `GET /api/pages/:id/versions/:vid` returns it; null when the page or the
 * version is unknown or the version belongs to another page. One query; the text only with `withText`.
 */
export async function getVersion(
  env: Env,
  pageId: string,
  versionId: string,
  opts: { withText: boolean },
): Promise<VersionDetail | null> {
  const row = await getVersionOfPage(env.DB, pageId, versionId, opts.withText);
  if (!row) return null;
  return versionJson(env, row.live_url, row, opts.withText ? (row.text ?? null) : null);
}

/**
 * What a page said at `atIso` (ISO, as parseTime returns it), as `GET /api/pages/:id/as-of` returns it:
 * the latest version captured at or before it, the baseline included, with its text. An AsOfMiss when
 * there is none; null for an unknown page. (The page view resolves `at=` with versionInForce instead.)
 */
export async function getVersionAsOf(env: Env, pageId: string, atIso: string): Promise<VersionDetail | AsOfMiss | null> {
  const db = env.DB;
  const [page, hit] = await Promise.all([getPage(db, pageId), versionAsOf(db, pageId, atIso)]);
  if (!page) return null;
  if (hit === "no_versions") return { error: "no_versions" };
  if (hit === "before_baseline") {
    const baseline = await baselineVersion(db, pageId);
    return baseline ? { error: "before_baseline", baseline_at: baseline.captured_at } : { error: "no_versions" };
  }
  return versionJson(env, page.url, hit, hit.text);
}

/**
 * The version in force at `atIso` among a page's versions listed newest first (as getPageDetail lists
 * them: by captured_at, then by insertion, newest first): the first one captured at or before it, which is
 * the one versionAsOf picks with the same order in SQL. Null when every version is later. The page view
 * resolves `at=` with it from the versions it has already read, so an as-of costs no query of its own.
 */
export function versionInForce<T extends { captured_at: string }>(versionsNewestFirst: readonly T[], atIso: string): T | null {
  return versionsNewestFirst.find((v) => v.captured_at <= atIso) ?? null;
}

// --- Diff -------------------------------------------------------------------------------------
//
// The diff of two versions (spec 4.7), as GET /api/pages/:id/diff answers it, the compare view shows it and
// the home's featured catch reads one block of it. The one expensive answer: it is stored in `diff_cache`
// under the two version ids so later requests only read it. It is stored only once both versions are final
// (`complete` or `failed`, with no facts run in flight) and the `to` version's summary is filled: a version's
// text never changes, but its screenshot, source, facts and summary are filled in after it is inserted (a
// capture takes minutes, the facts queue up to an hour), so the diff of a version still being captured is
// computed again on every request and a stored one would freeze it without them. What a stored diff also
// depends on (the page's ignore patterns and label) is dropped from the cache when it is edited.

/** One end of a diff: the version, its stored copies as public urls, how it was read and its facts status. */
export type DiffEnd = {
  version_id: string;
  captured_at: string;
  screenshot_url: string | null;
  source_url: string | null;
  trigger: TriggerKind | null;
  facts_status: FactsStatus;
};

/** The diff of two versions of a page, as `GET /api/pages/:id/diff` returns it. */
export type Diff = {
  page: { id: string; url: string; label: string };
  from: DiffEnd;
  to: DiffEnd;
  /** The `to` version's one-line summary (TinyFish's, else the diff line): the latest hop's. */
  summary: string | null;
  summary_source: SummarySource | null;
  blocks: StructuredDiff;
  facts: FactsDiff | null;
  /** Versions captured in (from, to]. */
  hops: number;
  /** Runs suppressed as noise received in (from, to]. */
  noise_suppressed_between: number;
};

/**
 * How far a diff may go to answer: `maxTextChars` refuses to diff texts longer than that, `storedOnly`
 * answers only from the cache (null when the diff is not stored), so not even the texts are read.
 */
export type DiffOptions = { maxTextChars?: number; storedOnly?: boolean };

/** A version as a diff reads it: every column but the text, with its run's trigger. */
export type DiffSide = WithTrigger<VersionSummary>;

/** What a diff needs of its page: the envelope's id, url and label, and the ignore patterns the texts are normalized with. */
export type DiffPage = { id: string; url: string; label: string; ignore_patterns: string[] };

/**
 * A diff as JSON text and as an object. A stored diff is served as the text it was stored with and parsed
 * only when the object is asked for; a fresh one is serialized once, for the cache and the JSON route alike.
 */
export type DiffAnswer = { readonly json: string; readonly diff: Diff };

/**
 * True when nothing a stored diff shows of a version will change any more: its capture is terminal
 * (`complete` or `failed`) and no facts run is in flight for it (`agent_run_id` set, a run id or a claim,
 * with no facts yet: a version can hold the facts slot while `failed`, or `complete` after its attempts).
 * A `pending`, `partial` or `awaiting_facts` version is still gaining its screenshot, source or facts.
 */
const isFinal = (v: Pick<VersionSummary, "capture_status" | "agent_run_id" | "facts_json">): boolean =>
  (v.capture_status === "complete" || v.capture_status === "failed") && !(v.agent_run_id !== null && v.facts_json === null);

// A version's trigger never changes, so a stored diff keeps it. Its facts status does until the version is
// final, and a diff is stored only once both of its versions are.
const diffEnd = (env: Env, v: DiffSide): DiffEnd => ({
  version_id: v.id,
  captured_at: v.captured_at,
  ...objectUrls(env, v),
  trigger: v.trigger_kind,
  facts_status: v.facts_status,
});

/**
 * The diff of two resolved versions, or null if a version is gone or, with `maxTextChars`, either text is
 * longer than that. `hops` counts the versions captured in (from, to] and `noise_suppressed_between` the
 * suppressed runs received in the same interval. Blocks come from the normalized texts, normalized with the
 * page's current ignore patterns, as the change gate does. One version on both sides is an empty diff and
 * reads no text.
 */
async function buildDiff(env: Env, page: DiffPage, from: DiffSide, to: DiffSide, maxTextChars?: number): Promise<Diff | null> {
  let blocks: StructuredDiff = { added: [], removed: [], changed: [] };
  let hops = 0;
  let noiseBetween = 0;

  if (from.id !== to.id) {
    const db = env.DB;
    const [fromFull, toFull, hopCount, noiseCount] = await Promise.all([
      getVersionRow(db, from.id),
      getVersionRow(db, to.id),
      countVersionsBetween(db, page.id, from.captured_at, to.captured_at),
      countNoiseBetween(db, page.id, from.captured_at, to.captured_at),
    ]);
    if (!fromFull || !toFull) return null;
    if (maxTextChars !== undefined && (fromFull.text.length > maxTextChars || toFull.text.length > maxTextChars)) return null;
    blocks = structuredDiff(normalize(fromFull.text, page.ignore_patterns).text, normalize(toFull.text, page.ignore_patterns).text);
    hops = hopCount;
    noiseBetween = noiseCount;
  }

  return {
    page: { id: page.id, url: page.url, label: page.label },
    from: diffEnd(env, from),
    to: diffEnd(env, to),
    summary: to.summary,
    summary_source: to.summary_source,
    blocks,
    facts: factsDiff(parseFacts(from.facts_json), parseFacts(to.facts_json)),
    hops,
    noise_suppressed_between: noiseBetween,
  };
}

function storedAnswer(json: string): DiffAnswer {
  let parsed: Diff | undefined;
  return {
    json,
    get diff(): Diff {
      return (parsed ??= JSON.parse(json) as Diff);
    },
  };
}

function freshAnswer(diff: Diff): DiffAnswer {
  let text: string | undefined;
  return {
    diff,
    get json(): string {
      return (text ??= JSON.stringify(diff));
    },
  };
}

/**
 * The diff of two versions of a page that the caller has already read (the JSON route resolves two times to
 * them, the compare view picks them from the page's versions). `from` is the older of the two; the cache is
 * keyed by the pair in that order. A stored answer is served as it was stored (the viewer never recomputes);
 * an answer for a version still being captured is computed fresh, so it shows the screenshots and facts that
 * have arrived, and is not kept. Null when a version is gone, or when it is not stored and either
 * `storedOnly` is set or `maxTextChars` is given and either text is longer (the home's featured catch never
 * diffs a large page on its own request: the hourly job stores those, see warmDiff).
 */
export async function diffVersions(
  env: Env,
  page: DiffPage,
  from: DiffSide,
  to: DiffSide,
  opts: DiffOptions = {},
): Promise<DiffAnswer | null> {
  const db = env.DB;
  // The `to` version's summary is part of the answer, so a change whose summary is not filled yet waits too.
  const final = isFinal(from) && isFinal(to) && (to.is_baseline === 1 || to.summary !== null);
  if (final) {
    const cached = await getCachedDiff(db, from.id, to.id);
    if (cached !== null) return storedAnswer(cached);
  }

  if (opts.storedOnly === true) return null;
  const diff = await buildDiff(env, page, from, to, opts.maxTextChars);
  if (diff === null) return null;
  const answer = freshAnswer(diff);
  if (final) {
    try {
      await putCachedDiff(db, from.id, to.id, answer.json);
    } catch (err) {
      // The answer is right whether or not it could be kept; the next request computes it again.
      console.error("diff cache write failed", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
    }
  }
  return answer;
}

/**
 * The diff from one version of a page to another, by their ids (`from` the older): the page and the two
 * versions are read (three queries at once), then diffVersions. Null when the page is unknown, either
 * version is not one of its versions, or diffVersions says null.
 */
export async function getDiff(
  env: Env,
  pageId: string,
  fromVersionId: string,
  toVersionId: string,
  opts: DiffOptions = {},
): Promise<Diff | null> {
  const db = env.DB;
  const [page, from, to] = await Promise.all([
    getPage(db, pageId),
    getVersionOfPage(db, pageId, fromVersionId, false),
    getVersionOfPage(db, pageId, toVersionId, false),
  ]);
  if (!page || !from || !to) return null;
  return (await diffVersions(env, pageToJson(page), from, to, opts))?.diff ?? null;
}

/**
 * Stores the diff of a version and the one before it (`POST /api/admin/warm-diff`, which the hourly cron
 * calls for one large pair a tick, src/cron.ts): diffVersions, the same function and the same rule for what
 * is kept as every reader, run in a request of its own so the first diff of a 228 KB pair never shares a
 * reader's CPU. Null for an unknown version or one with no version before it (a baseline). `stored` says
 * whether the diff is in the cache afterwards (not when either end is still being captured).
 */
export async function warmDiff(env: Env, versionId: string): Promise<{ version_id: string; from_version_id: string; stored: boolean } | null> {
  const db = env.DB;
  const pair = await previousVersionOf(db, versionId);
  if (pair === null) return null;
  const [page, from, to] = await Promise.all([
    getPage(db, pair.page_id),
    getVersionOfPage(db, pair.page_id, pair.previous_id, false),
    getVersionOfPage(db, pair.page_id, versionId, false),
  ]);
  if (!page || !from || !to) return null;
  // The answer is not read: a stored diff is not even parsed.
  if ((await diffVersions(env, pageToJson(page), from, to)) === null) return null;
  return { version_id: to.id, from_version_id: from.id, stored: await hasCachedDiff(db, from.id, to.id) };
}

/** At most this many sections are placed by sectionPlaces (D1 binds at most 100 values a query). */
export const SECTION_PLACES_MAX = 90;

/**
 * Where each named section's heading stands in the two texts of a diff, by character position (0 when not
 * found): the compare view puts its section groups in page order with them, when the diff's own lists do not
 * settle it. One query, and the search runs in D1 (`instr`), so no text is read out: for each section, the
 * first "# {section}" that ends its line (a heading of any level), else the first that ends it after one or
 * two trailing spaces, else the first with a closing "#", else the first at all. At most SECTION_PLACES_MAX
 * sections.
 */
export async function sectionPlaces(
  env: Env,
  fromVersionId: string,
  toVersionId: string,
  sections: string[],
): Promise<Map<string, { newer: number; older: number }>> {
  const named = [...new Set(sections.filter((s) => s !== ""))].slice(0, SECTION_PLACES_MAX);
  const places = new Map<string, { newer: number; older: number }>();
  if (named.length === 0) return places;
  const columns = named.map(
    (_, k) =>
      `COALESCE(NULLIF(instr(text, ?${k + 1} || char(10)), 0), NULLIF(instr(text, ?${k + 1} || ' ' || char(10)), 0), ` +
      `NULLIF(instr(text, ?${k + 1} || '  ' || char(10)), 0), NULLIF(instr(text, ?${k + 1} || ' #'), 0), instr(text, ?${k + 1})) AS p${k}`,
  );
  const { results } = await env.DB.prepare(
    `SELECT id, ${columns.join(", ")} FROM versions WHERE id IN (?${named.length + 1}, ?${named.length + 2})`,
  )
    .bind(...named.map((s) => `# ${s}`), fromVersionId, toVersionId)
    .all<Record<string, unknown>>();
  const newer = results.find((r) => r.id === toVersionId);
  const older = results.find((r) => r.id === fromVersionId);
  const at = (row: Record<string, unknown> | undefined, k: number): number => {
    const n = Number(row?.[`p${k}`] ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  named.forEach((s, k) => places.set(s, { newer: at(newer, k), older: at(older, k) }));
  return places;
}

/**
 * A page's versions as the compare view reads them: newest first, without text, each as the diff reads it
 * (`row`) and as the API shows it (`item`). One query.
 */
export async function listVersionsForDiff(env: Env, pageId: string): Promise<{ row: DiffSide; item: VersionItem }[]> {
  const rows = await listVersions(env.DB, pageId);
  return rows.map((row) => ({ row, item: versionSummaryJson(env, row) }));
}

/** What the home's featured catch needs to know about a change before it reads its diff. */
export type FeatureCandidate = {
  /** The change (a version that is not a baseline). */
  id: string;
  capture_status: CaptureStatus;
  page_status: PageStatus | null;
  /** The version before it, the `from` of the diff. */
  from: { id: string; captured_at: string; screenshot_url: string | null; thumb_url: string | null; capture_status: CaptureStatus };
  /** The lengths of the two texts, in characters. */
  from_length: number;
  to_length: number;
  /** The length of the stored diff of the pair, or null when none is stored. */
  cached_length: number | null;
};

/**
 * For each of the given changes, the version before it, the lengths of the two texts and of the stored diff
 * of the pair, in one query that reads no text out (SQLite counts the characters). Changes without a
 * previous version, and unknown ids, are left out. At most 100 ids (D1's bound parameters).
 */
export async function featureCandidates(env: Env, versionIds: string[]): Promise<FeatureCandidate[]> {
  const ids = versionIds.slice(0, 100);
  if (ids.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.capture_status, pg.status AS page_status,
       p.id AS from_id, p.captured_at AS from_at, p.screenshot_key AS from_screenshot_key, p.html_key AS from_html_key,
       p.thumb_key AS from_thumb_key, p.capture_status AS from_capture_status,
       COALESCE(length(v.text), 0) AS to_length, COALESCE(length(p.text), 0) AS from_length,
       (SELECT length(d.json) FROM diff_cache d WHERE d.from_version_id = p.id AND d.to_version_id = v.id) AS cached_length
     FROM versions v
       JOIN versions p ON p.id = (SELECT w.id ${PREVIOUS_OF_V})
       JOIN pages pg ON pg.id = v.page_id
     WHERE v.id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all<{
      id: string;
      capture_status: CaptureStatus;
      page_status: PageStatus | null;
      from_id: string;
      from_at: string;
      from_screenshot_key: string | null;
      from_html_key: string | null;
      from_thumb_key: string | null;
      from_capture_status: CaptureStatus;
      to_length: number;
      from_length: number;
      cached_length: number | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    capture_status: r.capture_status,
    page_status: r.page_status,
    from: {
      id: r.from_id,
      captured_at: r.from_at,
      screenshot_url: objectUrls(env, { id: r.from_id, screenshot_key: r.from_screenshot_key, html_key: r.from_html_key }).screenshot_url,
      thumb_url: thumbUrl(env, { id: r.from_id, thumb_key: r.from_thumb_key }),
      capture_status: r.from_capture_status,
    },
    from_length: r.from_length,
    to_length: r.to_length,
    cached_length: r.cached_length,
  }));
}
