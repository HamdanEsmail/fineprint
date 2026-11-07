// Home (GET /, optional before=<ISO>), top to bottom:
//
// 1. The opening, the one Persuade surface on the site: what Fineprint is in one line and a lede, the two
//    actions, and beside them (under them on a phone) the product itself, the featured catch (the comp's
//    "The latest catch, up close"): one changed block of a recent change, before and after with word marks,
//    beside the two screenshots. Under both, the live line: since when, and the stat blocks' figures.
// 2. What it answers: the three questions, each with a real, linked example.
// 3. Built for the TinyFish Time Machine bounty: each requirement with its live proof and one link, how each
//    TinyFish service is used with its figure, and the cost line.
// 4. Every change newest first as catch cards (DESIGN.md "Catch card"), twenty to a screen, with the stat
//    blocks beside them (above them on a phone).
//
// Pages retired for unreliable reads are left out of the feed, the counts and the stat blocks; one line under
// the feed says they exist and links to their record. The older screens of the feed (before=) keep the opening
// without the featured catch and leave out 2 and 3. The featured catch runs on every newest home view, so it
// is bounded (see featuredCatch): it never diffs a large page on the home's own request.
import type { Child } from "hono/jsx";
import type { ChangedBlock } from "../../core/diff";
import type { CaptureStatus } from "../../db/types";
import { LARGE_DIFF_TEXT_CHARS, PUBLIC_TTL_DAYS } from "../../core/limits";
import type { Env } from "../../env";
import { featureCandidates, getDiff, type AsOfExample, type ChangeItem, type Stats } from "../../readModel";
import { BlockText, plainText } from "../blockText";
import { DeltaBadge, EvidenceLine, hasDeltaBadge, LAYOUT_ONLY_LINE, ShotFigure, StatBlock, Thumb } from "../components";
import { checksRun, costLine, daysSince, formatDate, formatUtc, liveParts, ownPath, plural, SUMMARY_ORIGIN } from "../format";
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
 * policy page fits but Gemini's; a larger page's diff is read only from the cache, which the hourly job fills
 * ahead of readers (src/cron.ts, LARGE_DIFF_TEXT_CHARS), as do the compare view and the JSON diff.
 */
export const FEATURE_TEXT_CAP = LARGE_DIFF_TEXT_CHARS;
/** The longest stored diff (characters of JSON) the home reads and parses for the featured catch. */
export const FEATURE_CACHED_CAP = 64_000;
/** Diffs looked at on one home request, at most; of them at most one is computed rather than read from the cache. */
const FEATURE_TRIES = 3;
/**
 * A changed block's differing lines, as recorded, longer than this are not looked at: what the featured catch
 * shows is under FEATURE_BLOCK_CHARS once its marks are gone, and links rarely more than treble a line.
 */
const FEATURE_RAW_CHARS = 4 * FEATURE_BLOCK_CHARS;
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
    // The raw lines first, before any work on them: a stored block can be a whole page, or 25,000 "[".
    if (cut.before.length > FEATURE_RAW_CHARS || cut.after.length > FEATURE_RAW_CHARS) continue;
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
 * it for the next home, once both versions are final). A large page's change is read from the cache only
 * and featured once its diff is stored: the hourly job stores one such diff a tick, and the compare view and
 * the JSON diff store it when they are first opened. A changed block whose differing lines are over
 * FEATURE_RAW_CHARS as recorded is passed over before any work is done on it.
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
    // A large pair is read from the cache only (not even its texts are read when that misses); a small one may
    // be diffed, and the cap holds whatever the cache said.
    const diff = await getDiff(env, change.page_id, row.from.id, change.version_id, small ? { maxTextChars: FEATURE_TEXT_CAP } : { storedOnly: true });
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

/** The comparison of the featured catch's change with the version before it. */
const featuredCompareHref = (featured: Featured): string =>
  `/pages/${encodeURIComponent(featured.change.page_id)}/compare?from=${encodeURIComponent(featured.fromId)}&to=${encodeURIComponent(featured.change.version_id)}`;

/**
 * The comp's "The latest catch, up close": the one before and after a first-time visitor sees on the home, as
 * the opening's product shot. Its caption line says it is a real catch and when it was recorded; the heading
 * names the section for a screen reader (on screen the caption line does).
 */
