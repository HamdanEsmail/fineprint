// Admin-only operations (spec 4.8): replay a page's stored raw payloads through the change gate,
// re-point every Monitor's webhook at a new host, and pull one overdue Monitor check. Each route
// checks the admin token first, so an unknown page or a bad body never tells a stranger anything.
import { Hono } from "hono";
import { adminOnly, productionHostOnly } from "../auth";
import { needsFacts, spendPaused } from "../capture";
import { isFetchFailure, judgeChange, normalizedHash, readIgnorePatterns, type Verdict } from "../core/gate";
import { PULL_BACKOFF_AFTER_FAILURES, PULL_BACKOFF_MS } from "../core/limits";
import { PRICES, recordSpendOnce } from "../core/spend";
import { changedRunsForReplay, clearNoise, markNoise } from "../db/runs";
import { deleteCachedDiffsOfPage } from "../db/diffCache";
import { clearPullFailures, getPage, listPageIdsAfter, listPages, notePullFailure, setPageStatusIf, updatePage } from "../db/pages";
import type { VersionRow } from "../db/types";
import { baselineVersion, countVersionsWithoutThumb, getVersion, insertVersion, latestVersion, versionsWithoutThumb } from "../db/versions";
import type { Env } from "../env";
import { dropCachedWatchlist, sweepStoredScreens } from "../site/htmlCache";
import { rebuildScreen } from "../site/rebuild";
import { warmDiff } from "../readModel";
import { recordMonitorRun, type MonitorRun } from "../record";
import { fillDeltas, fillSummaries, requestSummary } from "../summary";
import { thumbnailFromScreenshot } from "../thumbs";
import { TinyFishError } from "../tinyfish/client";
import { deleteMonitor, runMonitorNow, updateMonitor } from "../tinyfish/monitor";
import { codeOf, pageToJson, readBody } from "./pages";
import { parseStoredRun, type StoredRun } from "./webhooks";

export const adminRouter = new Hono<{ Bindings: Env }>();

// Never logs more than a TinyFish failure's status and code, or another error's name: a message
// could hold what TinyFish echoed back, which for a webhook update is the secret url.
function logFailure(what: string, err: unknown): void {
  if (err instanceof TinyFishError) console.error(what, `${err.name} status=${err.status} code=${err.code}`);
  else console.error(what, err instanceof Error ? err.name : "unknown error");
}

