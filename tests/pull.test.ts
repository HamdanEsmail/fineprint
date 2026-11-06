// The overdue-check fallback: when a page's scheduled Monitor run has not arrived 15 minutes after
// its tick, the hourly cron asks TinyFish to run that Monitor now (POST /api/admin/pull/:pageId, one
// Worker invocation per pull) and records the run under TinyFish's run id, marked `pull`.
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps } from "../src/capture";
import { lastTickAtOrBefore } from "../src/core/cronTick";
import { FACTS_PAUSE_USD, PULLS_PER_TICK, SPEND_PAUSE_USD } from "../src/core/limits";
import { hashText, normalize } from "../src/core/normalize";
import { PRICES, recordSpend } from "../src/core/spend";
import { cronDeps, runCron } from "../src/cron";
import { getPage, insertPage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { PageRow, RunRow, SpendRow, VersionRow } from "../src/db/types";
import { insertVersion } from "../src/db/versions";
import type { Env } from "../src/env";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import runNowFixture from "./fixtures/tinyfish/monitor-runnow.json";
import unchangedWebhook from "./fixtures/webhooks/unchanged.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ADMIN = { Authorization: "Bearer test-admin" };
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const FETCH_API = "https://api.fetch.tinyfish.ai/";
const BASE = "https://fineprint.test";

// The cron's clock (cronDeps.now) is fixed in the past, so the overdue rule is exact and every run a
// pull records (stamped with the real clock) is later than any tick computed here.
const NOW = new Date("2026-01-15T13:00:00.000Z");
// "0 0,12 * * *" at NOW − 15 min (12:45): the noon tick is the one that must have a run.
const TICK = "2026-01-15T12:00:00.000Z";
const BEFORE_TICK = "2026-01-15T00:30:00.000Z"; // the midnight run arrived; the noon one did not
const AFTER_TICK = "2026-01-15T12:05:00.000Z";

const BASE_TEXT = [
  "# Example pricing",
  "",
  "Last updated: 1 January 2026",
  "",
  "## Pro",
  "",
  "$20 per month per seat.",
].join("\n");
const REAL_TEXT = BASE_TEXT.replace("$20 per month", "$25 per month");
const STAMP_TEXT = BASE_TEXT.replace("1 January 2026", "15 January 2026"); // differs, normalizes the same

// --- Seeding -----------------------------------------------------------------------------------

let seq = 0;
const monitorOf = (pageId: string) => `mon-${pageId}`;

async function seedPage(over: Partial<NewPage> = {}): Promise<string> {
  const id = over.id ?? `page-${++seq}`;
  await insertPage(env.DB, {
    id,
    url: `https://example.com/${id}`,
    label: `Page ${id}`,
    kind: "policy", // no facts: a capture is a screenshot and a source
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

/** The page's baseline as the add flow records it: a `create` run and a fully captured version. */
async function seedBaseline(pageId: string, at: string = BEFORE_TICK, text: string = BASE_TEXT, hash?: string): Promise<string> {
  const versionId = `v-base-${pageId}`;
  await insertRun(env.DB, {
    id: `run-base-${pageId}`,
    page_id: pageId,
    monitor_run_id: `mrun-base-${pageId}`,
    outcome: "baseline",
    is_baseline: 1,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: at,
    trigger_kind: "create",
  });
  await insertVersion(env.DB, {
    id: versionId,
    page_id: pageId,
    run_id: `run-base-${pageId}`,
    is_baseline: 1,
    captured_at: at,
    text,
    normalized_hash: hash ?? (await hashText(normalize(text).text)),
    judgment_summary: null,
    screenshot_key: `shots/${versionId}.jpg`,
    html_key: `html/${versionId}.html`,
    capture_status: "complete",
  });
  return versionId;
}

/** A page whose noon run is missing: overdue at NOW. */
async function seedOverdue(over: Partial<NewPage> = {}): Promise<string> {
  const id = await seedPage(over);
  await seedBaseline(id);
  return id;
}

async function seedWebhookRun(pageId: string, at: string): Promise<void> {
  await insertRun(env.DB, {
    id: `run-hook-${pageId}-${at}`,
    page_id: pageId,
    monitor_run_id: `mrun-hook-${pageId}-${at}`,
    outcome: "unchanged",
    is_baseline: 0,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: `raw/mrun-hook-${pageId}-${at}.json`,
    received_at: at,
    trigger_kind: "webhook",
  });
}

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}
const runsOf = (pageId: string) => all<RunRow>("SELECT * FROM runs WHERE page_id = ? ORDER BY received_at, rowid", pageId);
const pullRunsOf = (pageId: string) => all<RunRow>("SELECT * FROM runs WHERE page_id = ? AND trigger_kind = 'pull'", pageId);
const versionsOf = (pageId: string) => all<VersionRow>("SELECT * FROM versions WHERE page_id = ? ORDER BY captured_at, rowid", pageId);
const spendRows = () => all<SpendRow>("SELECT * FROM spend ORDER BY rowid");
const rawKeys = async () => (await env.STORE.list({ prefix: "raw/" })).objects.map((o) => o.key);
const pageRow = async (id: string): Promise<PageRow> => (await getPage(env.DB, id))!;

// --- TinyFish mocks ------------------------------------------------------------------------------

const runNowUrl = (monitorId: string) => `${MONITORS_API}/${monitorId}/runs`;
const runNowCalls = () => fetchMock.calls.filter((c) => c.method === "POST" && /\/v1\/monitors\/[^/]+\/runs$/.test(c.url));

/** The 201 body run-now returns (the spike's shape), with this run id, text and errors. */
function runNowBody(runId: string, text: string | null, errors: unknown[] = []): Json {
  const body = structuredClone(runNowFixture) as Json;
  body.run.id = runId;
  body.run.errors = errors;
  if (text === null) body.run.results = [];
  else body.run.results[0].text = text;
  return body;
}

function mockRunNow(monitorId: string, body: Json, status = 201, times = 1): void {
  fetchMock.intercept({ method: "POST", url: runNowUrl(monitorId), times, reply: { status, json: body } });
}

/** GET /v1/monitors (the cron's health step): every Monitor a live page holds, all active. */
function mockMonitorList(): void {
  fetchMock.intercept({
    method: "GET",
    url: MONITORS_API,
    times: Infinity,
    reply: async () => {
      const { results } = await env.DB.prepare(
        "SELECT monitor_id FROM pages WHERE monitor_id IS NOT NULL AND status != 'expired'",
      ).all<{ monitor_id: string }>();
      return Response.json({ monitors: results.map((r) => ({ id: r.monitor_id, status: "active", name: null })) });
    },
  });
}

/** A new version's capture succeeds: the screenshot is stubbed and TinyFetch answers the source. */
function captureSucceeds(): void {
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: { json: { results: [{ text: "<html><body>Pro $25 per month</body></html>" }] } },
  });
}

const pull = (pageId: string, headers: Record<string, string> = ADMIN) =>
  callWorker(`/api/admin/pull/${pageId}`, { method: "POST", headers });

const postWebhook = (body: unknown) =>
  callWorker("/hooks/monitor/test-secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// --- Setup ---------------------------------------------------------------------------------------

const realPull = cronDeps.pull;
const realNow = cronDeps.now;
let shot: MockInstance<typeof captureDeps.screenshotFullPage>;
let log: MockInstance<typeof console.log>;
let errorLog: MockInstance<typeof console.error>;

beforeEach(async () => {
  fetchMock.activate(); // nothing here may reach TinyFish; an unmatched fetch throws
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  shot = vi
    .spyOn(captureDeps, "screenshotFullPage")
    .mockImplementation(async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer, height: 800, sessionId: "sess-1" }));
  // In-process, and waited for (waitUntil included), instead of the SELF service binding.
  cronDeps.pull = (_env, pageId) => pull(pageId);
  cronDeps.now = () => new Date(NOW);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fetchMock.reset();
  cronDeps.pull = realPull;
  cronDeps.now = realNow;
  shot.mockRestore();
  log.mockRestore();
  errorLog.mockRestore();
});

