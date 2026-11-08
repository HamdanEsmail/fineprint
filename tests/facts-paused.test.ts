// The honest state at the price-table budget line (submission Task 10.4): from FACTS_PAUSE_USD of total spend no
// price-table run starts, and a version whose run cannot start for that reason has facts_status "paused" in every
// JSON reply, says so on the page view and the compare, and is counted by /api/stats. A version created while
// paused takes the state as its capture starts; one already queued takes it on the next hourly tick, which drops
// its page's stored screens; a run already in flight keeps its run; if the line were raised, the next tick queues
// paused versions again.
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps, captureStatusFor, captureVersion, factsStatusFor, recordFactsResult, startNextFacts } from "../src/capture";
import { CAPTURE_MAX_ATTEMPTS, FACTS_HOLD_PER_TICK } from "../src/core/limits";
import { cronDeps, runCron } from "../src/cron";
import { insertPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { PageKind, VersionRow } from "../src/db/types";
import { getVersion, insertVersion, nextFactsCandidate, type NewVersion } from "../src/db/versions";
import worker from "../src/index";
import { deployStamp } from "../src/site/htmlCache";
import { fetchMock } from "./helpers/fetch-mock";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const COPY = "Price table not read: spending on price tables is paused at the $6 line. The change itself is recorded, with its screenshot and diff.";
const FETCH_API = "https://api.fetch.tinyfish.ai/";
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const HTML = "<!doctype html><html><body><h1>Pro</h1></body></html>";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const ITEMS = [{ name: "Pro", price: "$20", unit: "per month" }];
const both = { screenshot_key: "shots/a.jpg", html_key: "html/a.html" };
const db = env.DB;

let seq = 0;

async function seedPage(kind: PageKind = "pricing"): Promise<string> {
  const id = `page-${++seq}`;
  await insertPage(db, {
    id,
    url: `https://example.com/${id}`,
    label: `Label ${id}`,
    kind,
    monitor_id: `mon-${id}`,
    schedule_cron: "0 0,12 * * *",
    purpose: "watch",
    status: "active",
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
  });
  return id;
}

async function seedVersion(pageId: string, over: Partial<NewVersion> = {}): Promise<string> {
  const id = `v-${++seq}`;
  const isBaseline = over.is_baseline ?? 1;
  await insertRun(db, {
    id: `run-${id}`,
    page_id: pageId,
    monitor_run_id: `mrun-${id}`,
    outcome: isBaseline ? "baseline" : "changed",
    is_baseline: isBaseline,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: "2026-11-01T00:00:00.000Z",
    trigger_kind: isBaseline ? "create" : "webhook",
  });
  await insertVersion(db, {
    id,
    page_id: pageId,
    run_id: `run-${id}`,
    is_baseline: isBaseline,
    captured_at: new Date(Date.UTC(2026, 10, 1) + seq * 60_000).toISOString(),
    text: `Pro $20/mo. Version ${id}.`,
    normalized_hash: `hash-${id}`,
    judgment_summary: null,
    ...over,
  });
  return id;
}

/** A version waiting in the facts queue: screenshot and source stored, no run. */
const queued = (pageId: string, over: Partial<NewVersion> = {}) =>
  seedVersion(pageId, { ...both, capture_status: "awaiting_facts", facts_status: "pending", capture_attempts: 1, ...over });

const version = async (id: string): Promise<VersionRow> => (await getVersion(db, id))!;
const spend = (usd: number) =>
  db.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES (?, 'monitor_check', ?, 'ledger', ?)").bind(crypto.randomUUID(), usd, new Date().toISOString()).run();
const runAsyncCount = () => fetchMock.calls.filter((c) => c.url === RUN_ASYNC_API).length;

async function call(path: string, over: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(new URL(path, "https://fineprint.test")), { ...env, ...over }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const json = async (path: string): Promise<Json> => (await call(path)).json();
const html = async (path: string): Promise<string> => {
  const res = await call(path);
  expect(res.status, path).toBe(200);
  return res.text();
};

function mockCapture(): void {
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const url = (body as { urls: string[] }).urls[0];
      return Response.json({ results: [{ url, final_url: url, title: "T", text: HTML }] });
    },
  });
  let n = 0;
  fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, times: Infinity, reply: () => Response.json({ run_id: `agent-run-${++n}` }) });
}

