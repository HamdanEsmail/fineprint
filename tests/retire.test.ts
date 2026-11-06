// Retired pages: POST /api/admin/pages/:id/retire deletes the page's Monitor and sets status 'retired';
// the history stays, and the page leaves everything that records or spends.
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_MAX_ATTEMPTS } from "../src/core/limits";
import { cronDeps, runCron } from "../src/cron";
import { countMonitors, expiredPublicPages, insertPage, monitoredPages, pendingConfirmPages, type NewPage } from "../src/db/pages";
import { insertRun, pullCandidates } from "../src/db/runs";
import type { PageRow } from "../src/db/types";
import { insertVersion, nextFactsCandidate, pendingCaptures } from "../src/db/versions";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import changedReal from "./fixtures/webhooks/changed-real.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ADMIN = { Authorization: "Bearer test-admin" };
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const monitorUrl = (id: string) => `${MONITORS_API}/${id}`;
const PAST = "2020-01-01T00:00:00.000Z";

let seq = 0;
async function seedPage(over: Partial<NewPage> = {}): Promise<string> {
  const id = over.id ?? `page-${++seq}`;
  await insertPage(env.DB, {
    id,
    url: `https://example.com/${id}`,
    label: id,
    kind: "pricing",
    monitor_id: `mon-${id}`,
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

async function seedVersion(pageId: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = `v-${++seq}`;
  await insertVersion(env.DB, {
    id,
    page_id: pageId,
    run_id: null,
    is_baseline: 1,
    captured_at: PAST,
    text: "Pro $20/mo.",
    normalized_hash: "hash",
    judgment_summary: null,
    ...over,
  });
  return id;
}

async function seedRun(pageId: string, receivedAt = PAST): Promise<string> {
  const id = `run-${++seq}`;
  await insertRun(env.DB, {
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
    received_at: receivedAt,
    trigger_kind: "webhook",
  });
  return id;
}

const retire = (id: string, headers: Record<string, string> = ADMIN) =>
  callWorker(`/api/admin/pages/${id}/retire`, { method: "POST", headers });
const getPage = async (id: string): Promise<PageRow> => (await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first<PageRow>())!;
const setStatus = (id: string, status: string) => env.DB.prepare("UPDATE pages SET status = ? WHERE id = ?").bind(status, id).run();

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fetchMock.reset();
  vi.restoreAllMocks();
});

describe("POST /api/admin/pages/:id/retire", () => {
  it("needs the admin token, before the page is looked up and before anything is called", async () => {
    const id = await seedPage();
    const refused: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" }, { Authorization: "Basic test-admin" }];
    for (const headers of refused) {
      for (const target of [id, "no-such-page"]) {
        const res = await retire(target, headers);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "admin_required" });
      }
    }
    expect((await getPage(id)).status).toBe("active");
    expect(fetchMock.calls).toEqual([]);
  });

  it("an unknown page is 404", async () => {
    const res = await retire("no-such-page");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("deletes the Monitor, marks the page retired, clears a pending confirm read and keeps the history and the stored objects", async () => {
    const id = await seedPage();
    const versionId = await seedVersion(id, { screenshot_key: "shots/x.jpg", html_key: "html/x.html", capture_status: "complete", facts_status: "unavailable" });
    const runId = await seedRun(id);
    await env.STORE.put("shots/x.jpg", "jpeg");
    await env.DB.prepare("UPDATE pages SET pending_hash = 'h', pending_run_id = 'r', pending_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    fetchMock.intercept({ method: "DELETE", url: monitorUrl(`mon-${id}`), reply: { status: 200, json: {} } });

    const res = await retire(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ retired: true, page: { id, status: "retired" } });

    expect(fetchMock.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${monitorUrl(`mon-${id}`)}`]);
    expect(await getPage(id)).toMatchObject({ status: "retired", monitor_id: `mon-${id}`, pending_hash: null, pending_run_id: null, pending_at: null });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions WHERE id = ?").bind(versionId).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE id = ?").bind(runId).first<{ n: number }>())!.n).toBe(1);
    expect(await env.STORE.get("shots/x.jpg")).not.toBeNull();
  });

  it("a Monitor TinyFish no longer has (404) counts as deleted", async () => {
    const id = await seedPage();
    fetchMock.intercept({ method: "DELETE", url: monitorUrl(`mon-${id}`), reply: { status: 404, json: { error: { code: "NOT_FOUND" } } } });
    expect((await retire(id)).status).toBe(200);
    expect((await getPage(id)).status).toBe("retired");
  });

  it("a page without a Monitor is retired with no TinyFish call", async () => {
    const id = await seedPage({ monitor_id: null });
    expect((await retire(id)).status).toBe(200);
    expect((await getPage(id)).status).toBe("retired");
    expect(fetchMock.calls).toEqual([]);
  });

  it("a Monitor delete that fails leaves the page as it was: 502 monitor_delete_failed", async () => {
    const id = await seedPage({ status: "failed" });
    fetchMock.intercept({ method: "DELETE", url: monitorUrl(`mon-${id}`), reply: { status: 500, json: { error: { code: "INTERNAL" } } } });
    const res = await retire(id);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "monitor_delete_failed" });
    expect((await getPage(id)).status).toBe("failed");
  });

  it("refuses a page that is already retired or expired with 409, and calls nothing", async () => {
    const retired = await seedPage({ status: "retired" });
    const expired = await seedPage({ status: "expired" });
    for (const [id, error] of [[retired, "already_retired"], [expired, "page_expired"]] as const) {
      const res = await retire(id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error });
    }
    expect(fetchMock.calls).toEqual([]);
  });

  it("a paused page can be retired", async () => {
    const id = await seedPage({ status: "paused" });
    fetchMock.intercept({ method: "DELETE", url: monitorUrl(`mon-${id}`), reply: { status: 200, json: {} } });
    expect((await retire(id)).status).toBe(200);
    expect((await getPage(id)).status).toBe("retired");
  });
});

describe("a retired page", () => {
  it("is left out of the pull candidates, the confirm pulls, health, expiry, the repair list, the facts queue and the Monitor count", async () => {
    const live = await seedPage({ id: "live", kind: "pricing", added_by: "public", expires_at: PAST });
    const gone = await seedPage({ id: "gone", kind: "pricing", added_by: "public", expires_at: PAST });
    for (const id of [live, gone]) {
      await seedVersion(id, { capture_status: "awaiting_facts", screenshot_key: "s", html_key: "h", capture_attempts: 1 });
      await seedVersion(id, { is_baseline: 0, captured_at: "2020-01-02T00:00:00.000Z", capture_status: "partial", capture_attempts: 1 });
      await env.DB.prepare("UPDATE pages SET pending_hash = 'h', pending_run_id = 'r', pending_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    }
    await setStatus(gone, "retired");

    expect((await pullCandidates(env.DB)).map((p) => p.id)).toEqual([live]);
    expect(await pendingConfirmPages(env.DB, PAST)).toEqual([live]);
    expect((await monitoredPages(env.DB)).map((p) => p.id)).toEqual([live]);
    expect((await expiredPublicPages(env.DB, new Date().toISOString())).map((p) => p.id)).toEqual([live]);
    expect((await pendingCaptures(env.DB, new Date().toISOString(), CAPTURE_MAX_ATTEMPTS)).map((v) => v.page_id)).toEqual([live]);
    expect(await countMonitors(env.DB)).toBe(1);
    expect(await countMonitors(env.DB, "public")).toBe(1);

    // The queue: only the live page's baseline waits; with that one gone too the queue is empty.
    expect((await nextFactsCandidate(env.DB))?.page_id).toBe(live);
    await setStatus(live, "expired");
    expect(await nextFactsCandidate(env.DB)).toBeNull();
  });

  it("the hourly cron pulls it not, deletes no Monitor of it, and spends nothing on it", async () => {
    const gone = await seedPage({ id: "gone", added_by: "public", expires_at: PAST, status: "retired" });
    await seedVersion(gone, { capture_status: "partial", capture_attempts: 1 });
    await env.DB.prepare("UPDATE pages SET pending_hash = 'h', pending_run_id = 'r', pending_at = ? WHERE id = ?").bind(new Date().toISOString(), gone).run();
    const pull = vi.spyOn(cronDeps, "pull").mockImplementation(async () => Response.json({ ok: true, pulled: false }));

    const result = await runCron(env);

    expect(pull).not.toHaveBeenCalled();
    expect(result).toMatchObject({ repaired: 0, expired: 0, unhealthy: [], pulled: 0 });
    expect(fetchMock.calls).toEqual([]);
    expect((await getPage(gone)).status).toBe("retired");
  });

  it("the pull route refuses it (409 not_pullable) and calls nothing", async () => {
    const id = await seedPage({ status: "retired" });
    const res = await callWorker(`/api/admin/pull/${id}`, { method: "POST", headers: ADMIN });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_pullable" });
    expect(fetchMock.calls).toEqual([]);
  });

  it("a webhook that was already on its way is answered and set aside: no run, no version", async () => {
    const id = await seedPage({ status: "retired", monitor_id: "mon-retired" });
    const payload = { ...changedReal, fetch_monitor_id: "mon-retired", id: "late-run" } as Json;
    const res = await callWorker("/hooks/monitor/test-secret", { method: "POST", body: JSON.stringify(payload) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE page_id = ?").bind(id).first<{ n: number }>())!.n).toBe(0);
    expect(fetchMock.calls).toEqual([]);
  });

  it("rotate-webhook leaves its Monitor alone", async () => {
    const id = await seedPage({ status: "retired" });
    const res = await callWorker("/api/admin/rotate-webhook", {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ base_url: "https://new.example.org" }),
    });
    expect(await res.json()).toEqual({ updated: 0, failed: [] });
    expect(fetchMock.calls).toEqual([]);
    expect((await getPage(id)).status).toBe("retired");
  });

  it("stays in the list, the detail, the export and the history, with status retired, and stats count it", async () => {
    const id = await seedPage({ status: "retired" });
    const versionId = await seedVersion(id, { capture_status: "complete", screenshot_key: "s", html_key: "h", facts_status: "ok", facts_json: "[]" });
    await seedPage({ status: "active" });
    const get = async (path: string): Promise<Json> => (await callWorker(path)).json();

    expect((await get("/api/pages")).pages.find((p: Json) => p.id === id).status).toBe("retired");
    const detail = await get(`/api/pages/${id}`);
    expect(detail.page.status).toBe("retired");
    expect(detail.versions).toHaveLength(1);
    expect((await get("/api/export.json")).pages.find((p: Json) => p.id === id)).toMatchObject({ status: "retired", versions: [{ id: versionId }] });
    expect(await get(`/api/pages/${id}/versions/${versionId}`)).toMatchObject({ id: versionId });
    expect((await get(`/api/pages/${id}/as-of?at=2030-01-01T00:00:00Z`)).id).toBe(versionId);
    expect((await get("/api/stats")).monitors).toEqual({ active: 1, paused: 0, failed: 0, expired: 0, retired: 1 });
  });

  it("frees its Monitor slot: the watchlist cap counts it no more", async () => {
    // 20 pages hold the 20 slots; retiring one leaves room for an add.
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await seedPage({ added_by: "admin" }));
    expect(await countMonitors(env.DB)).toBe(20);
    await setStatus(ids[0]!, "retired");
    expect(await countMonitors(env.DB)).toBe(19);
  });
});
