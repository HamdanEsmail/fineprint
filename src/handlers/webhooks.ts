// Webhook receivers (spec 4.2). TinyFish calls these on every scheduled run; the
// URL carries a random secret segment because the payload carries no signature.
//
// The Monitor route stores the raw payload, records the run exactly once (a
// TinyFish retry of the same payload id is answered as a duplicate), and for a
// `changed` run decides through the normalization gate whether the page really
// changed. It runs on the free plan (10 ms CPU), so it does no line diffs: it
// normalizes and hashes, and that is all. The recording itself (src/record.ts) is
// the same path an overdue check pulled with run-now takes.
//
// The Agent route receives TinyAgent's run-lifecycle callback for a facts run and
// hands the result to the capture pipeline (src/capture.ts).
import { Hono } from "hono";
import { safeEqual } from "../auth";
import { recordFactsResult } from "../capture";
import { judgeChange } from "../core/gate";
import { getPageByMonitorId } from "../db/pages";
import { getVersionByAgentRunId } from "../db/versions";
import type { Env } from "../env";
import { recordMonitorRun, type MonitorRun } from "../record";
import { getRun } from "../tinyfish/agent";

export const webhooksRouter = new Hono<{ Bindings: Env }>();

// An unexpected failure answers 500, which makes TinyFish retry the delivery. The
// body is never logged: it holds the page text.
webhooksRouter.onError((err, c) => {
  logError("webhook failed", err);
  return c.json({ error: "internal_error" }, 500);
});

