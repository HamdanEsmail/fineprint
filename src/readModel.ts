// The read side shared by the JSON API and the site: one function per public shape, so a screen and
// the endpoint behind the same data can never disagree. The JSON handlers in src/handlers call these
// and serialize what they return; the site's views render it.
//
// Nothing here reads a version's `text`: the free plan's 10 ms of CPU a request has no room for it.
import type { Delta } from "./core/diff";
import { FACTS_PAUSE_USD, PUBLIC_SLOTS, SPEND_PAUSE_USD } from "./core/limits";
import { PRICES, type SpendKind } from "./core/spend";
import { publicSlotUsage } from "./db/pages";
import { countNoiseByReason, countRunsByTrigger } from "./db/runs";
import type { FactsStatus, PageKind, PageStatus, SummarySource, TriggerKind } from "./db/types";
import { countChanges as countChangeRows, listChanges as listChangeRows } from "./db/versions";
import type { Env } from "./env";
import { objectUrls, parseDelta, thumbUrl } from "./handlers/versionJson";

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
 * unless `includeRetired` is false.
 */
export async function listChanges(
  env: Env,
  opts: { since?: string; before?: string; limit: number; includeRetired?: boolean },
): Promise<ChangeItem[]> {
  const rows = await listChangeRows(env.DB, opts.since ?? null, opts.limit, {
    beforeIso: opts.before ?? null,
    includeRetired: opts.includeRetired ?? true,
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
 * Retired pages are in unless `includeRetired` is false.
 */
export function countChanges(env: Env, opts: { since?: string; includeRetired?: boolean }): Promise<number> {
  return countChangeRows(env.DB, { sinceIso: opts.since ?? null, includeRetired: opts.includeRetired ?? true });
}

/** How many retired pages hold at least one real change: their record is kept, out of the feed. */
export async function countRetiredPagesWithChanges(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pages p
     WHERE p.status = 'retired' AND EXISTS (SELECT 1 FROM versions v WHERE v.page_id = p.id AND v.is_baseline = 0)`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
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

// A version's layout-only label, read from its stored delta; 0 when it has no delta (or one that cannot be read).
const LAYOUT_ONLY = "COALESCE(CASE WHEN json_valid(v.delta_json) THEN json_extract(v.delta_json, '$.layout_only') END, 0)";
const NOT_RETIRED = "(p.status IS NULL OR p.status != 'retired')";

export async function getStats(env: Env): Promise<Stats> {
  const db = env.DB;
  const [totals, spendRows, statusRows, runsByTrigger, noiseReasons, slots] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM pages) AS pages,
           (SELECT COUNT(*) FROM runs) AS runs,
           (SELECT COUNT(*) FROM versions) AS versions,
           (SELECT COUNT(*) FROM versions WHERE is_baseline = 0) AS catches,
           (SELECT COUNT(*) FROM versions v JOIN pages p ON p.id = v.page_id
              WHERE v.is_baseline = 0 AND ${NOT_RETIRED} AND ${LAYOUT_ONLY} = 0) AS changes,
           (SELECT COUNT(*) FROM versions v JOIN pages p ON p.id = v.page_id
              WHERE v.is_baseline = 0 AND ${NOT_RETIRED} AND ${LAYOUT_ONLY} = 1) AS layout_only,
           (SELECT MIN(created_at) FROM pages) AS recording_since,
           (SELECT COUNT(*) FROM runs WHERE noise_suppressed = 1) AS noise_suppressed,
           (SELECT COUNT(*) FROM versions WHERE facts_status = 'unavailable') AS facts_unavailable,
           (SELECT COALESCE(SUM(amount_usd), 0) FROM spend) AS spend_usd`,
      )
      .first<{
        pages: number;
        runs: number;
        versions: number;
        catches: number;
        changes: number;
        layout_only: number;
        recording_since: string | null;
        noise_suppressed: number;
        facts_unavailable: number;
        spend_usd: number;
      }>(),
    db.prepare("SELECT kind, SUM(amount_usd) AS usd FROM spend GROUP BY kind").all<{ kind: string; usd: number | null }>(),
    db.prepare("SELECT status, COUNT(*) AS n FROM pages GROUP BY status").all<{ status: string | null; n: number }>(),
    countRunsByTrigger(db),
    countNoiseByReason(db),
    publicSlotUsage(db),
  ]);

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
