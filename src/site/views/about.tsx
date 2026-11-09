// About (GET /about): a Read surface, written for someone with five minutes. What Fineprint is and since when;
// how a change is recorded, in five steps beside a diagram; one real change followed start to finish (the
// home's featured catch, annotated); how each TinyFish product is used, with its live figure; what counts as
// noise, with the live counts, and what is kept but labelled; the honest limits; the public API with a
// copyable curl for each read; and who built it. Every figure comes from the read model the JSON API uses,
// and every number in the copy from src/core/limits.ts, so this screen cannot disagree with the others.
import {
  CURATED_PAUSED_ON,
  FACTS_PAUSE_USD,
  FLAP_WINDOW_MS,
  PUBLIC_ADDS_PER_IP_PER_DAY,
  PUBLIC_SLOTS,
  PUBLIC_TTL_DAYS,
  SPEND_PAUSE_USD,
} from "../../core/limits";
import type { Child } from "hono/jsx";
import type { ChangeItem, PageSummary, Stats } from "../../readModel";
import { BlockText } from "../blockText";
import { LAYOUT_ONLY_LINE, ShotFigure, StatusChip } from "../components";
import { formatUsd, formatUtc, ownPath, plural, sourceLabel, SUMMARY_ORIGIN, triggerLabel, webHref } from "../format";
import { Layout, type ScreenLink } from "../layout";
import { CatchCard, type Featured } from "./home";

export type AboutProps = {
  stats: Stats;
  /** Where the screen lives, for its link preview (src/site/layout.tsx). */
  link: ScreenLink;
  /** The home's featured catch (the same change, read under the same caps), or null when there is none. */
  featured: Featured | null;
  /** The newest change on a page that is not retired, for the curl examples when there is no featured catch. */
  sample: ChangeItem | null;
  /** The newest layout-only change on a page that is not retired: the one linked example. */
  layoutExample: ChangeItem | null;
  /** The pages retired for unreliable reads, from the page list. */
  retired: PageSummary[];
  /** PUBLIC_BASE_URL without a trailing slash: the host the curl examples call. */
  baseUrl: string;
  /** REPO_URL when it is an http or https url, else null (no link). */
  repoUrl: string | null;
};

const pageHref = (id: string): string => `/pages/${encodeURIComponent(id)}`;

/** A time as the site shows it, in a time element. */
const When = (props: { at: string }) => <time datetime={props.at}>{formatUtc(props.at)}</time>;

// --- 2. How a change is recorded ----------------------------------------------------------------------

const STEPS: { title: string; text: string }[] = [
  {
    title: "Monitor checks the page",
    text: "TinyFish Monitor reads each watched page twice a day on its own schedule and sends every result to Fineprint by webhook. When a scheduled check is overdue, Fineprint asks Monitor to run it now; that run is marked pulled.",
  },
  {
    title: "The read is cleaned of noise",
    text: 'Timestamps, "last updated" lines, cookie banners and similar lines are removed, then the read is compared with the latest version. A read that differs only in those is counted as noise and recorded as nothing more.',
  },
  {
    title: "A real difference becomes a version",
    text: "If the words or figures still differ, Fineprint records a new version of the page, dated to the read. A read that looks half-loaded is held until a second read agrees.",
  },
  {
    title: "The evidence is captured",
    text: "TinyFish Browser takes a full-page screenshot and TinyFish Fetch keeps the page's HTML source. TinyFish Agent reads the price table on pricing and fee pages, not on pages visitors add, and not for changes TinyFish judged irrelevant.",
  },
  {
    title: "The change is published",
    text: "It appears in the change feed and in the page's history with a one-line summary and its evidence line, and the JSON API returns the same record.",
  },
];

/**
 * The five steps as a flow, drawn top to bottom so it keeps its type size on a phone: the check, the cleaning
 * with noise leaving to the side, the version (the one accent shape), the three captures, the feed. Colour
 * comes from site.css (token variables only); the steps beside it say the same in words.
 */
