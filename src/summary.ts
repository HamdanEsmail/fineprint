// Filling a version's one-line summary out of band (Task 15). A change whose run carried TinyFish's
// judgment summary gets it when the version is inserted (src/db/versions.ts). Every other change needs a
// line built from Fineprint's own structured diff against the previous version, which means normalizing
// two page texts and diffing them: too much to add to a webhook or pull request on the free plan's 10 ms
// of CPU, where a CPU kill after the run is claimed would cost the version. So the new version's request
// asks for it through the SELF service binding (`summaryDeps.fill`), the way the cron runs a pull: the
// admin route POST /api/admin/backfill-summaries computes it in an invocation of its own. The same route
// is the one-off backfill of older versions, and the hourly cron calls it when any summary is missing. A
// version too large to diff alongside others (a 100 KB release-notes page) is only ever filled by a
// request for that version alone, so it can never hold back the rest.
import { structuredDiff } from "./core/diff";
import { readIgnorePatterns } from "./core/gate";
import { SUMMARY_TEXT_BUDGET_CHARS } from "./core/limits";
import { normalize } from "./core/normalize";
import { diffSummary, oneLine } from "./core/summary";
import {
  countMissingSummaries,
  getVersion,
  previousVersionText,
  setSummaryIfMissing,
  setTinyFishSummaries,
  versionMissingSummary,
  versionsMissingSummary,
  versionsWithJudgmentMissingSummary,
  type SummaryCandidate,
} from "./db/versions";
import type { Env } from "./env";

/**
 * The seam tests use instead of vi.mock. `fill` asks the Worker to fill summaries in an invocation of its
 * own: one version's when an id is given, else the oldest missing ones within the per-call budget.
 */
export const summaryDeps = {
  fill: (env: Env, versionId?: string): Promise<Response> =>
    env.SELF.fetch(
      new Request(
        `https://fineprint.internal/api/admin/backfill-summaries${versionId === undefined ? "" : `?version=${encodeURIComponent(versionId)}`}`,
        { method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } },
      ),
    ),
};

/**
 * Asks for a fill (see summaryDeps) and never throws: a failure is logged with its status, or an error's
 * name and message, and the version keeps no summary until the backfill or the cron's next call fills it.
 */
export async function requestSummary(env: Env, versionId?: string): Promise<void> {
  const what = `summary fill for ${versionId === undefined ? "missing versions" : `version ${versionId}`}`;
  try {
    const res = await summaryDeps.fill(env, versionId);
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) console.error(`${what} failed`, `status=${res.status}`);
  } catch (err) {
    console.error(`${what} failed`, err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error");
  }
}

/** At most this many candidates are looked at in one call (the text budget usually stops it first). */
/** At most this many versions needing a diff line are looked at in one call (metadata only, no text). */
const DIFF_CANDIDATES_PER_CALL = 200;

/** The text a diff line of this version works on: its own and the one before it. */
const pairLength = (c: SummaryCandidate): number => c.text_length + c.previous_length;

/** Too large to diff inside a call that does other work: filled only by a call of its own (`?version=<id>`). */
const isOversized = (c: SummaryCandidate): boolean => pairLength(c) > SUMMARY_TEXT_BUDGET_CHARS;

/**
 * Fills one version's summary: TinyFish's judgment summary when it has one, else the diff line against the
 * version captured before it (an empty page when there is none), both texts normalized with the page's
 * current ignore patterns. Never replaces a stored summary.
 */
async function fillOne(db: D1Database, c: SummaryCandidate): Promise<boolean> {
  const fromTinyFish = oneLine(c.judgment_summary);
  if (fromTinyFish !== null) return setSummaryIfMissing(db, c.id, fromTinyFish, "tinyfish");

  const [version, previous] = await Promise.all([getVersion(db, c.id), previousVersionText(db, c)]);
  if (version === null) return false;
  const patterns = readIgnorePatterns(c.ignore_patterns);
  const next = normalize(version.text, patterns).text;
  const prev = previous === null ? "" : normalize(previous, patterns).text;
  return setSummaryIfMissing(db, c.id, diffSummary(structuredDiff(prev, next), next), "diff");
}

/**
 * What a fill call answers. `remaining` counts every non-baseline version still without a summary;
 * `oversized` lists the versions the call left because their diff alone is over the per-call budget (each
 * is filled by `?version=<id>`, in an invocation of its own).
 */
export type FillAnswer = { filled: number; remaining: number; oversized: string[] };

/**
 * Fills missing summaries of non-baseline versions (baselines keep none).
 * - With `versionId`: that version only, whatever its size (the caller gives it an invocation of its own).
 * - Otherwise, first every version whose run carried TinyFish's summary, all of them, in one statement (no
 *   text is read). Then the versions that need a diff line, oldest first, while the texts worked on stay
 *   within SUMMARY_TEXT_BUDGET_CHARS. A version whose diff alone would be over the budget is not worked on
 *   here and is listed in `oversized`, so a large page can never hold back the versions after it.
 * Each summary is written as it is made, so a call that is cut off keeps what it wrote, and a second call
 * never changes a stored one.
 */
export async function fillSummaries(env: Env, opts: { versionId?: string } = {}): Promise<FillAnswer> {
  const db = env.DB;
  let filled = 0;
  const oversized: string[] = [];
  if (opts.versionId !== undefined) {
    const one = await versionMissingSummary(db, opts.versionId);
    if (one !== null && (await fillOne(db, one))) filled++;
  } else {
    const fromTinyFish = (await versionsWithJudgmentMissingSummary(db)).flatMap((v) => {
      const summary = oneLine(v.judgment_summary);
      return summary === null ? [] : [{ id: v.id, summary }];
    });
    filled += await setTinyFishSummaries(db, fromTinyFish);

    let chars = 0;
    let budgetLeft = true;
    for (const candidate of await versionsMissingSummary(db, DIFF_CANDIDATES_PER_CALL)) {
      if (oneLine(candidate.judgment_summary) !== null) continue; // stored just above (or by another call)
      if (isOversized(candidate)) {
        oversized.push(candidate.id);
        continue;
      }
      // Oldest first: once one does not fit, the rest wait for the next call (oversized ones are still listed).
      if (!budgetLeft || chars + pairLength(candidate) > SUMMARY_TEXT_BUDGET_CHARS) {
        budgetLeft = false;
        continue;
      }
      if (await fillOne(db, candidate)) filled++;
      chars += pairLength(candidate);
    }
  }
  return { filled, remaining: await countMissingSummaries(db), oversized };
}

/**
 * The oldest version still without a summary whose diff is over the per-call budget, or null. The cron
 * fills it with a `?version=<id>` request of its own, at most one a tick.
 */
export async function oldestOversizedSummary(db: D1Database): Promise<string | null> {
  for (const candidate of await versionsMissingSummary(db, DIFF_CANDIDATES_PER_CALL)) {
    if (oneLine(candidate.judgment_summary) === null && isOversized(candidate)) return candidate.id;
  }
  return null;
}
