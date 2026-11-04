// The partial-render guard (a read that is a shrunken copy of the latest version is held for a
// confirm read) and flap suppression (a text seen in the last 72 hours is not a new version), both in
// the judge path the webhook and the pull share (src/core/gate.ts, src/record.ts).
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps } from "../src/capture";
import { PULLS_PER_TICK } from "../src/core/limits";
import { hashText, normalize } from "../src/core/normalize";
import { cronDeps, runCron } from "../src/cron";
import { insertPage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { PageRow, RunRow, VersionRow } from "../src/db/types";
import { insertVersion } from "../src/db/versions";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import runNowFixture from "./fixtures/tinyfish/monitor-runnow.json";
import changedReal from "./fixtures/webhooks/changed-real.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ADMIN = { Authorization: "Bearer test-admin" };
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const FETCH_API = "https://api.fetch.tinyfish.ai/";
const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

// --- Texts ----------------------------------------------------------------------------------------

/** Paragraph `i`: about 72 characters, each one different, none touched by the normalizer. */
const para = (i: number) => `Item ${String(i).padStart(3, "0")}: the price is $${i}.50 per 1M tokens, billed monthly in arrears.`;
/** `n` paragraphs, from `from`. */
const build = (n: number, from = 0) => Array.from({ length: n }, (_, k) => para(from + k)).join("\n\n");
const len = (text: string) => normalize(text).text.length;

// --- Seeding ----------------------------------------------------------------------------------------

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

let versionSeq = 0;
/** A fully captured version of `text` captured `ageHours` ago. */
async function seedVersion(pageId: string, text: string, ageHours: number, baseline = false): Promise<string> {
  const id = `v-${pageId}-${++versionSeq}`;
  await insertVersion(env.DB, {
    id,
    page_id: pageId,
    run_id: null,
    is_baseline: baseline ? 1 : 0,
    captured_at: hoursAgo(ageHours),
    text,
    normalized_hash: await hashText(normalize(text).text),
    judgment_summary: null,
    screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`,
    capture_status: "complete",
  });
  return id;
}

async function seedRun(pageId: string, receivedAt: string): Promise<void> {
  const run: RunRow = {
    id: `run-seed-${pageId}-${receivedAt}`,
    page_id: pageId,
    monitor_run_id: `mrun-seed-${pageId}-${receivedAt}`,
    outcome: "unchanged",
    is_baseline: 0,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: receivedAt,
    trigger_kind: "webhook",
  };
  await insertRun(env.DB, run);
}

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}
const runsOf = (pageId: string) => all<RunRow>("SELECT * FROM runs WHERE page_id = ? ORDER BY received_at, rowid", pageId);
const versionsOf = (pageId: string) => all<VersionRow>("SELECT * FROM versions WHERE page_id = ? ORDER BY captured_at, rowid", pageId);
const pageRow = async (id: string) => (await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first<PageRow>())!;
const hashOf = async (text: string) => hashText(normalize(text).text);

async function setPending(pageId: string, hash: string, runId: string, at: string): Promise<void> {
  await env.DB.prepare("UPDATE pages SET pending_hash = ?, pending_run_id = ?, pending_at = ? WHERE id = ?")
    .bind(hash, runId, at, pageId)
    .run();
}

// --- TinyFish mocks -----------------------------------------------------------------------------------

const runNowUrl = (monitorId: string) => `${MONITORS_API}/${monitorId}/runs`;
const runNowCalls = () => fetchMock.calls.filter((c) => c.method === "POST" && /\/v1\/monitors\/[^/]+\/runs$/.test(c.url));

function runNowBody(runId: string, text: string): Json {
  const body = structuredClone(runNowFixture) as Json;
  body.run.id = runId;
  body.run.errors = [];
  body.run.results[0].text = text;
  return body;
}

function mockRunNow(monitorId: string, runId: string, text: string): void {
  fetchMock.intercept({ method: "POST", url: runNowUrl(monitorId), times: 1, reply: { status: 201, json: runNowBody(runId, text) } });
}

function mockMonitorList(): void {
  fetchMock.intercept({
    method: "GET",
    url: MONITORS_API,
    times: Infinity,
    reply: async () => {
      const { results } = await env.DB.prepare("SELECT monitor_id FROM pages WHERE monitor_id IS NOT NULL").all<{ monitor_id: string }>();
      return Response.json({ monitors: results.map((r) => ({ id: r.monitor_id, status: "active", name: null })) });
    },
  });
}

function captureSucceeds(): void {
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: { json: { results: [{ text: "<html><body>page</body></html>" }] } },
  });
}

const pull = (pageId: string) => callWorker(`/api/admin/pull/${pageId}`, { method: "POST", headers: ADMIN });

/** Pulls `text` as run `runId`; returns the answer. */
async function pullText(pageId: string, runId: string, text: string): Promise<Json> {
  mockRunNow(monitorOf(pageId), runId, text);
  const res = await pull(pageId);
  expect(res.status).toBe(200);
  return res.json();
}

const postWebhook = (body: unknown) =>
  callWorker("/hooks/monitor/test-secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// --- Setup ---------------------------------------------------------------------------------------------

const realPull = cronDeps.pull;
const realNow = cronDeps.now;
let shot: MockInstance<typeof captureDeps.screenshotFullPage>;
let log: MockInstance<typeof console.log>;
let errorLog: MockInstance<typeof console.error>;

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  shot = vi
    .spyOn(captureDeps, "screenshotFullPage")
    .mockImplementation(async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer, height: 800, sessionId: "sess-1" }));
  captureSucceeds();
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

// --- Rule 1: the partial-render guard ----------------------------------------------------------------------

describe("partial-render guard", () => {
  /** A page whose latest version is the long text (about 2,300 characters). */
  async function watchLong(): Promise<{ pageId: string; long: string }> {
    const pageId = await seedPage();
    const long = build(32);
    expect(len(long)).toBeGreaterThan(2200);
    await seedVersion(pageId, long, 5, true);
    return { pageId, long };
  }

  it("a shrink to under 70% with nothing added is suspect: no version, run partial_render, pending set", async () => {
    const { pageId, long } = await watchLong();
    const short = build(10); // the first ten paragraphs: about 725 characters, nothing added
    expect(len(short) / len(long)).toBeLessThan(0.35);

    const answer = await pullText(pageId, "tf-suspect", short);

    expect(answer).toMatchObject({ ok: true, pulled: true, outcome: "changed", suppressed: true });
    expect(answer.version_id).toBeUndefined();
    expect(await versionsOf(pageId)).toHaveLength(1);
    const [run] = await runsOf(pageId);
    expect(run).toMatchObject({ monitor_run_id: "tf-suspect", noise_suppressed: 1, noise_reason: "partial_render" });
    const page = await pageRow(pageId);
    expect(page.pending_hash).toBe(await hashOf(short));
    expect(page.pending_run_id).toBe(run!.id);
    expect(Date.parse(page.pending_at!)).toBeGreaterThan(Date.now() - 60_000);
    expect(page.last_change_at).toBeNull();
  });

  it("a shrink to 60% that ADDS a block is not suspect", async () => {
    const { pageId, long } = await watchLong();
    const shrunk = `${build(19)}\n\nA brand new setup fee of $9 applies to every account.`;
    const ratio = len(shrunk) / len(long);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.7);

    const answer = await pullText(pageId, "tf-added", shrunk);

    expect(answer.version_id).toBeTypeOf("string");
    expect(await versionsOf(pageId)).toHaveLength(2);
    expect((await pageRow(pageId)).pending_at).toBeNull();
    expect((await runsOf(pageId))[0]).toMatchObject({ noise_suppressed: 0, noise_reason: null });
  });

  it("under 500 characters against a latest over 2,000 is suspect even when a block was added", async () => {
    const { pageId } = await watchLong();
    const tiny = `${build(4)}\n\nNotice: the page is being rebuilt.`;
    expect(len(tiny)).toBeLessThan(500);

    const answer = await pullText(pageId, "tf-tiny", tiny);

    expect(answer.suppressed).toBe(true);
    expect(await versionsOf(pageId)).toHaveLength(1);
    expect((await runsOf(pageId))[0]).toMatchObject({ noise_reason: "partial_render" });
    expect((await pageRow(pageId)).pending_hash).toBe(await hashOf(tiny));
  });

  it("a 400-character read against a 1,900-character latest is not under rule (b); rule (a) decides", async () => {
    const pageId = await seedPage();
    const latest = build(26);
    expect(len(latest)).toBeLessThan(2000);
    await seedVersion(pageId, latest, 5, true);
    const withAdded = `${build(4)}\n\nAn extra notice that was not on the page before.`;
    expect(len(withAdded)).toBeLessThan(500);

    // (a): under 70%, but a block was added: a real change.
    const answer = await pullText(pageId, "tf-a1", withAdded);
    expect(answer.version_id).toBeTypeOf("string");
    expect(await versionsOf(pageId)).toHaveLength(2);

    // (a): under 70% and nothing added: suspect.
    const pageId2 = await seedPage();
    await seedVersion(pageId2, latest, 5, true);
    const answer2 = await pullText(pageId2, "tf-a2", build(5));
    expect(answer2.suppressed).toBe(true);
    expect((await runsOf(pageId2))[0]).toMatchObject({ noise_reason: "partial_render" });
  });

  it("the confirm read with the same text creates the version from the confirm run and clears the pending fields", async () => {
    const { pageId } = await watchLong();
    const short = build(10);
    await pullText(pageId, "tf-first", short);
    const [first] = await runsOf(pageId);

    const answer = await pullText(pageId, "tf-confirm", short);

    expect(answer.version_id).toBeTypeOf("string");
    const versions = await versionsOf(pageId);
    expect(versions).toHaveLength(2);
    const created = versions[1]!;
    const runs = await runsOf(pageId);
    expect(created.run_id).toBe(runs[1]!.id);
    expect(created.text).toBe(short);
    expect(created.notes).toBe(`confirmed after partial-render suspect run ${first!.id}`);
    expect(runs[1]).toMatchObject({ noise_suppressed: 0, noise_reason: null });
    expect(runs[0]).toMatchObject({ noise_reason: "partial_render" });
    const page = await pageRow(pageId);
    expect([page.pending_hash, page.pending_run_id, page.pending_at]).toEqual([null, null, null]);
    expect(page.last_change_at).toBe(runs[1]!.received_at);
  });

  it("a confirm read equal to the latest clears the pending fields and is suppressed as normalized_identical", async () => {
    const { pageId, long } = await watchLong();
    await pullText(pageId, "tf-first", build(10));

    const answer = await pullText(pageId, "tf-confirm", long); // exactly the latest text again

    expect(answer).toMatchObject({ ok: true, pulled: true });
    expect(answer.version_id).toBeUndefined();
    expect(await versionsOf(pageId)).toHaveLength(1);
    expect((await runsOf(pageId))[1]).toMatchObject({ noise_suppressed: 1, noise_reason: "normalized_identical" });
    const page = await pageRow(pageId);
    expect([page.pending_hash, page.pending_run_id, page.pending_at]).toEqual([null, null, null]);
  });

  it("a confirm read with a third text clears the pending fields and is judged normally", async () => {
    const { pageId, long } = await watchLong();
    await pullText(pageId, "tf-first", build(10));
    const third = long.replace("$3.50 per 1M", "$4.75 per 1M"); // a real edit of the full page

    const answer = await pullText(pageId, "tf-third", third);

    expect(answer.version_id).toBeTypeOf("string");
    const versions = await versionsOf(pageId);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.notes).toBeNull();
    const page = await pageRow(pageId);
    expect([page.pending_hash, page.pending_run_id, page.pending_at]).toEqual([null, null, null]);
  });

  it("a third text that is itself suspect sets a new pending", async () => {
    const { pageId } = await watchLong();
    await pullText(pageId, "tf-first", build(10));
    const other = build(8);

    await pullText(pageId, "tf-second", other);

    const page = await pageRow(pageId);
    expect(page.pending_hash).toBe(await hashOf(other));
    expect(page.pending_run_id).toBe((await runsOf(pageId))[1]!.id);
    expect(await versionsOf(pageId)).toHaveLength(1);
  });

  it("a webhook arriving for a pending page is judged as the confirm", async () => {
    const { pageId } = await watchLong();
    const short = build(10);
    await pullText(pageId, "tf-first", short);
    const [first] = await runsOf(pageId);

    const payload = structuredClone(changedReal) as Json;
    payload.id = "hook-confirm";
    payload.fetch_monitor_id = monitorOf(pageId);
    payload.results[0].text = short;
    const res = await postWebhook(payload);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version_id: expect.any(String) });
    const versions = await versionsOf(pageId);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.notes).toBe(`confirmed after partial-render suspect run ${first!.id}`);
    expect((await pageRow(pageId)).pending_at).toBeNull();
  });

  it("a webhook that is itself the suspect read sets the pending too", async () => {
    const { pageId } = await watchLong();
    const payload = structuredClone(changedReal) as Json;
    payload.id = "hook-suspect";
    payload.fetch_monitor_id = monitorOf(pageId);
    payload.results[0].text = build(10);

    const res = await postWebhook(payload);

    expect(await res.json()).toEqual({ ok: true, suppressed: true });
    expect((await runsOf(pageId))[0]).toMatchObject({ noise_reason: "partial_render", trigger_kind: "webhook" });
    expect((await pageRow(pageId)).pending_hash).toBe(await hashOf(build(10)));
  });
});

// --- The cron and the confirm read -------------------------------------------------------------------------

describe("the cron and pending confirm reads", () => {
  const NOW = new Date("2026-01-15T13:00:00.000Z");
  // "0 0,12 * * *" at NOW - 15 min: the noon tick must have a run.
  const BEFORE_TICK = "2026-01-15T00:30:00.000Z";
  const AFTER_TICK = "2026-01-15T12:05:00.000Z";

  beforeEach(() => {
    cronDeps.pull = (_env, pageId) => pull(pageId);
    cronDeps.now = () => new Date(NOW);
    mockMonitorList();
  });

  async function seedUpToDate(pending: { at: string } | null): Promise<string> {
    const pageId = await seedPage();
    await seedVersion(pageId, build(32), 5, true);
    await seedRun(pageId, AFTER_TICK); // its noon run arrived: not overdue
    if (pending) await setPending(pageId, await hashOf(build(10)), "run-suspect", pending.at);
    return pageId;
  }

  it("pulls a pending page regardless of its tick", async () => {
    const pageId = await seedUpToDate({ at: AFTER_TICK });
    mockRunNow(monitorOf(pageId), "tf-confirm", build(32)); // the page is whole again

    const result = await runCron(env);

    expect(result.pulled).toBe(1);
    expect(runNowCalls().map((c) => c.url)).toEqual([runNowUrl(monitorOf(pageId))]);
    expect((await pageRow(pageId)).pending_at).toBeNull();
    expect((await runsOf(pageId)).find((r) => r.monitor_run_id === "tf-confirm")).toMatchObject({
      trigger_kind: "pull",
      noise_reason: "normalized_identical",
    });
  });

  it("pending pulls come before overdue pulls and share the PULLS_PER_TICK cap", async () => {
    const overdue: string[] = [];
    for (let i = 0; i < PULLS_PER_TICK; i++) {
      const id = await seedPage();
      await seedVersion(id, build(32), 5, true);
      await seedRun(id, BEFORE_TICK);
      overdue.push(id);
      mockRunNow(monitorOf(id), `tf-over-${i}`, build(32));
    }
    const pendingPage = await seedUpToDate({ at: AFTER_TICK });
    mockRunNow(monitorOf(pendingPage), "tf-confirm", build(32));

    const result = await runCron(env);

    expect(result.pulled).toBe(PULLS_PER_TICK);
    const urls = runNowCalls().map((c) => c.url);
    expect(urls).toHaveLength(PULLS_PER_TICK);
    expect(urls[0]).toBe(runNowUrl(monitorOf(pendingPage)));
    expect(urls).not.toContain(runNowUrl(monitorOf(overdue[overdue.length - 1]!))); // the cap left it for the next tick
  });

  it("pending fields older than 24 hours are cleared without a pull", async () => {
    const pageId = await seedUpToDate({ at: "2026-01-14T11:00:00.000Z" }); // 26 hours before NOW

    const result = await runCron(env);

    expect(result.pulled).toBe(0);
    expect(runNowCalls()).toHaveLength(0);
    const page = await pageRow(pageId);
    expect([page.pending_hash, page.pending_run_id, page.pending_at]).toEqual([null, null, null]);
    expect(await versionsOf(pageId)).toHaveLength(1);
  });
});

// --- Rule 2: flap suppression ----------------------------------------------------------------------------------

describe("flap suppression", () => {
  const A = ["# Pricing", "", "Pro is $20 per month."].join("\n");
  const B = ["# Pricing", "", "Pro is $25 per month."].join("\n");

  it("A then B then A within 72 hours is suppressed as flap", async () => {
    const pageId = await seedPage();
    await seedVersion(pageId, A, 48, true);
    await seedVersion(pageId, B, 24);

    const answer = await pullText(pageId, "tf-back", A);

    expect(answer).toMatchObject({ ok: true, pulled: true, suppressed: true });
    expect(await versionsOf(pageId)).toHaveLength(2);
    expect((await runsOf(pageId))[0]).toMatchObject({ noise_suppressed: 1, noise_reason: "flap" });
  });

  it("A then B then A after 72 hours is a genuine revert and creates a version", async () => {
    const pageId = await seedPage();
    await seedVersion(pageId, A, 100, true);
    await seedVersion(pageId, B, 80);

    const answer = await pullText(pageId, "tf-revert", A);

    expect(answer.version_id).toBeTypeOf("string");
    expect(await versionsOf(pageId)).toHaveLength(3);
    expect((await runsOf(pageId))[0]).toMatchObject({ noise_suppressed: 0, noise_reason: null });
  });

  it("a read equal to the latest version stays normalized_identical, even with an older match", async () => {
    const pageId = await seedPage();
    await seedVersion(pageId, A, 48, true);
    await seedVersion(pageId, B, 24);
    await seedVersion(pageId, A, 2);
    const stamped = A.replace("# Pricing", "# Pricing\n\nLast updated: 15 January 2026");

    await pullText(pageId, "tf-same", stamped);

    expect((await runsOf(pageId))[0]).toMatchObject({ noise_suppressed: 1, noise_reason: "normalized_identical" });
  });

  it("the confirm path is checked for a flap too", async () => {
    const pageId = await seedPage();
    const small = build(10); // a subset of the full page
    const full = build(32);
    await seedVersion(pageId, small, 48, true);
    await seedVersion(pageId, full, 24); // the latest
    await pullText(pageId, "tf-first", small); // suspect: a shrink with nothing added
    expect((await pageRow(pageId)).pending_hash).toBe(await hashOf(small));

    const answer = await pullText(pageId, "tf-confirm", small);

    expect(answer.suppressed).toBe(true);
    expect(await versionsOf(pageId)).toHaveLength(2);
    expect((await runsOf(pageId))[1]).toMatchObject({ noise_suppressed: 1, noise_reason: "flap" });
    expect((await pageRow(pageId)).pending_at).toBeNull();
  });
});

// --- Exposure ---------------------------------------------------------------------------------------------------------

describe("exposure", () => {
  it("GET /api/pages/:id carries the page's runs, newest first, with noise_reason", async () => {
    const pageId = await seedPage();
    await seedVersion(pageId, build(32), 5, true);
    await pullText(pageId, "tf-suspect", build(10));
    await pullText(pageId, "tf-whole", build(32));

    const res = await callWorker(`/api/pages/${pageId}`);
    const body: Json = await res.json();

    expect(body.runs.map((r: Json) => r.monitor_run_id)).toEqual(["tf-whole", "tf-suspect"]);
    expect(body.runs[1]).toEqual({
      id: expect.any(String),
      monitor_run_id: "tf-suspect",
      trigger: "pull",
      outcome: "changed",
      received_at: expect.any(String),
      noise_suppressed: true,
      noise_reason: "partial_render",
    });
    expect(body.runs[0]).toMatchObject({ noise_suppressed: true, noise_reason: "normalized_identical" });
  });

  it("GET /api/pages/:id returns at most 100 runs", async () => {
    const pageId = await seedPage();
    for (let i = 0; i < 105; i++) await seedRun(pageId, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());

    const body: Json = await (await callWorker(`/api/pages/${pageId}`)).json();

    expect(body.runs).toHaveLength(100);
    expect(body.runs[0].received_at).toBe(new Date(Date.UTC(2026, 0, 1, 0, 104)).toISOString());
  });

  it("/api/stats has noise_by_reason with its keys always present", async () => {
    const empty: Json = await (await callWorker("/api/stats")).json();
    expect(empty.noise_by_reason).toEqual({ normalized_identical: 0, partial_render: 0, flap: 0 });

    const pageId = await seedPage();
    await seedVersion(pageId, build(32), 5, true);
    await pullText(pageId, "tf-suspect", build(10));
    await pullText(pageId, "tf-whole", build(32));
    const stats: Json = await (await callWorker("/api/stats")).json();
    expect(stats.noise_by_reason).toEqual({ normalized_identical: 1, partial_render: 1, flap: 0 });
    expect(stats.noise_suppressed).toBe(2);
  });

  it("version JSON carries notes (versions/:vid and as-of)", async () => {
    const pageId = await seedPage();
    const baselineId = await seedVersion(pageId, build(32), 5, true);
    await pullText(pageId, "tf-first", build(10));
    const confirm = await pullText(pageId, "tf-confirm", build(10));

    const one: Json = await (await callWorker(`/api/pages/${pageId}/versions/${confirm.version_id}`)).json();
    const at = encodeURIComponent(new Date(Date.now() + 1000).toISOString());
    const asOf: Json = await (await callWorker(`/api/pages/${pageId}/as-of?at=${at}`)).json();
    const first = (await runsOf(pageId))[0]!;

    expect(one.notes).toBe(`confirmed after partial-render suspect run ${first.id}`);
    expect(asOf.notes).toBe(one.notes);
    const baseline: Json = await (await callWorker(`/api/pages/${pageId}/versions/${baselineId}`)).json();
    expect(baseline.notes).toBeNull();
  });
});

describe("the admin replay", () => {
  it("leaves a run the guard set aside as it is, instead of turning it into a version", async () => {
    const pageId = await seedPage();
    await seedVersion(pageId, build(32), 5, true);
    await pullText(pageId, "tf-suspect", build(10)); // stores raw/tf-suspect.json and a partial_render run

    const res = await callWorker(`/api/pages/${pageId}/replay`, { method: "POST", headers: ADMIN });

    expect(await res.json()).toEqual({ created: 0, suppressed: 0 });
    expect(await versionsOf(pageId)).toHaveLength(1);
    expect((await runsOf(pageId))[0]).toMatchObject({ noise_suppressed: 1, noise_reason: "partial_render" });
  });
});
