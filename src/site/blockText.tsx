// One recorded markdown block as safe, readable HTML (the compare view and the home's featured catch). A
// block is text a watched page served, so nothing in it may become a tag or an attribute: it is read here
// into lines of plain text segments, and every segment reaches the page as a JSX text child, which hono/jsx
// escapes. The only elements are the fixed ones below, the only attributes fixed classes and an ordered
// list's start number, parsed as digits.
//
// What is kept and what is dropped: heading marks (# to ######) go and the line is set as a heading; list
// marks (*, -, +, 1.) become list items; [label](url) keeps the label only (the url is never shown, so a
// `javascript:` target cannot even be read); ![alt](src) becomes "[image: alt]"; the emphasis marks **, __,
// * and _ go where they open or close a stretch (an underscore inside a word stays); `code` keeps its text
// in the mono face; a table row stays one mono line, and a table's rule row (| --- |) is dropped. A
// backslash escape keeps the character it escapes.
import type { Part } from "./wordDiff";

type Seg = { text: string; code: boolean };

type Line =
  | { kind: "heading"; level: number; segs: Seg[] }
  | { kind: "bullet"; segs: Seg[] }
  | { kind: "number"; n: number; segs: Seg[] }
  | { kind: "row"; segs: Seg[] }
  | { kind: "text"; segs: Seg[] };

// Every step below is linear in the line, whatever the line holds: a block is text from any page, a public
// page included, and one line of 25,000 "[" must cost no more than 25,000 letters. No regex here can
// backtrack (each is anchored on a trimmed line, or a single character class), brackets and code spans are
// matched once per line, and links are walked without recursion.

/** On a trimmed line: a heading's marks and the space after them. */
const HEADING_RE = /^(#{1,6})[ \t]+/;
const NUMBER_RE = /^(\d{1,9})[.)][ \t]+/;
const BULLET_RE = /^[*+-][ \t]+/;
/** A table's rule row ("|:--|--:|") or a horizontal rule ("---") holds nothing but these. */
const RULE_CHARS_RE = /^[|:\- \t]+$/;
// The characters that can start a mark by themselves: an escape, code, emphasis. A link or an image starts
// only where matchLine found one, so a "[" or a "!" that starts nothing is plain text, taken in a slice.
const SPECIAL_RE = /[\\`*_]/g;
// What an image's alt text drops.
const ALT_MARKS_RE = /[\\`*_[\]]/g;

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!|<>~$\"'");
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * One pass over a line: for each "[" and "(", the index of the "]" or ")" that closes it (-1 when none),
 * with a stack each, escaped characters skipped; the places where a link or an image can start (a "[" whose
 * "]" is followed by a "(" that closes; the "!" before it too), in order; and for each "`", the next "`"
 * after it. Finding a link or a code span is then a lookup.
 */
type Matches = { close: Int32Array | null; starts: number[]; tick: Int32Array | null };

function matchLine(text: string): Matches {
  const n = text.length;
  let close: Int32Array | null = null;
  const starts: number[] = [];
  if (text.includes("[")) {
    close = new Int32Array(n).fill(-1);
    const brackets: number[] = [];
    const parens: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 92 /* \ */) {
        if (i + 1 < n && ESCAPABLE.has(text[i + 1]!)) i++;
      } else if (c === 91 /* [ */) brackets.push(i);
      else if (c === 93 /* ] */) {
        const open = brackets.pop();
        if (open !== undefined) close[open] = i;
      } else if (c === 40 /* ( */) parens.push(i);
      else if (c === 41 /* ) */) {
        const open = parens.pop();
        if (open !== undefined) close[open] = i;
      }
    }
    for (let i = 0; i < n; i++) {
      if (text.charCodeAt(i) !== 91) continue;
      const label = close[i]!;
      if (label < 0 || text.charCodeAt(label + 1) !== 40 || close[label + 1]! < 0) continue;
      if (i > 0 && text.charCodeAt(i - 1) === 33 /* ! */) starts.push(i - 1);
      starts.push(i);
    }
  }
  let tick: Int32Array | null = null;
  if (text.includes("`")) {
    tick = new Int32Array(n).fill(-1);
    let next = -1;
    for (let i = n - 1; i >= 0; i--) {
      tick[i] = next;
      if (text.charCodeAt(i) === 96 /* ` */) next = i;
    }
  }
  return { close, starts, tick };
}

