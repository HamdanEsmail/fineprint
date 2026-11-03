// A computed diff, keyed by the ordered pair of version ids. A version's text never
// changes, but a stored diff can still go stale: its screenshot and source urls and its
// facts are filled in after the version is inserted (so history.ts stores a diff only once
// both versions are `complete` or `failed`); its blocks depend on the page's ignore
// patterns and its envelope carries the page's label (so editing either drops the page's
// cached diffs); and its hop and noise counts change when the admin replay adds a version
// between the two. See deleteCachedDiffsOfPage.

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
