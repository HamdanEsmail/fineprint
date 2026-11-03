import { CAPTURE_MAX_ATTEMPTS } from "../core/limits";
import type { VersionRow } from "./types";

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
  >
>;

/** A version row without its (large) page text. */
export type VersionSummary = Omit<VersionRow, "text">;

/** A non-baseline version joined with its page, for the changes feed. */
export type ChangeRow = VersionSummary & { page_label: string; url: string };

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
] as const satisfies readonly (keyof CapturePatch)[];

/** Inserts a version. Omitted capture fields start as NULL, `pending` and 0 attempts. */
export async function insertVersion(db: D1Database, v: NewVersion): Promise<void> {
  await db
    .prepare(
      `INSERT INTO versions
         (id, page_id, run_id, is_baseline, captured_at, text, normalized_hash, judgment_summary,
          screenshot_key, html_key, facts_json, capture_status, capture_error, capture_attempts, agent_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run();
}

/** One version with its text, or null. */
export function getVersion(db: D1Database, id: string): Promise<VersionRow | null> {
  return db.prepare("SELECT * FROM versions WHERE id = ?").bind(id).first<VersionRow>();
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

/** Every version of a page, newest first (the baseline is last), without `text`. */
export async function listVersions(db: D1Database, pageId: string): Promise<VersionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT ${summaryColumns()} FROM versions WHERE page_id = ? ORDER BY captured_at DESC, rowid DESC`,
    )
    .bind(pageId)
    .all<VersionSummary>();
  return results;
}

/**
 * What the page said at a moment: the latest version captured at or before
 * `atIso` (the baseline counts). "before_baseline" when the page has versions
 * but all are later; "no_versions" when it has none. Timestamps are ISO 8601
 * UTC strings from toISOString(), so they compare correctly as text.
 */
export async function versionAsOf(
  db: D1Database,
  pageId: string,
  atIso: string,
): Promise<VersionRow | "before_baseline" | "no_versions"> {
  const hit = await db
    .prepare(
      "SELECT * FROM versions WHERE page_id = ? AND captured_at <= ? ORDER BY captured_at DESC, rowid DESC LIMIT 1",
    )
    .bind(pageId, atIso)
    .first<VersionRow>();
  if (hit) return hit;
  const any = await db.prepare("SELECT 1 AS found FROM versions WHERE page_id = ? LIMIT 1").bind(pageId).first();
  return any ? "before_baseline" : "no_versions";
}

/**
 * Real changes across all pages: non-baseline versions, newest first,
 * captured at or after `sinceIso` when given, joined with the page's label and
 * url. Never selects `text`. A limit below 1 (or NaN) returns nothing; it never
 * becomes SQLite's "no limit".
 */
export async function listChanges(
  db: D1Database,
  sinceIso: string | null,
  limit: number,
): Promise<ChangeRow[]> {
  const max = Math.max(0, Math.trunc(limit)) || 0;
  const select = `SELECT ${summaryColumns("v.")}, p.label AS page_label, p.url AS url
       FROM versions v JOIN pages p ON p.id = v.page_id`;
  const order = "ORDER BY v.captured_at DESC, v.rowid DESC LIMIT ?";
  const statement =
    sinceIso === null
      ? db.prepare(`${select} WHERE v.is_baseline = 0 ${order}`).bind(max)
      : db.prepare(`${select} WHERE v.is_baseline = 0 AND v.captured_at >= ? ${order}`).bind(sinceIso, max);
  const { results } = await statement.all<ChangeRow>();
  return results;
}

/**
 * Versions the repair cron should retry: `pending` or `partial`, captured at or
 * before `olderThanIso`, with fewer than `maxAttempts` attempts, oldest first,
 * without `text`. Versions in `awaiting_facts` are never returned: a facts
 * queue owns them, and counting a wait for the Agent callback as a failed
 * attempt would mark them failed.
 */
export async function pendingCaptures(
  db: D1Database,
  olderThanIso: string,
  maxAttempts: number,
): Promise<VersionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT ${summaryColumns()} FROM versions
       WHERE capture_status IN ('pending', 'partial')
         AND capture_attempts < ?
         AND captured_at <= ?
       ORDER BY captured_at, rowid`,
    )
    .bind(maxAttempts, olderThanIso)
    .all<VersionSummary>();
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

/** A version waiting in the facts queue, with its page's url. */
export type FactsCandidate = VersionSummary & { url: string };

/**
 * The oldest version (by `captured_at`) that is waiting for a facts run: its page is
 * `pricing` or `fees`, it has no facts and no run, it is not `failed`, it has attempts
 * left, and it is a baseline or its run was not judged irrelevant (a judgment of NULL,
 * or no run at all, counts as relevant). Null when the queue is empty.
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
         AND v.facts_json IS NULL
         AND v.agent_run_id IS NULL
         AND v.capture_status != 'failed'
         AND v.capture_attempts < ?
         AND (v.is_baseline = 1 OR r.judgment_relevant IS NULL OR r.judgment_relevant != 0)
       ORDER BY v.captured_at, v.rowid
       LIMIT 1`,
    )
    .bind(maxAttempts)
    .first<FactsCandidate>();
}
