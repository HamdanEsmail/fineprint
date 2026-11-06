import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps, captureStatusFor, captureVersion, recordFactsResult, startNextFacts } from "../src/capture";
import { AGENT_MAX_DURATION_SECONDS, AGENT_MAX_STEPS, CAPTURE_MAX_ATTEMPTS, FACTS_PAUSE_USD, SPEND_PAUSE_USD } from "../src/core/limits";
import { PRICES, recordSpend } from "../src/core/spend";
import { insertPage } from "../src/db/pages";
import { getRunById, insertRun } from "../src/db/runs";
import type { PageKind, PageStatus, SpendRow, VersionRow } from "../src/db/types";
import { claimFactsSlot, getVersion, insertVersion, nextFactsCandidate, type NewVersion } from "../src/db/versions";
import worker from "../src/index";
import { FACTS_GOAL, FACTS_SCHEMA } from "../src/tinyfish/agent";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SECRET = "test-secret";
const FETCH_API = "https://api.fetch.tinyfish.ai/";
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const runUrl = (id: string) => `https://agent.tinyfish.ai/v1/runs/${id}?screenshots=none&html=none`;
const CALLBACK = `https://fineprint.test/hooks/agent/${SECRET}`;
const HTML = "<!doctype html><html><body><h1>Pro</h1><p>$20/mo.</p></body></html>";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);
const ITEMS = [
  { name: "Hobby", price: "$0", unit: "per month" },
  { name: "Pro", price: "$20", unit: "per month", notes: "For teams" },
];
// What parseFacts makes of ITEMS: absent unit and notes become null.
const FACTS = [
  { name: "Hobby", price: "$0", unit: "per month", notes: null },
  { name: "Pro", price: "$20", unit: "per month", notes: "For teams" },
];

// --- Seeding --------------------------------------------------------------------

let seq = 0;
const urlOf = (pageId: string) => `https://example.com/${pageId}`;

async function seedPage(kind: PageKind, status: PageStatus = "active"): Promise<string> {
  const id = `page-${++seq}`;
  await insertPage(env.DB, {
    id,
    url: urlOf(id),
    label: id,
    kind,
    monitor_id: `mon-${id}`,
    schedule_cron: "0 0,12 * * *",
    purpose: "watch",
    status,
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
  });
  return id;
}

type SeedOptions = Partial<NewVersion> & { judgment_relevant?: number | null; withRun?: boolean };

/** A version of the page with its run (a baseline unless `is_baseline: 0`). Returns the version id. */
async function seedVersion(pageId: string, over: SeedOptions = {}): Promise<string> {
  const { judgment_relevant = null, withRun = true, ...fields } = over;
  const id = `v-${++seq}`;
  const isBaseline = fields.is_baseline ?? 1;
  const runId = withRun ? `run-${id}` : null;
  if (runId !== null) {
    await insertRun(env.DB, {
      id: runId,
      page_id: pageId,
      monitor_run_id: `mrun-${id}`,
      outcome: isBaseline ? "baseline" : "changed",
      is_baseline: isBaseline,
      judgment_relevant,
      judgment_summary: null,
      diff_truncated: 0,
      noise_suppressed: 0,
      noise_reason: null,
      raw_key: null,
      received_at: "2026-11-01T00:00:00.000Z",
      trigger_kind: isBaseline ? "create" : "webhook",
    });
  }
  await insertVersion(env.DB, {
    id,
    page_id: pageId,
    run_id: runId,
    is_baseline: isBaseline,
    // Later seeds are later versions (the queue takes the oldest first).
    captured_at: new Date(Date.UTC(2026, 10, 1) + seq * 1000).toISOString(),
    text: "Pro $20/mo.",
    normalized_hash: "hash",
    judgment_summary: null,
    ...fields,
  });
  return id;
}

/** A version whose screenshot and source are stored after one attempt, queued for its facts. */
const STORED = {
  screenshot_key: "shots/s.jpg",
  html_key: "html/h.html",
  capture_status: "awaiting_facts",
  capture_attempts: 1,
} as const satisfies SeedOptions;

const version = async (id: string): Promise<VersionRow> => (await getVersion(env.DB, id))!;
const agentSteps = async () =>
  (await env.DB.prepare("SELECT * FROM spend WHERE kind = 'agent_step' ORDER BY rowid").all<SpendRow>()).results;

// --- TinyFish mocks ---------------------------------------------------------------

