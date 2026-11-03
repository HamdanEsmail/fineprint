// The capture pipeline (spec 4.4). Every new version gets a full-page screenshot
// (TinyBrowser over raw CDP), its HTML source (TinyFetch) and, on pricing and fee
// pages, the price facts (TinyAgent). Each capture is written to D1 the moment it
// finishes and fails on its own, so one failure never loses the others.
//
// capture_status:
//   pending         nothing attempted yet
//   partial         screenshot or source still missing, attempts left
//   awaiting_facts  screenshot and source stored, facts needed and missing: queued
//                   while agent_run_id is NULL, in flight while it is set
//   complete        screenshot and source stored, and facts stored or not needed
//   failed          out of attempts with something still missing
//
// One counter, capture_attempts, counts capture attempts and failed facts runs alike;
// at CAPTURE_MAX_ATTEMPTS the version is failed. capture_error holds one
// "<capture>: <code>" part per capture whose last try failed, joined with "; ".
//
// Facts are a serial queue: three projects share the account's 2 concurrent Agent
// runs, so Fineprint never has more than one of its own in flight. A version takes
// the single slot with one atomic D1 claim (claimFactsSlot), and every facts result
// starts the next queued version, oldest first. Every write that frees or fills the
// slot is conditional on the run id or claim token the writer holds it with, and
// attempts are counted in SQL, so a repeated settlement can never clear a newer run.
import { CAPTURE_MAX_ATTEMPTS, FACTS_PAUSE_USD, SPEND_PAUSE_USD } from "./core/limits";
import { PRICES } from "./core/spend";
import { getPage } from "./db/pages";
import { getRunById } from "./db/runs";
import type { CaptureStatus, PageRow, RunRow, VersionRow } from "./db/types";
import {
  addCaptureAttempt,
  claimFactsSlot,
  getVersion,
  getVersionByAgentRunId,
  nextFactsCandidate,
  setCaptureStatusIfUnchanged,
  updateCapture,
  updateIfFactsHolder,
} from "./db/versions";
import type { Env } from "./env";
import { parseFacts, startFactsRun } from "./tinyfish/agent";
import { screenshotFullPage } from "./tinyfish/browser";
import { TinyFishError } from "./tinyfish/client";
import { fetchPage } from "./tinyfish/fetch";

/**
 * The seam tests use instead of vi.mock (which does not work in the Workers pool):
 * captureVersion calls `captureDeps.screenshotFullPage`, and a facts start that waits out
 * rate limits (`startNextFacts(env, {waitOnRateLimit: true})`) hands `captureDeps.sleep`
 * to startFactsRun in place of the real 60 s wait when it is set.
 */
export const captureDeps = {
  screenshotFullPage,
  sleep: undefined as undefined | ((ms: number) => Promise<void>),
};

// --- The status rule ------------------------------------------------------------

type StatusInput = Pick<VersionRow, "screenshot_key" | "html_key" | "facts_json" | "capture_attempts">;

/** The one rule for capture_status, used after every capture and every facts result. */
export function captureStatusFor(v: StatusInput, needsFacts: boolean): CaptureStatus {
  const stored = v.screenshot_key !== null && v.html_key !== null;
  if (stored && (!needsFacts || v.facts_json !== null)) return "complete";
  if (v.capture_attempts >= CAPTURE_MAX_ATTEMPTS) return "failed";
  if (stored) return "awaiting_facts";
  return v.capture_attempts === 0 ? "pending" : "partial";
}

/** Facts are taken on pricing and fee pages: always for the baseline, and for a later version unless its run was judged not relevant. */
export function needsFacts(
  page: Pick<PageRow, "kind">,
  version: Pick<VersionRow, "is_baseline">,
  run: Pick<RunRow, "judgment_relevant"> | null,
): boolean {
  if (page.kind !== "pricing" && page.kind !== "fees") return false;
  return version.is_baseline === 1 || run?.judgment_relevant !== 0;
}