function FlowDiagram() {
  return (
    <svg class="flow-svg" viewBox="0 0 320 420" width="320" height="420" role="img" aria-labelledby="flow-title flow-desc">
      <title id="flow-title">How a change is recorded</title>
      <desc id="flow-desc">
        A TinyFish Monitor check reads the page. Fineprint cleans the read and compares it with the latest version; a read
        that differs only in noise is counted and nothing is kept. A real difference becomes a new dated version. TinyFish
        Browser takes its screenshot, TinyFish Fetch its source and, on pricing pages, TinyFish Agent its price table. The
        change then appears in the feed and the API.
      </desc>
      <defs>
        <marker id="flow-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
          <path class="flow-headshape" d="M0 0 L8 4 L0 8 z" />
        </marker>
      </defs>

      <rect class="flow-box" x="12" y="8" width="176" height="52" rx="2" />
      <text class="flow-t" x="24" y="30">Scheduled check</text>
      <text class="flow-s" x="24" y="48">TinyFish Monitor</text>
      <path class="flow-line" d="M100 60 V88" marker-end="url(#flow-head)" />

      <rect class="flow-box" x="12" y="92" width="176" height="52" rx="2" />
      <text class="flow-t" x="24" y="114">Clean and compare</text>
      <text class="flow-s" x="24" y="132">Fineprint</text>
      <path class="flow-line" d="M188 118 H200" marker-end="url(#flow-head)" />
      <rect class="flow-box is-aside" x="204" y="92" width="104" height="52" rx="2" />
      <text class="flow-t" x="214" y="114">Noise</text>
      <text class="flow-s" x="214" y="132">counted only</text>
      <path class="flow-line" d="M100 144 V172" marker-end="url(#flow-head)" />

      <rect class="flow-box is-key" x="12" y="176" width="176" height="52" rx="2" />
      <text class="flow-t is-key" x="24" y="198">New version</text>
      <text class="flow-s" x="24" y="216">Fineprint, dated</text>

      <path class="flow-line" d="M100 228 V244 M58 244 H262" />
      <path class="flow-line" d="M58 244 V264" marker-end="url(#flow-head)" />
      <path class="flow-line" d="M160 244 V264" marker-end="url(#flow-head)" />
      <path class="flow-line" d="M262 244 V264" marker-end="url(#flow-head)" />
      <rect class="flow-box" x="12" y="268" width="92" height="52" rx="2" />
      <text class="flow-t is-small" x="58" y="290" text-anchor="middle">Screenshot</text>
      <text class="flow-s" x="58" y="308" text-anchor="middle">Browser</text>
      <rect class="flow-box" x="114" y="268" width="92" height="52" rx="2" />
      <text class="flow-t is-small" x="160" y="290" text-anchor="middle">Source</text>
      <text class="flow-s" x="160" y="308" text-anchor="middle">Fetch</text>
      <rect class="flow-box" x="216" y="268" width="92" height="52" rx="2" />
      <text class="flow-t is-small" x="262" y="290" text-anchor="middle">Price table</text>
      <text class="flow-s" x="262" y="308" text-anchor="middle">Agent</text>

      <path class="flow-line" d="M58 320 V336 M262 320 V336 M160 320 V336 M58 336 H262" />
      <path class="flow-line" d="M160 336 V356" marker-end="url(#flow-head)" />
      <rect class="flow-box" x="12" y="360" width="296" height="52" rx="2" />
      <text class="flow-t" x="24" y="382">Feed and API</text>
      <text class="flow-s" x="24" y="400">Fineprint, every screen and /api</text>
    </svg>
  );
}

// --- 3. One change, start to finish -------------------------------------------------------------------

/** What found the change, in one sentence, by the way its run arrived. */
function checkCaption(c: ChangeItem): string {
  const time = formatUtc(c.captured_at);
  if (c.trigger === "pull") {
    return `The scheduled check was overdue, so Fineprint asked TinyFish Monitor to run it now. That run read the page on ${time} and is marked pulled.`;
  }
  if (c.trigger === "webhook") return `TinyFish Monitor's scheduled check read the page on ${time} and sent the result to Fineprint by webhook.`;
  return `A TinyFish Monitor run read the page on ${time}.`;
}

function Step(props: { n: number; title: string; caption: string; children: unknown }) {
  return (
    <li class="trail-step">
      <div class="trail-note">
        <span class="n" aria-hidden="true">
          {String(props.n)}
        </span>
        <h3>{props.title}</h3>
        <p>{props.caption}</p>
      </div>
      <div class="trail-body">{props.children}</div>
    </li>
  );
}

