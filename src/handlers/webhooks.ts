// Webhook receivers (spec 4.2). TinyFish calls these on every scheduled run; the
// URL carries a random secret segment because the payload carries no signature.
//
// The Monitor route stores the raw payload, records the run exactly once (a
// TinyFish retry of the same payload id is answered as a duplicate), and for a
// `changed` run decides through the normalization gate whether the page really
// changed. It runs on the free plan (10 ms CPU), so it does no line diffs: it
// normalizes and hashes, and that is all.
import { Hono } from "hono";
import { safeEqual } from "../auth";
import { captureVersion } from "../capture";
import { hashText, normalize } from "../core/normalize";
import { PRICES, recordSpend } from "../core/spend";
import { getPageByMonitorId, updatePage } from "../db/pages";
import { deleteRun, insertRun, markNoise, setRunNote } from "../db/runs";
import type { PageRow } from "../db/types";
import { getVersion, insertVersion, latestVersionHash, setVersionHash } from "../db/versions";
import type { Env } from "../env";

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

/** What the handler needs from a Monitor webhook. Everything but the two ids is optional in the wire format. */
interface MonitorPayload {
  /** TinyFish's run id; the idempotency key. */
  id: string;
  monitorId: string;
  /** As sent. A value other than "changed" is recorded and otherwise treated like "unchanged". */
  outcome: string;
  isBaseline: boolean;
  diffTruncated: boolean;
  judgmentRelevant: 0 | 1 | null;
  judgmentSummary: string | null;
  /** `results[0].text`, or "" when there is none. */
  text: string;
  hasErrors: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The run id becomes an R2 key (`raw/<id>.json`). TinyFish's ids are UUIDs; a longer one is
// refused up front so a valid-but-odd payload cannot fail the R2 put and be retried forever.
const MAX_RUN_ID_LENGTH = 200;

/** Null when the body is not a JSON object with a run id and a monitor id. Every other field is read tolerantly. */
function parsePayload(raw: string): MonitorPayload | null {
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

/** The page's ignore patterns; a column that is not a JSON array of strings counts as none. */
function readPatterns(column: string): string[] {
  try {
    const parsed: unknown = JSON.parse(column);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

// --- The change gate ------------------------------------------------------------

type Verdict =
  | { kind: "fetch_error" }
  /** `heal` is set when the newest version's stored hash was stale and should be rewritten. */
  | { kind: "suppressed"; heal: { versionId: string; hash: string } | null }
  | { kind: "new_version"; hash: string };

/**
 * Stage two of the gate (spec 4.3) for a run TinyFish called `changed`. It only reads;
 * the route computes it before the run is claimed (see there).
 *
 * Normalizing a 100 KB page costs several ms of the 10 ms budget, so it happens once
 * if it can: the new text's hash is compared with the newest version's stored hash,
 * and only that hash is read. When they differ, the stored text is read and
 * normalized again with the page's current patterns, because the stored hash dates
 * from the rules in force when it was written and an admin edit of the ignore
 * patterns makes it stale. If the two texts then agree, the verdict says to rewrite
 * the stored hash so later runs take the cheap path again.
 */
async function judgeChange(db: D1Database, page: PageRow, payload: MonitorPayload): Promise<Verdict> {
  // An empty page or an error entry is a failed fetch, not a change in the page.
  if (payload.text.trim() === "" || payload.hasErrors) return { kind: "fetch_error" };

  const patterns = readPatterns(page.ignore_patterns);
  const hash = await hashText(normalize(payload.text, patterns).text);
  const latest = await latestVersionHash(db, page.id);
  if (latest === null) return { kind: "new_version", hash };
  if (hash === latest.normalized_hash) return { kind: "suppressed", heal: null };

  const previous = await getVersion(db, latest.id);
  if (previous !== null && (await hashText(normalize(previous.text, patterns).text)) === hash) {
    return { kind: "suppressed", heal: { versionId: latest.id, hash } };
  }
  return { kind: "new_version", hash };
}

/** Bookkeeping that must not fail a webhook whose run and version are already stored. */
async function bestEffort(what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    logError(what, err);
  }
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

  const now = new Date().toISOString();
  const rawKey = `raw/${payload.id}.json`;
  await c.env.STORE.put(rawKey, raw, { httpMetadata: { contentType: "application/json" } });

  // Judge a `changed` run BEFORE claiming it. This is the CPU-heavy part (normalizing
  // the page text), and if the Worker is killed in it nothing has been claimed, so
  // TinyFish's retry is processed instead of being answered "duplicate" for a run that
  // never got its version. A duplicate delivery wastes this work; that is accepted.
  // A "baseline" run is TinyFish re-baselining its own comparison: the run is stored
  // and no version is made. So is any outcome we do not know.
  const verdict = payload.outcome === "changed" ? await judgeChange(db, page, payload) : null;

  // Claim the run. A retry of the same payload id stops here, before any write below.
  const runId = crypto.randomUUID();
  const claim = await insertRun(db, {
    id: runId,
    page_id: page.id,
    monitor_run_id: payload.id,
    outcome: payload.outcome,
    is_baseline: payload.isBaseline ? 1 : 0,
    judgment_relevant: payload.judgmentRelevant,
    judgment_summary: payload.judgmentSummary,
    diff_truncated: payload.diffTruncated ? 1 : 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: rawKey,
    received_at: now,
  });
  if (claim === "duplicate") return c.json({ ok: true, duplicate: true });

  let response: Record<string, unknown> = { ok: true, run_id: runId };
  let versionId: string | null = null;
  try {
    if (verdict?.kind === "fetch_error") {
      await setRunNote(db, runId, "fetch_error");
    } else if (verdict?.kind === "suppressed") {
      await markNoise(db, runId, "normalized_identical");
      response = { ok: true, suppressed: true };
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
        is_baseline: 0,
        captured_at: now,
        text: payload.text,
        normalized_hash: verdict.hash,
        judgment_summary: payload.judgmentSummary,
        capture_status: "pending",
      });
      versionId = newId;
      response = { ok: true, version_id: newId };
    }
  } catch (err) {
    // The retry TinyFish sends after our 500 must be processed, not answered as a
    // duplicate of a run that never got its version, so give the claim back.
    await deleteRun(db, runId).catch((e: unknown) => logError(`could not release run ${runId}`, e));
    throw err;
  }

  await bestEffort("page timestamps", () =>
    updatePage(db, page.id, { last_run_at: now, last_change_at: versionId === null ? undefined : now }),
  );
  // TinyFish does not bill a failed check, so a fetch error is not put on the ledger.
  if (verdict?.kind !== "fetch_error") {
    await bestEffort("spend", () => recordSpend(db, "monitor_check", PRICES.monitor_check, payload.id));
  }

  if (versionId !== null) {
    const newId = versionId;
    c.executionCtx.waitUntil(
      captureVersion(c.env, newId).catch((err: unknown) => logError(`capture failed for ${newId}`, err)),
    );
  }
  return c.json(response);
});
