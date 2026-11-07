import { applyD1Migrations, reset, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertPage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { RunRow, TriggerKind } from "../src/db/types";
import { insertVersion, type NewVersion } from "../src/db/versions";
import { asOfExample, countChanges, countRetiredPagesWithChanges, getStats, homeCounts, listChanges } from "../src/readModel";
import { formatDate } from "../src/site/format";

// The home screen: the opening (what Fineprint is, the featured catch, the live line), what it answers, the
// bounty requirements with their live proof, the change feed with its paging, the stat blocks, the retired
// line and the empty state, all read through src/readModel.ts, the same functions the JSON API answers with.

const db = env.DB;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A time relative to now, so the "this week" count never goes stale. */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const XSS = "<script>alert(1)</script>";
const RETIRED_LABEL = "Gone Airline fees";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function get(path: string): Promise<string> {
  const res = await SELF.fetch(`https://x${path}`);
  expect(res.status, path).toBe(200);
  return res.text();
}

/** The text a reader sees: tags dropped, the entities JSX writes turned back, white space collapsed. */
const plain = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const count = (html: string, needle: string): number => html.split(needle).length - 1;

/** The markup from the first `open` to the first `close` after it. */
function slice(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  expect(start, open).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf(close, start) + close.length);
}

const H1 = '<h1 class="hero">A dated record of the web&#39;s small print.</h1>';
const LEDE =
  "Fineprint watches the pages you agree to without reading: pricing, fees, terms, privacy policies, visa and baggage rules. Every real change is recorded with the date, the text and a full-page screenshot, so you can see what a page said on any day, and exactly which words changed since.";

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

function run(id: string, pageId: string, at: string, trigger: TriggerKind): RunRow {
  return {
    id,
    page_id: pageId,
    monitor_run_id: `m-${id}`,
    outcome: trigger === "create" ? "baseline" : "changed",
    is_baseline: trigger === "create" ? 1 : 0,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: at,
    trigger_kind: trigger,
  };
}

