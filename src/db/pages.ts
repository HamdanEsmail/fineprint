import type { AddedBy, PageRow, PageStatus } from "./types";

export type NewPage = Omit<
  PageRow,
  | "created_at"
  | "last_run_at"
  | "last_change_at"
  | "pending_hash"
  | "pending_run_id"
  | "pending_at"
  | "pull_failures"
  | "pull_retry_after"
>;

export type PagePatch = Partial<
  Pick<
    PageRow,
    | "label"
    | "kind"
    | "schedule_cron"
    | "purpose"
    | "status"
    | "ignore_patterns"
    | "expires_at"
    | "added_by"
    | "last_run_at"
    | "last_change_at"
    | "pending_hash"
    | "pending_run_id"
    | "pending_at"
  >
>;

export type PageListRow = PageRow & {
  /** Every version of the page, baseline included. */
  version_count: number;
  /** Runs the change gate suppressed as noise. */
  noise_count: number;
  latest_version_at: string | null;
};

// The only columns updatePage will write. Keys of a patch that are not in this
// list are ignored, so a caller can never turn an object key into SQL.
const PAGE_PATCH_COLUMNS = [
  "label",
  "kind",
  "schedule_cron",
  "purpose",
  "status",
  "ignore_patterns",
  "expires_at",
  "added_by",
  "last_run_at",
  "last_change_at",
  "pending_hash",
  "pending_run_id",
  "pending_at",
] as const satisfies readonly (keyof PagePatch)[];

/** Inserts a page. `created_at` is now; `last_run_at` and `last_change_at` start NULL. Throws if the url already exists. */
export async function insertPage(db: D1Database, p: NewPage): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pages
         (id, url, label, kind, monitor_id, schedule_cron, purpose, status, added_by, ignore_patterns, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.url,
      p.label,
      p.kind,
      p.monitor_id,
      p.schedule_cron,
      p.purpose,
      p.status,
      p.added_by,
      p.ignore_patterns,
      p.expires_at,
      new Date().toISOString(),
    )
    .run();
}

export function getPage(db: D1Database, id: string): Promise<PageRow | null> {
  return db.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first<PageRow>();
}

export function getPageByMonitorId(db: D1Database, monitorId: string): Promise<PageRow | null> {
  return db.prepare("SELECT * FROM pages WHERE monitor_id = ?").bind(monitorId).first<PageRow>();
}

export function getPageByUrl(db: D1Database, url: string): Promise<PageRow | null> {
  return db.prepare("SELECT * FROM pages WHERE url = ?").bind(url).first<PageRow>();
}

/**
 * One page with the number of its runs suppressed as noise, counted as listPages counts them (every run,
 * no cap), in one query; null for an unknown page. The page view's header and its 404 read only this.
 */
export function getPageWithNoiseCount(db: D1Database, id: string): Promise<(PageRow & { noise_count: number }) | null> {
  return db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM runs r WHERE r.page_id = p.id AND r.noise_suppressed = 1) AS noise_count
       FROM pages p WHERE p.id = ?`,
    )
    .bind(id)
    .first<PageRow & { noise_count: number }>();
}

/** Every page with its version count, noise count and newest version time, ordered by creation. */
export async function listPages(db: D1Database): Promise<PageListRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM versions v WHERE v.page_id = p.id) AS version_count,
         (SELECT COUNT(*) FROM runs r WHERE r.page_id = p.id AND r.noise_suppressed = 1) AS noise_count,
         (SELECT MAX(v.captured_at) FROM versions v WHERE v.page_id = p.id) AS latest_version_at
       FROM pages p
       ORDER BY p.created_at, p.rowid`,
    )
    .all<PageListRow>();
  return results;
}

/** Sets the columns present in `patch` (undefined is skipped, null sets NULL). An empty patch does nothing. */
export async function updatePage(db: D1Database, id: string, patch: PagePatch): Promise<void> {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const column of PAGE_PATCH_COLUMNS) {
    const value = patch[column];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return;
  await db
    .prepare(`UPDATE pages SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values, id)
    .run();
}

/**
 * Sets a page's status only while it is one of `from`; true when it was changed. A status
 * worked out from an earlier read (the cron's) then never overwrites a newer one.
 */
export async function setPageStatusIf(
  db: D1Database,
  id: string,
  status: PageStatus,
  from: readonly PageStatus[],
): Promise<boolean> {
  if (from.length === 0) return false;
  const result = await db
    .prepare(`UPDATE pages SET status = ? WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`)
    .bind(status, id, ...from)
    .run();
  return result.meta.changes === 1;
}

/** Public pages whose week is over (`expires_at` at or before `nowIso`) and that are not yet expired or retired, oldest expiry first. */
export async function expiredPublicPages(db: D1Database, nowIso: string): Promise<PageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM pages
       WHERE added_by = 'public' AND expires_at IS NOT NULL AND expires_at <= ? AND status NOT IN ('expired', 'retired')
       ORDER BY expires_at, rowid`,
    )
    .bind(nowIso)
    .all<PageRow>();
  return results;
}

