import { describe, expect, it } from "vitest";
import { hashText, normalize } from "../src/core/normalize";

describe("normalize: plan examples", () => {
  it("drops a 'Last updated' line but keeps a cutoff date in content", () => {
    const { text, suppressed } = normalize("## Visa Bulletin\nFinal action date: 01 MAR 2023\nLast updated: 3 November 2026\n");
    expect(text).toContain("01 MAR 2023");
    expect(text).not.toContain("Last updated");
    expect(suppressed).toEqual(["Last updated: 3 November 2026"]);
  });

  it("strips utm parameters from links but keeps the link", () => {
    expect(normalize("[Pricing](https://a.com/p?utm_source=x&plan=pro)").text).toBe("[Pricing](https://a.com/p?plan=pro)");
  });

  it("applies page ignore patterns and tolerates an invalid regex", () => {
    const { text } = normalize("Price $20\nVisitors today: 1234\n", ["^Visitors today", "(["]);
    expect(text).toBe("Price $20");
  });

  it("keeps prices and plain numbers", () => {
    expect(normalize("Pro $25 /mo, 1,000 requests, 2026 model").text).toBe("Pro $25 /mo, 1,000 requests, 2026 model");
  });

  it("same input gives same hash, one changed digit gives a different hash", async () => {
    expect(await hashText("a")).toBe(await hashText("a"));
    expect(await hashText("Pro $20")).not.toBe(await hashText("Pro $25"));
  });
});

