// Watchlist (GET /watchlist, optional domain=, url= and label=; POST /watchlist): every page Fineprint
// watches as a dense table (cards on a phone), then the pages no longer watched (#retired), then the one
// place a visitor acts: the public add form (#add), with the slots and any refusal beside it, and the
// search for a site's small print (#find). The add and the search call the same addPage and discover as
// the JSON routes, so their caps, daily limits and refusals are the API's own; this file only says them.
import { MAX_MONITORS, MAX_URL_LENGTH, PUBLIC_SLOTS, PUBLIC_TTL_DAYS } from "../../core/limits";
import type { PageStatus } from "../../db/types";
import type { DiscoverAnswer } from "../../handlers/discover";
import { MAX_LABEL_LENGTH } from "../../handlers/pages";
import type { PageSummary, Stats } from "../../readModel";
import { StatusChip } from "../components";
import { cronToWords, formatUtc, plural, sourceLabel, webHref } from "../format";
import { Layout } from "../layout";

/** A refused add as the screen shows it: the add's own refusal (src/handlers/pages.ts AddRefusal), or the form's. */
export type Refusal = { error: string; reason?: string; existing_page_id?: string | null; retry_after?: string | null };

/** What the search box was sent and what came of it. */
export type FindState = { typed: string; answer: DiscoverAnswer };

export type WatchlistProps = {
  stats: Stats;
  /** Every page, in the order they were added (listPages). */
  pages: PageSummary[];
  /** What the add form shows in its fields: what was typed, or what a Watch this page link carried. */
  form: { url: string; label: string };
  refusal: Refusal | null;
  find: FindState | null;
  /** The screen answers a form or a search: kept out of search engines. */
  noindex: boolean;
  nowMs: number;
};

/** A page that is no longer watched: retired for unreliable reads, or past its 7 days. */
const isGone = (status: PageStatus | null): boolean => status === "retired" || status === "expired";

// --- What a refusal says -----------------------------------------------------------------------

/** The slots line when every public slot is held: when the next frees, or that it is due (the hourly job expires it). */
export function slotsFullLine(nextFreeAt: string | null | undefined, nowMs: number): string {
  const all = `All ${PUBLIC_SLOTS} public slots are in use.`;
  if (!nextFreeAt) return all;
  return Date.parse(nextFreeAt) <= nowMs ? `${all} The next one frees within the hour.` : `${all} The next one frees on ${formatUtc(nextFreeAt)}.`;
}

/** Words for the TinyFetch reasons an `unfetchable` add carries, and for the reasons that are codes. */
const BY_REASON: Record<string, string> = {
  login_required: "That page needs a login, so it cannot be watched.",
  bot_blocked: "That site refuses automated reading, so it cannot be watched.",
  timeout: "That page did not answer in time. Try again in a minute.",
  target_http_error: "That page returned an error when read.",
  url_too_long: `That address is longer than ${MAX_URL_LENGTH} characters. Use a shorter link to the same page.`,
  empty_page: "That page has no text Fineprint can read, so it cannot be watched.",
  fetch_failed: "Fineprint could not reach its page reader just now. Nothing was added. Try again in a minute.",
};

/** What the add form says while recording is paused at the budget line: as the slots line, and as a refusal. */
const PAUSED_LINE = "Recording is paused at the budget line, so no new page can be added until it lifts.";

/** Words for the add's error codes (and the form's own three), when the reason has none. */
const BY_ERROR: Record<string, string> = {
  daily_limit: "One public page per visitor per day. Come back tomorrow.",
  already_watched: "Fineprint already watches that page.",
  invalid_url: "That is not an address Fineprint can watch. Use the full address of a public page, starting with https://.",
  invalid_label: `A label can be at most ${MAX_LABEL_LENGTH} characters.`,
  watchlist_full: `Fineprint already watches its maximum of ${MAX_MONITORS} pages.`,
  monitor_create_failed: "TinyFish could not start watching that page. Nothing was added. Try again later.",
  internal_error: "Something went wrong while adding the page. Nothing was added. Try again in a minute.",
  spend_paused: PAUSED_LINE,
  cross_site: "That form was sent from another site, so it was not read. Use the form on this page.",
  invalid_body: "That request was not a form Fineprint reads. Use the form on this page.",
  form_too_large: "That form is larger than Fineprint reads.",
};