/** A version with its run, so it carries the run's trigger. */
async function version(id: string, pageId: string, at: string, trigger: TriggerKind, over: Partial<NewVersion> = {}): Promise<void> {
  await insertRun(db, run(`run-${id}`, pageId, at, trigger));
  await insertVersion(db, {
    id,
    page_id: pageId,
    run_id: `run-${id}`,
    is_baseline: trigger === "create" ? 1 : 0,
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

/** Two watched pages with a baseline each; no changes yet. */
async function seedBaselines(): Promise<void> {
  await insertPage(db, page("pricing", { url: "https://example.com/pricing", label: "Example pricing" }));
  await insertPage(db, page("terms", { url: "https://example.org/terms", label: "Example terms", kind: "policy" }));
  await version("pricing-0", "pricing", ago(12 * DAY), "create");
  await version("terms-0", "terms", ago(12 * DAY), "create");
}

/**
 * Two changes this week (one with markup in its summary), one older change, and a retired page
 * holding one change of its own this week.
 */
async function seedWeek(): Promise<void> {
  await seedBaselines();
  await version("pricing-1", "pricing", ago(2 * HOUR), "webhook", { summary: "Pro went from $20 to $25.", summary_source: "tinyfish" });
  await version("terms-1", "terms", ago(5 * HOUR), "pull", { summary: `${XSS} was added to the terms.`, summary_source: "diff" });
  await version("terms-old", "terms", ago(10 * DAY), "webhook", { summary: "An older change.", summary_source: "tinyfish" });

  await insertPage(db, page("gone", { url: "https://gone.example/fees", label: RETIRED_LABEL, status: "retired", monitor_id: null }));
  await version("gone-0", "gone", ago(12 * DAY), "create");
  await version("gone-1", "gone", ago(1 * HOUR), "webhook", { summary: "Unreliable read.", summary_source: "tinyfish" });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

describe("home", () => {
  it("opens with what Fineprint is, then shows the feed and the record, with markup from a watched page as text", async () => {
    await seedWeek();
    const html = await get("/");
    expect(html).toContain(H1);
    expect(count(html, "<h1")).toBe(1);
    expect(html).toContain("RECORDING");
    expect(plain(html)).toContain(LEDE);
    // The Watch, Catch, Compare steps live on About now.
    expect(html).not.toContain("TinyFish Monitor reads each of");
    expect(html).not.toContain('class="steps"');
    expect(html).toContain("Every change, newest first");

    // The retired page's change is neither listed nor counted; one line says it exists.
    expect(html).not.toContain(RETIRED_LABEL);
    expect(html).toContain("1 page was retired for unreliable reads. Its history is kept.");
    expect(html).toMatch(/<a[^>]+href="\/watchlist#retired"[^>]*>1 page was retired for unreliable reads\. Its history is kept\.<\/a>/);

    expect(html).not.toContain(XSS);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toMatch(
      /Source: <a[^>]+>example\.com\/pricing<\/a> · read \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC · Monitor \(webhook\)/,
    );
    expect(html).toMatch(/Source: <a[^>]+>example\.org\/terms<\/a> · read \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC · Monitor \(pulled\)/);
    expect(html).toContain("TinyFish spend $");
    expect(html).not.toMatch(/<img[^>]+src="https?:/); // images by path, so they load on a preview host too
    expect(html).toMatch(/<img[^>]+src="\/shots\/pricing-1\.jpg"/);
    expect(html).toContain('alt="Screenshot of Example pricing as recorded ');

    // The feed is newest first and includes the older change.
    const order = ["Pro went from $20 to $25.", "was added to the terms.", "An older change."].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // Each card links to the page and to the comparison of its change.
    expect(html).toContain('href="/pages/pricing"');
    expect(html).toContain('href="/pages/pricing/compare?to=pricing-1"');

    // The stat column: pages watched, real changes (retired pages left out), checks run.
    expect(html).toMatch(/<b>2<\/b>\s*<span[^>]*>Pages watched<\/span>/);
    expect(html).toMatch(/<b>3<\/b>\s*<span[^>]*>Real changes<\/span>/);
    expect(html).toMatch(/<b>4<\/b>\s*<span[^>]*>Checks run<\/span>/); // three webhook runs and one pull

    // No paging with three changes.
    expect(html).not.toContain("Older changes");
  });

  it("says so when nothing has changed yet", async () => {
    await seedBaselines();
    const html = await get("/");
    expect(html).toContain("No changes recorded yet. 2 pages are checked twice a day.");
    expect(html).toContain(H1);
    expect(html).not.toContain("retired for unreliable reads");
  });

  it("pages through older changes with before=", async () => {
    await seedBaselines();
    const times = Array.from({ length: 21 }, (_, i) => ago((i + 1) * HOUR));
    for (let i = 0; i < 21; i++) {
      await version(`c-${i + 1}`, "pricing", times[i]!, "webhook", { summary: `Change number ${i + 1}.`, summary_source: "tinyfish" });
    }
    const first = await get("/");
    expect(first).toContain("Change number 20.");
    expect(first).not.toContain("Change number 21.");
    // Encoded, and straight to the feed, past the introduction.
    expect(first).toContain(`href="/?before=${encodeURIComponent(times[19]!)}#feed"`);
    expect(first).toContain("Older changes");

    const second = await get(`/?before=${encodeURIComponent(times[19]!)}`);
    expect(second).toContain("Change number 21.");
    expect(second).not.toContain("Change number 20.");
    expect(second).not.toContain("Older changes");
    expect(second).toContain("Changes recorded before ");
    expect(second).toContain('href="/#feed"'); // back to the newest

    // A before= it cannot read shows the newest changes.
    expect(await get("/?before=garbage")).toContain("Change number 1.");
  });

  it("says pages in the plural when more than one retired page has changes", async () => {
    await seedWeek();
    await insertPage(db, page("gone2", { url: "https://gone2.example/fees", label: "Second gone", status: "retired", monitor_id: null }));
    await version("gone2-1", "gone2", ago(3 * HOUR), "webhook", { summary: "Another.", summary_source: "tinyfish" });
    // A retired page with only a baseline is not counted.
    await insertPage(db, page("gone3", { url: "https://gone3.example/fees", label: "Third gone", status: "retired", monitor_id: null }));
    await version("gone3-0", "gone3", ago(3 * HOUR), "create");
    expect(await get("/")).toContain("2 pages were retired for unreliable reads. Their history is kept.");
  });

  it("links a source only when its url is http or https", async () => {
    await seedBaselines();
    await insertPage(db, page("odd", { url: "javascript:alert(1)", label: "Odd source" }));
    await version("odd-1", "odd", ago(HOUR), "webhook", { summary: "Odd.", summary_source: "tinyfish" });
    const html = await get("/");
    expect(html).toContain("Odd source");
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toMatch(/Source: javascript:alert\(1\) · read /);
  });

  it("keeps pages with no status or kind in the feed and the counts, without an empty label", async () => {
    await seedBaselines();
    await db
      .prepare(
        "INSERT INTO pages (id, url, label, kind, status, ignore_patterns, created_at) VALUES ('bare', 'https://bare.example/terms', 'Bare page', NULL, NULL, '[]', ?)",
      )
      .bind(ago(DAY))
      .run();
    await version("bare-1", "bare", ago(HOUR), "webhook", { summary: "Bare change.", summary_source: "tinyfish" });
    expect((await listChanges(env, { limit: 10, includeRetired: false })).map((c) => c.version_id)).toEqual(["bare-1"]);
    expect(await countChanges(env, { includeRetired: false })).toBe(1);
    expect((await getStats(env)).changes).toBe(1);
    const html = await get("/");
    expect(html).toContain("Bare page");
    expect(plain(html)).toContain(" · 1 real change · ");
    expect(html).not.toContain("<span></span>");
  });

  it("says so in a banner at the budget line, and keeps the stamp RECORDING while the Monitors run", async () => {
    await seedBaselines();
    await db.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('s', 'monitor_check', 8, 'x', ?)").bind(ago(HOUR)).run();
    const html = await get("/");
    expect(html).toContain(
      "Spending is paused at the budget line. Changes the Monitors report are still recorded, without screenshots or price tables.",
    );
    expect(html).toMatch(/<span class="stamp"><span class="live" aria-hidden="true"><\/span>RECORDING<\/span>/);
    expect(html).not.toContain("PAUSED");
  });

  it("stamps PAUSED when no Monitor is active", async () => {
    await insertPage(db, page("idle", { label: "Idle page", status: "paused" }));
    await version("idle-0", "idle", ago(DAY), "create");
    const html = await get("/");
    expect(html).toMatch(/<span class="stamp">PAUSED<\/span>/);
    expect(html).not.toContain("RECORDING");
    expect(html).not.toContain("Spending is paused at the budget line.");
  });
});

describe("the read model behind the feed", () => {
  it("leaves retired pages out on request, and counts changes without them", async () => {
    await seedWeek();
    const all = await listChanges(env, { limit: 50 });
    expect(all.map((c) => c.version_id)).toEqual(["gone-1", "pricing-1", "terms-1", "terms-old"]);
    const kept = await listChanges(env, { limit: 50, includeRetired: false });
    expect(kept.map((c) => c.version_id)).toEqual(["pricing-1", "terms-1", "terms-old"]);
    expect(kept[0]).toMatchObject({ page_label: "Example pricing", kind: "pricing", trigger: "webhook", summary_source: "tinyfish" });

    const stats = await getStats(env);
    expect(stats.changes).toBe(3);
  });

  it("counts changes in one query, as listChanges would list them", async () => {
    await seedWeek();
    expect(await countChanges(env, {})).toBe(4);
    expect(await countChanges(env, { includeRetired: false })).toBe(3);
    const weekAgo = ago(7 * DAY);
    expect(await countChanges(env, { since: weekAgo, includeRetired: false })).toBe(2); // the week's count, under "What changed on the web this week?"
    expect(await countChanges(env, { since: weekAgo })).toBe(3);
    expect(await countChanges(env, { since: weekAgo, includeRetired: false })).toBe(
      (await listChanges(env, { since: weekAgo, limit: 500, includeRetired: false })).length,
    );
  });

  it("takes since (inclusive) and before (strictly older) together", async () => {
    await seedWeek();
    const all = await listChanges(env, { limit: 50 });
    const pricingAt = all[1]!.captured_at;
    const termsAt = all[2]!.captured_at;
    expect((await listChanges(env, { before: pricingAt, limit: 50 })).map((c) => c.version_id)).toEqual(["terms-1", "terms-old"]);
    expect((await listChanges(env, { since: termsAt, before: pricingAt, limit: 50 })).map((c) => c.version_id)).toEqual(["terms-1"]);
  });
});

describe("GET /api/changes additions", () => {
  const ids = async (query: string): Promise<string[]> => {
    const res = await SELF.fetch(`https://x/api/changes${query}`);
    expect(res.status, query).toBe(200);
    return ((await res.json()) as Json).changes.map((c: Json) => c.version_id);
  };

  it("keeps retired pages unless retired=0", async () => {
    await seedWeek();
    expect(await ids("")).toEqual(["gone-1", "pricing-1", "terms-1", "terms-old"]);
    expect(await ids("?retired=0")).toEqual(["pricing-1", "terms-1", "terms-old"]);
    expect(await ids("?retired=1")).toEqual(["gone-1", "pricing-1", "terms-1", "terms-old"]);
  });

  it("pages with before= (strictly older) and refuses one it cannot read", async () => {
    await seedWeek();
    const [, pricing] = await listChanges(env, { limit: 50 });
    expect(await ids(`?before=${encodeURIComponent(pricing!.captured_at)}`)).toEqual(["terms-1", "terms-old"]);
    expect(await ids(`?before=${encodeURIComponent(pricing!.captured_at)}&limit=1`)).toEqual(["terms-1"]);
    for (const query of ["?before=garbage", "?before="]) {
      const res = await SELF.fetch(`https://x/api/changes${query}`);
      expect(res.status, query).toBe(400);
      expect(await res.json(), query).toEqual({ error: "invalid_before" });
    }
  });
});

describe("catch cards with deltas and thumbnails (site Task 3)", () => {
  const delta = (blocks: [number, number, number], facts: [number, number, number] | null, layoutOnly: boolean): string =>
    JSON.stringify({
      blocks: { added: blocks[0], removed: blocks[1], changed: blocks[2] },
      facts: facts === null ? null : { added: facts[0], removed: facts[1], changed: facts[2] },
      layout_only: layoutOnly,
    });

  it("shows the delta badge, the thumbnail by path, and labels a layout-only change", async () => {
    await seedBaselines();
    await version("pricing-1", "pricing", ago(2 * HOUR), "webhook", {
      summary: "Pro went from $20 to $25.",
      summary_source: "tinyfish",
      delta_json: delta([1, 1, 1], [0, 0, 1], false),
      thumb_key: "thumbs/pricing-1.jpg",
    });
    await version("terms-1", "terms", ago(3 * HOUR), "webhook", {
      summary: "The terms were rearranged.",
      summary_source: "diff",
      delta_json: delta([25, 1, 0], null, true),
    });
    const html = await get("/");

    // The badge, and the thumbnail rather than the full screenshot when there is one.
    expect(html).toContain("+1 −1 ~1 blocks · ~1 fact");
    expect(html).toMatch(/<img[^>]+src="\/thumbs\/pricing-1\.jpg"/);
    expect(html).not.toMatch(/<img[^>]+src="\/shots\/pricing-1\.jpg"/);
    expect(html).toMatch(/<img[^>]+src="\/shots\/terms-1\.jpg"/);

    // Layout only: the tag instead of the counts, the line after the summary, the time without the accent.
    expect(html).toContain("Layout only");
    expect(html).not.toContain("+25 −1 blocks");
    expect(html).toMatch(/The terms were rearranged\.<\/p>\s*<p class="layout-note">Same words and figures, different structure\.<\/p>/);
    expect(html).toMatch(/<p class="meta is-quiet"><time[^>]*>[^<]+<\/time><span>policy<\/span><\/p>/);
    expect(html).toMatch(/<p class="meta"><time[^>]*>[^<]+<\/time><span>pricing<\/span><\/p>/);

    // The live line and the real-changes block both leave the layout-only change out; the feed lists it.
    expect(plain(html)).toContain(" · 1 real change · ");
    expect(html).toMatch(/<b>1<\/b>\s*<span[^>]*>Real changes<\/span>/);
    expect((await getStats(env)).changes).toBe(1);
    expect(await countChanges(env, { since: ago(7 * DAY), includeRetired: false, excludeLayoutOnly: true })).toBe(1);
  });

  it("puts the badge row and the evidence line in a footer that spans the card on a phone", async () => {
    await seedBaselines();
    await version("pricing-1", "pricing", ago(2 * HOUR), "webhook", {
      summary: "Pro went from $20 to $25.",
      summary_source: "tinyfish",
      delta_json: delta([0, 0, 1], null, false),
    });
    const html = await get("/");
    expect(html).toMatch(/<div class="catch-foot"><p class="row"><span class="delta"[^>]*>[\s\S]*?~1 block[\s\S]*?<\/span><span class="origin">TinyFish&#39;s summary<\/span><\/p><p class="evidence">/);
  });
});

describe("the opening, what it answers and the bounty proof (site Task 7b)", () => {
  /** The versions of a page, oldest first, as the as-of example reads them. */
  const timesOf = async (pageId: string): Promise<string[]> =>
    (
      await db.prepare("SELECT captured_at FROM versions WHERE page_id = ? ORDER BY captured_at, rowid").bind(pageId).all<{ captured_at: string }>()
    ).results.map((r) => r.captured_at);

  it("names itself in the title and the link previews, and opens with the two actions and the live line", async () => {
    await seedWeek();
    const html = await get("/");
    expect(html).toContain("<title>Fineprint: a dated record of the web&#39;s small print</title>");
    const description =
      "A dated record of the web&#39;s small print. Fineprint watches the pages you agree to without reading: pricing, fees, terms, privacy policies, visa and baggage rules.";
    expect(html).toContain(`<meta name="description" content="${description}"/>`);
    expect(html).toContain('<meta property="og:title" content="Fineprint: a dated record of the web&#39;s small print"/>');
    expect(html).toContain(`<meta property="og:description" content="${description}"/>`);

    expect(html).toContain(H1);
    expect(plain(slice(html, '<p class="lede">', "</p>"))).toBe(LEDE);
    expect(html).toContain('<a class="btn" href="#feed">See what changed this week</a>');
    expect(html).toContain('<a class="btn secondary" href="/watchlist#add">Watch a page of your own</a>');

    // The live line: two watched pages, three real changes (the retired page's left out), four checks (three by
    // webhook, one pulled), no noise; the same figures as the stat blocks beside the feed.
    const since = formatDate((await getStats(env)).recording_since!);
    expect(plain(slice(html, '<p class="liveline">', "</p>"))).toBe(`Recording since ${since} · 2 pages · 3 real changes · 4 checks · 0 noise events filtered`);
    expect(html).toMatch(/<b>2<\/b>\s*<span[^>]*>Pages watched<\/span>/);
    expect(html).toMatch(/<b>3<\/b>\s*<span[^>]*>Real changes<\/span>/);
    expect(html).toMatch(/<b>4<\/b>\s*<span[^>]*>Checks run<\/span>/);
    expect(html).toMatch(/<b>0<\/b>\s*<span[^>]*>Noise filtered<\/span>/);

    // The order: the opening, what it answers, the bounty section, then the feed with the stat blocks beside it.
    const at = (needle: string): number => html.indexOf(needle);
    expect(at(H1)).toBeLessThan(at('<p class="liveline">'));
    expect(at('<p class="liveline">')).toBeLessThan(at("What it answers"));
    expect(at("What it answers")).toBeLessThan(at("Built for the TinyFish Time Machine bounty"));
    expect(at("Built for the TinyFish Time Machine bounty")).toBeLessThan(at('id="feed"'));
    expect(at('id="feed"')).toBeLessThan(at('class="stats"'));
  });

  it("gives the live line its own row under the buttons, in the opening's words, never inside the buttons' row", async () => {
    await seedWeek();
    const html = await get("/");
    // Not inside the buttons' row element.
    expect(slice(html, '<p class="actions">', "</p>")).not.toContain("liveline");
    // Straight after the buttons' row, still inside the opening's words column (no other element in between).
    expect(html).toMatch(/<p class="actions">[\s\S]*?<\/p>\s*<p class="liveline">/);
    expect(html).toMatch(/<div class="opening-text">(?:(?!<\/div>)[\s\S])*<p class="liveline">/);
  });

  it("says each count in the singular when it is one", async () => {
    await insertPage(db, page("solo", { url: "https://example.com/solo", label: "Solo pricing" }));
    await version("solo-0", "solo", ago(2 * DAY), "create");
    await version("solo-1", "solo", ago(HOUR), "webhook", { summary: "One change.", summary_source: "tinyfish" });
    const since = formatDate((await getStats(env)).recording_since!);
    const line = async (): Promise<string> => plain(slice(await get("/"), '<p class="liveline">', "</p>"));
    expect(await line()).toBe(`Recording since ${since} · 1 page · 1 real change · 1 check · 0 noise events filtered`);

    await insertRun(db, { ...run("noise-1", "solo", ago(3 * HOUR), "webhook"), outcome: "unchanged", noise_suppressed: 1, noise_reason: "flap" });
    expect(await line()).toBe(`Recording since ${since} · 1 page · 1 real change · 2 checks · 1 noise event filtered`);

    const text = plain(await get("/"));
    expect(text).toContain(
      "1 page read twice a day by TinyFish Monitor: 2 scheduled checks delivered by webhook, 0 fetched when one was overdue. Delete the Monitors and nothing new is ever recorded.",
    );
    expect(text).toContain(`1 real change since ${since} (1 day of recording). 1 noise event filtered; 0 layout-only changes labelled, kept and shown.`);
    expect(text).toContain("1 real change this week, newest first");
  });

  it("answers the three questions with real, linked examples", async () => {
    await seedWeek();
    const html = await get("/");
    const asks = slice(html, '<ul class="asks">', "</ul>");
    expect(count(asks, "<li>")).toBe(3);

    // What a page said on a date: the page with the most versions (terms, three), halfway between its first two.
    const [first, second] = await timesOf("terms");
    const mid = new Date((Date.parse(first!) + Date.parse(second!)) / 2).toISOString();
    const asOfHref = `/pages/terms?at=${encodeURIComponent(mid)}`;
    expect(plain(asks)).toContain(`What did this page say on ${formatDate(mid)}?`);
    expect(asks).toContain(`<a href="${asOfHref}">Example terms, as of ${formatDate(mid)}</a>`);
    const asOf = await get(asOfHref);
    expect(asOf).toContain("AS OF");

    // What changed between two dates: with no featured catch, the newest change's comparison.
    const [newest] = await listChanges(env, { limit: 1, includeRetired: false });
    expect(plain(asks)).toContain("What changed between two dates?");
    expect(asks).toContain(`<a href="/pages/pricing/compare?to=pricing-1">Example pricing, ${formatDate(newest!.captured_at)}</a>`);

    // What changed this week: the week's real changes, in the feed.
    expect(plain(asks)).toContain("What changed on the web this week?");
    expect(asks).toContain('<a href="#feed">2 real changes this week, newest first</a>');
  });

  it("leaves the as-of example out when no page has two versions, and the comparison out with no change", async () => {
    await seedBaselines();
    const html = await get("/");
    const asks = slice(html, '<ul class="asks">', "</ul>");
    expect(count(asks, "<li>")).toBe(1);
    expect(asks).not.toContain("as of");
    expect(html).not.toContain("/compare");
    expect(asks).toContain('<a href="#feed">The feed, newest first</a>');
  });

  it("picks the as-of page: most versions, then the newest page, never a retired one", async () => {
    await seedWeek();
    const [first, second] = await timesOf("terms");
    expect(await asOfExample(env)).toEqual({ page_id: "terms", label: "Example terms", first_at: first, second_at: second });

    // The retired page gains the most versions: still not the example.
    await version("gone-2", "gone", ago(3 * HOUR), "webhook");
    await version("gone-3", "gone", ago(2 * HOUR), "webhook");
    expect((await asOfExample(env))?.page_id).toBe("terms");

    // A tie on the count goes to the newest page.
    await insertPage(db, page("late", { url: "https://example.com/late", label: "Late page" }));
    await version("late-0", "late", ago(3 * DAY), "create");
    await version("late-1", "late", ago(2 * DAY), "webhook");
    await version("late-2", "late", ago(DAY), "webhook");
    expect((await asOfExample(env))?.page_id).toBe("late");
  });

  it("reads the week's count, the retired line's count and the as-of example in one batch, each as it reads alone", async () => {
    await seedWeek();
    const weekAgo = ago(7 * DAY);
    const batch = vi.spyOn(env.DB, "batch");
    try {
      const counts = await homeCounts(env, weekAgo);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(counts).toEqual({
        weekCount: await countChanges(env, { since: weekAgo, includeRetired: false, excludeLayoutOnly: true }),
        retiredWithChanges: await countRetiredPagesWithChanges(env),
        asOf: await asOfExample(env),
      });
      expect([counts.weekCount, counts.retiredWithChanges, counts.asOf?.page_id]).toEqual([2, 1, "terms"]);
    } finally {
      batch.mockRestore();
    }
    // An empty record: nothing to count, no example.
    await reset();
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect(await homeCounts(env, weekAgo)).toEqual({ weekCount: 0, retiredWithChanges: 0, asOf: null });
  });

  it("names the bounty and proves each requirement with live figures, one link each", async () => {
    await seedWeek();
    await db.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('s', 'monitor_check', 0.3, 'x', ?)").bind(ago(HOUR)).run();
    const html = await get("/");
    expect(html).toContain("Built for the TinyFish Time Machine bounty");
    expect(html).toContain("Every line below is live data from the recorder, not a description.");

    const reqs = slice(html, '<ul class="reqs">', "</ul>");
    expect(count(reqs, '<li class="req">')).toBe(6);
    const names = [...reqs.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(names).toEqual([
      "Monitor does the core work",
      "A screenshot for every change",
      "As-of lookup and a structured diff",
      "Real changes caught live",
      "Works for any page you add",
      "Reusable by other tools",
    ]);
    const rows = reqs.split('<li class="req">').slice(1);
    const since = formatDate((await getStats(env)).recording_since!);
    const proof = [
      "2 pages read twice a day by TinyFish Monitor: 3 scheduled checks delivered by webhook, 1 fetched when one was overdue. Delete the Monitors and nothing new is ever recorded.",
      "7 of 7 recorded versions have a full-page screenshot and the stored source.",
      "Pick a date on any page; compare any two versions section by section, with the changed words marked.",
      `3 real changes since ${since} (1 day of recording). 0 noise events filtered; 0 layout-only changes labelled, kept and shown.`,
      "4 of 4 public slots free; a public page is watched for 7 days and refused with the reason when it cannot be read.",
      "An open JSON API with CORS, and a full export.",
    ];
    rows.forEach((row, i) => expect(plain(row), names[i]).toContain(proof[i]!));
    const links = rows.map((row) => [...row.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]));
    expect(links).toEqual([
      ["/watchlist"],
      ["/pages/pricing?v=pricing-1#version"],
      ["/pages/pricing/compare?to=pricing-1"],
      ["#feed"],
      ["/watchlist#add"],
      ["/about#data", "/api/export.json"],
    ]);

    // How each TinyFish service is used: five rows with row headers, each with its live figure.
    const services = slice(html, '<table class="table services"', "</table>");
    expect([...services.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1])).toEqual(["Monitor", "Fetch", "Browser", "Agent", "Search"]);
    expect(count(html, '<th scope="row">')).toBe(5);
    const service = plain(services);
    expect(service).toContain("4 checks");
    expect(service).toContain("3 pages validated and 7 sources stored");
    expect(service).toContain("7 screenshots and 0 thumbnails");
    expect(service).toContain("Price tables read for 0 versions");
    expect(service).toContain("Finds a site's pricing, terms and fees pages on the watchlist, free.");

    expect(plain(slice(html, '<p class="costline">', "</p>"))).toBe("TinyFish spend so far $0.30 · $0.10 per real change · caps at $6 and $8 by design.");
    expect(html).toContain('<a href="/about">Read how it works</a>');
    // The section credits nothing but the recorder's data.
    expect(plain(slice(html, '<section class="bounty"', "</section>"))).not.toMatch(/\b(AI|model|assistant)\b/i);
  });

  it("says screenshots and sources apart when not every version has both, with one or many", async () => {
    await insertPage(db, page("solo", { url: "https://example.com/solo", label: "Solo pricing" }));
    await version("solo-0", "solo", ago(2 * DAY), "create");
    expect(plain(await get("/"))).toContain("1 of 1 recorded version has a full-page screenshot and the stored source.");
    await version("solo-1", "solo", ago(DAY), "webhook", { html_key: null, thumb_key: "thumbs/solo-1.jpg", facts_status: "ok", facts_json: "[]" });
    await version("solo-2", "solo", ago(HOUR), "webhook", { screenshot_key: null, html_key: null, capture_status: "pending" });
    const text = plain(await get("/"));
    expect(text).toContain("2 of 3 recorded versions have a full-page screenshot, and 1 has the stored source.");
    expect(text).toContain("2 screenshots and 1 thumbnail");
    expect(text).toContain("1 page validated and 1 source stored");
    expect(text).toContain("Price tables read for 1 version");
  });

  it("counts the evidence in /api/stats, beside the figures it already had", async () => {
    await seedWeek();
    await version("pricing-2", "pricing", ago(HOUR), "webhook", { thumb_key: "thumbs/pricing-2.jpg", facts_status: "ok", facts_json: "[]" });
    await version("terms-2", "terms", ago(HOUR), "webhook", { screenshot_key: null });
    const res = await SELF.fetch("https://x/api/stats");
    const body = (await res.json()) as Json;
    expect(body).toMatchObject({ versions: 9, versions_with_screenshot: 8, versions_with_source: 9, versions_with_facts: 1, thumbnails: 1 });
    expect(await getStats(env)).toEqual(body);
  });
});
