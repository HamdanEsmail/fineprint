import { CAPTURE_MAX_ATTEMPTS } from "../core/limits";
import { oneLine } from "../core/summary";
import type { CaptureStatus, FactsStatus, PageKind, SummarySource, TriggerKind, VersionRow } from "./types";

/** What a caller supplies to insertVersion; the capture columns default to a fresh, uncaptured version. */
export type NewVersion = Pick<
  VersionRow,
  "id" | "page_id" | "run_id" | "is_baseline" | "captured_at" | "text" | "normalized_hash" | "judgment_summary"
> &
  Partial<
    Pick<
      VersionRow,
      | "screenshot_key"
      | "html_key"
      | "facts_json"
      | "capture_status"
      | "capture_error"
      | "capture_attempts"
      | "agent_run_id"
      | "notes"
      | "facts_status"
      | "summary"
      | "summary_source"
      | "delta_json"
      | "thumb_key"
    >
  >;

export type CapturePatch = Partial<
  Pick<
    VersionRow,
    | "screenshot_key"
    | "html_key"
    | "facts_json"
    | "capture_status"
    | "capture_error"
    | "capture_attempts"
    | "agent_run_id"
    | "facts_status"
    | "thumb_key"
  >
>;

/** A version row without its (large) page text. */
export type VersionSummary = Omit<VersionRow, "text">;

/**
 * A version with the trigger of the run that made it (create, webhook or pull): its run's
 * `trigger_kind`; a baseline whose run row is missing counts as `create`; any other version without
 * a run row has none.
 */
export type WithTrigger<T> = T & { trigger_kind: TriggerKind | null };

/** A non-baseline version joined with its page, for the changes feed. */
export type ChangeRow = WithTrigger<VersionSummary> & { page_label: string; url: string; kind: PageKind | null };

/** The `trigger_kind` column of WithTrigger, for a query over `versions` named `table`. */
function triggerColumn(table: string): string {
  return `COALESCE((SELECT r.trigger_kind FROM runs r WHERE r.id = ${table}.run_id),
    CASE WHEN ${table}.is_baseline = 1 THEN 'create' END) AS trigger_kind`;
}

// Every version column except `text`. List queries select these so a page's
// full text is never read just to draw a timeline.
const SUMMARY_COLUMNS = [
  "id",
  "page_id",
  "run_id",
  "is_baseline",
  "captured_at",
  "normalized_hash",
  "judgment_summary",
  "screenshot_key",
  "html_key",
  "facts_json",
  "capture_status",
  "capture_error",
  "capture_attempts",
  "agent_run_id",
  "notes",
  "facts_status",
  "summary",
  "summary_source",
  "delta_json",
  "thumb_key",
] as const satisfies readonly (keyof VersionSummary)[];

function summaryColumns(prefix = ""): string {
  return SUMMARY_COLUMNS.map((c) => prefix + c).join(", ");
}

// The only columns updateCapture will write (see PAGE_PATCH_COLUMNS in pages.ts).
const CAPTURE_PATCH_COLUMNS = [
  "screenshot_key",
  "html_key",
  "facts_json",
  "capture_status",
  "capture_error",
  "capture_attempts",
  "agent_run_id",
  "facts_status",
  "thumb_key",
] as const satisfies readonly (keyof CapturePatch)[];

/**
 * The summary a version is created with when the caller gives none: TinyFish's judgment summary on one
 * line (`tinyfish`) for a change whose run carried one; nothing for a baseline, or for a change without
 * one, whose diff line is filled afterwards out of band (src/summary.ts).
 */
function summaryAtInsert(v: NewVersion): { summary: string | null; summary_source: SummarySource | null } {
  if (v.summary !== undefined) return { summary: v.summary, summary_source: v.summary_source ?? null };
  const fromTinyFish = v.is_baseline === 1 ? null : oneLine(v.judgment_summary);
  return fromTinyFish === null ? { summary: null, summary_source: null } : { summary: fromTinyFish, summary_source: "tinyfish" };
}

/**
 * Inserts a version. Omitted capture fields start as NULL, `pending` and 0 attempts. An omitted
 * `facts_status` is `ok` when facts are given and `pending` otherwise; a caller that knows the page
 * does not need facts (src/capture.ts needsFacts) says `not_needed`. An omitted `summary` follows
 * summaryAtInsert.
 */