/**
 * What a refused add says beside the form, keyed by the TinyFetch reason it carries or by its error code
 * (`public_slots_full` says when the next slot frees, from `nextFreeAt`). A reason this has no words for is
 * shown as it came, inside a sentence; nothing at all is "The page was not added.", never an empty line.
 */
export function addErrorCopy(error: string, reason: string, nextFreeAt?: string | null, nowMs: number = Date.now()): string {
  if (error === "public_slots_full") return slotsFullLine(nextFreeAt, nowMs);
  const words = BY_REASON[reason] ?? BY_ERROR[error];
  if (words !== undefined) return words;
  if (error === "unfetchable" && reason !== "") return `That page could not be read (${reason}), so it cannot be watched.`;
  if (reason !== "") return /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return "The page was not added.";
}

/** Which field a refusal is about, so it is marked invalid and described by the refusal. */
function refusedField(error: string): "url" | "label" | null {
  if (error === "invalid_label") return "label";
  return ["invalid_url", "already_watched", "unfetchable", "monitor_create_failed"].includes(error) ? "url" : null;
}

// --- The tables --------------------------------------------------------------------------------

const pageHref = (id: string): string => `/pages/${encodeURIComponent(id)}`;

/** A time in a table cell: "5 Nov 2026, 09:12 UTC", its date and its clock each kept whole, so a narrow column breaks it once. */
function When(props: { at: string | null; none: string; isChange?: boolean }) {
  if (props.at === null) return <span class="wl-none">{props.none}</span>;
  const text = formatUtc(props.at);
  const cut = text.indexOf(", ");
  return (
    <time class={props.isChange ? "is-change" : undefined} datetime={props.at}>
      {cut === -1 ? (
        text
      ) : (
        <>
          <span class="wl-d">{text.slice(0, cut + 1)}</span> <span class="wl-d">{text.slice(cut + 2)}</span>
        </>
      )}
    </time>
  );
}

/** The line a page no longer watched carries (the site plan's honest states); an expired page that was not a public add says only that it is no longer watched. */
function goneLine(p: PageSummary): string {
  return p.status === "expired" && p.added_by === "public"
    ? `Watched for ${PUBLIC_TTL_DAYS} days as a public page. Its history is kept.`
    : "No longer watched. Its history is kept.";
}

/** How a page is read: how often on one line, at what times (UTC) under it; a page no longer watched says so instead. */
function Schedule(props: { p: PageSummary }) {
  const { p } = props;
  if (isGone(p.status)) return <>{goneLine(p)}</>;
  if (p.status === "paused") return <>Checks are paused</>;
  if (p.schedule_cron === null) return <>No schedule stored</>;
  const words = cronToWords(p.schedule_cron);
  if (words === p.schedule_cron) {
    return (
      <>
        <span class="wl-freq">On its own schedule</span>
        <span class="wl-at">{`${p.schedule_cron} (UTC)`}</span>
      </>
    );
  }
  // "twice a day, at 02:14 and 14:14 UTC", or "four times a day" with no times.
  const [often, at] = words.split(", at ");
  return (
    <>
      <span class="wl-freq">{`${often![0]!.toUpperCase()}${often!.slice(1)}`}</span>
      {at === undefined ? null : <span class="wl-at">{at}</span>}
    </>
  );
}

