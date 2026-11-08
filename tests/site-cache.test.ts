import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps } from "../src/capture";
import { cronDeps, runCron } from "../src/cron";
import { addPage } from "../src/handlers/pages";
import { fillDeltas, fillSummaries, summaryDeps } from "../src/summary";
import { fetchMock } from "./helpers/fetch-mock";
import fetchFixture from "./fixtures/tinyfish/fetch.json";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import { insertPage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { RunRow, TriggerKind } from "../src/db/types";
import { insertVersion, type NewVersion } from "../src/db/versions";
import { REBUILD_BUSY_TICK_CALLS, REBUILD_CALLS_PER_TICK } from "../src/core/limits";
import {
  cacheKey,
  deployStamp,
  dropCached,
  dropCachedPages,
  dropCachedWatchlist,
  isScreenListing,
  isStoredScreen,
  sweepStoredScreens,
} from "../src/site/htmlCache";
import worker from "../src/index";

// The stored copy of the likely screens (src/site/htmlCache.ts): the first answer is a miss that stores
// screens/<stamp>/<key>, the next is a hit with the same body and headers, and every screen with a varying query
// parameter, every 404 and every screen that still refreshes itself is never stored.

// Each test renders several screens, which the suite running in parallel can slow past the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

const db = env.DB;
const cacheOn = { ...env, HTML_CACHE: "1" };
/** This deploy's stamp in the test pool (the version metadata binding's id). */
const STAMP = deployStamp(cacheOn);
/** The R2 key of a stored screen under this deploy's stamp. */
const at = (key: string): string => `screens/${STAMP}/${key}`;

/** The Worker with the stored copy on (the suite's default has it off), waiting for the write after the response. */
async function callWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(new URL(path, "https://fineprint.test"), init), cacheOn, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

const page = (id: string): NewPage => ({
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
});

async function version(id: string, pageId: string, at: string, trigger: TriggerKind, over: Partial<NewVersion> = {}): Promise<void> {
  const baseline = trigger === "create";
  const run: RunRow = {
    id: `run-${id}`,
    page_id: pageId,
    monitor_run_id: `m-${id}`,
    outcome: baseline ? "baseline" : "changed",
    is_baseline: baseline ? 1 : 0,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: at,
    trigger_kind: trigger,
  };
  await insertRun(db, run);
  await insertVersion(db, {
    id,
    page_id: pageId,
    run_id: run.id,
    is_baseline: baseline ? 1 : 0,
    captured_at: at,
    text: `Plan costs ${id} dollars\n\nSecond block of ${id}`,
    normalized_hash: `hash-${id}`,
    judgment_summary: null,
    screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`,
    capture_status: "complete",
    facts_status: "not_needed",
    ...over,
  });
}

/** The screen keys the cache wrote under this deploy's stamp. */
async function stored(): Promise<string[]> {
  const listed = await env.STORE.list({ prefix: at("") });
  return listed.objects.map((o) => o.key.slice(at("").length));
}

const headersOf = (res: Response): [string, string][] =>
  [...res.headers.entries()].filter(([name]) => name !== "x-fineprint-cache").sort(([a], [b]) => a.localeCompare(b));

/** First answer a miss that stores `key`, second a hit that is the same response. */
async function missThenHit(path: string, key: string): Promise<void> {
  const first = await callWorker(path);
  expect(first.status, path).toBe(200);
  expect(first.headers.get("x-fineprint-cache"), path).toBe("miss");
  const body = await first.text();
  expect(await stored(), path).toContain(key);

  const second = await callWorker(path);
  expect(second.status, path).toBe(200);
  expect(second.headers.get("x-fineprint-cache"), path).toBe("hit");
  expect(await second.text(), path).toBe(body);
  expect(headersOf(second), path).toEqual(headersOf(first));
  expect(second.headers.get("content-security-policy"), path).toContain("default-src 'self'");
  expect(second.headers.get("content-type"), path).toContain("text/html");
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await insertPage(db, page("alpha"));
  await version("a-1", "alpha", ago(3 * HOUR), "create");
  await version("a-2", "alpha", ago(2 * HOUR), "webhook");
  await version("a-3", "alpha", ago(HOUR), "webhook");
});

describe("the stored copy of the likely screens", () => {
  it("serves the home screen: a miss stores screens/<stamp>/home, the next is the same response", async () => {
    await missThenHit("/", "home");
    expect(headersOf(await callWorker("/"))).toContainEqual(["cache-control", "public, max-age=60"]);
  });

  it("serves about, the watchlist, a default page view and a default compare the same way", async () => {
    await missThenHit("/about", "about");
    await missThenHit("/watchlist", "watchlist");
    await missThenHit("/pages/alpha", "page/alpha");
    await missThenHit("/pages/alpha/compare", cacheKey.compare("alpha", "a-2", "a-3"));
  });

  it("maps a compare with only to= (or only from=) onto the concrete pair", async () => {
    const first = await callWorker("/pages/alpha/compare?to=a-3");
    expect(first.headers.get("x-fineprint-cache")).toBe("miss");
    await first.text();
    expect(await stored()).toEqual(["compare/alpha/a-2/a-3"]);
    expect((await callWorker("/pages/alpha/compare")).headers.get("x-fineprint-cache")).toBe("hit");
    expect((await callWorker("/pages/alpha/compare?from=a-2&to=a-3")).headers.get("x-fineprint-cache")).toBe("hit");
    // a different pair is its own copy
    expect((await callWorker("/pages/alpha/compare?to=a-2")).headers.get("x-fineprint-cache")).toBe("miss");
    expect(await stored()).toEqual(["compare/alpha/a-1/a-2", "compare/alpha/a-2/a-3"]);
  });

  it("never stores a screen with a varying or unknown query parameter", async () => {
    const paths = [
      "/?before=2030-01-01",
      "/?x=1",
      "/about?x=1",
      "/watchlist?domain=example.com",
      "/watchlist?url=https://example.com&label=Pricing",
      "/watchlist?x=1",
      "/pages/alpha?at=2030-01-01",
      "/pages/alpha?v=a-2",
      "/pages/alpha?text=1",
      "/pages/alpha?all=1",
      "/pages/alpha?x=1",
      "/pages/alpha/compare?all=1",
      "/pages/alpha/compare?to=a-3&all=1",
      "/pages/alpha/compare?x=1",
    ];
    for (const path of paths) {
      const res = await callWorker(path);
      await res.text();
      expect(res.headers.get("x-fineprint-cache"), path).toBeNull();
      expect(await stored(), path).toEqual([]);
    }
  });

  it("never stores a 404", async () => {
    for (const path of ["/no/such", "/pages/nope", "/pages/nope/compare", "/pages/alpha?v=missing", "/pages/alpha/compare?to=missing"]) {
      const res = await callWorker(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("x-fineprint-cache"), path).toBeNull();
    }
    expect(await stored()).toEqual([]);
  });

  it("does not serve a stored page view once the page is gone", async () => {
    await missThenHit("/pages/alpha", "page/alpha");
    await db.prepare("DELETE FROM pages WHERE id = 'alpha'").run();
    const res = await callWorker("/pages/alpha");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-fineprint-cache")).toBeNull();
  });

  it("never stores a page view that reloads itself for a screenshot, or a page with no version", async () => {
    await insertPage(db, page("young"));
    await version("y-1", "young", ago(30_000), "create", { screenshot_key: null, html_key: null, capture_status: "pending" });
    await insertPage(db, page("bare"));
    for (const path of ["/pages/young", "/pages/bare"]) {
      const res = await callWorker(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-fineprint-cache"), path).toBe("miss");
      expect(res.headers.get("cache-control"), path).not.toBe("public, max-age=60");
    }
    expect(await stored()).toEqual([]);
  });

  it("does not store on HEAD, but a HEAD may read a copy", async () => {
    const head = await callWorker("/about", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await stored()).toEqual([]);
    await (await callWorker("/about")).text();
    expect((await callWorker("/about", { method: "HEAD" })).headers.get("x-fineprint-cache")).toBe("hit");
  });

  it("a failed write never reaches the response", async () => {
    const put = vi.spyOn(env.STORE, "put").mockRejectedValue(new Error("r2 down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await callWorker("/about");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-fineprint-cache")).toBe("miss");
      expect(error).toHaveBeenCalled();
    } finally {
      put.mockRestore();
      error.mockRestore();
    }
  });

  it("a hit on / reads nothing from D1; a hit on a page view reads only the page", async () => {
    await (await callWorker("/")).text();
    await (await callWorker("/pages/alpha")).text();
    const prepare = vi.spyOn(env.DB, "prepare");
    const batch = vi.spyOn(env.DB, "batch");
    const exec = vi.spyOn(env.DB, "exec");
    try {
      const home = await callWorker("/");
      expect(home.headers.get("x-fineprint-cache")).toBe("hit");
      expect(prepare.mock.calls.length + batch.mock.calls.length + exec.mock.calls.length).toBe(0);

      prepare.mockClear();
      const view = await callWorker("/pages/alpha");
      expect(view.headers.get("x-fineprint-cache")).toBe("hit");
      expect(prepare.mock.calls).toHaveLength(1);
      expect(batch.mock.calls).toHaveLength(0);
    } finally {
      for (const spy of [prepare, batch, exec]) spy.mockRestore();
    }
  });

  it("dropCached removes a stored copy", async () => {
    await (await callWorker("/about")).text();
    await dropCached(env, [cacheKey.about(), cacheKey.home()]);
    expect(await stored()).toEqual([]);
  });
});

// --- Invalidation ------------------------------------------------------------------------------------

const ALL_KEYS = ["home", "about", "watchlist", "page/alpha", "page/beta", "compare/alpha/a-1/a-2", "compare/alpha/a-2/a-3", "compare/beta/b-1/b-2"];

/** Every screen has a stored copy, whatever the pages are. */
async function fillCache(): Promise<void> {
  for (const key of ALL_KEYS) await env.STORE.put(at(key), `<p>${key}</p>`, { customMetadata: { headers: "{}" } });
}

const left = async (): Promise<string[]> => (await stored()).sort();
const without = (...gone: string[]): string[] => ALL_KEYS.filter((k) => !gone.includes(k)).sort();
const WATCHLIST_SCREENS = ["watchlist", "home", "about"];

describe("dropping the stored screens that show a change", () => {
  let screenshot: ReturnType<typeof vi.spyOn>;
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    fetchMock.activate();
    screenshot = vi.spyOn(captureDeps, "screenshotFullPage").mockImplementation(async () => ({
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
      height: 800,
      sessionId: "sess-test",
    }));
    captureDeps.sleep = async () => {};
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await insertPage(db, page("beta"));
    await version("b-1", "beta", ago(3 * HOUR), "create");
    await fillCache();
  });
  afterEach(() => {
    fetchMock.reset();
    screenshot.mockRestore();
    captureDeps.sleep = undefined;
    vi.restoreAllMocks();
  });

  it("a new version's summary and delta drop home, about, its page and its compares, and leave other pages alone", async () => {
    await version("a-4", "alpha", ago(60_000), "webhook");
    const answer = await fillSummaries(cacheOn, { versionId: "a-4" });
    expect(answer.filled).toBe(1);
    expect(await left()).toEqual(without("home", "about", "page/alpha", "compare/alpha/a-1/a-2", "compare/alpha/a-2/a-3"));
  });

  it("a fill that finds nothing to write drops nothing", async () => {
    await fillSummaries(cacheOn, { versionId: "a-1" }); // a baseline keeps no summary
    expect(await left()).toEqual(ALL_KEYS.slice().sort());
  });

  it("a failed delete is logged and the fill still succeeds", async () => {
    await version("a-4", "alpha", ago(60_000), "webhook");
    vi.spyOn(env.STORE, "delete").mockRejectedValue(new Error("r2 down"));
    const answer = await fillSummaries(cacheOn, { versionId: "a-4" });
    expect(answer.filled).toBe(1);
    expect(errorLog).toHaveBeenCalledWith("html cache drop failed", "Error");
  });

  it("a public add drops the watchlist, home and about; a failed delete does not fail the add", async () => {
    mockTinyFish();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    const added = await addPage(cacheOn, ctx, { url: "https://example.com/pricing" }, { admin: false, ipHash: async () => "ip-1" });
    await Promise.all(pending);
    expect(added.ok).toBe(true);
    expect(await left()).toEqual(without(...WATCHLIST_SCREENS));

    await fillCache();
    vi.spyOn(env.STORE, "delete").mockRejectedValue(new Error("r2 down"));
    pending.length = 0;
    const again = await addPage(cacheOn, ctx, { url: "https://example.com/terms" }, { admin: false, ipHash: async () => "ip-2" });
    await Promise.all(pending);
    expect(again.ok).toBe(true);
    expect(errorLog).toHaveBeenCalledWith("html cache delete failed", "Error");
  });

  it("a retirement drops the watchlist, home, about and the page's own view", async () => {
    fetchMock.intercept({ method: "DELETE", url: /\/v1\/monitors\/mon-alpha$/, reply: { status: 204 } });
    const res = await callWorker("/api/admin/pages/alpha/retire", { method: "POST", headers: { Authorization: "Bearer test-admin" } });
    expect(res.status).toBe(200);
    expect(await left()).toEqual(without(...WATCHLIST_SCREENS, "page/alpha"));
  });

  it("an expiry drops the watchlist, home, about and the page's own view", async () => {
    await insertPage(db, { ...page("old"), added_by: "public", expires_at: ago(1000) });
    fetchMock.intercept({ method: "DELETE", url: /\/v1\/monitors\/mon-old$/, reply: { status: 204 } });
    fetchMock.intercept({ method: "GET", url: "https://agent.tinyfish.ai/v1/monitors", times: Infinity, reply: { json: { monitors: [] } } });
    await env.STORE.put(at("page/old"), "<p>old</p>");
    const rebuild = vi.spyOn(cronDeps, "rebuild").mockResolvedValue(new Response("{}")); // the tick's own rebuild is tested below
    const result = await runCron(cacheOn);
    rebuild.mockRestore();
    expect(result.expired).toBe(1);
    // (The same tick also asks for the missing summaries, which drops alpha's screens: only these are checked.)
    const rest = await left();
    for (const key of [...WATCHLIST_SCREENS, "page/old"]) expect(rest).not.toContain(key);
    expect(rest).toContain("page/beta");
  });

  it("a deletion drops the watchlist, home, about and the page's own view", async () => {
    fetchMock.intercept({ method: "DELETE", url: /\/v1\/monitors\/mon-beta$/, reply: { status: 204 } });
    const res = await callWorker("/api/pages/beta", { method: "DELETE", headers: { Authorization: "Bearer test-admin" } });
    expect(res.status).toBe(200);
    expect(await left()).toEqual(without(...WATCHLIST_SCREENS, "page/beta"));
  });
});

/** TinyFetch reads any url; a Monitor create gets mon-N; deletes are answered. */
let monitorSeq = 0;
function mockTinyFish(): void {
  fetchMock.intercept({ method: "POST", url: "https://api.fetch.tinyfish.ai", times: Infinity, reply: () => Response.json(fetchFixture) });
  fetchMock.intercept({
    method: "POST",
    url: "https://agent.tinyfish.ai/v1/monitors",
    times: Infinity,
    reply: () => {
      const body = structuredClone(monitorCreate);
      body.monitor.id = `mon-n${++monitorSeq}`;
      body.run.id = `mrun-n${monitorSeq}`;
      return Response.json(body, { status: 201 });
    },
  });
}

// --- The hourly rebuild ------------------------------------------------------------------------------

const ADMIN = { Authorization: "Bearer test-admin" };

describe("POST /api/admin/rebuild-html", () => {
  it("refuses without the admin token and stores nothing", async () => {
    for (const headers of [{} as Record<string, string>, { Authorization: "Bearer wrong" }]) {
      const res = await callWorker("/api/admin/rebuild-html?key=home", { method: "POST", headers });
      expect(res.status).toBe(401);
    }
    expect(await stored()).toEqual([]);
  });

  it("renders a screen fresh and stores it: a GET that follows is a hit with the same body and headers", async () => {
    // the cache is on only for this suite's worker calls; the route itself needs no setting
    for (const key of ["home", "about", "watchlist", "page/alpha", "compare/alpha/a-2/a-3"]) {
      const res = await callWorker(`/api/admin/rebuild-html?key=${key}`, { method: "POST", headers: ADMIN });
      expect(await res.json(), key).toEqual({ key, stored: true });
    }
    expect((await stored()).sort()).toEqual(["about", "compare/alpha/a-2/a-3", "home", "page/alpha", "watchlist"]);
    const hit = await callWorker("/pages/alpha");
    expect(hit.headers.get("x-fineprint-cache")).toBe("hit");
    expect(await hit.text()).toContain("<h1>alpha</h1>");
    // a rebuild replaces the copy with a fresh render
    await env.STORE.put(at("page/alpha"), "stale", { customMetadata: { headers: "{}" } });
    await callWorker("/api/admin/rebuild-html?key=page/alpha", { method: "POST", headers: ADMIN });
    const again = await callWorker("/pages/alpha");
    expect(again.headers.get("x-fineprint-cache")).toBe("hit");
    expect(await again.text()).toContain("<h1>alpha</h1>"); // the render, not the stale copy
    expect(headersOf(again)).toEqual(headersOf(hit));
  });

  it("does not store a screen that is not kept, and refuses a key of another kind", async () => {
    const missing = await callWorker("/api/admin/rebuild-html?key=page/nope", { method: "POST", headers: ADMIN });
    expect(await missing.json()).toEqual({ key: "page/nope", stored: false });
    for (const key of ["", "x", "page", "page/a/b", "compare/a/b", "../home"]) {
      const res = await callWorker(`/api/admin/rebuild-html?key=${encodeURIComponent(key)}`, { method: "POST", headers: ADMIN });
      expect(res.status, key).toBe(400);
    }
    expect(await stored()).toEqual([]);
  });

  it("the public cannot force a fresh render: HTML_CACHE is not read from a request", async () => {
    await env.STORE.put(at("about"), "<p>kept</p>", { customMetadata: { headers: "{}" } });
    const res = await callWorker("/about", { headers: { "x-fineprint-cache": "rebuild", "cache-control": "no-cache" } });
    expect(res.headers.get("x-fineprint-cache")).toBe("hit");
    expect(await res.text()).toBe("<p>kept</p>");
  });
});

describe("the hourly tick's rebuild", () => {
  let asked: string[];
  let rebuild: MockInstance<typeof cronDeps.rebuild>;
  const at = (hour: number) => vi.spyOn(cronDeps, "now").mockReturnValue(new Date(`2026-11-07T${String(hour).padStart(2, "0")}:30:00.000Z`));
  beforeEach(() => {
    asked = [];
    rebuild = vi.spyOn(cronDeps, "rebuild").mockImplementation(async (_env, key) => {
      asked.push(key);
      return new Response("{}");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("rebuilds home, about and the watchlist, then pre-warms only the pages changed in the last 24 hours", async () => {
    await insertPage(db, page("quiet"));
    await version("q-1", "quiet", ago(30 * HOUR), "create");
    await version("q-2", "quiet", ago(26 * HOUR), "webhook");
    await runCron(cacheOn);
    expect(asked.slice(0, 3)).toEqual(["home", "about", "watchlist"]);
    expect(asked.slice(3)).toEqual(["page/alpha", "compare/alpha/a-2/a-3"]);
    expect(rebuild).toHaveBeenCalledTimes(5);
  });

  it("makes at most the cap in a tick, the fixed three always among them, and rotates by the hour", async () => {
    for (let n = 0; n < 6; n++) {
      await insertPage(db, page(`p${n}`));
      await version(`p${n}-1`, `p${n}`, ago(3 * HOUR), "create");
      await version(`p${n}-2`, `p${n}`, ago(2 * HOUR), "webhook");
    }
    at(5);
    await runCron(cacheOn);
    const first = asked.slice();
    expect(first).toHaveLength(REBUILD_CALLS_PER_TICK);
    expect(first.slice(0, 3)).toEqual(["home", "about", "watchlist"]);
    expect(new Set(first).size).toBe(first.length);
    asked.length = 0;
    at(6);
    await runCron(cacheOn);
    expect(asked).toHaveLength(REBUILD_CALLS_PER_TICK);
    expect(asked.slice(3)).not.toEqual(first.slice(3));
  });

  it("a failing rebuild is logged and does not fail the tick or stop the others", async () => {
    rebuild.mockImplementation(async (_env: unknown, key: string) => {
      asked.push(key);
      if (key === "about") throw new Error("down");
      return new Response("no", { status: 500 });
    });
    const result = await runCron(cacheOn);
    expect(result).toEqual({ repaired: 0, expired: 0, unhealthy: [], pulled: 0 });
    expect(asked.slice(0, 3)).toEqual(["home", "about", "watchlist"]);
  });
});

// --- Follow-ups: status changes, late price tables, the age bound, the tick budget ----------------------

const put = (key: string, meta: Record<string, string> = {}) =>
  env.STORE.put(at(key), `<p>${key}</p>`, { customMetadata: { headers: "{}", ...meta } });

describe("stored screens follow status changes and late price tables", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("the health step moving a page to failed drops its view and the watchlist screens", async () => {
    await insertPage(db, page("beta"));
    await version("b-1", "beta", ago(3 * HOUR), "create");
    for (const key of ["page/beta", "page/other", "watchlist", "home", "about"]) await put(key);
    vi.spyOn(cronDeps, "rebuild").mockResolvedValue(new Response("{}"));
    fetchMock.activate();
    fetchMock.intercept({
      method: "GET",
      url: "https://agent.tinyfish.ai/v1/monitors",
      times: Infinity,
      reply: { json: { monitors: [{ id: "mon-beta", status: "paused", name: "beta" }, { id: "mon-alpha", status: "active", name: "alpha" }] } },
    });
    try {
      const result = await runCron(cacheOn);
      expect(result.unhealthy).toEqual(["beta"]);
    } finally {
      fetchMock.reset();
    }
    const rest = await left();
    for (const key of ["page/beta", "watchlist"]) expect(rest).not.toContain(key);
    expect(rest).toContain("page/other");
  });

  it("a price table that lands late drops the page's view and compares", async () => {
    await insertPage(db, page("gamma"));
    const facts = (price: string) => JSON.stringify([{ name: "Pro", price, unit: "per month", notes: null }]);
    await version("g-1", "gamma", ago(3 * HOUR), "create", { facts_json: facts("$1") });
    await version("g-2", "gamma", ago(2 * HOUR), "webhook", {
      facts_json: facts("$2"),
      summary: "Price changed.",
      summary_source: "diff",
      delta_json: JSON.stringify({ blocks: { added: 0, removed: 0, changed: 1 }, facts: null, layout_only: false }),
    });
    for (const key of ["page/gamma", "compare/gamma/g-1/g-2", "page/alpha", "home"]) await put(key);
    const answer = await fillDeltas(cacheOn);
    expect(answer.facts_filled).toBe(1);
    const rest = await left();
    for (const key of ["page/gamma", "compare/gamma/g-1/g-2", "home"]) expect(rest).not.toContain(key);
    expect(rest).toContain("page/alpha");
  });

  it("a copy older than a day is a miss that is served and stored again", async () => {
    await put("about", { at: String(Date.now() - 25 * HOUR) });
    const stale = await callWorker("/about");
    expect(stale.headers.get("x-fineprint-cache")).toBe("miss");
    expect(await stale.text()).toContain("<html");
    const again = await callWorker("/about");
    expect(again.headers.get("x-fineprint-cache")).toBe("hit");
    expect(Number((await env.STORE.head(at("about")))?.customMetadata?.at)).toBeGreaterThan(Date.now() - HOUR);
    await put("about", { at: String(Date.now() - 23 * HOUR) });
    expect((await callWorker("/about")).headers.get("x-fineprint-cache")).toBe("hit");
  });

  it("a tick that has already made many invocations rebuilds only the three fixed screens", async () => {
    const asked: string[] = [];
    vi.spyOn(cronDeps, "rebuild").mockImplementation(async (_env: unknown, key: string) => (asked.push(key), new Response("{}")));
    const realFill = summaryDeps.fill;
    // alpha has versions without a summary, so the tick asks for a fill; this one makes 13 calls of its own.
    summaryDeps.fill = async (e) => {
      for (let i = 0; i < 13; i++) await (await e.SELF.fetch("https://fineprint.internal/api/stats")).arrayBuffer();
      return new Response("{}");
    };
    fetchMock.activate();
    fetchMock.intercept({ method: "GET", url: "https://agent.tinyfish.ai/v1/monitors", times: Infinity, reply: { json: { monitors: [] } } });
    try {
      await runCron(cacheOn);
    } finally {
      summaryDeps.fill = realFill;
      fetchMock.reset();
    }
    expect(asked).toEqual(["home", "about", "watchlist"]);
  });
});

// --- The deploy stamp ------------------------------------------------------------------------------------

/** The Worker as another deploy (another version id) would run it, with the stored copy on. */
const asDeploy = (id: string) => ({ ...cacheOn, CF_VERSION_METADATA: { id, tag: "", timestamp: "" } });

/** `path` may be a full url, for a request that reaches the Worker on another host (a preview URL). */
async function callAs(id: string, path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(new URL(path, "https://fineprint.test"), init), asDeploy(id), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Every key in the bucket, sorted. */
async function everything(): Promise<string[]> {
  return (await env.STORE.list()).objects.map((o) => o.key).sort();
}

/** A version source, as captureSource stores it: html/<versionId>.html. */
const SOURCE = "html/0d6f1c1e-6b5a-4d3c-9a8b-7c6d5e4f3a2b.html";

describe("stored screens are keyed by the deploy", () => {
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await env.STORE.put(SOURCE, "<p>the page as it was read</p>", { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps each copy under screens/<version id>/<key>, so a new deploy never serves an older deploy's markup", async () => {
    expect(STAMP).toBe(env.CF_VERSION_METADATA.id);
    const first = await callAs("deploy-a", "/about");
    expect(first.headers.get("x-fineprint-cache")).toBe("miss");
    await first.text();
    expect(await env.STORE.head("screens/deploy-a/about")).not.toBeNull();
    expect((await callAs("deploy-a", "/about")).headers.get("x-fineprint-cache")).toBe("hit");
    // The next deploy renders its own copy, and the old one is not read.
    await env.STORE.put("screens/deploy-a/about", "<p>old markup</p>", { customMetadata: { headers: "{}", at: String(Date.now()) } });
    const next = await callAs("deploy-b", "/about");
    expect(next.headers.get("x-fineprint-cache")).toBe("miss");
    expect(await next.text()).not.toContain("old markup");
    expect((await callAs("deploy-b", "/about")).headers.get("x-fineprint-cache")).toBe("hit");
    // Nothing is written under html/ any more.
    expect((await everything()).filter((k) => k.startsWith("html/"))).toEqual([SOURCE]);
  });

  it("the clean-up after a deploy deletes the previous stamp's copies by listing that stamp, and never the current one's", async () => {
    await env.STORE.put("screens/stamp", "deploy-a");
    for (const key of ["home", "page/alpha", "compare/alpha/a-2/a-3"]) await env.STORE.put(`screens/deploy-a/${key}`, "<p>a</p>");
    for (const key of ["home", "about"]) await env.STORE.put(`screens/deploy-b/${key}`, "<p>b</p>");
    const first = await callAs("deploy-b", "/api/admin/sweep-screens", { method: "POST", headers: ADMIN });
    expect(await first.json()).toEqual({ stamp: "deploy-b", previous: "deploy-a", deleted: 3, done: true });
    expect(await everything()).toEqual([SOURCE, "screens/deploy-b/about", "screens/deploy-b/home", "screens/stamp"].sort());
    expect(await (await env.STORE.get("screens/stamp"))!.text()).toBe("deploy-b");
    // Once the marker is this deploy's, a sweep deletes nothing, this deploy's copies least of all.
    const again = await callAs("deploy-b", "/api/admin/sweep-screens", { method: "POST", headers: ADMIN });
    expect(await again.json()).toEqual({ stamp: "deploy-b", previous: "deploy-b", deleted: 0, done: true });
    expect(await everything()).toContain("screens/deploy-b/home");
  });

  it("the first clean-up deletes the copies kept under html/ by name, once, and the version sources survive", async () => {
    await insertPage(db, page("beta"));
    const legacy = ["home", "about", "watchlist", "page/alpha", "page/beta", "compare/alpha/a-1/a-2", "compare/alpha/a-2/a-3", "compare/beta/b-1/b-2"];
    for (const key of legacy) await env.STORE.put(`html/${key}`, `<p>${key}</p>`);
    // Not a page in D1: not named, so not deleted.
    await env.STORE.put("html/page/ghost", "<p>ghost</p>");
    const list = vi.spyOn(env.STORE, "list");
    const res = await callAs("deploy-a", "/api/admin/sweep-screens", { method: "POST", headers: ADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stamp: "deploy-a", previous: null, done: true });
    // Only each page's own compares were listed.
    expect(list.mock.calls.map(([o]) => o?.prefix).sort()).toEqual(["html/compare/alpha/", "html/compare/beta/"]);
    list.mockRestore();
    expect(await everything()).toEqual([SOURCE, "html/page/ghost", "screens/stamp"].sort());
    // Never again: a later sweep for the same deploy, or the next deploy's, leaves html/ alone.
    await env.STORE.put("html/home", "<p>home</p>");
    await callAs("deploy-a", "/api/admin/sweep-screens", { method: "POST", headers: ADMIN });
    await callAs("deploy-b", "/api/admin/sweep-screens", { method: "POST", headers: ADMIN });
    expect(await everything()).toContain("html/home");
    expect(await everything()).toContain(SOURCE);
  });

  it("the sweep answers only on production's own hosts: a preview URL is refused, the SELF binding and PUBLIC_BASE_URL are not", async () => {
    // Production's stamp is in the marker and its copies are stored; a preview runs another version (another stamp).
    await env.STORE.put("screens/stamp", "deploy-prod");
    await env.STORE.put("screens/deploy-prod/home", "<p>production</p>");
    for (const url of ["https://abc123-fineprint.example.workers.dev/api/admin/sweep-screens", "https://preview.example/api/admin/sweep-screens"]) {
      const refused = await callAs("deploy-preview", url, { method: "POST", headers: ADMIN });
      expect(refused.status, url).toBe(403);
      expect(await refused.json()).toEqual({ error: "not_production" });
    }
    expect(await env.STORE.head("screens/deploy-prod/home")).not.toBeNull();
    expect(await (await env.STORE.get("screens/stamp"))!.text()).toBe("deploy-prod");
    // Without the token it is still a 401 first, whatever the host.
    expect((await callAs("deploy-preview", "https://preview.example/api/admin/sweep-screens", { method: "POST" })).status).toBe(401);
    // Through the SELF binding (the hourly job's own call) it runs, as the deployed version.
    const viaSelf = await env.SELF.fetch("https://fineprint.internal/api/admin/sweep-screens", { method: "POST", headers: ADMIN });
    expect(viaSelf.status).toBe(200);
    expect(await viaSelf.json()).toMatchObject({ stamp: STAMP, previous: "deploy-prod", done: true });
    // And on PUBLIC_BASE_URL's host (https://fineprint.test in the tests).
    expect((await callAs("deploy-next", "https://fineprint.test/api/admin/sweep-screens", { method: "POST", headers: ADMIN })).status).toBe(200);
  });

  it("a rebuild on a preview URL writes only under the preview's own stamp, never production's copies", async () => {
    await env.STORE.put("screens/deploy-prod/about", "<p>production</p>", { customMetadata: { headers: "{}", at: String(Date.now()) } });
    const res = await callAs("deploy-preview", "https://preview.example/api/admin/rebuild-html?key=about", { method: "POST", headers: ADMIN });
    expect(await res.json()).toEqual({ key: "about", stored: true });
    expect(await env.STORE.head("screens/deploy-preview/about")).not.toBeNull();
    expect(await (await env.STORE.get("screens/deploy-prod/about"))!.text()).toBe("<p>production</p>");
  });

  it("the html/ clean-up takes at most 20 page ids a call, resumes on the next, and each call stays far inside 50 subrequests", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      const id = `p-${String(i).padStart(2, "0")}`;
      ids.push(id);
      await insertPage(db, { ...page(id), url: `https://example.com/many/${id}` });
      await env.STORE.put(`html/page/${id}`, "<p>old</p>");
      await env.STORE.put(`html/compare/${id}/x/y`, "<p>old</p>");
    }
    for (const key of ["home", "about", "watchlist"]) await env.STORE.put(`html/${key}`, "<p>old</p>");
    const legacyLeft = async () => (await everything()).filter((k) => k.startsWith("html/") && k !== SOURCE).length;
    expect(await legacyLeft()).toBe(3 + 45 * 2);
    const answers: { done: boolean }[] = [];
    for (let call = 0; call < 4; call++) {
      const counts = (["get", "put", "list", "delete", "head"] as const).map((m) => vi.spyOn(env.STORE, m));
      const queries = vi.spyOn(db, "prepare");
      const res = await callAs("deploy-a", "/api/admin/sweep-screens", { method: "POST", headers: ADMIN });
      answers.push((await res.json()) as { done: boolean });
      const used = counts.reduce((n, spy) => n + spy.mock.calls.length, 0) + queries.mock.calls.length;
      for (const spy of [...counts, queries]) spy.mockRestore();
      expect(used, `call ${call + 1}`).toBeLessThanOrEqual(30);
      if (answers.at(-1)!.done) break;
    }
    // alpha (from beforeEach) and the 45: 46 page ids, so three calls of at most 20.
    expect(answers.map((a) => a.done)).toEqual([false, false, true]);
    expect((await everything()).filter((k) => k.startsWith("html/"))).toEqual([SOURCE]);
    expect(await (await env.STORE.get("screens/stamp"))!.text()).toBe("deploy-a");
  });

  it("a deploy in the middle of the html/ clean-up finishes it, then takes the earlier deploy's copies", async () => {
    for (let i = 0; i < 25; i++) await insertPage(db, { ...page(`q-${String(i).padStart(2, "0")}`), url: `https://example.com/q/${i}` });
    await env.STORE.put("screens/deploy-a/home", "<p>a</p>");
    expect(await (await callAs("deploy-a", "/api/admin/sweep-screens", { method: "POST", headers: ADMIN })).json()).toMatchObject({ done: false });
    // The next deploy goes on from where the clean-up stopped, then names the stamp it began under.
    expect(await (await callAs("deploy-b", "/api/admin/sweep-screens", { method: "POST", headers: ADMIN })).json()).toMatchObject({ done: false });
    expect(await (await env.STORE.get("screens/stamp"))!.text()).toBe("deploy-a");
    expect(await (await callAs("deploy-b", "/api/admin/sweep-screens", { method: "POST", headers: ADMIN })).json()).toMatchObject({
      previous: "deploy-a",
      done: true,
    });
    expect(await env.STORE.head("screens/deploy-a/home")).toBeNull();
  });

  it("the sweep needs the admin token", async () => {
    await env.STORE.put("html/home", "<p>home</p>");
    const res = await callAs("deploy-a", "/api/admin/sweep-screens", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await everything()).toContain("html/home");
    expect(await env.STORE.head("screens/stamp")).toBeNull();
  });

  it("the hourly tick asks for the clean-up first, and only when the stamp it last cleaned up for is not its own", async () => {
    const order: string[] = [];
    vi.spyOn(cronDeps, "rebuild").mockImplementation(async (_env, key) => (order.push(key), new Response("{}")));
    await env.STORE.put("screens/stamp", "deploy-old");
    await env.STORE.put("screens/deploy-old/home", "<p>old</p>");
    await env.STORE.put(at("page/other"), "<p>current</p>");
    await runCron(cacheOn); // the real clean-up, through the SELF binding, as an invocation of its own
    expect(order.slice(0, 3)).toEqual(["home", "about", "watchlist"]);
    expect(await env.STORE.head("screens/deploy-old/home")).toBeNull();
    expect(await env.STORE.head(at("page/other"))).not.toBeNull();
    expect(await (await env.STORE.get("screens/stamp"))!.text()).toBe(STAMP);

    const sweep = vi.spyOn(cronDeps, "sweep");
    await runCron(cacheOn);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("the clean-up's own invocation counts towards a busy tick", async () => {
    const asked: string[] = [];
    vi.spyOn(cronDeps, "rebuild").mockImplementation(async (_env, key) => (asked.push(key), new Response("{}")));
    // The clean-up's call goes through the tick's SELF binding, as the real one does.
    vi.spyOn(cronDeps, "sweep").mockImplementation(async (e) => {
      await (await e.SELF.fetch("https://fineprint.internal/api/stats")).arrayBuffer();
      return Response.json({ stamp: STAMP, previous: null, deleted: 0, done: true });
    });
    // No other call goes through the binding: the pull and the delta fill answer here.
    vi.spyOn(cronDeps, "pull").mockResolvedValue(Response.json({ ok: true, pulled: false, reason: "x" }));
    vi.spyOn(summaryDeps, "fillDeltas").mockResolvedValue(new Response("{}"));
    const realFill = summaryDeps.fill;
    // Exactly the busy line's worth of calls before the last step: the clean-up's makes it a busy tick.
    summaryDeps.fill = async (e) => {
      for (let i = 0; i < REBUILD_BUSY_TICK_CALLS; i++) await (await e.SELF.fetch("https://fineprint.internal/api/stats")).arrayBuffer();
      return new Response("{}");
    };
    fetchMock.activate();
    fetchMock.intercept({ method: "GET", url: "https://agent.tinyfish.ai/v1/monitors", times: Infinity, reply: { json: { monitors: [] } } });
    try {
      await runCron(cacheOn);
    } finally {
      summaryDeps.fill = realFill;
      fetchMock.reset();
    }
    expect(asked).toEqual(["home", "about", "watchlist"]);
  });

  it("a failed clean-up is logged, the rebuilds still run, and the next tick asks again", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const asked: string[] = [];
    vi.spyOn(cronDeps, "rebuild").mockImplementation(async (_env, key) => (asked.push(key), new Response("{}")));
    const sweep = vi.spyOn(cronDeps, "sweep").mockResolvedValue(new Response("no", { status: 500 }));
    await runCron(cacheOn);
    expect(asked.slice(0, 3)).toEqual(["home", "about", "watchlist"]);
    await runCron(cacheOn);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith("stored screens clean-up failed", "status=500");
  });
});

