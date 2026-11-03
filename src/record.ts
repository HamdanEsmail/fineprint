// Recording one Monitor run: the path a webhook payload and a pulled overdue check both take
// (spec 4.2 and 4.3), so the two can never record a run differently. The caller has stored the raw
// body and judged the run (src/core/gate.ts) before it gets here; this claims the run under
// TinyFish's run id, then writes the noise flag or the new version, the page's timestamps and the
// spend, and starts the new version's capture in the caller's own invocation.
import { captureVersion } from "./capture";
import type { Verdict } from "./core/gate";
import { PRICES, recordSpend } from "./core/spend";
import { updatePage } from "./db/pages";
import { deleteRun, insertRun, markNoise, setRunNote } from "./db/runs";
import type { PageRow, TriggerKind } from "./db/types";
import { insertVersion, setVersionHash } from "./db/versions";
import type { Env } from "./env";

/** What the recording path needs of a Monitor run, whichever way it arrived. */
export interface MonitorRun {
  /** TinyFish's run id; the idempotency key. */
  id: string;
  /** As sent by the webhook, or worked out by Fineprint for a pull. */
  outcome: string;
  isBaseline: boolean;
  diffTruncated: boolean;
  judgmentRelevant: 0 | 1 | null;
  judgmentSummary: string | null;
  /** `results[0].text`, or "" when there is none. */
  text: string;
  hasErrors: boolean;
}

export type RecordInput = {
  page: PageRow;
  run: MonitorRun;
  trigger: TriggerKind;
  /** Where the caller stored the raw body. */
  rawKey: string;
  /** When Fineprint received the run: the run's `received_at`, and a new version's `captured_at`. */
  receivedAt: string;
  /** The gate's decision, or null to store the run and nothing else. */
  verdict: Verdict | null;
};

export type Recorded =
  /** TinyFish's run id is already recorded: nothing was written. */
  | { kind: "duplicate" }
  | { kind: "recorded"; runId: string; versionId: string | null; suppressed: boolean };

function logError(what: string, err: unknown): void {
  console.error(what, err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
}

/** Bookkeeping that must not fail a run whose row and version are already stored. */
async function bestEffort(what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    logError(what, err);
  }
}

/**
 * Records a judged run exactly once. A second delivery of the same run id (a webhook retry, a late
 * webhook for a run already pulled, or a pull answered with a run already recorded) stops at the
 * claim and writes nothing. If writing the verdict fails, the claim is given back before the error
 * is rethrown, so the retry that follows (TinyFish's after a 500, or the next tick's pull) is
 * processed instead of being answered as a duplicate of a run that never got its version.
 */
export async function recordMonitorRun(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  input: RecordInput,
): Promise<Recorded> {
  const db = env.DB;
  const { page, run, verdict, receivedAt } = input;

  // Claim the run. A second delivery of the same run id stops here, before any write below.
  const runId = crypto.randomUUID();
  const claim = await insertRun(db, {
    id: runId,
    page_id: page.id,
    monitor_run_id: run.id,
    outcome: run.outcome,
    is_baseline: run.isBaseline ? 1 : 0,
    judgment_relevant: run.judgmentRelevant,
    judgment_summary: run.judgmentSummary,
    diff_truncated: run.diffTruncated ? 1 : 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: input.rawKey,
    received_at: receivedAt,
    trigger_kind: input.trigger,
  });
  if (claim === "duplicate") return { kind: "duplicate" };

  let versionId: string | null = null;
  let suppressed = false;
  try {
    if (verdict?.kind === "fetch_error") {
      await setRunNote(db, runId, "fetch_error");
    } else if (verdict?.kind === "suppressed") {
      await markNoise(db, runId, "normalized_identical");
      suppressed = true;
      const { heal } = verdict;
      if (heal !== null) {
        await bestEffort("stale hash heal", () => setVersionHash(db, heal.versionId, heal.hash));
      }
    } else if (verdict?.kind === "new_version") {
      const newId = crypto.randomUUID();
      await insertVersion(db, {
        id: newId,
        page_id: page.id,
        run_id: runId,
        is_baseline: verdict.baseline ? 1 : 0,
        captured_at: receivedAt,
        text: run.text,
        normalized_hash: verdict.hash,
        judgment_summary: run.judgmentSummary,
        capture_status: "pending",
      });
      versionId = newId;
    }
  } catch (err) {
    await deleteRun(db, runId).catch((e: unknown) => logError(`could not release run ${runId}`, e));
    throw err;
  }

  await bestEffort("page timestamps", () =>
    updatePage(db, page.id, { last_run_at: receivedAt, last_change_at: versionId === null ? undefined : receivedAt }),
  );
  // TinyFish does not bill a failed check, so a fetch error is not put on the ledger.
  if (verdict?.kind !== "fetch_error") {
    await bestEffort("spend", () => recordSpend(db, "monitor_check", PRICES.monitor_check, run.id));
  }

  if (versionId !== null) {
    const newId = versionId;
    ctx.waitUntil(captureVersion(env, newId).catch((err: unknown) => logError(`capture failed for ${newId}`, err)));
  }
  return { kind: "recorded", runId, versionId, suppressed };
}