async function loadNeedsFacts(db: D1Database, page: Pick<PageRow, "kind">, version: VersionRow): Promise<boolean> {
  const run = version.run_id === null ? null : await getRunById(db, version.run_id);
  return needsFacts(page, version, run);
}

/**
 * Brings a version's status (and the note on facts that can no longer start) in line with
 * the rule, from a fresh read or the row a write returned. The write is a compare-and-set on
 * the columns the rule reads, so it never overwrites a newer state; whoever changed them
 * settles in turn. Every writer of the status settles after its own write, so a status worked
 * out from an older read (a capture racing a facts result) does not stay.
 */
async function settleStatus(db: D1Database, v: VersionRow | null, factsNeeded: boolean): Promise<void> {
  if (v === null) return;
  const status = captureStatusFor(v, factsNeeded);
  const error = withExhaustedFacts(v.capture_error, status, v, factsNeeded);
  if (status !== v.capture_status || error !== v.capture_error) {
    await setCaptureStatusIfUnchanged(db, v, status, error);
  }
}

// --- capture_error ----------------------------------------------------------------

type Capture = "screenshot" | "source" | "facts";
const CAPTURES: readonly Capture[] = ["screenshot", "source", "facts"];

const captureOf = (part: string): Capture | undefined => CAPTURES.find((c) => part.startsWith(`${c}: `));

/**
 * Rewrites the error parts of the captures in `replace` with `fresh`, keeping the
 * other captures' parts. Anything that is not a capture's part (`spend_paused`,
 * `replayed`) is dropped: it described an earlier state.
 */
function withErrors(existing: string | null, replace: readonly Capture[], fresh: string[]): string | null {
  const kept = (existing ?? "").split("; ").filter((part) => {
    const capture = captureOf(part);
    return capture !== undefined && !replace.includes(capture);
  });
  const parts = [...kept, ...fresh].sort(
    (a, b) => CAPTURES.indexOf(captureOf(a) ?? "facts") - CAPTURES.indexOf(captureOf(b) ?? "facts"),
  );
  return parts.length === 0 ? null : parts.join("; ");
}

/** A failed version must name what is missing: facts that can no longer be started say so. */
function withExhaustedFacts(error: string | null, status: CaptureStatus, v: StatusInput, factsNeeded: boolean): string | null {
  const factsMissing = factsNeeded && v.facts_json === null && v.screenshot_key !== null && v.html_key !== null;
  if (status !== "failed" || !factsMissing || (error ?? "").split("; ").some((p) => captureOf(p) === "facts")) return error;
  return withErrors(error, [], ["facts: no_attempts_left"]);
}

/** A capture failure whose code is already known and safe to store. */
class CaptureFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CaptureFailure";
  }
}

/** Free text made safe for one error part: one line, no part separator, at most 80 characters. */
function clean(text: string): string {
  return text.replace(/\s+/g, " ").replace(/;/g, ",").trim().slice(0, 80);
}

/**
 * The code stored for an error. A TinyFishError's message is never stored, only its
 * code. Other errors get `label`, plus up to 80 characters of their message when
 * `withMessage` is set (only for our own CDP code, whose messages hold no secrets).
 */
function codeOf(err: unknown, label: string, withMessage = false): string {
  if (err instanceof CaptureFailure) return err.code;
  if (err instanceof TinyFishError) return clean(err.code) || label;
  const message = withMessage && err instanceof Error ? clean(err.message) : "";
  return message === "" ? label : `${label} (${message})`;
}