/** The tick with nothing outside its facts steps: every Monitor active, no pull, no screen rebuilt, no clean-up. */
async function tick(over: Record<string, string> = {}): Promise<void> {
  fetchMock.intercept({
    method: "GET",
    url: MONITORS_API,
    times: Infinity,
    reply: async () => {
      const { results } = await db.prepare("SELECT monitor_id FROM pages WHERE monitor_id IS NOT NULL").all<{ monitor_id: string }>();
      return Response.json({ monitors: results.map((r) => ({ id: r.monitor_id, status: "active", name: r.monitor_id })) });
    },
  });
  vi.spyOn(cronDeps, "rebuild").mockResolvedValue(new Response("{}"));
  vi.spyOn(cronDeps, "sweep").mockResolvedValue(Response.json({ stamp: "x", previous: "x", deleted: 0 }));
  vi.spyOn(cronDeps, "pull").mockResolvedValue(Response.json({ ok: true, pulled: false, reason: "not_due" }));
  await runCron({ ...env, ...over } as typeof env);
  for (const seam of [cronDeps.rebuild, cronDeps.sweep, cronDeps.pull]) vi.mocked(seam).mockRestore();
}

let shot: MockInstance<typeof captureDeps.screenshotFullPage>;

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  shot = vi.spyOn(captureDeps, "screenshotFullPage").mockImplementation(async () => ({ bytes: JPEG.slice().buffer, height: 800, sessionId: "s" }));
  captureDeps.sleep = async () => {};
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fetchMock.reset();
  shot.mockRestore();
  captureDeps.sleep = undefined;
  vi.restoreAllMocks();
});

describe("the paused state in the status rule", () => {
  const row = (over: Partial<VersionRow>) => ({ screenshot_key: null, html_key: null, facts_json: null, capture_attempts: 1, agent_run_id: null, ...over });

  it.each([
    ["paused and queued", "paused", "awaiting_facts", row({ ...both, facts_status: "paused" })],
    ["paused, screenshot still to take", "paused", "partial", row({ html_key: "h", facts_status: "paused" })],
    ["paused, then its facts are stored", "ok", "complete", row({ ...both, facts_status: "paused", facts_json: "[]" })],
    ["paused with a run (only after the line is raised)", "pending", "awaiting_facts", row({ ...both, facts_status: "paused", agent_run_id: "run-1" })],
    ["paused at the attempt cap, both stored", "unavailable", "complete", row({ ...both, facts_status: "paused", capture_attempts: CAPTURE_MAX_ATTEMPTS })],
  ] as const)("%s → facts %s, capture %s", (_name, facts, capture, v) => {
    expect(factsStatusFor(v, true)).toBe(facts);
    expect(captureStatusFor(v, true)).toBe(capture);
    expect(factsStatusFor(v, false)).toBe(v.facts_json === null ? "not_needed" : "ok");
  });
});

