// The normalization gate (spec 4.3). TinyFish Monitor says a page "changed"
// whenever its extracted markdown differs; this module decides whether the
// difference is real. It reduces a page's text to what the page is about:
// tracking parameters, "last updated" stamps, cookie banners and counters are
// removed, everything else (every price, limit, fee and content date) is kept.
// Two texts that normalize to the same string are the same version.
//
// It runs inside a Worker on the free plan (10 ms CPU) on texts up to ~100 KB,
// so: regexes are compiled once at module level, the text is processed line by
// line, and no pattern here can backtrack badly (quantifiers are anchored or
// bounded). Page-supplied ignore patterns are the one exception we cannot
// control; they are admin-edited.

export type Normalized = {
  /** The normalized text: one line per surviving line, single blank lines between blocks. */
  text: string;
  /**
   * What was removed, in text order: each dropped line as its trimmed original
   * text, each stripped tracking parameter as `key=value`. The webhook handler
   * stores this as the run's `noise_reason`.
   */
  suppressed: string[];
};

// --- Tracking query parameters ---------------------------------------------

const TRACKING_KEYS = new Set(["gclid", "fbclid", "ref", "_ga", "mc_cid", "mc_eid", "igshid"]);

function isTrackingKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || TRACKING_KEYS.has(k);
}