/** The featured catch, followed through the record in four annotated steps: the real record, not a description of one. */
function StartToFinish(props: { featured: Featured }) {
  const { featured } = props;
  const c = featured.change;
  const compareHref = `${pageHref(c.page_id)}/compare?from=${encodeURIComponent(featured.fromId)}&to=${encodeURIComponent(c.version_id)}`;
  const live = webHref(c.url);
  const source = ownPath(featured.toShot.source_url);
  return (
    <ol class="trail">
      <Step n={1} title="The check that found it" caption={checkCaption(c)}>
        <dl class="slip">
          <div>
            <dt>Page</dt>
            <dd>
              <a href={pageHref(c.page_id)}>{c.page_label}</a>
              <span class="slip-url">{live === null ? sourceLabel(c.url) : <a href={live}>{sourceLabel(c.url)}</a>}</span>
            </dd>
          </div>
          <div>
            <dt>Read</dt>
            <dd class="is-change">
              <When at={c.captured_at} />
            </dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd>{c.trigger === null ? "Monitor" : triggerLabel(c.trigger)}</dd>
          </div>
          <div>
            <dt>Compared with</dt>
            <dd>
              {"The version recorded "}
              <When at={featured.fromAt} />
            </dd>
          </div>
        </dl>
      </Step>
      <Step
        n={2}
        title="The cleaned text that differed"
        caption="Once the noise was cleaned away, this part of the page still read differently from the version before, so the read became a new version. Struck words are gone; marked words are new."
      >
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
      </Step>
      <Step
        n={3}
        title="The screenshots taken"
        caption="TinyFish Browser takes a full-page screenshot of each version, and TinyFish Fetch keeps its HTML source. Open a screenshot to see the whole page as it was read."
      >
        <div class="shots">
          <ShotFigure v={featured.fromShot} pageLabel={c.page_label} liveUrl={c.url} gone={featured.gone} />
          <ShotFigure v={featured.toShot} pageLabel={c.page_label} liveUrl={c.url} gone={featured.gone} />
        </div>
        {source === null ? null : (
          <p class="trail-link">
            <a href={source}>The stored source of the new version</a>
          </p>
        )}
      </Step>
      <Step
        n={4}
        title="The entry in the feed"
        caption="The change went into the feed with its one-line summary, where that summary came from, and the evidence line. GET /api/changes returns the same entry."
      >
        <ul class="feed">
          <CatchCard change={c} />
        </ul>
        <p class="actions">
          <a class="btn" href={compareHref}>
            Open the full comparison
          </a>
          <a class="btn secondary" href={pageHref(c.page_id)}>
            See this page's history
          </a>
        </p>
      </Step>
    </ol>
  );
}

// --- 4. How TinyFish is used ----------------------------------------------------------------------------

