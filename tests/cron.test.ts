import { applyD1Migrations, createExecutionContext, createScheduledController, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps } from "../src/capture";
import { CAPTURE_MAX_ATTEMPTS } from "../src/core/limits";
import { PRICES } from "../src/core/spend";
import { runCron } from "../src/cron";
import { getPage, insertPage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { PageRow, SpendRow, VersionRow } from "../src/db/types";
import { getVersion, insertVersion, listVersions, type NewVersion } from "../src/db/versions";
import worker from "../src/index";
import { fetchMock } from "./helpers/fetch-mock";

const FETCH_API = "https://api.fetch.tinyfish.ai/";
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const runUrl = (id: string) => `https://agent.tinyfish.ai/v1/runs/${id}?screenshots=none&html=none`;
const monitorUrl = (id: string) => `${MONITORS_API}/${id}`;
const HTML = "<!doctype html><html><body><h1>Pro</h1><p>$20/mo.</p></body></html>";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);
const ITEMS = [
  { name: "Hobby", price: "$0", unit: "per month" },
  { name: "Pro", price: "$20", unit: "per month", notes: "For teams" },
];
const FACTS = [
  { name: "Hobby", price: "$0", unit: "per month", notes: null },
  { name: "Pro", price: "$20", unit: "per month", notes: "For teams" },
];

// --- Time ---------------------------------------------------------------------------
// The cron's windows (10, 15 and 60 minutes) are measured from the real clock, so every
// time a test cares about is set relative to now.

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * MINUTE).toISOString();
/** A time as TinyAgent writes it on a run: whole seconds, `Z`. */
const runTime = (minutes: number) => ago(minutes).replace(/\.\d{3}Z$/, "Z");

// --- Seeding --------------------------------------------------------------------------

let seq = 0;
const urlOf = (pageId: string) => `https://example.com/${pageId}`;
const monitorOf = (pageId: string) => `mon-${pageId}`;

async function seedPage(over: Partial<NewPage> = {}): Promise<string> {
  const id = `page-${++seq}`;
  await insertPage(env.DB, {
    id,
    url: urlOf(id),
    label: id,
    kind: "policy",
    monitor_id: monitorOf(id),
    schedule_cron: "0 0,12 * * *",
    purpose: "watch",
    status: "active",
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
    ...over,
  });
  return id;
}

/** A baseline version of the page with its run, captured about three hours ago (later seeds are later). */
async function seedVersion(pageId: string, over: Partial<NewVersion> = {}): Promise<string> {
  const id = `v-${++seq}`;
  const runId = `run-${id}`;
  await insertRun(env.DB, {
    id: runId,
    page_id: pageId,
    monitor_run_id: `mrun-${id}`,
    outcome: "baseline",
    is_baseline: 1,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: ago(180),
  });
  await insertVersion(env.DB, {
    id,
    page_id: pageId,
    run_id: runId,
    is_baseline: 1,
    captured_at: new Date(Date.now() - 180 * MINUTE + seq * 1000).toISOString(),
    text: "Pro $20/mo.",
    normalized_hash: "hash",
    judgment_summary: null,
    ...over,
  });
  return id;
}

/** A version whose screenshot and source are stored after one attempt, queued for its facts. */
const STORED = {
  screenshot_key: "shots/s.jpg",
  html_key: "html/h.html",
  capture_status: "awaiting_facts",
  capture_attempts: 1,
} as const satisfies Partial<NewVersion>;

const version = async (id: string): Promise<VersionRow> => (await getVersion(env.DB, id))!;
const page = async (id: string): Promise<PageRow> => (await getPage(env.DB, id))!;
const agentSteps = async () =>
  (await env.DB.prepare("SELECT * FROM spend WHERE kind = 'agent_step' ORDER BY rowid").all<SpendRow>()).results;

// --- TinyFish mocks ---------------------------------------------------------------------

type MonitorEntry = { id: string; status: string; name: string | null };

