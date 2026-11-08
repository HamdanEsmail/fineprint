import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps } from "../src/capture";
import { DISCOVER_PER_IP_PER_DAY, MAX_URL_LENGTH, SPEND_PAUSE_USD } from "../src/core/limits";
import { hashText } from "../src/core/normalize";
import { getPage, insertPage, type NewPage } from "../src/db/pages";
import { publicAddsToday } from "../src/db/publicAdds";
import { insertRun } from "../src/db/runs";
import type { RunRow } from "../src/db/types";
import { insertVersion } from "../src/db/versions";
import type { Env } from "../src/env";
import worker from "../src/index";
import { formatUtc } from "../src/site/format";
import { addErrorCopy } from "../src/site/views/watchlist";
import { fetchMock } from "./helpers/fetch-mock";
import fetchFixture from "./fixtures/tinyfish/fetch.json";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";

// The watchlist (GET /watchlist with domain=, url= and label=; POST /watchlist): every page and how it is
// watched, the pages no longer watched, the public add form with its slots and its refusals, and discover.
// The form and the search call the same addPage and discover as POST /api/pages and POST /api/discover, so
// a visitor meets the same caps, the same daily limits and the same refusals on both.

const db = env.DB;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const FETCH_API = "https://api.fetch.tinyfish.ai";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const SECRET = "test-secret";
const XSS = "<script>alert(1)</script>";

const SLOTS_LINE = "4 of 4 public slots are free.";
const TERMS_LINE = "Fineprint will watch this page twice a day for 7 days.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// Work the Worker handed to waitUntil (a successful add's baseline capture), awaited before a call returns.
let scheduled: Promise<unknown>[] = [];

async function call(path: string, init: RequestInit = {}, over: Partial<Env> = {}): Promise<Response> {
  const ctx = { waitUntil: (work: Promise<unknown>) => void scheduled.push(work), passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(new URL(path, "https://fineprint.test").href, init), { ...env, ...over } as Env, ctx);
  await Promise.allSettled(scheduled);
  return res;
}

const from = (ip: string): Record<string, string> => ({ "CF-Connecting-IP": ip });

async function get(path: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await call(path, { headers });
  expect(res.status, path).toBe(200);
  return res.text();
}

function post(fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return call("/watchlist", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function postJsonApi(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return call("/api/pages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/** The page id a successful add redirected to (`/pages/<id>#version`). */
const pageIdOf = (res: Response): string => (res.headers.get("location") ?? "").replace(/^\/pages\//, "").replace(/#.*$/, "");

/** Total spend at the pause line: nothing that costs money starts. */
async function pauseSpend(): Promise<void> {
  await db.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('s-pause', 'monitor_check', ?, 'x', ?)").bind(SPEND_PAUSE_USD, new Date().toISOString()).run();
}

const monitorCreateCalls = (): number => fetchMock.calls.filter((c) => c.method === "POST" && c.url === new URL(MONITORS_API).href).length;
const searchCalls = (): number => fetchMock.calls.filter((c) => new URL(c.url).hostname === "api.search.tinyfish.ai").length;
const discoverKey = async (ip: string): Promise<string> => "discover:" + (await hashText(ip + SECRET));

let monitorSeq = 0;

/** TinyFetch reads any url but walled.example (login_required); a Monitor create gets mon-N; deletes are answered. */
function mockTinyFish(): void {
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const url = ((body as { urls?: string[] }).urls ?? [])[0] ?? "";
      if (url.includes("walled.example")) return Response.json({ results: [], errors: [{ url, error: "login_required" }] });
      return Response.json(fetchFixture);
    },
  });
  fetchMock.intercept({
    method: "POST",
    url: MONITORS_API,
    times: Infinity,
    reply: () => {
      const body = structuredClone(monitorCreate);
      body.monitor.id = `mon-${++monitorSeq}`;
      body.run.id = `mrun-${monitorSeq}`;
      return Response.json(body, { status: 201 });
    },
  });
  fetchMock.intercept({ method: "DELETE", url: /\/v1\/monitors\/mon-\d+$/, times: Infinity, reply: { status: 204 } });
}

const searchHit = (url: string, title: string, snippet: string) => ({ position: 1, site_name: "example.com", snippet, title, url });

/** The four TinySearch queries for example.com: three distinct urls, one of them already watched (seeded by the test). */
function mockSearch(): void {
  const answer = (query: string, results: unknown[]) =>
    fetchMock.intercept({
      method: "GET",
      url: new RegExp(`^https://api\\.search\\.tinyfish\\.ai/\\?query=${query}&include_domains=example\\.com&`),
      times: Infinity,
      reply: { json: { query, results, total_results: results.length, page: 0 } },
    });
  answer("pricing\\+plans", [searchHit("https://example.com/pricing", "Example pricing", "Plans from $5 a month, billed yearly.")]);
  answer("terms\\+of\\+service", [searchHit("https://example.com/terms", `Terms ${XSS}`, `Read these terms ${XSS} first.`)]);
  answer("privacy\\+policy", []);
  answer("fees\\+and\\+charges", [searchHit("https://example.com/fees", "Example fees", "Every fee we charge.")]);
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

async function version(id: string, pageId: string, at: string, baseline: boolean): Promise<void> {
  await insertRun(db, run(`run-${id}`, pageId, at, { outcome: baseline ? "baseline" : "changed", is_baseline: baseline ? 1 : 0, trigger_kind: baseline ? "create" : "webhook" }));
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
  });
}

/** Four public pages holding every slot; the earliest frees in two days. */
async function fillPublicSlots(): Promise<string> {
  const soonest = ago(-2 * DAY);
  const expiries = [ago(-5 * DAY), soonest, ago(-6 * DAY), ago(-3 * DAY)];
  for (const [i, expires_at] of expiries.entries()) {
    await insertPage(db, page(`pub${i}`, { added_by: "public", kind: "other", expires_at, label: `Public page ${i}` }));
  }
  return soonest;
}

/** The part of a screen from `start` (an id or a heading's text) to the next section, for asserting what sits where. */
function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start, id).toBeGreaterThan(-1);
  const end = html.indexOf("<section", start);
  return html.slice(start, end === -1 ? undefined : end);
}