/** A `[label](target)` whose "[" is at `open` and which closes before `bound`: where its label is and where it ends. */
function linkAt(text: string, m: Matches, open: number, bound: number): { from: number; to: number; end: number } | null {
  if (m.close === null || text.charCodeAt(open) !== 91) return null;
  const label = m.close[open]!;
  if (label < 0 || label + 1 >= bound || text.charCodeAt(label + 1) !== 40 /* ( */) return null;
  const target = m.close[label + 1]!;
  return target < 0 || target >= bound ? null : { from: open + 1, to: label, end: target + 1 };
}

/**
 * The inline text of one line as segments: emphasis and link marks gone, code spans kept apart. A link's
 * label is walked where it stands and its target skipped when the walk reaches the label's end: a stack of
 * open labels instead of recursion, so any depth of nesting costs the same as none, and no target is ever
 * read, at any depth. The cursor only moves forward; the next character that can start a mark is looked
 * for once from it, and the link starts are a list it moves along, so the walk is one pass, and the text
 * between marks (a "[" that opens nothing included) is taken in slices.
 */
function inlineSegs(text: string, work: { n: number }): Seg[] {
  const m = matchLine(text);
  const segs: Seg[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf !== "") segs.push({ text: buf, code: false });
    buf = "";
  };
  const open: { to: number; end: number }[] = [];
  let bound = text.length;
  let nextSpecial = -1;
  let nextStart = 0; // index into m.starts
  let i = 0;
  for (;; work.n++) {
    if (i >= bound) {
      const label = open.pop();
      if (label === undefined) break;
      i = label.end;
      bound = open.length > 0 ? open[open.length - 1]!.to : text.length;
      continue;
    }
    if (nextSpecial < i) {
      SPECIAL_RE.lastIndex = i;
      nextSpecial = SPECIAL_RE.exec(text)?.index ?? text.length;
    }
    while (nextStart < m.starts.length && m.starts[nextStart]! < i) nextStart++;
    const start = nextStart < m.starts.length ? m.starts[nextStart]! : text.length;
    const at = Math.min(nextSpecial, start, bound);
    if (at > i) {
      buf += text.slice(i, at);
      i = at;
      continue;
    }
    const c = text[i]!;
    if (i === start) {
      // An image, "![alt](src)": its alt text in words.
      if (c === "!") {
        const image = linkAt(text, m, i + 1, bound);
        if (image !== null) {
          const alt = text.slice(image.from, image.to).replace(ALT_MARKS_RE, "").trim();
          buf += alt === "" ? "[image]" : `[image: ${alt}]`;
          i = image.end;
          continue;
        }
      } else {
        // A link: its label is walked, its target skipped.
        const link = linkAt(text, m, i, bound);
        if (link !== null) {
          open.push({ to: link.to, end: link.end });
          bound = link.to;
          i = link.from;
          continue;
        }
      }
      // It does not close inside the label the walk is in: plain text.
      buf += c;
      i++;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < bound && ESCAPABLE.has(text[i + 1]!)) {
        buf += text[i + 1];
        i += 2;
      } else {
        buf += c;
        i++;
      }
      continue;
    }
    if (c === "`") {
      const close = m.tick?.[i] ?? -1;
      if (close > i + 1 && close < bound) {
        flush();
        segs.push({ text: text.slice(i + 1, close), code: true });
        i = close + 1;
        continue;
      }
      // Not a span: this backtick, and the ones right after it that open nothing either, as text.
      let end = i + 1;
      while (end < bound && text.charCodeAt(end) === 96 && m.tick![end] === end + 1) end++;
      buf += text.slice(i, end);
      i = end;
      continue;
    }
    // "*" or "_": a run of marks, taken one same-character run at a time. A run opens or closes a stretch,
    // and goes, when it has whitespace (or the line's end) on exactly one side, or punctuation beside it;
    // between two spaces it is a lone star and between two letters part of a word, and it stays.
    let j = i;
    while (j < bound && (text[j] === "*" || text[j] === "_")) {
      const mark = text[j];
      let end = j;
      while (end < bound && text[end] === mark) end++;
      const before = text[j - 1];
      const after = text[end];
      const flanking = isSpace(before) !== isSpace(after) || (!isSpace(before) && !isSpace(after) && (!isWordChar(before) || !isWordChar(after)));
      if (!(end - j <= 3 && flanking)) buf += text.slice(j, end);
      j = end;
    }
    i = j;
  }
  flush();
  return segs;
}

