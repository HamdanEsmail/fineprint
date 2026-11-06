import { applyD1Migrations, reset, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertPage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { RunRow, TriggerKind } from "../src/db/types";
import { insertVersion, type NewVersion } from "../src/db/versions";
import { countChanges, getStats, listChanges } from "../src/readModel";

// The home screen: the hero count, the change feed, its paging, the retired line and the empty state,
// all read through src/readModel.ts, the same functions the JSON API answers with.

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
  it("shows the week's count, the feed and the record, with markup from a watched page as text", async () => {
    await seedWeek();
    const html = await get("/");
    expect(html).toContain("The web changed its mind 2 times this week.");
    // The count in the accent, held to its word by a non-breaking space so a phone never breaks after the number.
    expect(html).toContain('<h1 class="hero">The web changed its mind <em>2 times</em> this week.</h1>');
    expect(html).toContain("RECORDING");
    expect(html).toContain("Fineprint watches the pages you agree to without reading");
    for (const step of ["Watch", "Catch", "Compare"]) expect(html).toContain(step);
    expect(html).toContain("TinyFish Monitor reads each of 2 pages twice a day.");
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

    // The feed is newest first and includes the older change; the hero counts only this week.
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
    expect(html).toContain('<h1 class="hero">Nothing changed this week.</h1>');
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

  it("says once in the accent for a single change", async () => {
    await seedBaselines();
    await version("pricing-1", "pricing", ago(HOUR), "webhook", { summary: "One change.", summary_source: "tinyfish" });
    expect(await get("/")).toContain('<h1 class="hero">The web changed its mind <em>once</em> this week.</h1>');
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
    expect(html).toContain("The web changed its mind <em>once</em> this week.");
    expect(html).not.toContain("<span></span>");
  });

  it("stamps PAUSED and says so in a banner at the budget line", async () => {
    await seedBaselines();
    await db.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('s', 'monitor_check', 8, 'x', ?)").bind(ago(HOUR)).run();
    const html = await get("/");
    expect(html).toContain("PAUSED");
    expect(html).not.toContain("RECORDING");
    expect(html).toContain("Recording is paused at the budget line.");
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
    expect(await countChanges(env, { since: weekAgo, includeRetired: false })).toBe(2); // the hero's count
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

    // The hero and the real-changes block both leave the layout-only change out; the feed lists it.
    expect(html).toContain('<h1 class="hero">The web changed its mind <em>once</em> this week.</h1>');
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
