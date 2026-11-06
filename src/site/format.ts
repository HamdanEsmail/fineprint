// Pure text formatters for the site. Every date in the UI is UTC and absolute ("5 Nov 2026, 09:12 UTC");
// ISO 8601 stays in data and URLs. Nothing here touches the DOM, the database or the clock.
import type { BlockCounts, Delta } from "../core/diff";
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

// --- The page view ----------------------------------------------------------------------------

const TIMES_A_DAY = ["", "once", "twice", "three times", "four times", "five times", "six times", "seven times", "eight times", "nine times", "ten times", "eleven times", "twelve times"];
const timesADay = (n: number): string => `${TIMES_A_DAY[n] ?? `${n} times`} a day`;

/** "a", "a and b", "a, b and c". */
function listWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A Monitor schedule in words. A fixed minute with a list of hours, every day: "14 2,14 * * *" gives
 * "twice a day, at 02:14 and 14:14 UTC". A fixed minute with an hour step that divides the day (every
 * 6 hours) gives "four times a day". Anything else comes back as it was.
 */
export function cronToWords(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  if (day !== "*" || month !== "*" || weekday !== "*" || !/^\d{1,2}$/.test(minute) || Number(minute) > 59) return cron;
  const step = /^\*\/(\d{1,2})$/.exec(hour);
  if (step) {
    const every = Number(step[1]);
    return every >= 1 && 24 % every === 0 ? timesADay(24 / every) : cron;
  }
  if (!/^\d{1,2}(,\d{1,2})*$/.test(hour)) return cron;
  const hours = [...new Set(hour.split(",").map(Number))].sort((a, b) => a - b);
  if (hours.some((h) => h > 23)) return cron;
  return `${timesADay(hours.length)}, at ${listWords(hours.map((h) => `${pad(h)}:${pad(Number(minute))}`))} UTC`;
}

/**
 * An as-of time as a visitor types or picks it: a date ("2026-11-05", midnight UTC), or a date and a time
 * ("2026-11-05T09:12", seconds and a fraction allowed, "T" or a space), with Z or an offset ("+03:00") or
 * with none, which is the `datetime-local` picker's form and is read as UTC.
 */
const AS_OF_FORM = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * An as-of time typed or picked by a visitor, as the ISO string the database compares, or null when it
 * cannot be read. Every field is checked as typed: Date.UTC (and Date.parse) would roll 30 February into
 * March, 24:00 into the next day and 09:60 into 10:00, and read years 0 to 99 as 1900 to 1999, so a time
 * whose fields do not come back unchanged is refused rather than moved. An offset is applied after that
 * check; a result outside the years 0000 to 9999 is refused, as parseTime refuses it.
 */
export function parseAsOfInput(raw: string): string | null {
  const m = AS_OF_FORM.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((part) => Number(part ?? "0")) as [number, number, number, number, number, number];
  const ms = Number((m[7] ?? "0").slice(0, 3).padEnd(3, "0"));
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  const exact =
    local.getUTCFullYear() === y &&
    local.getUTCMonth() === mo - 1 &&
    local.getUTCDate() === d &&
    local.getUTCHours() === h &&
    local.getUTCMinutes() === mi &&
    local.getUTCSeconds() === s;
  if (!exact) return null;
  const zone = m[8];
  let offsetMinutes = 0;
  if (zone !== undefined && zone.toUpperCase() !== "Z") {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const iso = new Date(local.getTime() - offsetMinutes * 60_000).toISOString();
  return /^\d{4}-/.test(iso) ? iso : null;
}

/** An ISO time in the picker's form, "2026-11-05T09:12" (UTC), rounded down or up to the minute. */
export function toDatetimeLocal(iso: string, round: "floor" | "ceil"): string {
  const ms = Date.parse(iso);
  const minute = (round === "ceil" ? Math.ceil : Math.floor)(ms / 60_000) * 60_000;
  return new Date(minute).toISOString().slice(0, 16);
}

const NOISE_WORDS: Record<string, string> = {
  partial_render: "partial render",
  flap: "flap",
  normalized_identical: "same after cleaning",
  layout_hold: "layout change held for a second read",
};

/** Why a read was filtered as noise, in words; a reason this code does not know is its own text with spaces. */
export function noiseReasonWords(reason: string): string {
  return NOISE_WORDS[reason] ?? reason.replaceAll("_", " ");
}

/** Where a change's one-line summary came from, as the cards say it. */
export const SUMMARY_ORIGIN = { tinyfish: "TinyFish's summary", diff: "From the diff" } as const;

const MINUS = "\u2212";
const counted = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

/** One side of a delta ("+2 −1 ~3 blocks", "2 blocks added, 1 removed, 3 changed"), or null when nothing moved. */
function countParts(c: BlockCounts | null | undefined, noun: string): { text: string; spoken: string } | null {
  if (!c) return null;
  const parts = [
    { n: counted(c.added), mark: "+", word: "added" },
    { n: counted(c.removed), mark: MINUS, word: "removed" },
    { n: counted(c.changed), mark: "~", word: "changed" },
  ].filter((p) => p.n > 0);
  if (parts.length === 0) return null;
  const total = parts.reduce((sum, p) => sum + p.n, 0);
  const text = `${parts.map((p) => `${p.mark}${p.n}`).join(" ")} ${total === 1 ? noun : `${noun}s`}`;
  const spoken = parts.map((p, i) => (i === 0 ? `${plural(p.n, noun)} ${p.word}` : `${p.n} ${p.word}`)).join(", ");
  return { text, spoken };
}

/**
 * A change's delta as its badge says it: "+2 −1 ~3 blocks", zero parts left out, then " · +1 ~2 facts"
 * when facts changed; `spoken` is the same in words, for a screen reader and the badge's tooltip. Null
 * when there is no delta yet or nothing in it moved. The layout-only tag is the component's business.
 */
export function deltaParts(delta: Delta | null): { text: string; spoken: string } | null {
  if (delta === null) return null;
  const parts = [countParts(delta.blocks, "block"), countParts(delta.facts, "fact")].filter((p) => p !== null);
  if (parts.length === 0) return null;
  return { text: parts.map((p) => p.text).join(" · "), spoken: parts.map((p) => p.spoken).join("; ") };
}
