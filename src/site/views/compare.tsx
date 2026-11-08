// Compare view (GET /pages/:id/compare?from=<version id>&to=<version id>, all=1): what changed between two
// versions of one page. It leads with the change itself: the span and the summary, the prices that moved,
// then the blocks of cleaned text under the page's own section headings (in each, the changed blocks, then
// the added, then the removed), the two screenshots with their evidence lines, and the links out. The diff
// is the JSON API's (src/readModel.ts diffVersions, from the same cache); nothing here reads the database.
//
// Cost: blocks are capped per section group (BLOCKS_PER_GROUP, all=1 lifts it) and on the whole screen
// (SCREEN_BLOCKS, SCREEN_CHARS and SCREEN_WORK, and ALL_BLOCKS, ALL_CHARS and ALL_WORK with all=1); a block
// over LONG_BLOCK_CHARS is shown in part (around the change, or from its start); and word marks, the part
// that grows fastest with the text, are capped by pairs and by characters (WORD_DIFF_PAIRS, WORD_DIFF_CHARS)
// with a shared step budget, the shortest pairs marked first. The work budget counts what a block costs to
// read and draw (src/site/blockText.tsx blockWork), so a screen of `a` code spans or *a* emphasis, an
// element or a mark a word, stops as soon as a screen of prose costs as much.
import type { ChangedBlock, FactChange, FactsDiff, StructuredDiff } from "../../core/diff";
import type { Diff, PageJson, Stats, VersionItem } from "../../readModel";
import { BlockText, blockWork, plainText } from "../blockText";
import { CompareForm, EvidenceLine, LAYOUT_ONLY_LINE, ShotFigure } from "../components";
import { formatUtc, plural, SUMMARY_ORIGIN, unitBeside } from "../format";
import { Layout, type ScreenLink } from "../layout";
import { hasMarks, wordDiff, type WordDiff, type WordDiffBudget } from "../wordDiff";

/** Blocks shown per section group before "Show all". */
export const BLOCKS_PER_GROUP = 30;
/** Blocks and characters of shown text on one screen, at most (release notes keep a section a release). */
export const SCREEN_BLOCKS = 120;
export const SCREEN_CHARS = 60_000;
/**
 * The work of the blocks on one screen (blockWork: a line, or a stop of the inline walk, is one), at most. The
 * largest real diff (Claude release notes, 4 to 5 Nov: 23 changed blocks, 53,500 characters) is about 2,500.
 * Measured in Node on screens of nothing but dense blocks (`a` code spans, *a* emphasis, a_b, [` runs) with
 * 40 changed pairs: a median of 0.5 to 2 ms a screen at this cap (it was 4 to 14 ms when only characters were
 * counted), and 0.5 to 3 ms with all=1 at ALL_WORK.
 */
export const SCREEN_WORK = 6000;
/** The same with all=1: past it, the JSON has every block. */
export const ALL_BLOCKS = 400;
export const ALL_CHARS = 120_000;
export const ALL_WORK = 8000;
/** Changed blocks that get word marks, at most; the rest show before and after side by side, unmarked. */
export const WORD_DIFF_PAIRS = 40;
/**
 * Characters (both sides together) word-marked on one screen, at most. Measured in Node: a 4,000-character
 * pair with many edits takes up to about 0.7 ms to mark, a 600-character pair 0.03 ms; 20,000 characters
 * keep the marks near 2 ms in the worst case and cover some 15 to 30 ordinary changed paragraphs.
 */
export const WORD_DIFF_CHARS = 20_000;
/** Myers steps one screen's word marks may take in all; a pair that would go past it is marked coarsely. */
const WORD_DIFF_STEPS = 150_000;

export type CompareState =
  /** Two different versions: the diff between them, `from` the older, and where its sections stand. */
  | { kind: "diff"; from: VersionItem; to: VersionItem; diff: Diff; all: boolean; places: SectionPlaces | null }
  /** The same version on both sides. */
  | { kind: "same"; at: VersionItem }
  /** A page with one version, or none. */
  | { kind: "single" };

export type CompareProps = {
  stats: Stats;
  /** Where the screen lives, for its link preview (src/site/layout.tsx). */
  link: ScreenLink;
  page: PageJson;
  /** Every version of the page, newest first, without text. */
  versions: VersionItem[];
  state: CompareState;
};

