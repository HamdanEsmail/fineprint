// Page view (GET /pages/:id, with v=<version id> or at=<time>, and text=1): one watched page's whole
// record. The header says what the page is and how it is watched; the timeline (DESIGN.md "Timeline")
// places every version by the time it was read, beside the as-of scrubber; the version list under it is
// the same versions as rows, the primary control on a phone; the version card shows the selected version
// with its screenshot, its price table and its evidence line; then the compare form and the check log.
// Everything is a link or a GET form, so the screen works with JavaScript off.
import type { PageDetail, RunItem, Stats, VersionItem } from "../../readModel";
import { MAX_RUNS_SHOWN } from "../../readModel";
import { DeltaBadge, EvidenceLine, FactsTable, hasDeltaBadge, LAYOUT_ONLY_LINE, StatusChip } from "../components";
import {
  cronToWords,
  formatUtc,
  noiseReasonWords,
  ownPath,
  plural,
  sourceLabel,
  SUMMARY_ORIGIN,
  toDatetimeLocal,
  webHref,
} from "../format";
import { Layout } from "../layout";

/** How long after a version is recorded the page reloads itself while its screenshot is being taken. */
export const REFRESH_WINDOW_MS = 2 * 60_000;
const REFRESH_SECONDS = 5;
/**
 * The least room, in percent of the track, kept between two neighbouring dots so their 24px targets do not
 * sit on each other (5% of a 460px desktop track is 23px); with many versions the gap shrinks to fit.
 */
const MIN_DOT_GAP = 5;

/** What an `at=` asked for and what came of it. */
export type AsOf =
  /** A version was in force then: the card carries the AS OF stamp. */
  | { kind: "resolved"; at: string }
  /** Before the first record: the baseline is shown, without the stamp. */
  | { kind: "before_baseline"; at: string; baselineAt: string }
  /** A time still to come: the latest version is shown, without the stamp. */
  | { kind: "future"; at: string }
  /** Not a time: the latest version is shown, with the line that says so. */
  | { kind: "unreadable" };

export type PageViewProps = {
  stats: Stats;
  detail: PageDetail;
  /** The version the card shows; null only for a page with no version. */
  selected: VersionItem | null;
  asOf: AsOf | null;
  /** The selected version's recorded text, read only for text=1. */
  text: string | null;
  nowMs: number;
};

// --- What a version and a run amount to ---------------------------------------------------------

type ShotState = "ok" | "pending" | "failed";

/** A screenshot is there, still being taken, or will not come (the capture finished or gave up without one). */
function shotState(v: VersionItem): ShotState {
  if (v.screenshot_url !== null) return "ok";
  return v.capture_status === "complete" || v.capture_status === "failed" ? "failed" : "pending";
}

/** Whether the page should reload itself: the selected version's screenshot is pending and the version is under two minutes old. */
export function refreshes(v: VersionItem | null, nowMs: number): boolean {
  return v !== null && shotState(v) === "pending" && nowMs - Date.parse(v.captured_at) < REFRESH_WINDOW_MS;
}

type Outcome = "baseline" | "change" | "noise" | "failed" | "unchanged";

type Check = { run: RunItem; outcome: Outcome; versionId: string | null };

/**
 * What each run amounted to. A run that made a version is a change (or the baseline); a run the gate
 * suppressed is noise, with its reason; a read that failed (`fetch_error`, not counted as noise) is a
 * failed read; everything else found the page as it was.
 */
function checksOf(detail: PageDetail): Check[] {
  const baselines = new Set(detail.versions.filter((v) => v.is_baseline).map((v) => v.id));
  return detail.runs.map((run) => {
    const versionId = detail.versionByRun[run.id] ?? null;
    let outcome: Outcome;
    if ((versionId !== null && baselines.has(versionId)) || run.outcome === "baseline" || run.trigger === "create") outcome = "baseline";
    else if (versionId !== null) outcome = "change";
    else if (run.noise_suppressed) outcome = "noise";
    else if (run.noise_reason === "fetch_error") outcome = "failed";
    else outcome = "unchanged";
    return { run, outcome, versionId };
  });
}

