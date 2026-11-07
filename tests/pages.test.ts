import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { safeEqual } from "../src/auth";
import { captureDeps } from "../src/capture";
import { MAX_MONITORS, MAX_URL_LENGTH, PUBLIC_SLOTS, PUBLIC_TTL_DAYS, SPEND_PAUSE_USD } from "../src/core/limits";
import { hashText, normalize } from "../src/core/normalize";
import { PURPOSE } from "../src/core/schedule";
import { countMonitors, getPage, getPageByUrl, insertPage, type NewPage } from "../src/db/pages";
import { claimPublicAdd, publicAddsToday, releasePublicAdd } from "../src/db/publicAdds";
import { insertRun } from "../src/db/runs";
import type { PageRow, VersionRow } from "../src/db/types";
import { pageToJson } from "../src/handlers/pages";
import worker from "../src/index";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import fetchFixture from "./fixtures/tinyfish/fetch.json";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const PRICING_URL = "https://vercel.com/pricing";
const PRICING_TITLE = "Vercel Pricing: Hobby, Pro, and Enterprise plans";
const ADMIN = { Authorization: "Bearer test-admin" };
const DAY_MS = 86_400_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const json = async (res: Response): Promise<Json> => res.json();

function callsTo(method: string, url: string) {
  return fetchMock.calls.filter((c) => c.method === method && c.url === new URL(url).href);
}

/** Every call that reached TinyFish's Agent API (Monitors) from call number `from` on. */
function agentCalls(from = 0) {
  return fetchMock.calls.slice(from).filter((c) => new URL(c.url).hostname === "agent.tinyfish.ai");
}

let monitorSeq = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function monitorCreated(): Response {
  const n = ++monitorSeq;
  const body = structuredClone(monitorCreate);
  body.monitor.id = `mon-${n}`;
  body.run.id = `mrun-${n}`;
  return Response.json(body, { status: 201 });
}

/**
 * TinyFetch answers with the pricing fixture (after `fetchDelayMs`); each Monitor create gets ids
 * mon-N / mrun-N. With `holdCreatesUntil` set, a Monitor create is answered only once that many
 * creates have arrived (or after 2 s), so that many adds are all past their checks before any of
 * them writes a row. Deleting a Monitor named mon-N is always answered, and so is the facts run
 * the capture of a pricing page's baseline starts (agent-run-N).
 */
function mockTinyFish(opts: { fetchDelayMs?: number; holdCreatesUntil?: number } = {}) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  if (opts.holdCreatesUntil !== undefined) setTimeout(open, 2000);
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: async () => {
      if (opts.fetchDelayMs) await sleep(opts.fetchDelayMs);
      return Response.json(fetchFixture);
    },
  });
  fetchMock.intercept({
    method: "POST",
    url: MONITORS_API,
    times: Infinity,
    reply: async () => {
      if (opts.holdCreatesUntil !== undefined) {
        if (++arrived >= opts.holdCreatesUntil) open();
        await gate;
      }
      return monitorCreated();
    },
  });
  fetchMock.intercept({ method: "DELETE", url: /\/v1\/monitors\/mon-\d+$/, times: Infinity, reply: { status: 204 } });
  let agentRuns = 0;
  fetchMock.intercept({
    method: "POST",
    url: RUN_ASYNC_API,
    times: Infinity,
    reply: () => Response.json({ run_id: `agent-run-${++agentRuns}` }),
  });
}

