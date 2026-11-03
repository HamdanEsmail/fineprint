// Structured diff (spec 4.7). Turns two versions of a page's normalized
// markdown into added / removed / changed blocks, each attributed to the
// heading it sits under, and diffs the price facts the Agent extracted.
//
// Callers pass text that already went through `normalize()`; nothing here
// normalizes. It runs inside a Worker (10 ms CPU on the free plan) on pages up
// to ~100 KB, so the line diff is never used: `diffArrays` runs on blocks, and
// each block's bigram set is built at most once.

import { diffArrays } from "diff";

export type Block = {
  /** Text of the nearest heading at or above the block ("" before the first heading). */
  section: string;
  text: string;
};

export type ChangedBlock = { section: string; before: string; after: string };

export type StructuredDiff = {
  added: Block[];
  removed: Block[];
  changed: ChangedBlock[];
};

export type Fact = { name: string; price: string; unit: string | null; notes: string | null };

export type FactField = "price" | "unit" | "notes";

export type FactChange = { name: string; field: FactField; before: string | null; after: string | null };

export type FactsDiff = {
  added: Fact[];
  removed: Fact[];
  changed: FactChange[];
};

// --- Blocks -----------------------------------------------------------------

// An ATX heading: one to six "#", a space, then text. Tested on a line whose
// trailing whitespace is already gone.
const HEADING_RE = /^#{1,6} +(\S.*)$/;

/**
 * Splits normalized markdown into blocks. Blocks are separated by blank lines.
 * A heading line is always a block of its own (even with no blank line next to
 * it): its section is its own text without the "#" marks, and every following
 * block takes that section until the next heading.
 */
export function splitBlocks(normalizedText: string): Block[] {
  const blocks: Block[] = [];
  let section = "";
  let lines: string[] = [];

  const flush = (): void => {
    if (lines.length === 0) return;
    blocks.push({ section, text: lines.join("\n").trim() });
    lines = [];
  };

  for (const rawLine of normalizedText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      section = heading[1]!.trim();
      blocks.push({ section, text: line });
      continue;
    }
    lines.push(line);
  }
  flush();
  return blocks;
}

// --- Similarity ---------------------------------------------------------------

// A removed block and an added block in the same section are one edit, not a
// deletion plus an insertion, when their Dice similarity reaches this.
const PAIR_THRESHOLD = 0.5;

/** Set of lowercased character bigrams (newlines included). Empty for texts under two characters. */
function bigrams(text: string): Set<string> {
  const s = text.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Dice coefficient of two bigram sets, 0 when both are empty. */
function dice(a: Set<string>, b: Set<string>): number {
  const total = a.size + b.size;
  if (total === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared++;
  return (2 * shared) / total;
}

// --- Structured diff ------------------------------------------------------------

/**
 * Settles one run of blocks that the line diff reported as removed and added
 * with nothing unchanged between them. The i-th removed block pairs with the
 * i-th added block when both sit in the same section and are similar enough;
 * everything else stays removed or added. Appends in document order.
 */
function settleRun(removedRun: Block[], addedRun: Block[], out: StructuredDiff): void {
  const length = Math.max(removedRun.length, addedRun.length);
  for (let i = 0; i < length; i++) {
    const before: Block | undefined = removedRun[i];
    const after: Block | undefined = addedRun[i];
    if (before && after && before.section === after.section && dice(bigrams(before.text), bigrams(after.text)) >= PAIR_THRESHOLD) {
      out.changed.push({ section: after.section, before: before.text, after: after.text });
      continue;
    }
    if (before) out.removed.push(before);
    if (after) out.added.push(after);
  }
}

/**
 * Compares two versions of a page. Blocks are matched by their text alone, so
 * a section heading that is renamed shows up as one removed and one added
 * heading while the unchanged blocks under it stay out of the diff. `removed`
 * is in `from` order; `added` and `changed` are in `to` order.
 */
export function structuredDiff(fromText: string, toText: string): StructuredDiff {
  const from = splitBlocks(fromText);
  const to = splitBlocks(toText);
  const out: StructuredDiff = { added: [], removed: [], changed: [] };

  // Index pointers, not text lookups: the same text ("Free") can sit under
  // several headings and each block must keep its own section.
  let fromIndex = 0;
  let toIndex = 0;
  let removedRun: Block[] = [];
  let addedRun: Block[] = [];

  const settle = (): void => {
    settleRun(removedRun, addedRun, out);
    removedRun = [];
    addedRun = [];
  };

  for (const part of diffArrays(
    from.map((b) => b.text),
    to.map((b) => b.text),
  )) {
    const count = part.value.length;
    if (part.removed) {
      for (let i = 0; i < count; i++) removedRun.push(from[fromIndex + i]!);
      fromIndex += count;
    } else if (part.added) {
      for (let i = 0; i < count; i++) addedRun.push(to[toIndex + i]!);
      toIndex += count;
    } else {
      settle();
      fromIndex += count;
      toIndex += count;
    }
  }
  settle();
  return out;
}

// --- Facts diff ---------------------------------------------------------------

const FACT_FIELDS: readonly FactField[] = ["price", "unit", "notes"];

function factKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Diffs the facts of two versions, matched by case-insensitive name. Returns
 * null when either side has no facts to compare (null). A name that repeats on
 * one side pairs by occurrence (first with first, second with second); the
 * surplus on either side is added or removed. `removed` is in `from` order;
 * `added` and `changed` are in `to` order, and `changed` has one entry per
 * differing field in the order price, unit, notes.
 */
export function factsDiff(from: Fact[] | null, to: Fact[] | null): FactsDiff | null {
  if (from === null || to === null) return null;

  // Unmatched positions in `from`, per name, in order.
  const pending = new Map<string, number[]>();
  from.forEach((fact, index) => {
    const key = factKey(fact.name);
    const list = pending.get(key);
    if (list) list.push(index);
    else pending.set(key, [index]);
  });

  const out: FactsDiff = { added: [], removed: [], changed: [] };
  const matched = new Set<number>();
  for (const next of to) {
    const index = pending.get(factKey(next.name))?.shift();
    if (index === undefined) {
      out.added.push(next);
      continue;
    }
    matched.add(index);
    const prev = from[index]!;
    for (const field of FACT_FIELDS) {
      if (prev[field] !== next[field]) out.changed.push({ name: next.name, field, before: prev[field], after: next[field] });
    }
  }
  from.forEach((fact, index) => {
    if (!matched.has(index)) out.removed.push(fact);
  });
  return out;
}