// --- The cron step -------------------------------------------------------------------------------

describe("overdue pulls in the hourly cron", () => {
  it("an overdue page gets exactly one pull and one run row marked pull, with spend 0.005", async () => {
    mockMonitorList();
    const pageId = await seedOverdue();
    const body = runNowBody("tf-run-1", BASE_TEXT);
    mockRunNow(monitorOf(pageId), body);

    const result = await runCron(env);

    expect(result.pulled).toBe(1);
    expect(runNowCalls().map((c) => c.url)).toEqual([runNowUrl(monitorOf(pageId))]);
    const runs = await pullRunsOf(pageId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      monitor_run_id: "tf-run-1",
      trigger_kind: "pull",
      outcome: "unchanged",
      is_baseline: 0,
      judgment_relevant: null,
      judgment_summary: null,
      diff_truncated: 0,
      noise_suppressed: 0,
      noise_reason: null,
      raw_key: "raw/tf-run-1.json",
    });
    expect(await spendRows()).toMatchObject([{ kind: "monitor_check", amount_usd: PRICES.monitor_check, ref: "tf-run-1" }]);
    expect(PRICES.monitor_check).toBe(0.005);
    // The raw 201 body, byte for byte.
    expect(await (await env.STORE.get("raw/tf-run-1.json"))!.text()).toBe(JSON.stringify(body));
    expect((await pageRow(pageId)).last_run_at).toBe(runs[0]!.received_at);
    expect(log).toHaveBeenCalledWith("cron", { repaired: 0, expired: 0, unhealthy: 0, pulled: 1 });

    // The pulled run answers the tick: the next hour's cron leaves the page alone.
    expect((await runCron(env)).pulled).toBe(0);
    expect(runNowCalls()).toHaveLength(1);
    expect(await pullRunsOf(pageId)).toHaveLength(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("a pull whose text differs creates a version and captures it in that invocation", async () => {
    mockMonitorList();
    captureSucceeds();
    const pageId = await seedOverdue();
    mockRunNow(monitorOf(pageId), runNowBody("tf-run-2", REAL_TEXT));

    expect((await runCron(env)).pulled).toBe(1);

    const [run] = await pullRunsOf(pageId);
    expect(run).toMatchObject({ outcome: "changed", noise_suppressed: 0, noise_reason: null, trigger_kind: "pull" });
    const versions = await versionsOf(pageId);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      run_id: run!.id,
      is_baseline: 0,
      captured_at: run!.received_at,
      text: REAL_TEXT,
      normalized_hash: await hashText(normalize(REAL_TEXT).text),
      judgment_summary: null,
      // Captured by the pull's own invocation (its waitUntil), not by a later repair.
      screenshot_key: `shots/${versions[1]!.id}.jpg`,
      html_key: `html/${versions[1]!.id}.html`,
      capture_status: "complete",
      capture_attempts: 1,
    });
    expect(shot).toHaveBeenCalledTimes(1);
    const page = await pageRow(pageId);
    expect(page.last_run_at).toBe(run!.received_at);
    expect(page.last_change_at).toBe(run!.received_at);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("a page whose scheduled run arrived at or after the tick is not pulled", async () => {
    mockMonitorList();
    const late = await seedOverdue();
    await seedWebhookRun(late, AFTER_TICK);
    const onTheTick = await seedOverdue();
    await seedWebhookRun(onTheTick, TICK);

    expect((await runCron(env)).pulled).toBe(0);
    expect(runNowCalls()).toEqual([]);
  });

  it("a page with no tick past the 15-minute grace since its last run is not pulled", async () => {
    mockMonitorList();
    // Its tick was ten minutes ago (12:50): still within the grace. The one before (yesterday 12:50)
    // came before the page's baseline run.
    const inGrace = await seedPage({ schedule_cron: "50 12 * * *" });
    await seedBaseline(inGrace);
    // Created after the noon tick: its create run answers that tick.
    const newer = await seedPage();
    await seedBaseline(newer, "2026-01-15T12:30:00.000Z");
    // A schedule with no tick in the search window, an unparseable one, and none at all.
    for (const schedule_cron of ["0 0 30 2 *", "every day", null]) {
      await seedBaseline(await seedPage({ schedule_cron }));
    }

    expect((await runCron(env)).pulled).toBe(0);
    expect(runNowCalls()).toEqual([]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("paused and expired pages, and a page without a Monitor, are never pulled; a page health marked failed still is", async () => {
    mockMonitorList();
    await seedOverdue({ status: "paused" });
    await seedOverdue({ status: "expired" });
    const failed = await seedOverdue({ status: "failed" });
    await seedOverdue({ monitor_id: null });
    const active = await seedOverdue();
    mockRunNow(monitorOf(failed), runNowBody("tf-run-failed", BASE_TEXT));
    mockRunNow(monitorOf(active), runNowBody("tf-run-active", BASE_TEXT));
    const seam = vi.fn((_env: Env, pageId: string) => pull(pageId));
    cronDeps.pull = seam;

    expect((await runCron(env)).pulled).toBe(2);
    // The cron asks for the failed and the active page, due at the same tick so in creation order (the
    // route would refuse the paused, expired and Monitor-less ones with a 409 anyway).
    expect(seam.mock.calls.map(([, pageId]) => pageId)).toEqual([failed, active]);
    expect(runNowCalls().map((c) => c.url)).toEqual([runNowUrl(monitorOf(failed)), runNowUrl(monitorOf(active))]);
    expect(await pullRunsOf(failed)).toHaveLength(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("nothing is pulled at the spend pause", async () => {
    mockMonitorList();
    const pageId = await seedOverdue();
    await recordSpend(env.DB, "monitor_check", SPEND_PAUSE_USD, "earlier");
    const seam = vi.fn(cronDeps.pull);
    cronDeps.pull = seam;

    expect((await runCron(env)).pulled).toBe(0);
    expect(seam).not.toHaveBeenCalled();
    expect(runNowCalls()).toEqual([]);
    expect(await pullRunsOf(pageId)).toEqual([]);
  });

  it("at the facts pause ($6) pulls and their screenshot and source captures still run, and the facts wait in the queue", async () => {
    expect(FACTS_PAUSE_USD).toBeLessThan(SPEND_PAUSE_USD);
    mockMonitorList();
    captureSucceeds();
    fetchMock.intercept({ method: "POST", url: "https://agent.tinyfish.ai/v1/automation/run-async", times: Infinity, reply: { json: { run_id: "agent-run-1" } } });
    const pageId = await seedOverdue({ kind: "pricing" });
    await recordSpend(env.DB, "monitor_check", FACTS_PAUSE_USD, "earlier");
    mockRunNow(monitorOf(pageId), runNowBody("tf-run-6", REAL_TEXT));

    expect((await runCron(env)).pulled).toBe(1);

    const [baseline, pulled] = await versionsOf(pageId);
    expect(pulled).toMatchObject({
      text: REAL_TEXT,
      screenshot_key: `shots/${pulled!.id}.jpg`,
      html_key: `html/${pulled!.id}.html`,
      // Queued for its facts: nothing started, nothing failed, no attempt used up.
      capture_status: "awaiting_facts",
      capture_error: null,
      capture_attempts: 1,
      agent_run_id: null,
    });
    expect(baseline!.agent_run_id).toBeNull();
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/automation"))).toEqual([]);
    expect((await spendRows()).filter((r) => r.kind === "agent_step")).toEqual([]);
    expect((await spendRows()).filter((r) => r.kind === "monitor_check").map((r) => r.ref)).toEqual(["earlier", "tf-run-6"]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it(`pulls at most ${PULLS_PER_TICK} pages a tick, the oldest overdue tick first`, async () => {
    expect(PULLS_PER_TICK).toBe(20);
    mockMonitorList();
    // 21 overdue pages, ticking at 12:00 to 12:20, seeded newest tick first.
    const byMinute = new Map<number, string>();
    for (let m = 20; m >= 0; m--) {
      const id = await seedPage({ schedule_cron: `${m} * * * *` });
      await seedBaseline(id);
      byMinute.set(m, id);
    }
    const seam = vi.fn(async (_env: Env, _pageId: string) => Response.json({ ok: true, pulled: true }));
    cronDeps.pull = seam;

    expect((await runCron(env)).pulled).toBe(PULLS_PER_TICK);

    // Page m's overdue tick is 12:m, so the pulls go 12:00, 12:01, ... 12:19, and the newest overdue
    // tick (12:20) waits for the next hour.
    expect(lastTickAtOrBefore("0 * * * *", new Date(NOW.getTime() - 15 * 60_000))!.toISOString()).toBe(TICK);
    const expected = [...Array(PULLS_PER_TICK).keys()].map((m) => byMinute.get(m));
    expect(seam.mock.calls.map(([, pageId]) => pageId)).toEqual(expected);
    expect(seam.mock.calls.map(([, pageId]) => pageId)).not.toContain(byMinute.get(20));
  });

  it("a failed pull is logged with its status and code only, and the other pulls still run", async () => {
    mockMonitorList();
    const refused = await seedOverdue();
    const broken = await seedOverdue();
    const fine = await seedOverdue();
    fetchMock.intercept({
      method: "POST",
      url: runNowUrl(monitorOf(refused)),
      reply: { status: 500, json: { error: { code: "INTERNAL", message: "test-tinyfish-key echoed" } } },
    });
    mockRunNow(monitorOf(fine), runNowBody("tf-run-fine", BASE_TEXT));
    cronDeps.pull = async (_env, pageId) => {
      if (pageId === broken) throw new Error("connection reset");
      return pull(pageId);
    };

    const result = await runCron(env);

    expect(result.pulled).toBe(1);
    expect(await pullRunsOf(fine)).toHaveLength(1);
    expect(await pullRunsOf(refused)).toEqual([]);
    const logged = errorLog.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain(refused);
    expect(logged).toContain("status=502");
    expect(logged).toContain("INTERNAL");
    expect(logged).toContain(broken);
    expect(logged).toContain("connection reset");
    expect(logged).not.toContain("test-tinyfish-key");
    expect(logged).not.toContain("test-admin");
  });

  it("a pull whose response has no text or has errors records nothing, and the page is pulled again next tick", async () => {
    mockMonitorList();
    const errored = await seedOverdue();
    const empty = await seedOverdue();
    mockRunNow(monitorOf(errored), runNowBody("tf-run-err", "partial text", [{ url: "https://example.com", error: "bot_blocked" }]), 201, 2);
    mockRunNow(monitorOf(empty), runNowBody("tf-run-empty", null), 201, 2);

    expect((await runCron(env)).pulled).toBe(0);
    expect((await runCron(env)).pulled).toBe(0);

    expect(runNowCalls().map((c) => c.url)).toEqual([
      runNowUrl(monitorOf(errored)),
      runNowUrl(monitorOf(empty)),
      runNowUrl(monitorOf(errored)),
      runNowUrl(monitorOf(empty)),
    ]);
    expect(await pullRunsOf(errored)).toEqual([]);
    expect(await pullRunsOf(empty)).toEqual([]);
    expect(await spendRows()).toEqual([]);
    expect(await rawKeys()).toEqual([]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("the default pull goes through the SELF service binding to the admin route, with the admin token", async () => {
    const requests: Request[] = [];
    const fakeEnv = {
      ...env,
      SELF: { fetch: async (req: Request) => (requests.push(req), Response.json({ ok: true, pulled: true })) },
    } as unknown as Env;

    const res = await realPull(fakeEnv, "page/odd id");

    expect(res.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("https://fineprint.internal/api/admin/pull/page%2Fodd%20id");
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer test-admin");
  });

  it("through the real SELF binding, the pull runs in the Worker and records the run", async () => {
    const pageId = await seedOverdue();
    mockRunNow(monitorOf(pageId), runNowBody("tf-run-self", BASE_TEXT));

    const res = await realPull(env, pageId);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pulled: true, outcome: "unchanged" });
    expect(await pullRunsOf(pageId)).toMatchObject([{ monitor_run_id: "tf-run-self", trigger_kind: "pull" }]);
  });
});

// --- The admin route -----------------------------------------------------------------------------

describe("POST /api/admin/pull/:pageId", () => {
  it("is admin only, 404 for an unknown page, 409 for an expired or paused page or one without a Monitor; none calls TinyFish", async () => {
    const pageId = await seedOverdue();
    const expired = await seedOverdue({ status: "expired" });
    const paused = await seedOverdue({ status: "paused" });
    const noMonitor = await seedOverdue({ monitor_id: null });

    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: "test-admin" }] as Record<string, string>[]) {
      const res = await pull(pageId, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "admin_required" });
    }
    // The token is checked before the page: a stranger learns nothing about which pages exist.
    expect((await pull("nope", {})).status).toBe(401);

    const unknown = await pull("nope");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });

    for (const id of [expired, paused, noMonitor]) {
      const res = await pull(id);
      expect(res.status, id).toBe(409);
      expect(await res.json()).toEqual({ error: "not_pullable" });
    }
    expect(fetchMock.calls).toEqual([]);
    expect(await all("SELECT * FROM runs WHERE trigger_kind = 'pull'")).toEqual([]);
  });

  it("answers 502 with TinyFish's code when run-now fails, and records nothing", async () => {
    const pageId = await seedOverdue();
    fetchMock.intercept({ method: "POST", url: runNowUrl(monitorOf(pageId)), reply: { status: 503, json: { error: { code: "UNAVAILABLE" } } } });

    const res = await pull(pageId);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "run_now_failed", reason: "UNAVAILABLE" });
    expect(await pullRunsOf(pageId)).toEqual([]);
    expect(await spendRows()).toEqual([]);
    expect(await rawKeys()).toEqual([]);
  });

  it("a page health marked failed is pulled like an active one (run-now works without a running schedule); a deleted Monitor just fails the pull, unbilled", async () => {
    const pageId = await seedOverdue({ status: "failed" });
    mockRunNow(monitorOf(pageId), runNowBody("tf-failed-1", BASE_TEXT));
    fetchMock.intercept({ method: "POST", url: runNowUrl(monitorOf(pageId)), reply: { status: 404, json: { error: { code: "NOT_FOUND" } } } });

    const res = await pull(pageId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pulled: true, outcome: "unchanged" });
    expect(await pullRunsOf(pageId)).toMatchObject([{ monitor_run_id: "tf-failed-1", trigger_kind: "pull" }]);

    const gone = await pull(pageId);
    expect(gone.status).toBe(502);
    expect(await gone.json()).toEqual({ error: "run_now_failed", reason: "NOT_FOUND" });
    expect(await pullRunsOf(pageId)).toHaveLength(1);
    expect((await spendRows()).map((r) => r.ref)).toEqual(["tf-failed-1"]);
    expect((await pageRow(pageId)).status).toBe("failed"); // the route never changes a page's status
  });

  it("at the spend pause it calls nothing and records nothing", async () => {
    const pageId = await seedOverdue();
    await recordSpend(env.DB, "monitor_check", SPEND_PAUSE_USD, "earlier");

    const res = await pull(pageId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pulled: false, reason: "spend_paused" });
    expect(fetchMock.calls).toEqual([]);
    expect(await pullRunsOf(pageId)).toEqual([]);
  });

  it("at the facts pause ($6) the pull route still runs: only the spend pause stops it", async () => {
    const pageId = await seedOverdue();
    await recordSpend(env.DB, "monitor_check", FACTS_PAUSE_USD, "earlier");
    mockRunNow(monitorOf(pageId), runNowBody("tf-at-facts-pause", BASE_TEXT));

    const res = await pull(pageId);

    expect(await res.json()).toMatchObject({ ok: true, pulled: true });
    expect(await pullRunsOf(pageId)).toHaveLength(1);
  });

  it("no text, or errors: 200 pulled false with the reason, and no run, spend or raw object", async () => {
    const pageId = await seedOverdue();
    mockRunNow(monitorOf(pageId), runNowBody("tf-a", "text", [{ error: "timeout" }]));
    mockRunNow(monitorOf(pageId), runNowBody("tf-b", null));
    mockRunNow(monitorOf(pageId), runNowBody("tf-c", "  \n "));

    expect(await (await pull(pageId)).json()).toEqual({ ok: true, pulled: false, reason: "fetch_error" });
    expect(await (await pull(pageId)).json()).toEqual({ ok: true, pulled: false, reason: "no_text" });
    expect(await (await pull(pageId)).json()).toEqual({ ok: true, pulled: false, reason: "no_text" });

    expect(await pullRunsOf(pageId)).toEqual([]);
    expect(await spendRows()).toEqual([]);
    expect(await rawKeys()).toEqual([]);
    expect((await pageRow(pageId)).last_run_at).toBeNull();
  });

  it("a duplicate run id is a no-op: a second pull answering the same id, and a late webhook with it", async () => {
    captureSucceeds();
    const pageId = await seedOverdue();
    mockRunNow(monitorOf(pageId), runNowBody("tf-dup", REAL_TEXT), 201, 2);

    const first = await pull(pageId);
    const firstBody = (await first.json()) as Json;
    expect(firstBody).toMatchObject({ ok: true, pulled: true, outcome: "changed" });
    const after = {
      runs: await runsOf(pageId),
      versions: await versionsOf(pageId),
      spend: await spendRows(),
      page: await pageRow(pageId),
    };
    expect(after.versions).toHaveLength(2);
    expect(shot).toHaveBeenCalledTimes(1);

    const second = await pull(pageId);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, duplicate: true });

    const webhook = structuredClone(unchangedWebhook) as Json;
    webhook.id = "tf-dup";
    webhook.fetch_monitor_id = monitorOf(pageId);
    const late = await postWebhook(webhook);
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ ok: true, duplicate: true });

    expect(await runsOf(pageId)).toEqual(after.runs);
    expect(await versionsOf(pageId)).toEqual(after.versions);
    expect(await spendRows()).toEqual(after.spend);
    expect(await pageRow(pageId)).toEqual(after.page);
    expect(shot).toHaveBeenCalledTimes(1);
  });

  it("raw text equal to the latest version: an unchanged run, and the change gate is not run", async () => {
    const pageId = await seedPage();
    // A stale stored hash: had the gate run, it would have re-hashed the text, found it equal and
    // rewritten this hash (and flagged the run as noise).
    const baseline = await seedBaseline(pageId, BEFORE_TICK, BASE_TEXT, "stale-hash");
    mockRunNow(monitorOf(pageId), runNowBody("tf-same", BASE_TEXT));

    const res = await pull(pageId);

    const [run] = await pullRunsOf(pageId);
    expect(await res.json()).toEqual({ ok: true, pulled: true, run_id: run!.id, outcome: "unchanged" });
    expect(run).toMatchObject({ outcome: "unchanged", noise_suppressed: 0, noise_reason: null });
    const versions = await versionsOf(pageId);
    expect(versions.map((v) => v.id)).toEqual([baseline]);
    expect(versions[0]!.normalized_hash).toBe("stale-hash");
    expect((await pageRow(pageId)).last_change_at).toBeNull();
    expect(await spendRows()).toHaveLength(1);
  });

  it("raw text differs but normalizes the same: a changed run, suppressed as noise, no version", async () => {
    const pageId = await seedOverdue();
    mockRunNow(monitorOf(pageId), runNowBody("tf-stamp", STAMP_TEXT));

    const res = await pull(pageId);

    const [run] = await pullRunsOf(pageId);
    expect(await res.json()).toEqual({ ok: true, pulled: true, run_id: run!.id, outcome: "changed", suppressed: true });
    expect(run).toMatchObject({ outcome: "changed", noise_suppressed: 1, noise_reason: "normalized_identical" });
    expect(await versionsOf(pageId)).toHaveLength(1);
    expect(shot).not.toHaveBeenCalled();
    expect((await pageRow(pageId)).last_change_at).toBeNull();
    expect(await spendRows()).toMatchObject([{ kind: "monitor_check", ref: "tf-stamp" }]);
  });

  it("a page with no version yet: the pulled run is its baseline", async () => {
    captureSucceeds();
    const pageId = await seedPage();
    mockRunNow(monitorOf(pageId), runNowBody("tf-first", BASE_TEXT));

    const res = await pull(pageId);

    const [run] = await pullRunsOf(pageId);
    const [version] = await versionsOf(pageId);
    expect(await res.json()).toEqual({ ok: true, pulled: true, run_id: run!.id, outcome: "baseline", version_id: version!.id });
    expect(run).toMatchObject({ outcome: "baseline", is_baseline: 1, trigger_kind: "pull" });
    expect(version).toMatchObject({
      run_id: run!.id,
      is_baseline: 1,
      captured_at: run!.received_at,
      text: BASE_TEXT,
      judgment_summary: null,
      capture_status: "complete",
    });
  });

  it("a real change answers with the new version's id", async () => {
    captureSucceeds();
    const pageId = await seedOverdue();
    mockRunNow(monitorOf(pageId), runNowBody("tf-real", REAL_TEXT));

    const res = await pull(pageId);

    const [run] = await pullRunsOf(pageId);
    const versions = await versionsOf(pageId);
    expect(await res.json()).toEqual({ ok: true, pulled: true, run_id: run!.id, outcome: "changed", version_id: versions[1]!.id });
  });
});

