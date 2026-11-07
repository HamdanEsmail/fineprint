// What the site needs from the recorder (site plan, Task 2): a delta per change (block and fact counts and
// the layout-only label), the layout hold in the change gate, the summary line rule, the stats the site
// shows, public adds that never start a facts run, and thumbnails (taken with each new screenshot, or
// made later from the stored screenshot in one browser session).
import { applyD1Migrations, reset, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps, captureVersion, startNextFacts } from "../src/capture";
import { changedRegionOverlap, isLayoutOnly, structuredDiff } from "../src/core/diff";
import { recordSpend } from "../src/core/spend";
import { hashText, normalize } from "../src/core/normalize";
import { diffSummary } from "../src/core/summary";
import { cronDeps, runCron } from "../src/cron";
import { insertPage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { PageRow, RunRow, VersionRow } from "../src/db/types";
import { insertVersion, updateCapture, type NewVersion } from "../src/db/versions";
import type { Env } from "../src/env";
import { computeDelta, summaryDeps } from "../src/summary";
import { screenshotFullPage } from "../src/tinyfish/browser";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import fetchFixture from "./fixtures/tinyfish/fetch.json";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import runNowFixture from "./fixtures/tinyfish/monitor-runnow.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ADMIN = { Authorization: "Bearer test-admin" };
const BASE = "https://fineprint.test";
const FETCH_API = "https://api.fetch.tinyfish.ai/";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const BROWSER_API = "https://api.browser.tinyfish.ai/";
const CDP_HTTP = "https://cdp.example/devtools/browser/s-1";

// --- Seeding ------------------------------------------------------------------------------------

let seq = 0;

async function seedPage(over: Partial<NewPage> = {}): Promise<PageRow> {
  const id = over.id ?? `page-${++seq}`;
  await insertPage(env.DB, {
    id,
    url: `https://example.com/${id}`,
    label: `Page ${id}`,
    kind: "pricing",
    monitor_id: `mon-${id}`,
    schedule_cron: "0 0,12 * * *",
    purpose: "watch",
    status: "active",
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
    ...over,
  });
  return (await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first<PageRow>())!;
}

/** A captured version of `text`, with a run of its own (a pull, so no TinyFish summary unless given). */
async function seedVersion(pageId: string, id: string, at: string, text: string, over: Partial<NewVersion> = {}): Promise<string> {
  const baseline = over.is_baseline === 1;
  await insertRun(env.DB, {
    id: `run-${id}`, page_id: pageId, monitor_run_id: `m-${id}-${++seq}`, outcome: baseline ? "baseline" : "changed",
    is_baseline: baseline ? 1 : 0, judgment_relevant: null, judgment_summary: over.judgment_summary ?? null, diff_truncated: 0,
    noise_suppressed: 0, noise_reason: null, raw_key: null, received_at: at, trigger_kind: baseline ? "create" : "pull",
  });
  await insertVersion(env.DB, {
    id, page_id: pageId, run_id: `run-${id}`, is_baseline: 0, captured_at: at, text,
    normalized_hash: await hashText(normalize(text).text), judgment_summary: null, screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`, capture_status: "complete", facts_status: "not_needed", ...over,
  });
  return id;
}

const all = async <T>(sql: string, ...b: unknown[]): Promise<T[]> => (await env.DB.prepare(sql).bind(...b).all<T>()).results;
const versionRow = async (id: string) => (await all<VersionRow>("SELECT * FROM versions WHERE id = ?", id))[0]!;
const get = async (path: string): Promise<Json> => (await callWorker(path)).json();
const post = (path: string, headers: Record<string, string> = ADMIN) => callWorker(path, { method: "POST", headers });
const deltaOf = async (id: string) => {
  const stored = (await versionRow(id)).delta_json;
  return stored === null ? null : JSON.parse(stored);
};

// --- Texts --------------------------------------------------------------------------------------

const BEFORE = [
  "# Example pricing",
  "",
  "## Pro",
  "",
  "The Pro plan costs $20 per month for every seat in the workspace.",
  "",
  "## Team",
  "",
  "Legacy seats are billed once a year in advance.",
  "",
  "## Help",
  "",
  "Contact sales for anything else.",
].join("\n");
// One block changed (Pro), one removed (Team's paragraph), one added (a new paragraph under Help).
const AFTER = [
  "# Example pricing",
  "",
  "## Pro",
  "",
  "The Pro plan costs $25 per month for every seat in the workspace.",
  "",
  "## Team",
  "",
  "## Help",
  "",
  "Contact sales for anything else.",
  "",
  "Zebra quartz xylophones now ship with every order worldwide.",
].join("\n");

/** Thirty price rows, each a block of its own. */
const rowsAsBlocks = (price20 = "$20") =>
  ["# Plans", "", ...Array.from({ length: 30 }, (_, i) => [`Plan ${i + 1}: ${i === 4 ? price20 : `$${100 + i}`} per month, billed yearly.`, ""]).flat()].join("\n");
/** The same rows as one table. */
const rowsAsTable = (price20 = "$20") =>
  [
    "# Plans",
    "",
    "| Plan | Price |",
    "| --- | --- |",
    ...Array.from({ length: 30 }, (_, i) => `| Plan ${i + 1}: | ${i === 4 ? price20 : `$${100 + i}`} per month, billed yearly. |`),
  ].join("\n");

// --- Fake TinyBrowser -------------------------------------------------------------------------------

type Sent = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
const FULL_B64 = btoa("\xff\xd8full-page\xff\xd9");
const THUMB_B64 = btoa("\xff\xd8thumb\xff\xd9");
const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Answers TinyBrowser's session create and the CDP socket in-process: every command gets a plausible
 * reply, the full-page capture (scale 1) one image and the clip (scale 0.5) another. `failThumb` makes the
 * clip fail; `imageLoads(n)` answers the n-th wait for an image.
 */
function fakeBrowser(
  opts: { failThumb?: boolean; hangThumb?: boolean; hangClose?: boolean; imageLoads?: (n: number) => boolean; events?: string[] } = {},
) {
  const sent: Sent[] = [];
  let sessions = 0;
  fetchMock.intercept({
    method: "POST",
    url: BROWSER_API,
    times: Infinity,
    reply: () => Response.json({ session_id: `s-${++sessions}`, cdp_url: "wss://cdp.example/devtools/browser/s-1" }),
  });
  fetchMock.intercept({
    method: "GET",
    url: CDP_HTTP,
    times: Infinity,
    reply: () => {
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      let waits = 0;
      server.addEventListener("message", (m) => {
        const msg = JSON.parse(String(m.data)) as Sent;
        sent.push(msg);
        opts.events?.push(msg.method);
        const reply = (result: unknown) => server.send(JSON.stringify({ id: msg.id, result }));
        switch (msg.method) {
          case "Target.getTargets":
            return reply({ targetInfos: [{ type: "page", targetId: "t-1" }] });
          case "Target.attachToTarget":
            return reply({ sessionId: "cdp-1" });
          case "Page.getLayoutMetrics":
            return reply({ cssContentSize: { height: 2400 } });
          case "Page.captureScreenshot": {
            const scale = (msg.params.clip as { scale: number }).scale;
            if (scale !== 1 && opts.failThumb) return server.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: "no clip" } }));
            if (scale !== 1 && opts.hangThumb) return; // never answered
            return reply({ data: scale === 1 ? FULL_B64 : THUMB_B64 });
          }
          case "Runtime.evaluate":
            return reply({ result: { type: "boolean", value: opts.imageLoads?.(++waits) ?? true } });
          case "Browser.close":
            if (opts.hangClose) return; // never answered, socket left open
            reply({});
            server.close(1000, "closed");
            return;
          default:
            return reply({});
        }
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    },
  });
  // The driver decodes the full screenshot's base64 through fetch.
  fetchMock.intercept({
    method: "GET",
    url: /^data:image\/jpeg;base64,/,
    times: Infinity,
    reply: (req) => new Response(bytesOf(req.url.slice("data:image/jpeg;base64,".length))),
  });
  return { sent, sessions: () => sessions };
}

// --- Setup --------------------------------------------------------------------------------------

let shot: MockInstance<typeof captureDeps.screenshotFullPage>;
let errorLog: MockInstance<typeof console.error>;
const realFill = summaryDeps.fill;
const realFillDeltas = summaryDeps.fillDeltas;
const realNow = cronDeps.now;

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  shot = vi.spyOn(captureDeps, "screenshotFullPage").mockImplementation(async () => ({
    bytes: bytesOf(FULL_B64).buffer,
    thumb: bytesOf(THUMB_B64).buffer,
    height: 2400,
    sessionId: "sess-1",
  }));
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fetchMock.reset();
  summaryDeps.fill = realFill;
  summaryDeps.fillDeltas = realFillDeltas;
  cronDeps.now = realNow;
  shot.mockRestore();
  errorLog.mockRestore();
  vi.restoreAllMocks();
});

// --- Delta --------------------------------------------------------------------------------------

describe("the delta of a change", () => {
  it("stores and serves a delta for a change", async () => {
    const page = await seedPage();
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER);

    await computeDelta(env, "v-1");

    const { changes } = await get("/api/changes");
    expect(changes[0].delta).toEqual({ blocks: { added: 1, removed: 1, changed: 1 }, facts: null, layout_only: false });
    expect(changes[0].kind).toBe("pricing");
    // Every version shape carries it: the page detail, versions/:vid and the export.
    const detail = await get(`/api/pages/${page.id}`);
    expect(detail.versions[0].delta).toEqual(changes[0].delta);
    expect((await get(`/api/pages/${page.id}/versions/v-1`)).delta).toEqual(changes[0].delta);
    expect((await get("/api/export.json")).pages[0].versions[0].delta).toEqual(changes[0].delta);
  });

  it("leaves a baseline's delta null", async () => {
    const page = await seedPage();
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await computeDelta(env, "v-0");
    const detail = await get(`/api/pages/${page.id}`);
    expect(detail.versions[0].delta).toBeNull();
    expect((await versionRow("v-0")).delta_json).toBeNull();
  });

  it("is null in the JSON until it is computed", async () => {
    const page = await seedPage();
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER);
    expect((await get("/api/changes")).changes[0].delta).toBeNull();
  });

  it("labels a restructure with the same words and figures as layout only", async () => {
    const page = await seedPage();
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", rowsAsBlocks(), { is_baseline: 1 });
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", rowsAsTable());

    await computeDelta(env, "v-1");

    const delta = await deltaOf("v-1");
    expect(delta.layout_only).toBe(true);
    expect(delta.blocks.removed).toBeGreaterThanOrEqual(20);
    // A label, never a suppression: the version, its screenshot and its diff stay.
    expect(await versionRow("v-1")).toMatchObject({ screenshot_key: "shots/v-1.jpg" });
    expect((await get("/api/changes")).changes.map((c: Json) => c.version_id)).toEqual(["v-1"]);
    const diff = await get(`/api/pages/${page.id}/diff?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`);
    expect(diff.blocks.removed.length).toBeGreaterThan(0);
    const stats = await get("/api/stats");
    expect(stats.layout_only).toBe(1);
    expect(stats.changes).toBe(0);
  });

  it("does not label a real price change as layout only", async () => {
    const page = await seedPage();
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", rowsAsBlocks(), { is_baseline: 1 });
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", rowsAsTable("$25"));
    await computeDelta(env, "v-1");
    expect((await deltaOf("v-1")).layout_only).toBe(false);
    const stats = await get("/api/stats");
    expect([stats.layout_only, stats.changes]).toEqual([0, 1]);
  });

  it("fills the facts part once both versions' facts are stored, without blocking the rest", async () => {
    const page = await seedPage();
    const pro = (price: string) => JSON.stringify([{ name: "Pro", price, unit: "month", notes: null }, { name: "Team", price: "$40", unit: "month", notes: null }]);
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1, facts_json: pro("$20"), facts_status: "ok" });
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER, { facts_status: "pending", summary: "s", summary_source: "diff" });

    await computeDelta(env, "v-1");
    expect(await deltaOf("v-1")).toEqual({ blocks: { added: 1, removed: 1, changed: 1 }, facts: null, layout_only: false });

    // The facts land later; the next delta fill adds them without reading a text.
    await updateCapture(env.DB, "v-1", {
      facts_json: JSON.stringify([{ name: "Pro", price: "$25", unit: "month", notes: null }, { name: "Ultra", price: "$90", unit: "month", notes: null }]),
      facts_status: "ok",
    });
    const answer = await (await post("/api/admin/backfill-deltas")).json();
    expect(answer).toMatchObject({ filled: 0, facts_filled: 1, remaining: 0, oversized: [] });
    expect((await deltaOf("v-1")).facts).toEqual({ added: 1, removed: 1, changed: 1 });
    // Once filled it stays.
    expect(await (await post("/api/admin/backfill-deltas")).json()).toMatchObject({ filled: 0, facts_filled: 0 });
  });
});

describe("isLayoutOnly", () => {
  const diffOf = (from: string, to: string) => structuredDiff(normalize(from).text, normalize(to).text);
  /** A release-notes page of `n` entries without prices, about 90 characters each. */
  const notes = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `Release entry ${from + i}: improved the workspace settings and the sharing dialog for teams.`).join("\n\n");

  it("labels rows merged into a table: same words, same prices, at least 20 blocks touched, skewed", () => {
    expect(isLayoutOnly(diffOf(rowsAsBlocks(), rowsAsTable()))).toBe(true);
    expect(changedRegionOverlap(diffOf(rowsAsBlocks(), rowsAsTable()))).toBeGreaterThanOrEqual(0.85);
    // A price changed.
    expect(isLayoutOnly(diffOf(rowsAsBlocks(), rowsAsTable("$25")))).toBe(false);
    // Different words.
    expect(isLayoutOnly(diffOf(rowsAsBlocks(), rowsAsTable().replace(/billed yearly/g, "charged on the first of each month to the card on file")))).toBe(false);
  });

  it("does not label too few blocks touched, or blocks replaced one for one (no skew)", () => {
    const nineteen = ["# Plans", "", ...Array.from({ length: 19 }, (_, i) => [`Plan ${i + 1}: $${100 + i} per month, billed yearly.`, ""]).flat()].join("\n");
    const nineteenTable = ["# Plans", "", ...Array.from({ length: 19 }, (_, i) => `| Plan ${i + 1}: | $${100 + i} per month, billed yearly. |`)].join("\n");
    expect(isLayoutOnly(diffOf(nineteen, nineteenTable))).toBe(false);
    // 30 blocks each reworded in place: 30 removed and 30 added, skew 0.
    const reworded = rowsAsBlocks().replace(/billed yearly/g, "billed yearly in advance");
    const d = diffOf(rowsAsBlocks(), reworded);
    expect(d.added.length - d.removed.length).toBe(0);
    expect(isLayoutOnly(d)).toBe(false);
  });

  it("a pure addition of 20 paragraphs on a large page is not layout only, and its overlap score is 0", () => {
    const page = notes(300);
    expect(page.length).toBeGreaterThan(14_000);
    const d = diffOf(page, `${notes(20, 1000)}\n\n${page}`);
    expect([d.added.length, d.removed.length]).toEqual([20, 0]);
    expect(changedRegionOverlap(d)).toBe(0);
    expect(isLayoutOnly(d)).toBe(false);
  });

  it("trimming 25 old blocks while adding one new entry is not layout only", () => {
    const page = notes(100);
    const d = diffOf(page, `New release: the sharing dialog now lists every member of the team.\n\n${notes(75)}`);
    expect([d.added.length, d.removed.length]).toEqual([1, 25]);
    expect(changedRegionOverlap(d)).toBeLessThan(0.2);
    expect(isLayoutOnly(d)).toBe(false);
  });

  it("does not count the words of a changed region over 40,000 characters", () => {
    // The same restructure with long rows: over the cap, so no label (and no word counted).
    const long = (table: boolean) =>
      [
        "# Plans",
        "",
        ...Array.from({ length: 30 }, (_, i) => {
          const row = `Plan ${i + 1}: $${100 + i} per month, billed yearly. ${"Includes the full feature set for every seat. ".repeat(15)}`;
          return table ? [`| ${row} |`] : [row, ""];
        }).flat(),
      ].join("\n");
    const d = diffOf(long(false), long(true));
    expect(changedRegionOverlap(d)).toBeGreaterThan(0.85);
    expect(isLayoutOnly(d)).toBe(false);
  });
});

// --- Layout hold --------------------------------------------------------------------------------

describe("the layout hold", () => {
  const MONITOR = (pageId: string) => `mon-${pageId}`;
  /** A long paragraph, about 560 characters. */
  const para = (i: number) => `Section ${i}. ${"The plan includes unlimited projects, priority support and audit logs for every member of the workspace. ".repeat(5).trim()}`;
  const row = (i: number) => `Feature ${i}: included in the Team and Enterprise plans.`;
  const shortRow = (i: number) => `| Feature ${i} | Team and Enterprise |`;
  /** 56 paragraphs and 229 rows, each a block: 285 blocks. */
  const LONG = [...Array.from({ length: 56 }, (_, i) => para(i)), ...Array.from({ length: 229 }, (_, i) => row(i))].join("\n\n");
  /** The 56 paragraphs and the rows shortened into one table block: 57 blocks, 1 of them added. */
  const SHRUNK = [...Array.from({ length: 56 }, (_, i) => para(i)), Array.from({ length: 229 }, (_, i) => shortRow(i)).join("\n")].join("\n\n");

  function mockRunNow(pageId: string, runId: string, text: string): void {
    const body = structuredClone(runNowFixture) as Json;
    body.run.id = runId;
    body.run.errors = [];
    body.run.results[0].text = text;
    fetchMock.intercept({ method: "POST", url: `${MONITORS_API}/${MONITOR(pageId)}/runs`, reply: { status: 201, json: body } });
  }
  const pull = async (pageId: string, runId: string, text: string): Promise<Json> => {
    mockRunNow(pageId, runId, text);
    return (await post(`/api/admin/pull/${pageId}`)).json();
  };

  beforeEach(() => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, times: Infinity, reply: { json: { results: [{ text: "<html></html>" }] } } });
    summaryDeps.fill = async () => new Response(null);
  });

  it("holds a shrinking restructure for a confirm read", async () => {
    const page = await seedPage({ kind: "policy" });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", LONG, { is_baseline: 1 });
    const d = structuredDiff(normalize(LONG).text, normalize(SHRUNK).text);
    expect([d.removed.length, d.added.length]).toEqual([229, 1]);
    const ratio = normalize(SHRUNK).text.length / normalize(LONG).text.length;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(0.95);

    const first = await pull(page.id, "tf-hold", SHRUNK);
    expect(first).toMatchObject({ pulled: true, outcome: "changed", suppressed: true });
    expect(first.version_id).toBeUndefined();
    const [run] = await all<RunRow>("SELECT * FROM runs WHERE page_id = ? AND monitor_run_id = 'tf-hold'", page.id);
    expect(run).toMatchObject({ noise_suppressed: 1, noise_reason: "layout_hold" });
    const held = (await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first<PageRow>())!;
    expect(held.pending_hash).toBe(await hashText(normalize(SHRUNK).text));
    expect(held.pending_run_id).toBe(run!.id);
    expect((await get("/api/stats")).noise_by_reason).toMatchObject({ layout_hold: 1, partial_render: 0 });

    // The second read agrees: now it is a version, with a note naming the held read.
    const second = await pull(page.id, "tf-confirm", SHRUNK);
    expect(second.version_id).toBeTypeOf("string");
    expect(await versionRow(second.version_id)).toMatchObject({ text: SHRUNK, notes: `confirmed after suspect run ${run!.id}` });
    const after = (await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first<PageRow>())!;
    expect([after.pending_hash, after.pending_run_id, after.pending_at]).toEqual([null, null, null]);
  });

  it("does not hold a shrink that adds more than 5% of what it removes, or removes fewer than 20 blocks", async () => {
    const page = await seedPage({ kind: "policy" });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", LONG, { is_baseline: 1 });
    // 229 rows removed, 12 new paragraphs added (over 5% of 229).
    const withNews = `${SHRUNK}\n\n${Array.from({ length: 12 }, (_, i) => `News item ${i}: a new paragraph that was not on the page before.`).join("\n\n")}`;
    expect(normalize(withNews).text.length / normalize(LONG).text.length).toBeLessThan(0.95);
    expect((await pull(page.id, "tf-news", withNews)).version_id).toBeTypeOf("string");

    const page2 = await seedPage({ kind: "policy" });
    const nineteen = [...Array.from({ length: 10 }, (_, i) => para(i)), ...Array.from({ length: 19 }, (_, i) => row(i))].join("\n\n");
    await seedVersion(page2.id, "v2-0", "2026-11-01T00:00:00.000Z", nineteen, { is_baseline: 1 });
    const fewer = Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n");
    expect(normalize(fewer).text.length / normalize(nineteen).text.length).toBeLessThan(0.95);
    expect((await pull(page2.id, "tf-fewer", fewer)).version_id).toBeTypeOf("string");
  });

  it("a partial render is still a partial render (it is checked first)", async () => {
    const page = await seedPage({ kind: "policy" });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", LONG, { is_baseline: 1 });
    const cut = Array.from({ length: 20 }, (_, i) => para(i)).join("\n\n");
    expect(await pull(page.id, "tf-cut", cut)).toMatchObject({ suppressed: true });
    expect((await all<RunRow>("SELECT * FROM runs WHERE monitor_run_id = 'tf-cut'"))[0]).toMatchObject({ noise_reason: "partial_render" });
  });

  it("a suspect that replaces a suspect keeps the first pending_at, so reads that never agree stop being confirmed after 24 hours", async () => {
    const page = await seedPage({ kind: "policy" });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", LONG, { is_baseline: 1 });
    await pull(page.id, "tf-first", SHRUNK);
    const first = (await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first<PageRow>())!;
    // The first suspect read was 20 hours ago.
    const twentyHoursAgo = new Date(Date.now() - 20 * 3_600_000).toISOString();
    await env.DB.prepare("UPDATE pages SET pending_at = ? WHERE id = ?").bind(twentyHoursAgo, page.id).run();

    // A different suspect read (also a shrinking restructure) replaces the pending hash and run, not the time.
    const other = `${SHRUNK}\n\nOne more line that the second suspect read has.`;
    expect(await pull(page.id, "tf-second", other)).toMatchObject({ suppressed: true });
    const second = (await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first<PageRow>())!;
    expect(second.pending_hash).toBe(await hashText(normalize(other).text));
    expect(second.pending_hash).not.toBe(first.pending_hash);
    expect(second.pending_run_id).not.toBe(first.pending_run_id);
    expect(second.pending_at).toBe(twentyHoursAgo);

    // Once the first is past the 24-hour window, the next suspect starts a new one.
    const dayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await env.DB.prepare("UPDATE pages SET pending_at = ? WHERE id = ?").bind(dayAgo, page.id).run();
    await pull(page.id, "tf-third", SHRUNK);
    const third = (await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first<PageRow>())!;
    expect(Date.parse(third.pending_at!)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("/api/stats always has the layout_hold key", async () => {
    expect((await get("/api/stats")).noise_by_reason).toEqual({ normalized_identical: 0, partial_render: 0, flap: 0, layout_hold: 0 });
  });

  it("the admin replay decides a held read as layout_hold and marks its run", async () => {
    const page = await seedPage({ kind: "policy" });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", LONG, { is_baseline: 1 });
    const body = structuredClone(runNowFixture) as Json;
    body.run.id = "tf-old";
    body.run.results[0].text = SHRUNK;
    await env.STORE.put("raw/tf-old.json", JSON.stringify(body));
    await insertRun(env.DB, {
      id: "run-old", page_id: page.id, monitor_run_id: "tf-old", outcome: "changed", is_baseline: 0, judgment_relevant: null,
      judgment_summary: null, diff_truncated: 0, noise_suppressed: 0, noise_reason: null, raw_key: "raw/tf-old.json",
      received_at: "2026-11-02T00:00:00.000Z", trigger_kind: "pull",
    });

    const answer: Json = await (await post(`/api/pages/${page.id}/replay`)).json();

    expect(answer).toMatchObject({ created: 0, suppressed: 1 });
    expect(answer.decisions[0]).toMatchObject({ run_id: "run-old", decision: "layout_hold" });
    expect((await all<RunRow>("SELECT * FROM runs WHERE id = 'run-old'"))[0]).toMatchObject({ noise_suppressed: 1, noise_reason: "layout_hold" });
  });
});

describe("a pulled change gets its summary and its delta in one out-of-band request", () => {
  it("the summary request computes the delta from the same diff", async () => {
    const page = await seedPage({ kind: "policy" });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    fetchMock.intercept({ method: "POST", url: FETCH_API, times: Infinity, reply: { json: { results: [{ text: "<html></html>" }] } } });
    const body = structuredClone(runNowFixture) as Json;
    body.run.id = "tf-pulled";
    body.run.errors = [];
    body.run.results[0].text = AFTER;
    fetchMock.intercept({ method: "POST", url: `${MONITORS_API}/mon-${page.id}/runs`, reply: { status: 201, json: body } });
    const fills = vi.fn((e: Env, id?: string) => realFill(e, id));
    summaryDeps.fill = fills;

    const res: Json = await (await post(`/api/admin/pull/${page.id}`)).json();

    expect(fills.mock.calls.map(([, id]) => id)).toEqual([res.version_id]);
    expect(await versionRow(res.version_id)).toMatchObject({
      summary: '1 block added, 1 changed, 1 removed: "The Pro plan costs $25 per month for every seat in the workspace."',
      summary_source: "diff",
    });
    expect(await deltaOf(res.version_id)).toEqual({ blocks: { added: 1, removed: 1, changed: 1 }, facts: null, layout_only: false });
  });
});

describe("the summary step stores the summary before it works out the delta", () => {
  it("a delta that fails leaves the summary stored and the version listed", async () => {
    const page = await seedPage({ monitor_id: null, schedule_cron: null });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1, facts_json: JSON.stringify([{ price: "$1" }]) });
    // Facts without a name: the facts part of the delta throws, after the summary is written.
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER, { facts_json: JSON.stringify([{ price: "$2" }]) });

    expect(await (await post("/api/admin/backfill-summaries")).json()).toEqual({ filled: 1, remaining: 0, oversized: ["v-1"] });
    expect(await versionRow("v-1")).toMatchObject({
      summary: '1 block added, 1 changed, 1 removed: "The Pro plan costs $25 per month for every seat in the workspace."',
      summary_source: "diff",
      delta_json: null,
    });
    expect(errorLog).toHaveBeenCalled();
  });
});

describe("the summary fill's per-call limits", () => {
  it("diffs at most 12 versions a call, and a version that fails is listed and does not stop the others", async () => {
    const page = await seedPage({ monitor_id: null, schedule_cron: null });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    for (let i = 1; i <= 14; i++) {
      const at = new Date(Date.parse("2026-11-02T00:00:00.000Z") + i * 60_000).toISOString();
      await seedVersion(page.id, `v-${i}`, at, `${BEFORE}\n\nNote number ${i}, a line long enough to be quoted in full.`);
    }
    await env.DB.prepare("UPDATE versions SET text = NULL WHERE id = 'v-2'").run();
    errorLog.mockClear();

    // v-2 fails (and so does v-3, whose previous version is v-2): both are listed, and twelve are diffed in all.
    expect(await (await post("/api/admin/backfill-summaries")).json()).toEqual({ filled: 10, remaining: 4, oversized: ["v-2", "v-3"] });
    expect(errorLog).toHaveBeenCalled();
    expect(await versionRow("v-1")).toMatchObject({ summary: '1 block added: "Note number 1, a line long enough to be quoted in full."' });
    expect(await deltaOf("v-1")).not.toBeNull();
    // The next call takes the rest; the two bad ones are listed again.
    expect(await (await post("/api/admin/backfill-summaries")).json()).toEqual({ filled: 2, remaining: 2, oversized: ["v-2", "v-3"] });
  });
});

// --- The summary line rule ---------------------------------------------------------------------------

describe("the summary line rule", () => {
  const summarize = (from: string, to: string) => {
    const next = normalize(to).text;
    return diffSummary(structuredDiff(normalize(from).text, next), next);
  };
  const INTRO = "Intro paragraph that stays the same in both versions.";

  it("skips a heading when it quotes a line in a diff summary", () => {
    const to = [INTRO, "", "## November 4, 2026", "", "We have raised the file upload limit to 50 files per chat."].join("\n");
    expect(summarize(INTRO, to)).toBe('2 blocks added: "We have raised the file upload limit to 50 files per chat."');
  });

  it("skips a bare date and any line of 30 characters or fewer", () => {
    const to = [INTRO, "", "Wednesday, September 23rd, 2026", "", "Short line.", "", "Projects are now limited to twenty per workspace."].join("\n");
    expect(summarize(INTRO, to)).toBe('3 blocks added: "Projects are now limited to twenty per workspace."');
  });

  it("gives the counts alone when no added or changed line qualifies", () => {
    const from = ["## Pro", "", "Pro plan", "$20 per month", "10 projects"].join("\n");
    const to = ["## Pro", "", "Pro plan", "$25 per month", "10 projects"].join("\n");
    expect(summarize(from, to)).toBe("1 block changed");
  });

  it("takes the first qualifying line in the order of the new text, across added and changed blocks", () => {
    const from = ["## A", "", "Alpha costs $1 per month for each seat in the team.", "", "## B", "", "Beta"].join("\n");
    const to = ["## A", "", "Alpha costs $2 per month for each seat in the team.", "", "## B", "", "Beta", "", "Gamma is a new plan for large teams with SSO."].join("\n");
    expect(summarize(from, to)).toBe('1 block added, 1 changed: "Alpha costs $2 per month for each seat in the team."');
  });
});

// --- The delta backfill and the one-off rebuild of diff summaries ----------------------------------

describe("POST /api/admin/backfill-deltas", () => {
  const OLD_LINE = '1 block changed: "$25 per month"';

  async function seedHistory(): Promise<string> {
    const page = await seedPage({ monitor_id: null, schedule_cron: null });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    // Summaries stored before the line rule: a diff line and a TinyFish one.
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER, { summary: OLD_LINE, summary_source: "diff" });
    await seedVersion(page.id, "v-2", "2026-11-03T00:00:00.000Z", `${AFTER}\n\nA closing note that only the third version has.`, {
      judgment_summary: "TinyFish: a closing note was added.",
    });
    return page.id;
  }

  it("is admin only", async () => {
    const res = await post("/api/admin/backfill-deltas", {});
    expect(res.status).toBe(401);
  });

  it("fills every missing delta, rebuilding each diff summary once with the line rule and leaving TinyFish's alone", async () => {
    const pageId = await seedHistory();
    // A diff of v-0 to v-1 is cached with the old summary.
    await get(`/api/pages/${pageId}/diff?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`);
    expect(await all("SELECT to_version_id FROM diff_cache")).toEqual([{ to_version_id: "v-1" }]);

    expect(await (await post("/api/admin/backfill-deltas")).json()).toEqual({ filled: 2, rebuilt: 1, facts_filled: 0, remaining: 0, oversized: [] });

    expect(await versionRow("v-1")).toMatchObject({
      summary: '1 block added, 1 changed, 1 removed: "The Pro plan costs $25 per month for every seat in the workspace."',
      summary_source: "diff",
    });
    expect(await versionRow("v-2")).toMatchObject({ summary: "TinyFish: a closing note was added.", summary_source: "tinyfish" });
    expect(await deltaOf("v-2")).toEqual({ blocks: { added: 1, removed: 0, changed: 0 }, facts: null, layout_only: false });
    // The cached diff held the old line: it is dropped, and the next request shows the new one.
    expect(await all("SELECT to_version_id FROM diff_cache")).toEqual([]);
    const diff = await get(`/api/pages/${pageId}/diff?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`);
    expect(diff.summary).toMatch(/^1 block added, 1 changed, 1 removed: "The Pro plan/);

    // Once: a second call changes nothing.
    const before = await all("SELECT * FROM versions ORDER BY rowid");
    expect(await (await post("/api/admin/backfill-deltas")).json()).toEqual({ filled: 0, rebuilt: 0, facts_filled: 0, remaining: 0, oversized: [] });
    expect(await all("SELECT * FROM versions ORDER BY rowid")).toEqual(before);
  });

  it("leaves a version without a summary to the summary fill, which writes its delta too", async () => {
    const page = await seedPage({ monitor_id: null, schedule_cron: null });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER);
    expect(await (await post("/api/admin/backfill-deltas")).json()).toEqual({ filled: 0, rebuilt: 0, facts_filled: 0, remaining: 1, oversized: [] });
    expect(await (await post("/api/admin/backfill-summaries")).json()).toEqual({ filled: 1, remaining: 0, oversized: [] });
    expect(await deltaOf("v-1")).toEqual({ blocks: { added: 1, removed: 1, changed: 1 }, facts: null, layout_only: false });
  });

  it("diffs at most 12 versions a call", async () => {
    const page = await seedPage({ monitor_id: null, schedule_cron: null });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    for (let i = 1; i <= 15; i++) {
      const at = new Date(Date.parse("2026-11-02T00:00:00.000Z") + i * 60_000).toISOString();
      await seedVersion(page.id, `v-${i}`, at, `${BEFORE}\n\nNote number ${i} that was added to the page.`, { judgment_summary: `TinyFish ${i}` });
    }
    expect(await (await post("/api/admin/backfill-deltas")).json()).toMatchObject({ filled: 12, remaining: 3 });
    expect(await (await post("/api/admin/backfill-deltas")).json()).toMatchObject({ filled: 3, remaining: 0 });
  });

  it("a version that fails is listed and does not stop the others; ?version= works on one version", async () => {
    const page = await seedPage({ monitor_id: null, schedule_cron: null });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await seedVersion(page.id, "v-good", "2026-11-02T00:00:00.000Z", AFTER, { judgment_summary: "TinyFish good" });
    await seedVersion(page.id, "v-bad", "2026-11-03T00:00:00.000Z", BEFORE, { judgment_summary: "TinyFish bad" });
    await env.DB.prepare("UPDATE versions SET text = NULL WHERE id = 'v-bad'").run();

    expect(await (await post("/api/admin/backfill-deltas")).json()).toEqual({ filled: 1, rebuilt: 0, facts_filled: 0, remaining: 1, oversized: ["v-bad"] });
    expect(await deltaOf("v-good")).not.toBeNull();
    expect(errorLog).toHaveBeenCalled();

    await env.DB.prepare("UPDATE versions SET text = ? WHERE id = 'v-bad'").bind(BEFORE).run();
    expect(await (await post("/api/admin/backfill-deltas?version=v-bad")).json()).toMatchObject({ filled: 1, remaining: 0, oversized: [] });
  });
});

describe("the hourly cron's fills", () => {
  /** Text this long, with its predecessor as long, is over the per-call budget. */
  const huge = (n: number) => "x".repeat(30_500) + `\n\nEntry ${n} of a very long page.`;

  it("asks for a delta fill when deltas are missing, and rotates its one ?version= request through the oversized versions", async () => {
    const page = await seedPage({ kind: "policy", monitor_id: null, schedule_cron: null });
    await seedVersion(page.id, "big-0", "2026-11-01T00:00:00.000Z", huge(0), { is_baseline: 1 });
    await seedVersion(page.id, "big-1", "2026-11-02T00:00:00.000Z", huge(1), { judgment_summary: "TinyFish one" });
    await seedVersion(page.id, "big-2", "2026-11-03T00:00:00.000Z", huge(2), { judgment_summary: "TinyFish two" });
    const calls = vi.fn((e: Env, id?: string) => realFillDeltas(e, id));
    summaryDeps.fillDeltas = calls;
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Two oversized versions; at 01:30 UTC the tick takes the second (1 mod 2).
    cronDeps.now = () => new Date("2026-11-07T01:30:00.000Z");
    await runCron(env);
    expect(calls.mock.calls.map(([, id]) => id)).toEqual([undefined, "big-2"]);
    expect(await deltaOf("big-2")).not.toBeNull();

    calls.mockClear();
    await runCron(env);
    expect(calls.mock.calls.map(([, id]) => id)).toEqual([undefined, "big-1"]);

    calls.mockClear();
    await runCron(env);
    expect(calls).not.toHaveBeenCalled();
  });
});

// --- Stats --------------------------------------------------------------------------------------

describe("the stats the site shows", () => {
  it("reports the counts the site needs", async () => {
    const seededPage = await seedPage();
    await seedVersion(seededPage.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await seedVersion(seededPage.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER);
    const s = await (await SELF.fetch("https://x/api/stats")).json<Json>();
    expect(s.changes).toBe(1);
    expect(s.layout_only).toBe(0);
    expect(s.recording_since).toBe(seededPage.created_at);
    expect(s.public_slots).toEqual({ total: 4, used: 0, next_free_at: null });
  });

  it("counts the public slots in use and when the next one frees", async () => {
    await seedPage({ added_by: "public", expires_at: "2026-11-12T00:00:00.000Z" });
    await seedPage({ added_by: "public", expires_at: "2026-11-10T00:00:00.000Z" });
    await seedPage({ added_by: "public", status: "expired", expires_at: "2026-11-01T00:00:00.000Z" });
    expect((await get("/api/stats")).public_slots).toEqual({ total: 4, used: 2, next_free_at: "2026-11-10T00:00:00.000Z" });
  });

  it("the home's week count counts what Stats.changes counts: layout-only changes stay in the feed but out of both counts", async () => {
    const day = 86_400_000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
    const tables = await seedPage({ label: "Tables page" });
    await seedVersion(tables.id, "t-0", at(3), rowsAsBlocks(), { is_baseline: 1 });
    await seedVersion(tables.id, "t-1", at(2), rowsAsTable());
    const prices = await seedPage({ label: "Prices page" });
    await seedVersion(prices.id, "p-0", at(3), BEFORE, { is_baseline: 1 });
    await seedVersion(prices.id, "p-1", at(1), AFTER);
    await computeDelta(env, "t-1");
    await computeDelta(env, "p-1");
    expect((await deltaOf("t-1")).layout_only).toBe(true);

    const stats = await get("/api/stats");
    expect([stats.changes, stats.layout_only]).toEqual([1, 1]);
    const home = await (await SELF.fetch("https://x/")).text();
    expect(home).toContain('<a href="#feed">1 real change this week, newest first</a>');
    // The feed still lists the layout-only change, tagged in the site's later task.
    expect(home).toContain("Tables page");
    expect(home).toContain("Prices page");
  });

  it("has no recording_since on an empty database", async () => {
    expect((await get("/api/stats")).recording_since).toBeNull();
  });
});

// --- Public adds --------------------------------------------------------------------------------

describe("public adds", () => {
  it("never starts a facts run for a public add", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, times: Infinity, reply: { json: fetchFixture } });
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: monitorCreate } });

    const res = await callWorker("/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "198.51.100.7" },
      body: JSON.stringify({ url: "https://vercel.com/pricing", kind: "pricing" }),
    });
    expect(res.status).toBe(201);
    const body: Json = await res.json();
    expect(body.page).toMatchObject({ added_by: "public", kind: "pricing" });
    expect(await versionRow(body.baseline_version_id)).toMatchObject({ facts_status: "not_needed", capture_status: "complete" });
    // Not now, and not from the queue later.
    expect(await startNextFacts(env)).toBe(false);
    expect(fetchMock.calls.filter((c) => c.url === RUN_ASYNC_API)).toEqual([]);
  });

  it("an admin add of a pricing page still takes its facts", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, times: Infinity, reply: { json: fetchFixture } });
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: monitorCreate } });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "agent-run-1" } } });
    const res = await callWorker("/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json", ...ADMIN },
      body: JSON.stringify({ url: "https://vercel.com/pricing", kind: "pricing" }),
    });
    const body: Json = await res.json();
    expect(await versionRow(body.baseline_version_id)).toMatchObject({ facts_status: "pending", agent_run_id: "agent-run-1" });
  });
});

// --- Thumbnails ---------------------------------------------------------------------------------

describe("thumbnails", () => {
  it("stores the thumbnail taken with the screenshot", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, times: Infinity, reply: { json: { results: [{ text: "<html></html>" }] } } });
    const page = await seedPage({ kind: "policy" });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, {
      is_baseline: 1, screenshot_key: null, html_key: null, capture_status: "pending",
    });

    await captureVersion(env, "v-0");

    expect(shot).toHaveBeenCalledTimes(1); // one session for both images
    const thumb = await env.STORE.get("thumbs/v-0.jpg");
    expect(new Uint8Array(await thumb!.arrayBuffer())).toEqual(bytesOf(THUMB_B64));
    expect(thumb!.httpMetadata?.contentType).toBe("image/jpeg");
    expect(await versionRow("v-0")).toMatchObject({ screenshot_key: "shots/v-0.jpg", thumb_key: "thumbs/v-0.jpg", capture_status: "complete" });
    const detail = await get(`/api/pages/${page.id}`);
    expect(detail.versions[0].thumb_url).toBe(`${BASE}/thumbs/v-0.jpg`);
    expect(detail.versions[0].screenshot_url).toBe(`${BASE}/shots/v-0.jpg`);
  });

  it("a thumbnail that could not be taken leaves the screenshot and the version as they are", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, times: Infinity, reply: { json: { results: [{ text: "<html></html>" }] } } });
    shot.mockImplementation(async () => ({ bytes: bytesOf(FULL_B64).buffer, thumb: null, height: 2400, sessionId: "sess-1" }));
    const page = await seedPage({ kind: "policy" });
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, {
      is_baseline: 1, screenshot_key: null, html_key: null, capture_status: "pending",
    });
    await captureVersion(env, "v-0");
    expect(await versionRow("v-0")).toMatchObject({
      screenshot_key: "shots/v-0.jpg", thumb_key: null, capture_status: "complete", capture_error: null, capture_attempts: 1,
    });
  });

  it("returns thumb_url null and keeps screenshot_url when no thumb exists", async () => {
    const page = await seedPage();
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER);
    const [change] = (await get("/api/changes")).changes;
    expect(change).toMatchObject({ screenshot_url: `${BASE}/shots/v-1.jpg`, thumb_url: null });
    const one = await get(`/api/pages/${page.id}/versions/v-1`);
    expect(one).toMatchObject({ screenshot_url: `${BASE}/shots/v-1.jpg`, thumb_url: null });
  });

  it("GET /thumbs/:name serves the thumbnail with the same headers as /shots", async () => {
    await env.STORE.put("thumbs/v-9.jpg", bytesOf(THUMB_B64), { httpMetadata: { contentType: "image/jpeg" } });
    await env.STORE.put("shots/v-9.jpg", bytesOf(FULL_B64), { httpMetadata: { contentType: "image/jpeg" } });
    const thumb = await callWorker("/thumbs/v-9.jpg", { headers: { Origin: "https://judge.example" } });
    const full = await callWorker("/shots/v-9.jpg", { headers: { Origin: "https://judge.example" } });
    expect(thumb.status).toBe(200);
    for (const name of ["content-type", "cache-control", "content-security-policy", "x-content-type-options", "access-control-allow-origin"]) {
      expect(thumb.headers.get(name), name).toBe(full.headers.get(name));
    }
    expect(thumb.headers.get("x-content-type-options")).toBe("nosniff");
    expect(thumb.headers.get("content-security-policy")).toBe("sandbox");
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(bytesOf(THUMB_B64));
    for (const path of ["/thumbs/nope.jpg", "/thumbs/v-9.html", "/thumbs/..%2Fshots%2Fv-9.jpg"]) {
      expect((await callWorker(path)).status, path).toBe(404);
    }
  });

  it("backfills thumbnails for older versions in one session", async () => {
    const browser = fakeBrowser();
    const page = await seedPage();
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER);
    await seedVersion(page.id, "v-2", "2026-11-03T00:00:00.000Z", AFTER, { screenshot_key: null }); // nothing to photograph
    await seedVersion(page.id, "v-3", "2026-11-04T00:00:00.000Z", BEFORE);

    expect(await (await post("/api/admin/thumbs?limit=10")).json()).toEqual({ made: 3, remaining: 0 });

    expect(browser.sessions()).toBe(1);
    expect(browser.sent.filter((m) => m.method === "Browser.close")).toHaveLength(1);
    // Each stored screenshot is opened in a wrapper page and the top 1280 by 800 photographed at half scale.
    const navigations = browser.sent.filter((m) => m.method === "Page.navigate").map((m) => String(m.params.url));
    expect(navigations).toHaveLength(3);
    for (const id of ["v-3", "v-1", "v-0"]) {
      expect(navigations.some((u) => u.startsWith("data:text/html,") && decodeURIComponent(u).includes(`<img src="${BASE}/shots/${id}.jpg" width="1280"`))).toBe(true);
    }
    const clips = browser.sent.filter((m) => m.method === "Page.captureScreenshot").map((m) => m.params);
    expect(clips).toEqual(Array(3).fill({ format: "jpeg", quality: 70, clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 } }));
    for (const id of ["v-0", "v-1", "v-3"]) {
      expect(await versionRow(id)).toMatchObject({ thumb_key: `thumbs/${id}.jpg` });
      expect(await env.STORE.head(`thumbs/${id}.jpg`)).not.toBeNull();
    }
    // One screenshot unit for the session.
    expect(await all("SELECT kind, amount_usd FROM spend")).toEqual([{ kind: "screenshot", amount_usd: 0.002 }]);
    // Nothing left: no session at all.
    expect(await (await post("/api/admin/thumbs")).json()).toEqual({ made: 0, remaining: 0 });
    expect(browser.sessions()).toBe(1);
  });

  it("the backfill stores each thumbnail as it is made, and waits for the expected image", async () => {
    const events: string[] = [];
    const browser = fakeBrowser({ events });
    const put = env.STORE.put.bind(env.STORE);
    vi.spyOn(env.STORE, "put").mockImplementation(((key: string, ...rest: unknown[]) => {
      events.push(`put ${key}`);
      return (put as (...a: unknown[]) => unknown)(key, ...rest);
    }) as typeof env.STORE.put);
    const page = await seedPage();
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await seedVersion(page.id, "v-1", "2026-11-02T00:00:00.000Z", AFTER);

    expect(await (await post("/api/admin/thumbs")).json()).toEqual({ made: 2, remaining: 0 });

    // Both thumbnails were stored while the session was open, each before the next image was opened.
    expect(events.filter((e) => e.startsWith("put ") || e === "Page.navigate" || e === "Browser.close")).toEqual([
      "Page.navigate", "put thumbs/v-1.jpg", "Page.navigate", "put thumbs/v-0.jpg", "Browser.close",
    ]);
    // The wait checks that the image in the page is the stored screenshot it was opened for.
    const waits = browser.sent.filter((m) => m.method === "Runtime.evaluate").map((m) => String(m.params.expression));
    expect(waits[0]).toContain(JSON.stringify(`${BASE}/shots/v-1.jpg`));
    expect(waits[1]).toContain(JSON.stringify(`${BASE}/shots/v-0.jpg`));
  });

  it("an image that does not load is skipped; the session is closed and the rest are made", async () => {
    const browser = fakeBrowser({ imageLoads: (n) => n !== 2 });
    const page = await seedPage();
    for (let i = 0; i < 3; i++) await seedVersion(page.id, `v-${i}`, `2026-11-0${i + 1}T00:00:00.000Z`, BEFORE, { is_baseline: i === 0 ? 1 : 0 });
    expect(await (await post("/api/admin/thumbs?limit=2")).json()).toEqual({ made: 1, remaining: 2 });
    expect(browser.sent.filter((m) => m.method === "Browser.close")).toHaveLength(1);
  });

  it("is admin only, and does nothing at the spend pause", async () => {
    expect((await post("/api/admin/thumbs", {})).status).toBe(401);
    const page = await seedPage();
    await seedVersion(page.id, "v-0", "2026-11-01T00:00:00.000Z", BEFORE, { is_baseline: 1 });
    await recordSpend(env.DB, "monitor_check", 8, "ledger");
    expect(await (await post("/api/admin/thumbs")).json()).toEqual({ made: 0, remaining: 1, reason: "spend_paused" });
    expect(fetchMock.calls).toEqual([]);
  });

  it("the screenshot driver takes the thumbnail as a second capture in the same session", async () => {
    const browser = fakeBrowser();
    const result = await screenshotFullPage(env, "https://example.com/pricing", { settleMs: 0 });
    expect(new Uint8Array(result.bytes)).toEqual(bytesOf(FULL_B64));
    expect(new Uint8Array(result.thumb!)).toEqual(bytesOf(THUMB_B64));
    expect(browser.sessions()).toBe(1);
    // The viewport is 1280 by 800, so the clip is the top of the page as a visitor first sees it.
    expect(browser.sent.find((m) => m.method === "Emulation.setDeviceMetricsOverride")!.params).toMatchObject({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const captures = browser.sent.filter((m) => m.method === "Page.captureScreenshot").map((m) => m.params);
    expect(captures).toEqual([
      { format: "jpeg", quality: 80, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1280, height: 2400, scale: 1 } },
      { format: "jpeg", quality: 70, clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 } },
    ]);
    // Both before the browser is closed, and no second spend row.
    const methods = browser.sent.map((m) => m.method);
    expect(methods.lastIndexOf("Page.captureScreenshot")).toBeLessThan(methods.indexOf("Browser.close"));
    expect(await all("SELECT kind FROM spend")).toEqual([{ kind: "screenshot" }]);
  });

  it("a thumbnail capture that never answers costs only a short wait: the full image comes back and the browser is closed", async () => {
    const browser = fakeBrowser({ hangThumb: true, hangClose: true });
    const started = Date.now();
    const result = await screenshotFullPage(env, "https://example.com/pricing", { settleMs: 0, thumbTimeoutMs: 50, closeWaitMs: 50 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(new Uint8Array(result.bytes)).toEqual(bytesOf(FULL_B64));
    expect(result.thumb).toBeNull();
    expect(browser.sent.filter((m) => m.method === "Browser.close")).toHaveLength(1);
  });

  it("the screenshot driver still returns the full image when the thumbnail capture fails", async () => {
    const browser = fakeBrowser({ failThumb: true });
    const result = await screenshotFullPage(env, "https://example.com/pricing", { settleMs: 0 });
    expect(new Uint8Array(result.bytes)).toEqual(bytesOf(FULL_B64));
    expect(result.thumb).toBeNull();
    expect(browser.sent.filter((m) => m.method === "Browser.close")).toHaveLength(1);
  });
});
