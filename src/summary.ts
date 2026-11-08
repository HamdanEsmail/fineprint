// Filling a version's one-line summary and its delta out of band (Task 15, site plan Task 2). A change whose
// run carried TinyFish's judgment summary gets it when the version is inserted (src/db/versions.ts). Every
// other change needs a line built from Fineprint's own structured diff against the previous version, and
// every change needs its delta (block and fact counts, and the layout-only label), which means normalizing
// two page texts and diffing them: too much to add to a webhook or pull request on the free plan's 10 ms of
// CPU, where a CPU kill after the run is claimed would cost the version. So the new version's request asks
// for its summary through the SELF service binding (`summaryDeps.fill`), the way the cron runs a pull: the
// admin route POST /api/admin/backfill-summaries computes it, and the delta with it, in an invocation of its
// own. A version whose summary came from TinyFish gets its delta from POST /api/admin/backfill-deltas, which
// the hourly cron asks for while any delta is missing. Both routes are also the one-off backfills of older
// versions. A version too large to diff alongside others (a 100 KB release-notes page) is only ever filled
// by a request for that version alone, so it can never hold back the rest.
//
// The delta's facts part needs both versions' facts, which land minutes after the version: it is null until
// then, and the delta fill adds it once both are stored (no text is read for that). The summary never waits
// for facts, nor for the delta: a missing summary is written first, in a write of its own, and only then is
// the delta (with its layout-only label, whose cost grows with the size of the change) worked out.
//
// Computing a delta is also when a diff summary stored under the old line rule is rebuilt: each version gets
// its delta once, so each stored diff summary is rebuilt once, from the diff the delta needs anyway. A
// TinyFish summary is never touched.
import { SELF_ORIGIN } from "./auth";
import { blockCounts, factCounts, factsDiff, isLayoutOnly, structuredDiff, type Delta, type StructuredDiff } from "./core/diff";
import { readIgnorePatterns } from "./core/gate";
import { FILL_DIFFS_PER_CALL, SUMMARY_TEXT_BUDGET_CHARS } from "./core/limits";
import { normalize } from "./core/normalize";
import { diffSummary, oneLine } from "./core/summary";
import {
  countMissingDeltas,
  countMissingSummaries,
  factsDeltaCandidates,
  replaceDeltas,
  setDeltaOnce,
  setSummaryIfMissing,
  setTinyFishSummaries,
  versionMissingDelta,
  versionMissingSummary,
  versionsMissingDelta,
  versionsMissingSummary,
  versionsWithJudgmentMissingSummary,
  versionWithPrevious,
  type SummaryCandidate,
} from "./db/versions";
import type { Env } from "./env";
import { dropCachedPages } from "./site/htmlCache";
import { parseFacts } from "./handlers/versionJson";

/** Which fill route a request goes to. */
type FillRoute = "backfill-summaries" | "backfill-deltas";

const fillRequest = (env: Env, route: FillRoute, versionId?: string): Promise<Response> =>
  env.SELF.fetch(
    new Request(
      `${SELF_ORIGIN}/api/admin/${route}${versionId === undefined ? "" : `?version=${encodeURIComponent(versionId)}`}`,
      { method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } },
    ),
  );

/**
 * The seam tests use instead of vi.mock. `fill` asks the Worker to fill summaries in an invocation of its
 * own, `fillDeltas` deltas: one version's when an id is given, else the oldest missing ones within the
 * per-call budget.
 */
export const summaryDeps = {
  fill: (env: Env, versionId?: string): Promise<Response> => fillRequest(env, "backfill-summaries", versionId),
  fillDeltas: (env: Env, versionId?: string): Promise<Response> => fillRequest(env, "backfill-deltas", versionId),
};

/** Asks for a fill and never throws: a failure is logged with its status, or an error's name and message. */
async function request(what: string, call: () => Promise<Response>): Promise<void> {
  try {
    const res = await call();
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) console.error(`${what} failed`, `status=${res.status}`);
  } catch (err) {
    console.error(`${what} failed`, err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  }
}

const scope = (versionId?: string): string => (versionId === undefined ? "missing versions" : `version ${versionId}`);

/**
 * Asks for a summary fill (see summaryDeps) and never throws: the version keeps no summary until the
 * backfill or the cron's next call fills it.
 */
export function requestSummary(env: Env, versionId?: string): Promise<void> {
  return request(`summary fill for ${scope(versionId)}`, () => summaryDeps.fill(env, versionId));
}

