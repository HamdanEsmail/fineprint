// Compare view (GET /pages/:id/compare?from=<version id>&to=<version id>, all=1): what changed between two
// versions of one page. It leads with the change itself: the span and the summary, the prices that moved,
// then the blocks of cleaned text under the page's own section headings (in each, the changed blocks, then
// the added, then the removed), the two screenshots with their evidence lines, and the links out. The diff
// is the JSON API's (src/readModel.ts diffVersions, from the same cache); nothing here reads the database.
//
// Cost: blocks are capped per section group (BLOCKS_PER_GROUP, all=1 lifts it); a block over
// LONG_BLOCK_CHARS is shown in part (around the change, or from its start); and word marks, the part that
// grows fastest with the text, are capped by pairs and by characters (WORD_DIFF_PAIRS, WORD_DIFF_CHARS) with
// a shared step budget. Measured in Node on the 6 Nov texts: 0.2 to 2.5 ms to render, the stored diff parsed.
import type { ChangedBlock, FactChange, FactsDiff, StructuredDiff } from "../../core/diff";
import type { Diff, PageJson, Stats, VersionItem } from "../../readModel";
import { BlockText, plainText } from "../blockText";
import { CompareForm, EvidenceLine, LAYOUT_ONLY_LINE, ShotFigure } from "../components";
import { formatUtc, plural, SUMMARY_ORIGIN } from "../format";
import { Layout } from "../layout";
import { hasMarks, wordDiff, type WordDiff, type WordDiffBudget } from "../wordDiff";

/** Blocks shown per section group before "Show all". */
export const BLOCKS_PER_GROUP = 30;
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
  /** Two different versions: the diff between them, `from` the older. */
  | { kind: "diff"; from: VersionItem; to: VersionItem; diff: Diff; all: boolean }
  /** The same version on both sides. */
  | { kind: "same"; at: VersionItem }
  /** A page with one version, or none. */
  | { kind: "single" };

export type CompareProps = {
  stats: Stats;
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
 * The diff's blocks under their section headings: one group per section, in the order a section first
 * appears among the changed, then the added, then the removed blocks; inside a group, changed blocks
 * first, then added, then removed, each in the diff's own order.
 */
function groupBlocks(blocks: StructuredDiff): Group[] {
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
  // Inside a group the kinds already come in order, because they were added kind by kind.
  return [...groups.values()];
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

/** Word marks for the changed pairs on screen, in screen order, within the pair, character and step budgets. */
function markPairs(shown: PairView[]): Map<PairView, WordDiff> {
  const marks = new Map<PairView, WordDiff>();
  const budget: WordDiffBudget = { steps: WORD_DIFF_STEPS };
  let chars = 0;
  for (const view of shown) {
    if (marks.size >= WORD_DIFF_PAIRS) break;
    const before = plainText(view.before);
    const after = plainText(view.after);
    if (chars + before.length + after.length > WORD_DIFF_CHARS) continue;
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

function Blocks(props: { blocks: StructuredDiff; all: boolean; allHref: string }) {
  const { blocks, all } = props;
  const groups = groupBlocks(blocks);
  const shown = groups.map((g) => (all ? g.items : g.items.slice(0, BLOCKS_PER_GROUP)));
  const views = new Map<ChangedBlock, PairView>();
  for (const item of shown.flat()) if (item.kind === "changed") views.set(item.block, pairView(item.block));
  const marks = markPairs([...views.values()]);
  const changed = blocks.changed?.length ?? 0;
  const unmarked = views.size - marks.size;
  return (
    <section class="diff" aria-labelledby="diff-h">
      <h2 id="diff-h">The text, block by block</h2>
      <p class="diff-count">{`${blocks.added?.length ?? 0} added · ${blocks.removed?.length ?? 0} removed · ${changed} changed`}</p>
      <p class="page-note">
        A block is a paragraph, a list or a table row of the page's cleaned text, shown under the heading it sits under. In a
        changed block, the words that went are struck through and the words that came are marked.
        {unmarked > 0 ? ` Word marks are shown for the first ${plural(marks.size, "changed block")} on this screen.` : ""}
      </p>
      {groups.map((group, g) => {
        const items = shown[g]!;
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
            {items.length < group.items.length ? (
              <p class="more">
                <a class="btn secondary" href={`${props.allHref}#sec-${g}`}>{`Show all ${group.items.length}`}</a>
              </p>
            ) : null}
          </section>
        );
      })}
    </section>
  );
}

// --- Facts ----------------------------------------------------------------------------------------

const FIELD_WORDS: Record<FactChange["field"], string> = { price: "price", unit: "unit", notes: "notes" };
const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
const priced = (f: { price: unknown; unit: unknown }): string => [text(f.price), text(f.unit)].filter((s) => s !== "").join(" ");

/** The prices that moved: changed fields (the new price is the screen's one accent figure), then added and removed facts. */
function Facts(props: { facts: FactsDiff }) {
  const { facts } = props;
  const changed = facts.changed ?? [];
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
          {changed.map((c) => (
            <tr>
              <th scope="row">{text(c.name)}</th>
              <td class="what">{FIELD_WORDS[c.field] ?? text(c.field)}</td>
              <td class={c.field === "price" ? "price was" : "was"}>{text(c.before)}</td>
              <td class={c.field === "price" ? "price is-key" : undefined}>{text(c.after)}</td>
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

function DiffBody(props: { page: PageJson; pageHref: string; state: Extract<CompareState, { kind: "diff" }> }) {
  const { page, pageHref, state } = props;
  const { from, to, diff, all } = state;
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
      {(diff.blocks.added?.length ?? 0) + (diff.blocks.removed?.length ?? 0) + (diff.blocks.changed?.length ?? 0) === 0 ? (
        <section class="diff" aria-labelledby="diff-h">
          <h2 id="diff-h">The text, block by block</h2>
          <p class="facts-note">The cleaned text is the same in both versions.</p>
        </section>
      ) : (
        <Blocks blocks={diff.blocks} all={all} allHref={`${pageHref}/compare?${query}&all=1`} />
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
  const title = `${page.label}: what changed`;
  const description =
    state.kind === "diff"
      ? `What changed on ${page.label} between ${formatUtc(state.from.captured_at)} and ${formatUtc(state.to.captured_at)}, word by word, with both screenshots.`
      : `Compare two recorded versions of ${page.label}.`;
  return (
    <Layout title={`${title} · Fineprint`} description={description} stats={stats} current={null}>
      <div class="wrap compare">
        <header class="page-head compare-head">
          <h1>{title}</h1>
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
              <CompareForm action={`${pageHref}/compare`} versions={versions} {...pairAround(versions, state.at.id)} />
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
            <CompareForm action={`${pageHref}/compare`} versions={versions} fromId={state.from.id} toId={state.to.id} />
          </section>
        ) : null}
      </div>
    </Layout>
  );
}
