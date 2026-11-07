// The Stamped Ledger's small parts (DESIGN.md "Signature pieces"). Every recorded string reaches the
// page as a JSX text child or attribute, so hono/jsx escapes it: nothing read from a watched page is
// ever emitted as markup.
import type { Child } from "hono/jsx";
import type { Delta, Fact } from "../core/diff";
import { CAPTURE_MAX_ATTEMPTS } from "../core/limits";
import type { CaptureStatus, PageStatus, TriggerKind } from "../db/types";
import type { VersionItem } from "../readModel";
import { deltaParts, formatUtc, ownPath, sourceLabel, triggerLabel, unitBeside, webHref } from "./format";

/**
 * The last line of every record: `Source: <host/path> · read 5 Nov 2026, 09:12 UTC · Monitor (webhook)`.
 * The source is a link only when its url is http or https; anything else (a stored `javascript:` url,
 * say) is plain text. A version made without a run row (none in production) says only "Monitor".
 */
export function EvidenceLine(props: { url: string; readAt: string; trigger: TriggerKind | null }) {
  const method = props.trigger === null ? "Monitor" : triggerLabel(props.trigger);
  const href = webHref(props.url);
  const label = sourceLabel(props.url);
  return (
    <p class="evidence">
      Source: {href === null ? label : <a href={href}>{label}</a>}
      {` · read ${formatUtc(props.readAt)} · ${method}`}
    </p>
  );
}

/** The stamp beside the wordmark, with the pulse dot while the recorder is live. */
export function Stamp(props: { text: string; live?: boolean }) {
  return (
    <span class="stamp">
      {props.live ? <span class="live" aria-hidden="true"></span> : null}
      {props.text}
    </span>
  );
}

const CHIPS: Record<PageStatus, { tone: string; text: string }> = {
  active: { tone: "ok", text: "Active" },
  paused: { tone: "warn", text: "Paused" },
  failed: { tone: "bad", text: "Failed" },
  expired: { tone: "muted", text: "Expired" },
  retired: { tone: "muted", text: "Retired" },
};

/**
 * A page's status as a coloured chip; colour is never the only signal, the word is always there. A
 * status this code does not know (a page stored without one) shows no chip.
 */
export function StatusChip(props: { status: PageStatus }) {
  const chip = CHIPS[props.status] as (typeof CHIPS)[PageStatus] | undefined;
  return chip ? <span class={`chip ${chip.tone}`}>{chip.text}</span> : null;
}

/** The line a layout-only change carries after its summary (the site plan's honest states). */
export const LAYOUT_ONLY_LINE = "Same words and figures, different structure.";

/**
 * A change in counts, ink on paper: "+2 −1 ~3 blocks · +1 ~2 facts", with the same in words for a
 * screen reader and as the tooltip. A layout-only change gets the tag "Layout only" instead (the card
 * then takes the accent off its time and adds LAYOUT_ONLY_LINE). Nothing at all without a delta, or
 * when nothing in it moved.
 */
export function DeltaBadge(props: { delta: Delta | null }) {
  if (props.delta?.layout_only === true) {
    return (
      <span class="tag" title={LAYOUT_ONLY_LINE}>
        Layout only
      </span>
    );
  }
  const parts = deltaParts(props.delta);
  if (parts === null) return null;
  return (
    <span class="delta" title={parts.spoken}>
      <span aria-hidden="true">{parts.text}</span>
      <span class="vh">{parts.spoken}</span>
    </span>
  );
}

/** Whether DeltaBadge shows anything for this delta. */
export const hasDeltaBadge = (delta: Delta | null): boolean => delta?.layout_only === true || deltaParts(delta) !== null;

/**
 * The prices read from one version, one row a fact: what it is, the price (mono, with its unit) and,
 * when any fact has them, the notes. Every value is text from a watched page, escaped by JSX.
 */