/** Asks for a delta fill (see summaryDeps) and never throws. */
export function requestDeltas(env: Env, versionId?: string): Promise<void> {
  return request(`delta fill for ${scope(versionId)}`, () => summaryDeps.fillDeltas(env, versionId));
}

/** At most this many versions needing a diff are looked at in one call (metadata only, no text). */
const DIFF_CANDIDATES_PER_CALL = 200;

/** At most this many deltas get their facts part in one call (one read and one write, no text). */
const FACTS_DELTAS_PER_CALL = 100;

/** The text a diff of this version works on: its own and the one before it. */
const pairLength = (c: SummaryCandidate): number => c.text_length + c.previous_length;

/** Too large to diff inside a call that does other work: filled only by a call of its own (`?version=<id>`). */
const isOversized = (c: SummaryCandidate): boolean => pairLength(c) > SUMMARY_TEXT_BUDGET_CHARS;

function logError(what: string, err: unknown): void {
  console.error(what, err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
}

// --- One version ------------------------------------------------------------------------------------

/** A version diffed against the one before it: the normalized new text and the structured diff. */
type Diffed = { next: string; diff: StructuredDiff };

type Facts = { facts_json: string | null };

/**
 * Diffs a version against the version captured before it (an empty page when there is none), both texts
 * normalized with the page's current ignore patterns. Throws on a row it cannot read (a NULL text).
 */
function diffVersion(v: { text: string }, previous: { text: string | null } | null, ignorePatterns: string): Diffed {
  const patterns = readIgnorePatterns(ignorePatterns);
  const next = normalize(v.text, patterns).text;
  const prev = previous === null ? "" : normalize(previous.text as string, patterns).text;
  return { next, diff: structuredDiff(prev, next) };
}

/**
 * A diffed version's delta: its block counts, its facts (null while either version has no stored facts)
 * and the layout-only label, which looks only at the changed region and is bounded by
 * LAYOUT_ONLY_MAX_REGION_CHARS.
 */
const deltaOf = (diff: StructuredDiff, v: Facts, previous: Facts | null): Delta => ({
  blocks: blockCounts(diff),
  facts: factCounts(factsDiff(parseFacts(previous?.facts_json ?? null), parseFacts(v.facts_json))),
  layout_only: isLayoutOnly(diff),
});

/** What filling one version wrote; `failed` when its summary was written but its delta could not be. */
type Filled = { summary: boolean; delta: boolean; rebuilt: boolean; failed: boolean; pageId: string };

const NOTHING: Filled = { summary: false, delta: false, rebuilt: false, failed: false, pageId: "" };

/**
 * The pages whose stored screens a fill made stale: a version that gained a summary or a delta changes the
 * home feed, About, the page view and its compares. Collected as versions are filled and dropped once at the
 * end (src/site/htmlCache.ts), so the work stays out of the webhook and a failure never fails the fill.
 */
function changedPages(): { note: (f: Filled) => void; drop: (env: Env) => Promise<void> } {
  const pages = new Set<string>();
  return {
    note: (f) => {
      if ((f.summary || f.delta) && f.pageId !== "") pages.add(f.pageId);
    },
    drop: (env) => dropCachedPages(env, [...pages]),
  };
}

/**
 * Fills what one non-baseline version is missing, from one read of it and the version before it:
 * - no summary: TinyFish's when its run had one (no diff), else the diff line, stored at once, in a write
 *   of its own, before the delta is worked out; so a delta that fails (or runs out of time) never costs
 *   the summary;
 * - no delta: the delta, and a diff summary stored under the old line rule is rebuilt from the same diff
 *   (dropping the cached diffs that end at the version when the line changes), in one write with the
 *   delta.
 * Never replaces a stored delta or a TinyFish summary. A baseline, or a version with nothing missing, is
 * left alone. Throws on a row it cannot read; a delta that fails after the summary was written is logged
 * and reported as `failed`.
 */
async function fillVersion(db: D1Database, id: string, ignorePatterns: string): Promise<Filled> {
  const v = await versionWithPrevious(db, id);
  if (v === null || v.is_baseline === 1) return NOTHING;
  const previous = v.previous_id === null ? null : { text: v.previous_text, facts_json: v.previous_facts_json };
  if (v.summary === null) {
    const fromTinyFish = oneLine(v.judgment_summary);
    if (fromTinyFish !== null) return { ...NOTHING, pageId: v.page_id, summary: await setSummaryIfMissing(db, id, fromTinyFish, "tinyfish") };
  } else if (v.delta_json !== null) {
    return NOTHING;
  }

  const d = diffVersion(v, previous, ignorePatterns);
  const out: Filled = { ...NOTHING, pageId: v.page_id };
  if (v.summary === null) out.summary = await setSummaryIfMissing(db, id, diffSummary(d.diff, d.next), "diff");
  if (v.delta_json !== null) return out;
  try {
    const delta = deltaOf(d.diff, v, previous);
    const line = v.summary_source === "diff" ? diffSummary(d.diff, d.next) : null;
    const rebuilt = line !== null && line !== v.summary;
    out.delta = await setDeltaOnce(db, id, JSON.stringify(delta), rebuilt ? line : null);
    out.rebuilt = out.delta && rebuilt;
  } catch (err) {
    if (!out.summary) throw err;
    logError(`delta of version ${id} failed after its summary was stored`, err);
    out.failed = true;
  }
  return out;
}

/**
 * Computes one version's delta (and whatever summary it is missing, see fillVersion), whatever its size.
 * True when the delta was stored.
 */
export async function computeDelta(env: Env, versionId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT p.ignore_patterns FROM versions v JOIN pages p ON p.id = v.page_id WHERE v.id = ?")
    .bind(versionId)
    .first<{ ignore_patterns: string }>();
  if (row === null) return false;
  const filled = await fillVersion(env.DB, versionId, row.ignore_patterns);
  const changed = changedPages();
  changed.note(filled);
  await changed.drop(env);
  return filled.delta;
}

// --- A batch, within the per-call budget -----------------------------------------------------------

/**
 * Works through `candidates` oldest first while the texts diffed stay within SUMMARY_TEXT_BUDGET_CHARS
 * and at most FILL_DIFFS_PER_CALL are diffed. A candidate whose diff alone is over the budget is not
 * worked on and is listed in `oversized`, so a large page can never hold back the versions after it; so
 * is one that fails (a row that cannot be read), which is logged and does not stop the others. Each
 * version is written as it is filled, so a call that is cut off keeps what it wrote.
 */
async function fillBatch(
  db: D1Database,
  candidates: SummaryCandidate[],
  skip: (c: SummaryCandidate) => boolean,
  add: (f: Filled) => void,
): Promise<string[]> {
  const oversized: string[] = [];
  let chars = 0;
  let diffs = 0;
  let budgetLeft = true;
  for (const candidate of candidates) {
    if (skip(candidate)) continue;
    if (isOversized(candidate)) {
      oversized.push(candidate.id);
      continue;
    }
    // Oldest first: once one does not fit, the rest wait for the next call (oversized ones are still listed).
    if (!budgetLeft || diffs >= FILL_DIFFS_PER_CALL || chars + pairLength(candidate) > SUMMARY_TEXT_BUDGET_CHARS) {
      budgetLeft = false;
      continue;
    }
    chars += pairLength(candidate);
    diffs++;
    try {
      const filled = await fillVersion(db, candidate.id, candidate.ignore_patterns);
      add(filled);
      if (filled.failed) oversized.push(candidate.id);
    } catch (err) {
      logError(`fill of version ${candidate.id} failed`, err);
      oversized.push(candidate.id);
    }
  }
  return oversized;
}

// --- Summaries ----------------------------------------------------------------------------------------

/**
 * What a summary fill call answers. `remaining` counts every non-baseline version still without a summary;
 * `oversized` lists the versions the call left because their diff alone is over the per-call budget (each
 * is filled by `?version=<id>`, in an invocation of its own), or because they could not be read.
 */
export type FillAnswer = { filled: number; remaining: number; oversized: string[] };

/**
 * Fills missing summaries of non-baseline versions (baselines keep none).
 * - With `versionId`: that version only, whatever its size (the caller gives it an invocation of its own).
 * - Otherwise, first every version whose run carried TinyFish's summary, all of them, in one statement (no
 *   text is read). Then the versions that need a diff line, oldest first, within the per-call budget (see
 *   fillBatch). A diff line is stored with the version's delta, which needs the same diff.
 * A stored summary is never changed here, so calling it again changes nothing.
 */
export async function fillSummaries(env: Env, opts: { versionId?: string } = {}): Promise<FillAnswer> {
  const db = env.DB;
  let filled = 0;
  let oversized: string[] = [];
  const changed = changedPages();
  const add = (f: Filled): void => {
    if (f.summary) filled++;
    changed.note(f);
  };
  if (opts.versionId !== undefined) {
    const one = await versionMissingSummary(db, opts.versionId);
    if (one !== null) add(await fillVersion(db, one.id, one.ignore_patterns));
  } else {
    const judged = await versionsWithJudgmentMissingSummary(db);
    const fromTinyFish = judged.flatMap((v) => {
      const summary = oneLine(v.judgment_summary);
      return summary === null ? [] : [{ id: v.id, summary }];
    });
    const written = await setTinyFishSummaries(db, fromTinyFish);
    filled += written;
    if (written > 0) for (const v of judged) changed.note({ ...NOTHING, summary: true, pageId: v.page_id });
    const candidates = await versionsMissingSummary(db, DIFF_CANDIDATES_PER_CALL);
    // Versions with TinyFish's summary were stored just above (or by another call).
    oversized = await fillBatch(db, candidates, (c) => oneLine(c.judgment_summary) !== null, add);
  }
  await changed.drop(env);
  return { filled, remaining: await countMissingSummaries(db), oversized };
}

// --- Deltas ---------------------------------------------------------------------------------------

/**
 * What a delta fill call answers. `filled` counts deltas stored, `rebuilt` the diff summaries rewritten
 * under the line rule with them, `facts_filled` the deltas whose facts part was added; `remaining` counts
 * every non-baseline version still without a delta (those without a summary are the summary fill's);
 * `oversized` is as in FillAnswer.
 */
export type DeltaAnswer = { filled: number; rebuilt: number; facts_filled: number; remaining: number; oversized: string[] };

/**
 * Fills missing deltas of non-baseline versions that have a summary (baselines keep none).
 * - With `versionId`: that version only, whatever its size, if it has no delta.
 * - Otherwise, first the facts part of every delta whose two versions now both have stored facts (no text
 *   is read, one statement), then the versions without a delta, oldest first, within the per-call budget
 *   (see fillBatch).
 * A stored delta is never replaced, so calling it again changes nothing.
 */
export async function fillDeltas(env: Env, opts: { versionId?: string } = {}): Promise<DeltaAnswer> {
  const db = env.DB;
  const answer: DeltaAnswer = { filled: 0, rebuilt: 0, facts_filled: 0, remaining: 0, oversized: [] };
  const changed = changedPages();
  const add = (f: Filled): void => {
    if (f.delta) answer.filled++;
    if (f.rebuilt) answer.rebuilt++;
    changed.note(f);
  };
  if (opts.versionId !== undefined) {
    const one = await versionMissingDelta(db, opts.versionId);
    if (one !== null) add(await fillVersion(db, one.id, one.ignore_patterns));
  } else {
    const facts = await fillFactsDeltas(db);
    answer.facts_filled = facts.filled;
    for (const pageId of facts.pageIds) changed.note({ ...NOTHING, delta: true, pageId });
    answer.oversized = await fillBatch(db, await versionsMissingDelta(db, DIFF_CANDIDATES_PER_CALL), () => false, add);
  }
  await changed.drop(env);
  answer.remaining = await countMissingDeltas(db);
  return answer;
}

/** Adds the facts part to the deltas whose two versions now both have stored facts; returns how many. */
async function fillFactsDeltas(db: D1Database): Promise<{ filled: number; pageIds: string[] }> {
  const rows: { id: string; from: string; to: string }[] = [];
  const pageIds = new Set<string>();
  for (const c of await factsDeltaCandidates(db, FACTS_DELTAS_PER_CALL)) {
    let delta: Delta;
    try {
      delta = JSON.parse(c.delta_json) as Delta;
    } catch {
      continue;
    }
    const facts = factCounts(factsDiff(parseFacts(c.previous_facts_json), parseFacts(c.facts_json)));
    if (facts === null) continue;
    rows.push({ id: c.id, from: c.delta_json, to: JSON.stringify({ ...delta, facts }) });
    pageIds.add(c.page_id);
  }
  const filled = await replaceDeltas(db, rows);
  return { filled, pageIds: filled > 0 ? [...pageIds] : [] };
}

// --- The cron's one ?version= request a tick ----------------------------------------------------------

/**
 * The version the hourly cron fills with a `?version=<id>` request of its own this tick, or null: one of the
 * versions whose diff alone is over the per-call budget, taken in turn by the hour of day (the hour modulo
 * how many there are), so one that keeps failing cannot keep the others waiting.
 */
export async function oversizedForTick(db: D1Database, which: "summaries" | "deltas", now: Date): Promise<string | null> {
  const candidates =
    which === "summaries"
      ? (await versionsMissingSummary(db, DIFF_CANDIDATES_PER_CALL)).filter((c) => oneLine(c.judgment_summary) === null)
      : await versionsMissingDelta(db, DIFF_CANDIDATES_PER_CALL);
  const oversized = candidates.filter(isOversized);
  return oversized.length === 0 ? null : oversized[now.getUTCHours() % oversized.length]!.id;
}