function mockMonitorDelete(id: string, reply: { status?: number; json?: unknown } = { status: 204 }) {
  fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/${id}`, reply });
}

// Work the Worker handed to waitUntil during an add (the capture of the baseline).
let scheduled: Promise<unknown>[] = [];

async function addPage(body: unknown, headers: Record<string, string> = {}) {
  const ctx = {
    waitUntil: (work: Promise<unknown>) => void scheduled.push(work),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const request = new Request("https://fineprint.test/api/pages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await worker.fetch(request, env, ctx);
  await Promise.allSettled(scheduled);
  return res;
}

function patchPage(id: string, body: unknown, headers: Record<string, string> = ADMIN) {
  return callWorker(`/api/pages/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function deletePage(id: string, headers: Record<string, string> = ADMIN) {
  return callWorker(`/api/pages/${id}`, { method: "DELETE", headers });
}

async function seed(over: Partial<NewPage> & { id: string }) {
  await insertPage(env.DB, {
    url: `https://example.com/${over.id}`,
    label: over.id,
    kind: "other",
    monitor_id: `mon-${over.id}`,
    schedule_cron: "5 1,13 * * *",
    purpose: PURPOSE,
    status: "active",
    added_by: "admin",
    ignore_patterns: "[]",
    expires_at: null,
    ...over,
  });
}

async function versionsOf(pageId: string) {
  const { results } = await env.DB.prepare("SELECT * FROM versions WHERE page_id = ?").bind(pageId).all<VersionRow>();
  return results;
}

async function count(table: "pages" | "runs" | "versions") {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

// An add schedules the real capture of its baseline (src/capture.ts). The screenshot is
// stubbed here; the source comes from the TinyFetch interceptor of mockTinyFish.
let shot: MockInstance<typeof captureDeps.screenshotFullPage>;

beforeEach(async () => {
  monitorSeq = 0;
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  scheduled = [];
  shot = vi.spyOn(captureDeps, "screenshotFullPage").mockImplementation(async () => ({
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
    height: 800,
    sessionId: "sess-test",
  }));
  captureDeps.sleep = async () => {};
});
afterEach(() => {
  fetchMock.reset();
  shot.mockRestore();
  captureDeps.sleep = undefined;
});

describe("POST /api/pages as admin", () => {
  it("validates with TinyFetch, creates a Monitor with the staggered cron and purpose, stores the baseline version", async () => {
    mockTinyFish();
    const res = await addPage({ url: PRICING_URL }, ADMIN);
    expect(res.status).toBe(201);
    const body = await json(res);

    expect(body.page).toMatchObject({
      url: PRICING_URL,
      label: PRICING_TITLE,
      kind: "other",
      monitor_id: "mon-1",
      schedule_cron: "0 0,12 * * *",
      purpose: PURPOSE,
      status: "active",
      added_by: "admin",
      ignore_patterns: [],
      expires_at: null,
    });

    // TinyFetch is asked first, then the Monitor is created with the label as its name.
    expect(callsTo("POST", FETCH_API)[0]!.body).toEqual({
      urls: [PRICING_URL],
      format: "markdown",
      ttl: 0,
      include_etag_and_last_modified: true,
      per_url_timeout_ms: 45000,
    });
    const created = callsTo("POST", MONITORS_API);
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toEqual({
      type: "fetch",
      name: PRICING_TITLE,
      config: { url: PRICING_URL, format: "markdown" },
      schedule_cron: "0 0,12 * * *",
      purpose: PURPOSE,
      webhook_url: "https://fineprint.test/hooks/monitor/test-secret",
    });
    // After the response, the baseline's capture fetches the html source (the screenshot is stubbed;
    // an `other` page takes no facts run).
    expect(fetchMock.calls.map((c) => new URL(c.url).hostname)).toEqual([
      "api.fetch.tinyfish.ai",
      "agent.tinyfish.ai",
      "api.fetch.tinyfish.ai",
    ]);
    expect(callsTo("POST", FETCH_API)[1]!.body).toMatchObject({ urls: [PRICING_URL], format: "html" });
    expect(shot).toHaveBeenCalledTimes(1);

    // The baseline run and version come from the 201 body.
    const versions = await versionsOf(body.page.id);
    expect(versions).toHaveLength(1);
    const version = versions[0]!;
    expect(body.baseline_version_id).toBe(version.id);
    // Stored as `pending` with no attempts; the capture that waitUntil ran has completed it.
    expect(version).toMatchObject({
      is_baseline: 1,
      capture_status: "complete",
      capture_attempts: 1,
      capture_error: null,
      judgment_summary: null,
      screenshot_key: `shots/${version.id}.jpg`,
      html_key: `html/${version.id}.html`,
      facts_json: null,
      agent_run_id: null,
    });
    expect(version.text.length).toBe(13696);
    expect(version.normalized_hash).toBe(await hashText(normalize(version.text).text));

    const run = await env.DB.prepare("SELECT * FROM runs WHERE page_id = ?").bind(body.page.id).first<Json>();
    expect(run).toMatchObject({ outcome: "baseline", is_baseline: 1, monitor_run_id: "mrun-1", noise_suppressed: 0, trigger_kind: "create" });
    expect(version.run_id).toBe(run.id);

    // The capture of the baseline version is scheduled with waitUntil.
    expect(scheduled).toHaveLength(1);

    // The ledger holds the free TinyFetch, the billed baseline check and the capture's free TinyFetch.
    const { results: spend } = await env.DB.prepare("SELECT kind, amount_usd, ref FROM spend ORDER BY rowid").all();
    expect(spend).toEqual([
      { kind: "fetch", amount_usd: 0, ref: PRICING_URL },
      { kind: "monitor_check", amount_usd: 0.005, ref: PRICING_URL },
      { kind: "fetch", amount_usd: 0, ref: PRICING_URL },
    ]);
  });

  it("staggers the schedule by the number of Monitors already held", async () => {
    mockTinyFish();
    await seed({ id: "a" });
    await seed({ id: "b" });
    await seed({ id: "c", status: "expired" }); // an expired page holds no Monitor
    const res = await addPage({ url: PRICING_URL }, ADMIN);
    expect(res.status).toBe(201);
    expect((await json(res)).page.schedule_cron).toBe("14 2,14 * * *"); // cronForIndex(2)
    expect(callsTo("POST", MONITORS_API)[0]!.body).toMatchObject({ schedule_cron: "14 2,14 * * *" });
  });

  it("uses the label, kind and ignore patterns it is given, else the page title, else the hostname", async () => {
    mockTinyFish();
    const given = await addPage(
      { url: PRICING_URL, label: "  Vercel plans  ", kind: "pricing", ignore_patterns: ["^Posted", "\\d+ views"] },
      ADMIN,
    );
    expect(given.status).toBe(201);
    const page = (await json(given)).page;
    expect(page).toMatchObject({ label: "Vercel plans", kind: "pricing", ignore_patterns: ["^Posted", "\\d+ views"] });
    expect(callsTo("POST", MONITORS_API)[0]!.body).toMatchObject({ name: "Vercel plans" });
    // Stored as a JSON string, returned as an array.
    expect((await getPage(env.DB, page.id))!.ignore_patterns).toBe('["^Posted","\\\\d+ views"]');

    // A page with no title falls back to its hostname.
    fetchMock.reset();
    fetchMock.activate();
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [{ url: "x", final_url: "x", title: null, text: "Some terms" }], errors: [] } },
    });
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: monitorCreate } });
    const hostOnly = await addPage({ url: "https://Example.org/terms#top" }, ADMIN);
    expect(hostOnly.status).toBe(201);
    // The url is stored in its canonical form: lower-case host, no fragment.
    expect((await json(hostOnly)).page).toMatchObject({ label: "example.org", url: "https://example.org/terms" });
  });

  it("rejects a second add of the same url with 409 already_watched, whatever its spelling", async () => {
    mockTinyFish();
    const first = await addPage({ url: PRICING_URL }, ADMIN);
    const pageId = (await json(first)).page.id;
    const callsBefore = fetchMock.calls.length;

    for (const again of [PRICING_URL, "https://VERCEL.com/pricing#plans"]) {
      const res = await addPage({ url: again }, ADMIN);
      expect(res.status).toBe(409);
      expect(await json(res)).toEqual({ error: "already_watched", page_id: pageId });
    }
    expect(fetchMock.calls.length).toBe(callsBefore);
    expect(await count("pages")).toBe(1);
  });

  it("answers 409 already_watched and removes the new Monitor when another add wins the race for the url", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: async () => {
        // While TinyFetch is answering, a second request stores the same url.
        await seed({ id: "winner", url: PRICING_URL });
        return Response.json(fetchFixture);
      },
    });
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: monitorCreate } });
    mockMonitorDelete(monitorCreate.monitor.id);

    const res = await addPage({ url: PRICING_URL }, ADMIN);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "already_watched", page_id: "winner" });
    expect(callsTo("DELETE", `${MONITORS_API}/${monitorCreate.monitor.id}`)).toHaveLength(1);
    expect(await count("pages")).toBe(1);
    expect(await count("runs")).toBe(0);
    expect(scheduled).toHaveLength(0);
  });

  it("rejects an unfetchable url with 422 and the TinyFetch error code, creating no Monitor", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [], errors: [{ url: PRICING_URL, error: "login_required" }] } },
    });
    const res = await addPage({ url: PRICING_URL }, ADMIN);
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({ error: "unfetchable", reason: "login_required" });
    expect(agentCalls()).toEqual([]);
    expect(await count("pages")).toBe(0);
    expect(scheduled).toHaveLength(0);
  });

  it("reports a TinyFetch HTTP failure by its error code only, and a network failure as fetch_failed", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { status: 500, json: { error: { code: "INTERNAL", message: "upstream said something private" } } },
    });
    const http = await addPage({ url: PRICING_URL }, ADMIN);
    expect(http.status).toBe(422);
    expect(await json(http)).toEqual({ error: "unfetchable", reason: "INTERNAL" });

    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: () => {
        throw new TypeError("connection reset");
      },
    });
    const network = await addPage({ url: PRICING_URL }, ADMIN);
    expect(network.status).toBe(502);
    expect(await json(network)).toEqual({ error: "unfetchable", reason: "fetch_failed" });
    expect(agentCalls()).toEqual([]);
    expect(await count("pages")).toBe(0);
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "  \n\t \n"],
  ])("treats a page with %s as 422 unfetchable empty_page and creates no Monitor", async (_name, text) => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [{ url: PRICING_URL, final_url: PRICING_URL, title: "Blank", text }], errors: [] } },
    });
    const res = await addPage({ url: PRICING_URL }, ADMIN);
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({ error: "unfetchable", reason: "empty_page" });
    expect(agentCalls()).toEqual([]);
    expect(await count("pages")).toBe(0);
  });

  it("answers 502 monitor_create_failed with only the TinyFish code, and stores nothing", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchFixture } });
    fetchMock.intercept({
      method: "POST",
      url: MONITORS_API,
      reply: { status: 402, json: { error: { code: "INSUFFICIENT_CREDITS", message: "Top up at secret-billing-page" } } },
    });
    const res = await addPage({ url: PRICING_URL }, ADMIN);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "monitor_create_failed", reason: "INSUFFICIENT_CREDITS" });
    expect(text).not.toContain("secret-billing-page");
    expect(await count("pages")).toBe(0);
    expect(callsTo("DELETE", MONITORS_API)).toEqual([]);
  });

  it("answers 502 baseline_failed when the Monitor's baseline has no text, and stores nothing", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchFixture } });
    const empty = structuredClone(monitorCreate);
    empty.run.results = [];
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: empty } });
    mockMonitorDelete(monitorCreate.monitor.id); // createMonitor cleans up the half-made Monitor itself
    const res = await addPage({ url: PRICING_URL }, ADMIN);
    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({ error: "monitor_create_failed", reason: "baseline_failed" });
    expect(await count("pages")).toBe(0);
  });

  it("removes the Monitor and every row it wrote when a D1 write fails after the Monitor was created", async () => {
    mockTinyFish();
    // A run row that already carries TinyFish's baseline run id makes the run insert fail.
    await seed({ id: "other" });
    await insertRun(env.DB, {
      id: "run-other",
      page_id: "other",
      monitor_run_id: "mrun-1",
      outcome: "changed",
      is_baseline: 0,
      judgment_relevant: null,
      judgment_summary: null,
      diff_truncated: 0,
      noise_suppressed: 0,
      noise_reason: null,
      raw_key: null,
      received_at: "2026-11-03T10:00:00.000Z",
      trigger_kind: "webhook",
    });
    mockMonitorDelete("mon-1");

    const res = await addPage({ url: PRICING_URL }, { "CF-Connecting-IP": "198.51.100.9" });
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "internal_error" });
    expect(callsTo("DELETE", `${MONITORS_API}/mon-1`)).toHaveLength(1);
    expect(await getPageByUrl(env.DB, PRICING_URL)).toBeNull();
    expect(await count("versions")).toBe(0);
    expect(await count("runs")).toBe(1); // only the seeded one
    expect(scheduled).toHaveLength(0);
    // A failed add does not use up the visitor's daily add.
    const ipHash = await hashText("198.51.100.9" + env.WEBHOOK_SECRET);
    expect(await publicAddsToday(env.DB, ipHash)).toBe(0);
  });

  it("refuses the 25th monitor with 409 watchlist_full, for admin and public callers, before any TinyFish call", async () => {
    for (let i = 0; i < MAX_MONITORS; i++) await seed({ id: `p${i}`, status: i % 3 === 0 ? "paused" : "active" });
    await seed({ id: "gone", status: "expired" }); // does not count

    for (const headers of [ADMIN, {}]) {
      const res = await addPage({ url: PRICING_URL }, headers);
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ error: "watchlist_full" });
    }
    expect(fetchMock.calls).toEqual([]);
    expect(await count("pages")).toBe(MAX_MONITORS + 1);
  });

  it("is not limited by the public slots or the daily add for admin", async () => {
    mockTinyFish();
    for (let i = 0; i < PUBLIC_SLOTS; i++) {
      await seed({ id: `pub${i}`, added_by: "public", expires_at: "2026-12-01T00:00:00.000Z" });
    }
    for (const url of ["https://a.example.com/terms", "https://b.example.com/terms"]) {
      const res = await addPage({ url }, { ...ADMIN, "CF-Connecting-IP": "203.0.113.50" });
      expect(res.status).toBe(201);
      expect((await json(res)).page).toMatchObject({ added_by: "admin", expires_at: null });
    }
    const ipHash = await hashText("203.0.113.50" + env.WEBHOOK_SECRET);
    expect(await publicAddsToday(env.DB, ipHash)).toBe(0);
  });
});

