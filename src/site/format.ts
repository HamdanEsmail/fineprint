// Pure text formatters for the site. Every date in the UI is UTC and absolute ("5 Nov 2026, 09:12 UTC");
// ISO 8601 stays in data and URLs. Nothing here touches the DOM, the database or the clock.
import type { TriggerKind } from "../db/types";
import type { Stats } from "../readModel";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad = (n: number): string => String(n).padStart(2, "0");

/** "5 Nov 2026, 09:12 UTC". A string that is not a time comes back as it was. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Dollars with two decimals, rounded half up on the cent: "$3.10". */
export function formatUsd(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

/** The count and the word that goes with it: "1 page", "2 pages", "3 were". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const NBSP = "\u00a0";

/**
 * The hero line in three parts, so the view can set the count in the accent and the plain line can
 * never read differently: `before + count + after`. The count and its word are joined by a
 * non-breaking space ("14 times"), so a narrow screen never leaves the number at the end of a line.
 */
export function heroParts(changes7d: number): { before: string; count: string | null; after: string } {
  if (changes7d <= 0) return { before: "Nothing changed this week.", count: null, after: "" };
  return { before: "The web changed its mind ", count: changes7d === 1 ? "once" : `${changes7d}${NBSP}times`, after: " this week." };
}

/** "The web changed its mind 14 times this week.", with plain spaces, for text that is not laid out. */
export function heroLine(changes7d: number): string {
  const { before, count, after } = heroParts(changes7d);
  return `${before}${count ?? ""}${after}`.replaceAll(NBSP, " ");
}

/**
 * The footer's spend meter: "TinyFish spend $3.10 · 15 real changes · $0.21 per catch". The cost per
 * catch is the spend over the real changes the meter shows, so the line adds up as read; the API's
 * `cost_per_catch_usd` also counts the changes of retired pages, which the site leaves out.
 */
export function spendMeter(s: Stats): string {
  const parts = [`TinyFish spend ${formatUsd(s.spend_usd)}`, plural(s.changes, "real change")];
  if (s.changes > 0) parts.push(`${formatUsd(s.spend_usd / s.changes)} per catch`);
  return parts.join(" · ");
}

const LABEL_MAX = 48;

/** The url itself when it is an absolute http or https url, the only kind the site puts in an href; else null. */
export function webHref(url: string): string | null {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * A source url as people read it: host and path, without the scheme, the query, the fragment or a
 * trailing slash; cut to 48 characters with an ellipsis. Anything but an http or https url is shown
 * as it was stored (and cut the same way).
 */
export function sourceLabel(url: string): string {
  const label = webHref(url) === null ? url : (({ host, pathname }) => (host + pathname).replace(/\/+$/, ""))(new URL(url));
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/** How a version was read, for the evidence line. */
export function triggerLabel(t: TriggerKind): string {
  return t === "create" ? "Monitor (baseline)" : t === "pull" ? "Monitor (pulled)" : "Monitor (webhook)";
}

/** The header stamp: RECORDING (with the live dot while any page is watched), or PAUSED at the budget line. */
export function stampFor(s: Stats): { text: "RECORDING" | "PAUSED"; live: boolean } {
  if (s.spend_paused) return { text: "PAUSED", live: false };
  return { text: "RECORDING", live: s.monitors.active > 0 };
}

/**
 * The path of one of the Worker's own urls (`/shots/<id>.jpg`), so a page links its images on the
 * host it is served from: a preview lives on another hostname, and img-src 'self' would block the
 * production one.
 */
export function ownPath(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