describe("the guard on every delete", () => {
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await env.STORE.put(SOURCE, "<p>the page as it was read</p>");
  });
  afterEach(() => vi.restoreAllMocks());

  it("names only the five screen shapes as stored screens, never a version source or a broad prefix", () => {
    const screens = [
      "screens/x/home",
      "screens/x/about",
      "screens/x/watchlist",
      "screens/x/page/p",
      "screens/x/compare/p/a/b",
      "html/home",
      "html/page/p",
      "html/compare/p/a/b",
    ];
    for (const key of screens) expect(isStoredScreen(key), key).toBe(true);
    const others = [
      SOURCE,
      "html/abc.html",
      "html/home.html",
      "html/",
      "html/page",
      "html/page/",
      "html/page/a/b",
      "html/compare/p/a",
      "html/../html/x.html",
      "screens/stamp",
      "screens/x/",
      "screens/x/x.html",
      "screens/x/page/../a",
      "shots/a.jpg",
      "home",
    ];
    for (const key of others) expect(isStoredScreen(key), key).toBe(false);
    const now = asDeploy("deploy-now");
    for (const prefix of ["screens/deploy-now/compare/p/", "screens/old/compare/p/", "screens/old/", "html/compare/p/"]) {
      expect(isScreenListing(now, prefix), prefix).toBe(true);
    }
    const broad = ["", "html/", "html", "html/compare/", "html/compare/p", "html/page/", "screens/", "screens/deploy-now/", "screens/old/page/", "screens/../html/", "html/compare/../", "shots/"];
    for (const prefix of broad) expect(isScreenListing(now, prefix), prefix).toBe(false);
  });

  it("a seeded version source survives every invalidation and the clean-up", async () => {
    await insertPage(db, page("beta"));
    const list = vi.spyOn(env.STORE, "list");
    const del = vi.spyOn(env.STORE, "delete");
    const id = SOURCE.slice("html/".length, -".html".length);
    // Keys a caller could pass that name the source, whatever the stamp prefix.
    await dropCached(cacheOn, [`${id}.html`, `../../html/${id}.html`, `page/../../../html/${id}.html`, "../stamp"]);
    await dropCachedPages(cacheOn, ["alpha", `../../html/${id}.html`, "..", ""]);
    await dropCachedWatchlist(cacheOn, `../../../html/${id}.html`);
    await env.STORE.put("html/home", "<p>legacy</p>");
    await sweepStoredScreens(asDeploy("deploy-a"), async () => ["alpha", "beta", `${id}.html`, "../..", ""]);
    await sweepStoredScreens(asDeploy("deploy-b"), async () => ["alpha"]);
    expect(await env.STORE.head(SOURCE)).not.toBeNull();
    expect(await env.STORE.head("html/home")).toBeNull();
    // No listing reached past one page's compares or an earlier stamp, and nothing deleted was anything but a stored screen.
    for (const [options] of list.mock.calls) expect(isScreenListing(asDeploy("deploy-b"), options?.prefix ?? ""), options?.prefix).toBe(true);
    for (const [keys] of del.mock.calls) for (const key of [keys].flat()) expect(isStoredScreen(key), key).toBe(true);
    expect(await (await env.STORE.get("screens/stamp"))!.text()).toBe("deploy-b");
  });

  it("the cron's paths keep the source too: the summary fill, a status change, a tick after a deploy", async () => {
    await env.STORE.put("screens/stamp", "deploy-old");
    await version("a-4", "alpha", ago(60_000), "webhook");
    await fillSummaries(cacheOn, { versionId: "a-4" });
    vi.spyOn(cronDeps, "rebuild").mockResolvedValue(new Response("{}"));
    fetchMock.activate();
    fetchMock.intercept({
      method: "GET",
      url: "https://agent.tinyfish.ai/v1/monitors",
      times: Infinity,
      reply: { json: { monitors: [{ id: "mon-alpha", status: "paused", name: "alpha" }] } },
    });
    try {
      expect((await runCron(cacheOn)).unhealthy).toEqual(["alpha"]);
    } finally {
      fetchMock.reset();
    }
    expect(await env.STORE.head(SOURCE)).not.toBeNull();
    expect(await (await env.STORE.get("screens/stamp"))!.text()).toBe(STAMP);
  });
});