let shot: MockInstance<typeof captureDeps.screenshotFullPage>;

beforeEach(async () => {
  monitorSeq = 0;
  scheduled = [];
  fetchMock.activate();
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
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
  vi.restoreAllMocks();
});

// --- The lists --------------------------------------------------------------------------------------

describe("the watchlist", () => {
  it("lists every watched page in a table, and the pages no longer watched under #retired with their chip and line", async () => {
    await insertPage(db, page("vercel", { label: "Vercel pricing", url: "https://vercel.com/pricing" }));
    await version("v-base", "vercel", ago(4 * DAY), true);
    await version("v-1", "vercel", ago(2 * DAY), false);
    await version("v-2", "vercel", ago(1 * DAY), false);
    for (let i = 0; i < 3; i++) await insertRun(db, run(`noise-${i}`, "vercel", ago((3 - i * 0.5) * DAY), { outcome: "changed", noise_suppressed: 1, noise_reason: "flap" }));
    const lastRun = ago(6 * HOUR);
    const lastChange = ago(1 * DAY);
    await db.prepare("UPDATE pages SET last_run_at = ?, last_change_at = ? WHERE id = 'vercel'").bind(lastRun, lastChange).run();
    await insertPage(db, page("terms", { label: "Example terms", kind: "policy", status: "paused" }));
    await insertPage(db, page("broken", { label: "Broken fees", kind: "fees", status: "failed" }));
    await insertPage(db, page("visitor", { label: XSS, kind: "other", added_by: "public", expires_at: ago(-5 * DAY) }));
    await insertPage(db, page("gone-airline", { label: "Gone airline fees", status: "retired", monitor_id: null }));
    await version("g-base", "gone-airline", ago(9 * DAY), true);
    await insertPage(db, page("old-visitor", { label: "Old visitor page", kind: "other", status: "expired", added_by: "public", expires_at: ago(2 * DAY), monitor_id: null }));

    const html = await get("/watchlist");
    expect(html).toContain("<h1>Watchlist</h1>");
    // One public page holds a slot.
    expect(html).toContain("3 of 4 public slots are free.");
    expect(html).toContain(TERMS_LINE);
    expect(html).toMatch(/No longer watched[\s\S]*Retired/);

    const watching = sectionOf(html, "watching");
    expect(watching).toContain('<a href="/pages/vercel">Vercel pricing</a>');
    expect(watching).toContain("vercel.com/pricing");
    expect(watching).toContain('<span class="wl-freq">Twice a day</span><span class="wl-at">02:14 and 14:14 UTC</span>');
    // Each time in words, its date and its clock kept whole.
    const [runDay, runClock] = formatUtc(lastRun).split(", ");
    expect(watching).toContain(`<time datetime="${lastRun}"><span class="wl-d">${runDay},</span> <span class="wl-d">${runClock}</span></time>`);
    expect(watching).toContain(`<time class="is-change" datetime="${lastChange}">`);
    expect(watching).toMatch(/data-label="Versions">3</);
    expect(watching).toMatch(/data-label="Noise">3</);
    for (const chip of ["Active", "Paused", "Failed"]) expect(watching).toContain(chip);
    expect(watching).toContain("Checks are paused");
    expect(watching).toContain("Not checked yet");
    // The visitor's page, its label escaped, with the week it is watched for.
    expect(watching).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain(XSS);
    expect(watching).toContain("Public until");
    // Nothing that is no longer watched sits in the watched table.
    expect(watching).not.toContain("Gone airline fees");
    expect(watching).not.toContain("Old visitor page");

    const retired = sectionOf(html, "retired");
    expect(retired).toContain("No longer watched");
    expect(retired).toContain('<a href="/pages/gone-airline">Gone airline fees</a>');
    expect(retired).toContain("Retired");
    expect(retired).toContain("No longer watched. Its history is kept.");
    expect(retired).toContain('<a href="/pages/old-visitor">Old visitor page</a>');
    expect(retired).toContain("Expired");
    expect(retired).toContain("Watched for 7 days as a public page. Its history is kept.");
    // A page no longer watched is never shown with a schedule, nor offered to be added again.
    expect(retired).not.toMatch(/twice a day/i);
    expect(retired).not.toContain("Watch this page");
  });

  it("says so when nothing is watched yet, and leaves the retired section out when there is none", async () => {
    const html = await get("/watchlist");
    expect(html).toContain(SLOTS_LINE);
    expect(html).toContain("No page is watched yet.");
    expect(html).not.toContain('id="retired"');
  });

  it("counts only the pages watched now in its lede, and says how many are paused with their history kept", async () => {
    await insertPage(db, page("live", { label: "Live pricing" }));
    await insertPage(db, page("held-1", { label: "Held terms", kind: "policy", status: "paused" }));
    await insertPage(db, page("held-2", { label: "Held fees", kind: "fees", status: "paused" }));
    const lede = async (): Promise<string> => {
      const html = await get("/watchlist");
      const start = html.indexOf('<p class="lede">');
      expect(start).toBeGreaterThan(-1);
      const p = html.slice(start, html.indexOf("</p>", start));
      // The add link stays as it was.
      expect(p).toContain('<a href="#add">Add a page of your own</a>');
      return p.replace(/<[^>]+>/g, "");
    };

    expect(await lede()).toBe(
      "One page is watched now, each read by TinyFish Monitor on its own schedule. 2 pages are paused, their history kept. Add a page of your own for 7 days.",
    );
    // The paused pages keep their rows in the watched table, with their chip and line.
    const html = await get("/watchlist");
    const watching = sectionOf(html, "watching");
    expect(watching).toContain('<a href="/pages/held-1">Held terms</a>');
    expect(watching).toContain("Checks are paused");
    expect(html).toContain('content="The 1 page Fineprint watches, how often each is read');

    await db.prepare("UPDATE pages SET status = 'retired' WHERE id = 'held-2'").run();
    expect(await lede()).toBe(
      "One page is watched now, each read by TinyFish Monitor on its own schedule. One page is paused, its history kept. Add a page of your own for 7 days.",
    );

    await db.prepare("UPDATE pages SET status = 'expired' WHERE id = 'live'").run();
    expect(await lede()).toBe("No page is watched now. One page is paused, its history kept. Add a page of your own for 7 days.");

    await db.prepare("UPDATE pages SET status = 'retired' WHERE id = 'held-1'").run();
    expect(await lede()).toBe("No page is watched now. Add a page of your own for 7 days.");
  });

  it("is a plain 404 with the site off, for GET and POST alike, and reads nothing", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");
    for (const init of [{}, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "url=https%3A%2F%2Fexample.com%2F" }]) {
      const res = await call("/watchlist", init, { SITE_ENABLED: "0" });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("404 Not Found");
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(fetchMock.calls).toEqual([]);
  });
});

