// Home (GET /, optional before=<ISO>): what Fineprint is, the week in one line, and every change
// newest first as catch cards (DESIGN.md "Catch card"), twenty to a screen. Pages retired for
// unreliable reads are left out of the feed, the hero count and the stat blocks; one line under the
// feed says they exist and links to their record.
//
// Between the hero and the feed, the featured catch (the comp's "The latest catch, up close"): one changed
// block of a recent change, before and after with word marks, beside the two screenshots. It is the one
// place a first-time visitor sees a real before and after, and it runs on every home view, so it is bounded
// (see featuredCatch): it never diffs a large page on the home's own request.
import type { ChangedBlock } from "../../core/diff";
import type { CaptureStatus } from "../../db/types";
import type { Env } from "../../env";
import { featureCandidates, getDiff, type ChangeItem, type Stats } from "../../readModel";
import { BlockText, plainText } from "../blockText";
import { DeltaBadge, EvidenceLine, hasDeltaBadge, LAYOUT_ONLY_LINE, ShotFigure, StatBlock, Thumb } from "../components";
import { formatUtc, heroLine, heroParts, ownPath, plural, SUMMARY_ORIGIN } from "../format";
import { Layout } from "../layout";
import { hasMarks, wordDiff, type Part } from "../wordDiff";

/** Changes on one screen of the feed. */
export const FEED_SIZE = 20;

// --- The featured catch ---------------------------------------------------------------------------

/** The featured catch is the newest of this many changes (the first of the feed) that has a block to show. */
export const FEATURE_CHANGES = 10;
/** A changed block is shown when, cut to the lines that differ, each side's text is under this many characters. */
export const FEATURE_BLOCK_CHARS = 1200;
/**
 * The longest text (each side, in characters) the home diffs on its own request when the diff is not stored.
 * On the recorded texts of 6 Nov, in Node, normalize on both texts plus structuredDiff takes about 1.2 ms for
 * the 29 KB privacy policy, 2.4 ms for the 95 KB Gemini pricing, 5 to 6 ms for the 96 KB release notes and
 * 8 to 11 ms for the 228 KB ones: at this cap a cold home stays near 2 ms in all, and every pricing, fees and
 * policy page fits but Gemini's; the larger pages are left to the cache, which the compare view and the JSON
 * diff fill when they are first opened.
 */
export const FEATURE_TEXT_CAP = 40_000;
/** The longest stored diff (characters of JSON) the home reads and parses for the featured catch. */
export const FEATURE_CACHED_CAP = 64_000;
/** Diffs looked at on one home request, at most; of them at most one is computed rather than read from the cache. */
const FEATURE_TRIES = 3;
/** Changed blocks of one diff looked at, at most. */
const FEATURE_BLOCKS = 12;

/** One screenshot end of the featured catch. */
export type FeaturedShot = {
  captured_at: string;
  screenshot_url: string | null;
  thumb_url: string | null;
  source_url: string | null;
  capture_status: CaptureStatus;
};

export type Featured = {
  change: ChangeItem;
  /** The version before the change. */
  fromId: string;
  fromAt: string;
  /** The changed block's lines that differ, before and after, and the word marks over their plain text. */
  beforeText: string;
  afterText: string;
  before: Part[];
  after: Part[];
  /** Same-origin paths: the thumbnail, else the full screenshot; null when there is no image. */
  fromThumb: string | null;
  toThumb: string | null;
  fromShot: FeaturedShot;
  toShot: FeaturedShot;
  /** The page is retired or expired: a screenshot still missing will not come. */
  gone: boolean;
};

/**
 * A changed block cut down to the lines that differ: the lines both sides start and end with are dropped.
 * When that leaves one side empty (a line was only added or only removed), the whole block is kept, so both
 * sides have something to read.
 */
export function cutToChangedLines(block: Pick<ChangedBlock, "before" | "after">): { before: string; after: string } {
  const a = block.before.split("\n");
  const b = block.after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (endA === start || endB === start) return { before: block.before, after: block.after };
  return { before: a.slice(start, endA).join("\n"), after: b.slice(start, endB).join("\n") };
}

