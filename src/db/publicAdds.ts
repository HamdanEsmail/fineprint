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