export async function insertVersion(db: D1Database, v: NewVersion): Promise<void> {
  const summary = summaryAtInsert(v);
  await db
    .prepare(
      `INSERT INTO versions
         (id, page_id, run_id, is_baseline, captured_at, text, normalized_hash, judgment_summary,
          screenshot_key, html_key, facts_json, capture_status, capture_error, capture_attempts, agent_run_id, notes,
          facts_status, summary, summary_source, delta_json, thumb_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      v.id,
      v.page_id,
      v.run_id,
      v.is_baseline,
      v.captured_at,
      v.text,
      v.normalized_hash,
      v.judgment_summary,
      v.screenshot_key ?? null,
      v.html_key ?? null,
      v.facts_json ?? null,
      v.capture_status ?? "pending",
      v.capture_error ?? null,
      v.capture_attempts ?? 0,
      v.agent_run_id ?? null,
      v.notes ?? null,
      v.facts_status ?? (v.facts_json != null ? "ok" : "pending"),
      summary.summary,
      summary.summary_source,
      v.delta_json ?? null,
      v.thumb_key ?? null,
    )
    .run();
}

/**
 * Whether the page has a version with this normalized hash captured at or after `sinceIso` (and, when
 * `untilIso` is given, at or before it, so the replay of an old run does not see later versions;
 * `exceptVersionId` leaves out the version the run itself made).
 */
export async function hasVersionWithHashSince(
  db: D1Database,
  pageId: string,
  hash: string,
  sinceIso: string,
  bounds: { untilIso?: string; exceptVersionId?: string } = {},
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM versions
       WHERE page_id = ? AND normalized_hash = ? AND captured_at >= ? AND captured_at <= ? AND id != ? LIMIT 1`,
    )
    .bind(pageId, hash, sinceIso, bounds.untilIso ?? "9999-12-31T23:59:59.999Z", bounds.exceptVersionId ?? "")
    .first();
  return row !== null;
}

/** One version with its text, or null. */
export function getVersion(db: D1Database, id: string): Promise<VersionRow | null> {
  return db.prepare("SELECT * FROM versions WHERE id = ?").bind(id).first<VersionRow>();
}

/**
 * One version of one page with its run's trigger and the page's live url, in one query: null when the
 * page or the version is unknown, or the version belongs to another page. The text is read only when
 * `withText` is set (a page view reads it only for `text=1`).
 */
export function getVersionOfPage(
  db: D1Database,
  pageId: string,
  versionId: string,
  withText: boolean,
): Promise<(WithTrigger<VersionSummary> & { text?: string; live_url: string }) | null> {
  return db
    .prepare(
      `SELECT ${summaryColumns("v.")}${withText ? ", v.text" : ""}, ${triggerColumn("v")}, p.url AS live_url
       FROM versions v JOIN pages p ON p.id = v.page_id WHERE v.id = ? AND v.page_id = ?`,
    )
    .bind(versionId, pageId)
    .first<WithTrigger<VersionSummary> & { text?: string; live_url: string }>();
}

/** The newest version of a page, with its text, or null when it has none. */
export function latestVersion(db: D1Database, pageId: string): Promise<VersionRow | null> {
  return db
    .prepare("SELECT * FROM versions WHERE page_id = ? ORDER BY captured_at DESC, rowid DESC LIMIT 1")
    .bind(pageId)
    .first<VersionRow>();
}

/**
 * The id and normalized hash of a page's newest version (same order as `latestVersion`),
 * or null when it has none. The change gate asks this first so a page's text is read
 * only when the hash alone does not settle it.
 */
export function latestVersionHash(
  db: D1Database,
  pageId: string,
): Promise<{ id: string; normalized_hash: string } | null> {
  return db
    .prepare("SELECT id, normalized_hash FROM versions WHERE page_id = ? ORDER BY captured_at DESC, rowid DESC LIMIT 1")
    .bind(pageId)
    .first<{ id: string; normalized_hash: string }>();
}

/** Rewrites a version's normalized hash (the change gate does it when the page's ignore patterns changed under it). */
export async function setVersionHash(db: D1Database, id: string, hash: string): Promise<void> {
  await db.prepare("UPDATE versions SET normalized_hash = ? WHERE id = ?").bind(hash, id).run();
}

/** Every version of a page, newest first (the baseline is last), without `text`, with its run's trigger. */
export async function listVersions(db: D1Database, pageId: string): Promise<WithTrigger<VersionSummary>[]> {
  const { results } = await db
    .prepare(
      `SELECT ${summaryColumns()}, ${triggerColumn("versions")} FROM versions WHERE page_id = ? ORDER BY captured_at DESC, rowid DESC`,
    )
    .bind(pageId)
    .all<WithTrigger<VersionSummary>>();
  return results;
}

