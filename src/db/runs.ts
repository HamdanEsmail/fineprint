import type { RunRow, TriggerKind } from "./types";

/**
 * Inserts a run. A run whose `monitor_run_id` already exists (a TinyFish
 * webhook retry, or a pull answered with a run already recorded) is left alone
 * and reported as "duplicate". Any other constraint failure (for example a
 * clashing `id`) still throws.
 */
export async function insertRun(db: D1Database, r: RunRow): Promise<"inserted" | "duplicate"> {
  const result = await db
    .prepare(
      `INSERT INTO runs
         (id, page_id, monitor_run_id, outcome, is_baseline, judgment_relevant, judgment_summary,
          diff_truncated, noise_suppressed, noise_reason, raw_key, received_at, trigger_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(monitor_run_id) DO NOTHING`,
    )
    .bind(
      r.id,
      r.page_id,
      r.monitor_run_id,
      r.outcome,
      r.is_baseline,
      r.judgment_relevant,
      r.judgment_summary,
      r.diff_truncated,
      r.noise_suppressed,
      r.noise_reason,
      r.raw_key,
      r.received_at,
      r.trigger_kind,
    )
    .run();
  return result.meta.changes === 0 ? "duplicate" : "inserted";
}

/** An active or failed page that holds a Monitor, with the receipt time of its newest run (any trigger). */
export type PullCandidate = {
  id: string;
  schedule_cron: string | null;
  last_received_at: string | null;
};

/**
 * Every active or failed page that holds a Monitor, with the newest `received_at` among its runs, in
 * creation order: the pages the cron's overdue check looks at. A page health marked failed is still
 * pulled: run-now works whatever state the Monitor's schedule is in, and when the Monitor is gone the
 * pull just fails (unbilled). Paused and expired pages are left alone. One query, however many pages
 * there are.
 */
export async function pullCandidates(db: D1Database): Promise<PullCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.schedule_cron,
         (SELECT MAX(r.received_at) FROM runs r WHERE r.page_id = p.id) AS last_received_at
       FROM pages p
       WHERE p.status IN ('active', 'failed') AND p.monitor_id IS NOT NULL
       ORDER BY p.created_at, p.rowid`,
    )
    .all<PullCandidate>();
  return results;
}

/** How many runs arrived each way. */
export async function countRunsByTrigger(db: D1Database): Promise<Record<TriggerKind, number>> {
  const counts: Record<TriggerKind, number> = { create: 0, webhook: 0, pull: 0 };
  const { results } = await db
    .prepare("SELECT trigger_kind, COUNT(*) AS n FROM runs GROUP BY trigger_kind")
    .all<{ trigger_kind: string; n: number }>();
  for (const row of results) {
    if (Object.hasOwn(counts, row.trigger_kind)) counts[row.trigger_kind as TriggerKind] = row.n;
  }
  return counts;
}

/** One run by our own id, or null. */
export function getRunById(db: D1Database, id: string): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();
}

/** Flags a run as suppressed noise and records why. */
export async function markNoise(db: D1Database, runId: string, reason: string): Promise<void> {
  await db
    .prepare("UPDATE runs SET noise_suppressed = 1, noise_reason = ? WHERE id = ?")
    .bind(reason, runId)
    .run();
}

/** Takes a run's noise flag and reason back off (the replay does it for a run it turned into a version). */
export async function clearNoise(db: D1Database, runId: string): Promise<void> {
  await db.prepare("UPDATE runs SET noise_suppressed = 0, noise_reason = NULL WHERE id = ?").bind(runId).run();
}

/** A run with the id of the version it made, or null when it made none. */
export type ReplayRun = RunRow & { version_id: string | null };

/**
 * A page's runs the admin replay walks: outcome `changed` with a stored raw payload, in the
 * order they were received (ties by insertion), each with the id of the version it made, if any.
 */
export async function changedRunsForReplay(db: D1Database, pageId: string): Promise<ReplayRun[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, v.id AS version_id
       FROM runs r
       LEFT JOIN versions v ON v.page_id = r.page_id AND v.run_id = r.id
       WHERE r.page_id = ? AND r.outcome = 'changed' AND r.raw_key IS NOT NULL
       ORDER BY r.received_at, r.rowid`,
    )
    .bind(pageId)
    .all<ReplayRun>();
  return results;
}

/**
 * Records why a run was set aside without counting it as suppressed noise
 * (`noise_suppressed` stays as it is). The webhook handler uses it for a
 * `changed` run whose fetch failed: that is a gap in the record, not noise.
 */
export async function setRunNote(db: D1Database, runId: string, reason: string): Promise<void> {
  await db.prepare("UPDATE runs SET noise_reason = ? WHERE id = ?").bind(reason, runId).run();
}

/**
 * Takes a run back out. The webhook handler claims a run before it does the
 * rest of its work; if that work fails it gives the claim back, so TinyFish's
 * retry of the same payload is processed instead of being answered as a duplicate.
 */
export async function deleteRun(db: D1Database, runId: string): Promise<void> {
  await db.prepare("DELETE FROM runs WHERE id = ?").bind(runId).run();
}

export async function countRuns(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Runs the change gate suppressed as noise. */
export async function countNoise(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM runs WHERE noise_suppressed = 1").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Runs of one page suppressed as noise that were received after `afterIso` and at or before `uptoIso`. */
export async function countNoiseBetween(
  db: D1Database,
  pageId: string,
  afterIso: string,
  uptoIso: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE page_id = ? AND noise_suppressed = 1 AND received_at > ? AND received_at <= ?",
    )
    .bind(pageId, afterIso, uptoIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