function PageRow(props: { p: PageSummary }) {
  const { p } = props;
  const gone = isGone(p.status);
  return (
    <tr>
      <th scope="row" class="wl-page">
        <a href={pageHref(p.id)}>{p.label}</a>
        <span class="wl-meta">
          {p.kind ? <span class="wl-kind">{p.kind}</span> : null}
          <span class="wl-url" title={p.url}>
            {sourceLabel(p.url)}
          </span>
        </span>
        {!gone && p.added_by === "public" && p.expires_at !== null ? (
          <span class="wl-note">
            Public until <time datetime={p.expires_at}>{formatUtc(p.expires_at)}</time>
          </span>
        ) : null}
      </th>
      <td class="wl-status">
        <StatusChip status={p.status} />
      </td>
      <td class={gone ? "wl-sched is-gone" : "wl-sched"}>
        <Schedule p={p} />
      </td>
      <td class="wl-when" data-label="Last check">
        <When at={p.last_run_at} none="Not checked yet" />
      </td>
      <td class="wl-when" data-label="Last change">
        <When at={p.last_change_at} none="No change yet" isChange />
      </td>
      <td class="num" data-label="Versions">{p.version_count}</td>
      <td class="num" data-label="Noise">{p.noise_count}</td>
    </tr>
  );
}

function PageTable(props: { pages: PageSummary[]; caption: string; gone: boolean }) {
  return (
    <table class="table wl">
      <caption class="vh">{props.caption}</caption>
      <thead>
        <tr>
          <th scope="col">Page</th>
          <th scope="col">Status</th>
          <th scope="col">{props.gone ? "Record" : "Schedule"}</th>
          <th scope="col">Last check</th>
          <th scope="col">Last change</th>
          <th scope="col" class="num">
            Versions
          </th>
          <th scope="col" class="num">
            Noise
          </th>
        </tr>
      </thead>
      <tbody>
        {props.pages.map((p) => (
          <PageRow p={p} />
        ))}
      </tbody>
    </table>
  );
}

// --- Add a page --------------------------------------------------------------------------------

function SlotCells(props: { used: number }) {
  const cells = Array.from({ length: PUBLIC_SLOTS }, (_, i) => i < props.used);
  return (
    <span class="slot-cells" aria-hidden="true">
      {cells.map((held) => (
        <span class={held ? "slot is-held" : "slot"}></span>
      ))}
    </span>
  );
}

function RefusalBox(props: { refusal: Refusal; pages: PageSummary[]; stats: Stats; nowMs: number }) {
  const { refusal } = props;
  const existing = refusal.error === "already_watched" && refusal.existing_page_id ? props.pages.find((p) => p.id === refusal.existing_page_id) : undefined;
  const text =
    existing !== undefined && isGone(existing.status)
      ? "Fineprint watched that page before and keeps its history. It cannot be added again."
      : addErrorCopy(refusal.error, refusal.reason ?? "", refusal.retry_after ?? props.stats.public_slots.next_free_at, props.nowMs);
  return (
    <div class="refusal" id="add-refusal" role="alert">
      <span class="stamp is-refused">Not added</span>
      <p class="refusal-text">{text}</p>
      {refusal.error === "already_watched" && refusal.existing_page_id ? (
        <p class="refusal-link">
          <a href={pageHref(refusal.existing_page_id)}>See its history</a>
        </p>
      ) : null}
    </div>
  );
}

