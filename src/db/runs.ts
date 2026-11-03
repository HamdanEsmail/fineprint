import type { RunRow } from "./types";

/**
 * Inserts a run. A run whose `monitor_run_id` already exists (a TinyFish
 * webhook retry) is left alone and reported as "duplicate". Any other
 * constraint failure (for example a clashing `id`) still throws.
 */
export async function insertRun(db: D1Database, r: RunRow): Promise<"inserted" | "duplicate"> {
  const result = await db
    .prepare(
      `INSERT INTO runs
         (id, page_id, monitor_run_id, outcome, is_baseline, judgment_relevant, judgment_summary,
          diff_truncated, noise_suppressed, noise_reason, raw_key, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    )
    .run();
  return result.meta.changes === 0 ? "duplicate" : "inserted";
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