function FeaturedCatch(props: { featured: Featured }) {
  const { featured } = props;
  const c = featured.change;
  const pageHref = `/pages/${encodeURIComponent(c.page_id)}`;
  const compareHref = featuredCompareHref(featured);
  return (
    <section class="featured" aria-labelledby="featured-h">
      <h2 id="featured-h" class="vh">
        The latest catch, up close
      </h2>
      <article class="card feature">
        <p class="meta">
          <span class="caught">
            A real catch, recorded <time datetime={c.captured_at}>{formatUtc(c.captured_at)}</time>
          </span>
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
        {/* Paper buttons: in the opening, the one ink button is "See what changed this week". */}
        <p class="actions">
          <a class="btn secondary" href={compareHref}>
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
  /** This week's real changes outside retired pages, leaving out layout-only ones (as Stats.changes does). */
  weekCount: number;
  /** Up to FEED_SIZE + 1 changes: one more than is shown says there are older ones. */
  changes: ChangeItem[];
  /** The before= this screen was asked for, as ISO, or null for the newest changes. */
  before: string | null;
  /** Retired pages that hold at least one change. */
  retiredWithChanges: number;
  /** The featured catch, or null to leave the section out (always on the older screens of the feed). */
  featured?: Featured | null;
  /** The page for "What did this page say on a date?" (asOfExample), or null to leave that example out. */
  asOf?: AsOfExample | null;
  /** The time of the request, for the days of recording. */
  nowMs: number;
};

/** The opening's line and lede; the page's title and description are made from them. */
export const OPENING = {
  h1: "A dated record of the web's small print.",
  lede: [
    "Fineprint watches the pages you agree to without reading: pricing, fees, terms, privacy policies, visa and baggage rules.",
    "Every real change is recorded with the date, the text and a full-page screenshot, so you can see what a page said on any day, and exactly which words changed since.",
  ],
} as const;

/** "6 Nov 2026 to 7 Nov 2026", or the one date when both ends were recorded on the same day. */
function dateSpan(fromIso: string, toIso: string): string {
  const from = formatDate(fromIso);
  const to = formatDate(toIso);
  return from === to ? to : `${from} to ${to}`;
}

/** A figure in a sentence of proof, with its noun: "<b>20</b> pages", "<b>1</b> page". */
function Fig(props: { n: number; one?: string; many?: string }) {
  const { n, one } = props;
  return (
    <>
      <b class="fig">{String(n)}</b>
      {one === undefined ? null : ` ${n === 1 ? one : (props.many ?? `${one}s`)}`}
    </>
  );
}

/** The live line: the stat blocks' figures in one mono line, set apart so a phone breaks it between parts. */
function LiveLine(props: { stats: Stats }) {
  const parts = liveParts(props.stats);
  return (
    <p class="liveline">
      {parts.map((part, i) => (
        <>
          {i === 0 ? null : " · "}
          <span>{part}</span>
        </>
      ))}
    </p>
  );
}

/** One question the record answers, with its real example. */
type Ask = { question: string; href: string; text: string };

/** The examples that can be shown: the as-of one needs a page with two versions, the comparison a change. */
function asks(props: HomeProps, compare: { href: string; text: string } | null): Ask[] {
  const list: Ask[] = [];
  if (props.asOf) {
    const { page_id, label, first_at, second_at } = props.asOf;
    // Halfway between the first two versions: the first is the one in force, and it is not the newest.
    const mid = new Date((Date.parse(first_at) + Date.parse(second_at)) / 2).toISOString();
    list.push({
      question: `What did this page say on ${formatDate(mid)}?`,
      href: `/pages/${encodeURIComponent(page_id)}?at=${encodeURIComponent(mid)}`,
      text: `${label}, as of ${formatDate(mid)}`,
    });
  }
  if (compare !== null) list.push({ question: "What changed between two dates?", ...compare });
  list.push({
    question: "What changed on the web this week?",
    href: "#feed",
    text: props.weekCount > 0 ? `${plural(props.weekCount, "real change")} this week, newest first` : "The feed, newest first",
  });
  return list;
}

/** The comparison the examples point to: the featured catch's, else the newest change's (against the version before it). */
function compareExample(featured: Featured | null, newest: ChangeItem | undefined): { href: string; text: string } | null {
  if (featured) {
    const c = featured.change;
    return { href: featuredCompareHref(featured), text: `${c.page_label}, ${dateSpan(featured.fromAt, c.captured_at)}` };
  }
  if (newest === undefined) return null;
  return {
    href: `/pages/${encodeURIComponent(newest.page_id)}/compare?to=${encodeURIComponent(newest.version_id)}`,
    text: `${newest.page_label}, ${formatDate(newest.captured_at)}`,
  };
}

/** The screenshot row's proof: both counts in one sentence only when every version has both. */
function evidenceProof(s: Stats) {
  const has = (n: number): string => (n === 1 ? "has" : "have");
  if (s.versions_with_screenshot === s.versions && s.versions_with_source === s.versions) {
    return (
      <>
        <Fig n={s.versions_with_screenshot} /> of <Fig n={s.versions} one="recorded version" /> {has(s.versions_with_screenshot)} a full-page
        screenshot and the stored source.
      </>
    );
  }
  return (
    <>
      <Fig n={s.versions_with_screenshot} /> of <Fig n={s.versions} one="recorded version" /> {has(s.versions_with_screenshot)} a full-page
      screenshot, and <Fig n={s.versions_with_source} /> {has(s.versions_with_source)} the stored source.
    </>
  );
}

type Requirement = { name: string; proof: Child; links: { href: string; text: string }[] };

/** The bounty's requirements, each with its live proof and its link, with the figures from the stats. */
function requirements(props: HomeProps, compare: { href: string; text: string } | null): Requirement[] {
  const s = props.stats;
  const runs = s.runs_by_trigger;
  const newest = props.changes[0];
  const since = s.recording_since;
  const free = Math.max(0, s.public_slots.total - s.public_slots.used);
  return [
    {
      name: "Monitor does the core work",
      proof: (
        <>
          <Fig n={s.monitors.active} one="page" /> read twice a day by TinyFish Monitor: <Fig n={runs.webhook} one="scheduled check" />{" "}
          delivered by webhook, <Fig n={runs.pull} /> fetched when one was overdue. Delete the Monitors and nothing new is ever recorded.
        </>
      ),
      links: [{ href: "/watchlist", text: "Watchlist" }],
    },
    {
      name: "A screenshot for every change",
      proof: evidenceProof(s),
      links:
        newest === undefined
          ? []
          : [{ href: `/pages/${encodeURIComponent(newest.page_id)}?v=${encodeURIComponent(newest.version_id)}#version`, text: "The newest version" }],
    },
    {
      name: "As-of lookup and a structured diff",
      proof: "Pick a date on any page; compare any two versions section by section, with the changed words marked.",
      links: compare === null ? [] : [{ href: compare.href, text: "The comparison above" }],
    },
    {
      name: "Real changes caught live",
      proof: (
        <>
          <Fig n={s.changes} one="real change" />
          {since === null ? (
            " so far"
          ) : (
            <>
              {` since ${formatDate(since)} (`}
              <Fig n={daysSince(since, props.nowMs)} one="day" />
              {" of recording)"}
            </>
          )}
          . <Fig n={s.noise_suppressed} one="noise event" /> filtered; <Fig n={s.layout_only} one="layout-only change" /> labelled, kept and
          shown.
        </>
      ),
      links: [{ href: "#feed", text: "The feed" }],
    },
    {
      name: "Works for any page you add",
      proof: (
        <>
          <Fig n={free} /> of <Fig n={s.public_slots.total} one="public slot" /> free; a public page is watched for {PUBLIC_TTL_DAYS} days and
          refused with the reason when it cannot be read.
        </>
      ),
      links: [{ href: "/watchlist#add", text: "Add a page" }],
    },
    {
      name: "Reusable by other tools",
      proof: "An open JSON API with CORS, and a full export.",
      links: [
        { href: "/about#data", text: "The API" },
        { href: "/api/export.json", text: "The full export" },
      ],
    },
  ];
}

/** How each TinyFish service is used, one sentence each with its live figure. */
function services(s: Stats): { name: string; use: Child }[] {
  return [
    {
      name: "Monitor",
      use: (
        <>
          <Fig n={checksRun(s)} one="check" /> of the watched pages, each sent to Fineprint by webhook or, when one was overdue, run on
          request.
        </>
      ),
    },
    {
      name: "Fetch",
      use: (
        <>
          <Fig n={s.pages} one="page" /> validated and <Fig n={s.versions_with_source} one="source" /> stored: each page is read before it is
          added, and each version's HTML is kept.
        </>
      ),
    },
    {
      name: "Browser",
      use: (
        <>
          <Fig n={s.versions_with_screenshot} one="screenshot" /> and <Fig n={s.thumbnails} one="thumbnail" />: the whole page as it was read,
          and the small copy the feed shows.
        </>
      ),
    },
    {
      name: "Agent",
      use: (
        <>
          Price tables read for <Fig n={s.versions_with_facts} one="version" /> of pricing and fee pages.
        </>
      ),
    },
    { name: "Search", use: "Finds a site's pricing, terms and fees pages on the watchlist, free." },
  ];
}

/** 3. Built for the TinyFish Time Machine bounty: the requirements with their proof, the services, the cost. */
function Bounty(props: { home: HomeProps; compare: { href: string; text: string } | null }) {
  const s = props.home.stats;
  return (
    <section class="bounty" id="bounty" aria-labelledby="bounty-h">
      <h2 id="bounty-h">Built for the TinyFish Time Machine bounty</h2>
      <p class="section-lede">Every line below is live data from the recorder, not a description.</p>
      <ul class="reqs">
        {requirements(props.home, props.compare).map((r) => (
          <li class="req">
            <h3>{r.name}</h3>
            <p class="req-proof">{r.proof}</p>
            {r.links.length === 0 ? null : (
              <p class="req-link">
                {r.links.map((l, i) => (
                  <>
                    {i === 0 ? null : " · "}
                    <a href={l.href}>{l.text}</a>
                  </>
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>
      <h3 class="services-h" id="services-h">
        How each TinyFish service is used
      </h3>
      <table class="table services" aria-labelledby="services-h">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Its use so far</th>
          </tr>
        </thead>
        <tbody>
          {services(s).map((row) => (
            <tr>
              <th scope="row">{row.name}</th>
              <td>{row.use}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="costline">{costLine(s)}</p>
      <p class="bounty-more">
        <a href="/about">Read how it works</a>
      </p>
    </section>
  );
}

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
 * nothing in the words or figures moved. The About screen shows the featured catch's card the same way.
 */
export function CatchCard(props: { change: ChangeItem }) {
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
  const shown = props.changes.slice(0, FEED_SIZE);
  const older = props.changes.length > FEED_SIZE ? shown[shown.length - 1] : undefined;
  const featured = props.featured ?? null;
  // The older screens of the feed are the feed: the opening stays (the one h1), the examples and the proof do not.
  const newest = props.before === null;
  const compare = newest ? compareExample(featured, props.changes[0]) : null;

  return (
    <Layout
      title="Fineprint: a dated record of the web's small print"
      description={`${OPENING.h1} ${OPENING.lede[0]}`}
      stats={stats}
      current="home"
    >
      <div class={featured === null ? "wrap opening" : "wrap opening has-shot"}>
        <div class="opening-text">
          <h1 class="hero">{OPENING.h1}</h1>
          <p class="lede">{`${OPENING.lede[0]} ${OPENING.lede[1]}`}</p>
          <p class="actions">
            <a class="btn" href="#feed">
              See what changed this week
            </a>
            <a class="btn secondary" href="/watchlist#add">
              Watch a page of your own
            </a>
          </p>
        </div>
        {/* Under the opening's words on a phone; under the words and the catch from 1000px (site.css). */}
        <LiveLine stats={stats} />
        {featured === null ? null : <FeaturedCatch featured={featured} />}
      </div>

      <div class="wrap">
        {newest ? (
          <section class="answers" aria-labelledby="answers-h">
            <h2 id="answers-h">What it answers</h2>
            <ul class="asks">
              {asks(props, compare).map((a) => (
                <li>
                  <h3>{a.question}</h3>
                  <p>
                    <a href={a.href}>{a.text}</a>
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {newest ? <Bounty home={props} compare={compare} /> : null}

        <section id="feed" aria-labelledby="feed-h">
          <h2 id="feed-h">Every change, newest first</h2>
          {props.before === null ? null : (
            <p class="page-note">
              {`Changes recorded before ${formatUtc(props.before)}. `}
              <a href="/#feed">Back to the newest</a>
            </p>
          )}
          <div class="feed-grid">
            <div class="stats" role="group" aria-label="The record so far">
              <StatBlock figure={String(watched)} label="Pages watched" />
              <StatBlock figure={String(stats.changes)} label="Real changes" isKey />
              <StatBlock figure={String(checksRun(stats))} label="Checks run" />
              <StatBlock figure={String(stats.noise_suppressed)} label="Noise filtered" />
            </div>
            <div class="feed-main">
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
            </div>
          </div>
        </section>
      </div>
    </Layout>
  );
}