/** "6 checks: 3 changes, 1 noise, 2 unchanged." The baseline is not a check; a failed read is named only when there is one. */
function checksSentence(checks: Check[]): string {
  if (checks.length === 0) return "No check has run yet.";
  const scheduled = checks.filter((c) => c.outcome !== "baseline");
  if (scheduled.length === 0) return "No check has run since the baseline.";
  const n = (o: Outcome): number => scheduled.filter((c) => c.outcome === o).length;
  const failed = n("failed");
  const capped = checks.length >= MAX_RUNS_SHOWN ? "The latest " : "";
  return `${capped}${plural(scheduled.length, "check")}: ${plural(n("change"), "change")}, ${n("noise")} noise, ${n("unchanged")} unchanged${
    failed > 0 ? `, ${plural(failed, "failed read")}` : ""
  }.`;
}

const ARRIVAL = { create: "baseline", webhook: "webhook", pull: "pulled" } as const;

function outcomeWords(c: Check): string {
  switch (c.outcome) {
    case "baseline":
      return "Baseline";
    case "change":
      return "Change recorded";
    case "noise":
      return `Noise: ${noiseReasonWords(c.run.noise_reason ?? "unknown")}`;
    case "failed":
      return "Failed read";
    default:
      return "Unchanged";
  }
}

/**
 * Where each dot sits on the track, in percent: by time between the first record and now, then nudged so
 * neighbours keep MIN_DOT_GAP apart (two versions an hour apart would otherwise be one blot).
 */
function dotPositions(timesOldestFirst: number[], startMs: number, endMs: number): number[] {
  const span = Math.max(endMs - startMs, 1);
  const pos = timesOldestFirst.map((t) => Math.min(100, Math.max(0, ((t - startMs) / span) * 100)));
  const n = pos.length;
  const gap = n > 1 ? Math.min(MIN_DOT_GAP, 100 / (n - 1)) : 0;
  for (let i = 1; i < n; i++) pos[i] = Math.max(pos[i]!, pos[i - 1]! + gap);
  if (n > 0 && pos[n - 1]! > 100) {
    pos[n - 1] = 100;
    for (let i = n - 2; i >= 0; i--) pos[i] = Math.min(pos[i]!, pos[i + 1]! - gap);
  }
  return pos.map((p) => Math.round(p * 100) / 100);
}

// --- Parts of the screen ------------------------------------------------------------------------

type Ctx = { detail: PageDetail; pageHref: string; label: string };

const versionHref = (ctx: Ctx, id: string, extra = ""): string => `${ctx.pageHref}?v=${encodeURIComponent(id)}${extra}`;

function PageHead(props: { ctx: Ctx; noise: number }) {
  const { page, versions } = props.ctx.detail;
  const href = webHref(page.url);
  const gone = page.status === "retired" || page.status === "expired";
  const cron = page.schedule_cron;
  const words = cron === null ? null : cronToWords(cron);
  return (
    <header class="page-head">
      <h1>{page.label}</h1>
      <p class="page-url">{href === null ? sourceLabel(page.url) : <a href={href}>{sourceLabel(page.url)}</a>}</p>
      <ul class="page-facts">
        <li>
          <StatusChip status={page.status} />
        </li>
        {page.kind ? <li class="page-kind">{page.kind}</li> : null}
        {gone || cron === null || words === null ? null : page.status === "paused" ? (
          <li>Checks are paused</li>
        ) : words === cron ? (
          <li>
            Checked on the schedule <code>{cron}</code> (UTC)
          </li>
        ) : (
          <li>{`Checked ${words}`}</li>
        )}
        <li>
          {page.last_run_at === null ? (
            "Not checked yet"
          ) : (
            <>
              Last checked <time datetime={page.last_run_at}>{formatUtc(page.last_run_at)}</time>
            </>
          )}
        </li>
      </ul>
      <p class="page-tally">{`${plural(versions.length, "version")} · ${plural(props.noise, "noise event")} suppressed`}</p>
      {page.status === "retired" ? <p class="state-line">No longer watched. Its history is kept.</p> : null}
      {page.status === "expired" ? <p class="state-line">Watched for 7 days as a public page. Its history is kept.</p> : null}
      {!gone && page.pending_hash !== null ? (
        <p class="state-line">A suspect read is waiting for a second check. Nothing is recorded until two reads agree.</p>
      ) : null}
    </header>
  );
}