function Uses(props: { stats: Stats }) {
  const { stats } = props;
  const runs = stats.runs_by_trigger;
  const spend = stats.spend_by_kind;
  const total = runs.create + runs.webhook + runs.pull;
  const rows: { name: string; does: string; figure: string; note: string }[] = [
    {
      name: "Monitor",
      does: "Checks each watched page on its schedule and sends every run by webhook; when a scheduled check is overdue, Fineprint asks Monitor to run it now and records that run, marked pulled.",
      figure: formatUsd(spend.monitor_check),
      note: `${plural(total, "run")}: ${plural(runs.create, "baseline")}, ${runs.webhook} by webhook, ${runs.pull} pulled`,
    },
    {
      name: "Fetch",
      does: "Reads each version's HTML source for the stored copy, and reads a page before it is added, to make sure it can be watched.",
      figure: formatUsd(spend.fetch),
      note: "Free",
    },
    {
      name: "Browser",
      does: "Takes the full-page screenshot of each version and its thumbnail, over the Chrome DevTools Protocol.",
      figure: formatUsd(spend.screenshot),
      note: "Screenshots",
    },
    {
      name: "Agent",
      does: "Reads the price table on pricing and fee pages, not on pages visitors add, and not for changes TinyFish judged irrelevant; one run at a time, and a run that finds no prices is final for that version.",
      figure: formatUsd(spend.agent_step),
      note: "Price tables",
    },
    {
      name: "Search",
      does: "Finds a site's pricing, terms, privacy and fee pages for Find a site's small print, on the watchlist.",
      figure: formatUsd(spend.search),
      note: "Free",
    },
  ];
  return (
    <table class="table uses">
      <caption class="vh">The five TinyFish products Fineprint uses, what each does here, and its use so far</caption>
      <thead>
        <tr>
          <th scope="col">Product</th>
          <th scope="col">What it does here</th>
          <th scope="col" class="num">
            Spend so far
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <th scope="row">{r.name}</th>
            <td class="uses-does">{r.does}</td>
            <td class="num uses-fig">
              <span class="uses-usd">{r.figure}</span>
              <span class="uses-note">{r.note}</span>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">All five</th>
          <td class="uses-does">Every billed call is written to the spend ledger, which the footer adds up on every screen.</td>
          <td class="num uses-fig">
            <span class="uses-usd">{formatUsd(stats.spend_usd)}</span>
            <span class="uses-note">{`of the $${SPEND_PAUSE_USD} budget`}</span>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

// --- 5. What counts as noise ------------------------------------------------------------------------------

const FLAP_HOURS = FLAP_WINDOW_MS / 3_600_000;

const NOISE: { id: string; reason: string; term: string; text: string }[] = [
  {
    id: "cleaning",
    reason: "normalized_identical",
    term: "Same after cleaning",
    text: 'Timestamps, "last updated" lines, cookie banners, share counters and tracking parameters are removed before comparing. A read that matches the latest version once they are gone is not a change.',
  },
  {
    id: "partial-render",
    reason: "partial_render",
    term: "Partial render",
    text: "A read much shorter than the latest version, with nothing added, is most likely a page that loaded only in part: a partial render. Nothing is recorded until a second read agrees.",
  },
  {
    id: "layout-hold",
    reason: "layout_hold",
    term: "Layout hold",
    text: "A shorter read that drops many blocks of the page and adds almost none is held the same way, until a second read agrees.",
  },
  {
    id: "flap",
    reason: "flap",
    term: "Flap",
    text: `A read that matches a version recorded in the last ${FLAP_HOURS} hours is a page flipping between two renderings, not a change.`,
  },
];

function Noise(props: { stats: Stats; layoutExample: ChangeItem | null; retired: PageSummary[] }) {
  const { stats, layoutExample, retired } = props;
  const known = NOISE.reduce((sum, n) => sum + (stats.noise_by_reason[n.reason] ?? 0), 0);
  const other = Math.max(0, stats.noise_suppressed - known);
  const reads = (n: number): string => plural(n, "read");
  return (
    <>
      <p class="section-lede">
        {`Most reads that differ from the latest version are not changes. Fineprint sets them aside before anything is recorded, and counts them: ${reads(stats.noise_suppressed)} so far.`}
      </p>
      <dl class="noise">
        {NOISE.map((n) => (
          <div class="noise-row" id={`noise-${n.id}`}>
            <dt>{n.term}</dt>
            <dd class="noise-n">{reads(stats.noise_by_reason[n.reason] ?? 0)}</dd>
            <dd class="noise-text">{n.text}</dd>
          </div>
        ))}
        {other === 0 ? null : (
          <div class="noise-row" id="noise-other">
            <dt>Other</dt>
            <dd class="noise-n">{reads(other)}</dd>
            <dd class="noise-text">Set aside for a reason not listed here; the page's check log names it.</dd>
          </div>
        )}
      </dl>

      <h3 class="kept-h">Kept, but labelled</h3>
      <div class="kept">
        <div class="kept-item">
          <p class="kept-tag">
            <span class="tag">Layout only</span>
            <span class="kept-n">{stats.layout_only === 0 ? "None yet" : `${plural(stats.layout_only, "change")} so far`}</span>
          </p>
          <p>
            {`${LAYOUT_ONLY_LINE} Such a change stays in the record and the feed, with its screenshots and its comparison, but is not counted as a real change.`}
            {stats.layout_only === 0 ? " No change has been labelled layout only yet." : null}
          </p>
          {layoutExample === null ? null : (
            <p class="kept-link">
              {"See one: "}
              <a href={`${pageHref(layoutExample.page_id)}/compare?to=${encodeURIComponent(layoutExample.version_id)}`}>
                {`${layoutExample.page_label}, ${formatUtc(layoutExample.captured_at)}`}
              </a>
            </p>
          )}
        </div>
        {retired.length === 0 ? null : (
          <div class="kept-item">
            <p class="kept-tag">
              <StatusChip status="retired" />
              <span class="kept-n">{plural(retired.length, "page")}</span>
            </p>
            <p>
              Retired by hand, so far for one reason: the page rendered differently from one read to the next, so a difference
              between two reads did not have to mean a change. Fineprint stopped watching it, and everything recorded while it was
              watched stays. The retire date was not recorded; the date shown is when its newest version was recorded.
            </p>
            <ul class="kept-pages">
              {retired.map((p) => (
                <li>
                  <a href={pageHref(p.id)}>{p.label}</a>
                  <span class="kept-line">No longer watched. Its history is kept.</span>
                  <span class="kept-count">{`${plural(p.version_count, "version")}${p.latest_version_at === null ? "" : `; newest recorded ${formatUtc(p.latest_version_at)}`}`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

// --- 6. Honest limits ------------------------------------------------------------------------------------

function Limits(props: { stats: Stats }) {
  const items: { lead: string; text: string }[] = [
    {
      lead: "No history before a page is added.",
      text: "Fineprint records from its first read of a page, the baseline. It cannot say what a page said before that.",
    },
    {
      lead: "Each watched page is checked twice a day.",
      text: "A change is dated by the check that found it, which can be up to about twelve hours after the page itself changed.",
    },
    {
      lead: "Not every summary is TinyFish's.",
      text: `When a Monitor run arrives with a summary of its own, Fineprint keeps it. So far TinyFish has sent one for every change it judged relevant to the page's purpose and for none it judged irrelevant. A pulled check carries no judgment, and any change that arrives without a summary gets a one-line summary built from Fineprint's own diff. Each card says which: "${SUMMARY_ORIGIN.tinyfish}" or "${SUMMARY_ORIGIN.diff}".`,
    },
    {
      lead: "Text is the diff; screenshots are evidence.",
      text: "A change is found by comparing the page's text. A change only in an image or in the styling is not caught, but the screenshot shows the page as it was read.",
    },
    {
      lead: `Public pages stop after ${PUBLIC_TTL_DAYS} days.`,
      text: `Anyone can add a page to one of the ${PUBLIC_SLOTS} public slots, ${PUBLIC_ADDS_PER_IP_PER_DAY === 1 ? "one" : PUBLIC_ADDS_PER_IP_PER_DAY} per visitor per day. It is watched for ${PUBLIC_TTL_DAYS} days, never gets a price table, and its history is kept.`,
    },
    {
      lead: "A small, fixed budget.",
      text: `At $${FACTS_PAUSE_USD} of TinyFish spend, spending on price tables is paused: a change recorded after that says its price table was not read, and is still recorded with its screenshot and diff. At $${SPEND_PAUSE_USD}, Fineprint starts nothing more that costs money on its side: no overdue-check pull, screenshot, stored source or price table, and no new page can be added. The Monitors' own scheduled checks keep running, and a change they report is still kept as a version, without its screenshot or stored source. Spend so far: ${formatUsd(props.stats.spend_usd)}.`,
    },
    {
      lead: "The home counts can trail by up to an hour.",
      text: "Home, About and the watchlist are served from a copy rebuilt every hour and whenever a new version is recorded, so their counts and the recording or paused state can be up to an hour behind.",
    },
  ];
  return (
    <ul class="limits">
      {items.map((i) => (
        <li>
          <b>{i.lead}</b> {i.text}
        </li>
      ))}
    </ul>
  );
}

// --- 7. Use the data -------------------------------------------------------------------------------------

/** Ids and times for the curl examples: real ones from the record when there are any. */
type Example = { pageId: string; versionId: string; at: string; fromAt: string };

function example(featured: Featured | null, sample: ChangeItem | null): Example {
  if (featured !== null) {
    const c = featured.change;
    return { pageId: c.page_id, versionId: c.version_id, at: c.captured_at, fromAt: featured.fromAt };
  }
  if (sample !== null) return { pageId: sample.page_id, versionId: sample.version_id, at: sample.captured_at, fromAt: sample.captured_at };
  return { pageId: "PAGE_ID", versionId: "VERSION_ID", at: "2026-11-05T09:12:00Z", fromAt: "2026-11-04T09:12:00Z" };
}

/** A curl for one url: quoted when it carries a query, so a shell (cmd.exe too) passes it whole. */
const curl = (url: string): string => (url.includes("?") ? `curl "${url}"` : `curl ${url}`);

function Endpoints(props: { baseUrl: string; ex: Example }) {
  const { baseUrl, ex } = props;
  // Ids and ISO times in a query, encoded but for the colons of the times, so the command stays readable.
  const q = (value: string): string => encodeURIComponent(value).replaceAll("%3A", ":");
  const page = `/api/pages/${encodeURIComponent(ex.pageId)}`;
  const list: { path: string; text: Child; url: string }[] = [
    {
      path: "/api/changes",
      text: (
        <>
          Every real change across all pages, newest first, with its summary and evidence. <code>since=</code>, <code>before=</code>{" "}
          and <code>limit=</code> narrow it; <code>retired=0</code> leaves out retired pages.
        </>
      ),
      url: `${baseUrl}/api/changes`,
    },
    { path: "/api/pages", text: "Every page with its status, schedule, latest version time, version count and noise count.", url: `${baseUrl}/api/pages` },
    { path: "/api/pages/:id", text: "One page, its versions without their text, and its newest 100 checks.", url: `${baseUrl}${page}` },
    {
      path: "/api/pages/:id/versions/:vid",
      text: "One version with its full recorded text, its screenshot, source and live links.",
      url: `${baseUrl}${page}/versions/${q(ex.versionId)}`,
    },
    { path: "/api/pages/:id/as-of?at=", text: "The version that was in force at a moment (ISO 8601).", url: `${baseUrl}${page}/as-of?at=${q(ex.at)}` },
    {
      path: "/api/pages/:id/diff?from=&to=",
      text: "The structured diff between the versions in force at two moments: blocks added, removed and changed, and the price facts.",
      url: `${baseUrl}${page}/diff?from=${q(ex.fromAt)}&to=${q(ex.at)}`,
    },
    { path: "/api/stats", text: "The figures on this screen: runs by trigger, noise by reason, spend by kind, monitor health, the two pauses.", url: `${baseUrl}/api/stats` },
  ];
  return (
    <>
      <ul class="endpoints">
        {list.map((e) => (
          <li>
            <h3>
              <code>
                <span class="verb">GET</span> {e.path}
              </code>
            </h3>
            <p>{e.text}</p>
            <div class="cmd">
              <pre data-copy="">{curl(e.url)}</pre>
            </div>
          </li>
        ))}
        <li>
          <h3>
            <code>
              <span class="verb">GET</span> /api/export.json
            </code>
          </h3>
          <p>
            Every page and every version, without the page texts, with absolute screenshot and source urls.{" "}
            <a href="/api/export.json">Download everything as JSON</a>
          </p>
          <div class="cmd">
            <pre data-copy="">{`curl -o fineprint.json ${baseUrl}/api/export.json`}</pre>
          </div>
        </li>
      </ul>
      <p class="page-note endpoints-note">
        {"A version's screenshot, thumbnail and stored source are at "}
        <code>{"/shots/<id>.jpg"}</code>, <code>{"/thumbs/<id>.jpg"}</code> and <code>{"/sources/<id>.html"}</code>
        {", by version id. The sources are served sandboxed: their scripts never run."}
      </p>
    </>
  );
}

// --- The screen ------------------------------------------------------------------------------------------

/**
 * The opening's note while any page is paused: when and why recording of the curated pages stopped, that nothing
 * was deleted, and what is still watched (active or failed, as the watchlist counts it). Null with nothing paused.
 */
function pausedNote(stats: Stats): string | null {
  const paused = stats.monitors.paused;
  if (paused === 0) return null;
  const watched = stats.monitors.active + stats.monitors.failed;
  const still = watched === 0 ? "No page is watched now" : watched === 1 ? "One page is still watched" : `${watched} pages are still watched`;
  return (
    `Recording of ${plural(paused, "curated page")} was paused on ${CURATED_PAUSED_ON}, once the bounty entry was ready to submit, to hold the TinyFish spend. ` +
    "Nothing was deleted: every version, screenshot, source, diff and check log is still shown. " +
    `${still}, and any page added on the watchlist starts a Monitor of its own for ${PUBLIC_TTL_DAYS} days.`
  );
}

const TOC: { id: string; text: string }[] = [
  { id: "how", text: "How a change is recorded" },
  { id: "example", text: "One change, start to finish" },
  { id: "tinyfish", text: "How TinyFish is used" },
  { id: "noise", text: "What counts as noise" },
  { id: "limits", text: "Honest limits" },
  { id: "data", text: "Use the data" },
];

export function About(props: AboutProps) {
  const { stats, featured } = props;
  const since = stats.recording_since;
  const note = pausedNote(stats);
  return (
    <Layout
      title="How Fineprint works · Fineprint"
      description="How Fineprint records each real change to pricing, fees, terms and rules pages with TinyFish: the five steps, one change start to finish, what counts as noise, the honest limits and the public API."
      stats={stats}
      current="about"
      link={props.link}
    >
      <div class="wrap about">
        <header class="page-head about-head">
          <h1>How Fineprint works</h1>
          <p class="lede">
            Fineprint keeps a public, dated record of the pages people agree to without reading: pricing, fees, terms, privacy
            policies and travel rules. Each time one of them really changes, it keeps the new text, a full-page screenshot and the
            page's source, so anyone can see what the page said on any day and exactly what changed.
          </p>
          <p class="since">
            {since === null ? (
              "Not recording yet: no page has been added."
            ) : (
              <>
                Recording since <When at={since} />
              </>
            )}
          </p>
          {note === null ? null : <p class="paused-note">{note}</p>}
        </header>

        <div class="about-grid">
          <nav class="toc" aria-label="On this page">
            <p class="toc-title">On this page</p>
            <ol>
              {TOC.map((t) => (
                <li>
                  <a href={`#${t.id}`}>{t.text}</a>
                </li>
              ))}
            </ol>
          </nav>

          <div class="about-body">
            <section id="how" aria-labelledby="how-h">
              <h2 id="how-h">How a change is recorded</h2>
              <div class="flow">
                <ol class="flow-steps">
                  {STEPS.map((s, i) => (
                    <li>
                      <span class="n" aria-hidden="true">
                        {String(i + 1)}
                      </span>
                      <div>
                        <h3>{s.title}</h3>
                        <p>{s.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <figure class="flow-figure">
                  <FlowDiagram />
                </figure>
              </div>
            </section>

            <section id="example" aria-labelledby="example-h">
              <h2 id="example-h">One change, start to finish</h2>
              {featured === null ? (
                <p class="section-lede">
                  {stats.changes === 0 ? (
                    "No change has been recorded yet. The first one will be followed here, from the check that found it to its entry in the feed."
                  ) : (
                    <>
                      {"None of the latest changes can be shown here start to finish; each one is in "}
                      <a href="/#feed">the feed</a>
                      {", with its screenshot and its comparison."}
                    </>
                  )}
                </p>
              ) : (
                <>
                  <p class="section-lede">
                    A change from the home screen, followed through the record: what found it, what differed, what was captured and
                    what was published.
                  </p>
                  <StartToFinish featured={featured} />
                </>
              )}
            </section>

            <section id="tinyfish" aria-labelledby="tinyfish-h">
              <h2 id="tinyfish-h">How TinyFish is used</h2>
              <p class="section-lede">
                Fineprint never reads a page itself to find a change: every version comes from a TinyFish Monitor run. Four more
                TinyFish products gather the evidence and the search.
              </p>
              <Uses stats={stats} />
              <p class="keyline">If every Monitor were deleted, nothing new would ever be recorded.</p>
            </section>

            <section id="noise" aria-labelledby="noise-h">
              <h2 id="noise-h">What counts as noise</h2>
              <Noise stats={stats} layoutExample={props.layoutExample} retired={props.retired} />
            </section>

            <section id="limits" aria-labelledby="limits-h">
              <h2 id="limits-h">Honest limits</h2>
              <Limits stats={stats} />
            </section>

            <section id="data" aria-labelledby="data-h">
              <h2 id="data-h">Use the data</h2>
              <p class="section-lede">
                Every record is public JSON, open to any site and with no key. Times are ISO 8601 in UTC; the ids are the ones in
                the site's own links.
              </p>
              <Endpoints baseUrl={props.baseUrl} ex={example(featured, props.sample)} />
            </section>

            <p class="credit">
              Built by Hamdan Esmail for the TinyFish Time Machine bounty.
              {props.repoUrl === null ? null : (
                <>
                  {" "}
                  <a href={props.repoUrl}>Source code</a>
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </Layout>
  );
}