adminRouter.onError((err, c) => {
  // The page text is never logged: only the error's name and the first part of its message.
  console.error("admin handler failed", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  return c.json({ error: "internal_error" }, 500);
});

// --- Replay -------------------------------------------------------------------------------------

/** What the next run is compared with: the newest version so far, read only when a run needs it. */
type Chain = { versionId: string | null; loaded: VersionRow | null };

async function chainVersion(db: D1Database, chain: Chain): Promise<VersionRow | null> {
  if (chain.loaded === null && chain.versionId !== null) chain.loaded = await getVersion(db, chain.versionId);
  return chain.loaded;
}

/** A stored raw body of either shape, or null when the object is missing or is not a Monitor run. */
async function readRaw(store: R2Bucket, key: string): Promise<StoredRun | null> {
  const object = await store.get(key);
  return object === null ? null : parseStoredRun(await object.text());
}

/** What the replay decided about one run. */
type ReplayDecision =
  | "existing_version"
  | "created"
  | "normalized_identical"
  | "partial_render"
  | "layout_hold"
  | "flap"
  | "skipped_unreadable";

/** The gate's verdict as a replay decision. */
function decisionOf(verdict: Verdict): Exclude<ReplayDecision, "existing_version"> {
  switch (verdict.kind) {
    case "new_version":
      return "created";
    case "suppressed":
      return verdict.reason;
    case "partial_suspect":
      return "partial_render";
    case "layout_hold":
      return "layout_hold";
    case "fetch_error":
      return "skipped_unreadable";
  }
}

/**
 * Walks the page's `changed` runs that kept a raw body, oldest first, against a chain that starts at
 * the baseline version, and decides each one again with the gate as it is now (src/core/gate.ts: the
 * normalization, the partial-render guard, the layout hold and flap suppression, as of the run's own receipt
 * time). The body may be a webhook payload or the 201 body of a run-now pull. A run that was a suspect read
 * is counted as suppressed (`partial_render` or `layout_hold`); the replay schedules no confirm reads.
 * - a run that already made a version is left alone and the chain moves to that version, without its
 *   raw body being read. With `?would_now_be=1` the body is read and the answer also says what the gate
 *   would decide for it now (`would_now_be`); that is opt-in because it normalizes every such run, which
 *   does not fit the 10 ms CPU budget for a page with a long history. Either way nothing is changed;
 * - a body that is missing, unreadable, empty or carries an error is skipped (counted nowhere);
 * - a read that normalizes to the chain's text, is a suspect partial render or layout hold, or repeats a
 *   text of the last 72 hours is suppressed (and marked as noise, with that reason, if it was not);
 * - any other read becomes a version, dated by the run's receipt time, with the note
 *   `created by replay on <iso>` (after any note of the gate's own), left `pending` with
 *   `capture_error "replayed"` for the hourly repair, and its run stops counting as noise. Its summary
 *   is TinyFish's when the body had one; otherwise the diff line is asked for after the answer.
 * Nothing is captured and TinyFish is never called. The replay only adds: it never deletes or changes
 * a version (R79). Each write is made as it is decided, so a replay that is cut off keeps what it wrote,
 * and running it again creates nothing twice. It does not resume where it stopped, though: every run is
 * walked again from the baseline; the runs it turned into versions are then skipped without a read, but
 * each run without a version (the suppressed ones included) is read and normalized again, so a replay
 * that ran out of CPU on such runs runs out at about the same place.
 * The page's cached diffs are dropped before the first write, so a cut-off replay leaves none stale.
 */
adminRouter.post("/pages/:id/replay", adminOnly, async (c) => {
  const db = c.env.DB;
  const page = await getPage(db, c.req.param("id"));
  if (!page) return c.json({ error: "not_found" }, 404);
  const wantWouldNowBe = c.req.query("would_now_be") === "1";
  const replayNote = `created by replay on ${new Date().toISOString()}`;

  const chain: Chain = { versionId: (await baselineVersion(db, page.id))?.id ?? null, loaded: null };
  // The gate sees the page as the replay does: no confirm read pending, so a suspect is a suspect.
  const judged = { id: page.id, ignore_patterns: page.ignore_patterns };
  let created = 0;
  let suppressed = 0;
  let lastChange = page.last_change_at;
  let purged = false;
  const decisions: { run_id: string; monitor_run_id: string; received_at: string; decision: ReplayDecision; would_now_be?: ReplayDecision }[] = [];

  /** Called before every write: the page's cached diffs hold counts the write makes wrong. */
  const beforeWrite = async (): Promise<void> => {
    if (purged) return;
    await deleteCachedDiffsOfPage(db, page.id);
    purged = true;
  };

  /** What the gate decides for this read now, against the chain. */
  const judge = async (stored: StoredRun, receivedAt: string, ownVersionId?: string): Promise<Verdict> => {
    const latest = await chainVersion(db, chain);
    return judgeChange(db, judged, stored, Date.parse(receivedAt), {
      latest: latest === null ? null : { id: latest.id, normalized_hash: latest.normalized_hash, text: latest.text },
      replay: { exceptVersionId: ownVersionId },
    });
  };

  for (const run of await changedRunsForReplay(db, page.id)) {
    const entry = { run_id: run.id, monitor_run_id: run.monitor_run_id, received_at: run.received_at };

    // A version that exists is history whether or not its body survived, and the next run is compared
    // with it, as the live gate would have. Only the answer to "and now?" needs the body, and only when asked.
    if (run.version_id !== null) {
      if (wantWouldNowBe) {
        const stored = await readRaw(c.env.STORE, run.raw_key!);
        const wouldNowBe = stored === null ? "skipped_unreadable" : decisionOf(await judge(stored, run.received_at, run.version_id));
        decisions.push({ ...entry, decision: "existing_version", would_now_be: wouldNowBe });
      } else {
        decisions.push({ ...entry, decision: "existing_version" });
      }
      chain.versionId = run.version_id;
      chain.loaded = null;
      continue;
    }

    const stored = await readRaw(c.env.STORE, run.raw_key!);
    if (stored === null || isFetchFailure(stored)) {
      decisions.push({ ...entry, decision: "skipped_unreadable" });
      continue;
    }

    const verdict = await judge(stored, run.received_at);
    if (verdict.kind === "suppressed" || verdict.kind === "partial_suspect" || verdict.kind === "layout_hold") {
      const reason = verdict.kind === "suppressed" ? verdict.reason : decisionOf(verdict);
      suppressed++;
      if (run.noise_suppressed !== 1 || run.noise_reason !== reason) {
        await beforeWrite();
        await markNoise(db, run.id, reason);
      }
      decisions.push({ ...entry, decision: reason });
      continue;
    }
    if (verdict.kind !== "new_version") {
      decisions.push({ ...entry, decision: "skipped_unreadable" });
      continue;
    }

    // The flag comes off first: if the insert then fails, the next replay finds a run with no
    // version and judges it again, which is right whichever way it goes.
    await beforeWrite();
    if (run.noise_suppressed !== 0 || run.noise_reason !== null) await clearNoise(db, run.id);
    const versionId = crypto.randomUUID();
    await insertVersion(db, {
      id: versionId,
      page_id: page.id,
      run_id: run.id,
      is_baseline: 0,
      captured_at: run.received_at,
      text: stored.text,
      normalized_hash: verdict.hash,
      judgment_summary: stored.judgmentSummary,
      capture_status: "pending",
      capture_error: "replayed",
      facts_status: needsFacts(page, { is_baseline: 0 }, run) ? "pending" : "not_needed",
      // The durable marker: capture_error "replayed" is dropped by the first capture, this note stays.
      notes: verdict.notes === undefined ? replayNote : `${verdict.notes}; ${replayNote}`,
    });
    created++;
    decisions.push({ ...entry, decision: "created" });
    if (lastChange === null || run.received_at > lastChange) {
      await updatePage(db, page.id, { last_change_at: run.received_at });
      lastChange = run.received_at;
    }
    chain.versionId = versionId;
    chain.loaded = null;
  }

  // A created version without TinyFish's summary gets its diff line in an invocation of its own.
  if (created > 0) c.executionCtx.waitUntil(requestSummary(c.env));
  return c.json({ created, suppressed, decisions });
});

// --- Summaries ----------------------------------------------------------------------------------

/**
 * Fills the one-line summary of non-baseline versions that have none (src/summary.ts), and answers
 * `{filled, remaining, oversized}`. `?version=<id>` fills that one version only, whatever its size (a new
 * version asks for its own this way, through the SELF binding). Without it: every TinyFish summary, then
 * the diff lines that fit a per-call text budget, oldest first; a version whose diff alone is over the
 * budget is skipped and listed in `oversized`, to be filled with `?version=<id>`. So the one-off backfill
 * is this route called until `filled` is 0, then once with `?version=` for each id in `oversized`.
 * Baselines keep no summary, and a stored summary is never replaced, so calling it again changes nothing.
 */
adminRouter.post("/admin/backfill-summaries", adminOnly, async (c) => {
  const versionId = c.req.query("version");
  return c.json(await fillSummaries(c.env, versionId === undefined ? {} : { versionId }));
});

// --- Deltas -------------------------------------------------------------------------------------

/**
 * Fills the delta (block and fact counts, and the layout-only label) of non-baseline versions that have a
 * summary and no delta (src/summary.ts), and answers `{filled, rebuilt, facts_filled, remaining, oversized}`.
 * Computing a version's delta also rebuilds its diff summary under the line rule (`rebuilt`), once, since
 * each version gets its delta once; TinyFish summaries are never touched. The facts part of a delta is added
 * once both of its versions have stored facts (`facts_filled`). `?version=<id>` fills that one version,
 * whatever its size; otherwise the call works within the same budget as the summary fill and lists in
 * `oversized` the versions to fill with `?version=`. So the one-off backfill is this route called until
 * `filled` is 0, then once with `?version=` for each id in `oversized`. The hourly cron calls it while any
 * delta is missing.
 */
adminRouter.post("/admin/backfill-deltas", adminOnly, async (c) => {
  const versionId = c.req.query("version");
  return c.json(await fillDeltas(c.env, versionId === undefined ? {} : { versionId }));
});

// --- Stored screens -------------------------------------------------------------------------------

/**
 * Renders one site screen fresh, exactly as the site route does, and stores it at `screens/<stamp>/<key>` with the
 * same headers (src/site/rebuild.ts): `?key=home|about|watchlist|page/<id>|compare/<id>/<from>/<to>`. Answers
 * `{key, stored}`; `stored` is false for a screen that is not kept (a 404, a page still refreshing for its
 * screenshot). A key of any other kind is 400. The hourly job calls it, one screen to an invocation.
 */
adminRouter.post("/admin/rebuild-html", adminOnly, async (c) => {
  const key = c.req.query("key") ?? "";
  const stored = await rebuildScreen(c.env, new URL(c.req.url).origin, key);
  if (stored === null) return c.json({ error: "invalid_key" }, 400);
  return c.json({ key, stored });
});

/**
 * The clean-up after a deploy (src/site/htmlCache.ts sweepStoredScreens): deletes the stored screens of the stamp
 * the last sweep was for, or, the first time, the copies kept under html/ before the stamp, by name, at most
 * LEGACY_PAGES_PER_SWEEP page ids a call; then records this deploy's stamp. Answers `{stamp, previous, deleted,
 * done}`; `done` false means another call is needed, and a call for a stamp already recorded deletes nothing. The
 * hourly job's rebuild step calls it, in an invocation of its own, while the recorded stamp is not its own. Only
 * on the deployed Worker's own hosts (403 `not_production` on a preview URL, whose stamp is another version's).
 * rebuild-html needs no such guard: a preview's rebuild writes under its own stamp, which production never reads.
 */
adminRouter.post("/admin/sweep-screens", adminOnly, productionHostOnly, async (c) =>
  c.json(await sweepStoredScreens(c.env, (after, limit) => listPageIdsAfter(c.env.DB, after, limit))),
);

// --- Thumbnails ---------------------------------------------------------------------------------

const THUMBS_DEFAULT = 10;
const THUMBS_MAX = 20;

/**
 * Makes thumbnails for versions that have a stored screenshot and no thumbnail, newest first, at most
 * `?limit=` (default 10, at most 20), in one browser session (one `screenshot` spend unit), and answers
 * `{made, remaining}`. Nothing is opened at the spend pause (`reason: "spend_paused"`) or when none is
 * missing. A version whose image did not load stays without one, so a backfill is this route called until
 * `remaining` is 0 or `made` is 0.
 */
adminRouter.post("/admin/thumbs", adminOnly, async (c) => {
  const raw = Number(c.req.query("limit") ?? THUMBS_DEFAULT);
  const limit = Number.isFinite(raw) ? Math.min(THUMBS_MAX, Math.max(1, Math.trunc(raw))) : THUMBS_DEFAULT;
  const db = c.env.DB;
  if (await spendPaused(db)) {
    return c.json({ made: 0, remaining: await countVersionsWithoutThumb(db), reason: "spend_paused" });
  }
  const ids = await versionsWithoutThumb(db, limit);
  let made = 0;
  try {
    made = await thumbnailFromScreenshot(c.env, ids);
  } catch (err) {
    logFailure("thumbs: the browser session failed", err);
    return c.json({ error: "browser_failed", reason: codeOf(err) }, 502);
  }
  return c.json({ made, remaining: await countVersionsWithoutThumb(db) });
});

// --- Retire a page --------------------------------------------------------------------------------

/**
 * Retires a page: its TinyFish Monitor is deleted (a Monitor already gone, 404, counts as deleted) and
 * its status becomes `retired`, which frees its Monitor slot. Its versions, runs and stored objects
 * stay, and the page stays in the list, the export and the history. A retired page is not pulled,
 * health-checked, repaired or expired, and its facts are not queued. A delete that fails otherwise
 * leaves the page as it was (502), so the Monitor and the page cannot drift apart. A page that is
 * already retired or expired is refused (409).
 */
adminRouter.post("/admin/pages/:id/retire", adminOnly, async (c) => {
  const db = c.env.DB;
  const page = await getPage(db, c.req.param("id"));
  if (!page) return c.json({ error: "not_found" }, 404);
  if (page.status === "retired") return c.json({ error: "already_retired" }, 409);
  if (page.status === "expired") return c.json({ error: "page_expired" }, 409);

  if (page.monitor_id !== null) {
    try {
      await deleteMonitor(c.env, page.monitor_id);
    } catch (err) {
      logFailure("retire: Monitor delete failed", err);
      return c.json({ error: "monitor_delete_failed", reason: codeOf(err) }, 502);
    }
  }
  if (!(await setPageStatusIf(db, page.id, "retired", ["active", "paused", "failed"]))) {
    return c.json({ error: "not_retirable" }, 409); // the status changed while the Monitor was being deleted
  }
  // No read of a retired page is awaited any more.
  await updatePage(db, page.id, { pending_hash: null, pending_run_id: null, pending_at: null });
  c.executionCtx.waitUntil(dropCachedWatchlist(c.env, page.id));
  const retired = await getPage(db, page.id);
  return c.json({ retired: true, page: pageToJson(retired ?? { ...page, status: "retired" }) });
});

// --- Rotate the webhook -------------------------------------------------------------------------

/** The base url without trailing slashes, or null unless it is a plain https origin (with an optional path prefix). */
function parseBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * Points every live Monitor (a page with a Monitor that is not expired or retired) at `<base_url>/hooks/monitor/<secret>`.
 * PUBLIC_BASE_URL itself is a Worker var changed at deploy time; this only updates TinyFish. The calls
 * go one at a time, and the answer carries the pages that failed with a reason, never the url or the secret.
 */
adminRouter.post("/admin/rotate-webhook", adminOnly, async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const base = parseBaseUrl(body.base_url);
  if (base === null) return c.json({ error: "invalid_base_url" }, 400);

  // With no secret every Monitor would be pointed at a url the Worker answers 404 to.
  const secret = c.env.WEBHOOK_SECRET;
  if (typeof secret !== "string" || secret === "") return c.json({ error: "webhook_secret_missing" }, 500);
  const webhookUrl = `${base}/hooks/monitor/${secret}`;

  let updated = 0;
  const failed: { page_id: string; reason: string }[] = [];
  for (const page of await listPages(c.env.DB)) {
    if (page.monitor_id === null || page.status === "expired" || page.status === "retired") continue;
    // TinyFish rejects an edit without schedule_cron, so a page with none stored cannot be re-pointed.
    if (page.schedule_cron === null) {
      failed.push({ page_id: page.id, reason: "no_schedule_cron" });
      continue;
    }
    try {
      await updateMonitor(c.env, page.monitor_id, { scheduleCron: page.schedule_cron, webhookUrl });
      updated++;
    } catch (err) {
      logFailure("rotate-webhook: Monitor update failed", err);
      failed.push({ page_id: page.id, reason: codeOf(err) });
    }
  }
  return c.json({ updated, failed });
});