/** The as-of line under the scrubber, when `at=` was given. */
function asOfNote(asOf: AsOf | null): { text: string; error: boolean } | null {
  if (asOf === null || asOf.kind === "resolved") return null;
  if (asOf.kind === "unreadable") {
    return { text: "That is not a date Fineprint can read. Use the picker, or a time like 2026-11-05T09:12.", error: true };
  }
  if (asOf.kind === "future") return { text: "That time has not come yet. This is the latest record.", error: false };
  return { text: `Fineprint started watching this page on ${formatUtc(asOf.baselineAt)}. There is no earlier record.`, error: false };
}

function Timeline(props: { ctx: Ctx; selected: VersionItem; asOf: AsOf | null; nowMs: number }) {
  const { ctx, selected, asOf, nowMs } = props;
  const oldestFirst = [...ctx.detail.versions].reverse();
  const first = oldestFirst[0]!;
  const startMs = Date.parse(first.captured_at);
  const positions = dotPositions(
    oldestFirst.map((v) => Date.parse(v.captured_at)),
    startMs,
    Math.max(nowMs, Date.parse(oldestFirst[oldestFirst.length - 1]!.captured_at)),
  );
  const nowIso = new Date(nowMs).toISOString();
  const note = asOfNote(asOf);
  const value = asOf !== null && asOf.kind !== "unreadable" ? toDatetimeLocal(asOf.at, "floor") : undefined;
  return (
    <div class="tl card">
      <div class="tl-strip">
        <p class="tl-note">Each dot is a recorded version, placed by the time it was read. Pick one, or pick a date.</p>
        <ol class="tl-track" aria-label="Versions by the time they were recorded, oldest first">
          {oldestFirst.map((v, i) => {
            const name = `Version recorded ${formatUtc(v.captured_at)}`;
            const on = v.id === selected.id;
            return (
              <li style={`left:${positions[i]}%`}>
                <a
                  class={on ? "dot is-on" : "dot"}
                  href={versionHref(ctx, v.id, "#version")}
                  aria-label={name}
                  title={name}
                  aria-current={on ? "true" : undefined}
                ></a>
              </li>
            );
          })}
        </ol>
        <p class="tl-ends">
          <span>
            <time datetime={first.captured_at}>{formatUtc(first.captured_at)}</time>
          </span>
          <span>Now</span>
        </p>
      </div>
      <form class="asof" method="get" action={ctx.pageHref}>
        <label for="at">Show the page as it was on</label>
        <p class="asof-hint" id="at-hint">
          A date and time in UTC.
        </p>
        <div class="asof-row">
          <input
            class="input"
            type="datetime-local"
            id="at"
            name="at"
            min={toDatetimeLocal(first.captured_at, "ceil")}
            max={toDatetimeLocal(nowIso, "floor")}
            step="60"
            value={value}
            aria-describedby={note === null ? "at-hint" : "at-hint at-note"}
          />
          <button class="btn" type="submit">
            Show this date
          </button>
        </div>
        {note === null ? null : (
          <p class={note.error ? "field-error asof-note" : "asof-note"} id="at-note">
            {note.text}
          </p>
        )}
      </form>
    </div>
  );
}

/** A small screenshot inside a link that already names its version: decorative, so its alt is empty. */
function MiniShot(props: { v: VersionItem }) {
  const src = ownPath(props.v.thumb_url ?? props.v.screenshot_url);
  return (
    <span class="vrow-shot">
      {src === null ? (
        <span class="thumb-none">{shotState(props.v) === "pending" ? "Not yet" : "No image"}</span>
      ) : (
        <img src={src} width={56} height={56} loading="lazy" decoding="async" alt="" />
      )}
    </span>
  );
}

const quietTime = (v: VersionItem): boolean => v.is_baseline || v.delta?.layout_only === true;

function summaryText(v: VersionItem): string {
  if (v.is_baseline) return "The first version Fineprint recorded of this page.";
  return v.summary ?? "No summary yet.";
}