describe("POST /api/pages validation", () => {
  const bad: [string, unknown][] = [
    ["not a url", "not a url"],
    ["an empty string", ""],
    ["a number", 42],
    ["ftp", "ftp://example.com/terms"],
    ["javascript", "javascript:alert(1)"],
    ["credentials in the url", "https://user:pass@example.com/terms"],
    ["localhost", "http://localhost/"],
    ["localhost with a trailing dot", "http://localhost./"],
    ["*.localhost", "http://app.localhost:3000/"],
    ["*.local", "http://printer.local/"],
    ["*.internal", "https://db.internal/admin"],
    ["0.0.0.0", "http://0.0.0.0/"],
    ["0/8", "http://0.1.2.3/"],
    ["127/8", "http://127.1.2.3/"],
    ["10/8", "http://10.1.2.3/"],
    ["172.16/12 low end", "http://172.16.0.1/"],
    ["172.16/12 high end", "http://172.31.255.255/"],
    ["192.168/16", "http://192.168.1.1/"],
    ["169.254/16 (cloud metadata)", "http://169.254.169.254/latest/meta-data"],
    ["100.64/10 low end", "http://100.64.0.1/"],
    ["100.64/10 high end", "http://100.127.255.255/"],
    ["a decimal IPv4 that is 127.0.0.1", "http://2130706433/"],
    ["::1", "http://[::1]/"],
    ["fc00::/7", "http://[fc00::1]/"],
    ["fd00::/8", "http://[fd12:3456::1]/"],
    ["fe80::/10", "http://[fe80::1]/"],
    ["the top of fe80::/10", "http://[febf::1]/"],
    ["an IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/"],
    ["an IPv4-mapped IPv6 private address", "http://[::ffff:192.168.0.1]/"],
    ["the unspecified IPv6 address", "http://[::]/"],
  ];

  it.each(bad)("rejects %s with 400 invalid_url before any request leaves the Worker", async (_name, url) => {
    for (const headers of [ADMIN, {}]) {
      const res = await addPage({ url }, headers);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_url" });
    }
    expect(fetchMock.calls).toEqual([]);
    expect(await count("pages")).toBe(0);
  });

  it(`refuses a url over ${MAX_URL_LENGTH} characters, as sent or once made canonical, before any request leaves the Worker`, async () => {
    expect(MAX_URL_LENGTH).toBe(2048);
    const base = "https://example.com/";
    const tooLong = base + "a".repeat(MAX_URL_LENGTH - base.length + 1);
    // 700 spaces are 700 characters as sent and 2,100 once percent-encoded.
    const growsTooLong = `${base}${" ".repeat(700)}x`;
    expect(growsTooLong.length).toBeLessThan(MAX_URL_LENGTH);
    for (const url of [tooLong, growsTooLong]) {
      for (const headers of [ADMIN, {}]) {
        const res = await addPage({ url }, headers);
        expect(res.status).toBe(400);
        expect(await json(res)).toEqual({ error: "invalid_url", reason: "url_too_long" });
      }
    }
    expect(fetchMock.calls).toEqual([]);
    expect(await count("pages")).toBe(0);
  });

  it(`accepts a url of exactly ${MAX_URL_LENGTH} characters`, async () => {
    mockTinyFish();
    const base = "https://example.com/";
    const res = await addPage({ url: base + "a".repeat(MAX_URL_LENGTH - base.length), kind: "policy" }, ADMIN);
    expect(res.status).toBe(201);
  });

  it("rejects a body with no url", async () => {
    const res = await addPage({ label: "x" }, ADMIN);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "invalid_url" });
    expect(fetchMock.calls).toEqual([]);
  });

  it("accepts public addresses that sit next to the private ranges", async () => {
    mockTinyFish();
    const ok = [
      "http://172.15.255.255/terms",
      "http://172.32.0.1/terms",
      "http://100.63.255.255/terms",
      "http://100.128.0.1/terms",
      "http://11.0.0.1/terms",
      "http://192.169.0.1/terms",
      "http://169.253.0.1/terms",
      "http://[2001:db8::1]/terms",
      "http://[fec0::1]/terms",
      "https://localhost.example.com/terms",
      "https://notlocal.example.com/terms",
      "https://example.local.com/terms",
      "https://internal.example.com/terms",
    ];
    for (const url of ok) {
      const res = await addPage({ url }, ADMIN);
      expect(res.status, url).toBe(201);
    }
  });

  it.each([
    ["kind", { kind: "pricey" }, "invalid_kind"],
    ["kind of the wrong type", { kind: 3 }, "invalid_kind"],
    ["ignore_patterns that is not an array", { ignore_patterns: "^Posted" }, "invalid_ignore_patterns"],
    ["ignore_patterns with a non-string", { ignore_patterns: ["ok", 1] }, "invalid_ignore_patterns"],
    ["too many ignore_patterns", { ignore_patterns: Array.from({ length: 51 }, (_, i) => `p${i}`) }, "invalid_ignore_patterns"],
    ["an over-long ignore pattern", { ignore_patterns: ["x".repeat(501)] }, "invalid_ignore_patterns"],
    ["label of the wrong type", { label: 7 }, "invalid_label"],
    ["a blank label", { label: "   " }, "invalid_label"],
    ["an over-long label", { label: "x".repeat(201) }, "invalid_label"],
  ])("rejects %s with 400 %s", async (_name, extra, error) => {
    const res = await addPage({ url: PRICING_URL, ...extra }, ADMIN);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error });
    expect(fetchMock.calls).toEqual([]);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an empty body", ""],
    ["an array", "[1]"],
    ["null", "null"],
    ["a string", '"https://vercel.com/pricing"'],
  ])("rejects %s with 400 invalid_body", async (_name, body) => {
    const res = await addPage(body, ADMIN);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "invalid_body" });
    expect(fetchMock.calls).toEqual([]);
  });
});

