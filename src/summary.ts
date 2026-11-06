// Filling a version's one-line summary out of band (Task 15). A change whose run carried TinyFish's
// judgment summary gets it when the version is inserted (src/db/versions.ts). Every other change needs a
// line built from Fineprint's own structured diff against the previous version, which means normalizing
// two page texts and diffing them: too much to add to a webhook or pull request on the free plan's 10 ms
// of CPU, where a CPU kill after the run is claimed would cost the version. So the new version's request
// asks for it through the SELF service binding (`summaryDeps.fill`), the way the cron runs a pull: the
// admin route POST /api/admin/backfill-summaries computes it in an invocation of its own. The same route
// is the one-off backfill of older versions, and the hourly cron calls it when any summary is missing.
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
  versionMissingSummary,
  versionsMissingSummary,
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
const CANDIDATES_PER_CALL = 50;

/**
 * Fills one version's summary: TinyFish's judgment summary when it has one, else the diff line against the
 * version captured before it (an empty page when there is none), both texts normalized with the page's
 * current ignore patterns. Never replaces a stored summary. Returns the characters of text it worked on.
 */
async function fillOne(db: D1Database, c: SummaryCandidate): Promise<{ filled: boolean; chars: number }> {
  const fromTinyFish = oneLine(c.judgment_summary);
  if (fromTinyFish !== null) return { filled: await setSummaryIfMissing(db, c.id, fromTinyFish, "tinyfish"), chars: 0 };

  const [version, previous] = await Promise.all([getVersion(db, c.id), previousVersionText(db, c)]);
  if (version === null) return { filled: false, chars: 0 };
  const patterns = readIgnorePatterns(c.ignore_patterns);
  const next = normalize(version.text, patterns).text;
  const prev = previous === null ? "" : normalize(previous, patterns).text;
  const summary = diffSummary(structuredDiff(prev, next), next);
  return { filled: await setSummaryIfMissing(db, c.id, summary, "diff"), chars: version.text.length + (previous?.length ?? 0) };
}

/**
 * Fills missing summaries of non-baseline versions (baselines keep none) and says how many are still
 * missing. With `versionId`, only that version, if it is one. Otherwise the oldest first, until the texts
 * worked on reach SUMMARY_TEXT_BUDGET_CHARS (always at least one diff); call again while `remaining` is
 * above 0. Each summary is written as it is made, so a call that is cut off keeps what it wrote, and a
 * second call never changes a stored one.
 */
export async function fillSummaries(env: Env, opts: { versionId?: string } = {}): Promise<{ filled: number; remaining: number }> {
  const db = env.DB;
  let filled = 0;
  if (opts.versionId !== undefined) {
    const one = await versionMissingSummary(db, opts.versionId);
    if (one !== null && (await fillOne(db, one)).filled) filled++;
  } else {
    let chars = 0;
    let diffs = 0;
    for (const candidate of await versionsMissingSummary(db, CANDIDATES_PER_CALL)) {
      // The estimate for a diff is twice the version's own text (its predecessor is about the same size).
      const estimate = oneLine(candidate.judgment_summary) === null ? 2 * candidate.text_length : 0;
      if (diffs > 0 && chars + estimate > SUMMARY_TEXT_BUDGET_CHARS) break;
      const done = await fillOne(db, candidate);
      if (done.filled) filled++;
      if (done.chars > 0) diffs++;
      chars += done.chars;
    }
  }
  return { filled, remaining: await countMissingSummaries(db) };
}