function VersionList(props: { ctx: Ctx; selected: VersionItem }) {
  const { ctx, selected } = props;
  return (
    <nav class="versions" aria-labelledby="versions-h">
      <h2 id="versions-h" class="label">
        Versions, newest first
      </h2>
      <ol>
        {ctx.detail.versions.map((v) => {
          const on = v.id === selected.id;
          return (
            <li>
              <a class={on ? "vrow is-on" : "vrow"} href={versionHref(ctx, v.id, "#version")} aria-current={on ? "true" : undefined}>
                <MiniShot v={v} />
                <span class="vrow-head">
                  <time class={quietTime(v) ? "vrow-time is-quiet" : "vrow-time"} datetime={v.captured_at}>
                    {formatUtc(v.captured_at)}
                  </time>
                  {v.is_baseline ? <span class="tag">Baseline</span> : <DeltaBadge delta={v.delta} />}
                </span>
                <span class={v.summary === null && !v.is_baseline ? "vrow-sum is-pending" : "vrow-sum"}>{summaryText(v)}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Shot(props: { ctx: Ctx; v: VersionItem; refreshing: boolean }) {
  const { ctx, v } = props;
  const time = formatUtc(v.captured_at);
  const state = shotState(v);
  const live = webHref(ctx.detail.page.url);
  if (state === "ok") {
    const full = ownPath(v.screenshot_url)!;
    return (
      <figure class="vshot">
        <a class="vshot-link" href={full} data-full="">
          <img src={ownPath(v.thumb_url) ?? full} width={640} height={400} decoding="async" alt={`Screenshot of ${ctx.label} as recorded ${time}`} />
        </a>
        <figcaption>{`The page as it was read on ${time}. Opens the full screenshot.`}</figcaption>
      </figure>
    );
  }
  if (state === "pending") {
    return (
      <div class="vshot-none" role="status">
        <p class="vshot-state">Taking the screenshot…</p>
        <p>{props.refreshing ? "This page reloads itself every few seconds until it is ready." : "It is retried every hour until it is stored."}</p>
      </div>
    );
  }
  const source = ownPath(v.source_url);
  return (
    <div class="vshot-none">
      <p class="vshot-state">Screenshot unavailable.</p>
      <p class="vshot-links">
        {source === null ? null : <a href={source}>Stored source</a>}
        {live === null ? <span>Live page: {ctx.detail.page.url}</span> : <a href={live}>Live page</a>}
      </p>
    </div>
  );
}

function Facts(props: { v: VersionItem; paused: boolean }) {
  const { v } = props;
  if (v.facts_status === "not_needed") return null;
  let body;
  if (v.facts_status === "ok" && v.facts !== null) {
    body = v.facts.length > 0 ? <FactsTable facts={v.facts} /> : <p class="facts-note">No prices were found on this version.</p>;
  } else if (v.facts_status === "pending") {
    body = (
      <p class="facts-note">{props.paused ? "Price tables are paused at the budget line. Changes are still recorded." : "Reading prices…"}</p>
    );
  } else {
    body = <p class="facts-note">Price table unavailable for this version.</p>;
  }
  return (
    <div class="vfacts">
      <h3>Prices on this version</h3>
      {body}
    </div>
  );
}

function VersionCard(props: { ctx: Ctx; v: VersionItem; asOf: AsOf | null; text: string | null; paused: boolean; refreshing: boolean }) {
  const { ctx, v, asOf, text } = props;
  const { versions, page } = ctx.detail;
  const index = versions.findIndex((x) => x.id === v.id);
  const previous = versions[index + 1];
  const time = formatUtc(v.captured_at);
  const stamped = asOf?.kind === "resolved" ? asOf.at : null;
  const live = webHref(page.url);
  const source = ownPath(v.source_url);
  // The text link keeps what the visitor asked for: the as-of time (and its stamp), else this version.
  const keep = stamped === null ? `?v=${encodeURIComponent(v.id)}` : `?at=${encodeURIComponent(stamped)}`;
  const layoutOnly = v.delta?.layout_only === true;
  return (
    <article class="card vcard" id="version" aria-labelledby="version-h">
      <div class="vcard-head">
        <h2 id="version-h">
          Recorded{" "}
          <time class={quietTime(v) ? "vcard-time is-quiet" : "vcard-time"} datetime={v.captured_at}>
            {time}
          </time>
        </h2>
        {stamped === null ? null : <span class="stamp is-asof">{`AS OF ${formatUtc(stamped)}`}</span>}
      </div>
      <p class="row">
        {v.is_baseline ? <span class="tag">Baseline</span> : hasDeltaBadge(v.delta) ? <DeltaBadge delta={v.delta} /> : null}
        <span class="label">{`Version ${versions.length - index} of ${versions.length}`}</span>
      </p>
      <p class={v.summary === null && !v.is_baseline ? "vcard-summary is-pending" : "vcard-summary"}>{summaryText(v)}</p>
      {layoutOnly ? <p class="layout-note">{LAYOUT_ONLY_LINE}</p> : null}
      {v.summary_source === null ? null : <p class="origin">{SUMMARY_ORIGIN[v.summary_source]}</p>}
      <Shot ctx={ctx} v={v} refreshing={props.refreshing} />
      <Facts v={v} paused={props.paused} />
      <p class="actions">
        {previous === undefined ? null : (
          <a class="btn" href={`${ctx.pageHref}/compare?from=${encodeURIComponent(previous.id)}&to=${encodeURIComponent(v.id)}`}>
            Compare with the previous version
          </a>
        )}
        {text === null ? (
          <a class="btn secondary" href={`${ctx.pageHref}${keep}&text=1#text`}>
            Show the recorded text
          </a>
        ) : (
          <a class="btn secondary" href={`${ctx.pageHref}${keep}#version`}>
            Hide the recorded text
          </a>
        )}
      </p>
      <ul class="vlinks">
        {source === null ? null : (
          <li>
            <a href={source}>Stored source</a>
          </li>
        )}
        <li>{live === null ? `Live page: ${page.url}` : <a href={live}>Live page</a>}</li>
        <li>
          <a href={`/api/pages/${encodeURIComponent(page.id)}/versions/${encodeURIComponent(v.id)}`}>This version as JSON</a>
        </li>
      </ul>
      <EvidenceLine url={page.url} readAt={v.captured_at} trigger={v.trigger} />
      {text === null ? null : (
        <section class="vtext" aria-labelledby="text-h">
          <h3 id="text-h">The recorded text</h3>
          <p class="origin">{`As Monitor read it on ${time}: ${plural(text.length, "character")}.`}</p>
          <pre id="text" tabindex={0}>
            {text}
          </pre>
        </section>
      )}
    </article>
  );
}

function ComparePick(props: { ctx: Ctx; selected: VersionItem }) {
  const { ctx, selected } = props;
  const { versions } = ctx.detail;
  const index = versions.findIndex((v) => v.id === selected.id);
  // To the selected version from the one before it; from the oldest, to the one after it.
  const [fromId, toId] =
    index < versions.length - 1 ? [versions[index + 1]!.id, selected.id] : [selected.id, versions[Math.max(index - 1, 0)]!.id];
  const options = (chosen: string) =>
    versions.map((v) => (
      <option value={v.id} selected={v.id === chosen}>
        {`${formatUtc(v.captured_at)}${v.is_baseline ? " · baseline" : ""}`}
      </option>
    ));
  return (
    <section class="pick-section" aria-labelledby="compare-h">
      <h2 id="compare-h">Compare two versions</h2>
      {versions.length < 2 ? (
        <p class="page-note">There is nothing to compare yet: this page has one recorded version.</p>
      ) : (
        <>
          <p class="page-note">Pick any two versions and see exactly which words changed.</p>
          <form class="pick card" method="get" action={`${ctx.pageHref}/compare`}>
            <div class="field">
              <label for="from">From</label>
              <select class="input" id="from" name="from">
                {options(fromId)}
              </select>
            </div>
            <div class="field">
              <label for="to">To</label>
              <select class="input" id="to" name="to">
                {options(toId)}
              </select>
            </div>
            <button class="btn" type="submit">
              Compare
            </button>
          </form>
        </>
      )}
    </section>
  );
}

/** The key under the marks: only the kinds this page has. */
const KEY: { outcome: Outcome; text: string; pulled?: true }[] = [
  { outcome: "change", text: "Change recorded" },
  { outcome: "noise", text: "Noise filtered" },
  { outcome: "unchanged", text: "Unchanged" },
  { outcome: "failed", text: "Failed read" },
  { outcome: "baseline", text: "Baseline" },
  { outcome: "unchanged", text: "Pulled check", pulled: true },
];

function CheckLog(props: { ctx: Ctx; checks: Check[] }) {
  const { ctx, checks } = props;
  const oldestFirst = [...checks].reverse();
  const seen = new Set(checks.map((c) => c.outcome));
  const anyPulled = checks.some((c) => c.run.trigger === "pull");
  return (
    <section class="checks" aria-labelledby="checks-h">
      <h2 id="checks-h">Every check</h2>
      <p class="checks-line">{checksSentence(checks)}</p>
      {checks.length === 0 ? null : (
        <>
          <p class="page-note">
            Monitor reads the page on its schedule. A read becomes a version only when the words or figures changed; a read that
            differs only in noise is filtered out and counted here.
          </p>
          <div class="marks-panel card">
            <ol class="marks" aria-hidden="true">
              {oldestFirst.map((c) => {
                const pulled = c.run.trigger === "pull";
                return (
                  <li
                    class={`mark mark-${c.outcome}${pulled ? " is-pulled" : ""}`}
                    title={`${formatUtc(c.run.received_at)}: ${outcomeWords(c)}${pulled ? ", pulled" : ""}`}
                  ></li>
                );
              })}
            </ol>
            <ul class="marks-key" aria-hidden="true">
              {KEY.filter((k) => (k.pulled ? anyPulled : seen.has(k.outcome))).map((k) => (
                <li>
                  <span class={`mark mark-${k.outcome}${k.pulled ? " is-pulled" : ""}`}></span>
                  {k.text}
                </li>
              ))}
            </ul>
          </div>
          <details class="all-checks">
            <summary>All checks</summary>
            <table class="table checks-table">
              <caption class="vh">Every check of this page, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">How it arrived</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr>
                    <td class="when">
                      <time datetime={c.run.received_at}>{formatUtc(c.run.received_at)}</time>
                    </td>
                    <td>{ARRIVAL[c.run.trigger] ?? c.run.trigger}</td>
                    <td>
                      {c.versionId === null ? (
                        outcomeWords(c)
                      ) : (
                        <a href={versionHref(ctx, c.versionId, "#version")}>{outcomeWords(c)}</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}

// --- The screen ---------------------------------------------------------------------------------

export function PageView(props: PageViewProps) {
  const { stats, detail, selected, asOf, text, nowMs } = props;
  const { page, versions } = detail;
  const ctx: Ctx = { detail, pageHref: `/pages/${encodeURIComponent(page.id)}`, label: page.label };
  const checks = checksOf(detail);
  const noise = checks.filter((c) => c.outcome === "noise").length;
  const refreshing = refreshes(selected, nowMs);
  const first = versions[versions.length - 1];
  return (
    <Layout
      title={`${page.label} · Fineprint`}
      description={
        first === undefined
          ? `${page.label}: watched by Fineprint, no version recorded yet.`
          : `${page.label}: ${plural(versions.length, "recorded version")} since ${formatUtc(first.captured_at)}, each with a screenshot, the source and the read time.`
      }
      stats={stats}
      current={null}
      refreshSeconds={refreshing ? REFRESH_SECONDS : undefined}
    >
      <div class="wrap page">
        <PageHead ctx={ctx} noise={noise} />
        {selected === null ? (
          <p class="empty card">No version of this page is recorded yet.</p>
        ) : (
          <>
            <section class="history" aria-label="History">
              <Timeline ctx={ctx} selected={selected} asOf={asOf} nowMs={nowMs} />
              <div class="history-grid">
                <VersionList ctx={ctx} selected={selected} />
                <VersionCard ctx={ctx} v={selected} asOf={asOf} text={text} paused={stats.facts_paused} refreshing={refreshing} />
              </div>
            </section>
            <ComparePick ctx={ctx} selected={selected} />
          </>
        )}
        <CheckLog ctx={ctx} checks={checks} />
      </div>
    </Layout>
  );
}
