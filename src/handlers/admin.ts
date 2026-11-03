// Admin-only operations (spec 4.8): replay a page's stored raw payloads through the change gate,
// re-point every Monitor's webhook at a new host, and pull one overdue Monitor check. Each route
// checks the admin token first, so an unknown page or a bad body never tells a stranger anything.
import { Hono } from "hono";
import { adminOnly } from "../auth";
import { spendPaused } from "../capture";
import { isFetchFailure, judgeChange, normalizedHash, readIgnorePatterns, type Verdict } from "../core/gate";
import { changedRunsForReplay, clearNoise, markNoise } from "../db/runs";
import { deleteCachedDiffsOfPage } from "../db/diffCache";
import { getPage, listPages, updatePage } from "../db/pages";
import { baselineVersion, getVersion, insertVersion, latestVersion } from "../db/versions";
import type { Env } from "../env";
import { recordMonitorRun, type MonitorRun } from "../record";
import { TinyFishError } from "../tinyfish/client";
import { runMonitorNow, updateMonitor } from "../tinyfish/monitor";
import { codeOf, readBody } from "./pages";
import { parsePayload, type MonitorPayload } from "./webhooks";

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

/** What the next run is compared with: the newest version so far, read and hashed only when needed. */
type Chain = { versionId: string | null; text: string | null; hash: string | null };

async function chainHash(db: D1Database, chain: Chain, patterns: string[]): Promise<string | null> {
  if (chain.hash !== null) return chain.hash;
  if (chain.text === null && chain.versionId !== null) chain.text = (await getVersion(db, chain.versionId))?.text ?? null;
  if (chain.text === null) return null;
  chain.hash = await normalizedHash(chain.text, patterns);
  return chain.hash;
}

/** A stored raw webhook payload, or null when the object is missing or is not a Monitor payload. */
async function readRaw(store: R2Bucket, key: string): Promise<MonitorPayload | null> {
  const object = await store.get(key);
  return object === null ? null : parsePayload(await object.text());
}

/**
 * Walks the page's `changed` runs that kept a raw payload, oldest first, against a chain that
 * starts at the baseline version, and decides each one again with the gate as it is now:
 * - a run that already made a version is left alone and the chain moves to that version;
 * - a payload that is missing, unreadable, empty or carries an error is skipped (counted nowhere);
 * - a payload that normalizes to the chain's text is suppressed (and marked as noise if it was not);
 * - any other payload becomes a version, dated by the run's receipt time and left `pending` with
 *   `capture_error "replayed"` for the hourly repair, and its run stops counting as noise.
 * Nothing is captured and TinyFish is never called. A replay that is cut off, or run again, picks up
 * where the stored versions say it was.
 */
