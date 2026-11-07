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
import { REBUILD_CALLS_PER_TICK } from "../src/core/limits";
import { cacheKey, dropCached } from "../src/site/htmlCache";
import worker from "../src/index";

// The stored copy of the likely screens (src/site/htmlCache.ts): the first answer is a miss that stores
// html/<key>, the next is a hit with the same body and headers, and every screen with a varying query
// parameter, every 404 and every screen that still refreshes itself is never stored.

// Each test renders several screens, which the suite running in parallel can slow past the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

const db = env.DB;
const cacheOn = { ...env, HTML_CACHE: "1" };

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

/** The keys under html/ that the cache wrote (the recorded sources are html/<id>.html and are not its). */
async function stored(): Promise<string[]> {
  const listed = await env.STORE.list({ prefix: "html/" });
  return listed.objects.map((o) => o.key.slice("html/".length)).filter((k) => !k.endsWith(".html"));
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
  it("serves the home screen: a miss stores html/home, the next is the same response", async () => {
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
  for (const key of ALL_KEYS) await env.STORE.put(`html/${key}`, `<p>${key}</p>`, { customMetadata: { headers: "{}" } });
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
    await env.STORE.put("html/page/old", "<p>old</p>");
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
    await env.STORE.put("html/page/alpha", "stale", { customMetadata: { headers: "{}" } });
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
    await env.STORE.put("html/about", "<p>kept</p>", { customMetadata: { headers: "{}" } });
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
  env.STORE.put(`html/${key}`, `<p>${key}</p>`, { customMetadata: { headers: "{}", ...meta } });

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
    expect(Number((await env.STORE.head("html/about"))?.customMetadata?.at)).toBeGreaterThan(Date.now() - HOUR);
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
