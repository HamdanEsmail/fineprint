import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps } from "../src/capture";
import { hashText, normalize } from "../src/core/normalize";
import { PRICES } from "../src/core/spend";
import { getPage, insertPage, type NewPage } from "../src/db/pages";
import type { PageRow, RunRow, SpendRow, VersionRow } from "../src/db/types";
import { insertVersion } from "../src/db/versions";
import worker from "../src/index";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import changedNoise from "./fixtures/webhooks/changed-noise.json";
import changedReal from "./fixtures/webhooks/changed-real.json";
import unchanged from "./fixtures/webhooks/unchanged.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** What a test needs of a webhook fixture: which monitor sent it. */
type Fixture = { fetch_monitor_id: string };

const SECRET = "test-secret";
const BASELINE_AT = "2026-11-01T00:00:00.000Z";
// The text the Monitor-create baseline stored. changed-real and changed-noise are this text plus one edit.
const BASE_TEXT: string = monitorCreate.run.results[0]!.text;
// unchanged.json carries whatever page its recording watched: its own text is its baseline.
const UNCHANGED_TEXT: string = unchanged.results[0]!.text;

function clone(fixture: unknown): Json {
  return structuredClone(fixture) as Json;
}

function post(body: unknown, secret: string = SECRET): Promise<Response> {
  return callWorker(`/hooks/monitor/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}

// One page per fixture, named after the monitor the fixture says it came from, so a test never
// assumes the three fixtures (or a day-1 recording that replaces one of them) share a monitor.
const pageIdFor = (fixture: Fixture) => `page-${fixture.fetch_monitor_id}`;

const runs = () => all<RunRow>("SELECT * FROM runs ORDER BY received_at, rowid");
const versions = (fixture: Fixture) =>
  all<VersionRow>("SELECT * FROM versions WHERE page_id = ? ORDER BY captured_at, rowid", pageIdFor(fixture));
const spendRows = () => all<SpendRow>("SELECT * FROM spend");
const rawKeys = async () => (await env.STORE.list()).objects.map((o) => o.key);

async function seedPage(fixture: Fixture, over: Partial<NewPage> = {}): Promise<void> {
  await insertPage(env.DB, {
    id: pageIdFor(fixture),
    url: `https://example.com/${fixture.fetch_monitor_id}`,
    label: "Watched page",
    kind: "pricing",
    monitor_id: fixture.fetch_monitor_id,
    schedule_cron: "0 0,12 * * *",
    purpose: "watch prices",
    status: "active",
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
    ...over,
  });
}

/**
 * The page's baseline version, hashed the way the add flow hashes it (or with a hash of the test's
 * choosing), and fully captured: a complete pricing baseline has its screenshot, its source and its
 * facts. (One without facts would be the oldest entry in the facts queue, and the capture of every
 * new version would try to start its Agent run first.)
 */