/** A heading's text without its closing run of "#" (one preceded by a space, or the whole text), scanned from the end. */
function withoutClosingHashes(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === " " || s[end - 1] === "\t")) end--;
  let hashes = end;
  while (hashes > 0 && s[hashes - 1] === "#") hashes--;
  if (hashes < end && (hashes === 0 || s[hashes - 1] === " " || s[hashes - 1] === "\t")) end = hashes;
  return s.slice(0, end).trimEnd();
}

/** A block's lines, and the work they cost: one a line, and one for each stop the inline walk makes. */
type Parsed = { lines: Line[]; work: number };

// A block is parsed to be weighed (blockWork), for its plain text (the word marks) and to be drawn; the parses
// are kept, keyed by the text itself, so each is done once. Room for every block of the largest screen (the
// compare view's 400 with all=1, a changed pair being two texts, and at most ALL_CHARS of them) and then some.
// The memory is bounded by the characters kept as well as by the count, since the parse of a block holds about
// as much again as its text: when either would run over, the oldest parses go first. A text longer than the
// whole character bound is parsed each time and not kept.
const PARSED = new Map<string, Parsed>();
export const PARSED_MAX = 1000;
export const PARSED_MAX_CHARS = 1_000_000;
let parsedChars = 0;

function parseBlock(text: string): Parsed {
  const kept = PARSED.get(text);
  if (kept !== undefined) return kept;
  const parsed = parseLines(text);
  if (text.length > PARSED_MAX_CHARS) return parsed;
  // Oldest first: a Map keeps its keys in the order they were set.
  for (const old of PARSED.keys()) {
    if (PARSED.size < PARSED_MAX && parsedChars + text.length <= PARSED_MAX_CHARS) break;
    PARSED.delete(old);
    parsedChars -= old.length;
  }
  PARSED.set(text, parsed);
  parsedChars += text.length;
  return parsed;
}

/** The parse cache's size, for the tests: the parses kept, their texts' characters, and the oldest text. */
export function parseCacheState(): { entries: number; chars: number; oldest: string | undefined } {
  return { entries: PARSED.size, chars: parsedChars, oldest: PARSED.keys().next().value };
}

/**
 * What a block costs to read and draw, in steps: one a line, and one for each stop the inline walk makes (a
 * run of plain text, an emphasis mark, a code span, a link, an escape). A paragraph of prose is a few steps
 * a line; a line of `a` `b` `c` code spans or *a* *b* emphasis is one or two steps a word, each a mark to
 * read and often an element to draw. The compare view counts it against a screen's budget, beside the
 * characters, so a screen of element-dense blocks costs no more than a screen of prose.
 */
export function blockWork(text: string): number {
  return parseBlock(text).work;
}

/** Whether a trimmed line's first character can start anything but text: # | * + - : or a digit. */
const mayBeMarked = (c: number): boolean => c === 35 || c === 124 || c === 42 || c === 43 || c === 45 || c === 58 || (c >= 48 && c <= 57);

/** A block's lines, each with its kind and its inline segments (rule rows are dropped), and their work. */
function parseLines(text: string): Parsed {
  const lines: Line[] = [];
  const work = { n: 0 };
  const inline = (line: string): Seg[] => inlineSegs(line, work);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!mayBeMarked(line.charCodeAt(0))) {
      lines.push({ kind: "text", segs: inline(line) });
      continue;
    }
    if (RULE_CHARS_RE.test(line) && line.includes("-") && (line.includes("|") || line.includes("---"))) continue;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      lines.push({ kind: "heading", level: heading[1]!.length, segs: inline(withoutClosingHashes(line.slice(heading[0].length))) });
      continue;
    }
    if (line.length > 1 && line.startsWith("|") && line.endsWith("|")) {
      lines.push({ kind: "row", segs: inline(line) });
      continue;
    }
    const number = NUMBER_RE.exec(line);
    if (number) {
      lines.push({ kind: "number", n: Number(number[1]), segs: inline(line.slice(number[0].length)) });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      lines.push({ kind: "bullet", segs: inline(line.slice(bullet[0].length)) });
      continue;
    }
    lines.push({ kind: "text", segs: inline(line) });
  }
  return { lines, work: work.n + lines.length };
}

