// Word-level marks for one changed block (the compare view and the home's featured catch): which words of
// the before side went and which words of the after side came. The plan named `diffWordsWithSpace` from
// `diff`; measured in Node it takes about 200 ms on two different 3,000-character blocks, and it splits
// "$20" into "$" and "20", so a price change would mark only the digits. This is the same Myers diff on
// word tokens, over typed arrays and with hard limits, so its cost is bounded whatever a page holds:
//
// - a side over WORD_DIFF_MAX_CHARS characters is not marked at all (wordDiff returns null);
// - the tokens both sides start and end with are skipped first, in one pass;
// - the diff of what is left gives up past MAX_EDITS edits, or when the caller's budget of steps runs out,
//   and then the whole stretch between the shared start and the shared end is marked on each side: still
//   true, only coarser.
//
// Nothing here renders: a Part is text and a flag, and the view escapes the text.

/** One stretch of a side: `mark` is true for words that went (before side) or came (after side). */
export type Part = { text: string; mark: boolean };

export type WordDiff = { before: Part[]; after: Part[] };

/** A side longer than this is not marked (the plan's 4,000). */
export const WORD_DIFF_MAX_CHARS = 4000;

/** The most token edits one pair is diffed for before it falls back to marking the whole changed stretch. */
const MAX_EDITS = 120;

/** Steps one call may take when the caller gives no budget of its own. */
const DEFAULT_STEPS = 200_000;

/**
 * Steps a caller lets a series of word diffs take in all (one view): each call takes what it uses, and a
 * call that would go past what is left falls back to the coarse marks. Mutable on purpose.
 */
export type WordDiffBudget = { steps: number };

// A word: a run of anything but whitespace and sentence punctuation, so a figure keeps its signs ("$1,200.50",
// "50%"); . , ' ’ - / join two runs into one word only when more of the word follows ("admin-user-sign-out",
// "don’t", "v1/users"), so "month." is "month" and ".". A run of whitespace is one token; any other character
// is a token of its own. A negated class, because \p{L} classes cost half as much again on real (two-byte)
// text; the u flag keeps a character outside the BMP (an emoji) in one token.
const TOKEN_RE = /\s+|[^\s.,;:!?()[\]{}<>"“”'‘’\-/]+(?:[.,'’\-/][^\s.,;:!?()[\]{}<>"“”'‘’\-/]+)*|[^]/gu;

const EQUAL = 0;
const REMOVED = 1;
const ADDED = 2;

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/**
 * The edit script from `a` to `b` (EQUAL, REMOVED, ADDED per step, in order) by Myers' O(ND) diff, or null
 * when it needs more than `maxEdits` edits or more than `steps.left` steps (what it took is subtracted).
 */
function myers(a: Int32Array, b: Int32Array, maxEdits: number, steps: { left: number }): Uint8Array | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const o = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let used = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(o - d - 1, o + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[o + k - 1]! < v[o + k + 1]!) ? v[o + k + 1]! : v[o + k - 1]! + 1;
      let y = x - k;
      used++;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
        used++;
      }
      v[o + k] = x;
      if (used > steps.left) {
        steps.left = 0;
        return null;
      }
      if (x >= n && y >= m) {
        steps.left -= used;
        return backtrack(trace, d, n, m);
      }
    }
  }
  steps.left -= used;
  return null;
}

/** Walks the stored rows back from (n, m) to (0, 0); row d holds v for k in [-d-1, d+1], before step d. */
function backtrack(trace: Int32Array[], depth: number, n: number, m: number): Uint8Array {
  // Every step is an equal pair, a removal or an addition: n + m - (equal pairs) steps, written from the end.
  const script = new Uint8Array(n + m);
  let w = script.length;
  let x = n;
  let y = m;
  for (let d = depth; d > 0; d--) {
    const row = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && row[k - 1 + d + 1]! < row[k + 1 + d + 1]!);
    const pk = down ? k + 1 : k - 1;
    const px = row[pk + d + 1]!;
    const sx = down ? px : px + 1;
    while (x > sx) {
      script[--w] = EQUAL;
      x--;
      y--;
    }
    script[--w] = down ? ADDED : REMOVED;
    x = px;
    y = px - pk;
  }
  while (x > 0) {
    script[--w] = EQUAL;
    x--;
  }
  return script.subarray(w);
}

