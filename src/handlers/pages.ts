// /api/pages: add, read, update and delete watched pages (spec 4.1, 4.8).
//
// Adding a page is the only place a Monitor is created. The order of the checks is
// deliberate: everything that can say "no" for free (shape of the request, the url,
// duplicates, the caps, the visitor's daily add) runs before the first TinyFish call,
// and TinyFetch validates the page before a billed Monitor is created.
import { Hono } from "hono";
import type { Context } from "hono";
import { adminOnly, isAdmin } from "../auth";
import { captureVersion, needsFacts } from "../capture";
import { MAX_MONITORS, MAX_URL_LENGTH, PUBLIC_ADDS_PER_IP_PER_DAY, PUBLIC_SLOTS, PUBLIC_TTL_DAYS } from "../core/limits";
import { hashText, normalize } from "../core/normalize";
import { cronForIndex, PURPOSE } from "../core/schedule";
import { deleteCachedDiffsOfPage } from "../db/diffCache";
import {
  countMonitors,
  getPage,
  getPageByUrl,
  insertPage,
  listPages,
  publicSlotUsage,
  updatePage,
  type PagePatch,
} from "../db/pages";
import { claimPublicAdd, publicAddsToday, releasePublicAdd } from "../db/publicAdds";
import { insertRun, listRunsOfPage } from "../db/runs";
import type { PageKind, PageRow } from "../db/types";
import { insertVersion, listVersions } from "../db/versions";
import type { Env } from "../env";
import { TinyFishError } from "../tinyfish/client";
import { fetchPage } from "../tinyfish/fetch";
import { createMonitor, deleteMonitor, updateMonitor } from "../tinyfish/monitor";
import { versionSummaryJson } from "./versionJson";

type AppContext = Context<{ Bindings: Env }>;

// --- Page JSON --------------------------------------------------------------

/** A page row as the API returns it: `ignore_patterns` is an array, every other column as stored. */
export type PageJson<T extends PageRow = PageRow> = Omit<T, "ignore_patterns"> & { ignore_patterns: string[] };

function parsePatterns(stored: string): string[] {
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The one mapping from a page row to API JSON (R33). Works for a plain row and for a
 * `listPages` row (the extra count columns pass through). Task 9 reuses it.
 */
export function pageToJson<T extends PageRow>(row: T): PageJson<T> {
  return { ...row, ignore_patterns: parsePatterns(row.ignore_patterns) };
}

// --- Request validation -----------------------------------------------------

const KINDS: readonly PageKind[] = ["pricing", "fees", "policy", "rules", "other"];
const MAX_LABEL_LENGTH = 200;
const MAX_PURPOSE_LENGTH = 2000;
const MAX_IGNORE_PATTERNS = 50;
const MAX_IGNORE_PATTERN_LENGTH = 500;
const DAY_MS = 86_400_000;
/** The page detail answer carries at most this many of the page's runs. */
const MAX_RUNS_SHOWN = 100;

type Fields = { label?: string; kind?: PageKind; ignorePatterns?: string[] };
type Rejected = { error: string };

const absent = (value: unknown): boolean => value === undefined || value === null;

/** The request's JSON object, or null when the body is not JSON or not an object. Shared with the sibling handlers. */
export async function readBody(c: AppContext): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** The fields POST and PATCH share. An absent (missing or null) field is left out of the result. */
function readFields(body: Record<string, unknown>): Fields | Rejected {
  const fields: Fields = {};

  if (!absent(body.kind)) {
    if (typeof body.kind !== "string" || !(KINDS as readonly string[]).includes(body.kind)) return { error: "invalid_kind" };
    fields.kind = body.kind as PageKind;
  }

  if (!absent(body.ignore_patterns)) {
    const list = body.ignore_patterns;
    if (
      !Array.isArray(list) ||
      list.length > MAX_IGNORE_PATTERNS ||
      !list.every((p) => typeof p === "string" && p.length <= MAX_IGNORE_PATTERN_LENGTH)
    ) {
      return { error: "invalid_ignore_patterns" };
    }
    fields.ignorePatterns = list as string[];
  }

  if (!absent(body.label)) {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (label === "" || label.length > MAX_LABEL_LENGTH) return { error: "invalid_label" };
    fields.label = label;
  }

  return fields;
}

// --- Private hosts ----------------------------------------------------------

function isPrivateIPv4(a: number, b: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 169 && b === 254) || // 169.254.0.0/16, includes cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10
  );
}