async function findAsOf<T>(
  db: D1Database,
  pageId: string,
  atIso: string,
  columns: string,
): Promise<T | "before_baseline" | "no_versions"> {
  const hit = await db
    .prepare(
      `SELECT ${columns} FROM versions WHERE page_id = ? AND captured_at <= ? ORDER BY captured_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(pageId, atIso)
    .first<T>();
  if (hit) return hit;
  const any = await db.prepare("SELECT 1 AS found FROM versions WHERE page_id = ? LIMIT 1").bind(pageId).first();
  return any ? "before_baseline" : "no_versions";
}

/**
 * What the page said at a moment: the latest version captured at or before
 * `atIso` (the baseline counts), with its run's trigger. "before_baseline" when
 * the page has versions but all are later; "no_versions" when it has none.
 * Timestamps are ISO 8601 UTC strings from toISOString(), so they compare
 * correctly as text.
 */
export function versionAsOf(
  db: D1Database,
  pageId: string,
  atIso: string,
): Promise<WithTrigger<VersionRow> | "before_baseline" | "no_versions"> {
  return findAsOf<WithTrigger<VersionRow>>(db, pageId, atIso, `*, ${triggerColumn("versions")}`);
}

/** `versionAsOf` without the version's text, for a caller that may not need it (a cached diff). */
export function versionSummaryAsOf(
  db: D1Database,
  pageId: string,
  atIso: string,
): Promise<WithTrigger<VersionSummary> | "before_baseline" | "no_versions"> {
  return findAsOf<WithTrigger<VersionSummary>>(db, pageId, atIso, `${summaryColumns()}, ${triggerColumn("versions")}`);
}

/** The oldest version of a page (its baseline) without `text`, or null when it has none. */
export function baselineVersion(db: D1Database, pageId: string): Promise<VersionSummary | null> {
  return db
    .prepare(`SELECT ${summaryColumns()} FROM versions WHERE page_id = ? ORDER BY captured_at, rowid LIMIT 1`)
    .bind(pageId)
    .first<VersionSummary>();
}

/** How many versions of a page were captured after `afterIso` and at or before `uptoIso`. */
export async function countVersionsBetween(
  db: D1Database,
  pageId: string,
  afterIso: string,
  uptoIso: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM versions WHERE page_id = ? AND captured_at > ? AND captured_at <= ?")
    .bind(pageId, afterIso, uptoIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Every version of every page, newest first, without `text`, with its run's trigger: the export reads them in one query. */
export async function listAllVersionSummaries(db: D1Database): Promise<WithTrigger<VersionSummary>[]> {
  const { results } = await db
    .prepare(`SELECT ${summaryColumns()}, ${triggerColumn("versions")} FROM versions ORDER BY captured_at DESC, rowid DESC`)
    .all<WithTrigger<VersionSummary>>();
  return results;
}

// --- Summaries -------------------------------------------------------------------
//
// A non-baseline version without a summary is filled out of band (src/summary.ts): TinyFish's judgment
// summary when its run had one, else a line built from the diff against the version before it.

/**
 * A version still without a summary (never a baseline), with the length of its text and of the text of
 * the version before it (not the texts: a TinyFish summary needs neither, and the lengths say whether a
 * diff fits one call), and its page's ignore patterns.
 */
export type SummaryCandidate = Pick<VersionRow, "id" | "page_id" | "captured_at" | "judgment_summary"> & {
  text_length: number;
  /** 0 when there is no earlier version. */
  previous_length: number;
  ignore_patterns: string;
};

/** The version of the same page captured just before `v` (ties by insertion), as a correlated subquery's FROM and WHERE. */
export const PREVIOUS_OF_V = `FROM versions w
  WHERE w.page_id = v.page_id AND w.id != v.id
    AND (w.captured_at < v.captured_at OR (w.captured_at = v.captured_at AND w.rowid < v.rowid))
  ORDER BY w.captured_at DESC, w.rowid DESC LIMIT 1`;

/** A version's page and the id of the version before it, without either text; null for an unknown id or a first version. */
export function previousVersionOf(db: D1Database, id: string): Promise<{ page_id: string; previous_id: string } | null> {
  return db
    .prepare(`SELECT v.page_id, p.id AS previous_id FROM versions v JOIN versions p ON p.id = (SELECT w.id ${PREVIOUS_OF_V}) WHERE v.id = ?`)
    .bind(id)
    .first<{ page_id: string; previous_id: string }>();
}

/**
 * A version over alias `t` whose stored copies are final, as SQL: its capture ended (`complete` or `failed`)
 * and no facts run is in flight for it. The same rule as isFinal in src/readModel.ts, which decides what
 * diff_cache keeps.
 */
const finalSql = (t: string): string =>
  `${t}.capture_status IN ('complete', 'failed') AND NOT (${t}.agent_run_id IS NOT NULL AND ${t}.facts_json IS NULL)`;

/**
 * Adjacent pairs (a version that is not a baseline and the one before it) whose diff the hourly job should
 * store ahead of a reader: both ends final, the newer one with its summary and its delta (so the out-of-band
 * fill is done and the diff will be kept), either text over `minChars` characters, and no stored diff yet.
 * Newest first, at most `limit`. Reads no text out (SQLite measures it).
 */
export async function diffsToWarm(db: D1Database, minChars: number, limit: number): Promise<{ id: string; previous_id: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT v.id, p.id AS previous_id
       FROM versions v JOIN versions p ON p.id = (SELECT w.id ${PREVIOUS_OF_V})
       WHERE v.is_baseline = 0 AND v.summary IS NOT NULL AND v.delta_json IS NOT NULL
         AND ${finalSql("v")} AND ${finalSql("p")}
         AND (length(v.text) > ?1 OR length(p.text) > ?1)
         AND NOT EXISTS (SELECT 1 FROM diff_cache d WHERE d.from_version_id = p.id AND d.to_version_id = v.id)
       ORDER BY v.captured_at DESC, v.rowid DESC
       LIMIT ?2`,
    )
    .bind(minChars, Math.max(0, Math.trunc(limit)) || 0)
    .all<{ id: string; previous_id: string }>();
  return results;
}

