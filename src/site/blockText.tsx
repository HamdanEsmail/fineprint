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

const HEADING_RE = /^#{1,6}[ \t]+/;
const CLOSING_HASHES_RE = /[ \t]+#+[ \t]*$/;
const BULLET_RE = /^[ \t]*[*+-][ \t]+/;
const NUMBER_RE = /^[ \t]*(\d{1,9})[.)][ \t]+/;
const ROW_RE = /^[ \t]*\|.*\|[ \t]*$/;
// A table's rule row ("| --- | :-: |"), or a horizontal rule ("---"): no words in it.
const RULE_RE = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;

const MARKED_LINE_RE = /^[ \t]*[#|*+\-:\d]/;
// The characters that can start a mark: an escape, code, an image or a link, emphasis.
const SPECIAL_RE = /[\\`![*_]/g;

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!|<>~$\"'");
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * The end of a `[label](url)` starting at `open` (the "["): the label and the index after the ")", or null.
 * Brackets and parentheses may nest; a line break or an unclosed bracket ends the search.
 */
function linkAt(text: string, open: number): { label: string; end: number } | null {
  let depth = 0;
  let i = open;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "\n") return null;
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (i >= text.length || text[i + 1] !== "(") return null;
  const label = text.slice(open + 1, i);
  depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\n") return null;
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { label, end: j + 1 };
  }
  return null;
}

/** The inline text of one line as segments: emphasis and link marks gone, code spans kept apart. */
function inline(text: string): Seg[] {
  const segs: Seg[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf !== "") segs.push({ text: buf, code: false });
    buf = "";
  };
  const append = (more: Seg[]): void => {
    for (const s of more) {
      if (s.code) {
        flush();
        segs.push(s);
      } else buf += s.text;
    }
  };
  let i = 0;
  while (i < text.length) {
    // Plain characters are taken in one slice up to the next one that can start a mark.
    SPECIAL_RE.lastIndex = i;
    const next = SPECIAL_RE.exec(text);
    if (next === null) {
      buf += text.slice(i);
      break;
    }
    if (next.index > i) {
      buf += text.slice(i, next.index);
      i = next.index;
    }
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length && ESCAPABLE.has(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        flush();
        segs.push({ text: text.slice(i + 1, close), code: true });
        i = close + 1;
        continue;
      }
    }
    if (c === "!" && text[i + 1] === "[") {
      const link = linkAt(text, i + 1);
      if (link !== null) {
        const alt = inline(link.label)
          .map((s) => s.text)
          .join("")
          .trim();
        buf += alt === "" ? "[image]" : `[image: ${alt}]`;
        i = link.end;
        continue;
      }
    }
    if (c === "[") {
      const link = linkAt(text, i);
      if (link !== null) {
        append(inline(link.label));
        i = link.end;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      let end = i;
      while (end < text.length && text[end] === c) end++;
      const run = end - i;
      const before = text[i - 1];
      const after = text[end];
      // A mark opens or closes a stretch: whitespace (or the line's end) on exactly one side, or punctuation
      // beside it. Between two spaces it is a lone star; between two letters it is part of a word.
      const flanking = isSpace(before) !== isSpace(after) || (!isSpace(before) && !isSpace(after) && (!isWordChar(before) || !isWordChar(after)));
      if (run <= 3 && flanking) {
        i = end;
        continue;
      }
      buf += text.slice(i, end);
      i = end;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return segs;
}

// A block is parsed once for its plain text (the word marks) and again to be drawn; the last few parses are
// kept, keyed by the text itself. Cleared whole when it fills, so it never grows past a screen's blocks.
const PARSED = new Map<string, Line[]>();
const PARSED_MAX = 128;

function parseBlock(text: string): Line[] {
  let lines = PARSED.get(text);
  if (lines === undefined) {
    if (PARSED.size >= PARSED_MAX) PARSED.clear();
    lines = parseLines(text);
    PARSED.set(text, lines);
  }
  return lines;
}

/** A block's lines, each with its kind and its inline segments; rule rows are dropped. */
function parseLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Only a line that starts (after spaces) with one of # | - * + : or a digit can be anything but text.
    if (!MARKED_LINE_RE.test(raw)) {
      lines.push({ kind: "text", segs: inline(raw.trim()) });
      continue;
    }
    if (RULE_RE.test(raw)) continue;
    const heading = HEADING_RE.exec(raw);
    if (heading) {
      const level = heading[0].trim().length;
      lines.push({ kind: "heading", level, segs: inline(raw.slice(heading[0].length).replace(CLOSING_HASHES_RE, "")) });
      continue;
    }
    if (ROW_RE.test(raw)) {
      lines.push({ kind: "row", segs: inline(raw.trim()) });
      continue;
    }
    const number = NUMBER_RE.exec(raw);
    if (number) {
      lines.push({ kind: "number", n: Number(number[1]), segs: inline(raw.slice(number[0].length)) });
      continue;
    }
    const bullet = BULLET_RE.exec(raw);
    if (bullet) {
      lines.push({ kind: "bullet", segs: inline(raw.slice(bullet[0].length)) });
      continue;
    }
    lines.push({ kind: "text", segs: inline(raw.trim()) });
  }
  return lines;
}

const lineText = (line: Line): string => line.segs.map((s) => s.text).join("");

/**
 * A block as plain text: its lines without their marks, joined by line breaks. Word marks for a changed
 * block are taken over this text (wordDiff), and BlockText lays them back on the block's lines.
 */
export function plainText(text: string): string {
  return parseBlock(text).map(lineText).join("\n");
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
  const lines = parseBlock(props.text);
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