async function seedBaseline(
  fixture: Fixture,
  text: string,
  hash?: string,
  patterns: string[] = [],
): Promise<void> {
  const id = `v-baseline-${fixture.fetch_monitor_id}`;
  await insertVersion(env.DB, {
    id,
    page_id: pageIdFor(fixture),
    run_id: null,
    is_baseline: 1,
    captured_at: BASELINE_AT,
    text,
    normalized_hash: hash ?? (await hashText(normalize(text, patterns).text)),
    judgment_summary: null,
    screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`,
    facts_json: JSON.stringify([{ name: "Pro", price: "$20", unit: "per month", notes: null }]),
    capture_status: "complete",
    capture_attempts: 0,
  });
}

/** A page watching the fixture's monitor, with a baseline version holding `text`. */
async function watch(fixture: Fixture, text: string, over: Partial<NewPage> = {}): Promise<void> {
  await seedPage(fixture, over);
  await seedBaseline(fixture, text);
}

async function getPageRow(fixture: Fixture): Promise<PageRow> {
  return (await getPage(env.DB, pageIdFor(fixture)))!;
}

// A new version's capture (src/capture.ts) runs in waitUntil, which `post` awaits. Where a
// test looks at the captured version it calls captureSucceeds(); elsewhere the capture's
// TinyFish requests meet no interceptor and fail without touching the network.
let shot: MockInstance<typeof captureDeps.screenshotFullPage> | undefined;

/** The capture of a new version succeeds: the screenshot is stubbed, TinyFetch and TinyAgent answer. */
function captureSucceeds(): void {
  shot = vi.spyOn(captureDeps, "screenshotFullPage").mockImplementation(async () => ({
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
    height: 800,
    sessionId: "sess-test",
  }));
  fetchMock.intercept({
    method: "POST",
    url: "https://api.fetch.tinyfish.ai",
    times: Infinity,
    reply: { json: { results: [{ text: "<html><body>Pro $25/mo.</body></html>" }] } },
  });
  fetchMock.intercept({
    method: "POST",
    url: "https://agent.tinyfish.ai/v1/automation/run-async",
    times: Infinity,
    reply: { json: { run_id: "agent-run-1" } },
  });
}

beforeEach(async () => {
  fetchMock.activate(); // nothing here may reach the network; an unmatched fetch throws
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => {
  fetchMock.reset();
  shot?.mockRestore();
  shot = undefined;
});

describe("POST /hooks/monitor/:secret", () => {
  it("wrong secret is 404 and stores nothing", async () => {
    await watch(changedReal, BASE_TEXT);

    for (const secret of ["wrong-secret", "test-secre", "test-secret-and-more"]) {
      const res = await post(changedReal, secret);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }

    expect(await runs()).toEqual([]);
    expect(await spendRows()).toEqual([]);
    expect(await rawKeys()).toEqual([]);
    expect(await versions(changedReal)).toHaveLength(1);
    expect((await getPageRow(changedReal)).last_run_at).toBeNull();
  });

  it("unchanged run stores a run row and spend 0.005, no version", async () => {
    await watch(unchanged, UNCHANGED_TEXT);

    const res = await post(unchanged);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;

    const [run, ...rest] = await runs();
    expect(rest).toEqual([]);
    expect(body).toEqual({ ok: true, run_id: run!.id });
    expect(run).toMatchObject({
      page_id: pageIdFor(unchanged),
      monitor_run_id: unchanged.id,
      outcome: "unchanged",
      is_baseline: 0,
      judgment_relevant: null,
      judgment_summary: null,
      diff_truncated: 0,
      noise_suppressed: 0,
      noise_reason: null,
      raw_key: `raw/${unchanged.id}.json`,
    });

    const spend = await spendRows();
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({ kind: "monitor_check", amount_usd: PRICES.monitor_check, ref: unchanged.id });
    expect(PRICES.monitor_check).toBe(0.005);

    expect(await versions(unchanged)).toHaveLength(1);
    const page = await getPageRow(unchanged);
    expect(page.last_run_at).toBe(run!.received_at);
    expect(page.last_change_at).toBeNull();
    expect(await rawKeys()).toEqual([`raw/${unchanged.id}.json`]);
  });

  it("changed run with a real difference creates a version with captured_at = receipt time and keeps the raw payload in R2", async () => {
    await watch(changedReal, BASE_TEXT);
    captureSucceeds();
    const posted = JSON.stringify(changedReal);

    const before = new Date().toISOString();
    const res = await post(posted);
    const after = new Date().toISOString();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;

    const stored = await versions(changedReal);
    expect(stored).toHaveLength(2);
    const version = stored[1]!;
    const [run] = await runs();
    expect(body).toEqual({ ok: true, version_id: version.id });

    const realText: string = changedReal.results[0]!.text;
    expect(version).toMatchObject({
      page_id: pageIdFor(changedReal),
      run_id: run!.id,
      is_baseline: 0,
      text: realText,
      normalized_hash: await hashText(normalize(realText, []).text),
      judgment_summary: changedReal.judgment.summary,
      // Inserted `pending`; the capture scheduled with waitUntil then stored the screenshot and
      // source and, the page being a pricing page and the change relevant, started a facts run.
      capture_status: "awaiting_facts",
      capture_attempts: 1,
      screenshot_key: `shots/${version.id}.jpg`,
      html_key: `html/${version.id}.html`,
      agent_run_id: "agent-run-1",
    });
    // The webhook carries no timestamp: the version is dated by when we received it.
    expect(version.captured_at).toBe(run!.received_at);
    expect(version.captured_at >= before && version.captured_at <= after).toBe(true);

    expect(run).toMatchObject({
      monitor_run_id: changedReal.id,
      outcome: "changed",
      judgment_relevant: 1,
      judgment_summary: changedReal.judgment.summary,
      noise_suppressed: 0,
      noise_reason: null,
    });
    const page = await getPageRow(changedReal);
    expect(page.last_run_at).toBe(run!.received_at);
    expect(page.last_change_at).toBe(run!.received_at);
    // One billed check, and the capture's free TinyFetch (the stubbed screenshot records nothing).
    expect((await spendRows()).map((s) => [s.kind, s.amount_usd, s.ref]).sort()).toEqual([
      ["fetch", 0, `https://example.com/${changedReal.fetch_monitor_id}`],
      ["monitor_check", 0.005, changedReal.id],
    ]);

    const raw = await env.STORE.get(`raw/${changedReal.id}.json`);
    expect(raw).not.toBeNull();
    expect(await raw!.text()).toBe(posted);
    expect(raw!.httpMetadata?.contentType).toBe("application/json");
  });

  it("changed run whose only difference is a Last updated line is suppressed: no version, run.noise_suppressed 1, reason normalized_identical", async () => {
    await watch(changedNoise, BASE_TEXT);

    const res = await post(changedNoise);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, suppressed: true });

    expect(await versions(changedNoise)).toHaveLength(1);
    const [run] = await runs();
    expect(run).toMatchObject({
      monitor_run_id: changedNoise.id,
      outcome: "changed",
      judgment_relevant: 0,
      noise_suppressed: 1,
      noise_reason: "normalized_identical",
    });
    const page = await getPageRow(changedNoise);
    expect(page.last_run_at).toBe(run!.received_at);
    expect(page.last_change_at).toBeNull();
    // A suppressed run still cost a check, and its raw payload is kept for replay.
    expect(await spendRows()).toHaveLength(1);
    expect(await rawKeys()).toEqual([`raw/${changedNoise.id}.json`]);
  });

  it("the same payload id delivered twice yields one run and one version", async () => {
    await watch(changedReal, BASE_TEXT);

    const first = await post(changedReal);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Json;
    expect(firstBody.version_id).toBeTypeOf("string");

    const second = await post(changedReal);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, duplicate: true });

    expect(await runs()).toHaveLength(1);
    const vs = await versions(changedReal);
    expect(vs).toHaveLength(2);
    expect(vs[1]!.id).toBe(firstBody.version_id);
    // The new version's capture fails here (no interceptors), and it must not touch the complete
    // baseline: a seeded baseline without facts would be the facts queue's oldest candidate.
    expect(vs[0]).toMatchObject({ capture_status: "complete", capture_attempts: 0, capture_error: null, agent_run_id: null });
    // The retry is not a second check: one ledger row, and the page's change time is the first delivery's.
    expect(await spendRows()).toHaveLength(1);
    expect((await getPageRow(changedReal)).last_run_at).toBe((await runs())[0]!.received_at);
  });

  it("a retried noise run stays one suppressed run and a retried unchanged run one heartbeat", async () => {
    await watch(changedNoise, BASE_TEXT);

    const heartbeat = { id: "heartbeat-1", fetch_monitor_id: changedNoise.fetch_monitor_id, outcome: "unchanged" };
    for (const payload of [changedNoise, heartbeat]) {
      expect((await post(payload)).status).toBe(200);
      expect(await (await post(payload)).json()).toEqual({ ok: true, duplicate: true });
    }
    expect(await runs()).toHaveLength(2);
    expect(await spendRows()).toHaveLength(2);
    expect(await versions(changedNoise)).toHaveLength(1);
  });

  it("each fixture is routed by its own fetch_monitor_id: pages for different monitors never mix", async () => {
    // Whatever ids the three fixtures carry, a page per distinct id receives only its own runs.
    const other = { fetch_monitor_id: "mon-another-page" };
    await watch(changedReal, BASE_TEXT);
    if (unchanged.fetch_monitor_id !== changedReal.fetch_monitor_id) await watch(unchanged, UNCHANGED_TEXT);
    await watch(other, "Some other page\n\n$5/mo.\n");

    const bareOther = { id: "other-1", fetch_monitor_id: other.fetch_monitor_id, outcome: "unchanged" };
    for (const payload of [unchanged, changedReal, bareOther]) expect((await post(payload)).status).toBe(200);

    const byPage = new Map<string, string[]>();
    for (const run of await runs()) byPage.set(run.page_id, [...(byPage.get(run.page_id) ?? []), run.monitor_run_id]);
    expect(byPage.get(pageIdFor(other))).toEqual(["other-1"]);
    expect(byPage.get(pageIdFor(unchanged))).toContain(unchanged.id);
    expect(byPage.get(pageIdFor(changedReal))).toContain(changedReal.id);
    expect((await versions(other)).length).toBe(1);
  });

  it("unknown fetch_monitor_id is 404 unknown_monitor, logged without the payload, and stores nothing", async () => {
    await watch(changedReal, BASE_TEXT);
    const payload = clone(changedReal);
    payload.fetch_monitor_id = "mon-nobody-has";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await post(payload);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown_monitor" });

      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("mon-nobody-has");
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("Hobby");
    } finally {
      warn.mockRestore();
    }

    expect(await runs()).toEqual([]);
    expect(await spendRows()).toEqual([]);
    expect(await rawKeys()).toEqual([]);
    expect(await versions(changedReal)).toHaveLength(1);
  });

  it("schedules a capture for a new version and for nothing else (a suppressed run takes no screenshot)", async () => {
    await watch(changedReal, BASE_TEXT);
    const monitor = changedReal.fetch_monitor_id;
    // vi.mock does not work in this pool, so hand the Worker an execution context and count its waitUntil calls.
    const scheduled: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (work: Promise<unknown>) => void scheduled.push(work),
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    async function postCounting(body: unknown): Promise<number> {
      const before = scheduled.length;
      const res = await worker.fetch(
        new Request(`https://fineprint.test/hooks/monitor/${SECRET}`, { method: "POST", body: JSON.stringify(body) }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      await Promise.allSettled(scheduled);
      return scheduled.length - before;
    }

    const noise = clone(changedNoise);
    noise.fetch_monitor_id = monitor;
    expect(await postCounting(noise)).toBe(0); // suppressed
    expect(await postCounting({ id: "hb-1", fetch_monitor_id: monitor, outcome: "unchanged" })).toBe(0);
    expect(await postCounting({ id: "fe-1", fetch_monitor_id: monitor, outcome: "changed", results: [] })).toBe(0);
    expect(await postCounting(changedReal)).toBe(1); // a real version
    expect(await postCounting(changedReal)).toBe(0); // the retry of it
  });

  describe("payload shape", () => {
    const MONITOR = changedReal.fetch_monitor_id;

    it.each([
      ["not JSON", "this is not json"],
      ["an empty body", ""],
      ["a JSON array", "[]"],
      ["JSON null", "null"],
      ["a JSON string", '"changed"'],
      ["no id", JSON.stringify({ fetch_monitor_id: MONITOR, outcome: "unchanged" })],
      ["no fetch_monitor_id", JSON.stringify({ id: "run-1", outcome: "unchanged" })],
      ["a numeric id", JSON.stringify({ id: 5, fetch_monitor_id: MONITOR, outcome: "unchanged" })],
      ["an empty id", JSON.stringify({ id: "", fetch_monitor_id: MONITOR, outcome: "unchanged" })],
      ["an id of 201 characters", JSON.stringify({ id: "r".repeat(201), fetch_monitor_id: MONITOR, outcome: "unchanged" })],
    ])("%s is 400 invalid_payload and stores nothing", async (_name, body) => {
      await seedPage(changedReal);
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_payload" });
      expect(await runs()).toEqual([]);
      expect(await spendRows()).toEqual([]);
      expect(await rawKeys()).toEqual([]);
    });

    it("an id of exactly 200 characters is accepted and keys the raw payload", async () => {
      await watch(changedReal, BASE_TEXT);
      const id = "r".repeat(200);
      const res = await post({ id, fetch_monitor_id: MONITOR, outcome: "unchanged" });
      expect(res.status).toBe(200);
      expect(await rawKeys()).toEqual([`raw/${id}.json`]);
      expect((await runs())[0]!.monitor_run_id).toBe(id);
    });

    it("the secret is checked before the body: a wrong secret with a bad body is still 404 with no body", async () => {
      const res = await post("not json", "wrong-secret");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });

    it("a payload with only id, fetch_monitor_id and outcome is accepted; every optional field defaults", async () => {
      await watch(changedReal, BASE_TEXT);
      const res = await post({ id: "bare-1", fetch_monitor_id: MONITOR, outcome: "unchanged" });
      expect(res.status).toBe(200);
      const [run] = await runs();
      expect(run).toMatchObject({
        monitor_run_id: "bare-1",
        outcome: "unchanged",
        is_baseline: 0,
        judgment_relevant: null,
        judgment_summary: null,
        diff_truncated: 0,
        noise_suppressed: 0,
      });
    });

    it("a changed run with junk in results, errors and judgment is a fetch_error, not a 500", async () => {
      await watch(changedReal, BASE_TEXT);
      const res = await post({
        id: "junk-1",
        fetch_monitor_id: MONITOR,
        outcome: "changed",
        results: "nope",
        errors: "nope",
        judgment: "nope",
        diff_truncated: "yes",
      });
      expect(res.status).toBe(200);
      const [run] = await runs();
      expect(run).toMatchObject({ noise_reason: "fetch_error", noise_suppressed: 0, judgment_relevant: null, diff_truncated: 0 });
      expect(await versions(changedReal)).toHaveLength(1);
    });

    it("stores judgment, diff_truncated and is_baseline as given", async () => {
      await watch(changedReal, BASE_TEXT);
      const payload = clone(unchanged);
      payload.fetch_monitor_id = MONITOR;
      payload.id = "flags-1";
      payload.diff_truncated = true;
      payload.is_baseline = true;
      payload.judgment = { purpose: "p", is_relevant: false, summary: "nothing that matters", error: null };
      expect((await post(payload)).status).toBe(200);
      expect((await runs())[0]).toMatchObject({
        is_baseline: 1,
        diff_truncated: 1,
        judgment_relevant: 0,
        judgment_summary: "nothing that matters",
      });
    });
  });

  describe("outcomes other than changed", () => {
    it("a baseline run is stored, creates no version and replaces nothing", async () => {
      await watch(changedReal, BASE_TEXT);
      const payload = clone(changedReal);
      payload.id = "rebaseline-1";
      payload.outcome = "baseline";
      payload.is_baseline = true;
      payload.diff = null;

      const res = await post(payload);
      expect(res.status).toBe(200);
      const [run] = await runs();
      expect(await res.json()).toEqual({ ok: true, run_id: run!.id });
      expect(run).toMatchObject({ outcome: "baseline", is_baseline: 1, noise_suppressed: 0 });
      expect(await versions(changedReal)).toHaveLength(1);
      expect(await spendRows()).toHaveLength(1);
    });

    it("an outcome we do not know is stored as given and treated like unchanged", async () => {
      await watch(changedReal, BASE_TEXT);
      const payload = clone(changedReal);
      payload.id = "mystery-1";
      payload.outcome = "mystery";

      const res = await post(payload);
      expect(res.status).toBe(200);
      const [run] = await runs();
      expect(await res.json()).toEqual({ ok: true, run_id: run!.id });
      expect(run).toMatchObject({ outcome: "mystery", noise_suppressed: 0, noise_reason: null });
      expect(await versions(changedReal)).toHaveLength(1);
      expect((await getPageRow(changedReal)).last_change_at).toBeNull();
      expect(await spendRows()).toHaveLength(1);
    });
  });

  describe("fetch errors are recorded, not counted as noise and not billed", () => {
    const failing: [string, (p: Json) => void][] = [
      ["no results", (p) => void (p.results = [])],
      ["empty text", (p) => void (p.results[0].text = "")],
      ["an errors entry next to good text", (p) => void (p.errors = [{ url: "https://vercel.com/pricing", code: "timeout" }])],
    ];

    it.each(failing)("%s: noise_reason fetch_error, noise_suppressed 0, no version, no spend row", async (_name, break_) => {
      await watch(changedReal, BASE_TEXT);
      const payload = clone(changedReal);
      break_(payload);

      const res = await post(payload);
      expect(res.status).toBe(200);
      const [run] = await runs();
      expect(await res.json()).toEqual({ ok: true, run_id: run!.id });
      expect(run).toMatchObject({ outcome: "changed", noise_suppressed: 0, noise_reason: "fetch_error" });
      expect(await versions(changedReal)).toHaveLength(1);
      const page = await getPageRow(changedReal);
      expect(page.last_change_at).toBeNull();
      expect(page.last_run_at).toBe(run!.received_at);
      // TinyFish does not bill a failed check, so the ledger gets nothing.
      expect(await spendRows()).toEqual([]);
    });
  });

  describe("the gate", () => {
    it("a stored hash that went stale still suppresses a run whose text normalizes the same (R40, second comparison)", async () => {
      await seedPage(changedNoise);
      await seedBaseline(changedNoise, BASE_TEXT, "hash-from-older-rules");

      const res = await post(changedNoise);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, suppressed: true });
      expect(await versions(changedNoise)).toHaveLength(1);
      expect((await runs())[0]).toMatchObject({ noise_suppressed: 1, noise_reason: "normalized_identical" });
    });

    it("heals the stale stored hash, so the next run is settled by the stored hash alone", async () => {
      await seedPage(changedNoise);
      await seedBaseline(changedNoise, BASE_TEXT, "hash-from-older-rules");
      const current = await hashText(normalize(BASE_TEXT, []).text);

      expect((await post(changedNoise)).status).toBe(200);
      expect((await versions(changedNoise))[0]!.normalized_hash).toBe(current);

      // Make the stored text useless: a run that had to look at it again could not be suppressed.
      await env.DB.prepare("UPDATE versions SET text = 'not the page' WHERE page_id = ?").bind(pageIdFor(changedNoise)).run();
      const again = clone(changedNoise);
      again.id = "noise-2";
      expect(await (await post(again)).json()).toEqual({ ok: true, suppressed: true });
      expect(await versions(changedNoise)).toHaveLength(1);
    });

    it("a stored hash that matches is trusted without reading the stored text", async () => {
      await watch(changedNoise, BASE_TEXT);
      await env.DB.prepare("UPDATE versions SET text = 'not the page' WHERE page_id = ?").bind(pageIdFor(changedNoise)).run();

      expect(await (await post(changedNoise)).json()).toEqual({ ok: true, suppressed: true });
      expect(await versions(changedNoise)).toHaveLength(1);
    });

    it("a stale hash and a real change creates the version and leaves the old hash alone", async () => {
      await seedPage(changedReal);
      await seedBaseline(changedReal, BASE_TEXT, "hash-from-older-rules");

      const body = (await (await post(changedReal)).json()) as Json;
      expect(body.version_id).toBeTypeOf("string");
      const vs = await versions(changedReal);
      expect(vs).toHaveLength(2);
      expect(vs[0]!.normalized_hash).toBe("hash-from-older-rules");
    });

    it("editing the page's ignore patterns never creates a false version, and the old version's hash is healed to the new rules", async () => {
      // The baseline was hashed with no patterns. Since then the admin added one, and the only
      // difference in the new text is a line the pattern now drops.
      const patterns = ["^(most )?popular$"];
      await seedPage(changedReal, { ignore_patterns: JSON.stringify(patterns) });
      await seedBaseline(changedReal, BASE_TEXT);
      expect(BASE_TEXT).toContain("\n\nPopular\n\n");
      const payload = clone(changedReal);
      payload.id = "pattern-edit-1";
      payload.results[0].text = BASE_TEXT.replace("\n\nPopular\n\n", "\n\nMost popular\n\n");

      const res = await post(payload);
      expect(await res.json()).toEqual({ ok: true, suppressed: true });
      const vs = await versions(changedReal);
      expect(vs).toHaveLength(1);
      expect(vs[0]!.normalized_hash).toBe(await hashText(normalize(BASE_TEXT, patterns).text));
      expect((await runs())[0]).toMatchObject({ noise_suppressed: 1, noise_reason: "normalized_identical" });
    });

    it("a real change still creates a version when the page has ignore patterns, hashed with those patterns", async () => {
      const patterns = ["^(most )?popular$"];
      await seedPage(changedReal, { ignore_patterns: JSON.stringify(patterns) });
      await seedBaseline(changedReal, BASE_TEXT, undefined, patterns);

      const res = await post(changedReal);
      const body = (await res.json()) as Json;
      expect(body.version_id).toBeTypeOf("string");
      const vs = await versions(changedReal);
      expect(vs).toHaveLength(2);
      expect(vs[1]!.normalized_hash).toBe(await hashText(normalize(changedReal.results[0]!.text, patterns).text));
    });

    it("ignore_patterns that is not valid JSON is treated as no patterns", async () => {
      await watch(changedNoise, BASE_TEXT, { ignore_patterns: "this is {not json" });
      expect(await (await post(changedNoise)).json()).toEqual({ ok: true, suppressed: true });
      expect(await versions(changedNoise)).toHaveLength(1);
    });

    it("a page with no version at all gets one from its first changed run", async () => {
      await seedPage(changedReal);
      captureSucceeds();

      const res = await post(changedReal);
      expect(res.status).toBe(200);
      const vs = await versions(changedReal);
      expect(vs).toHaveLength(1);
      // Captured by the waitUntil work `post` awaits: screenshot and source stored, facts run started.
      expect(vs[0]).toMatchObject({ is_baseline: 0, text: changedReal.results[0]!.text, capture_status: "awaiting_facts" });
      expect(await res.json()).toEqual({ ok: true, version_id: vs[0]!.id });
    });

    it("the comparison is against the newest version, not the baseline", async () => {
      await watch(changedReal, BASE_TEXT);
      expect((await post(changedReal)).status).toBe(200); // Pro goes to $25
      expect(await versions(changedReal)).toHaveLength(2);

      // The same $25 text again under a new run id (TinyFish says changed because of a stamp): no third version.
      const again = clone(changedReal);
      again.id = "again-1";
      again.results[0].text = `${changedReal.results[0]!.text}\n\nUpdated: 4 November 2026\n`;
      expect(await (await post(again)).json()).toEqual({ ok: true, suppressed: true });
      expect(await versions(changedReal)).toHaveLength(2);

      // Back to the baseline text ($20) is a real change against the newest version.
      const back = clone(changedReal);
      back.id = "back-1";
      back.results[0].text = BASE_TEXT;
      expect(((await (await post(back)).json()) as Json).version_id).toBeTypeOf("string");
      expect(await versions(changedReal)).toHaveLength(3);
    });
  });

  describe("failures", () => {
    it("a failure while judging leaves no run behind, so the retry is processed (the gate runs before the run is claimed)", async () => {
      await watch(changedReal, BASE_TEXT);
      // Reading the versions table fails: the gate cannot finish. And no run could be given back
      // either, as when the Worker is killed mid-request: the only way to end with no run row is
      // never to have claimed one.
      await env.DB.prepare("ALTER TABLE versions RENAME TO versions_away").run();
      await env.DB.prepare("CREATE TRIGGER keep_runs BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT, 'kept'); END").run();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const failed = await post(changedReal);
        expect(failed.status).toBe(500);
        expect(await failed.json()).toEqual({ error: "internal_error" });
        const logged = error.mock.calls.flat().join(" ");
        expect(logged).not.toContain("Hobby"); // never the page text
        expect(logged).not.toContain(SECRET);
      } finally {
        error.mockRestore();
      }
      expect(await runs()).toEqual([]);
      expect(await spendRows()).toEqual([]);

      await env.DB.prepare("ALTER TABLE versions_away RENAME TO versions").run();
      await env.DB.prepare("DROP TRIGGER keep_runs").run();
      const retry = await post(changedReal);
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as Json).version_id).toBeTypeOf("string");
      expect(await runs()).toHaveLength(1);
      expect(await versions(changedReal)).toHaveLength(2);
      expect(await spendRows()).toHaveLength(1);
    });

    it("a failure after the run is claimed is a 500 that gives the run back, so the retry creates the version (nothing is lost to the duplicate check)", async () => {
      await watch(changedReal, BASE_TEXT);
      await env.DB.prepare(
        "CREATE TRIGGER fail_version_insert BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT, 'disk on fire'); END",
      ).run();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const failed = await post(changedReal);
        expect(failed.status).toBe(500);
        expect(await failed.json()).toEqual({ error: "internal_error" });
        const logged = error.mock.calls.flat().join(" ");
        expect(logged).not.toContain("Hobby"); // never the page text
        expect(logged).not.toContain(SECRET);
      } finally {
        error.mockRestore();
      }
      expect(await runs()).toEqual([]);
      expect(await versions(changedReal)).toHaveLength(1);

      await env.DB.prepare("DROP TRIGGER fail_version_insert").run();
      const retry = await post(changedReal);
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as Json).version_id).toBeTypeOf("string");
      expect(await runs()).toHaveLength(1);
      expect(await versions(changedReal)).toHaveLength(2);
      // The failed delivery wrote nothing to the ledger, so the retry is billed once.
      expect(await spendRows()).toHaveLength(1);
    });

    it("a failing ledger write is logged and does not fail the webhook", async () => {
      await watch(changedReal, BASE_TEXT);
      await env.DB.prepare(
        "CREATE TRIGGER fail_spend_insert BEFORE INSERT ON spend BEGIN SELECT RAISE(ABORT, 'ledger full'); END",
      ).run();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const res = await post(changedReal);
        expect(res.status).toBe(200);
        expect(((await res.json()) as Json).version_id).toBeTypeOf("string");
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        error.mockRestore();
      }
      expect(await runs()).toHaveLength(1);
      expect(await versions(changedReal)).toHaveLength(2);
      expect(await spendRows()).toEqual([]);
    });
  });
});
