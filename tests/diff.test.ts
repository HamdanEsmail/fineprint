import { describe, expect, it } from "vitest";
import { factsDiff, splitBlocks, structuredDiff, type Fact } from "../src/core/diff";

const A = "# Plans\n\n## Pro\n\n$20 per month\nUnlimited projects\n\n## Hobby\n\nFree";
const B = "# Plans\n\n## Pro\n\n$25 per month\nUnlimited projects\n\n## Hobby\n\nFree\n\n## Ultra\n\n$200 per month";

describe("plan examples", () => {
  it("attributes blocks to the nearest heading", () => {
    expect(splitBlocks(A).map((b) => b.section)).toEqual(["Plans", "Pro", "Pro", "Hobby", "Hobby"]);
  });

  it("reports a price change as changed, a new tier as added, nothing removed", () => {
    const d = structuredDiff(A, B);
    expect(d.changed).toEqual([{ section: "Pro", before: "$20 per month\nUnlimited projects", after: "$25 per month\nUnlimited projects" }]);
    expect(d.added.map((b) => b.section)).toEqual(["Ultra", "Ultra"]);
    expect(d.removed).toEqual([]);
  });

  it("identical input gives an empty diff", () => {
    expect(structuredDiff(A, A)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("diffs facts by name", () => {
    const d = factsDiff(
      [{ name: "Pro", price: "$20", unit: "month", notes: null }],
      [
        { name: "Pro", price: "$25", unit: "month", notes: null },
        { name: "Ultra", price: "$200", unit: "month", notes: null },
      ],
    );
    expect(d).toEqual({
      added: [{ name: "Ultra", price: "$200", unit: "month", notes: null }],
      removed: [],
      changed: [{ name: "Pro", field: "price", before: "$20", after: "$25" }],
    });
    expect(factsDiff(null, [])).toBeNull();
  });
});

describe("splitBlocks", () => {
  it("returns the block text and puts text before the first heading in section ''", () => {
    expect(splitBlocks("Intro line one\nintro line two\n\n# Title\n\nBody")).toEqual([
      { section: "", text: "Intro line one\nintro line two" },
      { section: "Title", text: "# Title" },
      { section: "Title", text: "Body" },
    ]);
  });

  it("gives a heading its own text as section and keeps the raw heading line as text", () => {
    expect(splitBlocks("## Ultra plan  ")).toEqual([{ section: "Ultra plan", text: "## Ultra plan" }]);
  });

  it("starts a new block at a heading even without a blank line around it", () => {
    expect(splitBlocks("intro\n# T\nline a\nline b\n## U\nnext")).toEqual([
      { section: "", text: "intro" },
      { section: "T", text: "# T" },
      { section: "T", text: "line a\nline b" },
      { section: "U", text: "## U" },
      { section: "U", text: "next" },
    ]);
  });

  it("treats runs of blank and whitespace-only lines as one separator, and handles CRLF", () => {
    expect(splitBlocks("a\r\n\r\n   \n\t\nb\r\nc\r\n").map((b) => b.text)).toEqual(["a", "b\nc"]);
  });

  it("accepts heading levels 1 to 6 only, and needs a space after the marks", () => {
    expect(splitBlocks("###### Six").map((b) => b.section)).toEqual(["Six"]);
    expect(splitBlocks("####### Seven").map((b) => b.section)).toEqual([""]);
    expect(splitBlocks("#hashtag").map((b) => b.section)).toEqual([""]);
    expect(splitBlocks("Price is # 5")).toEqual([{ section: "", text: "Price is # 5" }]);
  });

  it("returns no blocks for empty or blank input", () => {
    expect(splitBlocks("")).toEqual([]);
    expect(splitBlocks("\n \n\n")).toEqual([]);
  });

  it("strips an ATX closing sequence from the section but keeps the raw heading line as text", () => {
    expect(splitBlocks("## Pro ##\n\nBody")).toEqual([
      { section: "Pro", text: "## Pro ##" },
      { section: "Pro", text: "Body" },
    ]);
    expect(splitBlocks("# Pro #   ")[0]).toEqual({ section: "Pro", text: "# Pro #" });
    expect(splitBlocks("### Pro \t######")[0]!.section).toBe("Pro");
  });

  it("keeps a trailing '#' that is part of the heading text", () => {
    expect(splitBlocks("# C#")[0]!.section).toBe("C#");
    expect(splitBlocks("## Fees ###a")[0]!.section).toBe("Fees ###a");
    expect(splitBlocks("## ##")[0]!.section).toBe("##");
  });
});

// Deterministic pseudo-random lowercase strings: two of them share almost no
// bigrams, so they never pair by similarity.
function randomBlocks(count: number, seed: number, length = 40): string[] {
  let state = seed;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 16;
  };
  return Array.from({ length: count }, () => Array.from({ length }, () => String.fromCharCode(97 + (next() % 26))).join(""));
}

describe("structuredDiff", () => {
  it("reports a removed block with its section", () => {
    const d = structuredDiff("# Fees\n\nBags: $35\n\nSeats: $15", "# Fees\n\nBags: $35");
    expect(d).toEqual({ added: [], removed: [{ section: "Fees", text: "Seats: $15" }], changed: [] });
  });

  it("keeps a removed and an added block in different sections unpaired", () => {
    // The headings differ too, so the whole region is one removed run and one
    // added run. The price blocks are near-identical but live under different
    // headings, so they must not be reported as one change.
    const d = structuredDiff("# Basic\n\n$20 per month", "# Premium\n\n$25 per month");
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([
      { section: "Basic", text: "# Basic" },
      { section: "Basic", text: "$20 per month" },
    ]);
    expect(d.added).toEqual([
      { section: "Premium", text: "# Premium" },
      { section: "Premium", text: "$25 per month" },
    ]);
  });

  it("keeps a same-section replacement with unrelated text unpaired", () => {
    const d = structuredDiff("# Refunds\n\nRefunds are issued within 14 days.", "# Refunds\n\nZZZ qqq xxx 999 wvu");
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([{ section: "Refunds", text: "Refunds are issued within 14 days." }]);
    expect(d.added).toEqual([{ section: "Refunds", text: "ZZZ qqq xxx 999 wvu" }]);
  });

  it("pairs a replacement whose similarity is above the threshold", () => {
    const d = structuredDiff(
      "# Refunds\n\nRefunds are issued within 14 days of purchase.",
      "# Refunds\n\nRefunds are issued within 30 days of purchase.",
    );
    expect(d.changed).toEqual([
      { section: "Refunds", before: "Refunds are issued within 14 days of purchase.", after: "Refunds are issued within 30 days of purchase." },
    ]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("compares case-insensitively when measuring similarity", () => {
    const d = structuredDiff("# T\n\nNO REFUNDS AFTER 14 DAYS", "# T\n\nno refunds after 30 days");
    expect(d.changed).toHaveLength(1);
  });

  it("pairs removed and added runs positionally, leaving the surplus unpaired", () => {
    const from = "# Plans\n\nPro costs $20 per month\n\nTeam costs $40 per month";
    const to = "# Plans\n\nPro costs $25 per month\n\nTeam costs $45 per month\n\nBrand new enterprise tier, contact sales";
    const d = structuredDiff(from, to);
    expect(d.changed).toEqual([
      { section: "Plans", before: "Pro costs $20 per month", after: "Pro costs $25 per month" },
      { section: "Plans", before: "Team costs $40 per month", after: "Team costs $45 per month" },
    ]);
    expect(d.added).toEqual([{ section: "Plans", text: "Brand new enterprise tier, contact sales" }]);
    expect(d.removed).toEqual([]);
  });

  it("returns blocks in document order", () => {
    const from = "# A\n\none\n\n# B\n\ntwo\n\n# C\n\nthree\n\n# D\n\nfour";
    const to = "# A\n\none\n\nnew-a-block\n\n# B\n\nthree-b changed here\n\n# C\n\nthree\n\n# E\n\nfive";
    const d = structuredDiff(from, to);
    expect(d.removed.map((b) => b.text)).toEqual(["two", "# D", "four"]);
    expect(d.added.map((b) => b.text)).toEqual(["new-a-block", "three-b changed here", "# E", "five"]);
  });

  it("orders several changes by their place in the new text", () => {
    const from = "# P\n\nAlpha costs $10 a month\n\n# Q\n\nBeta costs $20 a month\n\n# R\n\nGamma costs $30 a month";
    const to = "# P\n\nAlpha costs $11 a month\n\n# Q\n\nBeta costs $20 a month\n\n# R\n\nGamma costs $31 a month";
    expect(structuredDiff(from, to).changed.map((c) => c.section)).toEqual(["P", "R"]);
  });

  it("attributes a repeated block to its own section, not the first one with that text", () => {
    const from = "# One\n\nFree\n\n# Two\n\nFree";
    const to = "# One\n\nFree\n\n# Two";
    expect(structuredDiff(from, to).removed).toEqual([{ section: "Two", text: "Free" }]);
  });

  it("treats a renamed heading as removed plus added and leaves its unchanged body out", () => {
    const d = structuredDiff("## Pro\n\n$20 per month", "## Professional\n\n$20 per month");
    expect(d.removed).toEqual([{ section: "Pro", text: "## Pro" }]);
    expect(d.added).toEqual([{ section: "Professional", text: "## Professional" }]);
    expect(d.changed).toEqual([]);
  });

  it("diffs against and from empty text", () => {
    expect(structuredDiff("", "# A\n\nx")).toEqual({
      added: [
        { section: "A", text: "# A" },
        { section: "A", text: "x" },
      ],
      removed: [],
      changed: [],
    });
    expect(structuredDiff("# A\n\nx", "").removed).toHaveLength(2);
    expect(structuredDiff("", "")).toEqual({ added: [], removed: [], changed: [] });
  });

  it("ignores a difference that is only blank lines or line endings", () => {
    expect(structuredDiff("# A\n\nx\n\ny", "# A\r\n\r\n\r\nx\r\n\r\ny\r\n")).toEqual({ added: [], removed: [], changed: [] });
  });

  it("does not treat single-character blocks as similar", () => {
    const d = structuredDiff("# A\n\n5", "# A\n\n6");
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([{ section: "A", text: "5" }]);
    expect(d.added).toEqual([{ section: "A", text: "6" }]);
  });

  it("finds a single edit in a large page", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1500; i++) lines.push(i % 25 === 0 ? `## Section ${i}` : `Paragraph ${i} with some terms and a fee of $${i}.`);
    const from = lines.join("\n\n");
    const to = lines.map((l, i) => (i === 703 ? l.replace(/\$\d+/, () => "$999") : l)).join("\n\n");
    const d = structuredDiff(from, to);
    expect(d.changed).toEqual([
      { section: "Section 700", before: "Paragraph 703 with some terms and a fee of $703.", after: "Paragraph 703 with some terms and a fee of $999." },
    ]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe("structuredDiff: pairing inside a run", () => {
  it("pairs a price edit with its new block when a new tier is inserted before it", () => {
    const from = "# Plans\n\nPro costs $20 per month\n\nTeam costs $40 per month";
    const to = "# Plans\n\nStarter is free forever\n\nPro costs $25 per month\n\nTeam costs $40 per month";
    const d = structuredDiff(from, to);
    expect(d.changed).toEqual([{ section: "Plans", before: "Pro costs $20 per month", after: "Pro costs $25 per month" }]);
    expect(d.added).toEqual([{ section: "Plans", text: "Starter is free forever" }]);
    expect(d.removed).toEqual([]);
  });

  it("pairs a wording edit with its new block when a block is deleted before it", () => {
    const from = "# Policy\n\nWe may email you offers\n\nRefunds are issued within 14 days.";
    const to = "# Policy\n\nRefunds are issued within 30 days.";
    const d = structuredDiff(from, to);
    expect(d.removed).toEqual([{ section: "Policy", text: "We may email you offers" }]);
    expect(d.changed).toEqual([{ section: "Policy", before: "Refunds are issued within 14 days.", after: "Refunds are issued within 30 days." }]);
    expect(d.added).toEqual([]);
  });

  it("picks the best-scoring added block, not the first one above the threshold", () => {
    const from = "# Policy\n\nRefunds are issued within 14 days of purchase.";
    const to = "# Policy\n\nRefunds are issued.\n\nRefunds are issued within 30 days of purchase.";
    const d = structuredDiff(from, to);
    expect(d.changed).toEqual([
      { section: "Policy", before: "Refunds are issued within 14 days of purchase.", after: "Refunds are issued within 30 days of purchase." },
    ]);
    expect(d.added).toEqual([{ section: "Policy", text: "Refunds are issued." }]);
    expect(d.removed).toEqual([]);
  });

  it("never pairs against an added block that comes before an earlier match", () => {
    // Block A matches the second added block, so block B (whose best match is
    // the first added block) can only look further on, finds nothing, and stays
    // removed.
    const a = "Parking is free for the first two hours.";
    const b = "Late fees are charged at 5 percent per month.";
    const d = structuredDiff(`# T\n\n${a}\n\n${b}`, `# T\n\nLate fees are charged at 6 percent per month.\n\nParking is free for the first three hours.`);
    expect(d.changed).toEqual([{ section: "T", before: a, after: "Parking is free for the first three hours." }]);
    expect(d.removed).toEqual([{ section: "T", text: b }]);
    expect(d.added).toEqual([{ section: "T", text: "Late fees are charged at 6 percent per month." }]);
  });

  it("falls back to positional pairing when a run has more than 50 blocks on one side", () => {
    // One added block that edits the 31st of 51 removed blocks. Pairing by
    // similarity would find it; the position-by-position fallback does not,
    // which is the price of keeping the CPU bounded.
    const blocks = randomBlocks(51, 7);
    const d = structuredDiff(blocks.join("\n\n"), blocks[30] + " edited");
    expect(d.changed).toEqual([]);
    expect(d.removed.map((b) => b.text)).toEqual(blocks);
    expect(d.added.map((b) => b.text)).toEqual([blocks[30] + " edited"]);
  });

  it("still pairs by similarity in a run of exactly 50 blocks", () => {
    const blocks = randomBlocks(50, 7);
    const d = structuredDiff(blocks.join("\n\n"), blocks[30] + " edited");
    expect(d.changed).toEqual([{ section: "", before: blocks[30]!, after: blocks[30] + " edited" }]);
    expect(d.removed).toHaveLength(49);
    expect(d.added).toEqual([]);
  });

  it("compares only the first 4 KB of a block", () => {
    const head = "cat ".repeat(1024); // exactly 4096 characters
    const tail = randomBlocks(1, 3, 3000)[0]!;
    const d = structuredDiff(`# T\n\n${head}`, `# T\n\n${head}${tail}`);
    expect(d.changed).toHaveLength(1);
    expect(d.removed).toEqual([]);
    expect(d.added).toEqual([]);
  });

  it("does not pair blocks that differ inside the first 4 KB, whatever follows", () => {
    // The tails are identical and would make the blocks look alike if they counted.
    const tail = randomBlocks(1, 3, 3000)[0]!;
    const d = structuredDiff(`# T\n\n${"cat ".repeat(1024)}${tail}`, `# T\n\n${"dog ".repeat(1024)}${tail}`);
    expect(d.changed).toEqual([]);
    expect(d.removed).toHaveLength(1);
    expect(d.added).toHaveLength(1);
  });
});

describe("structuredDiff: bounded work", () => {
  // Reversing distinct blocks leaves a longest common subsequence of one block,
  // so an exact diff reports every block but one as removed and added. Past the
  // edit-distance bound the diff is not run: the whole region is one removed
  // run and one added run, paired position by position, so nothing is kept.
  it("gives up on an exact alignment past the bound and treats the region as one removed and one added run", () => {
    const blocks = randomBlocks(300, 1);
    const d = structuredDiff(blocks.join("\n\n"), [...blocks].reverse().join("\n\n"));
    expect(d.changed).toEqual([]);
    expect(d.removed.map((b) => b.text)).toEqual(blocks);
    expect(d.added.map((b) => b.text)).toEqual([...blocks].reverse());
  });

  it("still aligns exactly when the edit distance is within the bound", () => {
    const blocks = randomBlocks(20, 1);
    const reversed = [...blocks].reverse();
    const d = structuredDiff(blocks.join("\n\n"), reversed.join("\n\n"));
    // One block is common to both orders; every other block is removed and added.
    expect(d.removed).toHaveLength(19);
    expect(d.added).toHaveLength(19);
    expect(d.changed).toEqual([]);
  });

  it("keeps unchanged blocks out of the diff after giving up, and still pairs edits that line up", () => {
    const blocks = randomBlocks(300, 5);
    const edited = blocks.map((b, i) => (i % 3 === 0 ? b + " (revised)" : b));
    const d = structuredDiff(blocks.join("\n\n"), edited.join("\n\n"));
    expect(d.changed).toHaveLength(100);
    expect(d.changed[0]).toEqual({ section: "", before: blocks[0]!, after: blocks[0] + " (revised)" });
    expect(d.removed).toEqual([]);
    expect(d.added).toEqual([]);
  });

  it("stops comparing blocks once the similarity budget is spent, leaving the rest removed and added", () => {
    // 400 revised blocks of 200 characters is far more comparison work than the
    // budget allows, so only the first pairs (in document order) are recognised.
    const blocks = randomBlocks(400, 21, 200);
    const revised = blocks.map((b) => b + " (revised)");
    const d = structuredDiff(blocks.join("\n\n"), revised.join("\n\n"));
    expect(d.changed.length).toBeGreaterThan(20);
    expect(d.changed.length).toBeLessThan(200);
    expect(d.changed[0]).toEqual({ section: "", before: blocks[0]!, after: revised[0]! });
    expect(d.removed).toHaveLength(400 - d.changed.length);
    expect(d.added).toHaveLength(400 - d.changed.length);
    // The blocks that did pair are the first ones.
    expect(d.removed[0]!.text).toBe(blocks[d.changed.length]);
  });
});

describe("factsDiff", () => {
  const pro: Fact = { name: "Pro", price: "$20", unit: "month", notes: null };

  it("returns null when either side is null", () => {
    expect(factsDiff(null, null)).toBeNull();
    expect(factsDiff([pro], null)).toBeNull();
    expect(factsDiff(null, [pro])).toBeNull();
  });

  it("gives an empty diff for equal lists and for two empty lists", () => {
    expect(factsDiff([pro], [{ ...pro }])).toEqual({ added: [], removed: [], changed: [] });
    expect(factsDiff([], [])).toEqual({ added: [], removed: [], changed: [] });
  });

  it("reports removed facts in from order and added facts in to order", () => {
    const f = (name: string): Fact => ({ name, price: "$1", unit: null, notes: null });
    const d = factsDiff([f("A"), f("B"), f("C")], [f("Z"), f("B"), f("Y")]);
    expect(d?.removed.map((x) => x.name)).toEqual(["A", "C"]);
    expect(d?.added.map((x) => x.name)).toEqual(["Z", "Y"]);
    expect(d?.changed).toEqual([]);
  });

  it("matches names case-insensitively and ignoring surrounding whitespace, reporting the new name", () => {
    const d = factsDiff([{ name: " pro ", price: "$20", unit: null, notes: null }], [{ name: "PRO", price: "$25", unit: null, notes: null }]);
    expect(d).toEqual({ added: [], removed: [], changed: [{ name: "PRO", field: "price", before: "$20", after: "$25" }] });
  });

  it("emits one entry per differing field, in the order price, unit, notes", () => {
    const d = factsDiff(
      [{ name: "Pro", price: "$20", unit: "month", notes: null }],
      [{ name: "Pro", price: "$25", unit: "year", notes: "billed annually" }],
    );
    expect(d?.changed).toEqual([
      { name: "Pro", field: "price", before: "$20", after: "$25" },
      { name: "Pro", field: "unit", before: "month", after: "year" },
      { name: "Pro", field: "notes", before: null, after: "billed annually" },
    ]);
  });

  it("reports a field going from a value to null", () => {
    const d = factsDiff([{ name: "Pro", price: "$20", unit: "month", notes: "intro offer" }], [{ name: "Pro", price: "$20", unit: null, notes: null }]);
    expect(d?.changed).toEqual([
      { name: "Pro", field: "unit", before: "month", after: null },
      { name: "Pro", field: "notes", before: "intro offer", after: null },
    ]);
  });

  it("orders changes by the new list", () => {
    const f = (name: string, price: string): Fact => ({ name, price, unit: null, notes: null });
    const d = factsDiff([f("A", "$1"), f("B", "$2")], [f("B", "$3"), f("A", "$4")]);
    expect(d?.changed.map((c) => c.name)).toEqual(["B", "A"]);
  });

  it("pairs repeated names by occurrence, so identical lists with duplicates diff empty", () => {
    const dup: Fact[] = [
      { name: "Fee", price: "$5", unit: null, notes: "online" },
      { name: "Fee", price: "$9", unit: null, notes: "in store" },
    ];
    expect(factsDiff(dup, dup.map((f) => ({ ...f })))).toEqual({ added: [], removed: [], changed: [] });
    const d = factsDiff(dup, [dup[0]!, { ...dup[1]!, price: "$10" }, { name: "fee", price: "$1", unit: null, notes: null }]);
    expect(d?.changed).toEqual([{ name: "Fee", field: "price", before: "$9", after: "$10" }]);
    expect(d?.added).toEqual([{ name: "fee", price: "$1", unit: null, notes: null }]);
    expect(d?.removed).toEqual([]);
  });
});