export function FactsTable(props: { facts: Fact[] }) {
  const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
  const withNotes = props.facts.some((f) => text(f.notes) !== "");
  return (
    <table class="table facts">
      <caption class="vh">Prices read from this version</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Price</th>
          {withNotes ? <th scope="col">Notes</th> : null}
        </tr>
      </thead>
      <tbody>
        {props.facts.map((f) => {
          const unit = unitBeside(text(f.price), text(f.unit));
          return (
            <tr>
              <th scope="row">{text(f.name)}</th>
              <td class="price">
                {text(f.price)}
                {unit === "" ? null : <span class="unit"> {unit}</span>}
              </td>
              {withNotes ? <td>{text(f.notes)}</td> : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * A screenshot thumbnail that links somewhere. `src` is a same-origin path; without one the box
 * stays, marked "No image", so a missing capture never shows as a broken image. `label` names the
 * link when it goes somewhere other than the image itself.
 */
export function Thumb(props: { src: string | null; href: string; alt: string; label?: string; size?: number }) {
  const size = props.size ?? 92;
  return (
    <a class="thumb" href={props.href} aria-label={props.label}>
      {props.src === null ? (
        <span class="thumb-none">No image</span>
      ) : (
        <img src={props.src} width={size} height={size} loading="lazy" decoding="async" alt={props.alt} />
      )}
    </a>
  );
}

/** One figure of the record, ink on paper; `isKey` is the one accent block a view may have. */
export function StatBlock(props: { figure: string; label: string; isKey?: boolean }) {
  return (
    <div class={props.isKey ? "stat is-key" : "stat"}>
      <b>{props.figure}</b>
      <span class="t">{props.label}</span>
    </div>
  );
}

/** A full-width ink banner above the header, for a state that applies to the whole site. */
export function Notice(props: { children: Child }) {
  return (
    <div class="notice" role="status">
      <div class="wrap">
        <p>{props.children}</p>
      </div>
    </div>
  );
}

/** What a screenshot figure needs of a version: when it was read, its stored copies and how its capture went. */
export type ShotOf = {
  captured_at: string;
  screenshot_url: string | null;
  thumb_url: string | null;
  source_url: string | null;
  capture_status: CaptureStatus;
};

/**
 * A version's screenshot as a figure: the thumbnail (the full image when there is no thumbnail), by path,
 * linking to the full image, with the caption "The page as it was read on {time}". Without a screenshot the
 * box says so in words, never as a broken image: "Taking the screenshot…" while the capture may still bring
 * one (not on a page that is no longer watched, whose captures the hourly repair skips), else "Screenshot
 * unavailable." with the stored source and the live page. `children` goes under the caption (an evidence line).
 */
export function ShotFigure(props: { v: ShotOf; pageLabel: string; liveUrl: string; gone: boolean; children?: Child }) {
  const { v } = props;
  const time = formatUtc(v.captured_at);
  const full = ownPath(v.screenshot_url);
  if (full !== null) {
    return (
      <figure class="shot">
        <a class="shot-link" href={full} data-full="">
          <img src={ownPath(v.thumb_url) ?? full} width={640} height={400} loading="lazy" decoding="async" alt={`Screenshot of ${props.pageLabel} as recorded ${time}`} />
        </a>
        <figcaption>{`The page as it was read on ${time}`}</figcaption>
        {props.children}
      </figure>
    );
  }
  const pending = !props.gone && v.capture_status !== "complete" && v.capture_status !== "failed";
  const source = ownPath(v.source_url);
  const live = webHref(props.liveUrl);
  return (
    <figure class="shot">
      <div class="shot-none" role={pending ? "status" : undefined}>
        {pending ? (
          <>
            <p class="vshot-state">Taking the screenshot…</p>
            <p>{`If it does not arrive, the hourly repair tries again, up to ${CAPTURE_MAX_ATTEMPTS} attempts in all.`}</p>
          </>
        ) : (
          <>
            <p class="vshot-state">Screenshot unavailable.</p>
            <p class="vshot-links">
              {source === null ? null : <a href={source}>Stored source</a>}
              {live === null ? <span>Live page: {props.liveUrl}</span> : <a href={live}>Live page</a>}
            </p>
          </>
        )}
      </div>
      <figcaption>{`The page as it was read on ${time}`}</figcaption>
      {props.children}
    </figure>
  );
}

/** Versions one screen lists (the page view's list and dots, the compare picks), at most: the newest ones. */
export const VERSIONS_LISTED = 200;

/**
 * The newest VERSIONS_LISTED of a page's versions (newest first), and after them any of `keep` that are older,
 * so the version on screen is always among them. Every version stays in the page's JSON.
 */
export function listedVersions(versions: VersionItem[], keep: string[]): VersionItem[] {
  if (versions.length <= VERSIONS_LISTED) return versions;
  return [...versions.slice(0, VERSIONS_LISTED), ...versions.slice(VERSIONS_LISTED).filter((v) => keep.includes(v.id))];
}

/** Said under a list of versions cut to VERSIONS_LISTED, with the way to the rest; nothing when none was cut. */
export function OlderVersions(props: { total: number; json: string }) {
  if (props.total <= VERSIONS_LISTED) return null;
  return (
    <p class="older-note">
      {`The newest ${VERSIONS_LISTED} of ${props.total.toLocaleString("en-US")} versions are listed. `}
      <a href={props.json}>The page as JSON</a> has every one.
    </p>
  );
}

/**
 * The GET form to a page's compare view: two labelled selects of the page's version times (`from`, `to`,
 * newest first, the baseline marked; the newest VERSIONS_LISTED and the two chosen, with a line to the JSON
 * when that leaves some out) and a Compare button.
 */
export function CompareForm(props: { action: string; versions: VersionItem[]; fromId: string; toId: string; json: string }) {
  const listed = listedVersions(props.versions, [props.fromId, props.toId]);
  const options = (chosen: string) =>
    listed.map((v) => (
      <option value={v.id} selected={v.id === chosen}>
        {`${formatUtc(v.captured_at)}${v.is_baseline ? " · baseline" : ""}`}
      </option>
    ));
  return (
    <form class="pick card" method="get" action={props.action}>
      <div class="field">
        <label for="from">From</label>
        <select class="input" id="from" name="from">
          {options(props.fromId)}
        </select>
      </div>
      <div class="field">
        <label for="to">To</label>
        <select class="input" id="to" name="to">
          {options(props.toId)}
        </select>
      </div>
      <button class="btn" type="submit">
        Compare
      </button>
      <OlderVersions total={props.versions.length} json={props.json} />
    </form>
  );
}
