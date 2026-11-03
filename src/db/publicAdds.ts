// Per-caller daily counter for public actions. The key is an opaque string the
// caller computes (sha256(ip + WEBHOOK_SECRET)); a different feature can share
// the table by prefixing it (Discover uses "discover:" + ipHash). The day is
// the UTC calendar day, YYYY-MM-DD.

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function publicAddsToday(db: D1Database, ipHash: string): Promise<number> {
  const row = await db
    .prepare("SELECT count FROM public_adds WHERE ip_hash = ? AND day = ?")
    .bind(ipHash, utcDay())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Takes one of the key's `limit` adds for today, in one statement: true when the count was
 * below the limit and is now one higher, false (count unchanged) when the limit was reached.
 * Parallel callers cannot all pass, which a read of `publicAddsToday` followed by a write
 * cannot promise. A caller that does not complete the action gives the add back with
 * `releasePublicAdd`.
 */
export async function claimPublicAdd(db: D1Database, ipHash: string, limit: number): Promise<boolean> {
  if (limit < 1) return false;
  const row = await db
    .prepare(
      `INSERT INTO public_adds (ip_hash, day, count) VALUES (?, ?, 1)
       ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(ipHash, utcDay(), limit)
    .first<{ count: number }>();
  return row !== null;
}

/** Gives back an add taken with `claimPublicAdd` (never below 0; a day with no row is left alone). */
export async function releasePublicAdd(db: D1Database, ipHash: string): Promise<void> {
  await db
    .prepare("UPDATE public_adds SET count = count - 1 WHERE ip_hash = ? AND day = ? AND count > 0")
    .bind(ipHash, utcDay())
    .run();
}

/** Adds one to today's count for the key, creating the row at 1 on first use. */
export async function recordPublicAdd(db: D1Database, ipHash: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO public_adds (ip_hash, day, count) VALUES (?, ?, 1)
       ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1`,
    )
    .bind(ipHash, utcDay())
    .run();
}