const lineText = (line: Line): string => line.segs.map((s) => s.text).join("");

/**
 * A block as plain text: its lines without their marks, joined by line breaks. Word marks for a changed
 * block are taken over this text (wordDiff), and BlockText lays them back on the block's lines.
 */
export function plainText(text: string): string {
  return parseBlock(text).lines.map(lineText).join("\n");
}

type Piece = { text: string; code: boolean; mark: boolean };

/** Each line's segments cut where a mark starts or ends; null when the parts do not spell the block's plain text. */
function markLines(lines: Line[], parts: Part[]): Piece[][] | null {
  if (parts.map((p) => p.text).join("") !== lines.map(lineText).join("\n")) return null;
  const out: Piece[][] = [];
  let pi = 0;
  let partStart = 0;
  let offset = 0;
  for (const line of lines) {
    const pieces: Piece[] = [];
    for (const seg of line.segs) {
      let s = 0;
      while (s < seg.text.length) {
        while (partStart + parts[pi]!.text.length <= offset + s) partStart += parts[pi++]!.text.length;
        const part = parts[pi]!;
        const take = Math.min(seg.text.length - s, partStart + part.text.length - (offset + s));
        const last = pieces[pieces.length - 1];
        const text = seg.text.slice(s, s + take);
        if (last !== undefined && last.code === seg.code && last.mark === part.mark) last.text += text;
        else pieces.push({ text, code: seg.code, mark: part.mark });
        s += take;
      }
      offset += seg.text.length;
    }
    out.push(pieces);
    offset += 1; // the line break
  }
  return out;
}

function Inline(props: { pieces: Piece[]; tag: "del" | "ins" }) {
  return (
    <>
      {props.pieces.map((p) => {
        const text = p.code ? <code>{p.text}</code> : p.text;
        if (!p.mark) return text;
        return props.tag === "del" ? <del>{text}</del> : <ins>{text}</ins>;
      })}
    </>
  );
}

/**
 * One recorded block, safely. With `marks` (wordDiff's parts for this block's plainText), the words that
 * went or came are wrapped in `<del>` or `<ins>`; parts that do not spell this block are ignored.
 */
export function BlockText(props: { text: string; marks?: { parts: Part[]; tag: "del" | "ins" } }) {
  const { lines } = parseBlock(props.text);
  const tag = props.marks?.tag ?? "ins";
  const marked = props.marks === undefined ? null : markLines(lines, props.marks.parts);
  const pieces = (i: number): Piece[] => marked?.[i] ?? lines[i]!.segs.map((s) => ({ ...s, mark: false }));

  const out = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (line.kind === "bullet" || line.kind === "number") {
      const kind = line.kind;
      const items = [];
      for (; i < lines.length && lines[i]!.kind === kind; i++) {
        items.push(
          <li>
            <Inline pieces={pieces(i)} tag={tag} />
          </li>,
        );
      }
      out.push(
        kind === "bullet" ? (
          <ul class="bt-list">{items}</ul>
        ) : (
          <ol class="bt-list" start={line.kind === "number" && line.n !== 1 ? line.n : undefined}>
            {items}
          </ol>
        ),
      );
      continue;
    }
    if (line.kind === "heading") {
      out.push(
        <p class={`bt-h bt-h${line.level}`}>
          <Inline pieces={pieces(i)} tag={tag} />
        </p>,
      );
      i++;
      continue;
    }
    if (line.kind === "row") {
      const rows = [];
      for (; i < lines.length && lines[i]!.kind === "row"; i++) {
        rows.push(
          <span class="bt-row">
            <Inline pieces={pieces(i)} tag={tag} />
          </span>,
        );
      }
      out.push(<p class="bt-table">{rows}</p>);
      continue;
    }
    const text = [];
    for (; i < lines.length && lines[i]!.kind === "text"; i++) {
      if (text.length > 0) text.push(<br />);
      text.push(<Inline pieces={pieces(i)} tag={tag} />);
    }
    out.push(<p class="bt-p">{text}</p>);
  }
  return <>{out}</>;
}
