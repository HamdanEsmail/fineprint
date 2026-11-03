import type { AddedBy, PageRow } from "./types";

export type NewPage = Omit<PageRow, "created_at" | "last_run_at" | "last_change_at">;

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
 * Pages that hold a Monitor slot: active, paused and failed (an expired page's
 * Monitor is deleted). Pass `addedBy` to count one origin only.
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