describe("POST /api/pages as a public caller", () => {
  it("sets expires_at 7 days out and counts against the ip; a second add the same day is 429", async () => {
    mockTinyFish();
    const ip = { "CF-Connecting-IP": "203.0.113.7" };
    const before = Date.now();
    const res = await addPage({ url: PRICING_URL }, ip);
    expect(res.status).toBe(201);
    const page = (await json(res)).page;
    expect(page).toMatchObject({ added_by: "public", status: "active", kind: "other" });
    const expires = Date.parse(page.expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + PUBLIC_TTL_DAYS * DAY_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + PUBLIC_TTL_DAYS * DAY_MS);

    const ipHash = await hashText("203.0.113.7" + env.WEBHOOK_SECRET);
    expect(await publicAddsToday(env.DB, ipHash)).toBe(1);

    const callsBefore = fetchMock.calls.length;
    const second = await addPage({ url: "https://example.com/terms" }, ip);
    expect(second.status).toBe(429);
    expect(await json(second)).toEqual({ error: "daily_limit", reason: "One public page per day per visitor" });
    expect(fetchMock.calls.length).toBe(callsBefore);
    expect(agentCalls(callsBefore)).toEqual([]);
    expect(await count("pages")).toBe(1);

    // Another visitor is not affected.
    const other = await addPage({ url: "https://example.com/terms" }, { "CF-Connecting-IP": "203.0.113.8" });
    expect(other.status).toBe(201);
  });

  it.each(["Bearer wrong", "Bearer test-admin-and-more", "Bearer test-adm", "Basic test-admin", "test-admin", "Bearer "])(
    "treats the header %j as a public caller, not an error",
    async (authorization) => {
      mockTinyFish();
      const res = await addPage({ url: PRICING_URL }, { Authorization: authorization, "CF-Connecting-IP": "192.0.2.1" });
      expect(res.status).toBe(201);
      const page = (await json(res)).page;
      expect(page.added_by).toBe("public");
      expect(page.expires_at).not.toBeNull();
      expect(await publicAddsToday(env.DB, await hashText("192.0.2.1" + env.WEBHOOK_SECRET))).toBe(1);
    },
  );

  it("groups callers with no CF-Connecting-IP under one key", async () => {
    mockTinyFish();
    expect((await addPage({ url: "https://example.com/a" })).status).toBe(201);
    const second = await addPage({ url: "https://example.com/b" });
    expect(second.status).toBe(429);
    expect(await publicAddsToday(env.DB, await hashText("unknown" + env.WEBHOOK_SECRET))).toBe(1);
  });

  it("answers 409 public_slots_full with the earliest expiry when the public slots are taken, before any TinyFish call", async () => {
    const expiries = ["2026-11-20T08:00:00.000Z", "2026-11-09T12:30:00.000Z", "2026-11-15T00:00:00.000Z", "2026-11-12T00:00:00.000Z"];
    for (const [i, expires_at] of expiries.entries()) await seed({ id: `pub${i}`, added_by: "public", expires_at });
    // These do not hold a public slot or are not live, so they must not set retry_after.
    await seed({ id: "old", added_by: "public", status: "expired", expires_at: "2026-11-01T00:00:00.000Z" });
    await seed({ id: "curated", added_by: "curated", expires_at: "2026-11-02T00:00:00.000Z" });

    const res = await addPage({ url: PRICING_URL }, { "CF-Connecting-IP": "203.0.113.20" });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body).toMatchObject({ error: "public_slots_full", retry_after: "2026-11-09T12:30:00.000Z" });
    expect(typeof body.reason).toBe("string");
    expect(fetchMock.calls).toEqual([]);
    expect(await publicAddsToday(env.DB, await hashText("203.0.113.20" + env.WEBHOOK_SECRET))).toBe(0);
  });

  it("allows an add when only three of the public slots are taken", async () => {
    mockTinyFish();
    for (let i = 0; i < PUBLIC_SLOTS - 1; i++) await seed({ id: `pub${i}`, added_by: "public", expires_at: "2026-12-01T00:00:00.000Z" });
    const res = await addPage({ url: PRICING_URL }, { "CF-Connecting-IP": "203.0.113.21" });
    expect(res.status).toBe(201);
  });

  it("does not let a public caller set ignore_patterns (an empty list is fine)", async () => {
    mockTinyFish();
    const res = await addPage({ url: PRICING_URL, ignore_patterns: ["^Posted"] }, { "CF-Connecting-IP": "203.0.113.30" });
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ error: "admin_required" });
    expect(fetchMock.calls).toEqual([]);

    const empty = await addPage({ url: PRICING_URL, ignore_patterns: [] }, { "CF-Connecting-IP": "203.0.113.30" });
    expect(empty.status).toBe(201);
  });
});