describe("a version whose price table cannot start because spending on price tables is paused", () => {
  it("a version created while paused takes the state as its capture starts, and no run starts", async () => {
    mockCapture();
    await spend(6.5);
    const id = await seedVersion(await seedPage(), { capture_status: "pending", facts_status: "pending" });
    let during: string | undefined;
    shot.mockImplementation(async () => {
      during = (await version(id)).facts_status; // already said while the screenshot is being taken
      return { bytes: JPEG.slice().buffer, height: 800, sessionId: "s" };
    });
    await captureVersion(env, id);
    expect(during).toBe("paused");
    expect(await version(id)).toMatchObject({ capture_status: "awaiting_facts", facts_status: "paused", agent_run_id: null, screenshot_key: `shots/${id}.jpg` });
    expect(runAsyncCount()).toBe(0);
    // Another capture (the repair) keeps it.
    await captureVersion(env, id);
    expect((await version(id)).facts_status).toBe("paused");
  });

  it("at the spend pause too, the capture that is skipped says so", async () => {
    await spend(8);
    const id = await seedVersion(await seedPage(), { capture_status: "pending", facts_status: "pending" });
    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({ capture_status: "pending", capture_error: "spend_paused", facts_status: "paused" });
  });

  it("a page that needs no price table is not paused", async () => {
    mockCapture();
    await spend(6.5);
    const id = await seedVersion(await seedPage("policy"), { capture_status: "pending", facts_status: "not_needed" });
    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({ capture_status: "complete", facts_status: "not_needed" });
  });

  it("versions already queued when the pause begins take the state on the next tick; a run in flight keeps its run", async () => {
    const page = await seedPage();
    const waiting = await queued(page);
    const flying = await queued(page, { is_baseline: 0, agent_run_id: "agent-run-live" });
    const other = await queued(await seedPage("fees"));
    const policy = await seedVersion(await seedPage("policy"), { ...both, capture_status: "complete", facts_status: "not_needed" });
    await spend(6.5);
    await tick();
    expect(await version(waiting)).toMatchObject({ facts_status: "paused", capture_status: "awaiting_facts", agent_run_id: null });
    expect(await version(other)).toMatchObject({ facts_status: "paused" });
    expect(await version(flying)).toMatchObject({ facts_status: "pending", agent_run_id: "agent-run-live" });
    expect((await version(policy)).facts_status).toBe("not_needed");
    expect(runAsyncCount()).toBe(0);

    // The run in flight may still finish and store its price table.
    await recordFactsResult(env, "agent-run-live", "COMPLETED", { items: ITEMS }, 2);
    expect(await version(flying)).toMatchObject({ facts_status: "ok", capture_status: "complete" });
    expect(runAsyncCount()).toBe(0);
  });

  it("moves at most FACTS_HOLD_PER_TICK versions a tick, the oldest first", async () => {
    const page = await seedPage();
    const ids: string[] = [];
    for (let i = 0; i < FACTS_HOLD_PER_TICK + 2; i++) ids.push(await queued(page));
    await spend(6.5);
    await tick();
    const states = await Promise.all(ids.map(async (id) => (await version(id)).facts_status));
    expect(states).toEqual([...Array(FACTS_HOLD_PER_TICK).fill("paused"), "pending", "pending"]);
    await tick();
    expect((await version(ids.at(-1)!)).facts_status).toBe("paused");
  });

  it("the tick drops the stored screens of the pages it moved, by their keys, and leaves the others", async () => {
    const cacheOn = { HTML_CACHE: "1" };
    const stamp = deployStamp(env);
    const page = await seedPage();
    const calm = await seedPage();
    await queued(page);
    await seedVersion(calm, { ...both, capture_status: "complete", facts_status: "ok", facts_json: JSON.stringify(ITEMS) });
    const keys = [`page/${page}`, `compare/${page}/a/b`, `page/${calm}`, `compare/${calm}/c/d`, "watchlist"];
    for (const key of keys) await env.STORE.put(`screens/${stamp}/${key}`, `<p>${key}</p>`, { customMetadata: { headers: "{}" } });
    await spend(6.5);
    await tick(cacheOn);
    const left = (await env.STORE.list({ prefix: `screens/${stamp}/` })).objects.map((o) => o.key.slice(`screens/${stamp}/`.length)).sort();
    expect(left).toEqual([`compare/${calm}/c/d`, `page/${calm}`, "watchlist"].sort());
  });

  it("if the line were raised, the next tick queues paused versions again and the queue starts them", async () => {
    mockCapture();
    const id = await queued(await seedPage(), { facts_status: "paused" });
    await spend(3); // below the line: as if FACTS_PAUSE_USD had been raised past the total
    await tick();
    expect(await version(id)).toMatchObject({ facts_status: "pending", agent_run_id: "agent-run-1" });
    expect(runAsyncCount()).toBe(1);
  });

  it("the facts queue never starts a run for a paused version", async () => {
    mockCapture();
    const id = await queued(await seedPage(), { facts_status: "paused" });
    expect(await nextFactsCandidate(db)).toBeNull();
    expect(await startNextFacts(env)).toBe(false);
    await captureVersion(env, id);
    expect(runAsyncCount()).toBe(0);
    expect((await version(id)).facts_status).toBe("paused");
  });
});

