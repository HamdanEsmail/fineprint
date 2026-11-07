import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertPage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { RunRow, TriggerKind } from "../src/db/types";
import { insertVersion, type NewVersion } from "../src/db/versions";
import { cacheKey, dropCached } from "../src/site/htmlCache";
import worker from "../src/index";

// The stored copy of the likely screens (src/site/htmlCache.ts): the first answer is a miss that stores
// html/<key>, the next is a hit with the same body and headers, and every screen with a varying query
// parameter, every 404 and every screen that still refreshes itself is never stored.

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
