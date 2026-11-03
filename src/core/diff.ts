// Structured diff (spec 4.7). Turns two versions of a page's normalized
// markdown into added / removed / changed blocks, each attributed to the
// heading it sits under, and diffs the price facts the Agent extracted.
//
// Callers pass text that already went through `normalize()`; nothing here
// normalizes. It runs inside a Worker (10 ms CPU on the free plan) on pages up
// to ~100 KB, and the first computation of a diff is never cached if it is
// killed, so the cost is bounded by construction: the diff runs on whole blocks
// (never lines), gives up on an exact alignment past MAX_EDIT_LENGTH edited
// blocks, compares at most DICE_MAX_CHARS of a block, only looks for the best
// pairing inside runs of at most MONOTONE_RUN_LIMIT blocks, and stops pairing
// by similarity once SIMILARITY_BUDGET bigram operations are spent.

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
 * The text of a heading without its optional closing sequence ("## Pro ##" is
 * "Pro"). The closing "#" run only counts when a space or tab precedes it, so
 * "C#" keeps its "#". Scans from the end, so a long line costs one pass.
 */
function headingText(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === "#") end--;
  if (end < raw.length && end > 0 && (raw[end - 1] === " " || raw[end - 1] === "\t")) return raw.slice(0, end).trim();
  return raw.trim();
}

/**
 * Splits normalized markdown into blocks. Blocks are separated by blank lines.
 * A heading line is always a block of its own (even with no blank line next to
 * it): its section is its own text without the "#" marks and any closing
 * sequence, and every following block takes that section until the next
 * heading. Blocks before the first heading have section "".
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
      section = headingText(heading[1]!);
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

// Only the start of a block is compared, so one huge block (a page with no
// blank lines) costs a bounded amount.
const DICE_MAX_CHARS = 4096;

// Total bigram work one structuredDiff call may spend: characters scanned to
// build a block's bigram set plus the size of the smaller set for each
// comparison. About 3 ms. A full rewrite of a 100 KB page would otherwise cost
// 10 ms or more in comparisons that find nothing; once the budget is spent
// blocks are no longer paired (they stay removed and added), except identical
// ones, which are free.
const SIMILARITY_BUDGET = 60_000;

/** Set of lowercased character bigrams of the first DICE_MAX_CHARS characters. Empty under two characters. */
function bigrams(text: string): Set<number> {
  const s = (text.length > DICE_MAX_CHARS ? text.slice(0, DICE_MAX_CHARS) : text).toLowerCase();
  const out = new Set<number>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.charCodeAt(i) * 65536 + s.charCodeAt(i + 1));
  return out;
}

