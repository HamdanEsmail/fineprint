// The Stamped Ledger's small parts (DESIGN.md "Signature pieces"). Every recorded string reaches the
// page as a JSX text child or attribute, so hono/jsx escapes it: nothing read from a watched page is
// ever emitted as markup.
import type { Child } from "hono/jsx";
import type { PageStatus, TriggerKind } from "../db/types";
import { formatUtc, sourceLabel, triggerLabel } from "./format";

/**
 * The last line of every record: `Source: <host/path> · read 5 Nov 2026, 09:12 UTC · Monitor (webhook)`.
 * A version made without a run row (none in production) says only "Monitor".
 */
export function EvidenceLine(props: { url: string; readAt: string; trigger: TriggerKind | null }) {
  const method = props.trigger === null ? "Monitor" : triggerLabel(props.trigger);
  return (
    <p class="evidence">
      Source: <a href={props.url}>{sourceLabel(props.url)}</a>
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

/** A page's status as a coloured chip; colour is never the only signal, the word is always there. */
export function StatusChip(props: { status: PageStatus }) {
  const chip = CHIPS[props.status];
  return <span class={`chip ${chip.tone}`}>{chip.text}</span>;
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