// --- Store a large diff ---------------------------------------------------------------------------

/**
 * Stores the diff of `?version=<id>` and the version before it in diff_cache (src/readModel.ts warmDiff,
 * the same diffVersions every reader uses), and answers `{version_id, from_version_id, stored}`. The hourly
 * cron calls it for one large pair a tick, in an invocation of its own, so the first diff of a 228 KB pair
 * never runs inside a reader's request. 400 without `version`, 404 for an unknown version or a first one.
 */
adminRouter.post("/admin/warm-diff", adminOnly, async (c) => {
  const versionId = c.req.query("version");
  if (versionId === undefined || versionId === "") return c.json({ error: "invalid_version" }, 400);
  const warmed = await warmDiff(c.env, versionId);
  return warmed === null ? c.json({ error: "not_found" }, 404) : c.json(warmed);
});

// --- Pull an overdue check ------------------------------------------------------------------------

/**
 * The one place an overdue check is pulled (the hourly cron calls it through the SELF service
 * binding, one Worker invocation per page, so each pull has a request's own CPU and subrequests).
 * It asks TinyFish to run the page's Monitor now and records that run under TinyFish's run id,
 * marked `pull`, through the same recording path a webhook run takes.
 *
 * - An expired, retired or paused page, or one without a Monitor, is not pulled (409 `not_pullable`); a page
 *   health marked failed is (run-now works whatever the Monitor's schedule is doing, and a deleted
 *   Monitor just fails the pull); at the spend pause nothing is called (200, `pulled: false`). Only
 *   the spend pause stops a pull: the lower facts pause (FACTS_PAUSE_USD) does not.
 * - A run with no text or with errors records nothing: TinyFish does not bill a failed check, and the
 *   page stays overdue for the next tick (200, `pulled: false` with the reason).
 * - A run with text is put on the spend ledger at once, before anything else can fail, once per
 *   TinyFish run id (the shared recording path's write of the same row then adds nothing).
 * - Otherwise the raw 201 body is stored at `raw/<run id>.json` and the outcome is Fineprint's own
 *   (R71): no version yet is the `baseline` and becomes one; text equal to the latest version's
 *   (plain string equality) is `unchanged` and is not normalized; anything else is `changed` and
 *   goes through the change gate. A run id already recorded is a duplicate and writes nothing.
 * - The pull backoff: run-now failing, no text and a fetch error each count as a failed pull; from the
 *   PULL_BACKOFF_AFTER_FAILURES-th in a row the page gets `pull_retry_after` PULL_BACKOFF_MS ahead,
 *   which the cron respects. A pull with text ends it. The refusals above (409, the spend pause) are not
 *   pulls and count for nothing.
 */