adminRouter.post("/pages/:id/replay", adminOnly, async (c) => {
  const db = c.env.DB;
  const page = await getPage(db, c.req.param("id"));
  if (!page) return c.json({ error: "not_found" }, 404);

  const patterns = readIgnorePatterns(page.ignore_patterns);
  let chain: Chain = { versionId: (await baselineVersion(db, page.id))?.id ?? null, text: null, hash: null };
  let created = 0;
  let suppressed = 0;
  let marked = 0;
  let newest: string | null = null;

  for (const run of await changedRunsForReplay(db, page.id)) {
    // Checked before the raw object is read: a version that exists is history whether or not its
    // payload survived, and the next run is compared with it, as the live gate would have.
    if (run.version_id !== null) {
      chain = { versionId: run.version_id, text: null, hash: null };
      continue;
    }

    const payload = await readRaw(c.env.STORE, run.raw_key!);
    if (payload === null || isFetchFailure(payload)) continue;

    const hash = await normalizedHash(payload.text, patterns);
    if (hash === (await chainHash(db, chain, patterns))) {
      suppressed++;
      if (run.noise_suppressed !== 1) {
        await markNoise(db, run.id, "normalized_identical");
        marked++;
      }
      continue;
    }

    // The flag comes off first: if the insert then fails, the next replay finds a run with no
    // version and judges it again, which is right whichever way it goes.
    if (run.noise_suppressed !== 0 || run.noise_reason !== null) await clearNoise(db, run.id);
    const versionId = crypto.randomUUID();
    await insertVersion(db, {
      id: versionId,
      page_id: page.id,
      run_id: run.id,
      is_baseline: 0,
      captured_at: run.received_at,
      text: payload.text,
      normalized_hash: hash,
      judgment_summary: payload.judgmentSummary,
      capture_status: "pending",
      capture_error: "replayed",
    });
    created++;
    newest = run.received_at;
    chain = { versionId, text: payload.text, hash };
  }

  if (newest !== null && (page.last_change_at === null || newest > page.last_change_at)) {
    await updatePage(db, page.id, { last_change_at: newest });
  }
  // A cached diff holds the number of versions and suppressed runs between its two ends; a version
  // added or a run un-marked inside that stretch makes those numbers wrong.
  if (created > 0 || marked > 0) await deleteCachedDiffsOfPage(db, page.id);

  return c.json({ created, suppressed });
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
 * Points every live Monitor (a page with a Monitor that is not expired) at `<base_url>/hooks/monitor/<secret>`.
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
    if (page.monitor_id === null || page.status === "expired") continue;
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

// --- Pull an overdue check ------------------------------------------------------------------------

/**
 * The one place an overdue check is pulled (the hourly cron calls it through the SELF service
 * binding, one Worker invocation per page, so each pull has a request's own CPU and subrequests).
 * It asks TinyFish to run the page's Monitor now and records that run under TinyFish's run id,
 * marked `pull`, through the same recording path a webhook run takes.
 *
 * - An expired or paused page, or one without a Monitor, is not pulled (409 `not_pullable`); at the
 *   spend pause nothing is called (200, `pulled: false`).
 * - A run with no text or with errors records nothing: TinyFish does not bill a failed check, and the
 *   page stays overdue for the next tick (200, `pulled: false` with the reason).
 * - Otherwise the raw 201 body is stored at `raw/<run id>.json` and the outcome is Fineprint's own
 *   (R71): no version yet is the `baseline` and becomes one; text equal to the latest version's
 *   (plain string equality) is `unchanged` and is not normalized; anything else is `changed` and
 *   goes through the change gate. A run id already recorded is a duplicate and writes nothing.
 */
adminRouter.post("/admin/pull/:pageId", adminOnly, async (c) => {
  const db = c.env.DB;
  const page = await getPage(db, c.req.param("pageId"));
  if (!page) return c.json({ error: "not_found" }, 404);
  if (page.status === "expired" || page.status === "paused" || page.monitor_id === null) {
    return c.json({ error: "not_pullable" }, 409);
  }
  if (await spendPaused(db)) return c.json({ ok: true, pulled: false, reason: "spend_paused" });

  let pulled: Awaited<ReturnType<typeof runMonitorNow>>;
  try {
    pulled = await runMonitorNow(c.env, page.monitor_id);
  } catch (err) {
    logFailure(`pull: run-now failed for page ${page.id}`, err);
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
  if (isFetchFailure(run)) return c.json({ ok: true, pulled: false, reason: run.hasErrors ? "fetch_error" : "no_text" });

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
  }

  const recorded = await recordMonitorRun(c.env, c.executionCtx, { page, run, trigger: "pull", rawKey, receivedAt, verdict });
  if (recorded.kind === "duplicate") return c.json({ ok: true, duplicate: true });
  return c.json({
    ok: true,
    pulled: true,
    run_id: recorded.runId,
    outcome: run.outcome,
    ...(recorded.versionId !== null ? { version_id: recorded.versionId } : {}),
    ...(recorded.suppressed ? { suppressed: true } : {}),
  });
});
