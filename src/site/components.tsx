// The Stamped Ledger's small parts (DESIGN.md "Signature pieces"). Every recorded string reaches the
// page as a JSX text child or attribute, so hono/jsx escapes it: nothing read from a watched page is
// ever emitted as markup.
import type { Child } from "hono/jsx";
import type { Delta, Fact } from "../core/diff";
import type { PageStatus, TriggerKind } from "../db/types";
import { deltaParts, formatUtc, sourceLabel, triggerLabel, webHref } from "./format";

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
        {props.facts.map((f) => (
          <tr>
            <th scope="row">{text(f.name)}</th>
            <td class="price">
              {text(f.price)}
              {text(f.unit) === "" ? null : <span class="unit"> {text(f.unit)}</span>}
            </td>
            {withNotes ? <td>{text(f.notes)}</td> : null}
          </tr>
        ))}
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