function AddPage(props: { stats: Stats; pages: PageSummary[]; form: WatchlistProps["form"]; refusal: Refusal | null; nowMs: number }) {
  const { stats, form, refusal } = props;
  const { total, used, next_free_at } = stats.public_slots;
  const free = Math.max(total - used, 0);
  const held = stats.monitors.active + stats.monitors.paused + stats.monitors.failed;
  const listFull = held >= MAX_MONITORS;
  const paused = stats.spend_paused;
  const closed = free === 0 || listFull || paused;
  const slotLine = paused
    ? PAUSED_LINE
    : free === 0
      ? slotsFullLine(next_free_at, props.nowMs)
      : listFull
        ? `Fineprint already watches its maximum of ${MAX_MONITORS} pages, so none can be added now.`
        : `${free} of ${total} public slots are free.`;
  // A refusal that says the same as the slots line takes its place.
  const sameAsSlotLine =
    refusal !== null &&
    ((paused && refusal.error === "spend_paused") ||
      (!paused && refusal.error === "public_slots_full") ||
      (!paused && free > 0 && listFull && refusal.error === "watchlist_full"));
  const showSlotLine = !sameAsSlotLine;
  const field = refusal === null ? null : refusedField(refusal.error);
  const describe = (name: "url" | "label", own?: string): string | undefined => {
    const ids = [field === name ? "add-refusal" : null, own ?? null].filter((x) => x !== null);
    return ids.length > 0 ? ids.join(" ") : undefined;
  };
  const formBox = (
    <form class="card add-form" method="post" action="/watchlist#add">
      <div class="field">
        <label for="url">Address of the page</label>
        <input
          class="input"
          type="url"
          id="url"
          name="url"
          value={form.url}
          required
          maxlength={MAX_URL_LENGTH}
          inputmode="url"
          autocomplete="url"
          autocapitalize="none"
          spellcheck={false}
          placeholder="https://example.com/pricing"
          aria-invalid={field === "url" ? "true" : undefined}
          aria-describedby={describe("url", "add-slots")}
          disabled={closed}
        />
      </div>
      <div class="field">
        <label for="label">Label, if you want one</label>
        <input
          class="input"
          type="text"
          id="label"
          name="label"
          value={form.label}
          maxlength={MAX_LABEL_LENGTH}
          placeholder="Example pricing"
          aria-invalid={field === "label" ? "true" : undefined}
          aria-describedby={describe("label", closed ? "label-hint add-slots" : "label-hint")}
          disabled={closed}
        />
        <p class="field-hint" id="label-hint">
          Left empty, the page's own title is used.
        </p>
      </div>
      <button class="btn" type="submit" aria-describedby={closed ? "add-slots" : undefined} disabled={closed}>
        Start watching
      </button>
    </form>
  );
  const terms = (
    <div class="add-terms">
      <p class="terms-line">{`Fineprint will watch this page twice a day for ${PUBLIC_TTL_DAYS} days.`}</p>
      <p class={closed ? "slots is-full" : "slots"} id="add-slots">
        <SlotCells used={Math.min(used, total)} />
        {showSlotLine ? <span>{slotLine}</span> : <span class="vh">{slotLine}</span>}
      </p>
      <p class="terms-more">One page per visitor per day. After the week it stops being checked, and every version recorded stays here.</p>
    </div>
  );
  return (
    <section class="add" id="add" aria-labelledby="add-h">
      <h2 id="add-h">Add a page</h2>
      <p class="page-note">
        Any public page with small print: a pricing page, the terms, a fee table. Fineprint records it from today, with a screenshot of every version.
      </p>
      <div class={refusal === null ? "add-grid" : "add-grid has-refusal"}>
        {refusal === null ? null : <RefusalBox refusal={refusal} pages={props.pages} stats={stats} nowMs={props.nowMs} />}
        {/* Closed, the line that says why comes before the disabled fields (on a desktop it sits beside them either way). */}
        {closed ? (
          <>
            {terms}
            {formBox}
          </>
        ) : (
          <>
            {formBox}
            {terms}
          </>
        )}
      </div>
    </section>
  );
}

// --- Find a site's small print -------------------------------------------------------------------

const DISCOVER_COPY: Record<string, string> = {
  invalid_domain: "That is not a website Fineprint can search. Type a name like vercel.com.",
  daily_limit: "Ten searches per visitor per day. Come back tomorrow.",
  search_failed: "The search did not answer. Try again in a minute.",
};

const SNIPPET_CHARS = 280;

/** A link that fills the add form with a found page: `url=` and `label=` only, so following it searches nothing and adds nothing. */
function watchHref(url: string, title: string): string {
  const label = title.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
  return `/watchlist?url=${encodeURIComponent(url)}${label === "" ? "" : `&label=${encodeURIComponent(label)}`}#add`;
}