/** The first changed block of a diff that reads well on its own: short on both sides, and its words differ. */
function pickBlock(changed: ChangedBlock[]): { beforeText: string; afterText: string; before: Part[]; after: Part[] } | null {
  const budget = { steps: 60_000 };
  for (const block of changed.slice(0, FEATURE_BLOCKS)) {
    const cut = cutToChangedLines(block);
    const before = plainText(cut.before);
    const after = plainText(cut.after);
    if (before.length >= FEATURE_BLOCK_CHARS || after.length >= FEATURE_BLOCK_CHARS) continue;
    const marks = wordDiff(before, after, budget);
    if (marks === null || (!hasMarks(marks.before) && !hasMarks(marks.after))) continue;
    return { beforeText: cut.before, afterText: cut.after, before: marks.before, after: marks.after };
  }
  return null;
}

/**
 * The featured catch: the newest of the first FEATURE_CHANGES changes whose diff against the version before
 * it has a changed block that, cut down to the lines that differ, is under FEATURE_BLOCK_CHARS characters on
 * both sides and whose words differ. Null when none has (the section is then left out).
 *
 * Bounded, because it runs on every home view. The stored delta picks the candidates without a query: a
 * change with a changed block that is not layout only (the feed has no retired page). One query then gives,
 * for all of them, the version before, the two text lengths and the length of the stored diff. A candidate
 * is read only when its diff is stored (and at most FEATURE_CACHED_CAP long) or both its texts are at most
 * FEATURE_TEXT_CAP long; at most FEATURE_TRIES are read, and at most one of them diffed fresh (which stores
 * it for the next home, once both versions are final). A large page's change is featured once its diff is
 * stored: the compare view and the JSON diff store it when they are first opened.
 */
export async function featuredCatch(env: Env, changes: ChangeItem[]): Promise<Featured | null> {
  const candidates = changes.slice(0, FEATURE_CHANGES).filter((c) => {
    const changed = c.delta?.blocks?.changed;
    return typeof changed === "number" && changed > 0 && c.delta?.layout_only !== true;
  });
  if (candidates.length === 0) return null;
  const rows = new Map((await featureCandidates(env, candidates.map((c) => c.version_id))).map((r) => [r.id, r]));

  let tries = 0;
  let fresh = 0;
  for (const change of candidates) {
    if (tries >= FEATURE_TRIES) break;
    const row = rows.get(change.version_id);
    if (row === undefined) continue;
    const stored = row.cached_length !== null && row.cached_length <= FEATURE_CACHED_CAP;
    const small = row.from_length <= FEATURE_TEXT_CAP && row.to_length <= FEATURE_TEXT_CAP;
    if (!stored && !(small && fresh === 0)) continue;
    tries++;
    if (!stored) fresh++;
    // The cap holds even if the stored diff turns out not to be usable (a version no longer final).
    const diff = await getDiff(env, change.page_id, row.from.id, change.version_id, { maxTextChars: FEATURE_TEXT_CAP });
    if (diff === null) continue;
    const block = pickBlock(diff.blocks?.changed ?? []);
    if (block === null) continue;
    const toShot: FeaturedShot = {
      captured_at: change.captured_at,
      screenshot_url: change.screenshot_url,
      thumb_url: change.thumb_url,
      source_url: diff.to?.source_url ?? null,
      capture_status: row.capture_status,
    };
    const fromShot: FeaturedShot = { ...row.from, source_url: diff.from?.source_url ?? null };
    return {
      change,
      fromId: row.from.id,
      fromAt: row.from.captured_at,
      ...block,
      fromThumb: ownPath(fromShot.thumb_url ?? fromShot.screenshot_url),
      toThumb: ownPath(toShot.thumb_url ?? toShot.screenshot_url),
      fromShot,
      toShot,
      gone: row.page_status === "retired" || row.page_status === "expired",
    };
  }
  return null;
}

