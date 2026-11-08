// Pure text formatters for the site. Every date in the UI is UTC and absolute ("5 Nov 2026, 09:12 UTC");
// ISO 8601 stays in data and URLs. Nothing here touches the DOM, the database or the clock.
import type { BlockCounts, Delta } from "../core/diff";
import { FACTS_PAUSE_USD, SPEND_PAUSE_USD } from "../core/limits";
import type { TriggerKind } from "../db/types";
import type { Stats } from "../readModel";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad = (n: number): string => String(n).padStart(2, "0");

/** "5 Nov 2026, 09:12 UTC". A string that is not a time comes back as it was. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatDate(iso)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "5 Nov 2026": the date alone, in UTC. A string that is not a time comes back as it was. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `sinceIso` to `nowMs`, at least 1: "3 days of recording" on the fourth day. */
export function daysSince(sinceIso: string, nowMs: number): number {
  return Math.max(1, Math.floor((nowMs - Date.parse(sinceIso)) / DAY_MS));
}

/** Dollars with two decimals, rounded half up on the cent: "$3.10". */
export function formatUsd(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

/** The count and the word that goes with it: "1 page", "2 pages", "3 were". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
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

/** The scheduled checks the Monitors delivered by webhook, and the overdue ones pulled: the "Checks run" block. */
export const checksRun = (s: Stats): number => s.runs_by_trigger.webhook + s.runs_by_trigger.pull;

/**
 * The home's live line, in parts (the view sets them apart with " · "): "Recording since 3 Nov 2026",
 * "20 pages", "11 real changes", "150 checks", "8 noise events filtered". The figures are the stat blocks':
 * the active Monitors, Stats.changes, checksRun and every noise event. One sentence before any page is added.
 */
export function liveParts(s: Stats): string[] {
  if (s.recording_since === null) return ["Not recording yet: no page has been added."];
  return [
    `Recording since ${formatDate(s.recording_since)}`,
    plural(s.monitors.active, "page"),
    plural(s.changes, "real change"),
    plural(checksRun(s), "check"),
    `${plural(s.noise_suppressed, "noise event")} filtered`,
  ];
}

/**
 * Where a version's price table would be, when its run cannot start because spending on price tables is paused
 * (facts_status "paused"): the page view's version card and the compare's prices section.
 */
export const FACTS_PAUSED_COPY = `Price table not read: spending on price tables is paused at the $${FACTS_PAUSE_USD} line. The change itself is recorded, with its screenshot and diff.`;

/**
 * Whether a version's prices area says FACTS_PAUSED_COPY: its facts are `paused`, or, while the price-table pause
 * holds (`factsPaused`, the stats), still `pending` with its screenshot and source stored, so not yet reached by
 * the hourly job's hold. Without both stored it is still being captured, and says so as before.
 */
export function saysFactsPaused(
  v: { facts_status: string; screenshot_url: string | null; source_url: string | null },
  factsPaused: boolean,
): boolean {
  if (v.facts_status === "paused") return true;
  return factsPaused && v.facts_status === "pending" && v.screenshot_url !== null && v.source_url !== null;
}

/** The footer's line under the spend meter while spending on price tables is paused and the rest of the budget is not. */
export const FACTS_PAUSED_LINE = `Spending on price tables is paused at the $${FACTS_PAUSE_USD} line; changes are still recorded, with their screenshots and diffs.`;

/**
 * The banner on every screen at the spend pause (SPEND_PAUSE_USD): a capture is skipped whole there, so a change
 * is recorded without its screenshot, its stored source and its price table.
 */
export const SPEND_PAUSED_LINE =
  "Spending is paused at the budget line. Changes the Monitors report are still recorded, without screenshots, stored sources or price tables.";

/** The live line as one string. */
export const liveLine = (s: Stats): string => liveParts(s).join(" · ");

/**
 * The bounty section's cost line: "TinyFish spend so far $3.44 · $0.31 per real change · caps at $6 and $8 by
 * design." The cost per real change follows the footer's rule (the spend over the changes the site shows) and
 * is left out before the first one; the caps are the facts pause and the spend pause (src/core/limits.ts).
 */
export function costLine(s: Stats): string {
  const parts = [`TinyFish spend so far ${formatUsd(s.spend_usd)}`];
  if (s.changes > 0) parts.push(`${formatUsd(s.spend_usd / s.changes)} per real change`);
  parts.push(`caps at $${FACTS_PAUSE_USD} and $${SPEND_PAUSE_USD} by design.`);
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

/**
 * The header stamp follows the Monitors, not the wallet: RECORDING with the live dot while any Monitor is active
 * (at the budget line too, where the Monitors' scheduled checks still run and their changes are still kept),
 * PAUSED when none is.
 */
export function stampFor(s: Stats): { text: "RECORDING" | "PAUSED"; live: boolean } {
  return s.monitors.active > 0 ? { text: "RECORDING", live: true } : { text: "PAUSED", live: false };
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

/**
 * A fact's unit as it is shown after its price: left out when the price already says it ("$1 per 1,000" with
 * "per 1,000", "1M / month included" with "per month"), so a cell never reads "per month" twice. The unit is
 * still in the version's JSON as recorded.
 */
export function unitBeside(price: string, unit: string): string {
  const u = unit.trim();
  if (u === "") return "";
  const p = price.toLowerCase();
  const lower = u.toLowerCase();
  const per = lower.startsWith("per ") ? lower.slice(4).trim() : null;
  if (p.includes(lower) || (per !== null && per !== "" && (p.includes(`/ ${per}`) || p.includes(`/${per}`)))) return "";
  return u;
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