const isGone = (status: string | null): boolean => status === "retired" || status === "expired";

/** The form's two choices around one version: from the version before it to it, or, for the oldest, from it to the next. */
function pairAround(versions: VersionItem[], id: string): { fromId: string; toId: string } {
  const i = Math.max(0, versions.findIndex((v) => v.id === id));
  return i < versions.length - 1 ? { fromId: versions[i + 1]!.id, toId: id } : { fromId: id, toId: versions[Math.max(i - 1, 0)]!.id };
}

// --- The blocks, in section groups --------------------------------------------------------------

type Item = { kind: "changed"; block: ChangedBlock } | { kind: "added"; text: string } | { kind: "removed"; text: string };

type Group = { section: string; items: Item[] };

/**
 * Where each section's heading stands in the two texts (src/readModel.ts sectionPlaces): its character
 * position in the newer and the older text, 0 where it is not found. Null when not read (one section).
 */
export type SectionPlaces = Map<string, { newer: number; older: number }>;

/**
 * The page order of a diff's sections when the diff alone settles it, as places (`newer` its rank, from 1);
 * null when it does not, and the texts must be searched (src/readModel.ts sectionPlaces). `changed` and
 * `added` are each in the newer text's order, so each lists its sections in page order; when the two lists
 * together leave one way to line every section up, and every section of `removed` is among them (so it stands
 * in the newer text too), that is the page order. A diff of changed blocks only, the usual case for a large
 * page, is settled unless a section comes back in it after another (A, then B, then A again: the page has two
 * headings A, and the search orders A by its first). The blocks above the first heading ("") go first
 * whatever the places say.
 */
export function placesFromDiff(blocks: StructuredDiff): SectionPlaces | null {
  // Each list's sections in its order, a run of blocks in one section counted once.
  const lists = [blocks.changed ?? [], blocks.added ?? []].map((list) =>
    list.map((b) => b.section).filter((s, i, all) => s !== "" && s !== all[i - 1]),
  );
  // A section that comes back after another stands at two places in the page: the diff cannot say which one
  // its group goes by, and the search goes by the first. (A repeated heading whose earlier part did not change
  // is not in the lists at all, so the diff cannot see it.)
  if (lists.some((list) => new Set(list).size !== list.length)) return null;
  const named = new Set(lists.flat());
  for (const b of blocks.removed ?? []) if (b.section !== "" && !named.has(b.section)) return null;
  // Each list's neighbours are an edge; the order is settled when, step by step, exactly one section has no
  // section left before it (Kahn's algorithm with a uniqueness check: a cycle or a tie is null).
  const next = new Map<string, Set<string>>();
  const before = new Map<string, number>();
  for (const s of named) {
    next.set(s, new Set());
    before.set(s, 0);
  }
  for (const list of lists) {
    for (let i = 1; i < list.length; i++) {
      const edges = next.get(list[i - 1]!)!;
      if (edges.has(list[i]!)) continue;
      edges.add(list[i]!);
      before.set(list[i]!, before.get(list[i]!)! + 1);
    }
  }
  const places: SectionPlaces = new Map();
  let ready = [...named].filter((s) => before.get(s) === 0);
  while (ready.length === 1) {
    const s = ready[0]!;
    places.set(s, { newer: places.size + 1, older: 0 });
    ready = [];
    for (const t of next.get(s)!) {
      const left = before.get(t)! - 1;
      before.set(t, left);
      if (left === 0) ready.push(t);
    }
  }
  return places.size === named.size ? places : null;
}

/** The section names of a diff, in the order they first appear among the changed, added and removed blocks. */
export function diffSections(blocks: StructuredDiff): string[] {
  const seen = new Set<string>();
  for (const list of [blocks.changed ?? [], blocks.added ?? [], blocks.removed ?? []]) for (const b of list) seen.add(b.section);
  return [...seen];
}

/**
 * The diff's blocks under their section headings, one group per section; inside a group the changed blocks
 * first, then the added, then the removed, each in the diff's own order. Groups go in page order: by where
 * the section's heading stands in the newer text (the blocks before the first heading first); a section
 * that is gone from the newer text goes right after the section it followed in the older text; a section
 * found in neither goes last, in the order it first appears in the diff.
 */
