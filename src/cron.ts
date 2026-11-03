// The hourly cron (spec 4.4): the safety net behind the webhook's waitUntil work. It keeps
// the serial facts queue moving (stale claims, runs whose callback was lost, rate-limited
// starts), pulls Monitor checks whose scheduled run never arrived, retires public pages at the
// end of their week, flags pages whose Monitor TinyFish no longer runs, and retries captures
// that did not finish.
//
// Repair comes last and is capped (REPAIR_PER_TICK): each capture makes several outbound
// requests, the free plan allows 50 per invocation, and a backlog must never starve the
// cheap steps before it. Pulls are capped too (PULLS_PER_TICK), and each runs in its own Worker
// invocation. Each step is wrapped on its own, so one failing step never stops the others, and
// runCron never throws. It logs one summary line; errors are logged by code, never with a
// secret or page text.
import { captureVersion, recordFactsResult, spendPaused, startNextFacts } from "./capture";
import { lastTickAtOrBefore } from "./core/cronTick";
import { CAPTURE_MAX_ATTEMPTS, MONITOR_LOOKUPS_PER_TICK, PULLS_PER_TICK, REPAIR_PER_TICK } from "./core/limits";
import { expiredPublicPages, monitoredPages, setPageStatusIf } from "./db/pages";
import { pullCandidates } from "./db/runs";
import { inFlightFactsRuns, listFactsClaims, pendingCaptures, updateIfFactsHolder } from "./db/versions";
import type { Env } from "./env";
import { getRun } from "./tinyfish/agent";
import { TinyFishError } from "./tinyfish/client";
import { deleteMonitor, getMonitor, listMonitors, UNKNOWN_STATUS } from "./tinyfish/monitor";

/**
 * The seams tests use instead of vi.mock (which does not work in the Workers pool). `pull` runs one
 * overdue-check pull: by default a request through the SELF service binding to the admin pull route,
 * so the pull is a Worker invocation of its own with a request's CPU and subrequest budget (one
 * normalization per invocation, never twenty in the cron's). `now` is the overdue check's clock.
 */