/** The comp's "The latest catch, up close": the one before and after a first-time visitor sees on the home. */
function FeaturedCatch(props: { featured: Featured }) {
  const { featured } = props;
  const c = featured.change;
  const pageHref = `/pages/${encodeURIComponent(c.page_id)}`;
  const compareHref = `${pageHref}/compare?from=${encodeURIComponent(featured.fromId)}&to=${encodeURIComponent(c.version_id)}`;
  return (
    <section class="featured" aria-labelledby="featured-h">
      <h2 id="featured-h">The latest catch, up close</h2>
      <article class="card feature">
        <p class="meta">
          <time datetime={c.captured_at}>{formatUtc(c.captured_at)}</time>
          <span>{c.page_label}</span>
        </p>
        {c.summary === null ? null : <p class="feature-summary">{c.summary}</p>}
        <div class="pair">
          <div class="side">
            <p class="label">{`Before · recorded ${formatUtc(featured.fromAt)}`}</p>
            <div class="diff-before">
              <BlockText text={featured.beforeText} marks={{ parts: featured.before, tag: "del" }} />
            </div>
          </div>
          <div class="side">
            <p class="label">{`After · recorded ${formatUtc(c.captured_at)}`}</p>
            <div class="diff-after">
              <BlockText text={featured.afterText} marks={{ parts: featured.after, tag: "ins" }} />
            </div>
          </div>
        </div>
        <div class="shots">
          <ShotFigure v={featured.fromShot} pageLabel={c.page_label} liveUrl={c.url} gone={featured.gone} />
          <ShotFigure v={featured.toShot} pageLabel={c.page_label} liveUrl={c.url} gone={featured.gone} />
        </div>
        <p class="actions">
          <a class="btn" href={compareHref}>
            Open the full comparison
          </a>
          <a class="btn secondary" href={pageHref}>
            See this page's history
          </a>
        </p>
        <EvidenceLine url={c.url} readAt={c.captured_at} trigger={c.trigger} />
      </article>
    </section>
  );
}

// --- The screen --------------------------------------------------------------------------------------

export type HomeProps = {
  stats: Stats;
  /** This week's real changes outside retired pages. */
  weekCount: number;
  /** Up to FEED_SIZE + 1 changes: one more than is shown says there are older ones. */
  changes: ChangeItem[];
  /** The before= this screen was asked for, as ISO, or null for the newest changes. */
  before: string | null;
  /** Retired pages that hold at least one change. */
  retiredWithChanges: number;
  /** The featured catch, or null to leave the section out (always on the older screens of the feed). */
  featured?: Featured | null;
};

/** "1 page was retired for unreliable reads. Its history is kept." and its plural. */
export function retiredLine(n: number): string {
  return n === 1
    ? "1 page was retired for unreliable reads. Its history is kept."
    : `${n} pages were retired for unreliable reads. Their history is kept.`;
}

/**
 * One change as a catch card (DESIGN.md "Catch card"): the thumbnail (the 640 by 400 one when there is
 * one, else the screenshot, by path) beside the label row, the title and the summary; under them the
 * delta badge, where the summary came from and the evidence line, which span the whole card on a phone.
 * A layout-only change shows the "Layout only" tag, its time without the accent, and the line that says
 * nothing in the words or figures moved.
 */
function CatchCard(props: { change: ChangeItem }) {
  const c = props.change;
  const time = formatUtc(c.captured_at);
  const pageHref = `/pages/${encodeURIComponent(c.page_id)}`;
  const layoutOnly = c.delta?.layout_only === true;
  const badge = hasDeltaBadge(c.delta);
  return (
    <li class="catch card">
      <Thumb
        src={ownPath(c.thumb_url ?? c.screenshot_url)}
        href={`${pageHref}/compare?to=${encodeURIComponent(c.version_id)}`}
        alt={`Screenshot of ${c.page_label} as recorded ${time}`}
        label={`Compare this change to ${c.page_label}`}
      />
      <div class="catch-body">
        <p class={layoutOnly ? "meta is-quiet" : "meta"}>
          <time datetime={c.captured_at}>{time}</time>
          {c.kind ? <span>{c.kind}</span> : null}
        </p>
        <h3>
          <a href={pageHref}>{c.page_label}</a>
        </h3>
        {c.summary === null ? <p class="summary is-pending">No summary yet.</p> : <p class="summary">{c.summary}</p>}
        {layoutOnly ? <p class="layout-note">{LAYOUT_ONLY_LINE}</p> : null}
      </div>
      <div class="catch-foot">
        {!badge && c.summary_source === null ? null : (
          <p class="row">
            {badge ? <DeltaBadge delta={c.delta} /> : null}
            {c.summary_source === null ? null : <span class="origin">{SUMMARY_ORIGIN[c.summary_source]}</span>}
          </p>
        )}
        <EvidenceLine url={c.url} readAt={c.captured_at} trigger={c.trigger} />
      </div>
    </li>
  );
}