function groupBlocks(blocks: StructuredDiff, places: SectionPlaces | null): Group[] {
  const groups = new Map<string, Group>();
  const add = (section: string, item: Item): void => {
    let group = groups.get(section);
    if (group === undefined) {
      group = { section, items: [] };
      groups.set(section, group);
    }
    group.items.push(item);
  };
  for (const block of blocks.changed ?? []) add(block.section, { kind: "changed", block });
  for (const block of blocks.added ?? []) add(block.section, { kind: "added", text: block.text });
  for (const block of blocks.removed ?? []) add(block.section, { kind: "removed", text: block.text });
  const list = [...groups.values()];
  if (places === null || places === undefined) return list;

  const place = (g: Group) => (g.section === "" ? { newer: -1, older: -1 } : (places.get(g.section) ?? { newer: 0, older: 0 }));
  const present = list.filter((g) => place(g).newer !== 0);
  // A sort key of three numbers: the newer position the group goes by, 0 for a section in the newer text
  // and 1 for one placed after it, and the older position among those placed after the same section.
  const key = new Map<Group, [number, number, number]>();
  for (const g of present) key.set(g, [place(g).newer, 0, 0]);
  list.forEach((g, index) => {
    if (key.has(g)) return;
    const older = place(g).older;
    if (older <= 0) {
      key.set(g, [Number.MAX_SAFE_INTEGER, 2, index]);
      return;
    }
    let after: Group | null = null;
    for (const p of present) {
      const o = place(p).older;
      if (o !== 0 && o < older && (after === null || o > place(after).older)) after = p;
    }
    // Before every section of the newer text but the blocks above the first heading.
    key.set(g, [after === null ? -1 : place(after).newer, 1, older]);
  });
  return list.sort((a, b) => {
    const [a0, a1, a2] = key.get(a)!;
    const [b0, b1, b2] = key.get(b)!;
    return a0 - b0 || a1 - b1 || a2 - b2;
  });
}

// --- Long blocks --------------------------------------------------------------------------------
//
// A page whose text has no blank lines is one block, so a block can be the whole page (95 KB on the Gemini
// pricing page). Drawn whole on both sides it would be two walls of text and most of the render's time, so a
// long block is shown in part: a changed one around the change, an added or removed one from its start.

/** A block longer than this many characters (either side of a changed pair) is shown in part. */
export const LONG_BLOCK_CHARS = 4000;
/** Unchanged characters kept before and after the change in a long changed block. */
const EXCERPT_CONTEXT = 240;
/** Characters of a long block's changed stretch shown, at most, on each side. */
const EXCERPT_CHANGE = 2400;
/** Characters shown from the start of a long added or removed block. */
const BLOCK_START_CHARS = 2400;
/** How far a cut looks for whitespace to fall on, so it does not split a word. */
const SNAP = 80;

const isWhite = (c: string | undefined): boolean => c === " " || c === "\n" || c === "\t" || c === "\r";

/** `i` moved back to just after a whitespace, within SNAP characters; `i` itself when there is none. */
function snapBack(text: string, i: number): number {
  if (i <= 0) return 0;
  for (let k = i; k > Math.max(0, i - SNAP); k--) if (isWhite(text[k - 1])) return k;
  return i;
}

/** `i` moved on to the next whitespace, within SNAP characters; the end of the text when it is near. */
function snapOn(text: string, i: number): number {
  if (i >= text.length) return text.length;
  for (let k = i; k < Math.min(text.length, i + SNAP); k++) if (isWhite(text[k])) return k;
  return i;
}

/** What a changed pair shows: the whole blocks, or the stretch around the change with what was cut said. */
type PairView = { block: ChangedBlock; before: string; after: string; cut: { start: boolean; endBefore: boolean; endAfter: boolean } | null };

/**
 * A changed pair as it is shown. Short blocks whole; a long one from a little before the first character
 * that differs to a little after the last, each side cut at EXCERPT_CHANGE characters of change. The texts
 * share everything before the first difference, so both sides start at the same place.
 */