function FindResults(props: { find: FindState }) {
  const { answer } = props.find;
  if (!answer.ok) return <p class="state-line">{DISCOVER_COPY[answer.error] ?? "The search failed. Try again in a minute."}</p>;
  if (answer.results.length === 0) return <p class="state-line">{`No pricing, terms, privacy or fees pages were found on ${answer.domain}.`}</p>;
  return (
    <div class="found">
      <p class="found-line">{`${plural(answer.results.length, "page")} found on ${answer.domain}.`}</p>
      <ol class="found-list">
        {answer.results.map((r) => {
          const href = webHref(r.url);
          const snippet = r.snippet.length > SNIPPET_CHARS ? `${r.snippet.slice(0, SNIPPET_CHARS - 1)}…` : r.snippet;
          return (
            <li class="found-item">
              <div class="found-main">
                <h3 class="found-title">{r.title.trim() === "" ? sourceLabel(r.url) : r.title}</h3>
                <p class="found-url">
                  {href === null ? (
                    sourceLabel(r.url)
                  ) : (
                    <a href={href} rel="nofollow">
                      {sourceLabel(r.url)}
                    </a>
                  )}
                </p>
                {snippet === "" ? null : <p class="found-snippet">{snippet}</p>}
              </div>
              <p class="found-act">
                {r.watched === null ? (
                  <a class="btn secondary" href={watchHref(r.url, r.title)}>
                    Watch this page
                  </a>
                ) : (
                  <a class="found-known" href={pageHref(r.watched.id)}>
                    {isGone(r.watched.status) ? "Watched before: see its history" : "Already watched: see its history"}
                  </a>
                )}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Find(props: { find: FindState | null }) {
  const { find } = props;
  return (
    <section class="find" id="find" aria-labelledby="find-h">
      <h2 id="find-h">Find a site's small print</h2>
      <p class="page-note">Type a website and TinySearch looks for its pricing, terms, privacy and fees pages. Ten searches per visitor per day.</p>
      <form class="card find-form" method="get" action="/watchlist#find" role="search">
        <div class="field">
          <label for="domain">Website</label>
          <input
            class="input"
            type="text"
            id="domain"
            name="domain"
            value={find?.typed}
            required
            maxlength={MAX_URL_LENGTH}
            inputmode="url"
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            placeholder="vercel.com"
          />
        </div>
        <button class="btn secondary" type="submit">
          Find pages
        </button>
      </form>
      {find === null ? null : <FindResults find={find} />}
    </section>
  );
}

// --- The screen --------------------------------------------------------------------------------

export function Watchlist(props: WatchlistProps) {
  const { stats, pages, nowMs } = props;
  const watching = pages.filter((p) => !isGone(p.status));
  const gone = pages.filter((p) => isGone(p.status));
  return (
    <Layout
      title="Watchlist · Fineprint"
      description={`The ${plural(watching.length, "page")} Fineprint watches, how often each is read, and a form to add one of your own for ${PUBLIC_TTL_DAYS} days.`}
      stats={stats}
      current="watchlist"
      noindex={props.noindex}
    >
      <div class="wrap watchlist">
        <header class="page-head">
          <h1>Watchlist</h1>
          <p class="lede">
            {`${watching.length === 1 ? "One page is" : `${watching.length} pages are`} watched now, each read by TinyFish Monitor on its own schedule. `}
            <a href="#add">Add a page of your own</a>
            {` for ${PUBLIC_TTL_DAYS} days.`}
          </p>
        </header>

        <section class="watching" id="watching" aria-labelledby="watching-h">
          <h2 id="watching-h">Watching</h2>
          {watching.length === 0 ? (
            <p class="empty card">No page is watched yet.</p>
          ) : (
            <>
              <p class="page-note">In the order they were added. A read becomes a version only when the words or figures change; noise is counted, not recorded.</p>
              <PageTable pages={watching} caption="Pages Fineprint watches, in the order they were added" gone={false} />
            </>
          )}
        </section>

        {gone.length === 0 ? null : (
          <section class="retired" id="retired" aria-labelledby="retired-h">
            <h2 id="retired-h">No longer watched</h2>
            <p class="page-note">These pages are not read any more. Every version recorded while they were watched is kept.</p>
            <PageTable pages={gone} caption="Pages no longer watched, with their kept history" gone />
          </section>
        )}

        <AddPage stats={stats} pages={pages} form={props.form} refusal={props.refusal} nowMs={nowMs} />
        <Find find={props.find} />
      </div>
    </Layout>
  );
}
