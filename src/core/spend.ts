// The spend ledger. Every TinyFish call appends one row; the totals feed the
// spend pause (SPEND_PAUSE_USD) and the public /api/stats.

export type SpendKind = "monitor_check" | "screenshot" | "agent_step" | "fetch" | "search";

/** US dollars per unit of each kind. */
export const PRICES: Record<SpendKind, number> = {
  monitor_check: 0.005,
  screenshot: 0.002,
  agent_step: 0.016,
  fetch: 0,
  search: 0,
};

/**
 * Appends one row unless the ledger already has a row of this kind for this `ref`, in one statement, so
 * writing it again (a pulled check is recorded when run-now answers and again by the shared recording
 * path; a webhook retry) never bills twice. For spend that is once per thing, such as a check per run id.
 */
export async function recordSpendOnce(
  db: D1Database,
  kind: SpendKind,
  amountUsd: number,
  ref: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO spend (id, kind, amount_usd, ref, at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE NOT EXISTS (SELECT 1 FROM spend WHERE kind = ?2 AND ref = ?4)`,
    )
    .bind(crypto.randomUUID(), kind, amountUsd, ref, new Date().toISOString())
    .run();
}

/** Appends one row to the ledger. `ref` says what the money was spent on (a page id, a run id). */
export async function recordSpend(
  db: D1Database,
  kind: SpendKind,
  amountUsd: number,
  ref: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), kind, amountUsd, ref, new Date().toISOString())
    .run();
}