/** Dice coefficient of two bigram sets, 0 when both are empty. */
function dice(a: Set<number>, b: Set<number>): number {
  const total = a.size + b.size;
  if (total === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  // Even if every bigram of the smaller set were shared the score would fall short.
  if ((2 * small.size) / total < PAIR_THRESHOLD) return 0;
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared++;
  return (2 * shared) / total;
}

/** Scores pairs of blocks for one diff, building each block's bigram set once and spending from SIMILARITY_BUDGET. */
class Similarity {
  private left = SIMILARITY_BUDGET;
  private readonly sets = new Map<Block, Set<number>>();

  private gramsOf(block: Block): Set<number> | null {
    const known = this.sets.get(block);
    if (known) return known;
    const cost = Math.min(block.text.length, DICE_MAX_CHARS);
    if (cost > this.left) return null;
    this.left -= cost;
    const set = bigrams(block.text);
    this.sets.set(block, set);
    return set;
  }

  /** 1 for identical text, else the Dice score; 0 once the budget cannot cover the comparison. */
  score(a: Block, b: Block): number {
    if (a.text === b.text) return 1;
    const setA = this.gramsOf(a);
    const setB = setA && this.gramsOf(b);
    if (!setA || !setB) return 0;
    const cost = Math.min(setA.size, setB.size);
    if (cost > this.left) return 0;
    this.left -= cost;
    return dice(setA, setB);
  }
}

// --- Pairing a run ----------------------------------------------------------------

// Pairing by best similarity compares every removed block with the added blocks
// after it, so it only runs when both sides of a run have at most this many
// blocks; longer runs pair position by position (cost linear in the run).
const MONOTONE_RUN_LIMIT = 50;

/**
 * For each removed block, the index of the added block it pairs with, or -1.
 * The i-th removed block takes the highest-scoring same-section added block
 * (score >= PAIR_THRESHOLD, the earliest on a tie) that comes after the one the
 * previous pair took, so pairs never cross and an inserted or deleted block
 * does not push every later pair out of line.
 */
function pairMonotonically(removedRun: Block[], addedRun: Block[], similarity: Similarity): Int32Array {
  const partner = new Int32Array(removedRun.length).fill(-1);
  let next = 0;
  for (let i = 0; i < removedRun.length && next < addedRun.length; i++) {
    const before = removedRun[i]!;
    let best = -1;
    let bestScore = 0;
    for (let j = next; j < addedRun.length; j++) {
      const after = addedRun[j]!;
      if (after.section !== before.section) continue;
      const score = similarity.score(before, after);
      if (score >= PAIR_THRESHOLD && score > bestScore) {
        best = j;
        bestScore = score;
        if (score === 1) break;
      }
    }
    if (best >= 0) {
      partner[i] = best;
      next = best + 1;
    }
  }
  return partner;
}

/** The i-th removed block pairs with the i-th added block when they are in the same section and similar. */
function pairPositionally(removedRun: Block[], addedRun: Block[], similarity: Similarity): Int32Array {
  const partner = new Int32Array(removedRun.length).fill(-1);
  const length = Math.min(removedRun.length, addedRun.length);
  for (let i = 0; i < length; i++) {
    const before = removedRun[i]!;
    const after = addedRun[i]!;
    if (before.section === after.section && similarity.score(before, after) >= PAIR_THRESHOLD) partner[i] = i;
  }
  return partner;
}

/**
 * Settles one run of blocks that the block diff reported as removed and added
 * with nothing unchanged between them (or, past the edit-distance bound, a
 * whole region treated as one run). Similar blocks in the same section become
 * one `changed` entry; a pair with identical text is unchanged and is dropped;
 * the rest stay removed or added. Appends in document order.
 */
function settleRun(removedRun: Block[], addedRun: Block[], similarity: Similarity, out: StructuredDiff): void {
  if (removedRun.length === 0 && addedRun.length === 0) return;
  const partner =
    removedRun.length > MONOTONE_RUN_LIMIT || addedRun.length > MONOTONE_RUN_LIMIT
      ? pairPositionally(removedRun, addedRun, similarity)
      : pairMonotonically(removedRun, addedRun, similarity);

  const removedFor = new Int32Array(addedRun.length).fill(-1);
  for (let i = 0; i < partner.length; i++) {
    if (partner[i]! >= 0) removedFor[partner[i]!] = i;
  }
  for (let i = 0; i < removedRun.length; i++) {
    if (partner[i]! < 0) out.removed.push(removedRun[i]!);
  }
  for (let j = 0; j < addedRun.length; j++) {
    const after = addedRun[j]!;
    const i = removedFor[j]!;
    if (i < 0) out.added.push(after);
    else if (removedRun[i]!.text !== after.text) out.changed.push({ section: after.section, before: removedRun[i]!.text, after: after.text });
  }
}

// --- Structured diff ------------------------------------------------------------

// The most added plus removed blocks the exact alignment will look for. The
// cost grows with the square of this: about 3 ms on a cold isolate for a page
// that shares no block with its predecessor. Past it, the changed region is not
// aligned at all (see structuredDiff).
const MAX_EDIT_LENGTH = 80;

/**
 * Compares two versions of a page. Blocks are matched by their text alone, so
 * a section heading that is renamed shows up as one removed and one added
 * heading while the unchanged blocks under it stay out of the diff. `removed`
 * is in `from` order; `added` and `changed` are in `to` order.
 *
 * The blocks both versions start and end with are skipped, and the rest is
 * aligned with `diffArrays` on block text. If that needs more than
 * MAX_EDIT_LENGTH edits it is abandoned and the whole remaining region is one
 * removed run followed by one added run, paired position by position: edits
 * that line up are still found, blocks that shifted are reported as removed and
 * added.
 */
export function structuredDiff(fromText: string, toText: string): StructuredDiff {
  const from = splitBlocks(fromText);
  const to = splitBlocks(toText);
  const out: StructuredDiff = { added: [], removed: [], changed: [] };
  const similarity = new Similarity();

  let start = 0;
  while (start < from.length && start < to.length && from[start]!.text === to[start]!.text) start++;
  let fromEnd = from.length;
  let toEnd = to.length;
  while (fromEnd > start && toEnd > start && from[fromEnd - 1]!.text === to[toEnd - 1]!.text) {
    fromEnd--;
    toEnd--;
  }
  const fromRegion = from.slice(start, fromEnd);
  const toRegion = to.slice(start, toEnd);

  const parts = diffArrays(
    fromRegion.map((b) => b.text),
    toRegion.map((b) => b.text),
    { maxEditLength: MAX_EDIT_LENGTH },
  );
  if (parts === undefined) {
    settleRun(fromRegion, toRegion, similarity, out);
    return out;
  }

  // Index pointers, not text lookups: the same text ("Free") can sit under
  // several headings and each block must keep its own section.
  let fromIndex = 0;
  let toIndex = 0;
  let removedRun: Block[] = [];
  let addedRun: Block[] = [];

  const settle = (): void => {
    settleRun(removedRun, addedRun, similarity, out);
    removedRun = [];
    addedRun = [];
  };

  for (const part of parts) {
    const count = part.value.length;
    if (part.removed) {
      for (let i = 0; i < count; i++) removedRun.push(fromRegion[fromIndex + i]!);
      fromIndex += count;
    } else if (part.added) {
      for (let i = 0; i < count; i++) addedRun.push(toRegion[toIndex + i]!);
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