describe("POST /api/pages at the spend pause", () => {
  const spend = (amount: number) =>
    env.DB.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES (?, 'monitor_check', ?, 'x', ?)")
      .bind(crypto.randomUUID(), amount, new Date().toISOString())
      .run();

  it("refuses every add with 503 spend_paused once total spend reaches the pause, the admin's too, before any TinyFish call", async () => {
    mockTinyFish();
    await spend(SPEND_PAUSE_USD);
    const ip = "203.0.113.120";
    for (const headers of [ADMIN, { "CF-Connecting-IP": ip }]) {
      const res = await addPage({ url: PRICING_URL }, headers);
      expect(res.status).toBe(503);
      expect(await json(res)).toEqual({ error: "spend_paused", reason: "Recording is paused at the budget line" });
    }
    expect(fetchMock.calls).toEqual([]);
    expect(agentCalls()).toEqual([]);
    expect(await count("pages")).toBe(0);
    // No daily add was taken.
    expect(await publicAddsToday(env.DB, await hashText(ip + env.WEBHOOK_SECRET))).toBe(0);
  });

  it("adds as before just under the pause", async () => {
    mockTinyFish();
    await spend(SPEND_PAUSE_USD - 0.01);
    expect((await addPage({ url: PRICING_URL }, ADMIN)).status).toBe(201);
  });
});

describe("POST /api/pages without an execution context", () => {
  it("answers a refusal as before: the context is read only to schedule a capture", async () => {
    const request = new Request("https://fineprint.test/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "not a url" }),
    });
    const res = await worker.fetch(request, env, undefined as unknown as ExecutionContext);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "invalid_url" });
  });
});