// `address` is what sits between the brackets of a url host. The url parser has already
// lower-cased it, compressed it and turned a dotted IPv4 tail into two hex groups.
function isPrivateIPv6(address: string): boolean {
  const halves = address.split("::");
  if (halves.length > 2) return true;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return true;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  if (groups.some(Number.isNaN)) return true; // cannot read it: refuse

  const g = groups as number[];
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
  // ::, ::1, ::a.b.c.d (IPv4-compatible) and ::ffff:a.b.c.d (IPv4-mapped): judge the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    return isPrivateIPv4(g[6]! >> 8, g[6]! & 0xff);
  }
  return false;
}

/** True for a host that is not a public one (loopback, private ranges, local names); discover applies the same rule. */
export function isPrivateHost(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return isPrivateIPv6(hostname.slice(1, -1));
  const host = hostname.replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  return v4 !== null && isPrivateIPv4(Number(v4[1]), Number(v4[2]));
}

/**
 * The canonical form of a watchable url, or null. Must be http(s), carry no credentials
 * and not point at a private host. The canonical form (lower-case host, no fragment) is
 * what is stored and what duplicates are checked against.
 */
function parseWatchUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (isPrivateHost(url.hostname)) return null;
  url.hash = "";
  return url.href;
}

// --- Helpers for the add flow -----------------------------------------------

/** The code a failed TinyFish call is reported with: TinyFish's own, else `request_failed`. */
export const codeOf = (err: unknown): string => (err instanceof TinyFishError ? err.code : "request_failed");