// A NULL text counts as empty here, so one bad row cannot turn a call's text budget into NaN.
const candidateSelect = (where: string): string => `SELECT v.id, v.page_id, v.captured_at, v.judgment_summary,
    COALESCE(length(v.text), 0) AS text_length,
    COALESCE((SELECT length(w.text) ${PREVIOUS_OF_V}), 0) AS previous_length,
    p.ignore_patterns
  FROM versions v JOIN pages p ON p.id = v.page_id
  WHERE v.is_baseline = 0 AND ${where}`;

const CANDIDATE_SELECT = candidateSelect("v.summary IS NULL");

/** The oldest non-baseline versions without a summary (by `captured_at`, then insertion), at most `limit`. */
export async function versionsMissingSummary(db: D1Database, limit: number): Promise<SummaryCandidate[]> {
  const { results } = await db
    .prepare(`${CANDIDATE_SELECT} ORDER BY v.captured_at, v.rowid LIMIT ?`)
    .bind(Math.max(0, Math.trunc(limit)) || 0)
    .all<SummaryCandidate>();
  return results;
}

/** Every non-baseline version without a summary whose run carried a judgment text, id and text only. */
export async function versionsWithJudgmentMissingSummary(db: D1Database): Promise<Pick<VersionRow, "id" | "judgment_summary">[]> {
  const { results } = await db
    .prepare(
      `SELECT id, judgment_summary FROM versions
       WHERE is_baseline = 0 AND summary IS NULL AND judgment_summary IS NOT NULL
       ORDER BY captured_at, rowid`,
    )
    .all<Pick<VersionRow, "id" | "judgment_summary">>();
  return results;
}

/**
 * Stores TinyFish summaries for many versions in one statement (the free plan allows 50 D1 queries an
 * invocation, so not one each), never replacing a stored summary. Returns how many were written.
 */
export async function setTinyFishSummaries(db: D1Database, summaries: { id: string; summary: string }[]): Promise<number> {
  if (summaries.length === 0) return 0;
  const result = await db
    .prepare(
      `UPDATE versions
       SET summary = (SELECT json_extract(j.value, '$.summary') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = versions.id),
           summary_source = 'tinyfish'
       WHERE summary IS NULL AND id IN (SELECT json_extract(j.value, '$.id') FROM json_each(?1) j)`,
    )
    .bind(JSON.stringify(summaries))
    .run();
  return result.meta.changes;
}

/** One version, if it is a non-baseline version without a summary; else null. */
export function versionMissingSummary(db: D1Database, id: string): Promise<SummaryCandidate | null> {
  return db.prepare(`${CANDIDATE_SELECT} AND v.id = ?`).bind(id).first<SummaryCandidate>();
}