function logError(what: string, err: unknown): void {
  console.error(what, err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
}

// --- Secret -------------------------------------------------------------------

// A Worker with no WEBHOOK_SECRET accepts nothing.
function secretMatches(given: string, expected: unknown): boolean {
  return typeof expected === "string" && expected !== "" && safeEqual(given, expected);
}

// --- Payload ------------------------------------------------------------------

/**
 * What the handler needs from a Monitor webhook: the run (its `outcome` as sent; a value other than
 * "changed" is recorded and otherwise treated like "unchanged") and the Monitor that sent it.
 * Everything but the two ids is optional in the wire format.
 */
export interface MonitorPayload extends MonitorRun {
  monitorId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The run id becomes an R2 key (`raw/<id>.json`). TinyFish's ids are UUIDs; a longer one is
// refused up front so a valid-but-odd payload cannot fail the R2 put and be retried forever.
const MAX_RUN_ID_LENGTH = 200;

/**
 * Null when the body is not a JSON object with a run id and a monitor id. Every other field is
 * read tolerantly. The admin replay reads the stored raw payloads with it too.
 */
export function parsePayload(raw: string): MonitorPayload | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const { id, fetch_monitor_id: monitorId } = data;
  if (typeof id !== "string" || id === "" || id.length > MAX_RUN_ID_LENGTH) return null;
  if (typeof monitorId !== "string" || monitorId === "") return null;

  const judgment = isRecord(data.judgment) ? data.judgment : null;
  const first = Array.isArray(data.results) && isRecord(data.results[0]) ? data.results[0] : null;
  return {
    id,
    monitorId,
    outcome: typeof data.outcome === "string" ? data.outcome : "unknown",
    isBaseline: data.is_baseline === true || data.outcome === "baseline",
    diffTruncated: data.diff_truncated === true,
    judgmentRelevant: typeof judgment?.is_relevant === "boolean" ? (judgment.is_relevant ? 1 : 0) : null,
    judgmentSummary: typeof judgment?.summary === "string" ? judgment.summary : null,
    text: typeof first?.text === "string" ? first.text : "",
    hasErrors: Array.isArray(data.errors) && data.errors.length > 0,
  };
}

/** What the admin replay needs of a stored raw body, whichever way the run arrived. */
export type StoredRun = Pick<MonitorRun, "text" | "hasErrors" | "judgmentSummary">;

/**
 * Reads a raw body Fineprint stored under `raw/`: a Monitor webhook payload (see parsePayload) or the 201
 * body of a run-now pull, `{run: {id, is_baseline, results: [{text, ...}], errors}}`. Null when it is
 * neither: not JSON, no run id, or no monitor id on a payload that is not the pull shape.
 */
export function parseStoredRun(raw: string): StoredRun | null {
  const payload = parsePayload(raw);
  if (payload !== null) return payload;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const run = isRecord(data) && isRecord(data.run) ? data.run : null;
  if (run === null || typeof run.id !== "string" || run.id === "" || run.id.length > MAX_RUN_ID_LENGTH) return null;
  const first = Array.isArray(run.results) && isRecord(run.results[0]) ? run.results[0] : null;
  return {
    text: typeof first?.text === "string" ? first.text : "",
    hasErrors: Array.isArray(run.errors) && run.errors.length > 0,
    judgmentSummary: null,
  };
}

// --- Routes ---------------------------------------------------------------------

webhooksRouter.post("/monitor/:secret", async (c) => {
  if (!secretMatches(c.req.param("secret"), c.env.WEBHOOK_SECRET)) return c.body(null, 404);

  // Read as text, not c.req.json(): the raw payload is kept byte for byte.
  const raw = await c.req.text();
  const payload = parsePayload(raw);
  if (payload === null) return c.json({ error: "invalid_payload" }, 400);

  const db = c.env.DB;
  const page = await getPageByMonitorId(db, payload.monitorId);
  if (page === null) {
    // The monitor id only: never the payload, which holds the page text.
    console.warn(`monitor webhook for unknown monitor ${payload.monitorId.slice(0, 100)}`);
    return c.json({ error: "unknown_monitor" }, 404);
  }

  // A retired page's Monitor was deleted on purpose: a delivery that was already on its way is answered
  // and set aside, with no run, no version and no capture.
  if (page.status === "retired") return c.json({ ok: true, ignored: true });

  const now = new Date().toISOString();
  const rawKey = `raw/${payload.id}.json`;
  await c.env.STORE.put(rawKey, raw, { httpMetadata: { contentType: "application/json" } });

  // Judge a `changed` run BEFORE claiming it. This is the CPU-heavy part (normalizing
  // the page text), and if the Worker is killed in it nothing has been claimed, so
  // TinyFish's retry is processed instead of being answered "duplicate" for a run that
  // never got its version. A duplicate delivery wastes this work; that is accepted.
  // A "baseline" run is TinyFish re-baselining its own comparison: the run is stored
  // and no version is made. So is any outcome we do not know.
  // A page with a confirm read pending (src/core/gate.ts) judges whatever run arrives next, a scheduled
  // "unchanged" one included: it may be the second read of the text that was held.
  const judged = payload.outcome === "changed" || (page.pending_at !== null && payload.outcome === "unchanged");
  const verdict = judged ? await judgeChange(db, page, payload) : null;

  // Claimed, then written, exactly once per payload id; a retry of the same id writes nothing.
  // A failure after the claim gives it back and answers 500, so TinyFish's retry is processed.
  const recorded = await recordMonitorRun(c.env, c.executionCtx, {
    page,
    run: payload,
    trigger: "webhook",
    rawKey,
    receivedAt: now,
    verdict,
  });
  if (recorded.kind === "duplicate") return c.json({ ok: true, duplicate: true });
  if (recorded.versionId !== null) return c.json({ ok: true, version_id: recorded.versionId });
  if (recorded.suppressed) return c.json({ ok: true, suppressed: true });
  return c.json({ ok: true, run_id: recorded.runId });
});

// --- Agent callback ---------------------------------------------------------------

const TERMINAL_AGENT_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * Settles a finished facts run. The callback may leave out the result or the step
 * count; then the run is fetched. If the result is needed and cannot be fetched, the
 * run is left in flight for the cron's follow-up to settle.
 */
async function settleAgentRun(
  env: Env,
  runId: string,
  status: string,
  given: { result: unknown; numSteps: number | null },
): Promise<void> {
  // Only runs Fineprint started are fetched or recorded.
  if (runId.startsWith("claim:") || (await getVersionByAgentRunId(env.DB, runId)) === null) return;

  let { result, numSteps } = given;
  const needResult = status === "COMPLETED" && (result === null || result === undefined);
  if (needResult || numSteps === null) {
    try {
      const run = await getRun(env, runId);
      if (needResult) result = run.result;
      numSteps ??= run.num_of_steps;
    } catch (err) {
      logError(`agent run ${runId.slice(0, 100)} could not be fetched`, err);
      if (needResult) return;
    }
  }
  await recordFactsResult(env, runId, status, result, numSteps);
}

webhooksRouter.post("/agent/:secret", async (c) => {
  if (!secretMatches(c.req.param("secret"), c.env.WEBHOOK_SECRET)) return c.body(null, 404);

  // Always 200 after the secret: a run we cannot use is not worth a TinyFish retry.
  const ignored = () => c.json({ ok: true, ignored: true });
  try {
    let data: unknown;
    try {
      data = JSON.parse(await c.req.text());
    } catch {
      return ignored();
    }
    if (!isRecord(data)) return ignored();
    const { run_id: runId, status } = data;
    if (typeof runId !== "string" || runId === "" || runId.length > MAX_RUN_ID_LENGTH) return ignored();
    if (typeof status !== "string" || !TERMINAL_AGENT_STATUSES.has(status.toUpperCase())) return ignored();

    const given = {
      result: data.result,
      numSteps: typeof data.num_of_steps === "number" ? data.num_of_steps : null,
    };
    // Recording the result may start the next queued facts run: one more TinyAgent request, so it runs
    // after the response. That start never waits out a rate limit (a 429 gives its claim back at once,
    // src/capture.ts); only the hourly cron's start waits and retries.
    c.executionCtx.waitUntil(
      settleAgentRun(c.env, runId, status.toUpperCase(), given).catch((err: unknown) =>
        logError(`agent callback for ${runId.slice(0, 100)} failed`, err),
      ),
    );
    return c.json({ ok: true });
  } catch (err) {
    logError("agent callback failed", err);
    return c.json({ ok: true });
  }
});