export const cronDeps = {
  pull: (env: Env, pageId: string): Promise<Response> =>
    env.SELF.fetch(
      new Request(`https://fineprint.internal/api/admin/pull/${encodeURIComponent(pageId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
      }),
    ),
  now: (): Date => new Date(),
};

const MINUTE_MS = 60_000;
/** A scheduled run that has not arrived this long after its tick is overdue. */
const OVERDUE_AFTER_MS = 15 * MINUTE_MS;
/** A version this old whose capture is unfinished is retried: the webhook's own capture has ended by then. */
const REPAIR_AFTER_MS = 10 * MINUTE_MS;
/** A claim token this old belongs to a start that was cut off or may have created a run. */
const CLAIM_STALE_AFTER_MS = 10 * MINUTE_MS;
/** A facts run whose version is this old is looked up, in case its callback was lost. */
const FOLLOW_UP_AFTER_MS = 15 * MINUTE_MS;
/** A run not finished this long after it started is given up (runs are capped at 120 s). */
const RUN_STALE_AFTER_MS = 60 * MINUTE_MS;

const TERMINAL_AGENT_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const CLAIM_PREFIX = "claim:";

export type CronResult = {
  /** Versions whose capture was retried. */
  repaired: number;
  /** Public pages marked expired. */
  expired: number;
  /** Pages marked failed because TinyFish does not run their Monitor. */
  unhealthy: string[];
  /** Overdue checks pulled with run-now and recorded. */
  pulled: number;
};

export async function runCron(env: Env): Promise<CronResult> {
  const result: CronResult = { repaired: 0, expired: 0, unhealthy: [], pulled: 0 };
  await step("facts upkeep", () => factsUpkeep(env));
  await step("overdue pulls", () => pullOverdue(env, result));
  await step("expiry", () => expire(env, result));
  await step("health", () => health(env, result));
  await step("repair", () => repair(env, result));
  console.log("cron", {
    repaired: result.repaired,
    expired: result.expired,
    unhealthy: result.unhealthy.length,
    pulled: result.pulled,
  });
  return result;
}

async function step(name: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    logError(`cron ${name} failed`, err);
  }
}

function logError(what: string, err: unknown): void {
  if (err instanceof TinyFishError) {
    console.error(what, `${err.name} status=${err.status} code=${err.code}`);
  } else {
    console.error(what, err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  }
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

// --- 1. Facts upkeep --------------------------------------------------------------------

async function factsUpkeep(env: Env): Promise<void> {
  await step("stale claims", () => releaseStaleClaims(env));
  await step("facts follow-up", () => followUpRuns(env));
  // The one place that waits out rate limits: the cron has minutes of wall time, where
  // waitUntil work does not. A no-op while a run is in flight.
  await startNextFacts(env, { waitOnRateLimit: true });
}

/**
 * Releases every claim token older than 10 minutes, whatever the version's status. A token
 * whose time cannot be read was not written by a start (they all write `claim:<iso>`) and is
 * released too. Each release holds only while the version still has that token.
 */
async function releaseStaleClaims(env: Env): Promise<void> {
  const cutoff = Date.now() - CLAIM_STALE_AFTER_MS;
  for (const { id, agent_run_id: token } of await listFactsClaims(env.DB)) {
    const claimedAt = Date.parse(token.slice(CLAIM_PREFIX.length));
    if (Number.isFinite(claimedAt) && claimedAt > cutoff) continue;
    if ((await updateIfFactsHolder(env.DB, id, token, { agent_run_id: null })) !== null) {
      console.warn(`cron released a stale facts claim on version ${id}`);
    }
  }
}

/**
 * Looks up every facts run in flight on a version captured over 15 minutes ago. A finished
 * run is recorded as its callback would have been. A run that is not finished an hour after it
 * started is recorded as STALE, a facts failure that frees the slot. Its age comes from the
 * run's own start time: the queue starts a version's run long after the version was captured
 * when it waited behind others. Only when TinyAgent gives no readable start time is the
 * version's capture time used.
 *
 * A run that cannot be read is left for the next tick, except one TinyAgent does not know
 * (404) on a version captured over an hour ago, which is recorded as STALE too, so a run that
 * can never be read cannot hold the single slot for good. Any other error (a 429, a 5xx, a lost
 * connection) is left whatever the age: with no run read there is only the capture time, and a
 * transient error must never make a chained run that started seconds ago STALE.
 */
async function followUpRuns(env: Env): Promise<void> {
  for (const version of await inFlightFactsRuns(env.DB, isoAgo(FOLLOW_UP_AFTER_MS))) {
    const runId = version.agent_run_id;
    const capturedAt = Date.parse(version.captured_at);
    try {
      let run: Awaited<ReturnType<typeof getRun>>;
      try {
        run = await getRun(env, runId);
      } catch (err) {
        logError(`cron could not read facts run ${runId.slice(0, 100)}`, err);
        const notFound = err instanceof TinyFishError && err.status === 404;
        if (notFound && Date.now() - capturedAt > RUN_STALE_AFTER_MS) await recordStale(env, runId);
        continue;
      }
      const status = run.status.toUpperCase();
      if (TERMINAL_AGENT_STATUSES.has(status)) {
        await recordFactsResult(env, runId, status, run.result, run.num_of_steps);
        continue;
      }
      const startedAt = run.created_at === null ? NaN : Date.parse(run.created_at);
      const since = Number.isFinite(startedAt) ? startedAt : capturedAt;
      if (Date.now() - since > RUN_STALE_AFTER_MS) await recordStale(env, runId);
    } catch (err) {
      logError(`cron follow-up of facts run ${runId.slice(0, 100)} failed`, err);
    }
  }
}

/** A facts failure that frees the slot: one attempt used, then the next queued version starts. */
async function recordStale(env: Env, runId: string): Promise<void> {
  console.warn(`cron recorded facts run ${runId.slice(0, 100)} as STALE`);
  await recordFactsResult(env, runId, "STALE", null, null);
}

// --- 2. Overdue pulls -------------------------------------------------------------------

const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A short code from a pull's JSON answer (`reason`, else `error`), or "unknown". */
function codeIn(body: unknown): string {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  for (const value of [record.reason, record.error]) {
    if (typeof value === "string" && CODE_SHAPE.test(value)) return value;
  }
  return "unknown";
}

/**
 * Webhooks are the primary trigger; this is the fallback when one never came. For each active or failed
 * page with a Monitor (health's `failed` never stops the recording: run-now works on a Monitor whose
 * schedule TinyFish no longer runs), T is its schedule's last tick at or before now − 15 minutes; the page is overdue
 * when T exists and none of its runs (any trigger) was received at or after T. A page created after
 * T has its create run after T, so it is not overdue. Nothing is pulled at the spend pause. At most
 * PULLS_PER_TICK pages are pulled, oldest T first, one at a time, each through `cronDeps.pull` (its
 * own Worker invocation); a pull that fails is logged by status and code and the next one goes on.
 * A page whose pull recorded nothing (no text, a fetch error) stays overdue for the next tick.
 */
async function pullOverdue(env: Env, result: CronResult): Promise<void> {
  if (await spendPaused(env.DB)) {
    console.warn("cron overdue pulls skipped: the spend pause is reached");
    return;
  }
  const cutoff = new Date(cronDeps.now().getTime() - OVERDUE_AFTER_MS);
  const due: { id: string; tick: number }[] = [];
  for (const page of await pullCandidates(env.DB)) {
    const tick = page.schedule_cron === null ? null : lastTickAtOrBefore(page.schedule_cron, cutoff);
    if (tick === null) continue;
    if (page.last_received_at !== null && page.last_received_at >= tick.toISOString()) continue;
    due.push({ id: page.id, tick: tick.getTime() });
  }
  due.sort((a, b) => a.tick - b.tick); // stable: pages due at the same tick keep their creation order

  for (const { id } of due.slice(0, PULLS_PER_TICK)) {
    try {
      const res = await cronDeps.pull(env, id);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        console.error(`cron pull of page ${id} failed`, `status=${res.status} code=${codeIn(body)}`);
      } else if ((body as { pulled?: unknown } | null)?.pulled === true) {
        result.pulled += 1;
      } else if ((body as { pulled?: unknown } | null)?.pulled === false) {
        console.warn(`cron pull of page ${id} recorded nothing`, `reason=${codeIn(body)}`);
      }
    } catch (err) {
      logError(`cron pull of page ${id} failed`, err);
    }
  }
}

// --- 3. Expiry ------------------------------------------------------------------------

/**
 * Public pages past `expires_at`: the Monitor is deleted (a 404 counts as deleted), then the
 * page is marked expired. Its versions and runs stay. A delete that fails otherwise leaves the
 * page as it is for the next tick, so the Monitor and the page never drift apart.
 */
async function expire(env: Env, result: CronResult): Promise<void> {
  for (const page of await expiredPublicPages(env.DB, new Date().toISOString())) {
    try {
      if (page.monitor_id !== null) await deleteMonitor(env, page.monitor_id);
      if (await setPageStatusIf(env.DB, page.id, "expired", ["active", "paused", "failed"])) result.expired += 1;
    } catch (err) {
      logError(`cron could not expire page ${page.id}`, err);
    }
  }
}

// --- 4. Health ------------------------------------------------------------------------

/**
 * One list of the account's Monitors. An active page whose Monitor is in it with a status other than
 * `active` is marked failed, and a failed page whose Monitor reads `active` goes back to `active`.
 * A Monitor missing from the list is looked up on its own (the list may stop at a page size it does
 * not announce), at most MONITOR_LOOKUPS_PER_TICK a tick, active pages before failed ones: the page
 * is marked failed when that lookup answers 404, or answers with a status other than `active` (a
 * failed page stays failed); a Monitor that reads back `active` counts as the list's `active`, and a
 * lookup error leaves the page as it is. A Monitor whose status is missing or "unknown" (in either
 * answer, see src/tinyfish/monitor.ts) is no evidence: the page is left as it is, so a changed
 * response shape cannot fail every page. A failed page keeps being pulled (see pullOverdue), so
 * `failed` is a signal and never stops the recording. Health never changes a Monitor (the account is
 * shared with other projects, whose Monitors are in the list). A list that holds none of our
 * Monitors is not trusted (a changed response shape reads as an empty list), and health is skipped
 * that tick, as it is when the list cannot be read.
 */
async function health(env: Env, result: CronResult): Promise<void> {
  const pages = await monitoredPages(env.DB);
  if (pages.length === 0) return;

  let monitors: Awaited<ReturnType<typeof listMonitors>>;
  try {
    monitors = await listMonitors(env);
  } catch (err) {
    logError("cron health skipped: the Monitor list could not be read", err);
    return;
  }
  const statusById = new Map(monitors.map((m) => [m.id, m.status.toLowerCase()]));
  if (!pages.some((p) => statusById.has(p.monitor_id))) {
    console.error(`cron health skipped: the Monitor list (${monitors.length} entries) holds none of our ${pages.length} Monitors`);
    return;
  }

  let lookups = 0;
  for (const page of pages) {
    // The Monitor's status: undefined when the list does not hold it, null when TinyFish has no such Monitor.
    let status: string | null | undefined = statusById.get(page.monitor_id);
    if (status === undefined) {
      if (lookups >= MONITOR_LOOKUPS_PER_TICK) continue; // looked up on a later tick
      lookups += 1;
      try {
        const found = await getMonitor(env, page.monitor_id);
        status = found === null ? null : found.status.toLowerCase();
      } catch (err) {
        logError(`cron health could not look up the Monitor of page ${page.id}`, err);
        continue;
      }
    }
    if (status === UNKNOWN_STATUS) continue; // no evidence either way
    if (status === "active") {
      if (page.status === "failed" && (await setPageStatusIf(env.DB, page.id, "active", ["failed"]))) {
        console.warn(`cron health: the Monitor of page ${page.id} reads active again, so the page is active`);
      }
    } else if (await setPageStatusIf(env.DB, page.id, "failed", ["active"])) {
      result.unhealthy.push(page.id);
    }
  }
}

// --- 5. Repair ------------------------------------------------------------------------

/**
 * Retries, one at a time, the REPAIR_PER_TICK oldest pending or partial captures older than 10
 * minutes with attempts left, skipping versions of expired pages. The rest wait for later ticks.
 */
async function repair(env: Env, result: CronResult): Promise<void> {
  const due = await pendingCaptures(env.DB, isoAgo(REPAIR_AFTER_MS), CAPTURE_MAX_ATTEMPTS, REPAIR_PER_TICK);
  // One at a time: a capture can start a facts run, and Fineprint keeps one in flight.
  for (const version of due) {
    result.repaired += 1;
    await captureVersion(env, version.id); // never throws
  }
}