/**
 * Answers GET /v1/monitors with every Monitor a non-expired page holds, all `active`, read from
 * D1 when the request is made. `edit` changes that list (pause one, drop one, add a stranger's).
 */
function mockMonitors(edit: (list: MonitorEntry[]) => MonitorEntry[] = (list) => list, times = Infinity): void {
  fetchMock.intercept({
    method: "GET",
    url: MONITORS_API,
    times,
    reply: async () => {
      const { results } = await env.DB.prepare(
        "SELECT monitor_id, label FROM pages WHERE monitor_id IS NOT NULL AND status != 'expired' ORDER BY rowid",
      ).all<{ monitor_id: string; label: string }>();
      return Response.json({ monitors: edit(results.map((r) => ({ id: r.monitor_id, status: "active", name: r.label }))) });
    },
  });
}

function mockFetchHtml(): void {
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const url = (body as { urls: string[] }).urls[0];
      return Response.json({ results: [{ url, final_url: url, title: "Pricing", text: HTML }] });
    },
  });
}

/** Every run-async call gets the next id: agent-run-1, agent-run-2, ... */
function mockRunAsync(): void {
  let n = 0;
  fetchMock.intercept({
    method: "POST",
    url: RUN_ASYNC_API,
    times: Infinity,
    reply: () => Response.json({ run_id: `agent-run-${++n}` }),
  });
}

function mockGetRun(runId: string, run: Record<string, unknown>): void {
  fetchMock.intercept({ method: "GET", url: runUrl(runId), reply: { json: { run_id: runId, ...run } } });
}

const runAsyncCalls = () => fetchMock.calls.filter((c) => c.url === RUN_ASYNC_API);
const getRunCalls = () => fetchMock.calls.filter((c) => c.url.startsWith("https://agent.tinyfish.ai/v1/runs/"));
const deleteCalls = () => fetchMock.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
const callList = () => fetchMock.calls.map((c) => `${c.method} ${c.url}`);

// --- Setup ----------------------------------------------------------------------------

let shot: MockInstance<typeof captureDeps.screenshotFullPage>;
let sleep: MockInstance<(ms: number) => Promise<void>>;
let log: MockInstance<typeof console.log>;
// Every runCron step swallows its errors, so an unmatched fetch would only show up here: a
// test fails if anything is logged to console.error outside quietErrors.
let errorLog: MockInstance<typeof console.error>;

/** Runs `work`, expecting it to log errors, and returns everything it logged to console.error. */
async function quietErrors(work: () => Promise<unknown>): Promise<string> {
  errorLog.mockClear();
  await work();
  const logged = errorLog.mock.calls.flat().map(String).join(" ");
  errorLog.mockClear();
  return logged;
}

beforeEach(async () => {
  fetchMock.activate(); // nothing here may reach TinyFish; an unmatched fetch throws
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  shot = vi
    .spyOn(captureDeps, "screenshotFullPage")
    .mockImplementation(async () => ({ bytes: JPEG.slice().buffer, height: 1200, sessionId: "sess-1" }));
  const instant = { sleep: async (_ms: number) => {} };
  sleep = vi.spyOn(instant, "sleep");
  captureDeps.sleep = instant.sleep;
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  const unexpected = errorLog.mock.calls.flat().map(String).join(" ");
  fetchMock.reset();
  shot.mockRestore();
  log.mockRestore();
  errorLog.mockRestore();
  captureDeps.sleep = undefined;
  expect(unexpected).toBe("");
});

// --- Repair -----------------------------------------------------------------------------

