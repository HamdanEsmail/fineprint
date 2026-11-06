import { applyD1Migrations, createExecutionContext, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Delta } from "../src/core/diff";
import { insertPage, updatePage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { RunRow, TriggerKind } from "../src/db/types";
import { insertVersion, type NewVersion } from "../src/db/versions";
import worker from "../src/index";
import { getPageDetail, getVersion, getVersionAsOf, versionInForce } from "../src/readModel";
import { DeltaBadge, FactsTable } from "../src/site/components";
import { cronToWords, deltaParts, formatUtc, noiseReasonWords, parseAsOfInput, toDatetimeLocal } from "../src/site/format";

// The page view (GET /pages/:id, with v=, at= and text=1): the header, the timeline and the version
// list, the version card in each of its honest states, the as-of scrubber, the check log and the
// compare form, all read through src/readModel.ts, the same functions the JSON API answers with.

const db = env.DB;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A time relative to now, so the two-minute refresh window and "now" on the timeline never go stale. */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const XSS = "<script>alert(1)</script>";
const MARKER = "RECORDED-TEXT-MARKER";
const FACTS = JSON.stringify([
  { name: "Pro", price: "$25", unit: "per month", notes: null },
  { name: "Team", price: "$40", unit: "per seat", notes: "billed yearly" },
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function fetchPath(path: string): Promise<Response> {
  return SELF.fetch(`https://x${path}`);
}

async function get(path: string): Promise<string> {
  const res = await fetchPath(path);
  expect(res.status, path).toBe(200);
  return res.text();
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;

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

/** A version with the run that made it, so it carries the run's trigger and the check log counts it as a change. */
async function version(
  id: string,
  pageId: string,
  at: string,
  trigger: TriggerKind,
  over: Partial<NewVersion> = {},
): Promise<void> {
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

const delta = (blocks: [number, number, number], facts: [number, number, number] | null = null, layout_only = false): string =>
  JSON.stringify({
    blocks: { added: blocks[0], removed: blocks[1], changed: blocks[2] },
    facts: facts === null ? null : { added: facts[0], removed: facts[1], changed: facts[2] },
    layout_only,
  } satisfies Delta);

const T0 = (): string => ago(4 * DAY);

/**
 * One pricing page with a baseline and three later changes, and runs to match: the baseline run, three
 * changed runs (one pulled), one flap, two unchanged (one of them pulled). Returns the times.
 */
async function seedHistory(): Promise<{ t0: string; t1: string; t2: string; t3: string }> {
  const t0 = T0();
  const t1 = ago(3 * DAY);
  const t2 = ago(2 * DAY);
  const t3 = ago(12 * HOUR);
  await insertPage(db, page("pricing", { url: "https://example.com/pricing", label: "Example pricing" }));
  await version("base", "pricing", t0, "create", { facts_json: FACTS, facts_status: "ok" });
  await version("v1", "pricing", t1, "webhook", {
    summary: "Pro went from $20 to $25.",
    summary_source: "tinyfish",
    delta_json: delta([1, 1, 1], [0, 0, 1]),
    thumb_key: "thumbs/v1.jpg",
    facts_json: FACTS,
    facts_status: "ok",
  });
  await insertRun(db, run("noise-flap", "pricing", ago(2.5 * DAY), { outcome: "changed", noise_suppressed: 1, noise_reason: "flap" }));
  await version("v2", "pricing", t2, "pull", {
    summary: "A Team plan was added.",
    summary_source: "diff",
    delta_json: delta([2, 0, 0]),
    facts_json: FACTS,
    facts_status: "ok",
  });
  await insertRun(db, run("same-1", "pricing", ago(1.5 * DAY)));
  await insertRun(db, run("same-2", "pricing", ago(1 * DAY), { trigger_kind: "pull" }));
  await version("v3", "pricing", t3, "webhook", {
    summary: `${XSS} was added to the page.`,
    summary_source: "tinyfish",
    delta_json: delta([0, 0, 3]),
    text: `${MARKER} <b>Pro</b> costs $25.`,
    facts_json: FACTS,
    facts_status: "ok",
  });
  await updatePage(db, "pricing", { last_run_at: t3, last_change_at: t3 });
  return { t0, t1, t2, t3 };
}

/** A page whose only versions are a baseline without a screenshot and `latest`, for the version card's states. */
async function seedState(id: string, latest: Partial<NewVersion> & { at?: string } = {}, over: Partial<NewPage> = {}): Promise<void> {
  await insertPage(db, page(id, over));
  await version(`${id}-0`, id, T0(), "create", { screenshot_key: null, html_key: null, capture_status: "failed" });
  const { at, ...rest } = latest;
  await version(`${id}-1`, id, at ?? ago(HOUR), "webhook", { summary: `A change to ${id}.`, summary_source: "tinyfish", ...rest });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

// --- Formatters and components ---------------------------------------------------------------------

describe("the page view's formatters", () => {
  it("says a schedule in words", () => {
    expect(cronToWords("14 2,14 * * *")).toBe("twice a day, at 02:14 and 14:14 UTC");
    expect(cronToWords("0 */6 * * *")).toBe("four times a day");
    expect(cronToWords("7 1,13 * * *")).toBe("twice a day, at 01:07 and 13:07 UTC");
    expect(cronToWords("5 9 * * *")).toBe("once a day, at 09:05 UTC");
    expect(cronToWords("0 3,11,19 * * *")).toBe("three times a day, at 03:00, 11:00 and 19:00 UTC");
    for (const cron of ["0 * * * *", "14 2,14 * * 1", "x y z", "", "61 2 * * *", "0 25 * * *", "0 */7 * * *"]) {
      expect(cronToWords(cron), cron).toBe(cron);
    }
  });

  it("reads an as-of time from the picker or as ISO 8601, always as UTC", () => {
    expect(parseAsOfInput("2026-11-05T09:12")).toBe("2026-11-05T09:12:00.000Z");
    expect(parseAsOfInput("2026-11-05T09:12:30")).toBe("2026-11-05T09:12:30.000Z");
    expect(parseAsOfInput(" 2026-11-05T09:12 ")).toBe("2026-11-05T09:12:00.000Z");
    expect(parseAsOfInput("2026-11-05T12:12:00+03:00")).toBe("2026-11-05T09:12:00.000Z");
    expect(parseAsOfInput("2026-11-05T09:12:44.120Z")).toBe("2026-11-05T09:12:44.120Z");
    expect(parseAsOfInput("2026-11-05")).toBe("2026-11-05T00:00:00.000Z");
    for (const raw of ["yesterday", "", "Nov 5 2026", "2026-02-30T00:00", "2026-11-05T25:00", "05/11/2026", "+012026-11-05T00:00"]) {
      expect(parseAsOfInput(raw), raw).toBeNull();
    }
  });

  it("writes a time in the picker's form, in UTC, rounded to the minute either way", () => {
    expect(toDatetimeLocal("2026-11-03T16:18:26.422Z", "floor")).toBe("2026-11-03T16:18");
    expect(toDatetimeLocal("2026-11-03T16:18:26.422Z", "ceil")).toBe("2026-11-03T16:19");
    expect(toDatetimeLocal("2026-11-03T16:18:00.000Z", "ceil")).toBe("2026-11-03T16:18");
  });

  it("says a noise reason in words", () => {
    expect(noiseReasonWords("partial_render")).toBe("partial render");
    expect(noiseReasonWords("flap")).toBe("flap");
    expect(noiseReasonWords("normalized_identical")).toBe("same after cleaning");
    expect(noiseReasonWords("layout_hold")).toBe("layout change held for a second read");
    expect(noiseReasonWords("some_new_reason")).toBe("some new reason");
  });

  it("writes a delta as a badge, leaving zero parts out", () => {
    const d = (b: [number, number, number], f: [number, number, number] | null = null): Delta => JSON.parse(delta(b, f));
    expect(deltaParts(d([2, 1, 3]))?.text).toBe("+2 −1 ~3 blocks");
    expect(deltaParts(d([0, 0, 1]))?.text).toBe("~1 block");
    expect(deltaParts(d([3, 4, 0]))?.text).toBe("+3 −4 blocks");
    expect(deltaParts(d([0, 0, 2], [1, 0, 2]))?.text).toBe("~2 blocks · +1 ~2 facts");
    expect(deltaParts(d([0, 0, 2], [0, 0, 0]))?.text).toBe("~2 blocks");
    expect(deltaParts(d([0, 0, 0], [0, 1, 0]))?.text).toBe("−1 fact");
    expect(deltaParts(d([2, 1, 3]))?.spoken).toBe("2 blocks added, 1 removed, 3 changed");
    expect(deltaParts(d([0, 0, 0]))).toBeNull();
    expect(deltaParts(null)).toBeNull();
  });

  it("renders the delta badge, the layout-only tag, or nothing", () => {
    const html = (d: Delta | null): string => String(DeltaBadge({ delta: d }) ?? "");
    expect(html(JSON.parse(delta([2, 1, 3], [1, 0, 2])))).toContain("+2 −1 ~3 blocks · +1 ~2 facts");
    expect(html(JSON.parse(delta([25, 1, 0], null, true)))).toContain("Layout only");
    expect(html(JSON.parse(delta([25, 1, 0], null, true)))).not.toContain("blocks");
    expect(html(null)).toBe("");
    expect(html(JSON.parse(delta([0, 0, 0])))).toBe("");
  });

  it("renders a facts table with markup from a watched page as text", () => {
    const html = String(FactsTable({ facts: [{ name: XSS, price: "$20", unit: "per month", notes: null }] }));
    expect(html).toContain("<table");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain(XSS);
    expect(html).toContain("$20");
    expect(html).toContain("per month");
  });
});

// --- The read model and the JSON it shares --------------------------------------------------------

describe("the read model behind the page view", () => {
  it("answers the three JSON endpoints with exactly what it returns", async () => {
    const { t2 } = await seedHistory();
    const detail = (await getPageDetail(env, "pricing"))!;
    expect(detail.versions.map((v) => v.id)).toEqual(["v3", "v2", "v1", "base"]);
    expect(detail.runs[0]!.id).toBe("run-v3");
    const body: Json = await (await fetchPath("/api/pages/pricing")).json();
    expect(body).toEqual(JSON.parse(JSON.stringify({ page: detail.page, versions: detail.versions, runs: detail.runs })));

    const one: Json = await (await fetchPath("/api/pages/pricing/versions/v2")).json();
    expect(one).toEqual(JSON.parse(JSON.stringify(await getVersion(env, "pricing", "v2", { withText: true }))));
    expect(one.text).toBe("text of v2");
    expect(one.live_url).toBe("https://example.com/pricing");

    const asOf: Json = await (await fetchPath(`/api/pages/pricing/as-of?at=${encodeURIComponent(t2)}`)).json();
    expect(asOf).toEqual(one);
    expect(await getVersionAsOf(env, "pricing", t2)).toEqual(await getVersion(env, "pricing", "v2", { withText: true }));
  });

  it("leaves the text out unless asked, and says why an as-of time has no version", async () => {
    const { t0 } = await seedHistory();
    const bare = await getVersion(env, "pricing", "v3", { withText: false });
    expect(bare?.text).toBeNull();
    expect(bare?.live_url).toBe("https://example.com/pricing");
    expect(await getVersion(env, "pricing", "nope", { withText: true })).toBeNull();
    expect(await getVersion(env, "nope", "v3", { withText: true })).toBeNull();

    expect(await getVersionAsOf(env, "pricing", "2020-01-01T00:00:00.000Z")).toEqual({ error: "before_baseline", baseline_at: t0 });
    expect(await getVersionAsOf(env, "nope", t0)).toBeNull();
    await insertPage(db, page("empty"));
    expect(await getVersionAsOf(env, "empty", t0)).toEqual({ error: "no_versions" });
  });

  it("picks the version in force from the list the way the as-of query does", async () => {
    const { t1, t2 } = await seedHistory();
    const { versions } = (await getPageDetail(env, "pricing"))!;
    expect(versionInForce(versions, t2)?.id).toBe("v2");
    expect(versionInForce(versions, new Date(Date.parse(t2) - 1).toISOString())?.id).toBe("v1");
    expect(versionInForce(versions, t1)?.id).toBe("v1");
    expect(versionInForce(versions, "2020-01-01T00:00:00.000Z")).toBeNull();
    for (const at of [t1, t2, new Date().toISOString()]) {
      const viaSql = await getVersionAsOf(env, "pricing", at);
      expect(versionInForce(versions, at)?.id, at).toBe(viaSql && "id" in viaSql ? viaSql.id : undefined);
    }
  });

  it("keeps the JSON's not_found, no_versions and invalid_at answers", async () => {
    await seedHistory();
    await insertPage(db, page("empty"));
    const answer = async (path: string) => {
      const res = await fetchPath(path);
      return { status: res.status, body: await res.json() };
    };
    expect(await answer("/api/pages/nope")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await answer("/api/pages/nope/as-of?at=garbage")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await answer("/api/pages/pricing/as-of?at=garbage")).toEqual({ status: 400, body: { error: "invalid_at" } });
    expect(await answer("/api/pages/empty/as-of?at=2026-11-05")).toEqual({ status: 404, body: { error: "no_versions" } });
    expect(await answer("/api/pages/nope/versions/v1")).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

// --- The page view ----------------------------------------------------------------------------------

describe("GET /pages/:id", () => {
  it("shows the header, the timeline, the version list, the latest version and the check log", async () => {
    const { t0, t3 } = await seedHistory();
    const html = await get("/pages/pricing");

    // Header.
    expect(html).toContain("<h1>Example pricing</h1>");
    expect(html).toMatch(/<a[^>]+href="https:\/\/example\.com\/pricing"[^>]*>example\.com\/pricing<\/a>/);
    expect(html).toContain("Checked twice a day, at 02:14 and 14:14 UTC");
    expect(html).toMatch(new RegExp(`Last checked <time[^>]*>${formatUtc(t3)}</time>`));
    expect(html).toContain("4 versions · 1 noise event suppressed");
    expect(html).toContain('class="chip ok">Active</span>');

    // Timeline: one dot per version, each a link with its accessible name, the newest selected.
    expect(count(html, 'class="dot')).toBe(4);
    expect(html).toContain(`aria-label="Version recorded ${formatUtc(t0)}"`);
    expect(html).toMatch(/<a class="dot is-on"[^>]+href="\/pages\/pricing\?v=v3#version"/);
    expect(html).toContain('href="/pages/pricing?v=base#version"');

    // The version card: the latest version, its summary and where it came from, the screenshot, the facts.
    expect(html).toMatch(new RegExp(`Recorded <time[^>]+datetime="${t3}">${formatUtc(t3)}</time>`));
    expect(html).toContain("TinyFish&#39;s summary");
    expect(html).toContain("~3 blocks");
    expect(html).not.toContain(XSS);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; was added to the page.");
    expect(html).toMatch(/<a[^>]+href="\/shots\/v3\.jpg"[^>]*data-full/);
    expect(html).toMatch(/<img[^>]+src="\/shots\/v3\.jpg"[^>]+width="640"[^>]+height="400"/);
    expect(html).toContain(`alt="Screenshot of Example pricing as recorded ${formatUtc(t3)}"`);
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
    expect(html).toMatch(/<th scope="row">Team<\/th>/);
    expect(html).toContain("billed yearly");

    // Links: stored source, live page, JSON, compare with the previous, the recorded text.
    expect(html).toMatch(/<a[^>]+href="\/sources\/v3\.html"[^>]*>Stored source<\/a>/);
    expect(html).toMatch(/<a[^>]+href="https:\/\/example\.com\/pricing"[^>]*>Live page<\/a>/);
    expect(html).toMatch(/<a[^>]+href="\/api\/pages\/pricing\/versions\/v3"[^>]*>This version as JSON<\/a>/);
    expect(html).toMatch(/<a[^>]+href="\/pages\/pricing\/compare\?from=v2&amp;to=v3"[^>]*>Compare with the previous version<\/a>/);
    expect(html).toMatch(/<a[^>]+href="\/pages\/pricing\?v=v3&amp;text=1#text"[^>]*>Show the recorded text<\/a>/);
    expect(html).toMatch(
      /Source: <a[^>]+>example\.com\/pricing<\/a> · read \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC · Monitor \(webhook\)/,
    );

    // The version list, newest first, with each version's thumbnail by path (the thumbnail when there is one).
    const list = html.slice(html.indexOf('<nav class="versions"'), html.indexOf("</nav>", html.indexOf('<nav class="versions"')));
    const order = ["?v=v3#version", "?v=v2#version", "?v=v1#version", "?v=base#version"].map((s) => list.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('src="/thumbs/v1.jpg"');
    expect(html).toContain("A Team plan was added.");

    // The check log: the baseline run is not counted.
    expect(html).toContain("6 checks: 3 changes, 1 noise, 2 unchanged.");
    expect(html).toContain("flap");
    expect(html).toContain("<summary>All checks</summary>");
    expect(html).toContain("pulled");

    // The as-of scrubber and the compare form.
    expect(html).toMatch(/<form[^>]+method="get"[^>]+action="\/pages\/pricing"/);
    expect(html).toMatch(/<label[^>]+for="at"/);
    expect(html).toMatch(new RegExp(`<input[^>]+type="datetime-local"[^>]+name="at"[^>]+min="${toDatetimeLocal(t0, "ceil")}"`));
    expect(html).toContain("Show this date");
    expect(html).toMatch(/<form[^>]+action="\/pages\/pricing\/compare"/);
    expect(html).toMatch(/<label[^>]+for="from"/);
    expect(html).toMatch(/<label[^>]+for="to"/);
    expect(html).toMatch(/<select[^>]+name="from"/);
    expect(html).toMatch(/<option value="v2" selected/);
    expect(html).toContain(">Compare</button>");

    // No refresh, no text, no AS OF stamp on the plain view.
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain(MARKER);
    expect(html).not.toContain("AS OF");
  });

  it("selects a version with v= and says 404 for one it does not have", async () => {
    const { t1 } = await seedHistory();
    const html = await get("/pages/pricing?v=v1");
    expect(html).toMatch(/<a class="dot is-on"[^>]+href="\/pages\/pricing\?v=v1#version"/);
    expect(count(html, 'class="dot is-on"')).toBe(1);
    expect(html).toMatch(new RegExp(`Recorded <time[^>]+datetime="${t1}">${formatUtc(t1)}</time>`));
    expect(html).toContain("+1 −1 ~1 blocks · ~1 fact");
    expect(html).toMatch(/<img[^>]+src="\/thumbs\/v1\.jpg"/);
    expect(html).toMatch(/<a[^>]+href="\/shots\/v1\.jpg"[^>]*data-full/);
    expect(html).toContain('href="/pages/pricing/compare?from=base&amp;to=v1"');

    // A summary built from the diff says so.
    expect(await get("/pages/pricing?v=v2")).toContain("From the diff");

    // The baseline has nothing before it to compare with.
    const base = await get("/pages/pricing?v=base");
    expect(base).not.toContain("Compare with the previous version");
    expect(base).toContain("Monitor (baseline)");

    await insertPage(db, page("other"));
    await version("other-0", "other", T0(), "create");
    for (const path of ["/pages/pricing?v=not-a-version", "/pages/pricing?v=other-0", "/pages/nope", "/pages/nope?v=v1"]) {
      const res = await fetchPath(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain("No such page in the ledger.");
    }
  });

  it("shows the page as it was at a time, and says so honestly when it cannot", async () => {
    const { t0, t2 } = await seedHistory();
    const afterSecond = toDatetimeLocal(new Date(Date.parse(t2) + HOUR).toISOString(), "floor");
    const asOf = await get(`/pages/pricing?at=${afterSecond}`);
    expect(asOf).toMatch(/AS OF \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC/);
    expect(asOf).toContain(`AS OF ${formatUtc(`${afterSecond}:00.000Z`)}`);
    expect(asOf).toMatch(new RegExp(`Recorded <time[^>]+datetime="${t2}">${formatUtc(t2)}</time>`));
    expect(asOf).toMatch(/<a class="dot is-on"[^>]+href="\/pages\/pricing\?v=v2#version"/);
    expect(asOf).toContain(`value="${afterSecond}"`);
    // The recorded text keeps the as-of selection.
    expect(asOf).toContain(`href="/pages/pricing?at=${encodeURIComponent(`${afterSecond}:00.000Z`)}&amp;text=1#text"`);
    expect(asOf).toContain('<option value="v1" selected');

    // ISO 8601 with an offset works too.
    expect(await get(`/pages/pricing?at=${encodeURIComponent(t2)}`)).toMatch(/AS OF /);

    // Before the baseline: the earliest record, with the line, and no stamp.
    const early = await get("/pages/pricing?at=2020-01-01T00:00");
    expect(early).toContain(`Fineprint started watching this page on ${formatUtc(t0)}. There is no earlier record.`);
    expect(early).not.toContain("AS OF");
    expect(early).toMatch(/<a class="dot is-on"[^>]+href="\/pages\/pricing\?v=base#version"/);

    // A time it cannot read: the latest version, the line, no stamp, never a 500.
    for (const raw of ["yesterday", "2026-13-45T99:99", "%3Cscript%3E"]) {
      const bad = await get(`/pages/pricing?at=${raw}`);
      expect(bad, raw).toContain("That is not a date Fineprint can read. Use the picker, or a time like 2026-11-05T09:12.");
      expect(bad, raw).not.toContain("AS OF");
      expect(bad, raw).not.toContain("<script>");
      expect(bad, raw).toMatch(/<a class="dot is-on"[^>]+href="\/pages\/pricing\?v=v3#version"/);
    }

    // A time still to come: the latest version, said plainly, no stamp.
    const future = await get("/pages/pricing?at=2999-01-01T00:00");
    expect(future).toContain("That time has not come yet. This is the latest record.");
    expect(future).not.toContain("AS OF");

    // An empty at= is no as-of at all.
    const empty = await get("/pages/pricing?at=");
    expect(empty).not.toContain("That is not a date");
    expect(empty).not.toContain("AS OF");
  });

  it("loads the recorded text only with text=1, escaped, in a pre", async () => {
    await seedHistory();
    expect(await get("/pages/pricing")).not.toContain(MARKER);
    expect(await get("/pages/pricing?v=v3")).not.toContain(MARKER);
    const html = await get("/pages/pricing?text=1");
    expect(html).toMatch(new RegExp(`<pre[^>]+id="text"[^>]*>${MARKER} &lt;b&gt;Pro&lt;/b&gt; costs \\$25\\.</pre>`));
    expect(html).not.toContain("<b>Pro</b>");
    expect(html).toContain('href="/pages/pricing?v=v3#version">Hide the recorded text</a>');
    expect(await get("/pages/pricing?v=v2&text=1")).toContain(">text of v2</pre>");
  });

  it("reads few rows: the same queries with v= and at=, one more with text=1, and never the text without it", async () => {
    const { t2 } = await seedHistory();
    const prepare = vi.spyOn(env.DB, "prepare");
    const batch = vi.spyOn(env.DB, "batch");
    const exec = vi.spyOn(env.DB, "exec");
    const queries = async (path: string): Promise<string[]> => {
      prepare.mockClear();
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`https://x${path}`), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status, path).toBe(200);
      await res.text();
      return prepare.mock.calls.map((call) => String(call[0]));
    };
    /** A statement that reads versions.text: SELECT * from versions, or the text column by name. */
    const readsText = (sql: string): boolean => (/SELECT\s+\*/i.test(sql) && /FROM\s+versions/i.test(sql)) || /\bv\.text\b|,\s*text\b/i.test(sql);
    try {
      const plain = await queries("/pages/pricing");
      const byVersion = await queries("/pages/pricing?v=v1");
      const byTime = await queries(`/pages/pricing?at=${encodeURIComponent(t2)}`);
      const withText = await queries("/pages/pricing?text=1");
      const asOfText = await queries(`/pages/pricing?at=${encodeURIComponent(t2)}&text=1`);
      expect(plain.length).toBeLessThanOrEqual(9);
      expect(byVersion.length).toBe(plain.length);
      expect(byTime.length).toBe(plain.length);
      expect(withText.length).toBe(plain.length + 1);
      expect(asOfText.length).toBe(plain.length + 1);
      for (const sql of [...plain, ...byVersion, ...byTime]) expect(readsText(sql), sql).toBe(false);
      expect(withText.filter(readsText)).toHaveLength(1);
      expect(batch).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    } finally {
      for (const spy of [prepare, batch, exec]) spy.mockRestore();
    }
  });

  it("says when there is one version and nothing to compare, and copes with a page that has none", async () => {
    await insertPage(db, page("solo", { label: "Solo page" }));
    await version("solo-0", "solo", T0(), "create");
    const solo = await get("/pages/solo");
    expect(count(solo, 'class="dot')).toBe(1);
    expect(solo).toContain("There is nothing to compare yet: this page has one recorded version.");
    expect(solo).not.toMatch(/<form[^>]+action="\/pages\/solo\/compare"/);
    expect(solo).toContain("No check has run since the baseline.");
    expect(solo).toContain("The first version Fineprint recorded of this page.");

    await insertPage(db, page("bare", { label: "Bare page", schedule_cron: null }));
    const bare = await get("/pages/bare");
    expect(bare).toContain("Bare page");
    expect(bare).toContain("No version of this page is recorded yet.");
    expect(bare).not.toContain("Checked ");
  });

  it("says a failed read in the check log, apart from noise and unchanged", async () => {
    await seedHistory();
    await insertRun(db, run("broken-read", "pricing", ago(2 * HOUR), { noise_reason: "fetch_error" }));
    await insertRun(db, run("held", "pricing", ago(HOUR), { outcome: "changed", noise_suppressed: 1, noise_reason: "layout_hold" }));
    const html = await get("/pages/pricing");
    expect(html).toContain("8 checks: 3 changes, 2 noise, 2 unchanged, 1 failed read.");
    expect(html).toContain("layout change held for a second read");
    expect(html).toContain("4 versions · 2 noise events suppressed");
  });
});

// --- The version card's honest states -------------------------------------------------------------

describe("the version card's honest states", () => {
  it("never shows a broken image for a screenshot that failed: the copy, the stored source and the live page", async () => {
    await seedState("broken", { screenshot_key: null, html_key: "html/broken-1.html", capture_status: "failed" });
    const html = await get("/pages/broken");
    expect(html).toContain("Screenshot unavailable.");
    expect(html).not.toMatch(/<img[^>]+src="[^"]*\/shots\//);
    expect(html).toMatch(/Screenshot unavailable\.[\s\S]*href="\/sources\/broken-1\.html"[^>]*>Stored source<\/a>[\s\S]*>Live page<\/a>/);
    expect(html).not.toContain('http-equiv="refresh"');

    // Without a stored source either, only the live page.
    await seedState("bare", { screenshot_key: null, html_key: null, capture_status: "failed" });
    const bare = await get("/pages/bare");
    expect(bare).toContain("Screenshot unavailable.");
    expect(bare).not.toContain("Stored source");
    expect(bare).toContain(">Live page</a>");
  });

  it("refreshes while a new version's screenshot is being taken, and stops after two minutes", async () => {
    await seedState("young", { at: ago(30_000), screenshot_key: null, html_key: null, capture_status: "pending" });
    const young = await get("/pages/young");
    expect(young).toContain('<meta http-equiv="refresh" content="5"');
    expect(young).toContain("Taking the screenshot…");
    expect(young).not.toMatch(/<img[^>]+src="[^"]*\/shots\//);

    await seedState("old", { at: ago(10 * MIN), screenshot_key: null, html_key: null, capture_status: "partial" });
    const old = await get("/pages/old");
    expect(old).not.toContain('http-equiv="refresh"');
    expect(old).toContain("Taking the screenshot…");

    // A selected older version does not refresh because the newest is pending.
    expect(await get("/pages/young?v=young-0")).not.toContain('http-equiv="refresh"');
  });

  it("says where the price table stands", async () => {
    await seedState("reading", { facts_status: "pending" });
    expect(await get("/pages/reading")).toContain("Reading prices…");
    await seedState("missing", { facts_status: "unavailable" });
    expect(await get("/pages/missing")).toContain("Price table unavailable for this version.");
    await seedState("terms", { facts_status: "not_needed" }, { kind: "policy" });
    const terms = await get("/pages/terms");
    expect(terms).not.toContain("Reading prices");
    expect(terms).not.toContain("Price table");

    await db.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('s', 'monitor_check', 6.5, 'x', ?)").bind(ago(HOUR)).run();
    const paused = await get("/pages/reading");
    expect(paused).toContain("Price tables are paused at the budget line. Changes are still recorded.");
    expect(paused).not.toContain("Reading prices…");
  });

  it("says a suspect read is waiting for a second check", async () => {
    await seedState("suspect");
    await updatePage(db, "suspect", { pending_hash: "h", pending_run_id: "r", pending_at: ago(HOUR) });
    expect(await get("/pages/suspect")).toContain(
      "A suspect read is waiting for a second check. Nothing is recorded until two reads agree.",
    );
    await seedState("calm");
    expect(await get("/pages/calm")).not.toContain("A suspect read");
  });

  it("shows a retired or expired page's whole history without implying it is still watched", async () => {
    await seedState("gone", {}, { status: "retired", monitor_id: null });
    const gone = await get("/pages/gone");
    expect(gone).toContain('class="chip muted">Retired</span>');
    expect(gone).toContain("No longer watched. Its history is kept.");
    expect(gone).not.toContain("Checked twice a day");
    expect(count(gone, 'class="dot')).toBe(2);

    await seedState("visitor", {}, { status: "expired", added_by: "public", monitor_id: null });
    const visitor = await get("/pages/visitor");
    expect(visitor).toContain('class="chip muted">Expired</span>');
    expect(visitor).toContain("Watched for 7 days as a public page. Its history is kept.");
    expect(visitor).not.toContain("Checked twice a day");
    expect(visitor).not.toContain("A suspect read");
  });

  it("labels a layout-only change and takes the accent off its time", async () => {
    await seedState("restyled", { delta_json: delta([25, 1, 0], null, true) });
    const html = await get("/pages/restyled");
    expect(html).toContain("Layout only");
    expect(html).toContain("Same words and figures, different structure.");
    expect(html).toContain('class="vcard-time is-quiet"');
    expect(html).not.toContain("+25 −1 blocks");
  });
});