export function Home(props: HomeProps) {
  const { stats } = props;
  const watched = stats.monitors.active;
  const hero = heroParts(props.weekCount);
  const shown = props.changes.slice(0, FEED_SIZE);
  const older = props.changes.length > FEED_SIZE ? shown[shown.length - 1] : undefined;
  const checks = stats.runs_by_trigger.webhook + stats.runs_by_trigger.pull;

  return (
    <Layout
      title="Fineprint: a dated record of the small print"
      description={`${heroLine(props.weekCount)} Fineprint keeps a dated record, with a screenshot, every time a pricing, fees, terms or rules page changes, so you can see what was true on any day.`}
      stats={stats}
      current="home"
    >
      <div class="wrap hero-grid">
        <div>
          <h1 class="hero">
            {hero.before}
            {hero.count === null ? null : <em>{hero.count}</em>}
            {hero.after}
          </h1>
          <p class="lede">
            Fineprint watches the pages you agree to without reading: prices, fees, terms, visa rules. Every time one of them
            changes, it keeps a dated record with a screenshot, so you can see what was true on any day.
          </p>
          <ol class="steps">
            <li>
              <span class="n" aria-hidden="true">
                1
              </span>
              <b>Watch</b>
              <span class="t">{`TinyFish Monitor reads each of ${plural(watched, "page")} twice a day.`}</span>
            </li>
            <li>
              <span class="n" aria-hidden="true">
                2
              </span>
              <b>Catch</b>
              <span class="t">A real difference becomes a dated version with a screenshot. Noise is filtered out.</span>
            </li>
            <li>
              <span class="n" aria-hidden="true">
                3
              </span>
              <b>Compare</b>
              <span class="t">Pick any two dates and see exactly which words changed.</span>
            </li>
          </ol>
        </div>
        <div class="stats" role="group" aria-label="The record so far">
          <StatBlock figure={String(watched)} label="Pages watched" />
          <StatBlock figure={String(stats.changes)} label="Real changes" isKey />
          <StatBlock figure={String(checks)} label="Checks run" />
          <StatBlock figure={String(stats.noise_suppressed)} label="Noise filtered" />
        </div>
      </div>

      <div class="wrap">
        {props.featured ? <FeaturedCatch featured={props.featured} /> : null}
        <section id="feed" aria-labelledby="feed-h">
          <h2 id="feed-h">Every change, newest first</h2>
          {props.before === null ? null : (
            <p class="page-note">
              {`Changes recorded before ${formatUtc(props.before)}. `}
              <a href="/#feed">Back to the newest</a>
            </p>
          )}
          {shown.length === 0 ? (
            <p class="empty card">
              {props.before === null
                ? `No changes recorded yet. ${plural(watched, "page")} ${watched === 1 ? "is" : "are"} checked twice a day.`
                : `No changes recorded before ${formatUtc(props.before)}.`}
            </p>
          ) : (
            <ul class="feed">
              {shown.map((change) => (
                <CatchCard change={change} />
              ))}
            </ul>
          )}
          {older === undefined ? null : (
            <p class="more">
              <a class="btn secondary" href={`/?before=${encodeURIComponent(older.captured_at)}#feed`}>
                Older changes
              </a>
            </p>
          )}
          {props.retiredWithChanges > 0 ? (
            <p class="retired-note">
              <a href="/watchlist#retired">{retiredLine(props.retiredWithChanges)}</a>
            </p>
          ) : null}
        </section>
      </div>
    </Layout>
  );
}