describe("repair", () => {
  it("repair retries a partial capture older than 10 minutes and stops at 3 attempts", async () => {
    mockMonitors();
    shot.mockRejectedValue(new Error("CDP timeout: Page.navigate"));
    const pageId = await seedPage();
    const old = await seedVersion(pageId, {
      html_key: "html/h.html",
      capture_status: "partial",
      capture_error: "screenshot: cdp_failed (CDP timeout: Page.navigate)",
      capture_attempts: 1,
      captured_at: ago(30),
    });
    // Under 10 minutes old: the webhook's own capture may still be running, so it is left alone.
    const fresh = await seedVersion(pageId, { html_key: "html/f.html", capture_status: "partial", capture_attempts: 1, captured_at: ago(5) });

    expect(await runCron(env)).toEqual({ repaired: 1, expired: 0, unhealthy: [] });
    expect(await version(old)).toMatchObject({ capture_status: "partial", capture_attempts: 2 });

    expect(await runCron(env)).toEqual({ repaired: 1, expired: 0, unhealthy: [] });
    expect(await version(old)).toMatchObject({
      screenshot_key: null,
      html_key: "html/h.html",
      capture_status: "failed",
      capture_error: "screenshot: cdp_failed (CDP timeout: Page.navigate)",
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
    });

    // Failed: never retried again.
    expect(await runCron(env)).toEqual({ repaired: 0, expired: 0, unhealthy: [] });
    expect(shot).toHaveBeenCalledTimes(2);
    expect(await version(fresh)).toMatchObject({ capture_status: "partial", capture_attempts: 1 });
    expect(fetchMock.calls.filter((c) => c.url === FETCH_API)).toEqual([]); // the source was already stored
  });

  it("repair captures a pending version whose first capture never ran, and leaves awaiting_facts, complete and failed versions alone", async () => {
    mockMonitors();
    mockFetchHtml();
    const pageId = await seedPage();
    const pending = await seedVersion(pageId, { captured_at: ago(20) });
    await seedVersion(pageId, { ...STORED, capture_status: "complete", captured_at: ago(20) });
    await seedVersion(pageId, { capture_status: "failed", capture_attempts: CAPTURE_MAX_ATTEMPTS, captured_at: ago(20) });

    expect((await runCron(env)).repaired).toBe(1);

    expect(await version(pending)).toMatchObject({
      screenshot_key: `shots/${pending}.jpg`,
      html_key: `html/${pending}.html`,
      capture_status: "complete",
      capture_attempts: 1,
    });
    expect(shot).toHaveBeenCalledTimes(1);
  });
});

// --- Facts upkeep -------------------------------------------------------------------------