/**
 * Active and failed pages that hold a Monitor: the ones the health check compares with TinyFish (it
 * flags an active page and puts a failed one back). Active pages come first, then failed ones, each in
 * creation order, so the few Monitor lookups a tick are spent on active pages before failed ones.
 */
export async function monitoredPages(db: D1Database): Promise<(PageRow & { monitor_id: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM pages WHERE status IN ('active', 'failed') AND monitor_id IS NOT NULL
       ORDER BY (status = 'failed'), created_at, rowid`,
    )
    .all<PageRow & { monitor_id: string }>();
  return results;
}

/**
 * Pages with a confirm read pending that was marked at or after `sinceIso` and can be pulled, oldest
 * first; a page in its pull backoff (`pull_retry_after` after `nowIso`) is left out.
 */
export async function pendingConfirmPages(db: D1Database, sinceIso: string, nowIso: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM pages
       WHERE pending_at IS NOT NULL AND pending_at >= ? AND status IN ('active', 'failed') AND monitor_id IS NOT NULL
         AND (pull_retry_after IS NULL OR pull_retry_after <= ?)
       ORDER BY pending_at, rowid`,
    )
    .bind(sinceIso, nowIso)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Counts one more failed pull of a page (in SQL, so two at once both count). From the
 * `afterFailures`-th in a row on, the page's `pull_retry_after` is set to `retryAfterIso`: the cron does
 * not pull it again before then.
 */
export async function notePullFailure(db: D1Database, id: string, afterFailures: number, retryAfterIso: string): Promise<void> {
  await db
    .prepare(
      `UPDATE pages SET pull_failures = pull_failures + 1,
         pull_retry_after = CASE WHEN pull_failures + 1 >= ?2 THEN ?3 ELSE pull_retry_after END
       WHERE id = ?1`,
    )
    .bind(id, afterFailures, retryAfterIso)
    .run();
}

/** Ends a page's pull backoff (a pull returned text, or a webhook run arrived); writes nothing when there is none. */
export async function clearPullFailures(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `UPDATE pages SET pull_failures = 0, pull_retry_after = NULL
       WHERE id = ? AND (pull_failures != 0 OR pull_retry_after IS NOT NULL)`,
    )
    .bind(id)
    .run();
}

/** Clears the pending confirm read of every page marked before `beforeIso`; the number of pages cleared. */
export async function clearStalePending(db: D1Database, beforeIso: string): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE pages SET pending_hash = NULL, pending_run_id = NULL, pending_at = NULL
       WHERE pending_at IS NOT NULL AND pending_at < ?`,
    )
    .bind(beforeIso)
    .run();
  return result.meta.changes;
}

/**
 * The public add slots in use: how many public pages hold a Monitor slot (as countMonitors counts them)
 * and the earliest expiry among them, when the next slot frees (null when none is held). One query.
 */
export async function publicSlotUsage(db: D1Database): Promise<{ used: number; next_free_at: string | null }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS used, MIN(expires_at) AS next_free_at FROM pages
       WHERE added_by = 'public' AND status IN ('active', 'paused', 'failed')`,
    )
    .first<{ used: number; next_free_at: string | null }>();
  return { used: row?.used ?? 0, next_free_at: row?.next_free_at ?? null };
}

/**
 * Pages that hold a Monitor slot: active, paused and failed (the Monitor of an
 * expired or retired page is deleted). Pass `addedBy` to count one origin only.
 */
export async function countMonitors(db: D1Database, addedBy?: AddedBy): Promise<number> {
  const where = "status IN ('active', 'paused', 'failed')";
  const row =
    addedBy === undefined
      ? await db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE ${where}`).first<{ n: number }>()
      : await db
          .prepare(`SELECT COUNT(*) AS n FROM pages WHERE ${where} AND added_by = ?`)
          .bind(addedBy)
          .first<{ n: number }>();
  return row?.n ?? 0;
}
