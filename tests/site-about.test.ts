import { applyD1Migrations, createExecutionContext, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Delta } from "../src/core/diff";
import { FACTS_PAUSE_USD, PUBLIC_SLOTS, PUBLIC_TTL_DAYS, SPEND_PAUSE_USD } from "../src/core/limits";
import { insertPage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { RunRow, TriggerKind } from "../src/db/types";
import { insertVersion, type NewVersion } from "../src/db/versions";
import type { Env } from "../src/env";
import worker from "../src/index";
import { listChanges } from "../src/readModel";

// The About screen (GET /about): what Fineprint is, how a change is recorded, one real change followed
// start to finish, how each TinyFish product is used with the live figures, what counts as noise, the honest
// limits, the public API with copyable curl commands, and who built it. Every figure is read from the same
// functions the JSON API answers with.

const db = env.DB;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const XSS = "<script>alert(1)</script>";

async function call(path: string, over: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://x${path}`), { ...env, ...over } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function get(path: string, over: Partial<Env> = {}): Promise<string> {
  const res = await call(path, over);
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

/** A version with its run, so it carries the run's trigger. */
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

const TEXT0 = ["# Example pricing", "## Pro", "Pro costs $20 per month.", "Includes 10 projects."].join("\n\n");
const TEXT1 = ["# Example pricing", "## Pro", "Pro costs $25 per month.", "Includes 10 projects."].join("\n\n");

type Seeded = { t0: string; t1: string };

/**
 * A pricing page whose one change is the featured catch; a layout-only change on a policy page; a page retired
 * for unreliable reads, with its change; noise of each kind; and the spend ledger.
 */
async function seed(): Promise<Seeded> {
  const t0 = ago(3 * DAY);
  const t1 = ago(1 * DAY);
  await insertPage(db, page("pricing", { url: "https://example.com/pricing", label: "Example pricing" }));
  await version("v0", "pricing", t0, "create", { text: TEXT0 });
  await version("v1", "pricing", t1, "webhook", {
    text: TEXT1,
    summary: "Pro went from $20 to $25.",
    summary_source: "tinyfish",
    delta_json: delta([0, 0, 1]),
  });

  await insertPage(db, page("privacy", { url: "https://example.org/privacy", label: "Example privacy policy", kind: "policy" }));
  await version("p0", "privacy", ago(5 * DAY), "create", { text: "Old structure." });
  await version("p1", "privacy", ago(4 * DAY), "pull", {
    text: "New structure.",
    summary: `${XSS} restructured.`,
    summary_source: "diff",
    delta_json: delta([20, 2, 0], true),
  });

  await insertPage(db, page("gone", { url: "https://gone.example/api/pricing/", label: "Gone API pricing", status: "retired", monitor_id: null }));
  await version("g0", "gone", ago(4 * DAY), "create");
  await version("g1", "gone", ago(3 * DAY), "webhook", { summary: "Unreliable read.", summary_source: "tinyfish" });

  const noise: [string, number][] = [
    ["normalized_identical", 7],
    ["partial_render", 3],
    ["layout_hold", 2],
    ["flap", 5],
  ];
  for (const [reason, n] of noise) {
    for (let i = 0; i < n; i++) {
      await insertRun(db, run(`noise-${reason}-${i}`, "pricing", ago(2 * DAY + i * MIN), { outcome: "changed", noise_suppressed: 1, noise_reason: reason }));
    }
  }
  const spend: [string, number][] = [
    ["monitor_check", 0.25],
    ["screenshot", 0.018],
    ["agent_step", 0.096],
    ["fetch", 0],
    ["search", 0],
  ];
  for (const [kind, usd] of spend) {
    await db.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES (?, ?, ?, ?, ?)").bind(`s-${kind}`, kind, usd, "ref", ago(DAY)).run();
  }
  return { t0, t1 };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

describe("about", () => {
  it("names the five TinyFish products, the one sentence about Monitor, the record and the diagram", async () => {
    await seed();
    const html = await get("/about");
    for (const name of ["Monitor", "Fetch", "Browser", "Agent", "Search"]) expect(html).toContain(`<th scope="row">${name}</th>`);
    expect(html).toContain("If every Monitor were deleted, nothing new would ever be recorded.");
    expect(html).toContain("One change, start to finish");
    expect(html).toContain(`curl ${env.PUBLIC_BASE_URL}/api/changes`);
    expect(html).toContain("partial render");
    expect(html).not.toContain("github.com"); // REPO_URL unset
    expect(html).toMatch(/<svg[^>]+role="img"[^>]+aria-labelledby=/);

    // One h1, the two sentences and the date recording began, from the earliest page.
    expect(html.split("<h1").length - 1).toBe(1);
    expect(html).toMatch(/Recording since <time datetime="[^"]+">\d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC<\/time>/);
    expect(html).toContain('aria-current="page">About</a>');
    expect(html).toContain("Fineprint never reads a page itself to find a change");
  });

  it("draws the diagram with a title and a text alternative, colour from the stylesheet only", async () => {
    await seed();
    const html = await get("/about");
    const svg = /<svg[^>]*>[\s\S]*?<\/svg>/.exec(html)![0];
    const labelled = /aria-labelledby="([^"]+)"/.exec(svg)![1]!.split(" ");
    expect(labelled.length).toBe(2);
    expect(svg).toContain(`<title id="${labelled[0]}">`);
    expect(svg).toContain(`<desc id="${labelled[1]}">`);
    // No colour in attributes: shapes take fill and stroke from tokens in site.css.
    expect(svg).not.toMatch(/\s(fill|stroke|color|style)="/);
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(svg).not.toContain("Gradient");
    // The five steps it draws are the five steps in words beside it.
    expect(html).toMatch(/<ol class="flow-steps">(?:[\s\S]*?<li){5}/);
  });

  it("shows the featured catch again, annotated in four captions, with the screenshots and the feed entry", async () => {
    const { t0, t1 } = await seed();
    const html = await get("/about");
    const at = html.indexOf('<section id="example"');
    const section = html.slice(at, html.indexOf('<section id="tinyfish"', at));
    expect(section).toContain("One change, start to finish");
    expect(section).toContain("A change from the home screen, followed through the record");
    for (const caption of ["The check that found it", "The cleaned text that differed", "The screenshots taken", "The entry in the feed"]) {
      expect(section).toContain(caption);
    }
    // The real record: the check's time and method, the word marks, both screenshots by path, the card.
    expect(section).toContain("Monitor (webhook)");
    expect(section).toMatch(/<del[^>]*>\$20<\/del>/);
    expect(section).toMatch(/<ins[^>]*>\$25<\/ins>/);
    expect(section).toContain('src="/shots/v0.jpg"');
    expect(section).toContain('src="/shots/v1.jpg"');
    expect(section).toContain('data-full=""');
    expect(section).toContain("Pro went from $20 to $25.");
    expect(section).toContain('href="/pages/pricing/compare?from=v0&amp;to=v1"');
    expect(section).toMatch(/Source: <a[^>]+>example\.com\/pricing<\/a> · read [^<]+ · Monitor \(webhook\)/);
    // The same change the home features.
    const home = await (await SELF.fetch("https://x/")).text();
    expect(home).toContain("The latest catch, up close");
    expect(home).toContain('href="/pages/pricing/compare?from=v0&amp;to=v1"');
    expect(t0 < t1).toBe(true);
  });

  it("says so in one plain sentence, with no empty frame, when no change can be shown", async () => {
    await insertPage(db, page("quiet", { label: "Quiet page" }));
    await version("q0", "quiet", ago(DAY), "create");
    const html = await get("/about");
    expect(html).toContain("No change has been recorded yet.");
    expect(html).not.toContain("The check that found it");
    expect(html).not.toContain('class="trail"');
    // The rest of the screen is there, with zero figures rather than gaps.
    expect(html).toContain("If every Monitor were deleted, nothing new would ever be recorded.");
    expect(html).toContain("No change has been labelled layout only yet.");

    // Changes, but none small enough to show: the sentence says where they are.
    await version("q1", "quiet", ago(HOUR), "webhook", { summary: "A change.", summary_source: "tinyfish" });
    const later = await get("/about");
    expect(later).not.toContain("The check that found it");
    expect(later).toMatch(/None of the latest changes can be shown here[^<]*<a href="\/#feed">/);
  });

  it("gives each TinyFish product its live figure from the stats", async () => {
    await seed();
    const html = await get("/about");
    const table = html.slice(html.indexOf('<table class="table uses"'), html.indexOf("</table>", html.indexOf('<table class="table uses"')));
    const row = (name: string): string => {
      const start = table.indexOf(`<th scope="row">${name}</th>`);
      return table.slice(start, table.indexOf("</tr>", start));
    };
    // Monitor: its runs by the way they came, and its spend.
    expect(row("Monitor")).toContain("$0.25");
    expect(row("Monitor")).toMatch(/3 baselines/);
    expect(row("Monitor")).toMatch(/19 by webhook/);
    expect(row("Monitor")).toMatch(/1 pulled/);
    expect(row("Browser")).toContain("$0.02");
    expect(row("Agent")).toContain("$0.10");
    expect(row("Fetch")).toContain("$0.00");
    expect(row("Search")).toContain("$0.00");
    expect(row("Agent")).toContain("one run at a time");
    // When a facts run is taken (src/capture.ts needsFacts), said as the rule is written.
    expect(row("Agent")).toContain("on pricing and fee pages, not on pages visitors add, and not for changes TinyFish judged irrelevant");
    expect(row("Search")).toContain("Find a site&#39;s small print");
    expect(table).toContain("<tfoot>");
    expect(table).toContain("Every billed call is written to the spend ledger");
    expect(table).toContain("$0.36");
  });

  it("explains each kind of noise with its count, then what is kept but labelled", async () => {
    await seed();
    const html = await get("/about");
    const at = html.indexOf('id="noise"');
    const section = html.slice(at, html.indexOf('id="limits"', at));
    expect(section).toContain("17 reads");
    for (const [reason, n] of [["cleaning", 7], ["partial-render", 3], ["layout-hold", 2], ["flap", 5]] as const) {
      expect(section, reason).toMatch(new RegExp(`id="noise-${reason}"[\\s\\S]*?<dd class="noise-n">${n} reads?</dd>`));
    }
    expect(section).toContain("72 hours");
    expect(section).toContain("cookie banners");

    // Layout only: the count and one linked example (on a page that is not retired).
    expect(section).toContain("Layout only");
    expect(section).toContain("Same words and figures, different structure.");
    expect(section).toMatch(/1 change so far/);
    expect(section).toContain('href="/pages/privacy/compare?to=p1"');
    expect(section).toContain("Example privacy policy");

    // The retired page, named and linked from the data, with the reason and its kept history. The retire date is
    // not stored, so the date shown is said to be the newest version's.
    expect(section).toContain('href="/pages/gone"');
    expect(section).toContain("Gone API pricing");
    expect(section).toContain("Retired by hand, so far for one reason: the page rendered differently from one read to the next");
    expect(section).toContain("Fineprint stopped watching it");
    expect(section).toContain("The retire date was not recorded; the date shown is when its newest version was recorded.");
    expect(section).not.toContain("Monitor was deleted");
    expect(section).toMatch(/2 versions; newest recorded \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC/);
    expect(section).toContain("No longer watched. Its history is kept.");
    expect(section).toContain('class="chip muted">Retired</span>');
  });

  it("states the honest limits with the numbers the code enforces", async () => {
    await seed();
    const html = await get("/about");
    const at = html.indexOf('id="limits"');
    const section = html.slice(at, html.indexOf('id="data"', at));
    expect(section).toContain("No history before a page is added");
    expect(section).toContain("twice a day");
    // The summary rule as the recorder keeps it: a summary the run carries is kept, whatever its judgment says.
    expect(section).toContain("When a Monitor run arrives with a summary of its own, Fineprint keeps it.");
    expect(section).toContain("A pulled check carries no judgment");
    expect(section).toContain("any change that arrives without a summary gets a one-line summary built from Fineprint&#39;s own diff");
    expect(section).toContain("&quot;TinyFish&#39;s summary&quot; or &quot;From the diff&quot;");
    expect(section).not.toContain("TinyFish writes a summary when");
    expect(section).toContain("Text is the diff; screenshots are evidence.");
    expect(section).toContain(`${PUBLIC_SLOTS} public slots`);
    expect(section).toContain(`${PUBLIC_TTL_DAYS} days`);
    expect(section).toContain("never gets a price table");
    // The two budget lines as the code holds them: the facts pause, then the spend pause, which stops Fineprint's
    // own costs while the Monitors' scheduled checks go on and their changes are still kept.
    expect(section).toContain(
      `At $${FACTS_PAUSE_USD} of TinyFish spend, spending on price tables is paused: a change recorded after that says its price table was not read, and is still recorded with its screenshot and diff.`,
    );
    expect(section).toContain(
      `At $${SPEND_PAUSE_USD}, Fineprint starts nothing more that costs money on its side: no overdue-check pull, screenshot, stored source or price table, and no new page can be added.`,
    );
    expect(section).toContain(
      "The Monitors&#39; own scheduled checks keep running, and a change they report is still kept as a version, without its screenshot.",
    );
    expect(section).toContain("Spend so far: $0.36.");
    expect(section).toContain("The home counts can trail by up to an hour.");
    expect(section).toContain(
      "Home, About and the watchlist are served from a copy rebuilt every hour and whenever a new version is recorded, so their counts and the recording or paused state can be up to an hour behind.",
    );
    expect(section).not.toContain("recording pauses");
  });

  it("lists the public endpoints with copyable curl commands against PUBLIC_BASE_URL, escaped", async () => {
    const { t0, t1 } = await seed();
    // The host is PUBLIC_BASE_URL, never the host the request came in on (a preview's).
    const html = await get("/about", { PUBLIC_BASE_URL: "https://fineprint.example/" });
    expect(html).toContain("curl https://fineprint.example/api/changes");
    expect(html).not.toContain("curl https://x/");
    const commands = [...html.matchAll(/<pre[^>]*data-copy=""[^>]*>([^<]*)<\/pre>/g)].map((m) => m[1]!);
    expect(commands.length).toBeGreaterThanOrEqual(7);
    for (const command of commands) expect(command.startsWith("curl ")).toBe(true);
    // Real ids from the record, and the query string escaped as HTML.
    expect(commands).toContain("curl https://fineprint.example/api/pages/pricing");
    expect(commands).toContain("curl https://fineprint.example/api/pages/pricing/versions/v1");
    expect(commands).toContain(`curl &quot;https://fineprint.example/api/pages/pricing/as-of?at=${t1}&quot;`);
    expect(commands).toContain(`curl &quot;https://fineprint.example/api/pages/pricing/diff?from=${t0}&amp;to=${t1}&quot;`);
    expect(commands).toContain("curl https://fineprint.example/api/stats");
    expect(html).toContain('href="/api/export.json"');
    expect(html).not.toContain(XSS);
  });

  it("credits Hamdan Esmail and links the source only when REPO_URL is set", async () => {
    await seed();
    const plain = await get("/about");
    expect(plain).toContain("Built by Hamdan Esmail for the TinyFish Time Machine bounty.");
    expect(plain).not.toContain("Source code");
    const linked = await get("/about", { REPO_URL: "https://github.com/hamdan/fineprint" });
    expect(linked).toMatch(/<a href="https:\/\/github\.com\/hamdan\/fineprint">[^<]+<\/a>/);
    // Anything but an http or https url is not a link.
    const odd = await get("/about", { REPO_URL: "javascript:alert(1)" });
    expect(odd).not.toContain("javascript:");
    expect(odd).not.toContain("Source code");
  });

  it("answers as before with the site switched off", async () => {
    const res = await call("/about", { SITE_ENABLED: "0" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await res.text()).toBe("404 Not Found");
  });

  it("sends the security headers and loads enhance.js from this origin, deferred, with no inline script", async () => {
    await seed();
    const res = await call("/about");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain('<script src="/assets/enhance.js" defer=""></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style[\s>]/);
    // Every screen loads it.
    expect(await get("/")).toContain('<script src="/assets/enhance.js" defer=""></script>');

    // Served as a static file, before the Worker (through the service binding, as production routes it).
    const js = await env.SELF.fetch("https://x/assets/enhance.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const source = await js.text();
    expect(source).toContain("a[data-full]");
    expect(source).toContain("pre[data-copy]");
    expect(source).toContain("showModal");
    expect(source).toContain("navigator.clipboard");
    // The lightbox opens only images on this origin; each copy button is named by its endpoint.
    expect(source).toContain("target.origin !== location.origin");
    expect(source).toContain('" command: "');
  });

  it("reads about as much as the home: the stats, two change lists, the pages and the featured catch", async () => {
    await seed();
    const prepare = vi.spyOn(env.DB, "prepare");
    const batch = vi.spyOn(env.DB, "batch");
    const queries = async (path: string): Promise<string[]> => {
      prepare.mockClear();
      await get(path);
      return prepare.mock.calls.map((c) => String(c[0]));
    };
    try {
      const cold = await queries("/about");
      const warm = await queries("/about");
      const home = await queries("/");
      expect(cold.length).toBe(warm.length + 5);
      // The home reads one statement more: the feed and its three small reads (one batch), where About reads two
      // change lists and the pages.
      expect(warm.length).toBe(home.length - 1);
      expect(warm.length).toBe(14);
      // The warm screen never reads a version's text.
      expect(warm.some((sql) => /SELECT\s+\*\s+FROM\s+versions/i.test(sql))).toBe(false);
      // A batch is one round trip: the stats' six aggregates on each screen (prepared, so counted above), and the
      // home's week count, retired count and as-of example.
      expect(batch.mock.calls.map((call) => call[0].length)).toEqual([6, 6, 6, 3]);
    } finally {
      prepare.mockRestore();
      batch.mockRestore();
    }
    // The layout-only example comes from listChanges, the function /api/changes answers with.
    const [example] = await listChanges(env, { limit: 1, includeRetired: false, layoutOnly: true });
    expect(example?.version_id).toBe("p1");
  });
});