// --- Adding a page --------------------------------------------------------------------------------

describe("adding a page from the watchlist", () => {
  it("adds a page with a 303 to its history; a refusal comes back with the JSON route's status, the reason and the typed url", async () => {
    mockTinyFish();
    const html = await get("/watchlist");
    expect(html).toContain(SLOTS_LINE);
    expect(html).toContain(TERMS_LINE);
    expect(html).toMatch(/<form[^>]+method="post"[^>]+action="\/watchlist#add"/);

    const ok = await post({ url: "https://example.com/pricing" }, from("203.0.113.1"));
    expect(ok.status).toBe(303);
    // Straight to the new page's version card, whatever fragment the form was posted from.
    expect(ok.headers.get("location")).toMatch(/^\/pages\/[0-9a-f-]{36}#version$/);
    const added = (await getPage(db, pageIdOf(ok)))!;
    expect(added).toMatchObject({ url: "https://example.com/pricing", added_by: "public", kind: "other", status: "active" });
    expect(added.expires_at).not.toBeNull();
    expect(monitorCreateCalls()).toBe(1);

    // What POST /api/pages answers for the same refusal (another visitor, so the daily add is not what refuses).
    const json = await postJsonApi({ url: "https://walled.example/terms" }, from("203.0.113.3"));
    expect(await json.json()).toEqual({ error: "unfetchable", reason: "login_required" });

    const walled = await post({ url: "https://walled.example/terms" }, from("203.0.113.2"));
    expect(walled.status).toBe(json.status);
    expect(walled.headers.get("content-type")).toContain("text/html");
    const body = await walled.text();
    expect(body).toContain("That page needs a login, so it cannot be watched.");
    expect(body).toContain('value="https://walled.example/terms"');
    expect(body).toMatch(/<input[^>]+name="url"[^>]+aria-invalid="true"/);
    expect(monitorCreateCalls()).toBe(1); // only the successful add above
    // A refused add gives the visitor's daily add back.
    expect(await publicAddsToday(db, await hashText("203.0.113.2" + SECRET))).toBe(0);

    const limited = await post({ url: "https://example.org/fees" }, from("203.0.113.1"));
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("One public page per visitor per day. Come back tomorrow.");
    expect(monitorCreateCalls()).toBe(1);
  });

  it("disables the form when every public slot is taken, and a post then is refused with 409 before any TinyFish call", async () => {
    const soonest = await fillPublicSlots();
    const fullHtml = await get("/watchlist");
    const line = `All 4 public slots are in use. The next one frees on ${formatUtc(soonest)}.`;
    expect(fullHtml).toContain(line);
    expect(fullHtml).toMatch(/<input[^>]+name="url"[^>]+disabled/);
    expect(fullHtml).toMatch(/<button[^>]+type="submit"[^>]+disabled[^>]*>Start watching/);
    expect(fullHtml).not.toContain("public slots are free.");

    const res = await post({ url: "https://example.com/pricing" }, from("203.0.113.40"));
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain(line);
    expect(html).toContain('value="https://example.com/pricing"');
    expect(fetchMock.calls).toEqual([]);
  });

  it("says when a slot is overdue to free that it frees within the hour", async () => {
    await fillPublicSlots();
    await db.prepare("UPDATE pages SET expires_at = ? WHERE id = 'pub0'").bind(ago(10 * 60_000)).run();
    expect(await get("/watchlist")).toContain("All 4 public slots are in use. The next one frees within the hour.");
  });

  it("refuses a page Fineprint already has, with a link to it; one no longer watched is not said to be watched", async () => {
    await insertPage(db, page("watched", { url: "https://example.com/watched", label: "Watched page" }));
    await insertPage(db, page("expired", { url: "https://example.com/expired", status: "expired", added_by: "public", monitor_id: null }));

    const dup = await post({ url: "https://EXAMPLE.com/watched#top" }, from("203.0.113.50"));
    expect(dup.status).toBe(409);
    const dupHtml = await dup.text();
    const dupAdd = sectionOf(dupHtml, "add");
    expect(dupAdd).toContain("Fineprint already watches that page.");
    expect(dupAdd).toContain('<a href="/pages/watched">See its history</a>');

    const gone = await post({ url: "https://example.com/expired" }, from("203.0.113.50"));
    expect(gone.status).toBe(409);
    const goneHtml = await gone.text();
    const goneAdd = sectionOf(goneHtml, "add");
    expect(goneAdd).not.toContain("Fineprint already watches that page.");
    expect(goneAdd).toContain("Fineprint watched that page before and keeps its history. It cannot be added again.");
    expect(goneAdd).toContain('<a href="/pages/expired">See its history</a>');
    expect(fetchMock.calls).toEqual([]);
  });

  it("never takes the admin token: a bearer header and admin or token fields are still a public add, counted against the visitor", async () => {
    mockTinyFish();
    const ip = "198.51.100.23";
    const res = await post(
      { url: "https://example.com/terms", admin: "1", token: "test-admin", kind: "pricing", ignore_patterns: "^x" },
      { Authorization: "Bearer test-admin", ...from(ip) },
    );
    expect(res.status).toBe(303);
    const added = (await getPage(db, pageIdOf(res)))!;
    expect(added).toMatchObject({ added_by: "public", kind: "other", ignore_patterns: "[]" });
    expect(added.expires_at).not.toBeNull();
    const ipHash = await hashText(ip + SECRET);
    expect(await publicAddsToday(db, ipHash)).toBe(1);

    // And it holds the visitor to one a day, token or not.
    const again = await post({ url: "https://example.com/other" }, { Authorization: "Bearer test-admin", ...from(ip) });
    expect(again.status).toBe(429);
    const html = await again.text();
    // Neither the address nor its key ever reaches the page.
    expect(html).not.toContain(ip);
    expect(html).not.toContain(ipHash);
    expect(html).not.toContain(ipHash.slice(0, 16));
  });

  it("uses the typed label, and falls back to the page title when it is left empty", async () => {
    mockTinyFish();
    const named = await post({ url: "https://example.com/a", label: "  My bank fees " }, from("203.0.113.60"));
    expect(named.status).toBe(303);
    expect((await getPage(db, pageIdOf(named)))!.label).toBe("My bank fees");
    const blank = await post({ url: "https://example.com/b", label: "   " }, from("203.0.113.61"));
    expect(blank.status).toBe(303);
    expect((await getPage(db, pageIdOf(blank)))!.label).toBe(fetchFixture.results[0]!.title);
  });

  it("disables the form at the spend pause, refuses a post with 503 and the reason, and still searches", async () => {
    mockTinyFish();
    mockSearch();
    await pauseSpend();
    const html = await get("/watchlist");
    const line = "Spending is paused at the budget line, so no new page can be added until it lifts.";
    expect(html).toContain(line);
    expect(html).toMatch(/<input[^>]+name="url"[^>]+disabled/);
    expect(html).toMatch(/<input[^>]+name="label"[^>]+aria-describedby="label-hint add-slots"[^>]+disabled/);
    expect(html).toMatch(/<button[^>]+type="submit"[^>]+aria-describedby="add-slots"[^>]+disabled/);

    const res = await post({ url: "https://example.com/pricing" }, from("203.0.113.100"));
    expect(res.status).toBe(503);
    const refused = await res.text();
    expect(sectionOf(refused, "add")).toContain(line);
    expect(refused).toContain('value="https://example.com/pricing"');
    expect(fetchMock.calls).toEqual([]);
    expect(await publicAddsToday(db, await hashText("203.0.113.100" + SECRET))).toBe(0);

    // The search is free, so it stays open.
    expect(await get("/watchlist?domain=example.com", from("203.0.113.100"))).toContain("Watch this page");
  });

  it("refuses a post sent from another site with 403 before reading it; a same-origin post, or one without the headers, goes through", async () => {
    mockTinyFish();
    const line = "That form was sent from another site, so it was not read. Use the form on this page.";
    const crossSite: Record<string, string>[] = [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://elsewhere.example" }, { Origin: "null" }];
    for (const headers of crossSite) {
      const res = await post({ url: "https://example.com/pricing" }, { ...headers, ...from("203.0.113.110") });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      const html = await res.text();
      expect(html).toContain("<h1>Watchlist</h1>");
      expect(sectionOf(html, "add")).toContain(line);
    }
    expect(fetchMock.calls).toEqual([]);
    expect(await publicAddsToday(db, await hashText("203.0.113.110" + SECRET))).toBe(0);

    const same = await post({ url: "https://example.com/a" }, { Origin: "https://fineprint.test", "Sec-Fetch-Site": "same-origin", ...from("203.0.113.111") });
    expect(same.status).toBe(303);
    const sameSite = await post({ url: "https://example.com/b" }, { "Sec-Fetch-Site": "same-site", ...from("203.0.113.112") });
    expect(sameSite.status).toBe(303);
  });

  it("describes the closed form's label and button by the line that says why it is closed", async () => {
    await fillPublicSlots();
    const html = await get("/watchlist");
    expect(html).toMatch(/<input[^>]+name="url"[^>]+aria-describedby="add-slots"[^>]+disabled/);
    expect(html).toMatch(/<input[^>]+name="label"[^>]+aria-describedby="label-hint add-slots"[^>]+disabled/);
    expect(html).toMatch(/<button[^>]+type="submit"[^>]+aria-describedby="add-slots"[^>]+disabled/);
    // Open, the button needs no description.
    await db.prepare("UPDATE pages SET status = 'expired' WHERE id = 'pub0'").run();
    expect(await get("/watchlist")).toMatch(/<button class="btn" type="submit">Start watching<\/button>/);
  });

  it("takes a multipart form as well", async () => {
    mockTinyFish();
    const form = new FormData();
    form.set("url", "https://example.com/multipart");
    const res = await call("/watchlist", { method: "POST", headers: from("203.0.113.70"), body: form });
    expect(res.status).toBe(303);
  });

  it("refuses a body that is not a form with the watchlist and a plain reason, before anything else", async () => {
    for (const [type, body] of [
      ["application/json", JSON.stringify({ url: "https://example.com/pricing" })],
      ["text/plain", "url=https://example.com/pricing"],
    ] as const) {
      const res = await call("/watchlist", { method: "POST", headers: { "content-type": type, ...from("203.0.113.80") }, body });
      expect(res.status, type).toBe(400);
      const html = await res.text();
      expect(html).toContain("<h1>Watchlist</h1>");
      expect(html).toContain("That request was not a form Fineprint reads. Use the form on this page.");
    }
    expect(fetchMock.calls).toEqual([]);
    expect(await publicAddsToday(db, await hashText("203.0.113.80" + SECRET))).toBe(0);
  });

  it("refuses a form larger than it reads with 413", async () => {
    const res = await post({ url: `https://example.com/${"a".repeat(20_000)}` }, from("203.0.113.81"));
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("That form is larger than Fineprint reads.");
    expect(fetchMock.calls).toEqual([]);
  });

  it("refuses a url or a label over its length, keeping what was typed cut to the field's length", async () => {
    const long = `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`;
    const url = await post({ url: long }, from("203.0.113.82"));
    expect(url.status).toBe(400);
    const urlHtml = await url.text();
    expect(urlHtml).toContain(`That address is longer than ${MAX_URL_LENGTH} characters.`);
    expect(urlHtml).toContain(`value="${long.slice(0, MAX_URL_LENGTH)}"`);
    expect(urlHtml).not.toContain(long);

    const label = await post({ url: "https://example.com/pricing", label: "x".repeat(250) }, from("203.0.113.82"));
    expect(label.status).toBe(400);
    const labelHtml = await label.text();
    expect(labelHtml).toContain("A label can be at most 200 characters.");
    expect(labelHtml).toContain(`value="${"x".repeat(200)}"`);
    expect(labelHtml).not.toContain("x".repeat(201));
    expect(fetchMock.calls).toEqual([]);
  });

  it("refuses an address that is not a public web page, and a file sent in its place", async () => {
    for (const bad of ["not a url", "http://localhost/", "javascript:alert(1)"]) {
      const res = await post({ url: bad }, from("203.0.113.83"));
      expect(res.status, bad).toBe(400);
      expect(await res.text(), bad).toContain("That is not an address Fineprint can watch.");
    }
    const form = new FormData();
    form.set("url", new File(["https://example.com/"], "url.txt"));
    const file = await call("/watchlist", { method: "POST", headers: from("203.0.113.83"), body: form });
    expect(file.status).toBe(400);
    expect(fetchMock.calls).toEqual([]);
  });

  it("keeps a url and a label passed in the address, escaped, and calls nobody for them", async () => {
    const html = await get("/watchlist?url=https%3A%2F%2Fexample.com%2Fterms");
    expect(html).toContain('value="https://example.com/terms"');
    const escaped = await get(`/watchlist?url=${encodeURIComponent(`https://example.com/"><b>x</b>`)}&label=${encodeURIComponent(`"${XSS}`)}`);
    expect(escaped).toContain('value="https://example.com/&quot;&gt;&lt;b&gt;x&lt;/b&gt;"');
    expect(escaped).toContain('value="&quot;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(escaped).not.toContain(XSS);
    expect(fetchMock.calls).toEqual([]);
  });
});

// --- Discover -------------------------------------------------------------------------------------

describe("finding a site's small print from the watchlist", () => {
  it("lists what the search found with a Watch this page link (url and label only), and links the page Fineprint already has", async () => {
    mockSearch();
    await insertPage(db, page("fees", { url: "https://example.com/fees", label: "Watched fees" }));
    const ip = "203.0.113.90";
    const html = await get("/watchlist?domain=example.com", from(ip));
    expect(html).toContain("Watch this page");
    expect(html).toContain('href="/watchlist?url=https%3A%2F%2Fexample.com%2Fpricing&amp;label=Example%20pricing#add"');
    expect(html).toContain("Plans from $5 a month, billed yearly.");
    // Search text is text: escaped in the title, the snippet and the label it carries.
    expect(html).toContain("Read these terms &lt;script&gt;alert(1)&lt;/script&gt; first.");
    expect(html).not.toContain(XSS);
    // The page already watched is linked, not offered.
    const fees = html.slice(html.indexOf("Example fees</"), html.indexOf("</li>", html.indexOf("Example fees</")));
    expect(fees).toContain('href="/pages/fees"');
    expect(fees).not.toContain("Watch this page");
    expect(html).not.toContain("url=https%3A%2F%2Fexample.com%2Ffees");
    // The search box keeps what was typed; the results are not for search engines.
    expect(html).toMatch(/<input[^>]+name="domain"[^>]+value="example.com"/);
    expect(html).toContain('<meta name="robots" content="noindex"/>');
    // No link anywhere starts a search: only the GET form sends domain=.
    expect(html).not.toMatch(/href="[^"]*domain=/);
    expect(searchCalls()).toBe(4);
    expect(await publicAddsToday(db, await discoverKey(ip))).toBe(1);
    expect(monitorCreateCalls()).toBe(0);
  });

  it("searches nothing for a HEAD request, and robots.txt keeps crawlers off the watchlist's queries", async () => {
    mockSearch();
    const ip = "203.0.113.96";
    const head = await call("/watchlist?domain=example.com", { method: "HEAD", headers: from(ip) });
    expect(head.status).toBe(200);
    expect(searchCalls()).toBe(0);
    expect(await publicAddsToday(db, await discoverKey(ip))).toBe(0);

    // Served as a static file, before the Worker (through the service binding, as production reaches it).
    const robots = await (await env.SELF.fetch("https://x/robots.txt")).text();
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).toMatch(/^Disallow: \/watchlist\?$/m);
  });

  it("refuses a domain it cannot search with 400, without a search or a daily lookup", async () => {
    const ip = "203.0.113.91";
    const res = await call("/watchlist?domain=localhost", { headers: from(ip) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That is not a website Fineprint can search. Type a name like vercel.com.");
    expect(fetchMock.calls).toEqual([]);
    expect(await publicAddsToday(db, await discoverKey(ip))).toBe(0);
  });

  it("holds a visitor to the same ten lookups a day as the JSON route, with 429", async () => {
    mockSearch();
    const ip = "203.0.113.92";
    await db
      .prepare("INSERT INTO public_adds (ip_hash, day, count) VALUES (?, ?, ?)")
      .bind(await discoverKey(ip), new Date().toISOString().slice(0, 10), DISCOVER_PER_IP_PER_DAY)
      .run();
    const res = await call("/watchlist?domain=example.com", { headers: from(ip) });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Ten searches per visitor per day. Come back tomorrow.");
    expect(searchCalls()).toBe(0);
  });

  it("says what failed when the search does not answer, with 502, and gives the lookup back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.intercept({ method: "GET", url: /^https:\/\/api\.search\.tinyfish\.ai\//, times: Infinity, reply: { status: 503, json: { error: { code: "DOWN" } } } });
    const ip = "203.0.113.93";
    const res = await call("/watchlist?domain=example.com", { headers: from(ip) });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("The search did not answer. Try again in a minute.");
    expect(await publicAddsToday(db, await discoverKey(ip))).toBe(0);
  });

  it("says when nothing was found", async () => {
    fetchMock.intercept({ method: "GET", url: /^https:\/\/api\.search\.tinyfish\.ai\//, times: Infinity, reply: { json: { results: [] } } });
    expect(await get("/watchlist?domain=example.com", from("203.0.113.94"))).toContain(
      "No pricing, terms, privacy or fees pages were found on example.com.",
    );
  });
});

// --- What it costs ------------------------------------------------------------------------------------

describe("the watchlist's reads", () => {
  it("reads few rows: the stats and the page list, one claim and the search's spend rows for domain=, nothing for a path it does not have", async () => {
    mockSearch();
    const prepare = vi.spyOn(env.DB, "prepare");
    const batch = vi.spyOn(env.DB, "batch");
    const queries = async (path: string, init: RequestInit = {}, expected = 200): Promise<string[]> => {
      prepare.mockClear();
      const res = await call(path, init);
      expect(res.status, path).toBe(expected);
      await res.text();
      return prepare.mock.calls.map((c) => String(c[0]));
    };
    const plain = await queries("/watchlist");
    expect(plain.length).toBeLessThanOrEqual(7);
    expect(await queries("/watchlist?url=https%3A%2F%2Fexample.com%2Fterms&label=Terms")).toHaveLength(plain.length);
    // The claim and the four $0 spend rows of the search; the pages it is matched against are the list already read.
    const found = await queries("/watchlist?domain=example.com", { headers: from("203.0.113.95") });
    expect(found.length).toBe(plain.length + 5);
    // A refused add: the add's own checks, then the screen.
    await db.prepare("INSERT INTO public_adds (ip_hash, day, count) VALUES (?, ?, 1)").bind(await hashText("203.0.113.96" + SECRET), new Date().toISOString().slice(0, 10)).run();
    const refused = await queries(
      "/watchlist",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...from("203.0.113.96") }, body: "url=https%3A%2F%2Fexample.com%2Fnew" },
      429,
    );
    expect(refused.length).toBeLessThanOrEqual(plain.length + 5);
    const invalid = await queries("/watchlist", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "url=nope" }, 400);
    expect(invalid).toHaveLength(plain.length);
    // A path under the watchlist that does not exist is the ledger's 404, without a read.
    expect(await queries("/watchlist/nope", {}, 404)).toEqual([]);
    // One batch a screen, one round trip: the stats' six aggregates (prepared, so counted above).
    expect(batch.mock.calls.map((call) => call[0].length)).toEqual([6, 6, 6, 6, 6]);
  });
});

// --- The refusal copy -----------------------------------------------------------------------------

describe("addErrorCopy", () => {
  it("says each refusal plainly, by the TinyFetch reason it carries or by its error code", () => {
    expect(addErrorCopy("unfetchable", "login_required")).toBe("That page needs a login, so it cannot be watched.");
    expect(addErrorCopy("unfetchable", "bot_blocked")).toBe("That site refuses automated reading, so it cannot be watched.");
    expect(addErrorCopy("unfetchable", "timeout")).toBe("That page did not answer in time. Try again in a minute.");
    expect(addErrorCopy("unfetchable", "target_http_error")).toBe("That page returned an error when read.");
    expect(addErrorCopy("daily_limit", "One public page per day per visitor")).toBe("One public page per visitor per day. Come back tomorrow.");
    expect(addErrorCopy("already_watched", "")).toBe("Fineprint already watches that page.");
    expect(addErrorCopy("public_slots_full", "", "2026-11-09T12:30:00.000Z", Date.parse("2026-11-07T00:00:00.000Z"))).toBe(
      "All 4 public slots are in use. The next one frees on 9 Nov 2026, 12:30 UTC.",
    );
    expect(addErrorCopy("invalid_url", "")).toMatch(/^That is not an address Fineprint can watch\./);
    expect(addErrorCopy("invalid_url", "url_too_long")).toMatch(/^That address is longer than 2048 characters\./);
    expect(addErrorCopy("unfetchable", "empty_page")).toBe("That page has no text Fineprint can read, so it cannot be watched.");
    // A reason this code has no words for is shown as it came, in a sentence, never as an empty line.
    expect(addErrorCopy("unfetchable", "dns_error")).toBe("That page could not be read (dns_error), so it cannot be watched.");
    expect(addErrorCopy("watchlist_full", "Fineprint already watches its maximum of 24 pages")).toBe("Fineprint already watches its maximum of 24 pages.");
    expect(addErrorCopy("something_new", "")).toBe("The page was not added.");
  });
});
