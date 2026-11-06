// The one-line summary a non-baseline version carries (Task 15). TinyFish's judgment summary is used when
// the run had one; otherwise the line is built here, deterministically, from Fineprint's own structured
// diff against the previous version: the block counts and the first added or changed line, e.g.
//   3 blocks added, 1 changed: "Claude Code is now included in the Pro plan"
// No Agent or model call is involved. Pure functions: the caller supplies the diff and the new text.
import type { Block, ChangedBlock, StructuredDiff } from "./diff";

/** A diff summary is at most this many characters; the quote is shortened to fit. */
export const SUMMARY_MAX_CHARS = 200;

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

/** The first line of `lines` that still says something as plain text, or null. */
function firstPlain(lines: string[]): string | null {
  for (const line of lines) {
    const text = plain(line);
    if (text !== "") return text;
  }
  return null;
}

/** For a changed block, the first line of the new text that the old text did not have (else its first line). */
function changedLine(change: ChangedBlock): string | null {
  const before = new Set(change.before.split("\n").map((l) => l.trim()));
  const after = change.after.split("\n");
  return firstPlain(after.filter((l) => !before.has(l.trim()))) ?? firstPlain(after);
}

const blockLine = (block: Block): string | null => firstPlain(block.text.split("\n"));

/** Where a block's text starts in the new text; a text not found sorts last. */
function position(nextText: string, text: string): number {
  const at = nextText.indexOf(text);
  return at < 0 ? Number.MAX_SAFE_INTEGER : at;
}

/** `"<quote>"` after `head: `, the quote cut (with an ellipsis) so the whole line fits SUMMARY_MAX_CHARS. */
function withQuote(head: string, quote: string | null): string {
  if (quote === null) return head;
  const room = SUMMARY_MAX_CHARS - head.length - 4; // `: "` and the closing `"`
  if (room < 2) return head;
  const cut = quote.length <= room ? quote : `${quote.slice(0, room - 1).trimEnd()}…`;
  return `${head}: "${cut}"`;
}

/**
 * The diff summary of a version: the counts of added, changed and removed blocks (the first with the
 * word "block"), then, in quotes, the first added or changed line in the order of the new text. A
 * version that only removed blocks quotes its first removed line instead. `nextText` is the normalized
 * text the diff's `to` side was split from.
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

  const added = diff.added[0];
  const changed = diff.changed[0];
  let quote: string | null = null;
  if (added !== undefined && (changed === undefined || position(nextText, added.text) < position(nextText, changed.after))) {
    quote = blockLine(added);
  } else if (changed !== undefined) {
    quote = changedLine(changed);
  } else if (diff.removed[0] !== undefined) {
    quote = blockLine(diff.removed[0]);
  }
  return withQuote(parts.join(", "), quote);
}