/** How many non-baseline versions have no summary yet. */
export async function countMissingSummaries(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM versions WHERE is_baseline = 0 AND summary IS NULL")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * One version with its text, and the id, text and stored facts of the version of the same page captured
 * just before it (ties by insertion), in one query: what a diff of the version needs. The previous_*
 * fields are null when there is no earlier version. Null for an unknown id.
 */
export type VersionWithPrevious = VersionRow & {
  previous_id: string | null;
  previous_text: string | null;
  previous_facts_json: string | null;
};

export function versionWithPrevious(db: D1Database, id: string): Promise<VersionWithPrevious | null> {
  return db
    .prepare(
      `SELECT v.*, p.id AS previous_id, p.text AS previous_text, p.facts_json AS previous_facts_json
       FROM versions v LEFT JOIN versions p ON p.id = (SELECT w.id ${PREVIOUS_OF_V})
       WHERE v.id = ?`,
    )
    .bind(id)
    .first<VersionWithPrevious>();
}

/** Stores a version's summary unless it already has one; true when it was written. */
export async function setSummaryIfMissing(db: D1Database, id: string, summary: string, source: SummarySource): Promise<boolean> {
  const result = await db
    .prepare("UPDATE versions SET summary = ?, summary_source = ? WHERE id = ? AND summary IS NULL")
    .bind(summary, source, id)
    .run();
  return result.meta.changes === 1;
}

// --- Deltas ----------------------------------------------------------------------
//
// A non-baseline version's delta (src/core/diff.ts Delta) is computed out of band with its diff summary
// (src/summary.ts). The delta fill takes the versions that already have a summary; a version without one
// is the summary fill's, which writes both.

/**
 * Stores a version's delta while it has none; true when it was written. With `rebuiltSummary`, a diff
 * summary is rewritten in the same statement (the one-off rebuild under the summary line rule: each
 * version gets its delta once, so each diff summary is rebuilt once); a TinyFish summary is never
 * touched. A rewritten summary drops the cached diffs that end at the version, in the same batch: they
 * carry the old line.
 */
export async function setDeltaOnce(db: D1Database, id: string, deltaJson: string, rebuiltSummary: string | null): Promise<boolean> {
  const update = db
    .prepare(
      `UPDATE versions
       SET delta_json = ?1,
           summary = CASE WHEN summary_source = 'diff' AND ?2 IS NOT NULL THEN ?2 ELSE summary END
       WHERE id = ?3 AND delta_json IS NULL`,
    )
    .bind(deltaJson, rebuiltSummary, id);
  if (rebuiltSummary === null) return (await update.run()).meta.changes === 1;
  const [written] = await db.batch([update, db.prepare("DELETE FROM diff_cache WHERE to_version_id = ?").bind(id)]);
  return written!.meta.changes === 1;
}

const DELTA_CANDIDATE_SELECT = candidateSelect("v.delta_json IS NULL AND v.summary IS NOT NULL");

/** The oldest non-baseline versions with a summary and no delta, at most `limit`, listed as summary candidates are. */
export async function versionsMissingDelta(db: D1Database, limit: number): Promise<SummaryCandidate[]> {
  const { results } = await db
    .prepare(`${DELTA_CANDIDATE_SELECT} ORDER BY v.captured_at, v.rowid LIMIT ?`)
    .bind(Math.max(0, Math.trunc(limit)) || 0)
    .all<SummaryCandidate>();
  return results;
}

/** One version, if it is a non-baseline version without a delta (with or without a summary); else null. */
export function versionMissingDelta(db: D1Database, id: string): Promise<SummaryCandidate | null> {
  return db.prepare(`${candidateSelect("v.delta_json IS NULL")} AND v.id = ?`).bind(id).first<SummaryCandidate>();
}

/** How many non-baseline versions have no delta yet (with or without a summary). */
export async function countMissingDeltas(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM versions WHERE is_baseline = 0 AND delta_json IS NULL")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// A delta whose facts part is still null while this version and the one before it both have stored facts
// now (facts land minutes after the version). No text is read.
const FACTS_DELTA_FROM = `FROM versions v JOIN versions p ON p.id = (SELECT w.id ${PREVIOUS_OF_V})`;
const FACTS_DELTA_WHERE = `v.is_baseline = 0 AND v.delta_json IS NOT NULL AND json_valid(v.delta_json)
    AND json_type(v.delta_json, '$.facts') = 'null'
    AND v.facts_json IS NOT NULL AND p.facts_json IS NOT NULL`;

export type FactsDeltaCandidate = { id: string; delta_json: string; facts_json: string; previous_facts_json: string };

/** The oldest deltas whose facts part can be filled now, at most `limit`. */
export async function factsDeltaCandidates(db: D1Database, limit: number): Promise<FactsDeltaCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT v.id, v.delta_json, v.facts_json, p.facts_json AS previous_facts_json ${FACTS_DELTA_FROM}
       WHERE ${FACTS_DELTA_WHERE} ORDER BY v.captured_at, v.rowid LIMIT ?`,
    )
    .bind(Math.max(0, Math.trunc(limit)) || 0)
    .all<FactsDeltaCandidate>();
  return results;
}

/** How many deltas have a facts part that can be filled now. */
export async function countFactsDeltas(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n ${FACTS_DELTA_FROM} WHERE ${FACTS_DELTA_WHERE}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Rewrites many deltas in one statement (the free plan allows 50 D1 queries an invocation), each only
 * while its stored delta is still the one it was computed from. Returns how many were written.
 */
export async function replaceDeltas(db: D1Database, rows: { id: string; from: string; to: string }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await db
    .prepare(
      `UPDATE versions
       SET delta_json = (SELECT json_extract(j.value, '$.to') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = versions.id)
       WHERE EXISTS (SELECT 1 FROM json_each(?1) j
                     WHERE json_extract(j.value, '$.id') = versions.id AND json_extract(j.value, '$.from') = versions.delta_json)`,
    )
    .bind(JSON.stringify(rows))
    .run();
  return result.meta.changes;
}

// --- Thumbnails --------------------------------------------------------------------

/** Versions with a stored screenshot and no thumbnail, newest first (the feed shows those first), ids only. */
export async function versionsWithoutThumb(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM versions WHERE screenshot_key IS NOT NULL AND thumb_key IS NULL
       ORDER BY captured_at DESC, rowid DESC LIMIT ?`,
    )
    .bind(Math.max(0, Math.trunc(limit)) || 0)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** How many versions have a stored screenshot and no thumbnail. */
export async function countVersionsWithoutThumb(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM versions WHERE screenshot_key IS NOT NULL AND thumb_key IS NULL")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Records a version's thumbnail key unless it has one; true when it was written. */
export async function setThumbKey(db: D1Database, id: string, key: string): Promise<boolean> {
  const result = await db.prepare("UPDATE versions SET thumb_key = ? WHERE id = ? AND thumb_key IS NULL").bind(key, id).run();
  return result.meta.changes === 1;
}

/**
 * A version's layout-only label as SQL over `versions v`, read from its stored delta: 1 when labelled, 0
 * when not, when it has no delta yet, or when the stored delta cannot be read.
 */
export const LAYOUT_ONLY_SQL = "COALESCE(CASE WHEN json_valid(v.delta_json) THEN json_extract(v.delta_json, '$.layout_only') END, 0)";

/** A page that is not retired, as SQL over `pages p` (a page whose status is NULL is not retired). */
export const NOT_RETIRED_SQL = "(p.status IS NULL OR p.status != 'retired')";

/**
 * Which real changes a feed query covers; see listChanges. `excludeLayoutOnly` leaves out the changes
 * labelled layout only (the home screen's count, which agrees with Stats.changes); the feed keeps them.
 * `onlyLayoutOnly` keeps nothing but them (the About screen's one linked example).
 */
export type ChangeFilter = {
  sinceIso?: string | null;
  beforeIso?: string | null;
  includeRetired?: boolean;
  excludeLayoutOnly?: boolean;
  onlyLayoutOnly?: boolean;
};

/**
 * The WHERE clause shared by listChanges and countChanges, over `versions v JOIN pages p`. A page
 * whose status is NULL is not retired, so it stays in when retired pages are left out.
 */
function changeWhere(filter: ChangeFilter): { where: string; binds: unknown[] } {
  const where = ["v.is_baseline = 0"];
  const binds: unknown[] = [];
  if (filter.sinceIso != null) {
    where.push("v.captured_at >= ?");
    binds.push(filter.sinceIso);
  }
  if (filter.beforeIso != null) {
    where.push("v.captured_at < ?");
    binds.push(filter.beforeIso);
  }
  if (filter.includeRetired === false) where.push(NOT_RETIRED_SQL);
  if (filter.excludeLayoutOnly === true) where.push(`${LAYOUT_ONLY_SQL} = 0`);
  if (filter.onlyLayoutOnly === true) where.push(`${LAYOUT_ONLY_SQL} = 1`);
  return { where: where.join(" AND "), binds };
}

/**
 * Real changes across all pages: non-baseline versions, newest first,
 * captured at or after `sinceIso` when given and strictly before `beforeIso`
 * when given, joined with the page's label, url and kind and the run's trigger.
 * Retired pages are included unless `includeRetired` is false. Never selects
 * `text`. A limit below 1 (or NaN) returns nothing; it never becomes SQLite's
 * "no limit".
 */
export async function listChanges(
  db: D1Database,
  sinceIso: string | null,
  limit: number,
  opts: Omit<ChangeFilter, "sinceIso"> = {},
): Promise<ChangeRow[]> {
  const max = Math.max(0, Math.trunc(limit)) || 0;
  const { where, binds } = changeWhere({ ...opts, sinceIso });
  const { results } = await db
    .prepare(
      `SELECT ${summaryColumns("v.")}, ${triggerColumn("v")}, p.label AS page_label, p.url AS url, p.kind AS kind
       FROM versions v JOIN pages p ON p.id = v.page_id
       WHERE ${where}
       ORDER BY v.captured_at DESC, v.rowid DESC LIMIT ?`,
    )
    .bind(...binds, max)
    .all<ChangeRow>();
  return results;
}

/** How many real changes listChanges would find with no limit: one COUNT, no rows read out. */
export async function countChanges(db: D1Database, filter: ChangeFilter): Promise<number> {
  const { where, binds } = changeWhere(filter);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM versions v JOIN pages p ON p.id = v.page_id WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Versions the repair cron should retry: `pending` or `partial`, captured at or
 * before `olderThanIso`, with fewer than `maxAttempts` attempts, oldest first,
 * without `text`, at most `limit` of them when it is given. Versions in
 * `awaiting_facts` are never returned: a facts queue owns them, and counting a
 * wait for the Agent callback as a failed attempt would mark them failed. Nor are
 * versions of an expired or retired page: its recording has ended.
 */
export async function pendingCaptures(
  db: D1Database,
  olderThanIso: string,
  maxAttempts: number,
  limit?: number,
): Promise<VersionSummary[]> {
  const sql = `SELECT ${summaryColumns()} FROM versions
       WHERE capture_status IN ('pending', 'partial')
         AND capture_attempts < ?
         AND captured_at <= ?
         AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = versions.page_id AND p.status IN ('expired', 'retired'))
       ORDER BY captured_at, rowid`;
  const statement =
    limit === undefined
      ? db.prepare(sql).bind(maxAttempts, olderThanIso)
      : db.prepare(`${sql} LIMIT ?`).bind(maxAttempts, olderThanIso, Math.max(0, Math.trunc(limit)) || 0);
  const { results } = await statement.all<VersionSummary>();
  return results;
}

/** Sets the capture columns present in `patch` (undefined is skipped, null sets NULL). An empty patch does nothing. */
export async function updateCapture(db: D1Database, id: string, patch: CapturePatch): Promise<void> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const column of CAPTURE_PATCH_COLUMNS) {
    const value = patch[column];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return;
  await db
    .prepare(`UPDATE versions SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values, id)
    .run();
}

/** The version whose facts run has this Agent run id, or null. */
export function getVersionByAgentRunId(db: D1Database, runId: string): Promise<VersionRow | null> {
  return db.prepare("SELECT * FROM versions WHERE agent_run_id = ?").bind(runId).first<VersionRow>();
}

/**
 * Adds one capture attempt in SQL (never a read-modify-write, so parallel attempts are all
 * counted) and returns the row as written, or null for an unknown id.
 */
export function addCaptureAttempt(db: D1Database, id: string): Promise<VersionRow | null> {
  return db
    .prepare("UPDATE versions SET capture_attempts = capture_attempts + 1 WHERE id = ? RETURNING *")
    .bind(id)
    .first<VersionRow>();
}

/**
 * Writes `patch` to a version, and adds `addAttempts` to `capture_attempts` in SQL, only
 * while the version's `agent_run_id` is still `holder` (the claim token or run id the caller
 * holds the facts slot with). Returns the row as written, or null when the version no longer
 * holds `holder` and nothing was written: a second settlement of the same run, or a claim
 * that was released and taken again, can then never clear or count someone else's run.
 */
export async function updateIfFactsHolder(
  db: D1Database,
  id: string,
  holder: string,
  patch: Omit<CapturePatch, "capture_attempts">,
  addAttempts = 0,
): Promise<VersionRow | null> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const column of CAPTURE_PATCH_COLUMNS) {
    if (column === "capture_attempts") continue;
    const value = patch[column];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  sets.push("capture_attempts = capture_attempts + ?");
  values.push(addAttempts);
  return db
    .prepare(`UPDATE versions SET ${sets.join(", ")} WHERE id = ? AND agent_run_id = ? RETURNING *`)
    .bind(...values, id, holder)
    .first<VersionRow>();
}

/**
 * Sets a version's status and error only if the columns the status rule reads (both keys,
 * the facts and the attempt count) are still what `seen` holds: a compare-and-set, so a
 * status worked out from an older read never overwrites a newer state. False when another
 * write changed them in between (that writer settles the status itself).
 */
export async function setCaptureStatusIfUnchanged(
  db: D1Database,
  seen: Pick<VersionRow, "id" | "screenshot_key" | "html_key" | "facts_json" | "capture_attempts">,
  status: CaptureStatus,
  error: string | null,
  factsStatus: FactsStatus,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE versions SET capture_status = ?, capture_error = ?, facts_status = ?
       WHERE id = ? AND screenshot_key IS ? AND html_key IS ? AND facts_json IS ? AND capture_attempts = ?`,
    )
    .bind(status, error, factsStatus, seen.id, seen.screenshot_key, seen.html_key, seen.facts_json, seen.capture_attempts)
    .run();
  return result.meta.changes === 1;
}

// --- The facts queue -------------------------------------------------------------
//
// Fineprint keeps at most one TinyAgent run in flight. A version holds the slot while
// its `agent_run_id` is set and its `facts_json` is not: first a `claim:<iso>` token,
// then the real run id. Stored facts free the slot (the run id stays as the record of
// the run); a failed run clears `agent_run_id`.

/**
 * Takes the single facts slot for a version, in one statement: true when the version
 * had no run and no facts and no other version holds the slot, and now holds `token`
 * in `agent_run_id`. Parallel claims cannot both win.
 */
export async function claimFactsSlot(db: D1Database, versionId: string, token: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE versions SET agent_run_id = ?1
       WHERE id = ?2 AND agent_run_id IS NULL AND facts_json IS NULL
         AND NOT EXISTS (SELECT 1 FROM versions WHERE agent_run_id IS NOT NULL AND facts_json IS NULL)`,
    )
    .bind(token, versionId)
    .run();
  return result.meta.changes === 1;
}

/**
 * Every version that holds a `claim:<iso>` token in `agent_run_id`, whatever its status (a
 * start that may have created a run keeps its claim even after it used the last attempt),
 * oldest first. The cron releases the stale ones.
 */
export async function listFactsClaims(db: D1Database): Promise<{ id: string; agent_run_id: string }[]> {
  const { results } = await db
    .prepare("SELECT id, agent_run_id FROM versions WHERE agent_run_id LIKE 'claim:%' ORDER BY captured_at, rowid")
    .all<{ id: string; agent_run_id: string }>();
  return results;
}

/** A version with a facts run in flight. */
export type InFlightRun = VersionSummary & { agent_run_id: string };

/**
 * Versions with a facts run in flight: a real run id (not a claim token) and no facts yet,
 * captured at or before `olderThanIso`, oldest first, without `text`. Selected by the run
 * id, never by `capture_status`: a version can hold the slot while it is `partial` or even
 * `failed`.
 */
export async function inFlightFactsRuns(db: D1Database, olderThanIso: string): Promise<InFlightRun[]> {
  const { results } = await db
    .prepare(
      `SELECT ${summaryColumns()} FROM versions
       WHERE agent_run_id IS NOT NULL
         AND agent_run_id NOT LIKE 'claim:%'
         AND facts_json IS NULL
         AND captured_at <= ?
       ORDER BY captured_at, rowid`,
    )
    .bind(olderThanIso)
    .all<InFlightRun>();
  return results;
}

/** A version waiting in the facts queue, with its page's url. */
export type FactsCandidate = VersionSummary & { url: string };

/**
 * The oldest version (by `captured_at`) that is waiting for a facts run: its page is
 * `pricing` or `fees`, not added by a public visitor (src/capture.ts needsFacts) and not expired or
 * retired, it has no facts and no run, it is not `failed`, its
 * facts are not settled as `unavailable` (a facts run that completed with an empty list is final), it
 * has attempts left, and it is a baseline or its run was not judged irrelevant (a judgment
 * of NULL, or no run at all, counts as relevant). Null when the queue is empty.
 */
export function nextFactsCandidate(
  db: D1Database,
  maxAttempts: number = CAPTURE_MAX_ATTEMPTS,
): Promise<FactsCandidate | null> {
  return db
    .prepare(
      `SELECT ${summaryColumns("v.")}, p.url AS url
       FROM versions v
       JOIN pages p ON p.id = v.page_id
       LEFT JOIN runs r ON r.id = v.run_id
       WHERE p.kind IN ('pricing', 'fees')
         AND COALESCE(p.added_by, '') != 'public'
         AND p.status NOT IN ('expired', 'retired')
         AND v.facts_json IS NULL
         AND v.agent_run_id IS NULL
         AND v.capture_status != 'failed'
         AND COALESCE(v.facts_status, '') != 'unavailable'
         AND v.capture_attempts < ?
         AND (v.is_baseline = 1 OR r.judgment_relevant IS NULL OR r.judgment_relevant != 0)
       ORDER BY v.captured_at, v.rowid
       LIMIT 1`,
    )
    .bind(maxAttempts)
    .first<FactsCandidate>();
}
