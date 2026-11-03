// A computed diff, keyed by the ordered pair of version ids. Version rows are
// immutable once written, so a cached diff never goes stale; the one exception is
// the hop and noise counts inside it, which the admin replay can change by adding a
// version between the two (see deleteCachedDiffsOfPage).

export async function getCachedDiff(db: D1Database, fromId: string, toId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT json FROM diff_cache WHERE from_version_id = ? AND to_version_id = ?")
    .bind(fromId, toId)
    .first<{ json: string }>();
  return row?.json ?? null;
}

/** Drops every cached diff that starts or ends at a version of the page. */
export async function deleteCachedDiffsOfPage(db: D1Database, pageId: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM diff_cache
       WHERE from_version_id IN (SELECT id FROM versions WHERE page_id = ?1)
          OR to_version_id IN (SELECT id FROM versions WHERE page_id = ?1)`,
    )
    .bind(pageId)
    .run();
}

/** Stores a diff. Two requests racing to cache the same pair both succeed; the later write wins. */
export async function putCachedDiff(db: D1Database, fromId: string, toId: string, json: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO diff_cache (from_version_id, to_version_id, json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(from_version_id, to_version_id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at`,
    )
    .bind(fromId, toId, json, new Date().toISOString())
    .run();
}
