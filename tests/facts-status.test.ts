// facts_status: what became of a version's price facts, apart from whether its screenshot and source
// were stored (migrations/0004_facts_status.sql, src/capture.ts).
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps, captureStatusFor, captureVersion, factsStatusFor, recordFactsResult } from "../src/capture";
import { CAPTURE_MAX_ATTEMPTS } from "../src/core/limits";
import { insertPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { PageKind, VersionRow } from "../src/db/types";
import { getVersion, insertVersion, nextFactsCandidate, type NewVersion } from "../src/db/versions";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const FETCH_API = "https://api.fetch.tinyfish.ai/";
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const HTML = "<!doctype html><html><body><h1>Pro</h1></body></html>";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const ITEMS = [{ name: "Pro", price: "$20", unit: "per month" }];

let seq = 0;

async function seedPage(kind: PageKind): Promise<string> {
  const id = `page-${++seq}`;
  await insertPage(env.DB, {
    id,
    url: `https://example.com/${id}`,
    label: id,
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

async function seedVersion(pageId: string, over: Partial<NewVersion> & { relevant?: number | null } = {}): Promise<string> {
  const { relevant = null, ...fields } = over;
  const id = `v-${++seq}`;
  const isBaseline = fields.is_baseline ?? 1;
  await insertRun(env.DB, {
    id: `run-${id}`,
    page_id: pageId,
    monitor_run_id: `mrun-${id}`,
    outcome: isBaseline ? "baseline" : "changed",
    is_baseline: isBaseline,
    judgment_relevant: relevant,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: "2026-11-01T00:00:00.000Z",
    trigger_kind: isBaseline ? "create" : "webhook",
  });
  await insertVersion(env.DB, {
    id,
    page_id: pageId,
    run_id: `run-${id}`,
    is_baseline: isBaseline,
    captured_at: new Date(Date.UTC(2026, 10, 1) + seq * 1000).toISOString(),
    text: "Pro $20/mo.",
    normalized_hash: "hash",
    judgment_summary: null,
    ...fields,
  });
  return id;
}

const version = async (id: string): Promise<VersionRow> => (await getVersion(env.DB, id))!;
const both = { screenshot_key: "shots/a.jpg", html_key: "html/a.html" };

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

let shot: MockInstance<typeof captureDeps.screenshotFullPage>;

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  shot = vi.spyOn(captureDeps, "screenshotFullPage").mockImplementation(async () => ({ bytes: JPEG.slice().buffer, height: 800, sessionId: "s" }));
  captureDeps.sleep = async () => {};
});
afterEach(() => {
  fetchMock.reset();
  shot.mockRestore();
  captureDeps.sleep = undefined;
});

describe("factsStatusFor and the capture status that goes with it", () => {
  const row = (over: Partial<VersionRow>) => ({ screenshot_key: null, html_key: null, facts_json: null, capture_attempts: 1, ...over });

  it.each([
    ["facts not needed", row(both), false, "not_needed", "complete"],
    ["not needed, even with a screenshot missing at the cap", row({ html_key: "h", capture_attempts: CAPTURE_MAX_ATTEMPTS }), false, "not_needed", "failed"],
    ["facts stored", row({ ...both, facts_json: "[]" }), true, "ok", "complete"],
    ["facts needed and queued", row(both), true, "pending", "awaiting_facts"],
    ["facts needed, nothing captured yet", row({ capture_attempts: 0 }), true, "pending", "pending"],
    ["facts needed, source missing", row({ screenshot_key: "s" }), true, "pending", "partial"],
    ["facts needed, attempts used up, screenshot and source stored", row({ ...both, capture_attempts: CAPTURE_MAX_ATTEMPTS }), true, "unavailable", "complete"],
    ["facts needed, screenshot missing at the cap", row({ html_key: "h", capture_attempts: CAPTURE_MAX_ATTEMPTS }), true, "pending", "failed"],
    ["facts stored, source missing at the cap", row({ screenshot_key: "s", facts_json: "[]", capture_attempts: CAPTURE_MAX_ATTEMPTS }), true, "ok", "failed"],
  ] as const)("%s → facts %s, capture %s", (_name, v, needsFacts, facts, capture) => {
    expect(factsStatusFor(v, needsFacts)).toBe(facts);
    expect(captureStatusFor(v, needsFacts)).toBe(capture);
  });
});

describe("facts_status in the pipeline", () => {
  it("a policy version is captured with facts not_needed, and a pricing baseline goes pending, then ok when its facts land", async () => {
    mockCapture();
    const policy = await seedVersion(await seedPage("policy"));
    const pricing = await seedVersion(await seedPage("pricing"));

    await captureVersion(env, policy);
    expect(await version(policy)).toMatchObject({ capture_status: "complete", facts_status: "not_needed" });

    await captureVersion(env, pricing);
    const waiting = await version(pricing);
    expect(waiting).toMatchObject({ capture_status: "awaiting_facts", facts_status: "pending", agent_run_id: "agent-run-1" });

    await recordFactsResult(env, "agent-run-1", "COMPLETED", { items: ITEMS }, 2);
    expect(await version(pricing)).toMatchObject({ capture_status: "complete", facts_status: "ok" });
  });

  it("a later pricing version whose run was judged not relevant needs no facts; a relevant one does", async () => {
    mockCapture();
    const page = await seedPage("pricing");
    const irrelevant = await seedVersion(page, { is_baseline: 0, relevant: 0 });
    await captureVersion(env, irrelevant);
    expect(await version(irrelevant)).toMatchObject({ capture_status: "complete", facts_status: "not_needed" });
    expect(runAsyncCount()).toBe(0);

    const relevant = await seedVersion(page, { is_baseline: 0, relevant: 1 });
    await captureVersion(env, relevant);
    expect(await version(relevant)).toMatchObject({ capture_status: "awaiting_facts", facts_status: "pending" });
  });

  it("facts that fail on every attempt leave a complete version with facts unavailable, and the queue lets go of it", async () => {
    mockCapture();
    const id = await seedVersion(await seedPage("pricing"));
    await captureVersion(env, id); // attempt 1: screenshot, source, run agent-run-1
    await recordFactsResult(env, "agent-run-1", "FAILED", null, 1); // attempt 2, run agent-run-2
    expect(await version(id)).toMatchObject({ capture_status: "awaiting_facts", facts_status: "pending", capture_attempts: 2 });

    await recordFactsResult(env, "agent-run-2", "COMPLETED", { items: [] }, 1); // no price table: attempt 3
    expect(await version(id)).toMatchObject({
      capture_status: "complete",
      facts_status: "unavailable",
      facts_json: null,
      capture_attempts: CAPTURE_MAX_ATTEMPTS,
      agent_run_id: null,
    });
    expect(await nextFactsCandidate(env.DB)).toBeNull();
  });

  it("a missing screenshot at the attempt cap is still failed", async () => {
    mockCapture();
    shot.mockRejectedValue(new Error("CDP timeout"));
    const id = await seedVersion(await seedPage("policy"));
    await captureVersion(env, id);
    await captureVersion(env, id);
    await captureVersion(env, id);
    expect(await version(id)).toMatchObject({ capture_status: "failed", capture_attempts: CAPTURE_MAX_ATTEMPTS, screenshot_key: null });
  });

  it("a version inserted without a facts_status gets pending, and one with facts gets ok", async () => {
    const page = await seedPage("pricing");
    const plain = await seedVersion(page);
    const stored = await seedVersion(page, { facts_json: "[]" });
    expect((await version(plain)).facts_status).toBe("pending");
    expect((await version(stored)).facts_status).toBe("ok");
  });
});

const runAsyncCount = () => fetchMock.calls.filter((c) => c.url === RUN_ASYNC_API).length;

describe("facts_status in every version shape", () => {
  async function setup() {
    const page = await seedPage("pricing");
    const a = await seedVersion(page, { captured_at: "2026-11-01T00:00:00.000Z", ...both, facts_json: JSON.stringify(ITEMS), capture_status: "complete", facts_status: "ok" });
    const b = await seedVersion(page, { captured_at: "2026-11-02T00:00:00.000Z", is_baseline: 0, ...both, capture_status: "complete", facts_status: "unavailable", capture_attempts: 3 });
    return { page, a, b };
  }
  const get = async (path: string): Promise<Json> => (await callWorker(path)).json();

  it("versions/:vid and as-of", async () => {
    const { page, a, b } = await setup();
    expect((await get(`/api/pages/${page}/versions/${a}`)).facts_status).toBe("ok");
    expect((await get(`/api/pages/${page}/versions/${b}`)).facts_status).toBe("unavailable");
    expect((await get(`/api/pages/${page}/as-of?at=2030-01-01T00:00:00Z`)).facts_status).toBe("unavailable");
  });

  it("both ends of a diff", async () => {
    const { page } = await setup();
    const diff = await get(`/api/pages/${page}/diff?from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:00Z`);
    expect([diff.from.facts_status, diff.to.facts_status]).toEqual(["ok", "unavailable"]);
  });

  it("the changes feed, the export and a page's version list", async () => {
    const { page, b } = await setup();
    const changes = await get("/api/changes");
    expect(changes.changes.find((c: Json) => c.version_id === b).facts_status).toBe("unavailable");

    const exported = await get("/api/export.json");
    const versions = exported.pages.find((p: Json) => p.id === page).versions;
    expect(versions.map((v: Json) => v.facts_status).sort()).toEqual(["ok", "unavailable"]);

    const detail = await get(`/api/pages/${page}`);
    expect(detail.versions.map((v: Json) => v.facts_status).sort()).toEqual(["ok", "unavailable"]);
  });

  it("stats count the versions whose facts are unavailable", async () => {
    expect((await get("/api/stats")).facts_unavailable).toBe(0);
    await setup();
    expect((await get("/api/stats")).facts_unavailable).toBe(1);
  });
});