describe("hashText", () => {
  it("is the SHA-256 hex digest of the UTF-8 text", async () => {
    expect(await hashText("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hashText("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await hashText("Pro €25")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("normalize: whitespace", () => {
  it("collapses runs of spaces and tabs inside a line and trims each line", () => {
    expect(normalize("  Pro \t\t $25   /mo  \n").text).toBe("Pro $25 /mo");
  });

  it("keeps one blank line as a block separator and collapses longer runs", () => {
    expect(normalize("A\n\n\n\n   \n\t\nB\r\n\r\nC").text).toBe("A\n\nB\n\nC");
  });

  it("trims leading and trailing blank lines of the whole text", () => {
    expect(normalize("\n\n  \nA\nB\n\n\n").text).toBe("A\nB");
  });

  it("collapses the blank lines left behind by a dropped line", () => {
    expect(normalize("A\n\nLast updated: 3 November 2026\n\nB").text).toBe("A\n\nB");
  });

  it("returns empty text for empty or all-noise input", () => {
    expect(normalize("")).toEqual({ text: "", suppressed: [] });
    expect(normalize("Skip to content\n\nCookie settings\n").text).toBe("");
  });

  it("is idempotent", () => {
    const input = "## Pricing\n\n\nPro   $25 /mo\nLast updated: 3 Nov 2026\n[x](https://a.com/p?utm_source=x&plan=pro)\n";
    const once = normalize(input).text;
    expect(normalize(once)).toEqual({ text: once, suppressed: [] });
  });
});

describe("normalize: tracking parameters", () => {
  it.each(["utm_source=a", "utm_medium=b", "utm_anything_at_all=c", "UTM_Campaign=d", "gclid=1", "fbclid=2", "ref=3", "_ga=4", "mc_cid=5", "mc_eid=6", "igshid=7"])(
    "strips %s and records it as key=value",
    (param) => {
      const { text, suppressed } = normalize(`See https://a.com/p?${param}&plan=pro now`);
      expect(text).toBe("See https://a.com/p?plan=pro now");
      expect(suppressed).toEqual([param]);
    },
  );

  it.each(["reference=x", "referrer=x", "ref_src=x", "refund=true", "utmx=1", "my_utm_source=1", "ga=1", "gclid_x=1"])("keeps look-alike %s", (param) => {
    const input = `See https://a.com/p?${param}&plan=pro now`;
    expect(normalize(input)).toEqual({ text: input, suppressed: [] });
  });

  it("keeps other parameters in their original order", () => {
    expect(normalize("https://a.com/p?b=2&utm_source=x&a=1&fbclid=z&c=3").text).toBe("https://a.com/p?b=2&a=1&c=3");
  });

  it("drops the question mark when no parameter remains and keeps the fragment", () => {
    expect(normalize("https://a.com/p?utm_source=x&gclid=y").text).toBe("https://a.com/p");
    expect(normalize("https://a.com/p?utm_source=x#plans").text).toBe("https://a.com/p#plans");
    expect(normalize("https://a.com/p?utm_source=x&plan=pro#plans").text).toBe("https://a.com/p?plan=pro#plans");
  });

  it("does not re-encode the rest of the URL", () => {
    const url = "https://a.com/a%20b/c?q=caf%C3%A9+au+lait&x=%7Bs%7D";
    expect(normalize(`${url}&utm_source=x`).text).toBe(url);
  });

  it("handles every link on a line, bare or in markdown, and trailing punctuation", () => {
    const { text, suppressed } = normalize("[a](http://a.com/?ref=1) and <https://b.com/x?utm_medium=m&k=v>, then https://c.com/y?fbclid=q.");
    expect(text).toBe("[a](http://a.com/) and <https://b.com/x?k=v>, then https://c.com/y.");
    expect(suppressed).toEqual(["ref=1", "utm_medium=m", "fbclid=q"]);
  });

  it("keeps balanced parentheses in the path and strips the query after them", () => {
    expect(normalize("[w](https://en.wikipedia.org/wiki/Foo_(bar)?utm_source=x&a=1)").text).toBe("[w](https://en.wikipedia.org/wiki/Foo_(bar)?a=1)");
  });

  it("leaves URLs without tracking parameters and non-http text untouched", () => {
    const input = "https://a.com/p?plan=pro\nhttps://a.com/p?\nftp://a.com/p?utm_source=x\n/relative?utm_source=x";
    expect(normalize(input)).toEqual({ text: input, suppressed: [] });
  });

  it("records no tracking entry for a line that is dropped anyway", () => {
    const { suppressed } = normalize("Posted 3 hours ago https://a.com/p?utm_source=x");
    expect(suppressed).toEqual(["Posted 3 hours ago https://a.com/p?utm_source=x"]);
  });
});

describe("normalize: metadata lines", () => {
  it.each([
    "Last updated: 3 November 2026",
    "Last Updated 3 Nov 2026",
    "**Last updated:** 3 Nov 2026",
    "_Last updated: November 3rd, 2026_",
    "> Last updated on 2026-11-03",
    "- Last updated: Nov 3, 2026, 10:00 AM GST",
    "## Last updated: 3 November 2026 by John Smith",
    "| Last updated | 3 Nov 2026 |",
    "*Updated on Nov 3, 2026 at 10:00 AM UTC*",
    "Updated on 03.11.2026",
    "Updated: 2026-11-03T10:00:00+04:00",
    "Updated: Tuesday, 3 November 2026",
    "Updated: today",
    "Published 2026-11-03",
    "Published on November 2026",
    "Published: 3rd of November 2026 by the Pricing Team",
    "Effective date: January 1, 2027",
    "Page generated at 2026-11-03T10:00:00Z",
    "Page generated: Tue 3 Nov 2026 10:00:07 UTC+4",
    "As of 03/11/2026",
    "As of: 3 November 2026",
  ])("drops %j", (line) => {
    const { text, suppressed } = normalize(`Keep me\n${line}\nKeep me too`);
    expect(text).toBe("Keep me\nKeep me too");
    expect(suppressed).toEqual([line]);
  });

  it.each([
    "As of 1 December 2026 the checked bag fee is $35",
    "As of 2026 the checked bag fee is $35",
    "Published rates apply to all routes",
    "Published",
    "Updated: Pro now includes 10 seats",
    "Updated: May apply to new accounts",
    "Updated on request",
    "Last updated prices are shown below",
    "Last updated: see the changelog",
    "Effective date of the new fee schedule is announced 30 days in advance",
    "Page generated reports are available on Pro",
    "Updated 3 Nov 2026",
    "Final action date: 01 MAR 2023",
    "Deadline: file by 31 March 2027",
    "## 3 November 2026",
    "Your last updated invoice is attached",
    "Published 3 Nov 2026 by the chairman of the board of directors",
    "Published 12 new plans",
  ])("keeps %j", (line) => {
    expect(normalize(line)).toEqual({ text: line, suppressed: [] });
  });

  it("never removes dates that are not on a metadata line", () => {
    const input = [
      "## Release notes",
      "### 3 November 2026",
      "Deadline for filing is 31 March 2027.",
      "Fee rises to $35 on 1 January 2027 (announced 12 Oct 2026).",
      "Cutoff dates: EB-2 India 01 JAN 2013, EB-3 ROW 01 APR 2023",
    ].join("\n");
    expect(normalize(input)).toEqual({ text: input, suppressed: [] });
  });
});

describe("normalize: copyright and relative time", () => {
  it.each(["© 2026 Example Inc.", "Copyright 2026 Example Inc.", "Copyright (c) 2026 Example", "**Copyright** © 2026", "> © Example"])("drops copyright line %j", (line) => {
    expect(normalize(`A\n${line}`)).toEqual({ text: "A", suppressed: [line] });
  });

  it.each(["Photos remain the copyright of their authors", "Copyrighted material is removed within 24 hours", "Terms | © 2026 Example"])("keeps %j", (line) => {
    expect(normalize(line)).toEqual({ text: line, suppressed: [] });
  });

  it.each(["3 hours ago", "Posted 1 day ago by admin", "Edited 45 Minutes AGO", "12 seconds ago", "Checked 2 days ago"])("drops relative time line %j", (line) => {
    expect(normalize(`A\n${line}`)).toEqual({ text: "A", suppressed: [line] });
  });

  it.each(["Refunds within 30 days of purchase", "Posted 3 hours", "ago 3 hours", "3 weeks ago"])("keeps %j", (line) => {
    expect(normalize(line)).toEqual({ text: line, suppressed: [] });
  });
});

describe("normalize: built-in noise list", () => {
  it.each([
    "Skip to content",
    "[Skip to content](#main)",
    "SKIP TO CONTENT",
    "We use cookies to improve your experience.",
    "Accept all cookies",
    "[Accept all cookies](#)",
    "Manage Cookie Settings",
    "23 people viewing this page",
    "1,204 others are viewing",
    "5 People Viewing",
    "12 shares",
    "1 share",
    "1.2k shares",
    "3M Shares",
    "1,234 Shares",
    "**12** shares",
  ])("drops %j", (line) => {
    expect(normalize(`A\n${line}\nB`)).toEqual({ text: "A\nB", suppressed: [line] });
  });

  it.each([
    "Revenue share",
    "Revenue share: 20% of net sales",
    "Share this plan with 5 teammates",
    "Shares outstanding: 1,000",
    "Up to 5 people, unlimited viewing",
    "Plan for 3 people",
    "Skip the queue",
    "Cookies expire after 30 days",
    "Cookie policy",
  ])("keeps %j", (line) => {
    expect(normalize(line)).toEqual({ text: line, suppressed: [] });
  });
});

describe("normalize: ignore patterns", () => {
  it("matches case-insensitively, on the trimmed line", () => {
    const { text, suppressed } = normalize("Price $20\n   VISITORS TODAY: 12  \n", ["^visitors today"]);
    expect(text).toBe("Price $20");
    expect(suppressed).toEqual(["VISITORS TODAY: 12"]);
  });

  it("drops a line that matches any of several patterns", () => {
    expect(normalize("a\nfoo 1\nbar 2\nbaz 3", ["^foo", "^bar"]).text).toBe("a\nbaz 3");
  });

  it("never throws on invalid patterns, and ignores empty, blank, non-string and match-everything patterns", () => {
    const patterns = ["([", "*", "", "   ", "x*", "(?:)", null as unknown as string, 42 as unknown as string];
    expect(normalize("Price $20\nVisitors today: 1234", patterns)).toEqual({ text: "Price $20\nVisitors today: 1234", suppressed: [] });
  });

  it("does not need ignore patterns", () => {
    expect(normalize("Price $20", undefined).text).toBe("Price $20");
    expect(normalize("Price $20", []).text).toBe("Price $20");
  });
});

describe("normalize: rule order and suppressed list", () => {
  it("lists dropped lines as their trimmed original text and stripped parameters as key=value, in text order", () => {
    const input = ["  Last   updated:  3 Nov 2026  ", "[a](https://a.com/p?utm_source=x&plan=pro)", "Skip to content", "Visitors today: 12"].join("\n");
    expect(normalize(input, ["^Visitors"])).toEqual({
      text: "[a](https://a.com/p?plan=pro)",
      suppressed: ["Last   updated:  3 Nov 2026", "utm_source=x", "Skip to content", "Visitors today: 12"],
    });
  });

  it("a line dropped by a built-in rule is listed once even when several rules match", () => {
    const { suppressed } = normalize("Published 2026-11-03\nCookie settings 3 hours ago", ["Cookie"]);
    expect(suppressed).toEqual(["Published 2026-11-03", "Cookie settings 3 hours ago"]);
  });

  it("two texts that differ only by noise normalize to the same text and hash", async () => {
    const a = normalize("## Pricing\nPro $25 /mo\n\nLast updated: 3 Nov 2026\n12 shares\n[Buy](https://a.com/buy?utm_source=a&plan=pro)");
    const b = normalize("## Pricing\nPro  $25 /mo\nLast updated: 4 Nov 2026\n\n\n40 shares\n[Buy](https://a.com/buy?plan=pro&gclid=zz)");
    expect(a.text).toBe(b.text);
    expect(await hashText(a.text)).toBe(await hashText(b.text));
  });

  it("a changed price still changes the normalized text", () => {
    expect(normalize("Pro $20\nLast updated: 3 Nov 2026").text).not.toBe(normalize("Pro $25\nLast updated: 3 Nov 2026").text);
  });
});

describe("normalize: speed", () => {
  it("handles ~100 KB of text with many noisy lines quickly", () => {
    const block = [
      "## Section",
      "Pro plan: $25 per seat per month, billed annually.   Includes 1,000 requests.",
      "[Buy](https://a.com/buy?utm_source=a&utm_medium=b&plan=pro&ref=x)",
      "Last updated: 3 November 2026",
      "",
      "",
      "We use cookies to improve your experience.",
      "Posted 3 hours ago",
    ].join("\n");
    const input = Array.from({ length: Math.ceil(100_000 / block.length) }, () => block).join("\n");
    const t0 = performance.now();
    const { text } = normalize(input, ["^Visitors"]);
    const ms = performance.now() - t0;
    expect(text).toContain("Pro plan: $25 per seat per month, billed annually. Includes 1,000 requests.");
    expect(text).not.toContain("utm_");
    // Generous bound for a shared CI machine; real cost is a few milliseconds.
    expect(ms).toBeLessThan(250);
  });

  it("does not blow up on long pathological lines", () => {
    const t0 = performance.now();
    normalize(`Last updated: ${"1 ".repeat(20_000)}x`);
    normalize(`https://a.com/${"?".repeat(20_000)}`);
    normalize(`${"(".repeat(20_000)}`);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

// Spec section 8: every noise rule has a fixture that must be suppressed and a
// near-miss that must not be. The fixtures are plain text files; this table is
// the single list of rules and what each suppress fixture must report.
const fixtures = import.meta.glob("./fixtures/normalize/*.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

type Rule = {
  /** Suppressed entries, in order. */
  suppressed: string[];
  /** Expected text. Default: the fixture without the suppressed lines. */
  text?: string;
  patterns?: string[];
};

const RULES: Record<string, Rule> = {
  "metadata-last-updated": { suppressed: ["Last updated: 3 November 2026"] },
  "metadata-updated-on": { suppressed: ["*Updated on Nov 3, 2026 at 10:00 AM UTC*"] },
  "metadata-updated-colon": { suppressed: ["Updated: 3 Nov 2026"] },
  "metadata-published": { suppressed: ["Published 2026-11-03"] },
  "metadata-effective-date": { suppressed: ["Effective date: January 1, 2027"] },
  "metadata-page-generated": { suppressed: ["Page generated at 2026-11-03T10:00:00Z"] },
  "metadata-as-of": { suppressed: ["As of 03/11/2026"] },
  copyright: { suppressed: ["© 2026 Example Inc. All rights reserved."] },
  "relative-time": { suppressed: ["Posted 3 hours ago by admin"] },
  "noise-skip-to-content": { suppressed: ["Skip to content"] },
  "noise-we-use-cookies": { suppressed: ["We use cookies to improve your experience."] },
  "noise-accept-all-cookies": { suppressed: ["[Accept all cookies](#)"] },
  "noise-cookie-settings": { suppressed: ["Cookie settings"] },
  "noise-viewer-counter": { suppressed: ["23 people viewing this page"] },
  "noise-share-counter": { suppressed: ["1.2k shares"] },
  "tracking-params": {
    suppressed: ["utm_source=x", "gclid=abc", "fbclid=def"],
    text: "[Pricing](https://a.com/p?plan=pro)\nDocs: https://a.com/docs#intro.",
  },
  "ignore-patterns": { suppressed: ["Visitors today: 1234"], patterns: ["^Visitors today", "(["] },
};

const lines = (raw: string) => raw.replace(/\r\n/g, "\n").trim().split("\n");

describe("normalize: fixture pairs (one suppressed, one near-miss per rule)", () => {
  it("every rule has both fixtures and every fixture belongs to a rule", () => {
    const files = Object.keys(fixtures).map((p) => p.replace("./fixtures/normalize/", ""));
    const expected = Object.keys(RULES).flatMap((r) => [`${r}.suppress.txt`, `${r}.keep.txt`]);
    expect(files.sort()).toEqual(expected.sort());
  });

  describe.each(Object.entries(RULES))("%s", (name, rule) => {
    const get = (kind: "suppress" | "keep") => {
      const raw = fixtures[`./fixtures/normalize/${name}.${kind}.txt`];
      if (raw === undefined) throw new Error(`missing fixture ${name}.${kind}.txt`);
      return raw;
    };

    it("suppresses the noise fixture", () => {
      const raw = get("suppress");
      const result = normalize(raw, rule.patterns);
      expect(result.suppressed).toEqual(rule.suppressed);
      expect(result.text).toBe(rule.text ?? lines(raw).filter((l) => !rule.suppressed.includes(l.trim())).join("\n"));
    });

    it("keeps the near-miss fixture untouched", () => {
      const raw = get("keep");
      expect(normalize(raw, rule.patterns)).toEqual({ text: lines(raw).join("\n"), suppressed: [] });
    });
  });
});
