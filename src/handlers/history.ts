// The public read API over the recorded history (spec 4.7 and 4.8): one version, the version
// in force at a time, the structured diff between two times, the change feed, the full export
// and the stats. All of it is GET and JSON; CORS is added for /api/* in index.ts.
//
// The free plan allows 10 ms of CPU a request, so nothing here loops over pages with a query
// each, and no list reads a version's `text`. The one expensive answer, a diff, is stored in
// `diff_cache` under the two version ids so later requests only read it. It is stored only once
// both versions are final (`complete` or `failed`, with no facts run in flight) and the `to`
// version's summary is filled: a version's text never changes, but its screenshot, source, facts
// and summary are filled in after it is inserted (a capture takes minutes, the facts queue up to an
// hour), so the diff of a version still being captured is computed again on every request and a
// stored one would freeze it without them. What a stored diff also depends on (the page's ignore
// patterns and label) is dropped from the cache when it is edited. Every version is shown through
// the one mapper in ./versionJson.ts.
import { Hono } from "hono";
import type { Context } from "hono";
import { factsDiff, structuredDiff, type FactsDiff, type StructuredDiff } from "../core/diff";
import { normalize } from "../core/normalize";
import { getCachedDiff, putCachedDiff } from "../db/diffCache";
import { getPage, listPages } from "../db/pages";
import { countNoiseBetween } from "../db/runs";
import type { FactsStatus, PageRow, SummarySource, TriggerKind } from "../db/types";
import {
  baselineVersion,
  countVersionsBetween,
  getVersion,
  getVersionWithTrigger,
  listAllVersionSummaries,
  versionAsOf,
  versionSummaryAsOf,
  type VersionSummary,
  type WithTrigger,
} from "../db/versions";
import type { Env } from "../env";
import { getStats, listChanges, parseTime } from "../readModel";
import { pageToJson } from "./pages";
import { objectUrls, parseFacts, versionJson, versionSummaryJson } from "./versionJson";

type AppContext = Context<{ Bindings: Env }>;

export const historyRouter = new Hono<{ Bindings: Env }>();