describe("GET /api/pages", () => {
  it("lists every page with its counts and ignore_patterns as an array", async () => {
    mockTinyFish();
    await addPage({ url: PRICING_URL, ignore_patterns: ["^Posted"] }, ADMIN);
    await seed({ id: "bare", status: "expired" });
    const res = await callWorker("/api/pages");
    expect(res.status).toBe(200);
    const { pages } = await json(res);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({
      url: PRICING_URL,
      ignore_patterns: ["^Posted"],
      version_count: 1,
      noise_count: 0,
    });
    expect(typeof pages[0].latest_version_at).toBe("string");
    expect(pages[1]).toMatchObject({ id: "bare", ignore_patterns: [], version_count: 0, latest_version_at: null });
  });

  it("returns a page with its versions, newest first and without text", async () => {
    mockTinyFish();
    const added = await json(await addPage({ url: PRICING_URL }, ADMIN));
    const res = await callWorker(`/api/pages/${added.page.id}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.page).toMatchObject({ id: added.page.id, url: PRICING_URL, ignore_patterns: [] });
    expect(body.versions).toHaveLength(1);
    // The add's waitUntil capture has run by now (screenshot stubbed, html from TinyFetch).
    // The shared version shape: a boolean, the trigger, no raw columns.
    expect(body.versions[0]).toMatchObject({ id: added.baseline_version_id, is_baseline: true, capture_status: "complete", trigger: "create" });
    expect(body.versions[0]).not.toHaveProperty("text");
    expect(body.versions[0]).not.toHaveProperty("normalized_hash");
  });

  it("answers 404 not_found for an unknown page", async () => {
    const res = await callWorker("/api/pages/nope");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });
});

describe("PATCH /api/pages/:id", () => {
  const MONITOR = `${MONITORS_API}/mon-p1`;

  beforeEach(async () => {
    await seed({ id: "p1", label: "Old label", kind: "other", added_by: "public", expires_at: "2026-11-10T00:00:00.000Z" });
  });

  it("sends one Monitor PATCH that includes schedule_cron, then updates D1; without the admin token it is 401", async () => {
    // No token, or a wrong one: refused before anything else happens.
    const refused: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" }, { Authorization: "Bearer test-adm" }, { Authorization: "Basic test-admin" }];
    for (const headers of refused) {
      const res = await patchPage("p1", { schedule_cron: "30 6,18 * * *" }, headers);
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error: "admin_required" });
    }
    expect(fetchMock.calls).toEqual([]);
    expect((await getPage(env.DB, "p1"))!.schedule_cron).toBe("5 1,13 * * *");

    fetchMock.intercept({ method: "PATCH", url: MONITOR, reply: { status: 200, json: { monitor: { id: "mon-p1" } } } });
    const res = await patchPage("p1", { schedule_cron: "30 6,18 * * *" });
    expect(res.status).toBe(200);
    expect((await json(res)).page).toMatchObject({ id: "p1", schedule_cron: "30 6,18 * * *", purpose: PURPOSE });
    const patches = callsTo("PATCH", MONITOR);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ schedule_cron: "30 6,18 * * *" });
    expect(fetchMock.calls).toHaveLength(1);
    expect((await getPage(env.DB, "p1"))!.schedule_cron).toBe("30 6,18 * * *");
  });

  it("accepts a lower-case bearer scheme", async () => {
    const res = await patchPage("p1", { label: "New" }, { Authorization: "bearer test-admin" });
    expect(res.status).toBe(200);
  });

  it("sends the current schedule_cron with a purpose-only edit, and one call for schedule plus purpose plus label", async () => {
    fetchMock.intercept({ method: "PATCH", url: MONITOR, reply: { status: 200, json: {} }, times: 2 });
    const purposeOnly = await patchPage("p1", { purpose: "Watch the fees table only" });
    expect(purposeOnly.status).toBe(200);
    expect(callsTo("PATCH", MONITOR)[0]!.body).toEqual({ schedule_cron: "5 1,13 * * *", purpose: "Watch the fees table only" });
    expect((await getPage(env.DB, "p1"))!.purpose).toBe("Watch the fees table only");

    const all = await patchPage("p1", { schedule_cron: " 0  3,15 * *  * ", purpose: "Fees", label: "New label" });
    expect(all.status).toBe(200);
    expect(callsTo("PATCH", MONITOR)).toHaveLength(2);
    expect(callsTo("PATCH", MONITOR)[1]!.body).toEqual({ schedule_cron: "0 3,15 * * *", purpose: "Fees" });
    expect((await json(all)).page).toMatchObject({ label: "New label", schedule_cron: "0 3,15 * * *", purpose: "Fees" });
  });

  it("changes label, kind and ignore_patterns in D1 only, returning ignore_patterns as an array", async () => {
    const res = await patchPage("p1", { label: "  New label ", kind: "fees", ignore_patterns: ["^Posted", "views$"] });
    expect(res.status).toBe(200);
    expect((await json(res)).page).toMatchObject({ label: "New label", kind: "fees", ignore_patterns: ["^Posted", "views$"] });
    expect(fetchMock.calls).toEqual([]);
    expect((await getPage(env.DB, "p1"))!.ignore_patterns).toBe('["^Posted","views$"]');
  });

  it("promotes a public page: curated, no expiry, no TinyFish call", async () => {
    const res = await patchPage("p1", { promote: true });
    expect(res.status).toBe(200);
    expect((await json(res)).page).toMatchObject({ added_by: "curated", expires_at: null });
    expect(fetchMock.calls).toEqual([]);
  });

  it("changes nothing and calls nobody for an empty patch", async () => {
    const res = await patchPage("p1", {});
    expect(res.status).toBe(200);
    expect((await json(res)).page).toMatchObject({ id: "p1", label: "Old label" });
    expect(fetchMock.calls).toEqual([]);
  });

  it("answers 502 monitor_update_failed with the TinyFish code and leaves D1 alone", async () => {
    fetchMock.intercept({
      method: "PATCH",
      url: MONITOR,
      reply: { status: 500, json: { error: { code: "INTERNAL", message: "upstream private detail" } } },
    });
    const res = await patchPage("p1", { schedule_cron: "30 6,18 * * *", label: "New label", promote: true });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "monitor_update_failed", reason: "INTERNAL" });
    expect(text).not.toContain("upstream private detail");
    expect(await getPage(env.DB, "p1")).toMatchObject({
      schedule_cron: "5 1,13 * * *",
      label: "Old label",
      added_by: "public",
      expires_at: "2026-11-10T00:00:00.000Z",
    });
  });

  it("answers 409 page_expired for a schedule or purpose edit on an expired page or one with no Monitor", async () => {
    await seed({ id: "dead", status: "expired" });
    await seed({ id: "bare", monitor_id: null });
    for (const id of ["dead", "bare"]) {
      for (const body of [{ schedule_cron: "30 6,18 * * *" }, { purpose: "x" }]) {
        const res = await patchPage(id, body);
        expect(res.status).toBe(409);
        expect(await json(res)).toEqual({ error: "page_expired" });
      }
    }
    expect(fetchMock.calls).toEqual([]);
    // A label edit needs no Monitor.
    expect((await patchPage("dead", { label: "Still editable" })).status).toBe(200);
  });

  it.each([
    ["an unknown kind", { kind: "x" }, "invalid_kind"],
    ["a blank label", { label: " " }, "invalid_label"],
    ["ignore_patterns that is not an array", { ignore_patterns: "x" }, "invalid_ignore_patterns"],
    ["a non-string ignore pattern", { ignore_patterns: [null] }, "invalid_ignore_patterns"],
    ["a cron with three fields", { schedule_cron: "* * *" }, "invalid_schedule_cron"],
    ["a cron with six fields", { schedule_cron: "* * * * * *" }, "invalid_schedule_cron"],
    ["an empty cron", { schedule_cron: "" }, "invalid_schedule_cron"],
    ["a cron that is not a string", { schedule_cron: 5 }, "invalid_schedule_cron"],
    ["an empty purpose", { purpose: "  " }, "invalid_purpose"],
    ["a purpose that is not a string", { purpose: 1 }, "invalid_purpose"],
    ["promote: false", { promote: false }, "invalid_promote"],
    ["promote: 'yes'", { promote: "yes" }, "invalid_promote"],
  ])("rejects %s with 400 %s and calls nobody", async (_name, body, error) => {
    const res = await patchPage("p1", body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error });
    expect(fetchMock.calls).toEqual([]);
  });

  it("rejects a malformed body with 400 invalid_body", async () => {
    for (const body of ["{nope", "[]", "null"]) {
      const res = await patchPage("p1", body);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_body" });
    }
  });

  it("answers 404 not_found for an unknown page, but 401 first without a token", async () => {
    const res = await patchPage("nope", { label: "x" });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
    expect((await patchPage("nope", { label: "x" }, {})).status).toBe(401);
  });
});

describe("DELETE /api/pages/:id", () => {
  beforeEach(async () => {
    await seed({ id: "p1", added_by: "public", expires_at: "2026-11-10T00:00:00.000Z" });
  });

  it("deletes the Monitor and marks the page expired, keeping its rows", async () => {
    mockTinyFish();
    const added = await json(await addPage({ url: PRICING_URL }, ADMIN));
    mockMonitorDelete("mon-1");
    const res = await deletePage(added.page.id);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deleted: true });
    expect(callsTo("DELETE", `${MONITORS_API}/mon-1`)).toHaveLength(1);
    expect(await getPage(env.DB, added.page.id)).toMatchObject({ status: "expired", url: PRICING_URL });
    expect(await versionsOf(added.page.id)).toHaveLength(1);
    expect(await count("runs")).toBe(1);
  });

  it("is admin only: no token (a public visitor) is 401 and nothing is deleted", async () => {
    const refused: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" }];
    for (const headers of refused) {
      const res = await deletePage("p1", headers);
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error: "admin_required" });
    }
    expect(fetchMock.calls).toEqual([]);
    expect((await getPage(env.DB, "p1"))!.status).toBe("active");
  });

  it("answers 404 not_found for an unknown page", async () => {
    const res = await deletePage("nope");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });

  it("answers 200 for an already expired page without calling TinyFish", async () => {
    await seed({ id: "dead", status: "expired" });
    const res = await deletePage("dead");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deleted: true });
    expect(fetchMock.calls).toEqual([]);
  });

  it("treats a Monitor TinyFish no longer has (404) as deleted", async () => {
    mockMonitorDelete("mon-p1", { status: 404, json: { error: { code: "NOT_FOUND" } } });
    const res = await deletePage("p1");
    expect(res.status).toBe(200);
    expect((await getPage(env.DB, "p1"))!.status).toBe("expired");
  });

  it("answers 502 monitor_delete_failed and keeps the page active when TinyFish fails", async () => {
    mockMonitorDelete("mon-p1", { status: 500, json: { error: { code: "INTERNAL", message: "private detail" } } });
    const res = await deletePage("p1");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "monitor_delete_failed", reason: "INTERNAL" });
    expect(text).not.toContain("private detail");
    expect((await getPage(env.DB, "p1"))!.status).toBe("active");
  });
});

describe("parallel adds", () => {
  it("claimPublicAdd takes adds up to the limit, releasePublicAdd gives one back and never goes below zero", async () => {
    expect(await claimPublicAdd(env.DB, "ip-a", 0)).toBe(false);
    expect(await publicAddsToday(env.DB, "ip-a")).toBe(0);
    expect(await claimPublicAdd(env.DB, "ip-a", 1)).toBe(true);
    expect(await claimPublicAdd(env.DB, "ip-a", 1)).toBe(false);
    expect(await publicAddsToday(env.DB, "ip-a")).toBe(1);
    await releasePublicAdd(env.DB, "ip-a");
    expect(await publicAddsToday(env.DB, "ip-a")).toBe(0);
    await releasePublicAdd(env.DB, "ip-a"); // nothing to give back
    await releasePublicAdd(env.DB, "ip-never-seen");
    expect(await publicAddsToday(env.DB, "ip-a")).toBe(0);
    expect(await claimPublicAdd(env.DB, "ip-a", 2)).toBe(true);
    expect(await claimPublicAdd(env.DB, "ip-a", 2)).toBe(true);
    expect(await claimPublicAdd(env.DB, "ip-a", 2)).toBe(false);
    expect(await publicAddsToday(env.DB, "ip-b")).toBe(0); // other keys are separate
  });

  it("lets exactly the limit through when claims race", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => claimPublicAdd(env.DB, "ip-race", 2)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await publicAddsToday(env.DB, "ip-race")).toBe(2);
  });

  it("creates exactly one Monitor when one visitor fires several adds at once", async () => {
    // TinyFetch is slow, so every request is past the plain daily check before any has written.
    mockTinyFish({ fetchDelayMs: 25 });
    const ip = { "CF-Connecting-IP": "203.0.113.70" };
    const urls = [1, 2, 3, 4, 5].map((n) => `https://example.com/terms-${n}`);
    const responses = await Promise.all(urls.map((url) => addPage({ url }, ip)));

    expect(responses.map((r) => r.status).sort()).toEqual([201, 429, 429, 429, 429]);
    for (const res of responses.filter((r) => r.status === 429)) {
      expect(await json(res)).toEqual({ error: "daily_limit", reason: "One public page per day per visitor" });
    }
    expect(callsTo("POST", MONITORS_API)).toHaveLength(1);
    // The losers never got as far as TinyFetch: one validation, and one html fetch by the winner's capture.
    const fetches = callsTo("POST", FETCH_API).map((c) => (c.body as { format: string }).format);
    expect(fetches.filter((f) => f === "markdown")).toHaveLength(1);
    expect(fetches.filter((f) => f === "html")).toHaveLength(1);
    expect(fetches).toHaveLength(2);
    expect(await count("pages")).toBe(1);
    expect(await publicAddsToday(env.DB, await hashText("203.0.113.70" + env.WEBHOOK_SECRET))).toBe(1);
  });

  it("gives the daily add back when the add fails, so the visitor can try again", async () => {
    const ip = { "CF-Connecting-IP": "203.0.113.71" };
    const used = async () => publicAddsToday(env.DB, await hashText("203.0.113.71" + env.WEBHOOK_SECRET));

    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [], errors: [{ url: PRICING_URL, error: "bot_blocked" }] } },
    });
    expect((await addPage({ url: PRICING_URL }, ip)).status).toBe(422);
    expect(await used()).toBe(0);

    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [{ url: PRICING_URL, final_url: PRICING_URL, title: "Blank", text: " " }], errors: [] } },
    });
    expect((await addPage({ url: PRICING_URL }, ip)).status).toBe(422);
    expect(await used()).toBe(0);

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchFixture } });
    fetchMock.intercept({
      method: "POST",
      url: MONITORS_API,
      reply: { status: 402, json: { error: { code: "INSUFFICIENT_CREDITS" } } },
    });
    expect((await addPage({ url: PRICING_URL }, ip)).status).toBe(502);
    expect(await used()).toBe(0);

    mockTinyFish();
    expect((await addPage({ url: PRICING_URL }, ip)).status).toBe(201);
    expect(await used()).toBe(1);
    expect((await addPage({ url: "https://example.com/other" }, ip)).status).toBe(429);
  });

  it("never holds more than 24 Monitors when adds race for the last slot, and takes the losers' Monitors back", async () => {
    for (let i = 0; i < MAX_MONITORS - 1; i++) await seed({ id: `p${i}` });
    // All three adds see room for one more and create a Monitor before any of them has stored a page.
    mockTinyFish({ holdCreatesUntil: 3 });
    const responses = await Promise.all(
      ["a", "b", "c"].map((n) => addPage({ url: `https://${n}.example.com/terms` }, ADMIN)),
    );

    const won = responses.filter((r) => r.status === 201).length;
    const lost = responses.filter((r) => r.status === 409);
    expect(won).toBeLessThanOrEqual(1);
    expect(won + lost.length).toBe(3);
    for (const res of lost) expect(await json(res)).toMatchObject({ error: "watchlist_full" });

    expect(callsTo("POST", MONITORS_API)).toHaveLength(3); // each was billed
    expect(fetchMock.calls.filter((c) => c.method === "DELETE")).toHaveLength(lost.length);
    expect(await countMonitors(env.DB)).toBe(MAX_MONITORS - 1 + won);
    // No loser left a half-written add behind.
    expect(await count("pages")).toBe(MAX_MONITORS - 1 + won);
    expect(await count("versions")).toBe(won);
    expect(await count("runs")).toBe(won);
  });

  it("never holds more than the public slots when visitors race for the last one, and frees the losers' daily add", async () => {
    for (let i = 0; i < PUBLIC_SLOTS - 1; i++) {
      await seed({ id: `pub${i}`, added_by: "public", expires_at: `2026-12-0${i + 1}T00:00:00.000Z` });
    }
    mockTinyFish({ holdCreatesUntil: 3 });
    const ips = ["203.0.113.81", "203.0.113.82", "203.0.113.83"];
    const responses = await Promise.all(
      ips.map((ip, i) => addPage({ url: `https://v${i}.example.com/terms` }, { "CF-Connecting-IP": ip })),
    );

    const won = responses.filter((r) => r.status === 201).length;
    const lost = responses.filter((r) => r.status === 409);
    expect(won).toBeLessThanOrEqual(1);
    expect(won + lost.length).toBe(3);
    for (const res of lost) {
      const body = await json(res);
      expect(body).toMatchObject({ error: "public_slots_full" });
      expect(typeof body.reason).toBe("string");
      expect(body.retry_after).toBe("2026-12-01T00:00:00.000Z");
    }

    expect(callsTo("POST", MONITORS_API)).toHaveLength(3);
    expect(fetchMock.calls.filter((c) => c.method === "DELETE")).toHaveLength(lost.length);
    expect(await countMonitors(env.DB, "public")).toBe(PUBLIC_SLOTS - 1 + won);
    expect(await count("pages")).toBe(PUBLIC_SLOTS - 1 + won);
    const used = await Promise.all(ips.map(async (ip) => publicAddsToday(env.DB, await hashText(ip + env.WEBHOOK_SECRET))));
    expect(used.reduce((a, b) => a + b, 0)).toBe(won); // only the winner's visitor used the daily add
  });
});

