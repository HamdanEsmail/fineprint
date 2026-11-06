// The one-line summary a non-baseline version carries (Task 15). TinyFish's judgment summary is used when
// the run had one; otherwise the line is built here, deterministically, from Fineprint's own structured
// diff against the previous version: the block counts and the first added or changed line that says
// something (the line rule, site plan Task 2), e.g.
//   3 blocks added, 1 changed: "Claude Code is now included in the Pro plan"
// No Agent or model call is involved. Pure functions: the caller supplies the diff and the new text.
import type { Block, ChangedBlock, StructuredDiff } from "./diff";

/** A diff summary is at most this many characters; the quote is shortened to fit. */
export const SUMMARY_MAX_CHARS = 200;

/** A line is quoted only when it is longer than this after cleaning; a shorter one rarely says what changed. */
export const SUMMARY_QUOTE_MIN_CHARS = 30;

const EMPTY_DIFF = "No block-level change after normalization";

/** A text on one line (every run of whitespace becomes one space, trimmed), or null when nothing is left. */
export function oneLine(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line === "" ? null : line;
}

/**
 * A markdown line as plain text: images and links keep their text, emphasis and code marks go, and the
 * marks in front of a line (headings, quotes, list bullets, table bars) are dropped.
 */
function plain(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/^[\s#>*+|-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// An ATX heading line ("## November 4, 2026"): never quoted, whatever it says.
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;

// A line that is only a date, in the forms release notes and policies use: "November 4, 2026",
// "4 November 2026", "Wednesday, September 23rd, 2026", "Nov 2026", "2026-11-04", "11/04/2026".
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "\\d{1,2}(?:st|nd|rd|th)?";
const BARE_DATE = new RegExp(
  `^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s+)?(?:${MONTH}\\s+${DAY},?\\s+\\d{4}|${DAY}\\s+(?:of\\s+)?${MONTH},?\\s+\\d{4}|${MONTH},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4})\\.?$`,
  "i",
);

/**
 * A raw markdown line as the quote it would make, or null when it is not quoted: a heading, a bare date,
 * or a line of SUMMARY_QUOTE_MIN_CHARS characters or fewer once cleaned.
 */
function quotable(line: string): string | null {
  if (HEADING_LINE.test(line)) return null;
  const text = plain(line);
  if (text.length <= SUMMARY_QUOTE_MIN_CHARS || BARE_DATE.test(text)) return null;
  return text;
}

/** The first quotable line of `lines`, or null. */
function firstQuotable(lines: string[]): string | null {
  for (const line of lines) {
    const text = quotable(line);
    if (text !== null) return text;
  }
  return null;
}

/** For a changed block, the lines of the new text that the old text did not have. */
function changedLines(change: ChangedBlock): string[] {
  const before = new Set(change.before.split("\n").map((l) => l.trim()));
  return change.after.split("\n").filter((l) => !before.has(l.trim()));
}

const blockLines = (block: Block): string[] => block.text.split("\n");

/**
 * The added and changed blocks in the order of the new text, as the lines each could be quoted from.
 * structuredDiff gives each list in `to` order, so each list's next block is looked for after the
 * previous one's place (one pass over the text per list, however many blocks); a block not found sorts
 * after the ones found. Lazy: the walk stops at the first quotable line.
 */
function* inTextOrder(diff: StructuredDiff, nextText: string): Generator<string[]> {
  const find = (text: string, from: number): number => {
    const at = nextText.indexOf(text, from);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  let a = 0;
  let c = 0;
  let aFrom = 0;
  let cFrom = 0;
  let aAt = diff.added.length > 0 ? find(diff.added[0]!.text, 0) : Number.MAX_SAFE_INTEGER;
  let cAt = diff.changed.length > 0 ? find(diff.changed[0]!.after, 0) : Number.MAX_SAFE_INTEGER;
  while (a < diff.added.length || c < diff.changed.length) {
    if (c >= diff.changed.length || (a < diff.added.length && aAt <= cAt)) {
      yield blockLines(diff.added[a]!);
      if (aAt !== Number.MAX_SAFE_INTEGER) aFrom = aAt + 1;
      a++;
      aAt = a < diff.added.length ? find(diff.added[a]!.text, aFrom) : Number.MAX_SAFE_INTEGER;
    } else {
      yield changedLines(diff.changed[c]!);
      if (cAt !== Number.MAX_SAFE_INTEGER) cFrom = cAt + 1;
      c++;
      cAt = c < diff.changed.length ? find(diff.changed[c]!.after, cFrom) : Number.MAX_SAFE_INTEGER;
    }
  }
}

/** The first `units` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair (an emoji). */
function sliceWhole(text: string, units: number): string {
  const last = text.charCodeAt(units - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? units - 1 : units);
}

/** `"<quote>"` after `head: `, the quote cut (with an ellipsis) so the whole line fits SUMMARY_MAX_CHARS. */
function withQuote(head: string, quote: string | null): string {
  if (quote === null) return head;
  const room = SUMMARY_MAX_CHARS - head.length - 4; // `: "` and the closing `"`
  if (room < 2) return head;
  const cut = quote.length <= room ? quote : `${sliceWhole(quote, room - 1).trimEnd()}…`;
  return `${head}: "${cut}"`;
}

/**
 * The diff summary of a version: the counts of added, changed and removed blocks (the first with the
 * word "block"), then, in quotes, the first added or changed line in the order of the new text that is
 * longer than SUMMARY_QUOTE_MIN_CHARS characters once cleaned and is neither a heading nor a bare date
 * (the line rule). A version that only removed blocks quotes its first removed line under the same rule.
 * When no line qualifies, the counts stand alone. `nextText` is the normalized text the diff's `to` side
 * was split from.
 */
export function diffSummary(diff: StructuredDiff, nextText: string): string {
  const counts: [number, string][] = [
    [diff.added.length, "added"],
    [diff.changed.length, "changed"],
    [diff.removed.length, "removed"],
  ];
  const parts = counts
    .filter(([n]) => n > 0)
    .map(([n, verb], i) => (i === 0 ? `${n} ${n === 1 ? "block" : "blocks"} ${verb}` : `${n} ${verb}`));
  if (parts.length === 0) return EMPTY_DIFF;

  let quote: string | null = null;
  if (diff.added.length > 0 || diff.changed.length > 0) {
    for (const lines of inTextOrder(diff, nextText)) {
      quote = firstQuotable(lines);
      if (quote !== null) break;
    }
  } else {
    for (const block of diff.removed) {
      quote = firstQuotable(blockLines(block));
      if (quote !== null) break;
    }
  }
  return withQuote(parts.join(", "), quote);
}