function pairView(block: ChangedBlock): PairView {
  const { before, after } = block;
  if (before.length <= LONG_BLOCK_CHARS && after.length <= LONG_BLOCK_CHARS) return { block, before, after, cut: null };
  const shortest = Math.min(before.length, after.length);
  let head = 0;
  while (head < shortest && before.charCodeAt(head) === after.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < shortest - head && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  const start = snapBack(before, Math.max(0, head - EXCERPT_CONTEXT));
  const end = (text: string): number => snapOn(text, Math.min(text.length - tail + EXCERPT_CONTEXT, start + EXCERPT_CHANGE + 2 * EXCERPT_CONTEXT));
  const endBefore = end(before);
  const endAfter = end(after);
  return {
    block,
    before: before.slice(start, endBefore),
    after: after.slice(start, endAfter),
    cut: { start: start > 0, endBefore: endBefore < before.length, endAfter: endAfter < after.length },
  };
}

/** A long added or removed block's start, cut at whitespace; null when the block is short enough to show whole. */
function blockStart(text: string): string | null {
  return text.length <= LONG_BLOCK_CHARS ? null : text.slice(0, snapOn(text, BLOCK_START_CHARS));
}

/**
 * Word marks for the changed pairs on screen, within the pair, character and step budgets: the shortest pairs
 * first, so one long pair near the top of a screen does not leave every short pair after it unmarked.
 */
function markPairs(shown: PairView[]): Map<PairView, WordDiff> {
  const marks = new Map<PairView, WordDiff>();
  const budget: WordDiffBudget = { steps: WORD_DIFF_STEPS };
  const sides = shown
    .map((view) => ({ view, before: plainText(view.before), after: plainText(view.after) }))
    .sort((x, y) => x.before.length + x.after.length - (y.before.length + y.after.length));
  let chars = 0;
  for (const { view, before, after } of sides) {
    if (marks.size >= WORD_DIFF_PAIRS) break;
    // Shortest first: once one pair is past the characters left, so is every pair after it.
    if (chars + before.length + after.length > WORD_DIFF_CHARS) break;
    const d = wordDiff(before, after, budget);
    if (d === null) continue;
    chars += before.length + after.length;
    marks.set(view, d);
  }
  return marks;
}

const Ellipsis = () => (
  <p class="bt-cut" aria-hidden="true">
    …
  </p>
);

function ChangedPair(props: { view: PairView; marks: WordDiff | undefined }) {
  const { view, marks } = props;
  const { cut } = view;
  // A link target or a format mark is not shown, so a block can differ with the same words on both sides.
  const sameWords = marks !== undefined && !hasMarks(marks.before) && !hasMarks(marks.after);
  return (
    <div class="pair">
      <div class="side">
        <p class="label">Before</p>
        <div class="diff-before">
          {cut?.start ? <Ellipsis /> : null}
          <BlockText text={view.before} marks={marks && { parts: marks.before, tag: "del" }} />
          {cut?.endBefore ? <Ellipsis /> : null}
        </div>
      </div>
      <div class="side">
        <p class="label">After</p>
        <div class="diff-after">
          {cut?.start ? <Ellipsis /> : null}
          <BlockText text={view.after} marks={marks && { parts: marks.after, tag: "ins" }} />
          {cut?.endAfter ? <Ellipsis /> : null}
        </div>
      </div>
      {cut === null ? null : (
        <p class="diff-note">{`A long block (${view.block.before.length.toLocaleString("en-US")} characters before, ${view.block.after.length.toLocaleString("en-US")} after): only the part around the change is shown.`}</p>
      )}
      {sameWords ? <p class="diff-note">The words are the same; a link or the formatting changed.</p> : null}
      {marks === undefined ? <p class="diff-note">No word marks on this block: it is past what one screen marks.</p> : null}
    </div>
  );
}

/** An added or a removed block, whole, or its start with the rest said in words. */
function WholeBlock(props: { kind: "added" | "removed"; text: string }) {
  const start = blockStart(props.text);
  return (
    <div class={props.kind === "added" ? "diff-added" : "diff-removed"}>
      <span class="vh">{props.kind === "added" ? "Added: " : "Removed: "}</span>
      <BlockText text={start ?? props.text} />
      {start === null ? null : (
        <>
          <Ellipsis />
          <p class="bt-more">{`A long block: the first ${start.length.toLocaleString("en-US")} of its ${props.text.length.toLocaleString("en-US")} characters are shown.`}</p>
        </>
      )}
    </div>
  );
}

/**
 * Which blocks a screen shows: in page order, at most BLOCKS_PER_GROUP a group (not with all=1), and on the
 * whole screen at most SCREEN_BLOCKS blocks, SCREEN_CHARS characters of shown text or SCREEN_WORK of their
 * work (ALL_BLOCKS, ALL_CHARS and ALL_WORK with all=1), whichever comes first; the first block always shows.
 * A long block counts the part of it that is shown. Release notes keep one section a release, so the cap a
 * group alone would not bound a screen.
 */
function chooseBlocks(groups: Group[], all: boolean): { shown: Item[][]; views: Map<ChangedBlock, PairView>; count: number; fullAt: number } {
  const maxBlocks = all ? ALL_BLOCKS : SCREEN_BLOCKS;
  const maxChars = all ? ALL_CHARS : SCREEN_CHARS;
  const maxWork = all ? ALL_WORK : SCREEN_WORK;
  const views = new Map<ChangedBlock, PairView>();
  const shown: Item[][] = [];
  let count = 0;
  let chars = 0;
  let work = 0;
  let full = false;
  for (const group of groups) {
    const items: Item[] = [];
    for (const item of all ? group.items : group.items.slice(0, BLOCKS_PER_GROUP)) {
      let size: number;
      let cost: number;
      let view: PairView | null = null;
      if (item.kind === "changed") {
        view = pairView(item.block);
        size = view.before.length + view.after.length;
        cost = blockWork(view.before) + blockWork(view.after);
      } else {
        const text = blockStart(item.text) ?? item.text;
        size = text.length;
        cost = blockWork(text);
      }
      if (count > 0 && (count + 1 > maxBlocks || chars + size > maxChars || work + cost > maxWork)) {
        full = true;
        break;
      }
      if (view !== null && item.kind === "changed") views.set(item.block, view);
      items.push(item);
      count++;
      chars += size;
      work += cost;
    }
    shown.push(items);
    if (full) break;
  }
  return { shown, views, count, fullAt: full ? shown.length - 1 : -1 };
}

function Blocks(props: { blocks: StructuredDiff; places: SectionPlaces | null; all: boolean; allHref: string; json: string }) {
  const { blocks, all } = props;
  const groups = groupBlocks(blocks, props.places);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const { shown, views, count, fullAt } = chooseBlocks(groups, all);
  const marks = markPairs([...views.values()]);
  const changed = blocks.changed?.length ?? 0;
  const unmarked = views.size - marks.size;
  const hidden = total - count;
  return (
    <section class="diff" aria-labelledby="diff-h">
      <h2 id="diff-h">The text, block by block</h2>
      <p class="diff-count">{`${blocks.added?.length ?? 0} added · ${blocks.removed?.length ?? 0} removed · ${changed} changed`}</p>
      <p class="page-note">
        A block is a paragraph, a list or a table row of the page's cleaned text, shown under the heading it sits under. In a
        changed block, the words that went are struck through and the words that came are marked.
        {unmarked > 0 ? ` Word marks are shown on ${plural(marks.size, "changed block")} of the ${views.size} on this screen.` : ""}
      </p>
      {shown.map((items, g) => {
        const group = groups[g]!;
        if (items.length === 0) return null;
        return (
          <section class="diff-group" aria-labelledby={`sec-${g}`}>
            <h3 class="diff-section" id={`sec-${g}`}>
              {group.section === "" ? "Top of the page" : group.section}
            </h3>
            <div class="diff-blocks">
              {items.map((item) => {
                if (item.kind !== "changed") return <WholeBlock kind={item.kind} text={item.text} />;
                const view = views.get(item.block)!;
                return <ChangedPair view={view} marks={marks.get(view)} />;
              })}
            </div>
            {/* A group cut by its own cap links to all of it; the screen's own cut is said once, below. */}
            {!all && groups.length > 1 && g !== fullAt && items.length < group.items.length ? (
              <p class="more">
                <a class="btn secondary" href={`${props.allHref}#sec-${g}`}>{`Show all ${group.items.length}`}</a>
              </p>
            ) : null}
          </section>
        );
      })}
      {hidden === 0 ? null : all ? (
        <p class="diff-rest">
          {`${hidden === 1 ? "1 more block is" : `${hidden} more blocks are`} past what one page shows. `}
          <a href={props.json}>This diff as JSON</a> has every block.
        </p>
      ) : (
        <p class="diff-rest">
          {`${hidden === 1 ? "1 more block is" : `${hidden} more blocks are`} not shown here. `}
          <a class="btn secondary" href={`${props.allHref}#diff-h`}>{`Show all ${total}`}</a>
        </p>
      )}
    </section>
  );
}

// --- Facts ----------------------------------------------------------------------------------------

const FIELD_WORDS: Record<FactChange["field"], string> = { price: "price", unit: "unit", notes: "notes" };
const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
const priced = (f: { price: unknown; unit: unknown }): string =>
  [text(f.price), unitBeside(text(f.price), text(f.unit))].filter((s) => s !== "").join(" ");

/**
 * The prices that moved: changed fields, then added and removed facts. The new price of the first changed
 * price is the screen's one accent figure.
 */
function Facts(props: { facts: FactsDiff }) {
  const { facts } = props;
  const changed = facts.changed ?? [];
  const keyAt = changed.findIndex((c) => c.field === "price");
  const added = facts.added ?? [];
  const removed = facts.removed ?? [];
  if (changed.length + added.length + removed.length === 0) {
    return (
      <section class="facts-diff" aria-labelledby="facts-h">
        <h2 id="facts-h">Prices</h2>
        <p class="facts-note">The prices read from the two versions are the same.</p>
      </section>
    );
  }
  return (
    <section class="facts-diff" aria-labelledby="facts-h">
      <h2 id="facts-h">Prices</h2>
      <table class="table facts">
        <caption class="vh">Prices that changed between the two versions</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">What</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {changed.map((c, i) => (
            <tr>
              <th scope="row">{text(c.name)}</th>
              <td class="what">{FIELD_WORDS[c.field] ?? text(c.field)}</td>
              <td class={c.field === "price" ? "price was" : "was"}>{text(c.before)}</td>
              <td class={c.field !== "price" ? undefined : i === keyAt ? "price is-key" : "price"}>{text(c.after)}</td>
            </tr>
          ))}
          {added.map((f) => (
            <tr>
              <th scope="row">{text(f.name)}</th>
              <td class="what">added</td>
              <td class="none">
                <span class="vh">none</span>
              </td>
              <td class="price">{priced(f)}</td>
            </tr>
          ))}
          {removed.map((f) => (
            <tr>
              <th scope="row">{text(f.name)}</th>
              <td class="what">removed</td>
              <td class="price was">{priced(f)}</td>
              <td class="none">
                <span class="vh">none</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// --- The screen -------------------------------------------------------------------------------------

function Links(props: { pageHref: string; json?: string }) {
  return (
    <ul class="vlinks compare-links">
      {props.json === undefined ? null : (
        <li>
          <a href={props.json}>This diff as JSON</a>
        </li>
      )}
      <li>
        <a href={props.pageHref}>Back to the page</a>
      </li>
    </ul>
  );
}

/** A count from a stored diff, 0 when it is missing or not a number. */
const countOf = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

/**
 * A diff as the view reads it, with every part it uses present: a stored diff is JSON in the cache, written
 * by this code, but a row the view cannot read must cost a plainer screen, never a 500.
 */
function readable(d: Diff): Diff {
  const blocks: Partial<StructuredDiff> = d.blocks ?? {};
  return {
    ...d,
    summary: typeof d.summary === "string" ? d.summary : null,
    summary_source: d.summary_source === "tinyfish" || d.summary_source === "diff" ? d.summary_source : null,
    blocks: {
      added: Array.isArray(blocks.added) ? blocks.added : [],
      removed: Array.isArray(blocks.removed) ? blocks.removed : [],
      changed: Array.isArray(blocks.changed) ? blocks.changed : [],
    },
    facts: d.facts !== null && typeof d.facts === "object" ? d.facts : null,
    hops: countOf(d.hops),
    noise_suppressed_between: countOf(d.noise_suppressed_between),
  };
}

function DiffBody(props: { page: PageJson; pageHref: string; state: Extract<CompareState, { kind: "diff" }> }) {
  const { page, pageHref, state } = props;
  const { from, to, all } = state;
  const diff = readable(state.diff);
  const layoutOnly = to.delta?.layout_only === true;
  const gone = isGone(page.status);
  const origin = diff.summary_source === null ? null : SUMMARY_ORIGIN[diff.summary_source];
  const query = `from=${encodeURIComponent(from.id)}&to=${encodeURIComponent(to.id)}`;
  const json = `/api/pages/${encodeURIComponent(page.id)}/diff?from=${encodeURIComponent(from.captured_at)}&to=${encodeURIComponent(to.captured_at)}`;
  return (
    <>
      <p class="compare-span">
        From <time datetime={from.captured_at}>{formatUtc(from.captured_at)}</time> to{" "}
        <time datetime={to.captured_at}>{formatUtc(to.captured_at)}</time>
        {` · ${plural(diff.hops, "version")} apart · ${plural(diff.noise_suppressed_between, "noise event")} suppressed between`}
      </p>
      <div class="compare-lead">
        {layoutOnly ? (
          <p class="row">
            <span class="tag">Layout only</span>
          </p>
        ) : null}
        <p class={diff.summary === null ? "vcard-summary is-pending" : "vcard-summary"}>{diff.summary ?? "No summary yet."}</p>
        {layoutOnly ? <p class="layout-note">{LAYOUT_ONLY_LINE}</p> : null}
        {origin === null ? null : (
          <p class="origin">{diff.hops > 1 ? `${origin}, of the newest of these ${diff.hops} changes` : origin}</p>
        )}
      </div>
      {diff.facts === null ? null : <Facts facts={diff.facts} />}
      {diff.blocks.added.length + diff.blocks.removed.length + diff.blocks.changed.length === 0 ? (
        <section class="diff" aria-labelledby="diff-h">
          <h2 id="diff-h">The text, block by block</h2>
          <p class="facts-note">The cleaned text is the same in both versions.</p>
        </section>
      ) : (
        <Blocks blocks={diff.blocks} places={state.places} all={all} allHref={`${pageHref}/compare?${query}&all=1`} json={json} />
      )}
      <section class="compare-shots" aria-labelledby="shots-h">
        <h2 id="shots-h">The two screenshots</h2>
        <div class="shots">
          {[from, to].map((v) => (
            <ShotFigure v={v} pageLabel={page.label} liveUrl={page.url} gone={gone}>
              <EvidenceLine url={page.url} readAt={v.captured_at} trigger={v.trigger} />
            </ShotFigure>
          ))}
        </div>
      </section>
      <Links pageHref={pageHref} json={json} />
    </>
  );
}

export function CompareView(props: CompareProps) {
  const { stats, page, versions, state } = props;
  const pageHref = `/pages/${encodeURIComponent(page.id)}`;
  const jsonHref = `/api/pages/${encodeURIComponent(page.id)}`;
  const title = `${page.label}: what changed`;
  const description =
    state.kind === "diff"
      ? `What changed on ${page.label} between ${formatUtc(state.from.captured_at)} and ${formatUtc(state.to.captured_at)}, word by word, with both screenshots.`
      : `Compare two recorded versions of ${page.label}.`;
  return (
    <Layout title={`${title} · Fineprint`} description={description} stats={stats} current={null} link={props.link}>
      <div class="wrap compare">
        <header class="page-head compare-head">
          {/* The page's name is the way back to its history, from the top of a long comparison. */}
          <h1>
            <a href={pageHref}>{page.label}</a>: what changed
          </h1>
        </header>
        {state.kind === "diff" ? (
          <DiffBody page={page} pageHref={pageHref} state={state} />
        ) : state.kind === "same" ? (
          <>
            <p class="state-line">Pick two different versions.</p>
            <section class="pick-section" aria-labelledby="compare-h">
              <h2 id="compare-h" class="vh">
                Compare two versions
              </h2>
              <CompareForm action={`${pageHref}/compare`} versions={versions} {...pairAround(versions, state.at.id)} json={jsonHref} />
            </section>
            <Links pageHref={pageHref} />
          </>
        ) : (
          <>
            <p class="state-line">
              {versions.length === 1
                ? "There is nothing to compare yet: this page has one recorded version."
                : "There is nothing to compare yet: no version of this page is recorded yet."}
            </p>
            <Links pageHref={pageHref} />
          </>
        )}
        {state.kind === "diff" ? (
          <section class="pick-section" aria-labelledby="compare-h">
            <h2 id="compare-h">Compare two other versions</h2>
            <CompareForm action={`${pageHref}/compare`} versions={versions} fromId={state.from.id} toId={state.to.id} json={jsonHref} />
          </section>
        ) : null}
      </div>
    </Layout>
  );
}