historyRouter.onError((err, c) => {
  console.error("history handler failed", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  return c.json({ error: "internal_error" }, 500);
});

// --- Helpers ----------------------------------------------------------------------------------

/**
 * True when nothing a stored diff shows of a version will change any more: its capture is terminal
 * (`complete` or `failed`) and no facts run is in flight for it (`agent_run_id` set, a run id or a claim,
 * with no facts yet: a version can hold the facts slot while `failed`, or `complete` after its attempts).
 * A `pending`, `partial` or `awaiting_facts` version is still gaining its screenshot, source or facts.
 */
const isFinal = (v: Pick<VersionSummary, "capture_status" | "agent_run_id" | "facts_json">): boolean =>
  (v.capture_status === "complete" || v.capture_status === "failed") && !(v.agent_run_id !== null && v.facts_json === null);

const notFound = (c: AppContext): Response => c.json({ error: "not_found" }, 404);

/** The 404 for a time the page has no version for. */
async function noVersionAt(c: AppContext, pageId: string, reason: "before_baseline" | "no_versions"): Promise<Response> {
  if (reason === "before_baseline") {
    const baseline = await baselineVersion(c.env.DB, pageId);
    if (baseline) return c.json({ error: "before_baseline", baseline_at: baseline.captured_at }, 404);
  }
  return c.json({ error: "no_versions" }, 404);
}

// --- One version and as-of --------------------------------------------------------------------

historyRouter.get("/pages/:id/versions/:vid", async (c) => {
  const page = await getPage(c.env.DB, c.req.param("id"));
  if (!page) return notFound(c);
  const version = await getVersionWithTrigger(c.env.DB, c.req.param("vid"));
  if (!version || version.page_id !== page.id) return notFound(c);
  return c.json(versionJson(c.env, page, version));
});

historyRouter.get("/pages/:id/as-of", async (c) => {
  const page = await getPage(c.env.DB, c.req.param("id"));
  if (!page) return notFound(c);
  const at = parseTime(c.req.query("at"));
  if (at === null) return c.json({ error: "invalid_at" }, 400);

  const version = await versionAsOf(c.env.DB, page.id, at);
  if (typeof version === "string") return noVersionAt(c, page.id, version);
  return c.json(versionJson(c.env, page, version));
});

// --- Diff -------------------------------------------------------------------------------------

type DiffEnd = {
  version_id: string;
  captured_at: string;
  screenshot_url: string | null;
  source_url: string | null;
  trigger: TriggerKind | null;
  facts_status: FactsStatus;
};

type DiffJson = {
  page: { id: string; url: string; label: string };
  from: DiffEnd;
  to: DiffEnd;
  summary: string | null;
  summary_source: SummarySource | null;
  blocks: StructuredDiff;
  facts: FactsDiff | null;
  hops: number;
  noise_suppressed_between: number;
};

// A version's trigger never changes, so a stored diff keeps it. Its facts status does until the version is
// final, and a diff is stored only once both of its versions are.
const diffEnd = (env: Env, v: WithTrigger<VersionSummary>): DiffEnd => ({
  version_id: v.id,
  captured_at: v.captured_at,
  ...objectUrls(env, v),
  trigger: v.trigger_kind,
  facts_status: v.facts_status,
});

/**
 * The diff of two resolved versions (spec 4.7), or null if a version is gone. `hops` counts the
 * versions captured in (from, to] and `noise_suppressed_between` the suppressed runs received in
 * the same interval. Blocks come from the normalized texts, normalized with the page's current
 * ignore patterns, as the change gate does. One version on both sides is an empty diff and reads
 * no text.
 */
async function buildDiff(
  env: Env,
  page: PageRow,
  from: WithTrigger<VersionSummary>,
  to: WithTrigger<VersionSummary>,
): Promise<DiffJson | null> {
  let blocks: StructuredDiff = { added: [], removed: [], changed: [] };
  let hops = 0;
  let noiseBetween = 0;

  if (from.id !== to.id) {
    const db = env.DB;
    const [fromFull, toFull, hopCount, noiseCount] = await Promise.all([
      getVersion(db, from.id),
      getVersion(db, to.id),
      countVersionsBetween(db, page.id, from.captured_at, to.captured_at),
      countNoiseBetween(db, page.id, from.captured_at, to.captured_at),
    ]);
    if (!fromFull || !toFull) return null;
    const patterns = pageToJson(page).ignore_patterns;
    blocks = structuredDiff(normalize(fromFull.text, patterns).text, normalize(toFull.text, patterns).text);
    hops = hopCount;
    noiseBetween = noiseCount;
  }

  return {
    page: { id: page.id, url: page.url, label: page.label },
    from: diffEnd(env, from),
    to: diffEnd(env, to),
    // The latest hop's summary: the `to` version's stored one-line summary (TinyFish's, else the diff line).
    summary: to.summary,
    summary_source: to.summary_source,
    blocks,
    facts: factsDiff(parseFacts(from.facts_json), parseFacts(to.facts_json)),
    hops,
    noise_suppressed_between: noiseBetween,
  };
}

historyRouter.get("/pages/:id/diff", async (c) => {
  const db = c.env.DB;
  const page = await getPage(db, c.req.param("id"));
  if (!page) return notFound(c);

  const fromAt = parseTime(c.req.query("from"));
  if (fromAt === null) return c.json({ error: "invalid_from" }, 400);
  const toAt = parseTime(c.req.query("to"));
  if (toAt === null) return c.json({ error: "invalid_to" }, 400);

  const [from, to] = await Promise.all([versionSummaryAsOf(db, page.id, fromAt), versionSummaryAsOf(db, page.id, toAt)]);
  if (typeof from === "string") return noVersionAt(c, page.id, from);
  if (typeof to === "string") return noVersionAt(c, page.id, to);
  // Both ends are the latest version at or before their time, so `from` comes later than `to`
  // only when the range is reversed (R19). Two ends in one version are an empty diff.
  if (from.id !== to.id && from.captured_at > to.captured_at) return c.json({ error: "invalid_range" }, 400);

  // A diff is kept only once both versions are final, and only a kept one is read: a stored answer
  // is served as it was stored (the viewer never recomputes), and an answer for a version still
  // being captured is computed fresh, so it shows the screenshots and facts that have arrived. The
  // `to` version's summary is part of the answer, so a change whose summary is not filled yet waits too.
  const final = isFinal(from) && isFinal(to) && (to.is_baseline === 1 || to.summary !== null);
  if (final) {
    const cached = await getCachedDiff(db, from.id, to.id);
    if (cached !== null) return c.body(cached, 200, { "Content-Type": "application/json" });
  }

  const diff = await buildDiff(c.env, page, from, to);
  if (diff === null) return notFound(c);
  const json = JSON.stringify(diff);
  if (final) {
    try {
      await putCachedDiff(db, from.id, to.id, json);
    } catch (err) {
      // The answer is right whether or not it could be kept; the next request computes it again.
      console.error("diff cache write failed", err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
    }
  }
  return c.body(json, 200, { "Content-Type": "application/json" });
});

// --- Change feed ------------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** `limit`: 50 when absent or not a number, otherwise clamped to 1..200. */
function readLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

historyRouter.get("/changes", async (c) => {
  const sinceRaw = c.req.query("since");
  const since = sinceRaw === undefined ? null : parseTime(sinceRaw);
  if (sinceRaw !== undefined && since === null) return c.json({ error: "invalid_since" }, 400);
  const beforeRaw = c.req.query("before");
  const before = beforeRaw === undefined ? null : parseTime(beforeRaw);
  if (beforeRaw !== undefined && before === null) return c.json({ error: "invalid_before" }, 400);

  const items = await listChanges(c.env, {
    since: since ?? undefined,
    before: before ?? undefined,
    limit: readLimit(c.req.query("limit")),
    // retired=0 leaves out the pages retired for unreliable reads; without it they stay in.
    includeRetired: c.req.query("retired") !== "0",
  });
  return c.json({ changes: items });
});

// --- Export -----------------------------------------------------------------------------------

historyRouter.get("/export.json", async (c) => {
  // Two queries however many pages there are: the pages, then every version without its text,
  // grouped here. Versions are newest first, as in /api/pages/:id.
  const [pages, versions] = await Promise.all([listPages(c.env.DB), listAllVersionSummaries(c.env.DB)]);
  const byPage = new Map<string, WithTrigger<VersionSummary>[]>();
  for (const version of versions) {
    const list = byPage.get(version.page_id);
    if (list) list.push(version);
    else byPage.set(version.page_id, [version]);
  }

  return c.json({
    generated_at: new Date().toISOString(),
    pages: pages.map((page) => ({
      ...pageToJson(page),
      versions: (byPage.get(page.id) ?? []).map((v) => versionSummaryJson(c.env, v)),
    })),
  });
});

// --- Stats ------------------------------------------------------------------------------------

historyRouter.get("/stats", async (c) => c.json(await getStats(c.env)));