// Logs what failed without anything an upstream could have echoed back: for a TinyFish
// failure only its name, status and code; for any other error its name and message.
export function logError(what: string, err: unknown): void {
  if (err instanceof TinyFishError) {
    console.error(what, `${err.name} status=${err.status} code=${err.code}`);
  } else {
    console.error(what, err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  }
}

/** Best effort: a Monitor nobody has a page for would hold a slot and bill twice a day. */
async function dropMonitor(env: Env, monitorId: string): Promise<void> {
  try {
    await deleteMonitor(env, monitorId);
  } catch {
    console.error("orphan monitor: delete failed", monitorId);
  }
}

/** Undoes a half-finished add: the page and whatever was written for it. */
async function rollbackAdd(db: D1Database, pageId: string): Promise<void> {
  try {
    await db.batch([
      db.prepare("DELETE FROM versions WHERE page_id = ?").bind(pageId),
      db.prepare("DELETE FROM runs WHERE page_id = ?").bind(pageId),
      db.prepare("DELETE FROM pages WHERE id = ?").bind(pageId),
    ]);
  } catch {
    console.error("add rollback failed", pageId);
  }
}

const isUniqueViolation = (err: unknown): boolean => err instanceof Error && /UNIQUE constraint/i.test(err.message);

/** When the next public slot frees up: the earliest expiry among the public pages that hold a slot. */
async function nextPublicSlotAt(db: D1Database): Promise<string | null> {
  return (await publicSlotUsage(db)).next_free_at;
}

type CapHit = "watchlist_full" | "public_slots_full";

/**
 * Which cap an add runs into, if any. `held` is the number of Monitors now held and `extra`
 * is 1 before the add (is there room for one more?) and 0 after its page is stored (is the
 * count over the cap?).
 */
async function capHit(db: D1Database, admin: boolean, held: number, extra: 0 | 1): Promise<CapHit | null> {
  if (held + extra > MAX_MONITORS) return "watchlist_full";
  if (!admin && (await countMonitors(db, "public")) + extra > PUBLIC_SLOTS) return "public_slots_full";
  return null;
}

/** The 409 for a cap, the same body before and after the Monitor was created. */
async function capRefusal(c: AppContext, hit: CapHit): Promise<Response> {
  if (hit === "watchlist_full") {
    return c.json(
      { error: "watchlist_full", reason: `Fineprint already watches its maximum of ${MAX_MONITORS} pages` },
      409,
    );
  }
  const retryAfter = await nextPublicSlotAt(c.env.DB);
  return c.json(
    {
      error: "public_slots_full",
      reason: `All ${PUBLIC_SLOTS} public slots are in use. Public pages are removed after ${PUBLIC_TTL_DAYS} days${
        retryAfter ? `; the next slot frees up at ${retryAfter}` : ""
      }`,
      retry_after: retryAfter,
    },
    409,
  );
}

async function releaseQuietly(db: D1Database, ipHash: string): Promise<void> {
  try {
    await releasePublicAdd(db, ipHash);
  } catch (err) {
    logError("add: giving back the daily add failed", err);
  }
}

// --- Routes -----------------------------------------------------------------

export const pagesRouter = new Hono<{ Bindings: Env }>();

pagesRouter.onError((err, c) => {
  logError("pages handler failed", err);
  return c.json({ error: "internal_error" }, 500);
});

pagesRouter.get("/", async (c) => {
  const pages = await listPages(c.env.DB);
  return c.json({ pages: pages.map(pageToJson) });
});

pagesRouter.get("/:id", async (c) => {
  const page = await getPage(c.env.DB, c.req.param("id"));
  if (!page) return c.json({ error: "not_found" }, 404);
  const [versions, runs] = await Promise.all([listVersions(c.env.DB, page.id), listRunsOfPage(c.env.DB, page.id, MAX_RUNS_SHOWN)]);
  return c.json({
    page: pageToJson(page),
    // Newest first, without text, in the shape every endpoint gives a version (versionSummaryJson).
    versions: versions.map((v) => versionSummaryJson(c.env, v)),
    // Newest first. `noise_reason` says why a suppressed run made no version (normalized_identical,
    // partial_render, flap), or why a fetch failed (fetch_error, not counted as suppressed).
    runs: runs.map((r) => ({
      id: r.id,
      monitor_run_id: r.monitor_run_id,
      trigger: r.trigger_kind,
      outcome: r.outcome,
      received_at: r.received_at,
      noise_suppressed: r.noise_suppressed === 1,
      noise_reason: r.noise_reason,
    })),
  });
});

pagesRouter.post("/", async (c) => {
  const db = c.env.DB;

  // 1. Shape of the request. Nothing here costs anything.
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  // Long urls are refused as sent (before any parsing) and in the form that would be stored.
  const tooLong = () => c.json({ error: "invalid_url", reason: "url_too_long" }, 400);
  if (typeof body.url === "string" && body.url.length > MAX_URL_LENGTH) return tooLong();
  const url = parseWatchUrl(body.url);
  if (!url) return c.json({ error: "invalid_url" }, 400);
  if (url.length > MAX_URL_LENGTH) return tooLong();
  const fields = readFields(body);
  if ("error" in fields) return c.json({ error: fields.error }, 400);

  const admin = isAdmin(c);
  // Ignore patterns are regexes that run inside the Worker on every webhook for the page.
  if (!admin && fields.ignorePatterns !== undefined && fields.ignorePatterns.length > 0) {
    return c.json({ error: "admin_required", reason: "Only the admin can set ignore_patterns" }, 401);
  }

  // 2. Duplicates and caps (spec 4.1 step 1).
  const existing = await getPageByUrl(db, url);
  if (existing) return c.json({ error: "already_watched", page_id: existing.id }, 409);

  const held = await countMonitors(db);
  const full = await capHit(db, admin, held, 1);
  if (full) return capRefusal(c, full);

  if (admin) return createPage(c, { url, fields, admin, held });

  // A public visitor gets one add a day. The plain check answers the common case without a
  // write; the claim is the one that holds when several adds arrive at once (it is a single
  // statement, so only one of them can take the last add).
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const ipHash = await hashText(ip + c.env.WEBHOOK_SECRET);
  const dailyLimit = () => c.json({ error: "daily_limit", reason: "One public page per day per visitor" }, 429);
  if ((await publicAddsToday(db, ipHash)) >= PUBLIC_ADDS_PER_IP_PER_DAY) return dailyLimit();
  if (!(await claimPublicAdd(db, ipHash, PUBLIC_ADDS_PER_IP_PER_DAY))) return dailyLimit();

  // The add is given back unless a page was created, whichever way the rest ends.
  let res: Response | undefined;
  try {
    res = await createPage(c, { url, fields, admin, held });
    return res;
  } finally {
    if (res?.status !== 201) await releaseQuietly(db, ipHash);
  }
});

type NewPageRequest = { url: string; fields: Fields; admin: boolean; held: number };

/** Steps 3 to 6 of the add flow: validate with TinyFetch, create the Monitor, store the page. */
async function createPage(c: AppContext, req: NewPageRequest): Promise<Response> {
  const db = c.env.DB;
  const { url, fields, admin, held } = req;

  // 3. TinyFetch validation (free). A page that cannot be read now cannot be watched.
  let fetched: Awaited<ReturnType<typeof fetchPage>>;
  try {
    fetched = await fetchPage(c.env, url, "markdown");
  } catch (err) {
    logError("add: TinyFetch request failed", err);
    return c.json({ error: "unfetchable", reason: "fetch_failed" }, 502);
  }
  if (!fetched.ok) return c.json({ error: "unfetchable", reason: fetched.error.slice(0, 100) }, 422);
  if (fetched.text.trim() === "") return c.json({ error: "unfetchable", reason: "empty_page" }, 422);

  const title = fetched.title?.replace(/\s+/g, " ").trim();
  const label = fields.label ?? (title ? title.slice(0, MAX_LABEL_LENGTH) : new URL(url).hostname);

  // 4. The Monitor. The first check is billed, so nothing that can fail for free comes after it
  //    without first putting the Monitor away again.
  let monitor: Awaited<ReturnType<typeof createMonitor>>;
  try {
    monitor = await createMonitor(c.env, {
      url,
      name: label,
      scheduleCron: cronForIndex(held),
      purpose: PURPOSE,
      webhookUrl: `${c.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/hooks/monitor/${c.env.WEBHOOK_SECRET}`,
    });
  } catch (err) {
    logError("add: Monitor create failed", err);
    return c.json({ error: "monitor_create_failed", reason: codeOf(err) }, 502);
  }

  // 5. The page, its baseline run and its baseline version. A public page keeps the kind it was sent with
  //    (the site shows it), but never takes a facts run (needsFacts), so a visitor's add costs no Agent steps.
  const ignorePatterns = fields.ignorePatterns ?? [];
  const addedBy = admin ? "admin" : "public";
  const now = new Date();
  const nowIso = now.toISOString();
  const pageId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const versionId = crypto.randomUUID();

  try {
    await insertPage(db, {
      id: pageId,
      url,
      label,
      kind: fields.kind ?? "other",
      monitor_id: monitor.monitorId,
      schedule_cron: cronForIndex(held),
      purpose: PURPOSE,
      status: "active",
      added_by: addedBy,
      ignore_patterns: JSON.stringify(ignorePatterns),
      expires_at: admin ? null : new Date(now.getTime() + PUBLIC_TTL_DAYS * DAY_MS).toISOString(),
    });
  } catch (err) {
    await dropMonitor(c.env, monitor.monitorId);
    if (isUniqueViolation(err)) {
      // Another add stored this url while ours was waiting on TinyFish.
      const winner = await getPageByUrl(db, url);
      return c.json({ error: "already_watched", page_id: winner?.id ?? null }, 409);
    }
    logError("add: page insert failed", err);
    return c.json({ error: "internal_error" }, 500);
  }

  // Adds that arrive together all pass the checks above before any of them has written, so each
  // counts again now that its own page is stored. One that finds a cap exceeded takes its
  // Monitor and page back (a rare pair may both back out; the visitor can try again).
  let overCap: CapHit | null = null;
  try {
    overCap = await capHit(db, admin, await countMonitors(db), 0);
    if (overCap === null) {
      const outcome = await insertRun(db, {
        id: runId,
        page_id: pageId,
        monitor_run_id: monitor.baselineRunId,
        outcome: "baseline",
        is_baseline: 1,
        judgment_relevant: null,
        judgment_summary: null,
        diff_truncated: 0,
        noise_suppressed: 0,
        noise_reason: null,
        raw_key: null,
        received_at: nowIso,
        trigger_kind: "create",
      });
      if (outcome === "duplicate") throw new Error("the baseline run id is already recorded");
      await insertVersion(db, {
        id: versionId,
        page_id: pageId,
        run_id: runId,
        is_baseline: 1,
        captured_at: nowIso,
        text: monitor.baselineText,
        normalized_hash: await hashText(normalize(monitor.baselineText, ignorePatterns).text),
        judgment_summary: null,
        capture_status: "pending",
        facts_status: needsFacts({ kind: fields.kind ?? "other", added_by: addedBy }, { is_baseline: 1 }, null) ? "pending" : "not_needed",
      });
    }
  } catch (err) {
    logError("add: baseline insert failed", err);
    await rollbackAdd(db, pageId);
    await dropMonitor(c.env, monitor.monitorId);
    return c.json({ error: "internal_error" }, 500);
  }
  if (overCap !== null) {
    await rollbackAdd(db, pageId);
    await dropMonitor(c.env, monitor.monitorId);
    return capRefusal(c, overCap);
  }

  // 6. Every page gets a day-zero screenshot and source (spec 4.4).
  c.executionCtx.waitUntil(
    captureVersion(c.env, versionId).catch((err: unknown) => logError("add: capture failed for " + versionId, err)),
  );

  const row = await getPage(db, pageId);
  if (!row) return c.json({ error: "internal_error" }, 500);
  return c.json({ page: pageToJson(row), baseline_version_id: versionId }, 201);
}

pagesRouter.patch("/:id", adminOnly, async (c) => {
  const db = c.env.DB;
  const page = await getPage(db, c.req.param("id"));
  if (!page) return c.json({ error: "not_found" }, 404);

  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const fields = readFields(body);
  if ("error" in fields) return c.json({ error: fields.error }, 400);

  let scheduleCron: string | undefined;
  if (!absent(body.schedule_cron)) {
    const parts = typeof body.schedule_cron === "string" ? body.schedule_cron.trim().split(/\s+/) : [];
    if (parts.length !== 5 || parts.some((p) => p === "")) return c.json({ error: "invalid_schedule_cron" }, 400);
    scheduleCron = parts.join(" ");
  }

  let purpose: string | undefined;
  if (!absent(body.purpose)) {
    const text = typeof body.purpose === "string" ? body.purpose.trim() : "";
    if (text === "" || text.length > MAX_PURPOSE_LENGTH) return c.json({ error: "invalid_purpose" }, 400);
    purpose = text;
  }

  if (!absent(body.promote) && body.promote !== true) return c.json({ error: "invalid_promote" }, 400);
  const promote = body.promote === true;

  // Schedule and purpose live on TinyFish too: one PATCH that always carries schedule_cron
  // (TinyFish rejects an edit without it), and D1 changes only if TinyFish accepted it.
  if (scheduleCron !== undefined || purpose !== undefined) {
    if (page.status === "expired" || page.status === "retired" || page.monitor_id === null) {
      return c.json({ error: "page_expired" }, 409);
    }
    const cron = scheduleCron ?? page.schedule_cron;
    if (cron === null) {
      return c.json({ error: "invalid_schedule_cron", reason: "This page has no stored schedule; send schedule_cron" }, 400);
    }
    try {
      await updateMonitor(c.env, page.monitor_id, purpose === undefined ? { scheduleCron: cron } : { scheduleCron: cron, purpose });
    } catch (err) {
      logError("patch: Monitor update failed", err);
      return c.json({ error: "monitor_update_failed", reason: codeOf(err) }, 502);
    }
  }

  const patch: PagePatch = {};
  if (fields.label !== undefined) patch.label = fields.label;
  if (fields.kind !== undefined) patch.kind = fields.kind;
  if (fields.ignorePatterns !== undefined) patch.ignore_patterns = JSON.stringify(fields.ignorePatterns);
  if (scheduleCron !== undefined) patch.schedule_cron = scheduleCron;
  if (purpose !== undefined) patch.purpose = purpose;
  if (promote) {
    patch.added_by = "curated";
    patch.expires_at = null;
  }
  await updatePage(db, page.id, patch);
  // A stored diff holds the page's label and blocks cut with its ignore patterns (R73): an edit
  // of either drops the page's cached diffs, and the next request computes them again.
  if (patch.ignore_patterns !== undefined || patch.label !== undefined) await deleteCachedDiffsOfPage(db, page.id);

  const updated = await getPage(db, page.id);
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json({ page: pageToJson(updated) });
});

pagesRouter.delete("/:id", adminOnly, async (c) => {
  const page = await getPage(c.env.DB, c.req.param("id"));
  if (!page) return c.json({ error: "not_found" }, 404);
  if (page.status === "expired") return c.json({ deleted: true });

  // The Monitor goes, the history stays (spec 7). If TinyFish fails the page stays as it was,
  // so the Monitor and the page cannot drift apart.
  if (page.monitor_id !== null) {
    try {
      await deleteMonitor(c.env, page.monitor_id);
    } catch (err) {
      logError("delete: Monitor delete failed", err);
      return c.json({ error: "monitor_delete_failed", reason: codeOf(err) }, 502);
    }
  }
  await updatePage(c.env.DB, page.id, { status: "expired" });
  return c.json({ deleted: true });
});