// An http(s) URL: runs until whitespace, an angle bracket, a quote or an
// unbalanced bracket, so it stops before the ")" that closes a markdown link
// but keeps a balanced "(bar)" in a path. The two alternatives cannot both
// start at the same character, so there is no ambiguity to backtrack over.
const URL_RE = /https?:\/\/(?:[^\s<>"'`()[\]]|\([^\s<>"'`()]*\))+/gi;
// Sentence punctuation or emphasis that follows a URL but is not part of it.
const URL_TRAILING = ".,;:!?*";

function stripTrackingParams(url: string, removed: string[]): string {
  let end = url.length;
  while (end > 0 && URL_TRAILING.includes(url[end - 1]!)) end--;
  const trailing = url.slice(end);
  const core = url.slice(0, end);

  const hashAt = core.indexOf("#");
  const beforeFragment = hashAt === -1 ? core : core.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : core.slice(hashAt);
  const queryAt = beforeFragment.indexOf("?");
  if (queryAt === -1) return url;

  const base = beforeFragment.slice(0, queryAt);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const param of beforeFragment.slice(queryAt + 1).split("&")) {
    const eq = param.indexOf("=");
    (isTrackingKey(eq === -1 ? param : param.slice(0, eq)) ? dropped : kept).push(param);
  }
  if (dropped.length === 0) return url;

  removed.push(...dropped);
  // Rebuilt from the original pieces, never through new URL(), so nothing else
  // in the link is re-encoded.
  return base + (kept.length > 0 ? `?${kept.join("&")}` : "") + fragment + trailing;
}

// --- Metadata lines ---------------------------------------------------------

// Markdown that may sit in front of a line's text: headings, quotes, bullets,
// emphasis, table pipes, code ticks.
const LEADING_MARKUP = /^[\s#*_>\-+|~`]+/;

// "Last updated", "Updated on", "Updated:", "Published", "Effective date",
// "Page generated" and "As of", case-insensitive, at line start.
const META_MARKER = /^(?:(?:last updated|updated on|published|effective date|page generated|as of)(?![\p{L}\d])|updated:)/iu;

// A line that merely says when the page was touched. The scope rule (spec 4.3):
// the marker alone is not enough, what follows it must be a date or time stamp
// (optionally "by <name>"). "As of 1 December 2026 the checked bag fee is $35"
// is content and stays.
function isMetadataLine(body: string): boolean {
  const marker = META_MARKER.exec(body);
  return marker !== null && isStampWithOptionalAuthor(body.slice(marker[0].length));
}

const MONTH = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
const WEEKDAY = /^(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i;
const YEAR = /^\d{4}$/;
const DAY = /^\d{1,2}(?:st|nd|rd|th)?$/i;
const NUMERIC_DATE = /^(?:\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|\d{4}[/.-]\d{1,2}|\d{1,2}[/.-]\d{4})$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const CLOCK = /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[ap]\.?m\.?)?$/i;
const HOUR_AMPM = /^\d{1,2}[ap]\.?m\.?$/i;
const AMPM = /^[ap]\.?m\.?$/i;
const TIME_ZONE = /^(?:utc|gmt|z|est|edt|cst|cdt|mst|mdt|pst|pdt|cet|cest|bst|ist|gst|aest|aedt|jst|sgt|hkt|eet|eest|msk)(?:[+-]\d{1,2}(?::?\d{2})?)?$/i;
const UTC_OFFSET = /^[+-]\d{2}(?::?\d{2})?$/;
const FILLER = /^(?:on|at|of|the)$/i;
const RELATIVE_DAY = /^(?:today|yesterday)$/i;
const AUTHOR_WORD = /^\p{L}[\p{L}.'’-]*$/u;

// A stamp is never long; the cap also bounds the work on a hostile line.
const MAX_STAMP_LENGTH = 120;
const MAX_AUTHOR_WORDS = 4;

function isStampWithOptionalAuthor(rest: string): boolean {
  let s = rest.replace(/^[\s:*_|\-–—([]+/, "");
  if (s.length === 0 || s.length > MAX_STAMP_LENGTH) return false;
  s = s.replace(/[\s*_.;:,|\-–—)\]]+$/, "");

  const byAt = s.search(/\sby\s/i);
  if (byAt !== -1) {
    const author = s.slice(byAt).trim().slice(2).trim().split(" ");
    if (author.length === 0 || author.length > MAX_AUTHOR_WORDS || !author.every((w) => AUTHOR_WORD.test(w))) return false;
    s = s.slice(0, byAt);
  }
  return isDateStamp(s);
}

// Every token must belong to a date or time, and at least one must be a real
// date or time part (a month, a year, a numeric date, a clock time, "today").
// A bare day number is not enough: "Published 12 new plans" is not a stamp.
function isDateStamp(stamp: string): boolean {
  let hasDatePart = false;
  for (const raw of stamp.split(/[\s,]+/)) {
    const token = raw.replace(/^[([]+|[)\].;]+$/g, "");
    if (token === "") continue;
    if (
      MONTH.test(token) ||
      YEAR.test(token) ||
      NUMERIC_DATE.test(token) ||
      ISO_DATETIME.test(token) ||
      CLOCK.test(token) ||
      HOUR_AMPM.test(token) ||
      RELATIVE_DAY.test(token)
    ) {
      hasDatePart = true;
    } else if (!(WEEKDAY.test(token) || DAY.test(token) || AMPM.test(token) || TIME_ZONE.test(token) || UTC_OFFSET.test(token) || FILLER.test(token))) {
      return false;
    }
  }
  return hasDatePart;
}

// --- Other whole-line rules -------------------------------------------------

// "(c)" and "©" lines are footers. "copyright" must be a whole word, so
// "Copyrighted material..." stays.
const COPYRIGHT = /^(?:©|copyright(?![\p{L}\d]))/iu;
const RELATIVE_TIME = /\b\d+ (?:seconds?|minutes?|hours?|days?) ago\b/i;

// Cookie banners and navigation shortcuts: the phrase anywhere in the line.
const BANNER_PHRASE = /skip to content|we use cookies|accept all cookies|cookie settings/i;
// "23 people viewing", "1,204 others are viewing". The digit run is bounded so a
// long run of digits and commas cannot make the scan quadratic.
const VIEWER_COUNTER = /\b\d[\d,]{0,11} (?:people|others)(?: are)? viewing\b/i;
// A line that is only "1.2k shares" / "12 Shares". "Revenue share" stays.
const SHARE_COUNTER = /^\d[\d,]*(?:\.\d+)?[km]? shares?$/i;

function isNoiseLine(line: string, body: string, ignore: readonly RegExp[]): boolean {
  if (isMetadataLine(body)) return true;
  if (COPYRIGHT.test(body)) return true;
  if (RELATIVE_TIME.test(line)) return true;
  if (BANNER_PHRASE.test(line) || VIEWER_COUNTER.test(line)) return true;
  if (SHARE_COUNTER.test(body.replace(/[*_`]/g, ""))) return true;
  return ignore.some((re) => re.test(line));
}

// --- Page ignore patterns ---------------------------------------------------

// Invalid regex is skipped, never thrown. So are patterns that match an empty
// string ("", "x*", "(?:)"): they would match every line and wipe the page.
function compileIgnorePatterns(patterns: readonly unknown[]): RegExp[] {
  const compiled: RegExp[] = [];
  if (!Array.isArray(patterns)) return compiled;
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.trim() === "") continue;
    try {
      const re = new RegExp(pattern, "i");
      if (!re.test("")) compiled.push(re);
    } catch {
      // not a valid regex: ignored
    }
  }
  return compiled;
}

// --- Entry points -----------------------------------------------------------

/**
 * Normalize a page's text. Rules, in order (spec 4.3): collapse whitespace and
 * blank-line runs; strip tracking query parameters from links; drop metadata
 * lines, copyright lines, relative-time lines, built-in noise lines and lines
 * matching `ignorePatterns` (case-insensitive regexes). Numbers, prices and
 * content dates are never touched.
 */
export function normalize(text: string, ignorePatterns: string[] = []): Normalized {
  const ignore = compileIgnorePatterns(ignorePatterns);
  const suppressed: string[] = [];
  const out: string[] = [];
  let blankPending = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const original = rawLine.trim();
    if (original === "") {
      blankPending = out.length > 0;
      continue;
    }

    const removedParams: string[] = [];
    let line = original.replace(/\s+/g, " ");
    if (line.includes("://")) line = line.replace(URL_RE, (url) => stripTrackingParams(url, removedParams));

    if (isNoiseLine(line, line.replace(LEADING_MARKUP, ""), ignore)) {
      suppressed.push(original);
      continue;
    }

    suppressed.push(...removedParams);
    if (blankPending) out.push("");
    blankPending = false;
    out.push(line);
  }

  return { text: out.join("\n"), suppressed };
}

/** SHA-256 of the text, lower-case hex. Stored on each version as `normalized_hash`. */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