/** Adds a token to a side, joining it to the last part when the mark is the same. */
function push(parts: Part[], text: string, mark: boolean): void {
  if (text === "") return;
  const last = parts[parts.length - 1];
  if (last !== undefined && last.mark === mark) last.text += text;
  else parts.push({ text, mark });
}

/**
 * Whitespace between two marked stretches is marked too, so "went and gone" reads as one struck run, not
 * three; the text is unchanged.
 */
function bridge(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const between = !p.mark && i > 0 && i < parts.length - 1 && parts[i - 1]!.mark && parts[i + 1]!.mark && p.text.trim() === "";
    push(out, p.text, p.mark || between);
  }
  return out;
}

/**
 * The words that differ between two versions of a block, as each side's text cut into marked and unmarked
 * stretches (the stretches of a side join back to exactly its text). Null when either side is longer than
 * WORD_DIFF_MAX_CHARS. With a `budget`, the steps taken come out of it, and once it cannot cover a pair the
 * pair is marked coarsely (everything between the words both sides start and end with).
 */
export function wordDiff(before: string, after: string, budget?: WordDiffBudget): WordDiff | null {
  if (before.length > WORD_DIFF_MAX_CHARS || after.length > WORD_DIFF_MAX_CHARS) return null;
  const ta = tokenize(before);
  const tb = tokenize(after);

  let start = 0;
  while (start < ta.length && start < tb.length && ta[start] === tb[start]) start++;
  let endA = ta.length;
  let endB = tb.length;
  while (endA > start && endB > start && ta[endA - 1] === tb[endB - 1]) {
    endA--;
    endB--;
  }

  // The middle tokens as numbers, so the diff compares integers (plain loops: Int32Array.from with a map
  // function is several times slower).
  const ids = new Map<string, number>();
  const a = new Int32Array(endA - start);
  const b = new Int32Array(endB - start);
  for (const [tokens, out] of [[ta, a], [tb, b]] as const) {
    for (let i = 0; i < out.length; i++) {
      const t = tokens[start + i]!;
      let id = ids.get(t);
      if (id === undefined) {
        id = ids.size;
        ids.set(t, id);
      }
      out[i] = id;
    }
  }

  // A token one side has more often than the other is at least one edit, so this many edits are certain
  // before the diff starts; past MAX_EDITS the diff would only give up later.
  const surplus = new Int32Array(ids.size);
  for (let i = 0; i < a.length; i++) surplus[a[i]!]!++;
  for (let i = 0; i < b.length; i++) surplus[b[i]!]!--;
  let least = 0;
  for (let i = 0; i < surplus.length; i++) least += Math.abs(surplus[i]!);

  const steps = { left: Math.max(0, budget?.steps ?? DEFAULT_STEPS) };
  const script = a.length > 0 && b.length > 0 && least <= MAX_EDITS ? myers(a, b, MAX_EDITS, steps) : null;
  if (budget !== undefined) budget.steps = steps.left;

  const left: Part[] = [];
  const right: Part[] = [];
  push(left, ta.slice(0, start).join(""), false);
  push(right, tb.slice(0, start).join(""), false);
  if (script === null) {
    // One side is empty past the shared start and end, or the diff gave up: the whole middle differs.
    push(left, ta.slice(start, endA).join(""), true);
    push(right, tb.slice(start, endB).join(""), true);
  } else {
    let i = start;
    let j = start;
    for (const step of script) {
      if (step === EQUAL) {
        push(left, ta[i++]!, false);
        push(right, tb[j++]!, false);
      } else if (step === REMOVED) {
        push(left, ta[i++]!, true);
      } else {
        push(right, tb[j++]!, true);
      }
    }
  }
  push(left, ta.slice(endA).join(""), false);
  push(right, tb.slice(endB).join(""), false);
  return { before: bridge(left), after: bridge(right) };
}

/** True when a side has at least one marked stretch with something other than whitespace in it. */
export const hasMarks = (parts: Part[]): boolean => parts.some((p) => p.mark && p.text.trim() !== "");