function logError(what: string, err: unknown): void {
  if (err instanceof TinyFishError) {
    console.error(what, `${err.name} status=${err.status} code=${err.code}`);
  } else {
    console.error(what, err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  }
}

// --- Spend --------------------------------------------------------------------------

async function totalSpend(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend").first<{ total: number }>();
  return row?.total ?? 0;
}

/** True once total spend has reached SPEND_PAUSE_USD: nothing that costs money starts (captures, facts runs, overdue pulls). */
export async function spendPaused(db: D1Database): Promise<boolean> {
  return (await totalSpend(db)) >= SPEND_PAUSE_USD;
}

/**
 * True once total spend has reached FACTS_PAUSE_USD: no facts run starts (the versions stay queued;
 * nothing is failed or counted). Pulls and screenshot and source captures go on until `spendPaused`.
 */
export async function factsPaused(db: D1Database): Promise<boolean> {
  return (await totalSpend(db)) >= FACTS_PAUSE_USD;
}

/** The run's steps, once: a duplicate callback finds the row and writes nothing. Best effort. */
async function recordAgentSteps(db: D1Database, runId: string, numSteps: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO spend (id, kind, amount_usd, ref, at)
         SELECT ?1, 'agent_step', ?2, ?3, ?4
         WHERE NOT EXISTS (SELECT 1 FROM spend WHERE kind = 'agent_step' AND ref = ?3)`,
      )
      .bind(crypto.randomUUID(), PRICES.agent_step * numSteps, runId, new Date().toISOString())
      .run();
  } catch (err) {
    logError("spend write failed agent_step", err);
  }
}

// --- captureVersion -----------------------------------------------------------------

/**
 * Captures what is still missing for one version. It runs in waitUntil and in the
 * cron, so it never throws: an unexpected error is logged and the version keeps what
 * was already written.
 */
export async function captureVersion(env: Env, versionId: string): Promise<void> {
  try {
    await capture(env, versionId);
  } catch (err) {
    logError(`capture of version ${versionId} failed`, err);
  }
}

async function capture(env: Env, versionId: string): Promise<void> {
  const db = env.DB;
  const version = await getVersion(db, versionId);
  if (version === null) return;
  const page = await getPage(db, version.page_id);
  if (page === null) return;

  const factsNeeded = await loadNeedsFacts(db, page, version);
  const wantShot = version.screenshot_key === null;
  const wantSource = version.html_key === null;
  const factsMissing = factsNeeded && version.facts_json === null;

  // Nothing left that could cost money: settle the status and stop.
  if (!wantShot && !wantSource && !factsMissing) {
    if (version.capture_status !== "complete") await updateCapture(db, versionId, { capture_status: "complete" });
    return;
  }

  // The spend pause comes before any TinyFish call and uses no attempt.
  if (await spendPaused(db)) {
    await updateCapture(db, versionId, { capture_error: "spend_paused" });
    return;
  }

  // Only facts are outstanding: they are the queue's business, and no attempt is used.
  if (!wantShot && !wantSource) {
    await settleStatus(db, version, factsNeeded);
    if (version.agent_run_id === null) await startNextFacts(env);
    return;
  }

  // Counted in SQL, so two captures of one version at once both count.
  if ((await addCaptureAttempt(db, versionId)) === null) return;

  // At the same time: waitUntil work is cut about 30 s after the response and a
  // screenshot alone takes about 15 s. Each writes its own column when it is done.
  const [shot, source] = await Promise.allSettled([
    wantShot ? captureScreenshot(env, versionId, page.url) : Promise.resolve(),
    wantSource ? captureSource(env, versionId, page.url) : Promise.resolve(),
  ]);
  const failures: string[] = [];
  if (shot.status === "rejected") failures.push(`screenshot: ${codeOf(shot.reason, "store_failed")}`);
  if (source.status === "rejected") failures.push(`source: ${codeOf(source.reason, "store_failed")}`);

  // Read the row again: the captures wrote their keys, and a facts result may have landed.
  const now = await getVersion(db, versionId);
  if (now === null) return;
  const status = captureStatusFor(now, factsNeeded);
  const error = withExhaustedFacts(withErrors(now.capture_error, ["screenshot", "source"], failures), status, now, factsNeeded);
  await updateCapture(db, versionId, { capture_status: status, capture_error: error });
  // A facts result can land between that read and that write; read once more and settle.
  const after = await getVersion(db, versionId);
  await settleStatus(db, after, factsNeeded);

  // The queue starts the oldest waiting version, which may be this one or an older one.
  if (factsNeeded && after !== null && after.facts_json === null && after.agent_run_id === null) await startNextFacts(env);
}

async function captureScreenshot(env: Env, versionId: string, url: string): Promise<void> {
  let bytes: ArrayBuffer;
  try {
    ({ bytes } = await captureDeps.screenshotFullPage(env, url));
  } catch (err) {
    throw new CaptureFailure(codeOf(err, "cdp_failed", true));
  }
  const key = `shots/${versionId}.jpg`;
  await env.STORE.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await updateCapture(env.DB, versionId, { screenshot_key: key });
}

async function captureSource(env: Env, versionId: string, url: string): Promise<void> {
  let fetched: Awaited<ReturnType<typeof fetchPage>>;
  try {
    fetched = await fetchPage(env, url, "html");
  } catch (err) {
    throw new CaptureFailure(codeOf(err, "request_failed"));
  }
  if (!fetched.ok) throw new CaptureFailure(clean(fetched.error) || "fetch_error");
  if (fetched.text.trim() === "") throw new CaptureFailure("empty_page");
  const key = `html/${versionId}.html`;
  await env.STORE.put(key, fetched.text, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await updateCapture(env.DB, versionId, { html_key: key });
}

// --- The facts queue ------------------------------------------------------------------

function factsCallbackUrl(env: Env): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/hooks/agent/${env.WEBHOOK_SECRET}`;
}

/**
 * The wait startFactsRun is given when it must not wait. Work in waitUntil (a capture, an
 * Agent callback) is cut about 30 s after the response, so a 60 s wait would die holding the
 * claim and freeze the queue: instead the first rate limit ends the start, and the claim is
 * given back at once.
 */
const noWait = (): Promise<void> =>
  Promise.reject(new TinyFishError(429, "RATE_LIMIT_EXCEEDED", "TinyFish HTTP 429 RATE_LIMIT_EXCEEDED"));

/**
 * Starts the facts run of the oldest queued version, if the single slot is free. True
 * when a run was started. Never throws. A rate-limited start gives the slot back at once
 * unless `waitOnRateLimit` is set (only the cron, which can wait, sets it): then it waits
 * 60 s and retries, up to three times.
 */
export async function startNextFacts(env: Env, opts: { waitOnRateLimit?: boolean } = {}): Promise<boolean> {
  try {
    return await startNext(env, opts.waitOnRateLimit === true);
  } catch (err) {
    logError("facts start failed", err);
    return false;
  }
}

async function startNext(env: Env, waitOnRateLimit: boolean): Promise<boolean> {
  const db = env.DB;
  // The facts pause comes first (FACTS_PAUSE_USD is below SPEND_PAUSE_USD, so this covers the spend pause too).
  if (await factsPaused(db)) return false;
  const next = await nextFactsCandidate(db);
  if (next === null) return false;
  const token = `claim:${new Date().toISOString()}`;
  if (!(await claimFactsSlot(db, next.id, token))) return false;

  let runId: string;
  try {
    const sleep = waitOnRateLimit ? captureDeps.sleep : noWait;
    ({ runId } = await startFactsRun(env, next.url, factsCallbackUrl(env), { sleep }));
  } catch (err) {
    await settleFailedStart(db, next.id, token, err);
    return false;
  }
  // Recorded only while this start's claim still holds the slot: a claim released in the
  // meantime (the cron's sweep) may already have let another start through.
  const row = await updateIfFactsHolder(db, next.id, token, { agent_run_id: runId });
  if (row === null) {
    console.error(`facts run ${runId.slice(0, 100)} started after the claim on version ${next.id} was released`);
    return false;
  }
  // It was a facts candidate, so it needs facts.
  await settleStatus(db, row, true);
  return true;
}

/**
 * Settles a facts start that failed. Every write is conditional on this start's claim token,
 * so a claim that was released and taken again in the meantime is left alone.
 * - Still rate-limited: the shared account is busy, not this version failing. The claim is
 *   given back with no attempt used, and the version stays queued.
 * - Refused by TinyAgent (an HTTP error): no run exists. The claim is given back and an
 *   attempt is used.
 * - No answer, or a 2xx without a run id: a run may exist, and two must never be in flight.
 *   The claim is kept for the cron's sweep to release, and an attempt is used.
 */
async function settleFailedStart(db: D1Database, versionId: string, token: string, err: unknown): Promise<void> {
  const rateLimited = err instanceof TinyFishError && err.code === "RATE_LIMIT_EXCEEDED";
  const refused = err instanceof TinyFishError && err.code !== "no_run_id";
  if (!refused) logError(`facts start for version ${versionId} may have created a run; claim kept`, err);
  const code = rateLimited ? "rate_limited" : codeOf(err, "request_failed");
  const added = rateLimited ? 0 : 1;
  const v = await getVersion(db, versionId);
  if (v === null) return;
  const row = await updateIfFactsHolder(
    db,
    versionId,
    token,
    {
      agent_run_id: refused ? null : undefined,
      // It was a facts candidate, so it needs facts.
      capture_status: captureStatusFor({ ...v, capture_attempts: v.capture_attempts + added }, true),
      capture_error: withErrors(v.capture_error, ["facts"], [`facts: ${code}`]),
    },
    added,
  );
  await settleStatus(db, row, true);
}

const STATUS_SHAPE = /^[A-Za-z_]{1,32}$/;

/**
 * Records the end of a facts run (from the Agent callback or the cron's follow-up).
 * COMPLETED with a non-empty list of facts stores them; anything else uses an
 * attempt and puts the version back in the queue (or fails it at the cap). Then the
 * next queued version is started.
 */
export async function recordFactsResult(
  env: Env,
  runId: string,
  status: string,
  result: unknown,
  numSteps: number | null,
): Promise<void> {
  const db = env.DB;
  if (runId.startsWith("claim:")) return; // a claim token is not a run
  const version = await getVersionByAgentRunId(db, runId);
  if (version === null) return;

  if (typeof numSteps === "number" && Number.isFinite(numSteps) && numSteps >= 0) {
    await recordAgentSteps(db, runId, numSteps);
  }

  // Facts already stored: this is a duplicate callback.
  if (version.facts_json === null) {
    const page = await getPage(db, version.page_id);
    const factsNeeded = page === null || (await loadNeedsFacts(db, page, version));
    const label = STATUS_SHAPE.test(status) ? status.toUpperCase() : "unknown";
    const facts = label === "COMPLETED" ? parseFacts(result) : null;

    // Both writes hold only while the version still holds this run: a second settlement of the
    // same run (a late callback and the cron's follow-up) can never clear or count a newer one.
    if (facts !== null && facts.length > 0) {
      const factsJson = JSON.stringify(facts);
      const row = await updateIfFactsHolder(db, version.id, runId, {
        facts_json: factsJson,
        capture_status: captureStatusFor({ ...version, facts_json: factsJson }, factsNeeded),
        capture_error: withErrors(version.capture_error, ["facts"], []),
      });
      await settleStatus(db, row, factsNeeded);
    } else {
      const reason = label !== "COMPLETED" ? label : facts === null ? "unparseable" : "empty";
      const row = await updateIfFactsHolder(
        db,
        version.id,
        runId,
        {
          agent_run_id: null,
          capture_status: captureStatusFor({ ...version, capture_attempts: version.capture_attempts + 1 }, factsNeeded),
          capture_error: withErrors(version.capture_error, ["facts"], [`facts: ${reason}`]),
        },
        1,
      );
      // Another settlement of this run got there first: its attempt and its chain stand.
      if (row === null) return;
      await settleStatus(db, row, factsNeeded);
    }
  }

  // The slot is free again (or was never this run's): start the next queued version.
  await startNextFacts(env);
}
