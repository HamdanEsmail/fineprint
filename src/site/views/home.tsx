// Home (GET /, optional before=<ISO>): what Fineprint is, the week in one line, and every change
// newest first as catch cards (DESIGN.md "Catch card"), twenty to a screen. Pages retired for
// unreliable reads are left out of the feed, the hero count and the stat blocks; one line under the
// feed says they exist and links to their record.
import type { ChangeItem, Stats } from "../../readModel";
import { DeltaBadge, EvidenceLine, hasDeltaBadge, LAYOUT_ONLY_LINE, StatBlock, Thumb } from "../components";
import { formatUtc, heroLine, heroParts, ownPath, plural, SUMMARY_ORIGIN } from "../format";
import { Layout } from "../layout";

/** Changes on one screen of the feed. */
export const FEED_SIZE = 20;

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