function mockFetchHtml(text = HTML): void {
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const url = (body as { urls: string[] }).urls[0];
      return Response.json({ results: [{ url, final_url: url, title: "Pricing", text }] });
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

const fetchCalls = () => fetchMock.calls.filter((c) => c.url === FETCH_API);
const runAsyncCalls = () => fetchMock.calls.filter((c) => c.url === RUN_ASYNC_API);
const automationCalls = () => fetchMock.calls.filter((c) => c.url.includes("/v1/automation"));

function agentCallback(body: unknown, secret = SECRET): Promise<Response> {
  return callWorker(`/hooks/agent/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// --- Setup ----------------------------------------------------------------------

let shot: MockInstance<typeof captureDeps.screenshotFullPage>;
let sleep: MockInstance<(ms: number) => Promise<void>>;

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
});

afterEach(() => {
  fetchMock.reset();
  shot.mockRestore();
  captureDeps.sleep = undefined;
});

// --- The status rule ------------------------------------------------------------

describe("captureStatusFor", () => {
  const row = (over: Partial<VersionRow>) => ({
    screenshot_key: null,
    html_key: null,
    facts_json: null,
    capture_attempts: 1,
    ...over,
  });
  const both = { screenshot_key: "shots/a.jpg", html_key: "html/a.html" };

  it.each([
    ["nothing tried yet", row({ capture_attempts: 0 }), false, "pending"],
    ["screenshot missing, under the cap", row({ html_key: "html/a.html" }), false, "partial"],
    ["source missing, under the cap", row({ screenshot_key: "shots/a.jpg", capture_attempts: 2 }), true, "partial"],
    ["screenshot missing at the cap", row({ html_key: "html/a.html", capture_attempts: CAPTURE_MAX_ATTEMPTS }), false, "failed"],
    ["both done, no facts needed", row(both), false, "complete"],
    ["both done, facts needed and stored", row({ ...both, facts_json: "[]" }), true, "complete"],
    ["both done, facts needed and missing", row(both), true, "awaiting_facts"],
    ["both done, facts missing at the cap", row({ ...both, capture_attempts: CAPTURE_MAX_ATTEMPTS }), true, "complete"],
    ["facts stored but screenshot missing", row({ html_key: "html/a.html", facts_json: "[]" }), true, "partial"],
  ] as const)("%s → %s", (_name, v, needsFacts, expected) => {
    expect(captureStatusFor(v, needsFacts)).toBe(expected);
  });
});

// --- captureVersion ----------------------------------------------------------------

describe("captureVersion", () => {
  it("captures screenshot and html for a policy page and marks complete without an Agent run", async () => {
    mockFetchHtml();
    const pageId = await seedPage("policy");
    const id = await seedVersion(pageId);

    await captureVersion(env, id);

    expect(await version(id)).toMatchObject({
      screenshot_key: `shots/${id}.jpg`,
      html_key: `html/${id}.html`,
      facts_json: null,
      agent_run_id: null,
      capture_status: "complete",
      capture_error: null,
      capture_attempts: 1,
    });
    const jpeg = await env.STORE.get(`shots/${id}.jpg`);
    expect(new Uint8Array(await jpeg!.arrayBuffer())).toEqual(JPEG);
    expect(jpeg!.httpMetadata?.contentType).toBe("image/jpeg");
    const html = await env.STORE.get(`html/${id}.html`);
    expect(await html!.text()).toBe(HTML);
    expect(html!.httpMetadata?.contentType).toBe("text/html; charset=utf-8");

    expect(shot).toHaveBeenCalledTimes(1);
    expect(shot.mock.calls[0]![1]).toBe(urlOf(pageId));
    expect(fetchCalls()).toHaveLength(1);
    expect(fetchCalls()[0]!.body).toMatchObject({ urls: [urlOf(pageId)], format: "html" });
    expect(automationCalls()).toEqual([]);
  });

  it("a pricing baseline starts a facts run with FACTS_GOAL, the schema and the callback url, status awaiting_facts", async () => {
    mockFetchHtml();
    mockRunAsync();
    const pageId = await seedPage("pricing");
    const id = await seedVersion(pageId);

    await captureVersion(env, id);

    expect(runAsyncCalls()).toHaveLength(1);
    expect(runAsyncCalls()[0]!.body).toEqual({
      url: urlOf(pageId),
      goal: FACTS_GOAL,
      browser_profile: "lite",
      agent_config: { max_steps: AGENT_MAX_STEPS, max_duration_seconds: AGENT_MAX_DURATION_SECONDS },
      output_schema: FACTS_SCHEMA,
      webhook_url: CALLBACK,
    });
    // The facts run starts after the screenshot and source are stored.
    const order = fetchMock.calls.map((c) => c.url);
    expect(order.indexOf(FETCH_API)).toBeLessThan(order.indexOf(RUN_ASYNC_API));
    expect(await version(id)).toMatchObject({
      screenshot_key: `shots/${id}.jpg`,
      html_key: `html/${id}.html`,
      facts_json: null,
      agent_run_id: "agent-run-1",
      capture_status: "awaiting_facts",
      capture_error: null,
      capture_attempts: 1,
    });
  });

  it("a fees page needs facts too, and so does a later version whose run has no judgment; a version judged not relevant does not", async () => {
    mockFetchHtml();
    mockRunAsync();
    const pricing = await seedPage("pricing");
    const notRelevant = await seedVersion(pricing, { is_baseline: 0, judgment_relevant: 0 });
    await captureVersion(env, notRelevant);
    expect(await version(notRelevant)).toMatchObject({ capture_status: "complete", agent_run_id: null });
    expect(runAsyncCalls()).toEqual([]);

    const fees = await seedPage("fees");
    const noJudgment = await seedVersion(fees, { is_baseline: 0, judgment_relevant: null });
    await captureVersion(env, noJudgment);
    expect(await version(noJudgment)).toMatchObject({ capture_status: "awaiting_facts", agent_run_id: "agent-run-1" });
    expect(runAsyncCalls()[0]!.body).toMatchObject({ url: urlOf(fees) });
  });

  it("screenshot failure leaves html captured, status partial, capture_error names screenshot; third attempt marks failed", async () => {
    mockFetchHtml();
    shot.mockRejectedValue(new Error("CDP timeout: Page.navigate"));
    const pageId = await seedPage("policy");
    const id = await seedVersion(pageId);

    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({
      screenshot_key: null,
      html_key: `html/${id}.html`,
      capture_status: "partial",
      capture_error: "screenshot: cdp_failed (CDP timeout: Page.navigate)",
      capture_attempts: 1,
    });
    expect(await env.STORE.get(`html/${id}.html`)).not.toBeNull();

    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({ capture_status: "partial", capture_attempts: 2 });

    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({
      screenshot_key: null,
      html_key: `html/${id}.html`,
      capture_status: "failed",
      capture_error: "screenshot: cdp_failed (CDP timeout: Page.navigate)",
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
    });
    expect(shot).toHaveBeenCalledTimes(3);
    expect(fetchCalls()).toHaveLength(1); // the source was never fetched again
  });

  it("source failures are recorded by code: an error entry, an HTTP failure and an empty page", async () => {
    const pageId = await seedPage("policy");
    const id = await seedVersion(pageId);

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: { results: [], errors: [{ error: { code: "TIMEOUT" } }] } } });
    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({
      screenshot_key: `shots/${id}.jpg`,
      html_key: null,
      capture_status: "partial",
      capture_error: "source: TIMEOUT",
    });

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { status: 500, body: "upstream exploded with secrets" } });
    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({ capture_status: "partial", capture_error: "source: http_500" });

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: { results: [{ text: "  \n " }] } } });
    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({ capture_status: "failed", capture_error: "source: empty_page", capture_attempts: 3 });
    expect(shot).toHaveBeenCalledTimes(1); // the screenshot was kept from the first attempt
  });

  it("both captures failing are both named", async () => {
    shot.mockRejectedValue(new Error("TinyBrowser returned no cdp_url"));
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { status: 402, json: { error: { code: "PAYMENT_REQUIRED" } } } });
    const id = await seedVersion(await seedPage("rules"));

    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({
      capture_status: "partial",
      capture_error: "screenshot: cdp_failed (TinyBrowser returned no cdp_url); source: PAYMENT_REQUIRED",
    });
  });

  it("runs the screenshot and the source at the same time and writes each the moment it finishes", async () => {
    mockFetchHtml();
    const id = await seedVersion(await seedPage("policy"));
    // The screenshot finishes only once the source is already stored in D1: a pipeline that ran the
    // two in turn, or wrote both at the end, would never see it.
    let sawSourceFirst = false;
    shot.mockImplementation(async () => {
      for (let i = 0; i < 200 && !sawSourceFirst; i++) {
        sawSourceFirst = (await version(id)).html_key !== null;
        if (!sawSourceFirst) await new Promise((r) => setTimeout(r, 10));
      }
      return { bytes: JPEG.slice().buffer, height: 1200, sessionId: "sess-1" };
    });

    await captureVersion(env, id);
    expect(sawSourceFirst).toBe(true);
    expect(await version(id)).toMatchObject({ capture_status: "complete" });
  });

  it("a repeat captureVersion on a version with both keys calls neither TinyBrowser nor TinyFetch and uses no attempt", async () => {
    const policy = await seedVersion(await seedPage("policy"), {
      screenshot_key: "shots/x.jpg",
      html_key: "html/x.html",
      capture_status: "complete",
      capture_attempts: 1,
    });
    const pricing = await seedVersion(await seedPage("pricing"), {
      screenshot_key: "shots/y.jpg",
      html_key: "html/y.html",
      facts_json: JSON.stringify(FACTS),
      agent_run_id: "agent-run-old",
      capture_status: "complete",
      capture_attempts: 1,
    });

    await captureVersion(env, policy);
    await captureVersion(env, pricing);

    expect(shot).not.toHaveBeenCalled();
    expect(fetchMock.calls).toEqual([]);
    expect(await version(policy)).toMatchObject({ capture_status: "complete", capture_attempts: 1 });
    expect(await version(pricing)).toMatchObject({ capture_status: "complete", capture_attempts: 1 });
  });

  it("when only facts are outstanding it queues them without using an attempt", async () => {
    mockRunAsync();
    const id = await seedVersion(await seedPage("pricing"), {
      screenshot_key: "shots/z.jpg",
      html_key: "html/z.html",
      capture_status: "partial",
      capture_attempts: 2,
    });

    await captureVersion(env, id);

    expect(shot).not.toHaveBeenCalled();
    expect(fetchCalls()).toEqual([]);
    expect(runAsyncCalls()).toHaveLength(1);
    expect(await version(id)).toMatchObject({ capture_status: "awaiting_facts", capture_attempts: 2, agent_run_id: "agent-run-1" });
  });

  it("captures are skipped with spend_paused when the ledger is at $8", async () => {
    await recordSpend(env.DB, "monitor_check", SPEND_PAUSE_USD, "ledger");
    const id = await seedVersion(await seedPage("pricing"));

    await captureVersion(env, id);

    expect(await version(id)).toMatchObject({
      screenshot_key: null,
      html_key: null,
      agent_run_id: null,
      capture_status: "pending",
      capture_error: "spend_paused",
      capture_attempts: 0,
    });
    expect(shot).not.toHaveBeenCalled();
    expect(fetchMock.calls).toEqual([]);
    expect(await startNextFacts(env)).toBe(false);
    expect(fetchMock.calls).toEqual([]);
  });

  it("from the facts pause ($6) no facts run starts and the version stays queued; captures go on until the $8 pause", async () => {
    expect(FACTS_PAUSE_USD).toBe(6);
    mockFetchHtml();
    mockRunAsync();
    await recordSpend(env.DB, "monitor_check", FACTS_PAUSE_USD, "ledger");
    const queued = await seedVersion(await seedPage("pricing"), STORED);
    const fresh = await seedVersion(await seedPage("pricing"));

    expect(await startNextFacts(env)).toBe(false);
    expect(runAsyncCalls()).toEqual([]);
    expect(await version(queued)).toMatchObject({ agent_run_id: null, capture_status: "awaiting_facts", capture_error: null, capture_attempts: 1 });

    // A capture still takes its screenshot and source (the $8 pause is not reached); only its facts wait.
    await captureVersion(env, fresh);
    expect(shot).toHaveBeenCalledTimes(1);
    expect(fetchCalls()).toHaveLength(1);
    expect(runAsyncCalls()).toEqual([]);
    expect(await version(fresh)).toMatchObject({
      screenshot_key: `shots/${fresh}.jpg`,
      html_key: `html/${fresh}.html`,
      capture_status: "awaiting_facts",
      capture_error: null,
      capture_attempts: 1,
      agent_run_id: null,
    });
    // Nothing was marked failed, and both versions are still queued, oldest first.
    expect((await nextFactsCandidate(env.DB))?.id).toBe(queued);
  });

  it("just under the facts pause ($5.99) the oldest queued version's facts run starts", async () => {
    mockRunAsync();
    await recordSpend(env.DB, "monitor_check", FACTS_PAUSE_USD - 0.01, "ledger");
    const id = await seedVersion(await seedPage("pricing"), STORED);

    expect(await startNextFacts(env)).toBe(true);

    expect(runAsyncCalls()).toHaveLength(1);
    expect(await version(id)).toMatchObject({ agent_run_id: "agent-run-1" });
  });

  it("a run in flight when the facts pause is reached is still recorded, and the next queued version does not start", async () => {
    mockRunAsync();
    await recordSpend(env.DB, "monitor_check", FACTS_PAUSE_USD, "ledger");
    const running = await seedVersion(await seedPage("pricing"), { ...STORED, agent_run_id: "agent-run-X" });
    const waiting = await seedVersion(await seedPage("pricing"), STORED);

    await recordFactsResult(env, "agent-run-X", "COMPLETED", { items: ITEMS }, 3);

    expect(await version(running)).toMatchObject({ capture_status: "complete", facts_json: JSON.stringify(FACTS) });
    expect(await agentSteps()).toMatchObject([{ ref: "agent-run-X" }]);
    expect(runAsyncCalls()).toEqual([]);
    expect(await version(waiting)).toMatchObject({ agent_run_id: null, capture_status: "awaiting_facts", capture_error: null, capture_attempts: 1 });
  });

  it("an unknown version id does nothing and does not throw", async () => {
    await expect(captureVersion(env, "no-such-version")).resolves.toBeUndefined();
    expect(fetchMock.calls).toEqual([]);
  });

  it("stores only the code of a TinyFish error, never its text", async () => {
    mockFetchHtml();
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: { status: 400, json: { error: { code: "INVALID_INPUT", message: `bad webhook_url ${CALLBACK}` } } },
    });
    const id = await seedVersion(await seedPage("pricing"));

    await captureVersion(env, id);

    const v = await version(id);
    expect(v).toMatchObject({ agent_run_id: null, capture_error: "facts: INVALID_INPUT", capture_attempts: 2 });
    expect(v.capture_error).not.toContain(SECRET);
  });

  it("a pricing version whose screenshot needed every attempt is complete with facts unavailable, and says the facts were never run", async () => {
    mockFetchHtml();
    mockRunAsync();
    shot.mockRejectedValueOnce(new Error("CDP timeout: Page.navigate")).mockRejectedValueOnce(new Error("CDP timeout: Page.navigate"));
    const id = await seedVersion(await seedPage("pricing"));
    // Hold the facts slot so the first two captures cannot start a run for this version.
    const blocker = await seedVersion(await seedPage("pricing"), { agent_run_id: "agent-run-busy", screenshot_key: "s", html_key: "h" });

    await captureVersion(env, id);
    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({ capture_status: "partial", capture_attempts: 2, agent_run_id: null });
    await env.DB.prepare("UPDATE versions SET agent_run_id = NULL WHERE id = ?").bind(blocker).run();

    await captureVersion(env, id);

    // The attempt counter is shared by all three captures: at the cap, facts can no longer be started.
    expect(await version(id)).toMatchObject({
      screenshot_key: `shots/${id}.jpg`,
      html_key: `html/${id}.html`,
      capture_status: "complete",
      facts_status: "unavailable",
      capture_error: "facts: no_attempts_left",
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
    });
    expect(runAsyncCalls().map((c) => (c.body as Json).url)).not.toContain(urlOf((await version(id)).page_id));
  });
});

// --- The facts queue ---------------------------------------------------------------

describe("the facts queue", () => {
  it("two pricing versions needing facts start exactly one Agent run; completing it starts the second", async () => {
    mockFetchHtml();
    mockRunAsync();
    const first = await seedPage("pricing");
    const second = await seedPage("fees");
    const v1 = await seedVersion(first, { captured_at: "2026-11-01T00:00:00.000Z" });
    const v2 = await seedVersion(second, { captured_at: "2026-11-02T00:00:00.000Z" });

    await Promise.all([captureVersion(env, v1), captureVersion(env, v2)]);

    expect(runAsyncCalls()).toHaveLength(1);
    expect(runAsyncCalls()[0]!.body).toMatchObject({ url: urlOf(first) });
    expect(await version(v1)).toMatchObject({ capture_status: "awaiting_facts", agent_run_id: "agent-run-1" });
    expect(await version(v2)).toMatchObject({ capture_status: "awaiting_facts", agent_run_id: null }); // queued

    const res = await agentCallback({ run_id: "agent-run-1", status: "COMPLETED", num_of_steps: 4, result: { items: ITEMS } });
    expect(res.status).toBe(200);

    expect(await version(v1)).toMatchObject({ capture_status: "complete", facts_json: JSON.stringify(FACTS) });
    expect(runAsyncCalls()).toHaveLength(2);
    expect(runAsyncCalls()[1]!.body).toMatchObject({ url: urlOf(second) });
    expect(await version(v2)).toMatchObject({ capture_status: "awaiting_facts", agent_run_id: "agent-run-2" });
    expect(await startNextFacts(env)).toBe(false); // the slot is taken again
    expect(runAsyncCalls()).toHaveLength(2);
  });

  it("a claim: token present blocks any start", async () => {
    mockFetchHtml();
    mockRunAsync();
    await seedVersion(await seedPage("pricing"), { agent_run_id: "claim:2026-11-03T00:00:00.000Z" });
    const id = await seedVersion(await seedPage("pricing"));

    await captureVersion(env, id);

    expect(runAsyncCalls()).toEqual([]);
    expect(await version(id)).toMatchObject({ capture_status: "awaiting_facts", agent_run_id: null });
    expect(await startNextFacts(env)).toBe(false);
    expect(await claimFactsSlot(env.DB, id, "claim:now")).toBe(false);
    expect(runAsyncCalls()).toEqual([]);
  });

  it("a rate-limited start gives the slot back at once: one try, no wait, no attempt used, still queued", async () => {
    mockFetchHtml();
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 429, body: "slow down" } });
    const id = await seedVersion(await seedPage("pricing"));

    // A capture runs in waitUntil, which is cut about 30 s after the response: it never waits
    // out a rate limit (60 s a try), so it cannot die holding a claim.
    await captureVersion(env, id);

    expect(runAsyncCalls()).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(await version(id)).toMatchObject({
      screenshot_key: `shots/${id}.jpg`,
      html_key: `html/${id}.html`,
      agent_run_id: null,
      capture_status: "awaiting_facts",
      capture_error: "facts: rate_limited",
      capture_attempts: 1, // the capture's attempt only
    });

    // Still queued: the next start takes it.
    mockRunAsync();
    expect(await startNextFacts(env)).toBe(true);
    expect(await version(id)).toMatchObject({ agent_run_id: "agent-run-1", capture_status: "awaiting_facts" });
  });

  it("with waitOnRateLimit (the cron) a start waits 60 s between tries and, still limited after three retries, gives the slot back with no attempt used", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, times: 4, reply: { status: 429, body: "slow down" } });
    const id = await seedVersion(await seedPage("pricing"), STORED);

    expect(await startNextFacts(env, { waitOnRateLimit: true })).toBe(false);

    expect(runAsyncCalls()).toHaveLength(4);
    expect(sleep.mock.calls).toEqual([[60_000], [60_000], [60_000]]);
    expect(await version(id)).toMatchObject({
      agent_run_id: null,
      capture_status: "awaiting_facts",
      capture_error: "facts: rate_limited",
      capture_attempts: 1,
    });
  });

  it("with waitOnRateLimit a start that gets through after a wait takes the slot", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 429, body: "slow down" } });
    mockRunAsync();
    const id = await seedVersion(await seedPage("pricing"), STORED);

    expect(await startNextFacts(env, { waitOnRateLimit: true })).toBe(true);

    expect(runAsyncCalls()).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(await version(id)).toMatchObject({ agent_run_id: "agent-run-1", capture_status: "awaiting_facts", capture_attempts: 1 });
  });

  it.each([
    ["the request fails with no answer", () => Promise.reject(new TypeError("Network connection lost.")), "request_failed"],
    ["TinyAgent answers 200 without a run id", () => Response.json({ status: "PENDING" }), "no_run_id"],
  ])("when %s a run may exist: the claim is kept for the sweep, an attempt is used, and nothing else starts", async (_name, reply, code) => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, times: Infinity, reply });
    const id = await seedVersion(await seedPage("pricing"), STORED);
    const behind = await seedVersion(await seedPage("fees"), STORED);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await startNextFacts(env)).toBe(false);
      expect(await startNextFacts(env)).toBe(false); // the kept claim still holds the slot
    } finally {
      error.mockRestore();
    }

    const v = await version(id);
    expect(v.agent_run_id).toMatch(/^claim:/);
    expect(v).toMatchObject({ capture_status: "awaiting_facts", capture_error: `facts: ${code}`, capture_attempts: 2 });
    expect(await version(behind)).toMatchObject({ agent_run_id: null, capture_attempts: 1 });
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("a start that fails for another reason uses an attempt: at the cap the version is complete with facts unavailable and never started again", async () => {
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      times: Infinity,
      reply: { status: 400, json: { error: { code: "INVALID_INPUT" } } },
    });
    const id = await seedVersion(await seedPage("pricing"), {
      screenshot_key: "shots/s.jpg",
      html_key: "html/h.html",
      capture_status: "awaiting_facts",
      capture_attempts: CAPTURE_MAX_ATTEMPTS - 1,
    });

    expect(await startNextFacts(env)).toBe(false);
    expect(await version(id)).toMatchObject({
      agent_run_id: null,
      capture_status: "complete",
      facts_status: "unavailable",
      capture_error: "facts: INVALID_INPUT",
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
    });
    expect(sleep).not.toHaveBeenCalled(); // not a rate limit: no wait, no retry

    expect(await startNextFacts(env)).toBe(false);
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("a pricing baseline whose facts run fails keeps its screenshot and source and says facts failed; FAILED re-queues and the third attempt makes the facts unavailable", async () => {
    mockFetchHtml();
    mockRunAsync();
    const id = await seedVersion(await seedPage("pricing"));
    await captureVersion(env, id); // attempt 1: screenshot and source; facts run agent-run-1

    expect((await agentCallback({ run_id: "agent-run-1", status: "FAILED", num_of_steps: 2 })).status).toBe(200);
    // Attempt 2 failed and the version went straight back into the (empty) queue: agent-run-2.
    expect(await version(id)).toMatchObject({
      screenshot_key: `shots/${id}.jpg`,
      html_key: `html/${id}.html`,
      facts_json: null,
      agent_run_id: "agent-run-2",
      capture_status: "awaiting_facts",
      capture_error: "facts: FAILED",
      capture_attempts: 2,
    });

    expect((await agentCallback({ run_id: "agent-run-2", status: "CANCELLED", num_of_steps: 1 })).status).toBe(200);
    expect(await version(id)).toMatchObject({
      screenshot_key: `shots/${id}.jpg`,
      html_key: `html/${id}.html`,
      facts_json: null,
      agent_run_id: null,
      capture_status: "complete",
      facts_status: "unavailable",
      capture_error: "facts: CANCELLED",
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
    });
    expect(runAsyncCalls()).toHaveLength(2); // a failed version is never started again
    expect(await env.STORE.get(`shots/${id}.jpg`)).not.toBeNull();
    expect(await env.STORE.get(`html/${id}.html`)).not.toBeNull();
    // Both runs were billed for their steps.
    expect((await agentSteps()).map((s) => [s.ref, s.amount_usd])).toEqual([
      ["agent-run-1", PRICES.agent_step * 2],
      ["agent-run-2", PRICES.agent_step * 1],
    ]);
  });

  it("a facts failure keeps the screenshot's error alongside its own", async () => {
    mockFetchHtml();
    mockRunAsync();
    shot.mockRejectedValue(new Error("CDP timeout: Page.navigate"));
    const id = await seedVersion(await seedPage("pricing"));
    await captureVersion(env, id); // screenshot fails; source stored; facts run agent-run-1

    await recordFactsResult(env, "agent-run-1", "COMPLETED", { plans: [] }, 3);
    expect(await version(id)).toMatchObject({
      capture_status: "partial",
      capture_error: "screenshot: cdp_failed (CDP timeout: Page.navigate); facts: unparseable",
      capture_attempts: 2,
    });
  });

  it("an empty facts list is a failure, and a later success clears the facts error", async () => {
    mockFetchHtml();
    mockRunAsync();
    const id = await seedVersion(await seedPage("pricing"));
    await captureVersion(env, id);

    await recordFactsResult(env, "agent-run-1", "COMPLETED", { items: [] }, 2);
    expect(await version(id)).toMatchObject({ capture_error: "facts: empty", agent_run_id: "agent-run-2", capture_attempts: 2 });

    await recordFactsResult(env, "agent-run-2", "COMPLETED", { items: ITEMS }, 3);
    expect(await version(id)).toMatchObject({
      facts_json: JSON.stringify(FACTS),
      agent_run_id: "agent-run-2",
      capture_status: "complete",
      capture_error: null,
      capture_attempts: 2,
    });
  });

  it("nextFactsCandidate takes the oldest version that still needs facts", async () => {
    const pricing = await seedPage("pricing");
    const policy = await seedPage("policy");
    await seedVersion(policy, { captured_at: "2026-10-01T00:00:00.000Z" }); // not a pricing page
    await seedVersion(pricing, { captured_at: "2026-10-02T00:00:00.000Z", facts_json: "[]" }); // has facts
    await seedVersion(pricing, { captured_at: "2026-10-03T00:00:00.000Z", capture_status: "failed" });
    await seedVersion(pricing, { captured_at: "2026-10-04T00:00:00.000Z", capture_attempts: CAPTURE_MAX_ATTEMPTS });
    await seedVersion(pricing, { captured_at: "2026-10-05T00:00:00.000Z", is_baseline: 0, judgment_relevant: 0 });
    const wanted = await seedVersion(pricing, { captured_at: "2026-10-06T00:00:00.000Z", is_baseline: 0, judgment_relevant: 1 });
    await seedVersion(pricing, { captured_at: "2026-10-07T00:00:00.000Z" });

    expect(await nextFactsCandidate(env.DB)).toMatchObject({ id: wanted, url: urlOf(pricing) });

    // A baseline seeded without a run counts as needing facts.
    await env.DB.prepare("DELETE FROM versions").run();
    const orphan = await seedVersion(pricing, { withRun: false });
    expect(await nextFactsCandidate(env.DB)).toMatchObject({ id: orphan });
  });

  it("nextFactsCandidate skips versions of expired pages", async () => {
    const expired = await seedPage("pricing", "expired");
    const paused = await seedPage("fees", "paused");
    await seedVersion(expired, { captured_at: "2026-10-01T00:00:00.000Z" });
    const wanted = await seedVersion(paused, { captured_at: "2026-10-02T00:00:00.000Z" });

    expect(await nextFactsCandidate(env.DB)).toMatchObject({ id: wanted });
    await env.DB.prepare("DELETE FROM versions WHERE id = ?").bind(wanted).run();
    expect(await nextFactsCandidate(env.DB)).toBeNull();
  });

  it("a second settlement of a failed run never clears or counts the run that started after it", async () => {
    mockRunAsync();
    const id = await seedVersion(await seedPage("pricing"), { ...STORED, agent_run_id: "agent-run-X" });
    // Another settlement of agent-run-X lands between this one's read and its write: it failed the
    // run (attempt 2) and the chain started agent-run-Y. The step-spend insert is the one write in
    // between, so a trigger on it plays that other settlement.
    await env.DB.prepare(
      `CREATE TRIGGER other_settlement AFTER INSERT ON spend WHEN NEW.ref = 'agent-run-X'
       BEGIN UPDATE versions SET agent_run_id = 'agent-run-Y', capture_attempts = 2, capture_error = 'facts: FAILED'
       WHERE id = '${id}'; END`,
    ).run();

    await recordFactsResult(env, "agent-run-X", "FAILED", null, 2);

    expect(await version(id)).toMatchObject({
      agent_run_id: "agent-run-Y",
      capture_status: "awaiting_facts",
      capture_error: "facts: FAILED",
      capture_attempts: 2,
    });
    expect(runAsyncCalls()).toEqual([]); // never a second run in flight
  });

  it("a failed start gives back only its own claim", async () => {
    const id = await seedVersion(await seedPage("pricing"), STORED);
    // While TinyAgent answers, the claim is released (the cron's sweep) and another start takes the slot.
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: async () => {
        await env.DB.prepare("UPDATE versions SET agent_run_id = 'claim:other' WHERE id = ?").bind(id).run();
        return Response.json({ error: { code: "INVALID_INPUT" } }, { status: 400 });
      },
    });

    expect(await startNextFacts(env)).toBe(false);
    expect(await version(id)).toMatchObject({ agent_run_id: "claim:other", capture_error: null, capture_attempts: 1 });
  });

  it("a started run is recorded only while its claim still holds the slot", async () => {
    const id = await seedVersion(await seedPage("pricing"), STORED);
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: async () => {
        await env.DB.prepare("UPDATE versions SET agent_run_id = 'claim:other' WHERE id = ?").bind(id).run();
        return Response.json({ run_id: "agent-run-late" });
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await startNextFacts(env)).toBe(false);
      expect(error.mock.calls.flat().join(" ")).toContain("agent-run-late");
    } finally {
      error.mockRestore();
    }
    expect(await version(id)).toMatchObject({ agent_run_id: "claim:other", capture_attempts: 1 });
  });

  it("a facts result that lands while the capture writes its status still leaves the version complete", async () => {
    mockFetchHtml();
    mockRunAsync();
    const id = await seedVersion(await seedPage("pricing"));
    // The capture works out awaiting_facts from a read taken before the facts landed; the trigger
    // stores the facts at the moment that status is written, as a facts result racing it would.
    await env.DB.prepare(
      `CREATE TRIGGER facts_land AFTER UPDATE OF capture_status ON versions
       WHEN NEW.capture_status = 'awaiting_facts' AND NEW.facts_json IS NULL
       BEGIN UPDATE versions SET facts_json = '${JSON.stringify(FACTS)}' WHERE id = NEW.id; END`,
    ).run();

    await captureVersion(env, id);

    expect(await version(id)).toMatchObject({ facts_json: JSON.stringify(FACTS), capture_status: "complete" });
    expect(runAsyncCalls()).toEqual([]);
  });

  it("parallel capture attempts are all counted", async () => {
    mockFetchHtml();
    shot.mockRejectedValue(new Error("CDP timeout: Page.navigate"));
    const id = await seedVersion(await seedPage("policy"));

    await Promise.all([captureVersion(env, id), captureVersion(env, id)]);

    expect(await version(id)).toMatchObject({ capture_attempts: 2, capture_status: "partial" });
  });

  it("claimFactsSlot is one atomic claim: only one of several parallel claims wins", async () => {
    const pricing = await seedPage("pricing");
    const ids = [await seedVersion(pricing), await seedVersion(pricing), await seedVersion(pricing)];

    const won = await Promise.all(ids.map((id, i) => claimFactsSlot(env.DB, id, `claim:${i}`)));
    expect(won.filter(Boolean)).toHaveLength(1);
    // Facts stored on the winner free the slot even though it keeps its run id.
    const winner = ids[won.indexOf(true)]!;
    await env.DB.prepare("UPDATE versions SET facts_json = '[]' WHERE id = ?").bind(winner).run();
    expect(await claimFactsSlot(env.DB, ids.find((id) => id !== winner)!, "claim:again")).toBe(true);
  });

  it("getRunById reads a run row", async () => {
    const id = await seedVersion(await seedPage("pricing"), { is_baseline: 0, judgment_relevant: 0 });
    expect(await getRunById(env.DB, `run-${id}`)).toMatchObject({ id: `run-${id}`, judgment_relevant: 0 });
    expect(await getRunById(env.DB, "nope")).toBeNull();
  });
});

// --- POST /hooks/agent/:secret --------------------------------------------------------

describe("POST /hooks/agent/:secret", () => {
  async function inFlight(): Promise<string> {
    mockFetchHtml();
    mockRunAsync();
    const id = await seedVersion(await seedPage("pricing"));
    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({ agent_run_id: "agent-run-1" });
    return id;
  }

  it("agent callback with COMPLETED result stores facts and completes; spend has one agent_step row and a duplicate writes no second", async () => {
    const id = await inFlight();

    const res = await agentCallback({ run_id: "agent-run-1", status: "COMPLETED", num_of_steps: 4, result: { items: ITEMS } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await version(id)).toMatchObject({
      facts_json: JSON.stringify(FACTS),
      agent_run_id: "agent-run-1",
      capture_status: "complete",
      capture_error: null,
      capture_attempts: 1,
    });
    const steps = await agentSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ ref: "agent-run-1" });
    expect(steps[0]!.amount_usd).toBeCloseTo(PRICES.agent_step * 4, 10);

    const again = await agentCallback({ run_id: "agent-run-1", status: "COMPLETED", num_of_steps: 4, result: { items: ITEMS } });
    expect(again.status).toBe(200);
    expect(await agentSteps()).toHaveLength(1);
    expect(await version(id)).toMatchObject({ facts_json: JSON.stringify(FACTS), capture_status: "complete", capture_attempts: 1 });
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("fetches the run when the callback carries no result", async () => {
    const id = await inFlight();
    fetchMock.intercept({
      method: "GET",
      url: runUrl("agent-run-1"),
      reply: { json: { run_id: "agent-run-1", status: "COMPLETED", num_of_steps: 3, result: { items: ITEMS } } },
    });

    const res = await agentCallback({ run_id: "agent-run-1", status: "COMPLETED" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await version(id)).toMatchObject({ facts_json: JSON.stringify(FACTS), capture_status: "complete" });
    expect((await agentSteps()).map((s) => s.ref)).toEqual(["agent-run-1"]);
    expect((await agentSteps())[0]!.amount_usd).toBeCloseTo(PRICES.agent_step * 3, 10);
  });

  it("answers 200 at once and settles the run in waitUntil, then starts the next queued version", async () => {
    // agent-run-1 is in flight; a fees version is queued behind it.
    const first = await seedVersion(await seedPage("pricing"), { ...STORED, agent_run_id: "agent-run-1" });
    const queued = await seedVersion(await seedPage("fees"), STORED);
    // Starting the queued version takes until the test lets TinyAgent answer.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: async () => {
        await gate;
        return Response.json({ run_id: "agent-run-2" });
      },
    });
    // vi.mock does not work in this pool: hand the Worker an execution context that keeps its waitUntil work.
    const scheduled: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (work: Promise<unknown>) => void scheduled.push(work),
      passThroughOnException() {},
    } as unknown as ExecutionContext;

    const res = await worker.fetch(
      new Request(`https://fineprint.test/hooks/agent/${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: "agent-run-1", status: "COMPLETED", num_of_steps: 4, result: { items: ITEMS } }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(scheduled).toHaveLength(1);
    let settled = false;
    void scheduled[0]!.then(() => (settled = true));

    // After the response: the facts are stored, and the next start holds the slot while TinyAgent answers.
    await vi.waitFor(() => expect(runAsyncCalls()).toHaveLength(1));
    expect(settled).toBe(false);
    expect(await version(first)).toMatchObject({ facts_json: JSON.stringify(FACTS), capture_status: "complete" });
    expect((await version(queued)).agent_run_id).toMatch(/^claim:/);

    release();
    await Promise.allSettled(scheduled);
    expect(settled).toBe(true);
    expect(await version(queued)).toMatchObject({ agent_run_id: "agent-run-2", capture_status: "awaiting_facts", capture_attempts: 1 });
  });

  it("a rate-limited start chained from the callback gives the slot back at once instead of waiting in waitUntil", async () => {
    const first = await seedVersion(await seedPage("pricing"), { ...STORED, agent_run_id: "agent-run-1" });
    const queued = await seedVersion(await seedPage("fees"), STORED);
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, times: Infinity, reply: { status: 429, body: "busy" } });

    const res = await agentCallback({ run_id: "agent-run-1", status: "COMPLETED", num_of_steps: 4, result: { items: ITEMS } });

    expect(res.status).toBe(200);
    expect(await version(first)).toMatchObject({ facts_json: JSON.stringify(FACTS), capture_status: "complete" });
    expect(runAsyncCalls()).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(await version(queued)).toMatchObject({
      agent_run_id: null,
      capture_status: "awaiting_facts",
      capture_error: "facts: rate_limited",
      capture_attempts: 1,
    });
  });

  it("a failed run fetch leaves the run in flight for the cron to settle", async () => {
    const id = await inFlight();
    fetchMock.intercept({ method: "GET", url: runUrl("agent-run-1"), reply: { status: 503, body: "busy" } });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await agentCallback({ run_id: "agent-run-1", status: "COMPLETED" });
      expect(res.status).toBe(200);
    } finally {
      error.mockRestore();
    }
    expect(await version(id)).toMatchObject({ agent_run_id: "agent-run-1", capture_status: "awaiting_facts", capture_attempts: 1 });
  });

  it("wrong secret is 404 with an empty body and changes nothing", async () => {
    const id = await inFlight();
    for (const secret of ["wrong", "test-secre", "test-secret-and-more"]) {
      const res = await agentCallback({ run_id: "agent-run-1", status: "COMPLETED", result: { items: ITEMS } }, secret);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
    expect(await version(id)).toMatchObject({ facts_json: null, agent_run_id: "agent-run-1" });
  });

  it.each([
    ["not JSON", "this is not json"],
    ["a JSON array", "[]"],
    ["no run_id", JSON.stringify({ status: "COMPLETED" })],
    ["a numeric run_id", JSON.stringify({ run_id: 5, status: "COMPLETED" })],
    ["no status", JSON.stringify({ run_id: "agent-run-1" })],
    ["a running run", JSON.stringify({ run_id: "agent-run-1", status: "RUNNING" })],
    ["a pending run", JSON.stringify({ run_id: "agent-run-1", status: "PENDING" })],
  ])("%s is 200 ignored and changes nothing", async (_name, body) => {
    const id = await inFlight();
    const res = await agentCallback(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(await version(id)).toMatchObject({ facts_json: null, agent_run_id: "agent-run-1", capture_attempts: 1 });
    expect(await agentSteps()).toEqual([]);
  });

  it("an unknown run id is 200 and changes nothing", async () => {
    const id = await inFlight();
    const res = await agentCallback({ run_id: "someone-else", status: "COMPLETED", num_of_steps: 2, result: { items: ITEMS } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await version(id)).toMatchObject({ facts_json: null, agent_run_id: "agent-run-1" });
    expect(await agentSteps()).toEqual([]);
  });
});

// --- GET /shots/:name and /sources/:name -----------------------------------------------

describe("stored objects", () => {
  it("GET /shots/:key serves image/jpeg with immutable cache headers and 404s when missing", async () => {
    await env.STORE.put("shots/abc-123.jpg", JPEG, { httpMetadata: { contentType: "image/jpeg" } });
    await env.STORE.put("html/abc-123.html", HTML, { httpMetadata: { contentType: "text/html; charset=utf-8" } });

    const jpeg = await callWorker("/shots/abc-123.jpg");
    expect(jpeg.status).toBe(200);
    expect(jpeg.headers.get("content-type")).toBe("image/jpeg");
    expect(jpeg.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await jpeg.arrayBuffer())).toEqual(JPEG);

    const html = await callWorker("/sources/abc-123.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await html.text()).toBe(HTML);

    const missing = await callWorker("/shots/missing.jpg");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect((await callWorker("/sources/missing.html")).status).toBe(404);
  });

  it("serves stored objects as inert content: sandboxed, never sniffed into another type", async () => {
    // A captured page is someone else's HTML: on our origin it must not run scripts or be read as a page of ours.
    await env.STORE.put("shots/abc-123.jpg", JPEG, { httpMetadata: { contentType: "image/jpeg" } });
    await env.STORE.put("html/abc-123.html", "<script>alert(1)</script>", { httpMetadata: { contentType: "text/html; charset=utf-8" } });

    for (const path of ["/sources/abc-123.html", "/shots/abc-123.jpg"]) {
      const res = await callWorker(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it.each([
    "/shots/abc-123.html",
    "/sources/abc-123.jpg",
    "/shots/abc_123.jpg",
    "/shots/abc.123.jpg",
    "/shots/..%2Fraw%2Fx.json",
    "/sources/..%2Fshots%2Fabc-123.jpg",
    "/shots/abc-123.JPG",
  ])("%s is 404 not_found", async (path) => {
    await env.STORE.put("shots/abc-123.jpg", JPEG, { httpMetadata: { contentType: "image/jpeg" } });
    await env.STORE.put("html/abc-123.html", HTML, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    await env.STORE.put("raw/x.json", "{}", { httpMetadata: { contentType: "application/json" } });
    const res = await callWorker(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("serves what captureVersion stored", async () => {
    mockFetchHtml();
    const id = await seedVersion(await seedPage("policy"));
    await captureVersion(env, id);

    const jpeg = await callWorker(`/shots/${id}.jpg`);
    expect(jpeg.status).toBe(200);
    expect(new Uint8Array(await jpeg.arrayBuffer())).toEqual(JPEG);
    expect(await (await callWorker(`/sources/${id}.html`)).text()).toBe(HTML);
  });
});
