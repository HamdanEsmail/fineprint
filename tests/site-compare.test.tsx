import { applyD1Migrations, createExecutionContext, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Delta } from "../src/core/diff";
import { insertPage, updatePage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { RunRow, TriggerKind } from "../src/db/types";
import { diffsToWarm, insertVersion, type NewVersion } from "../src/db/versions";
import type { Env } from "../src/env";
import worker from "../src/index";
import { getDiff, listChanges } from "../src/readModel";
import { BlockText, plainText } from "../src/site/blockText";
import { BLOCKS_PER_GROUP, placesFromDiff, WORD_DIFF_CHARS, WORD_DIFF_PAIRS } from "../src/site/views/compare";
import { FEATURE_TEXT_CAP, featuredCatch } from "../src/site/views/home";
import { wordDiff, WORD_DIFF_MAX_CHARS } from "../src/site/wordDiff";

// The compare view (GET /pages/:id/compare?from=&to=&all=1): the structured diff between two versions as
// section groups with word-level marks, the facts first, the two screenshots with their evidence lines; and
// the home's featured catch, which shows one changed block of a recent change, read from the diff cache or
// diffed fresh only when both texts are small.

const db = env.DB;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const XSS = "<script>alert(1)</script>";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const render = (node: unknown): string => String(node);
const count = (html: string, needle: string): number => html.split(needle).length - 1;

async function fetchPath(path: string): Promise<Response> {
  return SELF.fetch(`https://x${path}`);
}

async function get(path: string): Promise<string> {
  const res = await fetchPath(path);
  expect(res.status, path).toBe(200);
  return res.text();
}

function page(id: string, over: Partial<NewPage> = {}): NewPage {
  return {
    id,
    url: `https://example.com/${id}`,
    label: id,
    kind: "pricing",
    monitor_id: `mon-${id}`,
    schedule_cron: "14 2,14 * * *",
    purpose: "watch",
    status: "active",
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
    ...over,
  };
}

function run(id: string, pageId: string, at: string, over: Partial<RunRow> = {}): RunRow {
  return {
    id,
    page_id: pageId,
    monitor_run_id: `m-${id}`,
    outcome: "unchanged",
    is_baseline: 0,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: at,
    trigger_kind: "webhook",
    ...over,
  };
}

async function version(id: string, pageId: string, at: string, trigger: TriggerKind, over: Partial<NewVersion> = {}): Promise<void> {
  const baseline = trigger === "create";
  await insertRun(db, run(`run-${id}`, pageId, at, { trigger_kind: trigger, outcome: baseline ? "baseline" : "changed", is_baseline: baseline ? 1 : 0 }));
  await insertVersion(db, {
    id,
    page_id: pageId,
    run_id: `run-${id}`,
    is_baseline: baseline ? 1 : 0,
    captured_at: at,
    text: `text of ${id}`,
    normalized_hash: `hash-${id}`,
    judgment_summary: null,
    screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`,
    capture_status: "complete",
    facts_status: "not_needed",
    ...over,
  });
}

const delta = (blocks: [number, number, number], layoutOnly = false): string =>
  JSON.stringify({ blocks: { added: blocks[0], removed: blocks[1], changed: blocks[2] }, facts: null, layout_only: layoutOnly } satisfies Delta);

const facts = (pro: string): string =>
  JSON.stringify([
    { name: "Pro", price: pro, unit: "per month", notes: null },
    { name: "Team", price: "$40", unit: "per seat", notes: null },
  ]);

const TEXT0 = [
  "# Example pricing",
  "## Pro",
  "Pro costs $20 per month.",
  "Includes 10 projects.",
  "## Team",
  "Team costs $40 per seat.",
  "An old footnote that goes away.",
].join("\n\n");

// One block changed ($20 to $25), one removed (the footnote), one added; the added block carries markup.
const TEXT1 = [
  "# Example pricing",
  "## Pro",
  "Pro costs $25 per month.",
  "Includes 10 projects.",
  "## Team",
  "Team costs $40 per seat.",
  `* [Docs](javascript:alert(1)) now list ${XSS} for **every** seat.`,
].join("\n\n");

/** A pricing page: a baseline and one change, both final, with facts; a noise run between them. */
async function seedPricing(): Promise<{ t0: string; t1: string }> {
  const t0 = ago(3 * DAY);
  const t1 = ago(1 * DAY);
  await insertPage(db, page("pricing", { url: "https://example.com/pricing", label: "Example pricing" }));
  await version("v0", "pricing", t0, "create", { text: TEXT0, facts_json: facts("$20"), facts_status: "ok" });
  await insertRun(db, run("noise-1", "pricing", ago(2 * DAY), { outcome: "changed", noise_suppressed: 1, noise_reason: "flap" }));
  await version("v1", "pricing", t1, "webhook", {
    text: TEXT1,
    summary: "Pro went from $20 to $25.",
    summary_source: "tinyfish",
    delta_json: delta([1, 1, 1]),
    thumb_key: "thumbs/v1.jpg",
    facts_json: facts("$25"),
    facts_status: "ok",
  });
  return { t0, t1 };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

// --- BlockText and wordDiff ---------------------------------------------------------------------

describe("BlockText", () => {
  it("renders a recorded block as text, never as markup", () => {
    expect(render(<BlockText text={"### Pro plan"} />)).not.toContain("#");
    expect(render(<BlockText text={"### Pro plan"} />)).toContain("Pro plan");
    expect(render(<BlockText text={"* [Docs](javascript:alert(1)) cost **$20**"} />)).toContain("Docs cost $20");
    expect(render(<BlockText text={"* [Docs](javascript:alert(1))"} />)).not.toContain("javascript:");
    expect(render(<BlockText text={"<img src=x onerror=alert(1)>"} />)).toContain("&lt;img");
    expect(render(<BlockText text={"<img src=x onerror=alert(1)>"} />)).not.toContain("<img");
    expect(render(<BlockText text={`Text ${XSS} and "quotes" & 'more'`} />)).not.toContain("<script>");
  });

  it("keeps list items, images, code and tables readable", () => {
    const list = render(<BlockText text={"* One\n- Two\n+ Three"} />);
    expect(count(list, "<li")).toBe(3);
    expect(list).not.toMatch(/[*+]\s/);
    const ordered = render(<BlockText text={"3. Third\n4. Fourth"} />);
    expect(ordered).toMatch(/<ol[^>]*start="3"/);
    expect(count(ordered, "<li")).toBe(2);
    expect(render(<BlockText text={"![Pricing chart](https://x.example/a.png)"} />)).toContain("[image: Pricing chart]");
    expect(render(<BlockText text={"![](https://x.example/a.png)"} />)).toContain("[image]");
    expect(render(<BlockText text={"Use `admin_user` here"} />)).toMatch(/<code[^>]*>admin_user<\/code>/);
    expect(render(<BlockText text={"Call snake_case_name or __init__ with *care* and _style_"} />)).toContain("Call snake_case_name or init with care and style");
    const table = render(<BlockText text={"| Plan | Price |\n| --- | --- |\n| Pro | $20 |"} />);
    expect(table).toContain("| Pro | $20 |");
    expect(table).not.toContain("---");
    expect(count(table, 'class="bt-row"')).toBe(2);
    expect(render(<BlockText text={"\\*not emphasis\\* and \\[not a link\\](x)"} />)).toContain("*not emphasis* and [not a link](x)");
  });

  it("says a block as plain text, which the word marks are taken over", () => {
    expect(plainText("## Pro plan")).toBe("Pro plan");
    expect(plainText("* [Docs](https://a.example) cost **$20**\n* Two")).toBe("Docs cost $20\nTwo");
    expect(plainText("| Pro | $20 |\n|---|---|")).toBe("| Pro | $20 |");
  });

  it("puts word marks on the right words, with the block's structure kept", () => {
    const before = "* Pro costs **$20** per month\n* Team stays";
    const after = "* Pro costs **$25** per month\n* Team stays";
    const d = wordDiff(plainText(before), plainText(after))!;
    const left = render(<BlockText text={before} marks={{ parts: d.before, tag: "del" }} />);
    const right = render(<BlockText text={after} marks={{ parts: d.after, tag: "ins" }} />);
    expect(left).toMatch(/<del[^>]*>\$20<\/del>/);
    expect(right).toMatch(/<ins[^>]*>\$25<\/ins>/);
    expect(count(right, "<li")).toBe(2);
    // Marks that do not belong to this text are ignored rather than misplaced.
    const wrong = render(<BlockText text={"Something else"} marks={{ parts: d.after, tag: "ins" }} />);
    expect(wrong).not.toContain("<ins");
    expect(wrong).toContain("Something else");
  });
});

describe("wordDiff", () => {
  it("marks the words that differ", () => {
    const d = wordDiff("Pro costs $20 per month", "Pro costs $25 per month")!;
    expect(d.before.filter((p) => p.mark).map((p) => p.text)).toEqual(["$20"]);
    expect(d.after.filter((p) => p.mark).map((p) => p.text)).toEqual(["$25"]);
    expect(wordDiff("a".repeat(WORD_DIFF_MAX_CHARS + 1), "b")).toBeNull();
    expect(wordDiff("a".repeat(4001), "b")).toBeNull();
  });

  it("keeps a figure whole and joins a run of changed words", () => {
    const d = wordDiff("Business costs $1,200.50 a year, billed monthly.", "Business costs $1,300.50 a year, billed yearly.")!;
    expect(d.before.filter((p) => p.mark).map((p) => p.text)).toEqual(["$1,200.50", "monthly"]);
    expect(d.after.filter((p) => p.mark).map((p) => p.text)).toEqual(["$1,300.50", "yearly"]);
    const run = wordDiff("one two three four", "one six seven four")!;
    expect(run.before.filter((p) => p.mark).map((p) => p.text)).toEqual(["two three"]);
  });

  it("always rebuilds both texts exactly from their parts", () => {
    const words = ["plan", "$20", "per", "month", "team", "the", "and", "seat", "API", "usage"];
    for (let t = 0; t < 300; t++) {
      // Every third text has line breaks in it, as a list or a table block does.
      const a = Array.from({ length: 5 + (t % 60) }, (_, i) => words[(i * 7 + t) % words.length]).join(t % 3 === 0 ? " \n" : " ");
      const b = a
        .split(" ")
        .map((w, j) => ((j * 13 + t) % 5 === 0 ? "zz" : w))
        .filter((_, j) => (j + t) % 9 !== 0)
        .join(" ");
      const d = wordDiff(a, b)!;
      expect(d.before.map((p) => p.text).join("")).toBe(a);
      expect(d.after.map((p) => p.text).join("")).toBe(b);
    }
  });

  it("marks the whole changed stretch when the budget is spent, and still rebuilds the texts", () => {
    const budget = { steps: 0 };
    const d = wordDiff("keep this one two three keep that", "keep this six seven keep that", budget)!;
    expect(d.before.filter((p) => p.mark).map((p) => p.text)).toEqual(["one two three"]);
    expect(d.after.filter((p) => p.mark).map((p) => p.text)).toEqual(["six seven"]);
    expect(d.before.map((p) => p.text).join("")).toBe("keep this one two three keep that");
    // A pair with nothing in common past its ends is one stretch each.
    const all = wordDiff("alpha beta", "gamma delta")!;
    expect(all.before).toEqual([{ text: "alpha beta", mark: true }]);
  });
});

// --- The compare view -------------------------------------------------------------------------------

describe("GET /pages/:id/compare", () => {
  it("shows the change as section groups with word marks, facts first, screenshots by path", async () => {
    const { t0, t1 } = await seedPricing();
    const html = await get("/pages/pricing/compare?from=v0&to=v1");
    expect(html).toContain("Example pricing: what changed");
    expect(html).toMatch(/From <time[^>]*>[^<]+<\/time> to <time[^>]*>[^<]+<\/time> · 1 version apart · 1 noise event suppressed between/);
    expect(html).toContain("Pro went from $20 to $25.");
    expect(html).toContain("TinyFish&#39;s summary");
    expect(html).toContain("1 added · 1 removed · 1 changed");
    expect(html).toContain("diff-added");
    expect(html).toContain("diff-removed");
    expect(count(html, 'class="diff-added"')).toBe(1);
    expect(count(html, 'class="diff-removed"')).toBe(1);
    expect(html).toMatch(/<del[^>]*>\$20<\/del>/);
    expect(html).toMatch(/<ins[^>]*>\$25<\/ins>/);
    // Section headings: the page's own, in the display face.
    expect(html).toMatch(/<h3 class="diff-section"[^>]*>Pro<\/h3>/);
    expect(html).toMatch(/<h3 class="diff-section"[^>]*>Team<\/h3>/);

    // Facts first, with the after price of a changed fact as the accent figure.
    expect(html).toMatch(/Pro[\s\S]*price[\s\S]*\$20[\s\S]*\$25/);
    expect(html.indexOf("facts-diff")).toBeLessThan(html.indexOf("diff-group"));
    expect(html).toMatch(/<td class="price is-key">\$25<\/td>/);

    // Markup in a recorded block is text, and a link's target is dropped.
    expect(html).not.toContain(XSS);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("javascript:");

    // Screenshots by path (the thumbnail when there is one), each with its evidence line.
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
    expect(html).toMatch(/<img[^>]+src="\/shots\/v0\.jpg"/);
    expect(html).toMatch(/<img[^>]+src="\/thumbs\/v1\.jpg"/);
    expect(html).toContain('href="/shots/v1.jpg"');
    expect(html).toMatch(/Source: <a[^>]+>example\.com\/pricing<\/a> · read \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC · Monitor \(baseline\)/);
    expect(html).toMatch(/Source: <a[^>]+>example\.com\/pricing<\/a> · read \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC · Monitor \(webhook\)/);

    // Links: the JSON diff with the two ISO times, and back to the page.
    const json = `/api/pages/pricing/diff?from=${encodeURIComponent(t0)}&amp;to=${encodeURIComponent(t1)}`;
    expect(html).toContain(`href="${json}">This diff as JSON</a>`);
    expect(html).toContain('href="/pages/pricing">Back to the page</a>');
    expect(count(html, "<h1")).toBe(1);
  });

  it("swaps a reversed range and answers the same", async () => {
    await seedPricing();
    const swapped = await get("/pages/pricing/compare?from=v1&to=v0");
    expect(swapped).toContain("1 added · 1 removed · 1 changed");
    expect(swapped).toMatch(/<del[^>]*>\$20<\/del>/);
  });

  it("defaults to the version before `to`, and to the latest two with neither", async () => {
    await seedPricing();
    const t2 = ago(2 * HOUR);
    await version("v2", "pricing", t2, "pull", {
      text: TEXT1.replace("Includes 10 projects.", "Includes 12 projects."),
      summary: "Pro now includes 12 projects.",
      summary_source: "diff",
      delta_json: delta([0, 0, 1]),
    });
    const onlyTo = await get("/pages/pricing/compare?to=v1");
    expect(onlyTo).toContain("Pro went from $20 to $25.");
    expect(onlyTo).toMatch(/<del[^>]*>\$20<\/del>/);
    const latest = await get("/pages/pricing/compare");
    expect(latest).toContain("Pro now includes 12 projects.");
    expect(latest).toContain("From the diff");
    expect(latest).toMatch(/<del[^>]*>10<\/del>/);
    expect(latest).toMatch(/<ins[^>]*>12<\/ins>/);
    expect(latest).toContain("0 added · 0 removed · 1 changed");
    // Only from= given: to is the latest.
    expect(await get("/pages/pricing/compare?from=v1")).toContain("Pro now includes 12 projects.");
    // Two hops: the counts cover both, and the summary says it is the newest change's.
    const both = await get("/pages/pricing/compare?from=v0&to=v2");
    expect(both).toContain("2 versions apart · 1 noise event suppressed between");
    expect(both).toContain("of the newest of these 2 changes");
  });

  it("says so for the same version twice, a page with one version, and an empty difference", async () => {
    await seedPricing();
    const same = await get("/pages/pricing/compare?from=v1&to=v1");
    expect(same).toContain("Pick two different versions.");
    expect(same).toMatch(/<form[^>]+action="\/pages\/pricing\/compare"/);
    expect(same).not.toContain("diff-group");

    await insertPage(db, page("single", { label: "Single page" }));
    await version("s0", "single", ago(DAY), "create");
    const one = await get("/pages/single/compare");
    expect(one).toContain("There is nothing to compare yet: this page has one recorded version.");
    expect(await get("/pages/single/compare?to=s0")).toContain("There is nothing to compare yet");

    await insertPage(db, page("empty", { label: "Empty page" }));
    expect(await get("/pages/empty/compare")).toContain("There is nothing to compare yet");

    // Two versions whose cleaned text is the same.
    await insertPage(db, page("twin", { label: "Twin page" }));
    await version("w0", "twin", ago(2 * DAY), "create", { text: "Same words." });
    await version("w1", "twin", ago(DAY), "webhook", { text: "Same words.", summary: "Nothing in the text.", summary_source: "diff" });
    expect(await get("/pages/twin/compare")).toContain("The cleaned text is the same in both versions.");
  });

  it("answers the ledger 404 for an unknown page or a version that is not this page's, after one query", async () => {
    await seedPricing();
    await insertPage(db, page("other", { label: "Other page" }));
    await version("o0", "other", ago(DAY), "create");
    for (const path of [
      "/pages/nope/compare",
      "/pages/pricing/compare?from=nope&to=v1",
      "/pages/pricing/compare?to=nope",
      "/pages/pricing/compare?from=o0&to=v1",
      "/pages/pricing/compare?from=v0&to=o0",
    ]) {
      const res = await fetchPath(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain("No such page in the ledger.");
    }
    const prepare = vi.spyOn(env.DB, "prepare");
    try {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://x/pages/nope/compare?from=a&to=b"), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(404);
      await res.text();
      expect(prepare.mock.calls.length).toBe(1);
    } finally {
      prepare.mockRestore();
    }
  });

  it("reads the diff once and then from the cache: fifteen queries, then ten (one of them the section order)", async () => {
    await seedPricing();
    const prepare = vi.spyOn(env.DB, "prepare");
    const queries = async (): Promise<number> => {
      prepare.mockClear();
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://x/pages/pricing/compare?from=v0&to=v1"), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("1 added · 1 removed · 1 changed");
      return prepare.mock.calls.length;
    };
    try {
      expect(await queries()).toBe(15);
      expect(await queries()).toBe(10);
    } finally {
      prepare.mockRestore();
    }
  });

  it("labels a layout-only change and still shows its blocks", async () => {
    await seedPricing();
    await version("v2", "pricing", ago(HOUR), "webhook", {
      text: TEXT1.replace("Team costs $40 per seat.", "Team costs $40 per seat, billed monthly."),
      summary: "The table was rebuilt.",
      summary_source: "diff",
      delta_json: delta([0, 0, 1], true),
    });
    const html = await get("/pages/pricing/compare?from=v1&to=v2");
    expect(html).toContain("Layout only");
    expect(html).toContain("Same words and figures, different structure.");
    expect(html).toContain("0 added · 0 removed · 1 changed");
    expect(html).toMatch(/<ins[^>]*>, billed monthly<\/ins>/);
  });

  it("shows a screenshot that is not there in words, never as a broken image", async () => {
    await seedPricing();
    await version("v2", "pricing", ago(10 * MIN), "webhook", {
      text: TEXT1.replace("$25", "$30"),
      summary: "Pro went to $30.",
      summary_source: "tinyfish",
      screenshot_key: null,
      html_key: null,
      capture_status: "pending",
    });
    await version("v3", "pricing", ago(5 * MIN), "webhook", {
      text: TEXT1.replace("$25", "$35"),
      summary: "Pro went to $35.",
      summary_source: "tinyfish",
      screenshot_key: null,
      html_key: null,
      capture_status: "failed",
    });
    const pending = await get("/pages/pricing/compare?from=v1&to=v2");
    expect(pending).toContain("Taking the screenshot…");
    expect(pending).not.toMatch(/<img[^>]+src="[^"]*\/shots\/v2/);
    const failed = await get("/pages/pricing/compare?from=v2&to=v3");
    expect(failed).toContain("Screenshot unavailable.");
    expect(failed).toContain(">Live page</a>");
  });

  it("caps each section group and shows all with all=1", async () => {
    expect(BLOCKS_PER_GROUP).toBe(30);
    expect(WORD_DIFF_PAIRS).toBe(40);
    expect(WORD_DIFF_CHARS).toBeGreaterThan(0);
    const head = "# Release notes\n\n## Notes\n\nThe first note.";
    const tail = "## Older\n\nAn older note.";
    const notes = Array.from({ length: 60 }, (_, i) => `Note number ${i + 1}: something new about release ${i + 1} arrived today.`);
    await insertPage(db, page("notes", { label: "Release notes", kind: "other" }));
    await version("n0", "notes", ago(2 * DAY), "create", { text: `${head}\n\n${tail}` });
    await version("n1", "notes", ago(DAY), "webhook", {
      text: `${head}\n\n${notes.join("\n\n")}\n\n${tail}`,
      summary: "Sixty notes were added.",
      summary_source: "diff",
      delta_json: delta([60, 0, 0]),
    });
    const bigUrl = "/pages/notes/compare?from=n0&to=n1";
    const bigHtml = await get(bigUrl);
    expect(count(bigHtml, "diff-added")).toBe(30);
    expect(bigHtml).toContain("Show all 60");
    expect(bigHtml).toContain("60 added · 0 removed · 0 changed");
    expect(count(await get(bigUrl + "&all=1"), "diff-added")).toBe(60);
    expect(await get(bigUrl + "&all=1")).not.toContain("Show all 60");
  });

  it("gives word marks to the first pairs only and shows the rest side by side", async () => {
    const before = Array.from({ length: 45 }, (_, i) => `Item ${i + 1} costs $${i + 10} per month for every member.`);
    const after = before.map((b, i) => b.replace(`$${i + 10}`, `$${i + 20}`));
    await insertPage(db, page("many", { label: "Many prices" }));
    await version("m0", "many", ago(2 * DAY), "create", { text: before.join("\n\n") });
    await version("m1", "many", ago(DAY), "webhook", { text: after.join("\n\n"), summary: "Every price moved.", summary_source: "diff", delta_json: delta([0, 0, 45]) });
    const html = await get("/pages/many/compare?all=1");
    expect(html).toContain("0 added · 0 removed · 45 changed");
    expect(count(html, "<del")).toBe(WORD_DIFF_PAIRS);
    expect(count(html, "<ins")).toBe(WORD_DIFF_PAIRS);
    expect(count(html, 'class="pair')).toBe(45);
  });

  it("shows a long block in part: around the change when it changed, from its start when it was added", async () => {
    // A page with no blank lines is one block: 600 sentences, one price changed in the middle.
    const sentences = Array.from({ length: 600 }, (_, i) => `Sentence ${i} about the plan.`);
    const before = sentences.join(" ");
    const after = before.replace("Sentence 300 about the plan.", "Sentence 300 about the plan, now $25.");
    const added = Array.from({ length: 400 }, (_, i) => `Added sentence ${i}.`).join(" ");
    await insertPage(db, page("wall", { label: "Wall of text" }));
    await version("wall-0", "wall", ago(2 * DAY), "create", { text: `${before}\n\nEnd.` });
    await version("wall-1", "wall", ago(DAY), "webhook", { text: `${after}\n\nEnd.\n\n${added}`, summary: "One price.", summary_source: "diff", delta_json: delta([1, 0, 1]) });
    const html = await get("/pages/wall/compare");
    expect(html).toMatch(/<ins[^>]*>, now \$25<\/ins>/);
    expect(html).toContain("Sentence 299 about the plan.");
    expect(html).not.toContain("Sentence 10 about the plan.");
    expect(html).not.toContain("Sentence 590 about the plan.");
    expect(html).toMatch(/A long block \([\d,]+ characters before, [\d,]+ after\): only the part around the change is shown\./);
    expect(html).toContain("Added sentence 1.");
    expect(html).not.toContain("Added sentence 399.");
    expect(html).toMatch(/A long block: the first [\d,]+ of its [\d,]+ characters are shown\./);
  });

  it("shares the JSON route's diff and its cache", async () => {
    const { t0, t1 } = await seedPricing();
    await get("/pages/pricing/compare?from=v0&to=v1");
    const rows = await db.prepare("SELECT from_version_id, to_version_id, json FROM diff_cache").all<{ from_version_id: string; to_version_id: string; json: string }>();
    expect(rows.results.map((r) => `${r.from_version_id}>${r.to_version_id}`)).toEqual(["v0>v1"]);
    const res = await fetchPath(`/api/pages/pricing/diff?from=${encodeURIComponent(t0)}&to=${encodeURIComponent(t1)}`);
    expect(await res.text()).toBe(rows.results[0]!.json);
    const diff = (await getDiff(env, "pricing", "v0", "v1"))!;
    expect(diff.blocks.changed).toEqual([{ section: "Pro", before: "Pro costs $20 per month.", after: "Pro costs $25 per month." }]);
    expect(diff.hops).toBe(1);
    expect(await getDiff(env, "pricing", "v0", "o0")).toBeNull();
    expect(await getDiff(env, "nope", "v0", "v1")).toBeNull();
  });

  it("answers as before when the site is switched off", async () => {
    await seedPricing();
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://x/pages/pricing/compare"), { ...env, SITE_ENABLED: "0" } as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
  });
});

// --- The home's featured catch -------------------------------------------------------------------------

describe("the featured catch on the home screen", () => {
  it("shows one changed block before and after, with the screenshots and the links", async () => {
    await seedPricing();
    const home = await get("/");
    expect(home).toContain("The latest catch, up close");
    expect(home).toMatch(/<del[^>]*>\$20<\/del>/);
    expect(home).toMatch(/<ins[^>]*>\$25<\/ins>/);
    expect(home).toContain("Open the full comparison");
    expect(home).toContain('href="/pages/pricing/compare?from=v0&amp;to=v1"');
    expect(home).toContain("See this page&#39;s history");
    expect(count(home, "The page as it was read on")).toBe(2);
    expect(home).toMatch(/<img[^>]+src="\/shots\/v0\.jpg"/);
    expect(home).toMatch(/<img[^>]+src="\/thumbs\/v1\.jpg"/);
    expect(home).not.toMatch(/<img[^>]+src="https?:/);
    // Between the hero and the feed.
    expect(home.indexOf("The latest catch, up close")).toBeGreaterThan(home.indexOf('class="hero"'));
    expect(home.indexOf("The latest catch, up close")).toBeLessThan(home.indexOf("Every change, newest first"));
    // Only the block that changed, cut to its lines.
    expect(home).not.toContain("An old footnote that goes away.</p>");
  });

  it("leaves the section out when no recent change has a small changed block", async () => {
    await insertPage(db, page("huge", { label: "Huge block page" }));
    const long = "word ".repeat(400).trim();
    await version("h0", "huge", ago(2 * DAY), "create", { text: `${long} ends here.` });
    await version("h1", "huge", ago(DAY), "webhook", { text: `${long} ends there.`, summary: "A long paragraph changed.", summary_source: "diff", delta_json: delta([0, 0, 1]) });
    const homeWithOnlyHugeChanges = await get("/");
    expect(homeWithOnlyHugeChanges).not.toContain("The latest catch, up close");
    expect(homeWithOnlyHugeChanges).toContain("Every change, newest first");
  });

  it("skips layout-only changes, changes without a changed block or a delta, and retired pages", async () => {
    await seedPricing();
    await updatePage(db, "pricing", { status: "retired" });
    await insertPage(db, page("layout", { label: "Layout page" }));
    await version("l0", "layout", ago(2 * DAY), "create", { text: "Pro costs $20." });
    await version("l1", "layout", ago(HOUR), "webhook", { text: "Pro costs $20!", delta_json: delta([0, 0, 1], true) });
    await insertPage(db, page("added", { label: "Added page" }));
    await version("a0", "added", ago(2 * DAY), "create", { text: "First." });
    await version("a1", "added", ago(2 * HOUR), "webhook", { text: "First.\n\nSecond.", delta_json: delta([1, 0, 0]) });
    await insertPage(db, page("nodelta", { label: "No delta page" }));
    await version("d0", "nodelta", ago(2 * DAY), "create", { text: "Pro costs $20." });
    await version("d1", "nodelta", ago(3 * HOUR), "webhook", { text: "Pro costs $30." });
    expect(await get("/")).not.toContain("The latest catch, up close");
    expect(await featuredCatch(env, await listChanges(env, { limit: 10, includeRetired: false }))).toBeNull();
  });

  it("does not diff a large page, and features it once its diff is in the cache", async () => {
    const filler = Array.from({ length: 700 }, (_, i) => `Paragraph ${i} of the release notes, with enough words to fill the page.`).join("\n\n");
    expect(filler.length).toBeGreaterThan(FEATURE_TEXT_CAP);
    const t0 = ago(2 * DAY);
    const t1 = ago(DAY);
    await insertPage(db, page("big", { label: "Big notes", kind: "other" }));
    await version("b0", "big", t0, "create", { text: `Pro costs $20 per month.\n\n${filler}` });
    await version("b1", "big", t1, "webhook", { text: `Pro costs $25 per month.\n\n${filler}`, summary: "Pro went to $25.", summary_source: "tinyfish", delta_json: delta([0, 0, 1]) });
    expect(await get("/")).not.toContain("The latest catch, up close");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM diff_cache").first<{ n: number }>())!.n).toBe(0);

    // Someone opens the comparison: the diff is stored, and the home reads it from there.
    await get(`/api/pages/big/diff?from=${encodeURIComponent(t0)}&to=${encodeURIComponent(t1)}`);
    const home = await get("/");
    expect(home).toContain("The latest catch, up close");
    expect(home).toMatch(/<del[^>]*>\$20<\/del>/);
  });

  it("adds a bounded number of queries to the home, and none when there is no candidate", async () => {
    await seedPricing();
    const prepare = vi.spyOn(env.DB, "prepare");
    const queries = async (): Promise<string[]> => {
      prepare.mockClear();
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://x/"), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("The latest catch, up close");
      return prepare.mock.calls.map((call) => String(call[0]));
    };
    try {
      const cold = await queries();
      const warm = await queries();
      // Nine for the home itself; the featured catch adds its candidate query, the two versions and the
      // page, and the cached diff (warm), or the diff's own reads and the cache write (cold, once).
      expect(cold.length).toBe(19);
      expect(warm.length).toBe(14);
      // The warm home never reads a version's text.
      expect(warm.some((sql) => /SELECT\s+\*\s+FROM\s+versions/i.test(sql))).toBe(false);
    } finally {
      prepare.mockRestore();
    }
    await reset();
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    await insertPage(db, page("quiet", { label: "Quiet page" }));
    await version("q0", "quiet", ago(DAY), "create");
    const spy = vi.spyOn(env.DB, "prepare");
    try {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://x/"), env, ctx);
      await waitOnExecutionContext(ctx);
      await res.text();
      expect(spy.mock.calls.length).toBeLessThanOrEqual(9);
    } finally {
      spy.mockRestore();
    }
  });

  it("is left out of the older screens of the feed", async () => {
    await seedPricing();
    expect(await get(`/?before=${encodeURIComponent(new Date().toISOString())}`)).not.toContain("The latest catch, up close");
  });
});

// --- Fix round: bounded work on any recorded text -----------------------------------------------------

/**
 * Milliseconds `work` takes. The Workers test pool's clock moves during synchronous work, to the millisecond
 * (checked on 7 Nov: a 30-million-step loop read 109 ms on performance.now() and on Date.now()), so only bounds
 * far above a millisecond mean anything.
 */
function timed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

describe("BlockText on hostile text stays linear", () => {
  const cases: [string, (n: number) => string][] = [
    ["unclosed [", (n) => "[".repeat(n)],
    ["[a]( without )", (n) => "[a](".repeat(n / 4)],
    ["unclosed ![", (n) => "![".repeat(n / 2)],
    ["[]( without )", (n) => "[](".repeat(n / 3)],
    ["deep nesting", (n) => `${"[".repeat(n)}a${"](x)".repeat(n)}`],
    ["backticks", (n) => "`a".repeat(n / 2)],
    ["emphasis runs", (n) => "*_".repeat(n / 2)],
    ["heading with trailing spaces", (n) => `# a${" ".repeat(n)}x`],
    ["rule-like spaces", (n) => `${" ".repeat(n)}-x`],
  ];
  for (const [name, make] of cases) {
    it(`renders ${name} at 40,000 characters in well under a quadratic time`, () => {
      const large = make(40_000);
      // Quadratic work would take seconds here.
      expect(timed(() => render(<BlockText text={large} />))).toBeLessThan(150);
      expect(timed(() => plainText(`${large}${name}`))).toBeLessThan(150);
    });
  }

  it("never throws on deep nesting, and keeps link targets out at any depth", () => {
    const deep = `${"[".repeat(20_000)}label${"](javascript:alert(1))".repeat(20_000)}`;
    expect(() => plainText(deep)).not.toThrow();
    const shallow = render(<BlockText text={"[[[[a](javascript:x)](javascript:y)](javascript:z)](javascript:w)"} />);
    expect(shallow).toContain("a");
    expect(shallow).not.toContain("javascript:");
  });

  it("still reads ordinary links, images, code and emphasis", () => {
    expect(plainText("See [the **docs**](https://a.example/x_(y)) and ![chart](c.png), `x[1]` and _this_.")).toBe(
      "See the docs and [image: chart], x[1] and this.",
    );
    expect(plainText("# Title ##")).toBe("Title");
    expect(plainText("## C#")).toBe("C#");
    expect(plainText("  - item")).toBe("item");
    expect(plainText("| a | b |\n|:--|--:|")).toBe("| a | b |");
  });
});

describe("a screen-wide budget for blocks", () => {
  const sectionText = (n: number, per: number, len: number) =>
    Array.from({ length: n }, (_, s) =>
      [`## Section ${s + 1}`, ...Array.from({ length: per }, (_, i) => `Block ${s + 1}.${i + 1} ${"x".repeat(Math.max(0, len - 20))}.`)].join("\n\n"),
    ).join("\n\n");

  async function seedAdded(id: string, text: string): Promise<void> {
    await insertPage(db, page(id, { label: id }));
    await version(`${id}-0`, id, ago(2 * DAY), "create", { text: "# Start" });
    await version(`${id}-1`, id, ago(DAY), "webhook", { text: `# Start\n\n${text}`, summary: "Many blocks.", summary_source: "diff", delta_json: delta([1, 0, 0]) });
  }

  it("shows at most 120 blocks on a screen, and says how many more there are", async () => {
    // Five sections of a heading and 40 blocks: 205 added blocks, 30 a group, and the screen stops at 120.
    await seedAdded("sections", sectionText(5, 40, 60));
    const html = await get("/pages/sections/compare");
    expect(count(html, 'class="diff-added"')).toBe(120);
    expect(html).toContain("85 more blocks are not shown here.");
    expect(html).toMatch(/<a[^>]+href="\/pages\/sections\/compare\?from=sections-0&amp;to=sections-1&amp;all=1[^"]*"[^>]*>Show all 205<\/a>/);
    const all = await get("/pages/sections/compare?all=1");
    expect(count(all, 'class="diff-added"')).toBe(205);
    expect(all).not.toContain("more blocks are not shown");
  });

  it("stops at about 60,000 characters on a screen", async () => {
    await seedAdded("heavy", sectionText(1, 25, 3000).replace(/^## Section 1\n\n/, ""));
    const html = await get("/pages/heavy/compare");
    const shown = count(html, 'class="diff-added"');
    expect(shown).toBeGreaterThanOrEqual(19);
    expect(shown).toBeLessThanOrEqual(21);
    expect(html).toContain(`${25 - shown} more blocks are not shown here.`);
  });

  it("gives all=1 a ceiling too, and points to the JSON past it", async () => {
    await seedAdded("ceiling", Array.from({ length: 450 }, (_, i) => `Line ${i + 1} of the list.`).join("\n\n"));
    const html = await get("/pages/ceiling/compare?all=1");
    expect(count(html, 'class="diff-added"')).toBe(400);
    expect(html).toContain("50 more blocks are past what one page shows.");
    expect(html).toMatch(/href="\/api\/pages\/ceiling\/diff\?from=[^"]+">This diff as JSON<\/a> has every block\./);
  });

  it("counts code spans and emphasis marks against the screen, not only characters", async () => {
    // 25 blocks of 2,800 characters: about 21 fit the characters, but each is some 1,400 steps of work (a code
    // span and a space a word), so the screen stops at SCREEN_WORK.
    const dense = Array.from({ length: 25 }, (_, i) => `${"`a` ".repeat(700)}block ${i + 1}`).join("\n\n");
    await seedAdded("dense", dense);
    const html = await get("/pages/dense/compare");
    const shown = count(html, 'class="diff-added"');
    expect(shown).toBeGreaterThanOrEqual(3);
    expect(shown).toBeLessThanOrEqual(5);
    expect(html).toContain(`${25 - shown} more blocks are not shown here.`);
    // Emphasis is dropped, not drawn, but each mark is still a stop of the walk.
    const starred = Array.from({ length: 25 }, (_, i) => `${"*a* ".repeat(700)}block ${i + 1}`).join("\n\n");
    await seedAdded("starred", starred);
    const stars = await get("/pages/starred/compare");
    expect(count(stars, 'class="diff-added"')).toBeLessThanOrEqual(3);
    expect(stars).toContain("more blocks are not shown here.");
  });

  it("marks the shortest changed blocks first, and says so at a block it could not mark", async () => {
    const long = (n: number, end: string) => `Long paragraph ${n} ${"word ".repeat(700)}${end}`;
    const short = (n: number, end: string) => `Short paragraph ${n} ${"term ".repeat(300)}${end}`;
    const text = (end: string) =>
      ["# Notes", long(1, end), long(2, end), long(3, end), ...[1, 2, 3, 4, 5, 6].map((n) => short(n, end))].join("\n\n");
    await insertPage(db, page("marks", { label: "Marks" }));
    await version("mk0", "marks", ago(2 * DAY), "create", { text: text("closing old") });
    await version("mk1", "marks", ago(DAY), "webhook", { text: text("closing new"), summary: "Nine.", summary_source: "diff", delta_json: delta([0, 0, 9]) });
    const html = await get("/pages/marks/compare");
    expect(count(html, 'class="pair"')).toBe(9);
    // 20,000 characters of marks: the six short pairs (about 3,000 each) fit; the three long ones (7,000) do not.
    expect(count(html, "<del>old</del>")).toBe(6);
    expect(count(html, "No word marks on this block: it is past what one screen marks.")).toBe(3);
    expect(html).toContain("Word marks are shown on 6 changed blocks of the 9 on this screen.");
  });

  it("renders a release-notes-sized diff (300 added, 100 changed, 50 sections) quickly", async () => {
    const para = (i: number) => `Release ${i}: the model now supports **longer** context, see [docs](https://example.com/docs/${i}) and \`api\` details. `.repeat(6);
    const before = Array.from({ length: 50 }, (_, s) => [`## Release ${s}`, ...Array.from({ length: 2 }, (_, i) => `${para(s * 10 + i)} old ${s}.${i}`)].join("\n\n")).join("\n\n");
    const after = Array.from({ length: 50 }, (_, s) =>
      [`## Release ${s}`, ...Array.from({ length: 2 }, (_, i) => `${para(s * 10 + i)} new ${s}.${i}`), ...Array.from({ length: 6 }, (_, i) => `${para(s * 100 + i)} added`)].join("\n\n"),
    ).join("\n\n");
    await insertPage(db, page("notes2", { label: "Notes", kind: "other" }));
    await version("nn0", "notes2", ago(2 * DAY), "create", { text: before });
    await version("nn1", "notes2", ago(DAY), "webhook", { text: after, summary: "A lot.", summary_source: "diff", delta_json: delta([300, 0, 100]) });
    await get("/pages/notes2/compare"); // stores the diff
    const start = performance.now();
    const html = await get("/pages/notes2/compare");
    expect(performance.now() - start).toBeLessThan(400);
    expect(count(html, 'class="diff-added"') + count(html, 'class="pair"')).toBeLessThanOrEqual(120);
  });
});

describe("the fix round's smaller items", () => {
  it("tells a screen reader what a mark means, in CSS around the marks only", async () => {
    // Through the service binding, which reaches the static files as a request from outside does.
    const css = await (await env.SELF.fetch("https://x/assets/site.css")).text();
    expect(css).toMatch(/\.diff-before del::before\s*\{[^}]*content:\s*"/);
    expect(css).toMatch(/\.diff-after ins::before\s*\{[^}]*content:\s*"/);
    expect(css).toMatch(/\.diff-before del::after/);
    expect(css).toMatch(/\.diff-after ins::after/);
    // The marks' own look is scoped to the diff sides too.
    expect(css).not.toMatch(/(^|\n)del\s*\{/);
    expect(css).not.toMatch(/(^|\n)ins\s*\{/);
    // And the mark itself stays bare, so the price is the whole of its text.
    await seedPricing();
    expect(await get("/pages/pricing/compare")).toMatch(/<del>\$20<\/del>/);
  });

  it("survives a stored diff without blocks", async () => {
    await seedPricing();
    await db
      .prepare("INSERT INTO diff_cache (from_version_id, to_version_id, json, created_at) VALUES ('v0', 'v1', ?, ?)")
      .bind(JSON.stringify({ cached: true }), ago(HOUR))
      .run();
    const html = await get("/pages/pricing/compare?from=v0&to=v1");
    expect(html).toContain("The cleaned text is the same in both versions.");
  });

  it("puts the accent on the first changed price only", async () => {
    await insertPage(db, page("twoprices", { label: "Two prices" }));
    const f = (pro: string, team: string) =>
      JSON.stringify([
        { name: "Pro", price: pro, unit: null, notes: null },
        { name: "Team", price: team, unit: null, notes: null },
      ]);
    await version("tp0", "twoprices", ago(2 * DAY), "create", { text: "Pro $20. Team $40.", facts_json: f("$20", "$40"), facts_status: "ok" });
    await version("tp1", "twoprices", ago(DAY), "webhook", { text: "Pro $25. Team $45.", facts_json: f("$25", "$45"), facts_status: "ok", summary: "Both moved.", summary_source: "diff" });
    const html = await get("/pages/twoprices/compare");
    expect(count(html, "is-key")).toBe(1);
    expect(html).toMatch(/<td class="price is-key">\$25<\/td>/);
  });

  it("orders sections as the page does, a removed section where it was", async () => {
    const proOld = "The Pro plan costs $20 per month for every seat on the team.";
    const proNew = "The Pro plan costs $25 per month for every seat on the team.";
    const teamOld = "The Team plan includes ten projects and a shared workspace for all.";
    const teamNew = "The Team plan includes twelve projects and a shared workspace for all.";
    const before = ["# Plans", "## Pro", proOld, "## Legacy", "The legacy plan is still sold to old customers.", "## Team", teamOld].join("\n\n");
    const after = ["# Plans", "## Launch", "A launch offer was added for new customers.", "## Pro", proNew, "## Team", teamNew].join("\n\n");
    await insertPage(db, page("order", { label: "Order page" }));
    await version("o-0", "order", ago(2 * DAY), "create", { text: before });
    await version("o-1", "order", ago(DAY), "webhook", { text: after, summary: "Several.", summary_source: "diff" });
    const html = await get("/pages/order/compare");
    const sections = [...html.matchAll(/<h3 class="diff-section"[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(sections).toEqual(["Launch", "Pro", "Legacy", "Team"]);
  });

  it("finds a heading that ends in spaces, not a longer heading that starts with the same words", async () => {
    const proOld = "The Pro plan costs $20 per month for every seat on the team.";
    const proNew = "The Pro plan costs $25 per month for every seat on the team.";
    const teamOld = "The Team plan includes ten projects and a shared workspace for all.";
    const teamNew = "The Team plan includes twelve projects and a shared workspace for all.";
    const extras = "Extras cost $5 per month for every seat on any plan.";
    // "## Pro  " ends in two spaces, and "## Pro team extras" comes before it; Legacy is only in the older text,
    // so the order is searched for, not read from the diff.
    const before = ["# Plans", "## Pro team extras", extras, "## Team", teamOld, "## Legacy", "The legacy plan is still sold.", "## Pro  ", proOld].join("\n\n");
    const after = ["# Plans", "## Pro team extras", extras, "## Team", teamNew, "## Pro  ", proNew].join("\n\n");
    await insertPage(db, page("spaces", { label: "Spaces" }));
    await version("sp-0", "spaces", ago(2 * DAY), "create", { text: before });
    await version("sp-1", "spaces", ago(DAY), "webhook", { text: after, summary: "Two.", summary_source: "diff" });
    const html = await get("/pages/spaces/compare");
    const sections = [...html.matchAll(/<h3 class="diff-section"[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(sections).toEqual(["Team", "Legacy", "Pro"]);
  });

  it("reads the section order from the diff when its lists settle it, without searching the texts", async () => {
    const c = (section: string) => ({ section, before: "x", after: "y" });
    const b = (section: string) => ({ section, text: section });
    const order = (places: ReturnType<typeof placesFromDiff>) => (places === null ? null : [...places.keys()]);
    expect(order(placesFromDiff({ changed: [c("B"), c("A"), c("C")], added: [], removed: [] }))).toEqual(["B", "A", "C"]);
    expect(order(placesFromDiff({ changed: [c(""), c("A"), c("B")], added: [b("B"), b("C")], removed: [b("A")] }))).toEqual(["A", "B", "C"]);
    // A choice left (B could go anywhere), lists that disagree, or a removed section the newer text may not have.
    expect(placesFromDiff({ changed: [c("A"), c("C")], added: [b("B")], removed: [] })).toBeNull();
    expect(placesFromDiff({ changed: [c("A"), c("B")], added: [b("B"), b("A")], removed: [] })).toBeNull();
    expect(placesFromDiff({ changed: [c("A")], added: [], removed: [b("Legacy")] })).toBeNull();

    const text = (n: number) => ["# Notes", "## May", `May notes, take ${n}, with enough words to pair.`, "## April", `April notes, take ${n}, with enough words to pair.`].join("\n\n");
    await insertPage(db, page("settled", { label: "Settled" }));
    await version("st-0", "settled", ago(2 * DAY), "create", { text: text(1) });
    await version("st-1", "settled", ago(DAY), "webhook", { text: text(2), summary: "Both.", summary_source: "diff", delta_json: delta([0, 0, 2]) });
    const prepare = vi.spyOn(env.DB, "prepare");
    try {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://x/pages/settled/compare"), env, ctx);
      await waitOnExecutionContext(ctx);
      const html = await res.text();
      expect([...html.matchAll(/<h3 class="diff-section"[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1])).toEqual(["May", "April"]);
      expect(prepare.mock.calls.some((call) => String(call[0]).includes("instr("))).toBe(false);
    } finally {
      prepare.mockRestore();
    }
  });

  it("reads no text on the home for a large page whose diff is not stored", async () => {
    const filler = Array.from({ length: 700 }, (_, i) => `Paragraph ${i} of the release notes, with enough words to fill the page.`).join("\n\n");
    await insertPage(db, page("bigtext", { label: "Big text", kind: "other" }));
    await version("bt0", "bigtext", ago(2 * DAY), "create", { text: `Pro costs $20 per month.\n\n${filler}` });
    await version("bt1", "bigtext", ago(DAY), "webhook", { text: `Pro costs $25 per month.\n\n${filler}`, summary: "Pro went to $25.", summary_source: "tinyfish", delta_json: delta([0, 0, 1]) });
    const prepare = vi.spyOn(env.DB, "prepare");
    try {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://x/"), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(await res.text()).not.toContain("The latest catch, up close");
      const sql = prepare.mock.calls.map((call) => String(call[0]));
      expect(sql.some((q) => /SELECT\s+\*\s+FROM\s+versions/i.test(q))).toBe(false);
      expect(sql.some((q) => /FROM pages WHERE id = \?/.test(q))).toBe(false);
    } finally {
      prepare.mockRestore();
    }
  });

  it("keeps a hostile changed block out of the featured catch, and the home fast", async () => {
    await insertPage(db, page("brackets", { label: "Brackets" }));
    await version("br0", "brackets", ago(2 * DAY), "create", { text: `Price $20 ${"[".repeat(25_000)}` });
    await version("br1", "brackets", ago(DAY), "webhook", { text: `Price $25 ${"[".repeat(25_000)}`, summary: "Price.", summary_source: "diff", delta_json: delta([0, 0, 1]) });
    for (let i = 0; i < 2; i++) {
      const start = performance.now();
      const home = await get("/");
      expect(performance.now() - start).toBeLessThan(500);
      expect(home).not.toContain("The latest catch, up close");
    }
    const start = performance.now();
    const compare = await get("/pages/brackets/compare");
    expect(performance.now() - start).toBeLessThan(500);
    expect(compare).toMatch(/<del>\$20<\/del>/);
  });
});

describe("large diffs are stored by the hourly job", () => {
  const big = (tag: string) => Array.from({ length: 800 }, (_, i) => `Paragraph ${i} of the ${tag} notes, long enough to fill the page.`).join("\n\n");

  async function pair(id: string, over: Partial<NewVersion> = {}, text = big(id), daysAgo = 1): Promise<void> {
    await insertPage(db, page(id, { label: id }));
    await version(`${id}-0`, id, ago((daysAgo + 1) * DAY), "create", { text });
    await version(`${id}-1`, id, ago(daysAgo * DAY), "webhook", {
      text: `${text}\n\nOne more paragraph.`,
      summary: "One more.",
      summary_source: "diff",
      delta_json: delta([1, 0, 0]),
      ...over,
    });
  }

  /** The hourly job's window: versions captured in the last 14 days. */
  const window = () => ago(14 * DAY);

  it("lists the large adjacent pairs whose ends are final and whose diff is not stored", async () => {
    await pair("warm-a");
    await pair("warm-old", {}, big("warm-old"), 20);
    await pair("warm-pending", { capture_status: "pending" });
    await pair("warm-facts", { agent_run_id: "run-in-flight", facts_json: null });
    await pair("warm-nodelta", { delta_json: null });
    await pair("warm-nosummary", { summary: null, summary_source: null });
    await pair("warm-small", {}, "Short text.");
    await pair("warm-cached");
    await db
      .prepare("INSERT INTO diff_cache (from_version_id, to_version_id, json, created_at) VALUES ('warm-cached-0', 'warm-cached-1', '{}', ?)")
      .bind(ago(HOUR))
      .run();
    expect(await diffsToWarm(db, FEATURE_TEXT_CAP, 10, window())).toEqual([{ id: "warm-a-1", previous_id: "warm-a-0" }]);
    // A pair captured 20 days ago is listed only when the window reaches back to it.
    expect(await diffsToWarm(db, FEATURE_TEXT_CAP, 10, ago(30 * DAY))).toEqual([
      { id: "warm-a-1", previous_id: "warm-a-0" },
      { id: "warm-old-1", previous_id: "warm-old-0" },
    ]);
  });

  it("stores one pair's diff through the admin route, the text the JSON route then serves", async () => {
    await pair("warm-b");
    const post = (path: string, token?: string) =>
      SELF.fetch(`https://x${path}`, { method: "POST", headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } });
    expect((await post("/api/admin/warm-diff?version=warm-b-1")).status).toBe(401);
    expect((await post("/api/admin/warm-diff", "test-admin")).status).toBe(400);
    expect((await post("/api/admin/warm-diff?version=nope", "test-admin")).status).toBe(404);
    expect((await post("/api/admin/warm-diff?version=warm-b-0", "test-admin")).status).toBe(404); // a baseline has no pair
    const res = await post("/api/admin/warm-diff?version=warm-b-1", "test-admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version_id: "warm-b-1", from_version_id: "warm-b-0", stored: true });
    const row = await db.prepare("SELECT json FROM diff_cache WHERE from_version_id = 'warm-b-0' AND to_version_id = 'warm-b-1'").first<{ json: string }>();
    const t0 = (await db.prepare("SELECT captured_at FROM versions WHERE id = 'warm-b-0'").first<{ captured_at: string }>())!.captured_at;
    const t1 = (await db.prepare("SELECT captured_at FROM versions WHERE id = 'warm-b-1'").first<{ captured_at: string }>())!.captured_at;
    const served = await (await fetchPath(`/api/pages/warm-b/diff?from=${encodeURIComponent(t0)}&to=${encodeURIComponent(t1)}`)).text();
    expect(served).toBe(row!.json);
    expect(await diffsToWarm(db, FEATURE_TEXT_CAP, 10, window())).toEqual([]);
  });
});