describe("facts upkeep", () => {
  it("an in-flight version whose run is COMPLETED gets its facts and becomes complete; then exactly one new run starts for the next queued version", async () => {
    mockMonitors();
    mockRunAsync();
    const first = await seedVersion(await seedPage({ kind: "pricing" }), { ...STORED, agent_run_id: "agent-run-X", captured_at: ago(20) });
    const queuedPage = await seedPage({ kind: "fees" });
    const queued = await seedVersion(queuedPage, { ...STORED, captured_at: ago(19) });
    mockGetRun("agent-run-X", { status: "COMPLETED", num_of_steps: 4, result: { items: ITEMS }, created_at: runTime(19) });

    await runCron(env);

    expect(await version(first)).toMatchObject({
      facts_json: JSON.stringify(FACTS),
      agent_run_id: "agent-run-X",
      capture_status: "complete",
      capture_error: null,
      capture_attempts: 1,
    });
    const steps = await agentSteps();
    expect(steps.map((s) => s.ref)).toEqual(["agent-run-X"]);
    expect(steps[0]!.amount_usd).toBeCloseTo(PRICES.agent_step * 4, 10);
    expect(runAsyncCalls()).toHaveLength(1);
    expect(runAsyncCalls()[0]!.body).toMatchObject({ url: urlOf(queuedPage) });
    expect(await version(queued)).toMatchObject({ agent_run_id: "agent-run-1", capture_status: "awaiting_facts" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("a FAILED run found by the follow-up uses an attempt and the version goes back in the queue", async () => {
    mockMonitors();
    mockRunAsync();
    const id = await seedVersion(await seedPage({ kind: "pricing" }), { ...STORED, agent_run_id: "agent-run-X", captured_at: ago(20) });
    mockGetRun("agent-run-X", { status: "FAILED", num_of_steps: 2, result: null, created_at: runTime(19) });

    await runCron(env);

    expect(await version(id)).toMatchObject({
      agent_run_id: "agent-run-1",
      capture_status: "awaiting_facts",
      capture_error: "facts: FAILED",
      capture_attempts: 2,
    });
    expect((await agentSteps()).map((s) => s.ref)).toEqual(["agent-run-X"]);
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("with one run in flight (and not yet 15 minutes old), a tick starts nothing new", async () => {
    mockMonitors();
    mockRunAsync();
    const inFlight = await seedVersion(await seedPage({ kind: "pricing" }), { ...STORED, agent_run_id: "agent-run-X", captured_at: ago(5) });
    const queued = await seedVersion(await seedPage({ kind: "fees" }), { ...STORED, captured_at: ago(4) });

    await runCron(env);

    expect(callList()).toEqual([`GET ${MONITORS_API}`]); // no run read, no run started
    expect(await version(inFlight)).toMatchObject({ agent_run_id: "agent-run-X", capture_attempts: 1 });
    expect(await version(queued)).toMatchObject({ agent_run_id: null, capture_status: "awaiting_facts" });
  });

  it("a run still going a few minutes after it started is left alone, though its version was captured hours ago", async () => {
    // The queue chains: a version that waited behind others gets its run long after it was captured.
    mockMonitors();
    mockRunAsync();
    const id = await seedVersion(await seedPage({ kind: "pricing" }), { ...STORED, agent_run_id: "agent-run-X", captured_at: ago(180) });
    const queued = await seedVersion(await seedPage({ kind: "fees" }), { ...STORED, captured_at: ago(170) });
    mockGetRun("agent-run-X", { status: "RUNNING", num_of_steps: 1, result: null, created_at: runTime(2) });

    await runCron(env);

    expect(getRunCalls()).toHaveLength(1);
    expect(await version(id)).toMatchObject({ agent_run_id: "agent-run-X", capture_status: "awaiting_facts", capture_error: null, capture_attempts: 1 });
    expect(runAsyncCalls()).toEqual([]);
    expect(await version(queued)).toMatchObject({ agent_run_id: null });
  });

  it.each([
    ["the run started over 60 minutes ago", { status: "RUNNING", created_at: runTime(75) }, 30],
    ["the run gives no start time and its version was captured over 60 minutes ago", { status: "PENDING" }, 90],
  ])("a run non-terminal for over 60 minutes is recorded as STALE (attempt used, slot freed): %s", async (_name, run, capturedMinutesAgo) => {
    mockMonitors();
    mockRunAsync();
    const stuck = await seedVersion(await seedPage({ kind: "pricing" }), {
      ...STORED,
      capture_attempts: CAPTURE_MAX_ATTEMPTS - 1,
      agent_run_id: "agent-run-X",
      captured_at: ago(capturedMinutesAgo),
    });
    const queuedPage = await seedPage({ kind: "fees" });
    const queued = await seedVersion(queuedPage, { ...STORED, captured_at: ago(25) });
    mockGetRun("agent-run-X", { ...run, result: null });

    await runCron(env);

    // The attempt was its last: the version is failed and the slot goes to the next one.
    expect(await version(stuck)).toMatchObject({
      agent_run_id: null,
      facts_json: null,
      capture_status: "failed",
      capture_error: "facts: STALE",
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
    });
    expect(runAsyncCalls()).toHaveLength(1);
    expect(runAsyncCalls()[0]!.body).toMatchObject({ url: urlOf(queuedPage) });
    expect(await version(queued)).toMatchObject({ agent_run_id: "agent-run-1" });
  });

  const NOT_FOUND = { status: 404, json: { error: { code: "NOT_FOUND" } } };

  // Only a run TinyAgent does not know frees the slot after an hour. A transient error must never
  // make a seconds-old chained run STALE, and with no run read the capture time is all there is.
  it.each([
    ["not found (404) on a version captured 59 minutes ago", NOT_FOUND, 59],
    ["rate-limited (429) on a version captured 61 minutes ago", { status: 429, body: "slow down" }, 61],
    ["failing (503) on a version captured 61 minutes ago", { status: 503, body: "busy" }, 61],
    ["a lost connection on a version captured 61 minutes ago", () => Promise.reject(new TypeError("Network connection lost.")), 61],
  ] as const)("a run whose read is %s is left in flight, and nothing new starts", async (_name, reply, capturedMinutesAgo) => {
    mockMonitors();
    mockRunAsync();
    const id = await seedVersion(await seedPage({ kind: "pricing" }), {
      ...STORED,
      agent_run_id: "agent-run-X",
      captured_at: ago(capturedMinutesAgo),
    });
    await seedVersion(await seedPage({ kind: "fees" }), { ...STORED, captured_at: ago(50) });
    fetchMock.intercept({ method: "GET", url: runUrl("agent-run-X"), reply });

    const logged = await quietErrors(() => runCron(env));

    expect(await version(id)).toMatchObject({ agent_run_id: "agent-run-X", capture_error: null, capture_attempts: 1 });
    expect(runAsyncCalls()).toEqual([]);
    expect(logged).toContain("agent-run-X");
    expect(logged).not.toContain("test-tinyfish-key");
  });

  it("a run TinyAgent does not know (404) on a version captured over 60 minutes ago is recorded as STALE: slot freed, the next queued version starts", async () => {
    mockMonitors();
    mockRunAsync();
    // With no run to read, its age comes from the version's capture time.
    const stuck = await seedVersion(await seedPage({ kind: "pricing" }), {
      ...STORED,
      capture_attempts: CAPTURE_MAX_ATTEMPTS - 1,
      agent_run_id: "agent-run-X",
      captured_at: ago(61),
    });
    const queuedPage = await seedPage({ kind: "fees" });
    const queued = await seedVersion(queuedPage, { ...STORED, captured_at: ago(50) });
    fetchMock.intercept({ method: "GET", url: runUrl("agent-run-X"), reply: NOT_FOUND });

    const logged = await quietErrors(() => runCron(env));

    expect(await version(stuck)).toMatchObject({
      agent_run_id: null,
      capture_status: "failed",
      capture_error: "facts: STALE",
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
    });
    expect(runAsyncCalls()).toHaveLength(1);
    expect(runAsyncCalls()[0]!.body).toMatchObject({ url: urlOf(queuedPage) });
    expect(await version(queued)).toMatchObject({ agent_run_id: "agent-run-1", capture_status: "awaiting_facts" });
    expect(getRunCalls()).toHaveLength(1);
    expect(logged).toContain("agent-run-X");
    expect(logged).not.toContain("test-tinyfish-key");
  });

  it("a stale claim: token older than 10 minutes on a failed version is cleared and the queue resumes; a fresh claim is left alone", async () => {
    mockMonitors();
    mockRunAsync();
    // A start that may have created a run kept its claim, and that start used the version's last attempt.
    const fresh = `claim:${ago(2)}`;
    const holder = await seedVersion(await seedPage({ kind: "pricing" }), {
      ...STORED,
      capture_status: "failed",
      capture_error: "facts: request_failed",
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
      agent_run_id: fresh,
    });
    const queuedPage = await seedPage({ kind: "fees" });
    const queued = await seedVersion(queuedPage, STORED);

    // Two minutes old: its start may still be waiting on TinyAgent.
    await runCron(env);
    expect((await version(holder)).agent_run_id).toBe(fresh);
    expect(runAsyncCalls()).toEqual([]);
    expect(await version(queued)).toMatchObject({ agent_run_id: null });

    const stale = `claim:${ago(11)}`;
    await env.DB.prepare("UPDATE versions SET agent_run_id = ? WHERE id = ?").bind(stale, holder).run();

    await runCron(env);

    expect(await version(holder)).toMatchObject({
      agent_run_id: null,
      capture_status: "failed",
      capture_error: "facts: request_failed",
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
    });
    expect(runAsyncCalls()).toHaveLength(1);
    expect(runAsyncCalls()[0]!.body).toMatchObject({ url: urlOf(queuedPage) });
    expect(await version(queued)).toMatchObject({ agent_run_id: "agent-run-1", capture_status: "awaiting_facts" });
  });

  it("a claim token with no readable time is released too", async () => {
    mockMonitors();
    mockRunAsync();
    const holder = await seedVersion(await seedPage({ kind: "pricing" }), { ...STORED, agent_run_id: "claim:not-a-time" });

    await runCron(env);

    // Released, and as the oldest queued version it is started again.
    expect(await version(holder)).toMatchObject({ agent_run_id: "agent-run-1", capture_attempts: 1 });
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("the cron's start waits out a 429 and then starts", async () => {
    mockMonitors();
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 429, body: "slow down" } });
    mockRunAsync();
    const id = await seedVersion(await seedPage({ kind: "pricing" }), STORED);

    await runCron(env);

    expect(runAsyncCalls()).toHaveLength(2);
    expect(sleep.mock.calls).toEqual([[60_000]]);
    expect(await version(id)).toMatchObject({ agent_run_id: "agent-run-1", capture_status: "awaiting_facts", capture_attempts: 1 });
  });
});

// --- Expiry -------------------------------------------------------------------------------

describe("expiry", () => {
  it("expiry deletes the Monitor of a public page past expires_at and marks it expired, keeping its versions", async () => {
    mockMonitors();
    const due = await seedPage({ added_by: "public", expires_at: ago(1) });
    const v = await seedVersion(due, { ...STORED, capture_status: "complete" });
    const notYet = await seedPage({ added_by: "public", expires_at: ahead(60) });
    const curated = await seedPage();
    const gone = await seedPage({ added_by: "public", expires_at: ago(60 * 24), status: "expired" });
    fetchMock.intercept({ method: "DELETE", url: monitorUrl(monitorOf(due)), reply: { status: 200, json: {} } });

    const result = await runCron(env);

    expect(result).toEqual({ repaired: 0, expired: 1, unhealthy: [] });
    expect(deleteCalls()).toEqual([monitorUrl(monitorOf(due))]);
    expect(await page(due)).toMatchObject({ status: "expired", added_by: "public" });
    expect((await listVersions(env.DB, due)).map((x) => x.id)).toEqual([v]);
    expect(await version(v)).toMatchObject({ capture_status: "complete" });
    expect((await page(notYet)).status).toBe("active");
    expect((await page(curated)).status).toBe("active");
    expect((await page(gone)).status).toBe("expired");
  });

  it("a Monitor delete that fails leaves the page for the next tick; one already gone (404) counts as deleted", async () => {
    mockMonitors();
    const alreadyGone = await seedPage({ added_by: "public", expires_at: ago(10) });
    const failing = await seedPage({ added_by: "public", expires_at: ago(5) });
    fetchMock.intercept({ method: "DELETE", url: monitorUrl(monitorOf(alreadyGone)), reply: { status: 404, json: { error: { code: "NOT_FOUND" } } } });
    fetchMock.intercept({ method: "DELETE", url: monitorUrl(monitorOf(failing)), reply: { status: 500, body: "upstream" } });

    let result!: Awaited<ReturnType<typeof runCron>>;
    const logged = await quietErrors(async () => (result = await runCron(env)));

    expect(result.expired).toBe(1);
    expect((await page(alreadyGone)).status).toBe("expired");
    expect((await page(failing)).status).toBe("active");
    expect(logged).toContain("http_500");

    fetchMock.intercept({ method: "DELETE", url: monitorUrl(monitorOf(failing)), reply: { status: 200, json: {} } });
    expect((await runCron(env)).expired).toBe(1);
    expect((await page(failing)).status).toBe("expired");
  });
});

// --- Health ----------------------------------------------------------------------------------

describe("health", () => {
  it("health marks a page failed when TinyFish reports its monitor paused", async () => {
    const paused = await seedPage();
    const fine = await seedPage();
    const pause = (list: MonitorEntry[]) => list.map((m) => (m.id === monitorOf(paused) ? { ...m, status: "paused" } : m));
    mockMonitors(pause, 1);

    expect(await runCron(env)).toEqual({ repaired: 0, expired: 0, unhealthy: [paused] });
    expect((await page(paused)).status).toBe("failed");
    expect((await page(fine)).status).toBe("active");

    // Health only flags: the Monitor running again does not un-fail the page.
    mockMonitors(undefined, 1);
    expect(await runCron(env)).toEqual({ repaired: 0, expired: 0, unhealthy: [] });
    expect((await page(paused)).status).toBe("failed");
  });

  it("a page whose monitor is missing from the list is marked failed; a monitor that belongs to no page is never touched", async () => {
    const missing = await seedPage();
    const fine = await seedPage();
    // Only active pages are checked: a paused page's Monitor may be missing too.
    const pausedPage = await seedPage({ status: "paused" });
    mockMonitors((list) => [
      ...list.filter((m) => m.id !== monitorOf(missing) && m.id !== monitorOf(pausedPage)),
      { id: "another-project-monitor", status: "paused", name: "not ours" },
    ]);

    expect((await runCron(env)).unhealthy).toEqual([missing]);

    expect((await page(missing)).status).toBe("failed");
    expect((await page(fine)).status).toBe("active");
    expect((await page(pausedPage)).status).toBe("paused");
    expect(callList()).toEqual([`GET ${MONITORS_API}`]); // nothing sent to any Monitor
  });

  it.each([
    ["an empty list", () => [] as MonitorEntry[]],
    ["only other projects' monitors", () => [{ id: "another-project-monitor", status: "active", name: "not ours" }]],
  ])("a list holding none of our monitors (%s) is not trusted: health is skipped and no page is failed", async (_name, edit) => {
    const a = await seedPage();
    const b = await seedPage();
    mockMonitors(edit);

    const logged = await quietErrors(async () => expect((await runCron(env)).unhealthy).toEqual([]));

    expect((await page(a)).status).toBe("active");
    expect((await page(b)).status).toBe("active");
    expect(logged).toContain("health");
  });
});

// --- The whole tick ------------------------------------------------------------------------

describe("runCron", () => {
  it("a failing step does not stop the others: listMonitors throws and runCron still resolves", async () => {
    mockFetchHtml();
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { status: 500, json: { error: { code: "INTERNAL" } } } });
    const repairable = await seedVersion(await seedPage(), { captured_at: ago(20) });
    const due = await seedPage({ added_by: "public", expires_at: ago(1) });
    await seedPage();
    fetchMock.intercept({ method: "DELETE", url: monitorUrl(monitorOf(due)), reply: { status: 200, json: {} } });

    let result: unknown;
    const logged = await quietErrors(async () => (result = await runCron(env)));

    expect(result).toEqual({ repaired: 1, expired: 1, unhealthy: [] });
    expect(await version(repairable)).toMatchObject({ capture_status: "complete" });
    expect((await page(due)).status).toBe("expired");
    expect(logged).toContain("INTERNAL");
    expect(logged).not.toContain("test-tinyfish-key");
    expect(log).toHaveBeenCalledWith("cron", { repaired: 1, expired: 1, unhealthy: 0 });
  });

  it("the scheduled handler hands runCron to waitUntil", async () => {
    mockMonitors();
    mockFetchHtml();
    const id = await seedVersion(await seedPage(), { captured_at: ago(20) });

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await version(id)).toMatchObject({ capture_status: "complete" });
    expect(log).toHaveBeenCalledWith("cron", { repaired: 1, expired: 0, unhealthy: 0 });
  });
});