describe("the paused state everywhere a version appears", () => {
  async function setup() {
    const page = await seedPage();
    const a = await seedVersion(page, { captured_at: "2026-11-01T00:00:00.000Z", ...both, capture_status: "complete", facts_status: "ok", facts_json: JSON.stringify(ITEMS) });
    const b = await seedVersion(page, {
      captured_at: "2026-11-02T00:00:00.000Z",
      is_baseline: 0,
      ...both,
      capture_status: "awaiting_facts",
      facts_status: "paused",
      summary: "The Pro plan changed.",
      summary_source: "diff",
    });
    await spend(6.5);
    return { page, a, b };
  }

  it("every JSON reply carries the same value", async () => {
    const { page, a, b } = await setup();
    expect((await json(`/api/pages/${page}/versions/${b}`)).facts_status).toBe("paused");
    expect((await json(`/api/pages/${page}/versions/${a}`)).facts_status).toBe("ok");
    expect((await json(`/api/pages/${page}/as-of?at=2030-01-01T00:00:00Z`)).facts_status).toBe("paused");
    const detail = await json(`/api/pages/${page}`);
    expect(detail.versions.find((v: Json) => v.id === b).facts_status).toBe("paused");
    const exported = await json("/api/export.json");
    expect(exported.pages.find((p: Json) => p.id === page).versions.find((v: Json) => v.id === b).facts_status).toBe("paused");
    const changes = await json("/api/changes");
    expect(changes.changes.find((c: Json) => c.version_id === b).facts_status).toBe("paused");
    const diff = await json(`/api/pages/${page}/diff?from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:00Z`);
    expect([diff.from.facts_status, diff.to.facts_status]).toEqual(["ok", "paused"]);
  });

  it("/api/stats counts the paused versions", async () => {
    expect((await json("/api/stats")).facts_paused_versions).toBe(0);
    await setup();
    const stats = await json("/api/stats");
    expect(stats.facts_paused_versions).toBe(1);
    expect(stats.facts_unavailable).toBe(0);
  });

  it("the page view says so in the price table's place", async () => {
    const { page, a } = await setup();
    const view = await html(`/pages/${page}`);
    expect(view).toContain(`<p class="facts-note">${COPY}</p>`);
    expect(view).not.toContain("Reading prices…");
    expect(view).not.toContain("Price tables are paused at the budget line");
    // The version with its price table still shows the table.
    expect(await html(`/pages/${page}?v=${a}`)).not.toContain(COPY);
  });

  it("the compare says so in its prices section", async () => {
    const { page, a, b } = await setup();
    const compare = await html(`/pages/${page}/compare?from=${a}&to=${b}`);
    expect(compare).toContain('<h2 id="facts-h">Prices</h2>');
    expect(compare).toContain(COPY);
    expect(compare).not.toContain("Reading prices…");
  });

  it("a version still reading its prices is not called paused, and an unpaused screen has no pause line", async () => {
    const page = await seedPage();
    await queued(page);
    const view = await html(`/pages/${page}`);
    expect(view).toContain("Reading prices…");
    expect(view).not.toContain(COPY);
    expect(view).not.toContain("Spending on price tables is paused");
  });

  it("the footer and About say the same in one sentence", async () => {
    await setup();
    const line = "Spending on price tables is paused at the $6 line; changes are still recorded, with their screenshots and diffs.";
    expect(await html("/")).toContain(line);
    const about = await html("/about");
    expect(about).toContain(line);
    expect(about).toContain(
      "At $6 of TinyFish spend, spending on price tables is paused: a change recorded after that says its price table was not read, and is still recorded with its screenshot and diff.",
    );
  });
});
