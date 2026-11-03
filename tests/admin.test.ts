import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashText, normalize } from "../src/core/normalize";
import { PURPOSE } from "../src/core/schedule";
import { putCachedDiff } from "../src/db/diffCache";
import { insertPage, type NewPage } from "../src/db/pages";
import { publicAddsToday } from "../src/db/publicAdds";
import { insertRun } from "../src/db/runs";
import type { PageRow, RunRow, VersionRow } from "../src/db/types";
import { insertVersion, pendingCaptures } from "../src/db/versions";
import worker from "../src/index";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import searchFixture from "./fixtures/tinyfish/search.json";
import changedReal from "./fixtures/webhooks/changed-real.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ADMIN = { Authorization: "Bearer test-admin" };
const SECRET = "test-secret";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";

// The page text the Monitor-create baseline stored ($20 Pro), the same text with the Pro price at $25
// (what changed-real.json carries), and the stamp a "Last updated" line adds.
const BASE_TEXT: string = monitorCreate.run.results[0]!.text;
const REAL_TEXT: string = changedReal.results[0]!.text;
const STAMP = "\n\nLast updated: 3 November 2026\n";

const PAGE_ID = "page-replay";
const BASELINE_AT = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-02T01:00:00.000Z";
const T2 = "2026-11-02T02:00:00.000Z";
const T3 = "2026-11-02T03:00:00.000Z";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function send(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return callWorker(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const replay = (id: string = PAGE_ID, headers: Record<string, string> = ADMIN) => send(`/api/pages/${id}/replay`, undefined, headers);
const rotate = (body: unknown, headers: Record<string, string> = ADMIN) => send("/api/admin/rotate-webhook", body, headers);
const discover = (body: unknown, headers: Record<string, string> = {}) => send("/api/discover", body, headers);

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}

const runRow = async (id: string): Promise<RunRow> => (await all<RunRow>("SELECT * FROM runs WHERE id = ?", id))[0]!;
const pageRow = async (id: string): Promise<PageRow> => (await all<PageRow>("SELECT * FROM pages WHERE id = ?", id))[0]!;
const versionsOf = (pageId: string = PAGE_ID) =>
  all<VersionRow>("SELECT * FROM versions WHERE page_id = ? ORDER BY captured_at, rowid", pageId);

async function seedPage(over: Partial<NewPage> = {}): Promise<void> {
  await insertPage(env.DB, {
    id: PAGE_ID,
    url: "https://example.com/pricing",
    label: "Pricing",
    kind: "pricing",
    monitor_id: "mon-replay",
    schedule_cron: "5 1,13 * * *",
    purpose: PURPOSE,
    status: "active",
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
    ...over,
  });
}

/** A fully captured baseline version, hashed with the page's patterns. */
async function seedBaseline(text: string, pageId: string = PAGE_ID, patterns: string[] = []): Promise<string> {
  const id = `v-baseline-${pageId}`;
  await insertVersion(env.DB, {
    id,
    page_id: pageId,
    run_id: null,
    is_baseline: 1,
    captured_at: BASELINE_AT,
    text,
    normalized_hash: await hashText(normalize(text, patterns).text),
    judgment_summary: null,
    screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`,
    facts_json: JSON.stringify([{ name: "Pro", price: "$20", unit: "per month", notes: null }]),
    capture_status: "complete",
  });
  return id;
}

/** What the Monitor posted for a run: changed-real.json with this run's id and text. */
function rawPayload(runId: string, text: string, over: Json = {}): Json {
  const payload = structuredClone(changedReal) as Json;
  payload.id = runId;
  payload.results[0].text = text;
  return { ...payload, ...over };
}

type SeedRun = { n: number; at: string; raw?: Json | string | null; over?: Partial<RunRow> };

/**
 * A run of the page, with its raw payload stored in R2 under `raw/mrun-<n>.json` (`raw: null` stores
 * none; a string is stored as it is). The run row is what the webhook route would have written.
 */
async function seedRun({ n, at, raw, over }: SeedRun): Promise<string> {
  const id = `run-${n}`;
  const monitorRunId = `mrun-${n}`;
  const key = `raw/${monitorRunId}.json`;
  if (raw !== null) {
    const body = raw === undefined ? rawPayload(monitorRunId, REAL_TEXT) : raw;
    await env.STORE.put(key, typeof body === "string" ? body : JSON.stringify(body));
  }
  await insertRun(env.DB, {
    id,
    page_id: PAGE_ID,
    monitor_run_id: monitorRunId,
    outcome: "changed",
    is_baseline: 0,
    judgment_relevant: 1,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: key,
    received_at: at,
    trigger_kind: "webhook",
    ...over,
  });
  return id;
}

beforeEach(async () => {
  fetchMock.activate(); // nothing here may reach the network; an unmatched fetch throws
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => {
  fetchMock.reset();
  vi.restoreAllMocks();
});

// --- Auth ---------------------------------------------------------------------------------------

describe("admin routes", () => {
  it("reject a missing or wrong token with 401, before the page is looked up and before anything is done", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun({ n: 1, at: T1, raw: rawPayload("mrun-1", REAL_TEXT) });

    const refused: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" }, { Authorization: "Basic test-admin" }, { Authorization: "test-admin" }];
    for (const headers of refused) {
      for (const res of [await replay(PAGE_ID, headers), await replay("no-such-page", headers)]) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "admin_required" });
      }
      const rotated = await rotate({ base_url: "https://new.example.org" }, headers);
      expect(rotated.status).toBe(401);
      expect(await rotated.json()).toEqual({ error: "admin_required" });
    }

    expect(await versionsOf()).toHaveLength(1);
    expect(fetchMock.calls).toEqual([]);
  });

  it("discover is public: no token needed", async () => {
    mockSearch();
    expect((await discover({ domain: "vercel.com" })).status).toBe(200);
  });
});

// --- Discover -----------------------------------------------------------------------------------

const hit = (url: string, title?: string) => ({ position: 1, site_name: "vercel.com", snippet: "...", ...(title === undefined ? {} : { title }), url });
const searchUrl = (query: string, domain = "vercel\\.com") =>
  new RegExp(`^https://api\\.search\\.tinyfish\\.ai/\\?query=${query}&include_domains=${domain}&purpose=find\\+the\\+fine-print\\+pages\\+of\\+a\\+website$`);

/** The four TinySearch queries for vercel.com: seven distinct urls among them (Task 4's fixture set). */
function mockSearch(domain = "vercel\\.com"): void {
  const answer = (query: string, results: unknown[]) =>
    fetchMock.intercept({
      method: "GET",
      url: searchUrl(query, domain),
      times: Infinity,
      reply: { json: { query, results, total_results: results.length, page: 0 } },
    });
  answer("pricing\\+plans", searchFixture.results);
  answer("terms\\+of\\+service", [hit("https://vercel.com/docs/pricing", "Pricing on Vercel"), hit("https://vercel.com/legal/terms", "Terms of Service")]);
  answer("privacy\\+policy", [hit("https://vercel.com/legal/privacy-policy", "Privacy Policy"), hit("https://vercel.com/legal/terms", "Terms of Service")]);
  answer("fees\\+and\\+charges", [hit("https://vercel.com/docs/pricing", "Pricing on Vercel"), hit("https://vercel.com/docs/billing")]);
}

const searchCalls = () => fetchMock.calls.filter((c) => new URL(c.url).hostname === "api.search.tinyfish.ai");

describe("POST /api/discover", () => {
  it("discover returns deduped candidates with already_watched flags", async () => {
    mockSearch();
    // An active page and an expired one both count: the url is unique, so neither can be added again.
    await seedPage({ id: "w1", url: "https://vercel.com/pricing", monitor_id: "mon-w1" });
    await seedPage({ id: "w2", url: "https://vercel.com/legal/terms", monitor_id: null, status: "expired" });
    // Same host, different url: not a match.
    await seedPage({ id: "w3", url: "https://vercel.com/pricing/", monitor_id: "mon-w3" });

    const res = await discover({ domain: "vercel.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(Object.keys(body)).toEqual(["candidates"]);

    const urls = body.candidates.map((c: Json) => c.url);
    expect(urls).toEqual([
      ...searchFixture.results.map((r) => r.url),
      "https://vercel.com/legal/terms",
      "https://vercel.com/legal/privacy-policy",
      "https://vercel.com/docs/billing",
    ]);
    expect(new Set(urls).size).toBe(urls.length);

    expect(body.candidates[0]).toEqual({
      url: "https://vercel.com/pricing",
      title: "Vercel Pricing: Hobby, Pro, and Enterprise plans",
      kind: "pricing",
      already_watched: true,
    });
    const watched = body.candidates.filter((c: Json) => c.already_watched).map((c: Json) => c.url);
    expect(watched).toEqual(["https://vercel.com/pricing", "https://vercel.com/legal/terms"]);
    const terms = body.candidates.find((c: Json) => c.url === "https://vercel.com/legal/terms");
    expect(terms).toEqual({ url: "https://vercel.com/legal/terms", title: "Terms of Service", kind: "policy", already_watched: true });
    const billing = body.candidates.find((c: Json) => c.url === "https://vercel.com/docs/billing");
    expect(billing).toEqual({ url: "https://vercel.com/docs/billing", title: "", kind: "fees", already_watched: false });
    expect(searchCalls()).toHaveLength(4);
  });

  it.each([
    ["a bare hostname", "vercel.com"],
    ["a url", "https://vercel.com/pricing?plan=pro#top"],
    ["a url with a port", "https://vercel.com:8443/"],
    ["a bare hostname with a path", "vercel.com/pricing"],
    ["mixed case and spaces", "  VERCEL.com  "],
    ["a trailing dot", "vercel.com."],
  ])("accepts %s and searches the hostname", async (_name, domain) => {
    mockSearch();
    const res = await discover({ domain });
    expect(res.status).toBe(200);
    const calls = searchCalls();
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => new URL(c.url).searchParams.get("include_domains") === "vercel.com")).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["blanks", "   "],
    ["a missing domain", undefined],
    ["null", null],
    ["a number", 5],
    ["an object", {}],
    ["localhost", "localhost"],
    ["a single-label host", "intranet"],
    ["a .local host", "printer.local"],
    ["a .internal host", "metadata.google.internal"],
    ["a .localhost host", "app.localhost"],
    ["loopback", "127.0.0.1"],
    ["loopback as a url", "http://127.0.0.1/pricing"],
    ["loopback as one decimal number", "2130706433"],
    ["a private address", "10.0.0.5"],
    ["another private address", "192.168.1.1"],
    ["the metadata address", "169.254.169.254"],
    ["a public IPv4 address (not a hostname)", "8.8.8.8"],
    ["IPv6 loopback", "[::1]"],
    ["IPv6 loopback as a url", "https://[::1]/"],
    ["a host with a space", "vercel .com"],
    ["a scheme that is not http(s)", "ftp://vercel.com"],
    ["credentials", "https://user:pw@vercel.com/"],
    ["a label that is too long", `${"a".repeat(64)}.com`],
  ])("rejects %s with 400 invalid_domain, searches nothing and uses no daily lookup", async (_name, domain) => {
    const ip = "203.0.113.77";
    const res = await discover({ domain }, { "CF-Connecting-IP": ip });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_domain" });
    expect(fetchMock.calls).toEqual([]);
    expect(await publicAddsToday(env.DB, await discoverKey(ip))).toBe(0);
  });

  it("a body that is not a JSON object is 400 invalid_body", async () => {
    for (const body of ["not json", "[]", "null", '"vercel.com"']) {
      const res = await discover(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
    expect(fetchMock.calls).toEqual([]);
  });

  it("a public caller gets ten lookups a day, then 429 daily_limit with no search; the next visitor and the admin are not affected", async () => {
    mockSearch();
    const ip = { "CF-Connecting-IP": "203.0.113.5" };
    for (let i = 0; i < 10; i++) expect((await discover({ domain: "vercel.com" }, ip)).status).toBe(200);
    expect(searchCalls()).toHaveLength(40);

    const limited = await discover({ domain: "vercel.com" }, ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "daily_limit", reason: "Ten discover lookups per day per visitor" });
    expect(searchCalls()).toHaveLength(40);
    expect(await publicAddsToday(env.DB, await discoverKey("203.0.113.5"))).toBe(10);

    // Another visitor, and the same visitor's one daily page add (a different counter), are untouched.
    expect((await discover({ domain: "vercel.com" }, { "CF-Connecting-IP": "203.0.113.6" })).status).toBe(200);
    expect(await publicAddsToday(env.DB, await hashText("203.0.113.5" + SECRET))).toBe(0);

    // Admin lookups are unlimited and use none of the visitor's lookups (even from the same address).
    for (let i = 0; i < 3; i++) expect((await discover({ domain: "vercel.com" }, { ...ip, ...ADMIN })).status).toBe(200);
    expect(await publicAddsToday(env.DB, await discoverKey("203.0.113.5"))).toBe(10);
    const adminOnly = await discover({ domain: "vercel.com" }, ADMIN);
    expect(adminOnly.status).toBe(200);
    expect(await publicAddsToday(env.DB, await discoverKey("unknown"))).toBe(0);
  });

  it("parallel lookups from one visitor cannot pass the limit of ten", async () => {
    mockSearch();
    const ip = { "CF-Connecting-IP": "203.0.113.8" };
    const answers = await Promise.all(Array.from({ length: 15 }, () => discover({ domain: "vercel.com" }, ip)));
    expect(answers.filter((r) => r.status === 200)).toHaveLength(10);
    expect(answers.filter((r) => r.status === 429)).toHaveLength(5);
    expect(searchCalls()).toHaveLength(40);
    expect(await publicAddsToday(env.DB, await discoverKey("203.0.113.8"))).toBe(10);
  });

  it("a failing search is 502 search_failed with the TinyFish code, uses no daily lookup and logs no secret", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.intercept({
      method: "GET",
      url: /^https:\/\/api\.search\.tinyfish\.ai\//,
      times: Infinity,
      reply: { status: 503, json: { error: { code: "SEARCH_DOWN", message: "key test-tinyfish-key and secret test-secret" } } },
    });
    const ip = "203.0.113.9";
    const res = await discover({ domain: "vercel.com" }, { "CF-Connecting-IP": ip });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "search_failed", reason: "SEARCH_DOWN" });
    expect(await publicAddsToday(env.DB, await discoverKey(ip))).toBe(0);
    const text = error.mock.calls.flat().join(" ");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("test-tinyfish-key");

    // The visitor still has all ten lookups: a later lookup (search back up) works.
    fetchMock.reset();
    fetchMock.activate();
    mockSearch();
    expect((await discover({ domain: "vercel.com" }, { "CF-Connecting-IP": ip })).status).toBe(200);
    expect(await publicAddsToday(env.DB, await discoverKey(ip))).toBe(1);
  });

  it("a search that cannot be reached at all is 502 request_failed", async () => {
    fetchMock.intercept({
      method: "GET",
      url: /^https:\/\/api\.search\.tinyfish\.ai\//,
      times: Infinity,
      reply: () => {
        throw new Error("connection reset");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await discover({ domain: "vercel.com" }, { "CF-Connecting-IP": "203.0.113.10" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "search_failed", reason: "request_failed" });
    expect(await publicAddsToday(env.DB, await discoverKey("203.0.113.10"))).toBe(0);
  });

  it("a lookup that fails after the search (the page check) gives the daily lookup back too", async () => {
    mockSearch();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("ALTER TABLE pages RENAME TO pages_away").run();
    try {
      const res = await discover({ domain: "vercel.com" }, { "CF-Connecting-IP": "203.0.113.11" });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal_error" });
      expect(await publicAddsToday(env.DB, await discoverKey("203.0.113.11"))).toBe(0);
    } finally {
      await env.DB.prepare("ALTER TABLE pages_away RENAME TO pages").run();
    }
  });

  it("a search with no results is 200 with an empty list and still counts as a lookup", async () => {
    fetchMock.intercept({ method: "GET", url: /^https:\/\/api\.search\.tinyfish\.ai\//, times: Infinity, reply: { json: { results: [] } } });
    const res = await discover({ domain: "vercel.com" }, { "CF-Connecting-IP": "203.0.113.12" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [] });
    expect(await publicAddsToday(env.DB, await discoverKey("203.0.113.12"))).toBe(1);
  });
});

async function discoverKey(ip: string): Promise<string> {
  return "discover:" + (await hashText(ip + SECRET));
}

// --- Replay -------------------------------------------------------------------------------------

describe("POST /api/pages/:id/replay", () => {
  it("replay creates the versions a stricter gate missed and leaves suppressed ones out", async () => {
    await seedPage();
    const baselineId = await seedBaseline(BASE_TEXT);
    // Run 1 is the Last-updated-only change: the page text is the baseline plus a stamp (nothing marked it yet).
    const noiseRun = await seedRun({ n: 1, at: T1, raw: rawPayload("mrun-1", BASE_TEXT + STAMP, { judgment: { ...changedReal.judgment, is_relevant: false, summary: "Only a timestamp." } }) });
    // Run 2 is the real change ($20 to $25); an earlier gate had set it aside as noise.
    const realRun = await seedRun({
      n: 2,
      at: T2,
      raw: rawPayload("mrun-2", REAL_TEXT),
      over: { noise_suppressed: 1, noise_reason: "normalized_identical" },
    });
    await putCachedDiff(env.DB, baselineId, "v-elsewhere", "{}");
    await putCachedDiff(env.DB, "v-other-1", "v-other-2", "{}");

    const res = await replay();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, suppressed: 1 });

    const stored = await versionsOf();
    expect(stored).toHaveLength(2);
    const created = stored[1]!;
    expect(created).toMatchObject({
      page_id: PAGE_ID,
      run_id: realRun,
      is_baseline: 0,
      // Dated by the run's receipt time, like the version the webhook would have made.
      captured_at: T2,
      text: REAL_TEXT,
      normalized_hash: await hashText(normalize(REAL_TEXT, []).text),
      judgment_summary: changedReal.judgment.summary,
      // Left for the repair cron: nothing is captured here.
      capture_status: "pending",
      capture_error: "replayed",
      capture_attempts: 0,
      screenshot_key: null,
      html_key: null,
      facts_json: null,
      agent_run_id: null,
    });
    // The baseline is untouched.
    expect(stored[0]).toMatchObject({ id: baselineId, capture_status: "complete", capture_error: null, capture_attempts: 0 });

    // The real run is no longer noise; the stamp-only run is now recorded as suppressed.
    expect(await runRow(realRun)).toMatchObject({ noise_suppressed: 0, noise_reason: null });
    expect(await runRow(noiseRun)).toMatchObject({ noise_suppressed: 1, noise_reason: "normalized_identical" });
    expect((await pageRow(PAGE_ID)).last_change_at).toBe(T2);

    // The hourly repair picks the new version up (it is `pending`); nothing else in this page is waiting.
    const waiting = await pendingCaptures(env.DB, new Date().toISOString(), 3);
    expect(waiting.map((v) => v.id)).toEqual([created.id]);

    // Replay calls no TinyFish API and bills nothing.
    expect(fetchMock.calls).toEqual([]);
    expect(await all("SELECT * FROM spend")).toEqual([]);

    // A cached diff that spans the changed stretch of this page is dropped (its hop and noise counts moved);
    // another page's cached diff stays.
    expect(await all("SELECT from_version_id FROM diff_cache")).toEqual([{ from_version_id: "v-other-1" }]);
  });

  it("is idempotent: a second replay creates nothing and counts the suppressed run again", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun({ n: 1, at: T1, raw: rawPayload("mrun-1", BASE_TEXT + STAMP) });
    await seedRun({ n: 2, at: T2, raw: rawPayload("mrun-2", REAL_TEXT) });

    expect(await (await replay()).json()).toEqual({ created: 1, suppressed: 1 });
    const first = await versionsOf();
    expect(await (await replay()).json()).toEqual({ created: 0, suppressed: 1 });
    expect(await versionsOf()).toEqual(first);
    expect((await pageRow(PAGE_ID)).last_change_at).toBe(T2);
  });

  it("compares each run with the newest version in the chain, not with the baseline", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    // $25, then $25 with a stamp (same page), then back to $20 (a real change against the $25 version).
    await seedRun({ n: 1, at: T1, raw: rawPayload("mrun-1", REAL_TEXT) });
    await seedRun({ n: 2, at: T2, raw: rawPayload("mrun-2", REAL_TEXT + STAMP) });
    await seedRun({ n: 3, at: T3, raw: rawPayload("mrun-3", BASE_TEXT) });

    expect(await (await replay()).json()).toEqual({ created: 2, suppressed: 1 });
    const stored = await versionsOf();
    expect(stored.map((v) => [v.run_id, v.captured_at])).toEqual([
      [null, BASELINE_AT],
      ["run-1", T1],
      ["run-3", T3],
    ]);
    expect((await pageRow(PAGE_ID)).last_change_at).toBe(T3);
  });

  it("leaves a version a run already has alone and moves the chain to it, even when the raw payload is gone", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    // Run 1 already made a version ($25, fully captured); its raw object was never kept (no object is stored).
    const runId = await seedRun({ n: 1, at: T1, raw: null });
    await insertVersion(env.DB, {
      id: "v-run-1",
      page_id: PAGE_ID,
      run_id: runId,
      is_baseline: 0,
      captured_at: T1,
      text: REAL_TEXT,
      normalized_hash: "hash-from-older-rules",
      judgment_summary: "Pro rose",
      screenshot_key: "shots/v-run-1.jpg",
      html_key: "html/v-run-1.html",
      facts_json: "[]",
      capture_status: "complete",
    });
    // Run 2 is the same page again with a stamp: against the $25 version it is noise. Against the baseline it would not be.
    await seedRun({ n: 2, at: T2, raw: rawPayload("mrun-2", REAL_TEXT + STAMP) });
    const before = (await versionsOf())[1]!;

    expect(await (await replay()).json()).toEqual({ created: 0, suppressed: 1 });
    const after = await versionsOf();
    expect(after).toHaveLength(2);
    expect(after[1]).toEqual(before);
    expect(await runRow(runId)).toMatchObject({ noise_suppressed: 0, noise_reason: null });
    expect(await runRow("run-2")).toMatchObject({ noise_suppressed: 1, noise_reason: "normalized_identical" });
    expect((await pageRow(PAGE_ID)).last_change_at).toBeNull(); // nothing was created
  });

  it("skips runs it cannot use and counts nothing for them: no object, not JSON, an errors entry, empty text, no raw_key, other outcomes", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun({ n: 1, at: T1, raw: null }); // the object is missing
    await seedRun({ n: 2, at: T1, raw: "this is not json" });
    await seedRun({ n: 3, at: T1, raw: rawPayload("mrun-3", REAL_TEXT, { errors: [{ url: "https://vercel.com/pricing", code: "timeout" }] }) });
    const empty = rawPayload("mrun-4", "");
    await seedRun({ n: 4, at: T1, raw: empty });
    await seedRun({ n: 5, at: T1, raw: rawPayload("mrun-5", REAL_TEXT, { results: [] }) });
    await seedRun({ n: 6, at: T1, raw: rawPayload("mrun-6", REAL_TEXT), over: { raw_key: null } });
    await seedRun({ n: 7, at: T1, raw: rawPayload("mrun-7", REAL_TEXT), over: { outcome: "unchanged" } });
    await seedRun({ n: 8, at: T1, raw: rawPayload("mrun-8", REAL_TEXT), over: { outcome: "baseline", is_baseline: 1 } });
    await seedRun({ n: 9, at: T1, raw: rawPayload("mrun-9", REAL_TEXT, { id: undefined }) }); // no payload id: not a webhook body
    const flagged = await seedRun({ n: 10, at: T1, raw: rawPayload("mrun-10", REAL_TEXT, { errors: [{ code: "x" }] }), over: { noise_reason: "fetch_error" } });

    expect(await (await replay()).json()).toEqual({ created: 0, suppressed: 0 });
    expect(await versionsOf()).toHaveLength(1);
    expect(await all<RunRow>("SELECT * FROM runs WHERE noise_suppressed = 1")).toEqual([]);
    expect((await runRow(flagged)).noise_reason).toBe("fetch_error");
  });

  it("a page with no version at all gets its first one from the first usable run", async () => {
    await seedPage();
    await seedRun({ n: 1, at: T1, raw: rawPayload("mrun-1", REAL_TEXT) });
    await seedRun({ n: 2, at: T2, raw: rawPayload("mrun-2", REAL_TEXT + STAMP) });

    expect(await (await replay()).json()).toEqual({ created: 1, suppressed: 1 });
    const stored = await versionsOf();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ run_id: "run-1", is_baseline: 0, captured_at: T1, text: REAL_TEXT });
  });

  it("uses the page's ignore patterns on both sides of the comparison", async () => {
    const patterns = ["^(most )?popular$"];
    await seedPage({ ignore_patterns: JSON.stringify(patterns) });
    await seedBaseline(BASE_TEXT, PAGE_ID, patterns);
    expect(BASE_TEXT).toContain("\n\nPopular\n\n");
    // Only the line the pattern drops differs: noise for this page.
    await seedRun({ n: 1, at: T1, raw: rawPayload("mrun-1", BASE_TEXT.replace("\n\nPopular\n\n", "\n\nMost popular\n\n")) });
    await seedRun({ n: 2, at: T2, raw: rawPayload("mrun-2", REAL_TEXT) });

    expect(await (await replay()).json()).toEqual({ created: 1, suppressed: 1 });
    const stored = await versionsOf();
    expect(stored[1]!.normalized_hash).toBe(await hashText(normalize(REAL_TEXT, patterns).text));
  });

  it("a stale stored hash on the baseline does not matter: both sides are normalized with the current rules", async () => {
    await seedPage();
    const id = await seedBaseline(BASE_TEXT);
    await env.DB.prepare("UPDATE versions SET normalized_hash = 'hash-from-older-rules' WHERE id = ?").bind(id).run();
    await seedRun({ n: 1, at: T1, raw: rawPayload("mrun-1", BASE_TEXT + STAMP) });

    expect(await (await replay()).json()).toEqual({ created: 0, suppressed: 1 });
    expect(await versionsOf()).toHaveLength(1);
  });

  it("does not move last_change_at back when the page changed later than the replayed run", async () => {
    const later = "2026-11-09T00:00:00.000Z";
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await env.DB.prepare("UPDATE pages SET last_change_at = ? WHERE id = ?").bind(later, PAGE_ID).run();
    await seedRun({ n: 1, at: T1, raw: rawPayload("mrun-1", REAL_TEXT) });

    expect(await (await replay()).json()).toEqual({ created: 1, suppressed: 0 });
    expect((await pageRow(PAGE_ID)).last_change_at).toBe(later);
  });

  it("only looks at the page's own runs", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedPage({ id: "page-other", url: "https://example.com/other", monitor_id: "mon-other" });
    await env.STORE.put("raw/mrun-x.json", JSON.stringify(rawPayload("mrun-x", REAL_TEXT)));
    await insertRun(env.DB, {
      id: "run-x",
      page_id: "page-other",
      monitor_run_id: "mrun-x",
      outcome: "changed",
      is_baseline: 0,
      judgment_relevant: 1,
      judgment_summary: null,
      diff_truncated: 0,
      noise_suppressed: 0,
      noise_reason: null,
      raw_key: "raw/mrun-x.json",
      received_at: T1,
      trigger_kind: "webhook",
    });

    expect(await (await replay()).json()).toEqual({ created: 0, suppressed: 0 });
    expect(await versionsOf("page-other")).toEqual([]);
  });

  it("an unknown page is 404 not_found", async () => {
    const res = await replay("no-such-page");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("a page whose history cannot be read is a 500 that logs no page text", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun({ n: 1, at: T1, raw: rawPayload("mrun-1", REAL_TEXT) });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("CREATE TRIGGER fail_version_insert BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT, 'disk on fire'); END").run();

    const res = await replay();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(error.mock.calls.flat().join(" ")).not.toContain("Hobby");

    // Nothing is half done: the next replay, with the fault gone, creates the version.
    await env.DB.prepare("DROP TRIGGER fail_version_insert").run();
    expect(await (await replay()).json()).toEqual({ created: 1, suppressed: 0 });
  });
});