adminRouter.post("/admin/pull/:pageId", adminOnly, async (c) => {
  const db = c.env.DB;
  const page = await getPage(db, c.req.param("pageId"));
  if (!page) return c.json({ error: "not_found" }, 404);
  if (page.status === "expired" || page.status === "retired" || page.status === "paused" || page.monitor_id === null) {
    return c.json({ error: "not_pullable" }, 409);
  }
  if (await spendPaused(db)) return c.json({ ok: true, pulled: false, reason: "spend_paused" });

  const failedPull = (): Promise<void> =>
    notePullFailure(db, page.id, PULL_BACKOFF_AFTER_FAILURES, new Date(Date.now() + PULL_BACKOFF_MS).toISOString()).catch((err: unknown) =>
      logFailure(`pull: could not count a failed pull of page ${page.id}`, err),
    );

  let pulled: Awaited<ReturnType<typeof runMonitorNow>>;
  try {
    pulled = await runMonitorNow(c.env, page.monitor_id);
  } catch (err) {
    logFailure(`pull: run-now failed for page ${page.id}`, err);
    await failedPull();
    return c.json({ error: "run_now_failed", reason: codeOf(err) }, 502);
  }

  const run: MonitorRun = {
    id: pulled.runId,
    outcome: "unchanged", // worked out below
    isBaseline: false,
    diffTruncated: false,
    judgmentRelevant: null,
    judgmentSummary: null,
    text: pulled.text ?? "",
    hasErrors: pulled.errors.length > 0,
  };
  if (isFetchFailure(run)) {
    await failedPull();
    return c.json({ ok: true, pulled: false, reason: run.hasErrors ? "fetch_error" : "no_text" });
  }

  // TinyFish billed this check. It goes on the ledger now, once per run id, so a failure anywhere below
  // (or a CPU kill) never leaves a billed check off it.
  try {
    await recordSpendOnce(db, "monitor_check", PRICES.monitor_check, run.id);
  } catch (err) {
    logFailure(`pull: spend write failed for page ${page.id}`, err);
  }
  if (page.pull_failures !== 0 || page.pull_retry_after !== null) {
    await clearPullFailures(db, page.id).catch((err: unknown) => logFailure(`pull: could not end the backoff of page ${page.id}`, err));
  }

  const receivedAt = new Date().toISOString();
  const rawKey = `raw/${run.id}.json`;
  await c.env.STORE.put(rawKey, pulled.raw, { httpMetadata: { contentType: "application/json" } });

  // As the webhook does, the run is judged before it is claimed (src/record.ts).
  let verdict: Verdict | null = null;
  const latest = await latestVersion(db, page.id);
  if (latest === null) {
    run.outcome = "baseline";
    run.isBaseline = true;
    verdict = { kind: "new_version", hash: await normalizedHash(run.text, readIgnorePatterns(page.ignore_patterns)), baseline: true };
  } else if (run.text !== latest.text) {
    run.outcome = "changed";
    verdict = await judgeChange(db, page, run);
  } else if (page.pending_at !== null) {
    // The text is the latest version's byte for byte, and a confirm read is pending: the judge
    // ends it and records the run as identical.
    verdict = await judgeChange(db, page, run);
  }

  const recorded = await recordMonitorRun(c.env, c.executionCtx, { page, run, trigger: "pull", rawKey, receivedAt, verdict });
  if (recorded.kind === "duplicate") return c.json({ ok: true, duplicate: true });
  return c.json({
    ok: true,
    pulled: true,
    // Fineprint's row id, and TinyFish's own id for the same run.
    run_id: recorded.runId,
    monitor_run_id: run.id,
    outcome: run.outcome,
    ...(recorded.versionId !== null ? { version_id: recorded.versionId } : {}),
    ...(recorded.suppressed ? { suppressed: true } : {}),
  });
});