// --- What the API shows --------------------------------------------------------------------------

describe("the trigger in the read API", () => {
  it("appears in the version JSON, as-of, the diff ends, the changes feed and runs_by_trigger in stats", async () => {
    captureSucceeds();
    const pageId = await seedOverdue();
    const baseline = `v-base-${pageId}`;
    mockRunNow(monitorOf(pageId), runNowBody("tf-api", REAL_TEXT));
    await pull(pageId);
    const pulled = (await versionsOf(pageId))[1]!;
    // And one scheduled run by webhook (unchanged: no version).
    const webhook = structuredClone(unchangedWebhook) as Json;
    webhook.id = "tf-hook";
    webhook.fetch_monitor_id = monitorOf(pageId);
    expect((await postWebhook(webhook)).status).toBe(200);

    const json = async (path: string) => (await callWorker(path)).json() as Promise<Json>;

    expect((await json(`/api/pages/${pageId}/versions/${pulled.id}`)).trigger).toBe("pull");
    expect((await json(`/api/pages/${pageId}/versions/${baseline}`)).trigger).toBe("create");
    expect((await json(`/api/pages/${pageId}/as-of?at=${encodeURIComponent(new Date().toISOString())}`)).trigger).toBe("pull");
    expect((await json(`/api/pages/${pageId}/as-of?at=${encodeURIComponent(AFTER_TICK)}`)).trigger).toBe("create");

    const diff = await json(`/api/pages/${pageId}/diff?from=${encodeURIComponent(AFTER_TICK)}&to=${encodeURIComponent(new Date().toISOString())}`);
    expect(diff.from).toEqual({
      version_id: baseline,
      captured_at: BEFORE_TICK,
      screenshot_url: `${BASE}/shots/${baseline}.jpg`,
      source_url: `${BASE}/sources/${baseline}.html`,
      trigger: "create",
      facts_status: "pending", // the seeded baseline was given no facts
    });
    expect(diff.to).toMatchObject({ version_id: pulled.id, trigger: "pull" });
    // A stored diff (both ends are final) keeps the triggers.
    const again = await json(`/api/pages/${pageId}/diff?from=${encodeURIComponent(AFTER_TICK)}&to=${encodeURIComponent(new Date().toISOString())}`);
    expect(again).toEqual(diff);

    const changes = (await json("/api/changes")).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ version_id: pulled.id, trigger: "pull" });

    expect((await json("/api/stats")).runs_by_trigger).toEqual({ create: 1, webhook: 1, pull: 1 });
  });
});