// --- Rotate webhook -----------------------------------------------------------------------------

type MonitorSeed = { id: string; monitor: string | null; status?: PageRow["status"]; cron?: string | null };

async function seedMonitors(seeds: MonitorSeed[]): Promise<void> {
  for (const s of seeds) {
    await insertPage(env.DB, {
      id: s.id,
      url: `https://example.com/${s.id}`,
      label: s.id,
      kind: "other",
      monitor_id: s.monitor,
      schedule_cron: s.cron === undefined ? `5 ${seeds.indexOf(s)},12 * * *` : s.cron,
      purpose: PURPOSE,
      status: s.status ?? "active",
      added_by: "curated",
      ignore_patterns: "[]",
      expires_at: null,
    });
  }
}

const patchCalls = () => fetchMock.calls.filter((c) => c.method === "PATCH" && c.url.startsWith(`${MONITORS_API}/`));

describe("POST /api/admin/rotate-webhook", () => {
  const LIVE: MonitorSeed[] = [
    { id: "p1", monitor: "mon-1" },
    { id: "p2", monitor: "mon-2", status: "paused" },
    { id: "p3", monitor: "mon-3", status: "failed" },
  ];

  it("rotate-webhook PATCHes every live monitor with schedule_cron and the new webhook url", async () => {
    await seedMonitors([...LIVE, { id: "p4", monitor: "mon-4", status: "expired" }, { id: "p5", monitor: null }]);
    let running = 0;
    let busiest = 0;
    fetchMock.intercept({
      method: "PATCH",
      url: /\/v1\/monitors\/mon-\d$/,
      times: Infinity,
      reply: async () => {
        busiest = Math.max(busiest, ++running);
        await sleep(5);
        running--;
        return Response.json({ id: "ok" });
      },
    });

    const res = await rotate({ base_url: "https://new.example.org" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ updated: 3, failed: [] });
    // The response never carries the secret or the url that holds it.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("new.example.org");

    const calls = patchCalls();
    // One at a time, in the order the pages were added; paused and failed pages included, expired and monitor-less ones left alone.
    expect(busiest).toBe(1);
    expect(calls.map((c) => c.url)).toEqual(["mon-1", "mon-2", "mon-3"].map((m) => `${MONITORS_API}/${m}`));
    const crons = await all<{ id: string; schedule_cron: string }>("SELECT id, schedule_cron FROM pages ORDER BY rowid");
    expect(calls.map((c) => c.body)).toEqual(
      LIVE.map((_, i) => ({ schedule_cron: crons[i]!.schedule_cron, webhook_url: `https://new.example.org/hooks/monitor/${SECRET}` })),
    );
    expect(fetchMock.calls).toHaveLength(3);
  });

  it("strips trailing slashes and keeps a path prefix", async () => {
    await seedMonitors([{ id: "p1", monitor: "mon-1" }]);
    fetchMock.intercept({ method: "PATCH", url: `${MONITORS_API}/mon-1`, times: Infinity, reply: { json: {} } });

    for (const base of ["https://new.example.org/", "https://new.example.org///", "https://NEW.example.org"]) {
      expect(await (await rotate({ base_url: base })).json()).toEqual({ updated: 1, failed: [] });
    }
    expect(await (await rotate({ base_url: "https://new.example.org/fineprint//" })).json()).toEqual({ updated: 1, failed: [] });
    expect((patchCalls().map((c) => (c.body as Json).webhook_url) as string[])).toEqual([
      `https://new.example.org/hooks/monitor/${SECRET}`,
      `https://new.example.org/hooks/monitor/${SECRET}`,
      `https://new.example.org/hooks/monitor/${SECRET}`,
      `https://new.example.org/fineprint/hooks/monitor/${SECRET}`,
    ]);
  });

  it("collects failures as {page_id, reason} and keeps going; nothing leaks into the response or the log", async () => {
    await seedMonitors([...LIVE, { id: "p6", monitor: "mon-6" }, { id: "p7", monitor: "mon-7", cron: null }]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // TinyFish echoes the rejected webhook url (with the secret in it) back in its error body.
    const echo = { error: { code: "INVALID_WEBHOOK", message: `bad webhook https://new.example.org/hooks/monitor/${SECRET}` } };
    fetchMock.intercept({ method: "PATCH", url: `${MONITORS_API}/mon-1`, reply: { json: {} } });
    fetchMock.intercept({ method: "PATCH", url: `${MONITORS_API}/mon-2`, reply: { status: 400, json: echo } });
    fetchMock.intercept({ method: "PATCH", url: `${MONITORS_API}/mon-3`, reply: { status: 502, body: `<html>${SECRET}</html>` } });
    fetchMock.intercept({
      method: "PATCH",
      url: `${MONITORS_API}/mon-6`,
      reply: () => {
        throw new Error(`socket hang up https://new.example.org/hooks/monitor/${SECRET}`);
      },
    });

    const res = await rotate({ base_url: "https://new.example.org" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      updated: 1,
      failed: [
        { page_id: "p2", reason: "INVALID_WEBHOOK" },
        { page_id: "p3", reason: "http_502" },
        { page_id: "p6", reason: "request_failed" },
        // No stored schedule: TinyFish rejects an edit without one, so it is reported and no call is made.
        { page_id: "p7", reason: "no_schedule_cron" },
      ],
    });
    expect(text).not.toContain(SECRET);
    expect(error.mock.calls.flat().join(" ")).not.toContain(SECRET);
    expect(patchCalls()).toHaveLength(4); // mon-1, mon-2, mon-3, mon-6; none for mon-7
  });

  it("a Worker that has no webhook secret refuses instead of pointing every Monitor at a dead url", async () => {
    await seedMonitors([{ id: "p1", monitor: "mon-1" }]);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://fineprint.test/api/admin/rotate-webhook", {
        method: "POST",
        headers: { "content-type": "application/json", ...ADMIN },
        body: JSON.stringify({ base_url: "https://new.example.org" }),
      }),
      new Proxy(env, { get: (target, key) => (key === "WEBHOOK_SECRET" ? "" : Reflect.get(target, key)) }),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "webhook_secret_missing" });
    expect(fetchMock.calls).toEqual([]);
  });

  it.each([
    ["http", "http://new.example.org"],
    ["another scheme", "ftp://new.example.org"],
    ["no scheme", "new.example.org"],
    ["not a url", "not a url"],
    ["an empty string", ""],
    ["no host", "https://"],
    ["credentials", "https://user:pw@new.example.org"],
    ["a query", "https://new.example.org/?a=b"],
    ["a fragment", "https://new.example.org/#top"],
    ["a number", 5],
    ["null", null],
    ["a missing base_url", undefined],
  ])("rejects %s with 400 invalid_base_url and calls TinyFish for nothing", async (_name, base) => {
    await seedMonitors([{ id: "p1", monitor: "mon-1" }]);
    const res = await rotate({ base_url: base });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_base_url" });
    expect(fetchMock.calls).toEqual([]);
  });

  it("a body that is not a JSON object is 400 invalid_body", async () => {
    for (const body of ["not json", "[]", "null"]) {
      const res = await rotate(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
    expect(fetchMock.calls).toEqual([]);
  });

  it("with no live Monitor it updates nothing", async () => {
    await seedMonitors([{ id: "p4", monitor: "mon-4", status: "expired" }]);
    const res = await rotate({ base_url: "https://new.example.org" });
    expect(await res.json()).toEqual({ updated: 0, failed: [] });
    expect(fetchMock.calls).toEqual([]);
  });
});