describe("secrets in logs and responses", () => {
  it("never writes or returns the webhook secret when TinyFish echoes the webhook url back", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const webhook = `https://fineprint.test/hooks/monitor/${env.WEBHOOK_SECRET}`;
    const echo = {
      status: 400,
      json: { error: { code: "INVALID_WEBHOOK_URL", message: `webhook_url ${webhook} is not allowed` } },
    };
    try {
      fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: fetchFixture } });
      fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: echo });
      const add = await addPage({ url: PRICING_URL }, ADMIN);
      expect(add.status).toBe(502);
      expect(await add.text()).toBe('{"error":"monitor_create_failed","reason":"INVALID_WEBHOOK_URL"}');

      await seed({ id: "p1" });
      fetchMock.intercept({ method: "PATCH", url: `${MONITORS_API}/mon-p1`, reply: echo });
      const patch = await patchPage("p1", { schedule_cron: "30 6,18 * * *" });
      expect(patch.status).toBe(502);
      expect(await patch.text()).toBe('{"error":"monitor_update_failed","reason":"INVALID_WEBHOOK_URL"}');

      fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/mon-p1`, reply: echo });
      const del = await deletePage("p1");
      expect(del.status).toBe(502);
      expect(await del.text()).toBe('{"error":"monitor_delete_failed","reason":"INVALID_WEBHOOK_URL"}');

      // Each failure was logged, with its status and code and nothing the upstream said.
      expect(logged).toHaveBeenCalledTimes(3);
      const lines = JSON.stringify(logged.mock.calls);
      expect(lines).toContain("TinyFishError status=400 code=INVALID_WEBHOOK_URL");
      expect(lines).not.toContain(env.WEBHOOK_SECRET);
      expect(lines).not.toContain("is not allowed");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("admin token", () => {
  it("safeEqual is true only for identical strings", () => {
    expect(safeEqual("test-admin", "test-admin")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("pässword", "pässword")).toBe(true);
    expect(safeEqual("test-admin", "test-admiN")).toBe(false);
    expect(safeEqual("test-admin", "test-admin ")).toBe(false);
    expect(safeEqual("test-admin", "")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual("pässword", "passwörd")).toBe(false);
  });


  it("never authenticates when the Worker has no ADMIN_TOKEN, even with an empty bearer token", async () => {
    await seed({ id: "p1" });
    const noToken = { DB: env.DB, STORE: env.STORE, TINYFISH_API_KEY: "k", ADMIN_TOKEN: "", WEBHOOK_SECRET: "s", PUBLIC_BASE_URL: "https://fineprint.test" };
    for (const authorization of ["Bearer ", "Bearer", "Bearer x"]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request("https://fineprint.test/api/pages/p1", { method: "DELETE", headers: { Authorization: authorization } }),
        noToken,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status, authorization).toBe(401);
    }
    expect((await getPage(env.DB, "p1"))!.status).toBe("active");
  });
});

describe("unexpected errors", () => {
  it("answer 500 internal_error as JSON, without the error text", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("secret detail about the database");
      },
    } as unknown as D1Database;
    const broken = { DB: brokenDb, STORE: env.STORE, TINYFISH_API_KEY: "k", ADMIN_TOKEN: "a", WEBHOOK_SECRET: "s", PUBLIC_BASE_URL: "https://fineprint.test" };
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://fineprint.test/api/pages"), broken, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("secret detail");
  });
});

describe("pageToJson", () => {
  const row: PageRow = {
    id: "p1",
    url: "https://example.com/terms",
    label: "Terms",
    kind: "policy",
    monitor_id: "mon-1",
    schedule_cron: "0 0,12 * * *",
    purpose: PURPOSE,
    status: "active",
    added_by: "admin",
    ignore_patterns: '["^Posted","views$"]',
    expires_at: null,
    created_at: "2026-11-03T10:00:00.000Z",
    last_run_at: null,
    last_change_at: null,
    pending_hash: null,
    pending_run_id: null,
    pending_at: null,
    pull_failures: 0,
    pull_retry_after: null,
  };

  it("parses ignore_patterns and keeps every other column, including extra list columns", () => {
    expect(pageToJson(row)).toEqual({ ...row, ignore_patterns: ["^Posted", "views$"] });
    const listed = pageToJson({ ...row, version_count: 3, noise_count: 1, latest_version_at: "2026-11-03T10:00:00.000Z" });
    expect(listed.version_count).toBe(3);
    expect(listed.ignore_patterns).toEqual(["^Posted", "views$"]);
  });

  it("returns [] for stored text that is not a JSON array and drops non-string entries", () => {
    expect(pageToJson({ ...row, ignore_patterns: "" }).ignore_patterns).toEqual([]);
    expect(pageToJson({ ...row, ignore_patterns: "{oops" }).ignore_patterns).toEqual([]);
    expect(pageToJson({ ...row, ignore_patterns: '{"a":1}' }).ignore_patterns).toEqual([]);
    expect(pageToJson({ ...row, ignore_patterns: '["a",1,null,"b"]' }).ignore_patterns).toEqual(["a", "b"]);
  });
});
