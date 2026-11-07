import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordSpend } from "../src/core/spend";
import { insertPage, updatePage, type NewPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { PageStatus, RunRow } from "../src/db/types";
import { insertVersion, updateCapture, type NewVersion } from "../src/db/versions";
import { callWorker } from "./helpers/app";

const db = env.DB;
const BASE = "https://fineprint.test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const get = (path: string, init?: RequestInit) => callWorker(path, init);
const getJson = async (path: string): Promise<{ status: number; body: Json; res: Response }> => {
  const res = await get(path);
  return { status: res.status, body: await res.json(), res };
};

// --- Seed: one pricing page, three versions ---------------------------------------------------

const T1 = "2026-11-01T09:00:00.000Z"; // baseline
const T2 = "2026-11-02T09:15:00.000Z"; // Pro $20 -> $25
const T3 = "2026-11-03T14:30:00.000Z"; // Ultra plan added
const BEFORE = "2026-10-31T00:00:00.000Z";

const PAGE = "page-1";
const URL1 = "https://vercel.com/pricing";

const text1 = [
  "# Vercel pricing",
  "",
  "Last updated: 1 November 2026",
  "",
  "## Hobby",
  "",
  "Free for personal projects.",
  "",
  "## Pro",
  "",
  "$20 per month per seat. Includes 10 projects.",
  "",
  "## Enterprise",
  "",
  "Custom pricing. Contact sales.",
].join("\n");
const text2 = text1.replace("$20 per month", "$25 per month").replace("1 November 2026", "2 November 2026");
const text3 = text2
  .replace("## Enterprise", "## Ultra\n\n$200 per month per seat. Includes unlimited projects.\n\n## Enterprise")
  .replace("2 November 2026", "3 November 2026");

const hobby = { name: "Hobby", price: "$0", unit: "month", notes: "Free for personal projects" };
const enterprise = { name: "Enterprise", price: "Custom", unit: null, notes: "Contact sales" };
const pro20 = { name: "Pro", price: "$20", unit: "seat/month", notes: null };
const pro25 = { ...pro20, price: "$25" };
const ultra = { name: "Ultra", price: "$200", unit: "seat/month", notes: null };
const facts1 = [hobby, pro20, enterprise];
const facts2 = [hobby, pro25, enterprise];
const facts3 = [hobby, pro25, ultra, enterprise];

const SUMMARY2 = "The Pro plan went from $20 to $25 per month.";
const SUMMARY3 = "A new Ultra plan at $200 per month was added.";

function pageInput(over: Partial<NewPage> = {}): NewPage {
  return {
    id: PAGE,
    url: URL1,
    label: "Vercel pricing",
    kind: "pricing",
    monitor_id: "mon-1",
    schedule_cron: "0 */12 * * *",
    purpose: "watch prices",
    status: "active",
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
    ...over,
  };
}

function runInput(id: string, over: Partial<RunRow> = {}): RunRow {
  return {
    id,
    page_id: PAGE,
    monitor_run_id: `m-${id}`,
    outcome: "unchanged",
    is_baseline: 0,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: T1,
    trigger_kind: "webhook",
    ...over,
  };
}

function versionInput(id: string, over: Partial<NewVersion> = {}): NewVersion {
  return {
    id,
    page_id: PAGE,
    run_id: null,
    is_baseline: 0,
    captured_at: T1,
    text: text1,
    normalized_hash: `hash-${id}`,
    judgment_summary: null,
    screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`,
    facts_json: null,
    capture_status: "complete",
    ...over,
  };
}

const noise = (id: string, receivedAt: string, pageId = PAGE): RunRow =>
  runInput(id, { page_id: pageId, outcome: "changed", noise_suppressed: 1, noise_reason: "last updated", received_at: receivedAt });

/** Three versions of one pricing page, with runs (five of them noise) around them. */
async function seed(): Promise<void> {
  await insertPage(db, pageInput());

  await insertRun(db, runInput("run-1", { outcome: "baseline", is_baseline: 1, received_at: T1, trigger_kind: "create" }));
  await insertVersion(db, versionInput("ver-1", { run_id: "run-1", is_baseline: 1, captured_at: T1, text: text1, facts_json: JSON.stringify(facts1) }));

  await insertRun(db, noise("noise-at-start", T1)); // on the lower edge of (T1, T3]: not counted
  await insertRun(db, noise("noise-a", "2026-11-01T21:00:00.000Z"));
  await insertRun(db, runInput("run-quiet", { received_at: "2026-11-02T00:00:00.000Z" })); // unchanged, not noise

  await insertRun(db, runInput("run-2", { outcome: "changed", judgment_relevant: 1, judgment_summary: SUMMARY2, received_at: T2 }));
  await insertVersion(
    db,
    versionInput("ver-2", { run_id: "run-2", captured_at: T2, text: text2, judgment_summary: SUMMARY2, facts_json: JSON.stringify(facts2) }),
  );

  await insertRun(db, noise("noise-b", "2026-11-02T21:00:00.000Z"));
  await insertRun(db, noise("noise-at-end", T3)); // on the upper edge of (T1, T3]: counted

  await insertRun(db, runInput("run-3", { outcome: "changed", judgment_relevant: 1, judgment_summary: SUMMARY3, received_at: T3 }));
  await insertVersion(
    db,
    versionInput("ver-3", {
      run_id: "run-3",
      captured_at: T3,
      text: text3,
      judgment_summary: SUMMARY3,
      facts_json: JSON.stringify(facts3),
      screenshot_key: null, // the screenshot capture gave up: final, and without a screenshot
      capture_status: "failed",
      capture_error: "screenshot: request_failed",
    }),
  );

  await insertRun(db, noise("noise-after", "2026-11-04T09:00:00.000Z")); // after T3
  await insertPage(db, pageInput({ id: "page-other", url: "https://example.com/other", label: "Other", monitor_id: "mon-other" }));
  await insertRun(db, noise("noise-other-page", "2026-11-02T12:00:00.000Z", "page-other")); // another page's noise
}

const NOISE_RUNS = 6; // noise-at-start, a, b, at-end, after, other-page

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Versions and as-of -------------------------------------------------------------------------

describe("GET /api/pages/:id/versions/:vid", () => {
  it("returns the version with its text, parsed facts and absolute urls", async () => {
    await seed();
    const { status, body } = await getJson(`/api/pages/${PAGE}/versions/ver-2`);
    expect(status).toBe(200);
    expect(body).toEqual({
      id: "ver-2",
      page_id: PAGE,
      captured_at: T2,
      is_baseline: false,
      text: text2,
      facts: facts2,
      screenshot_url: `${BASE}/shots/ver-2.jpg`,
      source_url: `${BASE}/sources/ver-2.html`,
      thumb_url: null,
      delta: null,
      live_url: URL1,
      summary: SUMMARY2, // the run carried TinyFish's summary, so the version was stored with it
      summary_source: "tinyfish",
      judgment_summary: SUMMARY2,
      capture_status: "complete",
      facts_status: "ok",
      trigger: "webhook",
      notes: null,
    });
  });

  it("says which way the version's run arrived: create for the baseline, else its run's trigger, null without a run", async () => {
    await seed();
    await insertRun(db, runInput("run-pulled", { outcome: "changed", received_at: "2026-11-04T00:00:00.000Z", trigger_kind: "pull" }));
    await insertVersion(db, versionInput("ver-pulled", { run_id: "run-pulled", captured_at: "2026-11-04T00:00:00.000Z" }));
    await insertVersion(db, versionInput("ver-norun", { captured_at: "2026-11-05T00:00:00.000Z" }));
    // A baseline whose run row is missing is still the create baseline.
    await insertPage(db, pageInput({ id: "page-3", url: "https://example.com/3", monitor_id: "mon-3" }));
    await insertVersion(db, versionInput("ver-orphan-base", { page_id: "page-3", is_baseline: 1 }));

    const trigger = async (page: string, id: string) => (await getJson(`/api/pages/${page}/versions/${id}`)).body.trigger;
    expect(await trigger(PAGE, "ver-1")).toBe("create");
    expect(await trigger(PAGE, "ver-3")).toBe("webhook");
    expect(await trigger(PAGE, "ver-pulled")).toBe("pull");
    expect(await trigger(PAGE, "ver-norun")).toBeNull();
    expect(await trigger("page-3", "ver-orphan-base")).toBe("create");
  });

  it("says is_baseline true for the baseline and gives a null url for a capture that is missing", async () => {
    await seed();
    expect((await getJson(`/api/pages/${PAGE}/versions/ver-1`)).body.is_baseline).toBe(true);
    const v3 = (await getJson(`/api/pages/${PAGE}/versions/ver-3`)).body;
    expect(v3.screenshot_url).toBeNull();
    expect(v3.source_url).toBe(`${BASE}/sources/ver-3.html`);
    expect(v3.capture_status).toBe("failed");
  });

  it("gives facts null when none were stored, and null for facts that cannot be read", async () => {
    await seed();
    await insertVersion(db, versionInput("ver-nofacts", { captured_at: "2026-11-04T00:00:00.000Z", facts_json: null }));
    await insertVersion(db, versionInput("ver-badfacts", { captured_at: "2026-11-05T00:00:00.000Z", facts_json: "{not json" }));
    await insertVersion(db, versionInput("ver-objfacts", { captured_at: "2026-11-06T00:00:00.000Z", facts_json: '{"a":1}' }));
    await insertVersion(db, versionInput("ver-emptyfacts", { captured_at: "2026-11-07T00:00:00.000Z", facts_json: "[]" }));
    for (const id of ["ver-nofacts", "ver-badfacts", "ver-objfacts"]) {
      expect((await getJson(`/api/pages/${PAGE}/versions/${id}`)).body.facts, id).toBeNull();
    }
    expect((await getJson(`/api/pages/${PAGE}/versions/ver-emptyfacts`)).body.facts).toEqual([]);
  });

  it("builds urls from PUBLIC_BASE_URL without doubling a trailing slash", async () => {
    await seed();
    const original = env.PUBLIC_BASE_URL;
    try {
      (env as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = "https://fineprint.example/";
      const { body } = await getJson(`/api/pages/${PAGE}/versions/ver-1`);
      expect(body.screenshot_url).toBe("https://fineprint.example/shots/ver-1.jpg");
      expect(body.source_url).toBe("https://fineprint.example/sources/ver-1.html");
    } finally {
      (env as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = original;
    }
  });

  it("is 404 not_found for an unknown page, an unknown version and a version of another page", async () => {
    await seed();
    await insertVersion(db, versionInput("ver-x", { page_id: "page-other", captured_at: T1 }));
    for (const path of [`/api/pages/nope/versions/ver-1`, `/api/pages/${PAGE}/versions/nope`, `/api/pages/${PAGE}/versions/ver-x`]) {
      const { status, body } = await getJson(path);
      expect(status, path).toBe(404);
      expect(body, path).toEqual({ error: "not_found" });
    }
  });
});

describe("GET /api/pages/:id/as-of", () => {
  it("returns the version in force, 404 before_baseline with the baseline time, 400 without at", async () => {
    await seed();
    const asOf = (at: string) => getJson(`/api/pages/${PAGE}/as-of?at=${encodeURIComponent(at)}`);

    // Exactly at a capture time, between two, and after the last: the latest version at or before `at`.
    expect((await asOf(T2)).body.id).toBe("ver-2");
    expect((await asOf("2026-11-02T23:59:59.000Z")).body.id).toBe("ver-2");
    expect((await asOf("2026-12-25T00:00:00.000Z")).body.id).toBe("ver-3");
    // The baseline counts.
    expect((await asOf(T1)).body.id).toBe("ver-1");
    expect((await asOf("2026-11-01T09:00:00.001Z")).body.id).toBe("ver-1");

    // The same shape as /versions/:vid.
    const hit = await asOf(T2);
    expect(hit.status).toBe(200);
    expect(hit.body).toEqual((await getJson(`/api/pages/${PAGE}/versions/ver-2`)).body);

    // Review focus 4: before the baseline is a 404 with the baseline time, never the baseline and never a 500.
    const early = await asOf(BEFORE);
    expect(early.status).toBe(404);
    expect(early.body).toEqual({ error: "before_baseline", baseline_at: T1 });
    const justBefore = await asOf("2026-11-01T08:59:59.999Z");
    expect(justBefore.status).toBe(404);
    expect(justBefore.body).toEqual({ error: "before_baseline", baseline_at: T1 });

    // A missing or unreadable time is a 400.
    for (const path of [`/api/pages/${PAGE}/as-of`, `/api/pages/${PAGE}/as-of?at=`, `/api/pages/${PAGE}/as-of?at=yesterday-ish`]) {
      const res = await getJson(path);
      expect(res.status, path).toBe(400);
      expect(res.body, path).toEqual({ error: "invalid_at" });
    }
  });

  it("reads the time in any ISO form: without milliseconds, with an offset, as a date", async () => {
    await seed();
    const asOf = (at: string) => getJson(`/api/pages/${PAGE}/as-of?at=${encodeURIComponent(at)}`);
    // A time without milliseconds is read as the whole second: it hits a version captured at it.
    expect((await asOf("2026-11-02T09:15:00Z")).body.id).toBe("ver-2");
    // 12:15 at +03:00 is 09:15 UTC.
    expect((await asOf("2026-11-02T12:15:00+03:00")).body.id).toBe("ver-2");
    expect((await asOf("2026-11-02T12:14:59+03:00")).body.id).toBe("ver-1");
    // A bare date is midnight UTC.
    expect((await asOf("2026-11-03")).body.id).toBe("ver-2");
  });

  it("compares a time without milliseconds as .000, so a version captured a few milliseconds later is not in force yet", async () => {
    await seed();
    // Versions carry real milliseconds. As text "…09:15:00Z" sorts after "…09:15:00.123Z", so an
    // unconverted parameter would count this version as captured before it.
    await insertVersion(db, versionInput("ver-ms", { captured_at: "2026-11-02T09:15:00.123Z", text: text2 }));
    const asOf = (at: string) => getJson(`/api/pages/${PAGE}/as-of?at=${encodeURIComponent(at)}`);
    expect((await asOf("2026-11-02T09:15:00Z")).body.id).toBe("ver-2");
    expect((await asOf("2026-11-02T09:15:00.122Z")).body.id).toBe("ver-2");
    expect((await asOf("2026-11-02T09:15:00.123Z")).body.id).toBe("ver-ms");
    expect((await asOf("2026-11-02T09:15:01Z")).body.id).toBe("ver-ms");
    // The same moment written with an offset and no milliseconds.
    expect((await asOf("2026-11-02T12:15:00+03:00")).body.id).toBe("ver-2");

    // And in a diff: the version captured at .123 is a hop after the one at .000.
    const diff = await getJson(`/api/pages/${PAGE}/diff?from=${encodeURIComponent("2026-11-02T09:15:00Z")}&to=${encodeURIComponent("2026-11-02T09:15:01Z")}`);
    expect(diff.body.from.version_id).toBe("ver-2");
    expect(diff.body.to.version_id).toBe("ver-ms");
    expect(diff.body.hops).toBe(1);
  });

  it("is 404 not_found for an unknown page and 404 no_versions for a page that has none", async () => {
    await seed();
    const unknown = await getJson(`/api/pages/nope/as-of?at=${T2}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "not_found" });

    const empty = await getJson(`/api/pages/page-other/as-of?at=${T2}`);
    expect(empty.status).toBe(404);
    expect(empty.body).toEqual({ error: "no_versions" });
  });
});

// --- Diff ---------------------------------------------------------------------------------------

describe("GET /api/pages/:id/diff", () => {
  const diffPath = (from: string, to: string, page = PAGE) =>
    `/api/pages/${page}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const cacheRows = async () =>
    (await db.prepare("SELECT from_version_id, to_version_id, json FROM diff_cache ORDER BY from_version_id, to_version_id").all<{
      from_version_id: string;
      to_version_id: string;
      json: string;
    }>()).results;

  it("between the first and the third version reports the Pro price change in facts and blocks, hops 2, and is served from the cache the second time", async () => {
    await seed();

    const first = await get(diffPath(T1, T3));
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(JSON.parse(firstText)).toEqual({
      page: { id: PAGE, url: URL1, label: "Vercel pricing" },
      from: { version_id: "ver-1", captured_at: T1, screenshot_url: `${BASE}/shots/ver-1.jpg`, source_url: `${BASE}/sources/ver-1.html`, trigger: "create", facts_status: "ok" },
      to: { version_id: "ver-3", captured_at: T3, screenshot_url: null, source_url: `${BASE}/sources/ver-3.html`, trigger: "webhook", facts_status: "ok" },
      summary: SUMMARY3,
      summary_source: "tinyfish",
      blocks: {
        added: [
          { section: "Ultra", text: "## Ultra" },
          { section: "Ultra", text: "$200 per month per seat. Includes unlimited projects." },
        ],
        removed: [],
        // The "Last updated" lines are noise: normalization drops them before the diff.
        changed: [
          {
            section: "Pro",
            before: "$20 per month per seat. Includes 10 projects.",
            after: "$25 per month per seat. Includes 10 projects.",
          },
        ],
      },
      facts: {
        added: [ultra],
        removed: [],
        changed: [{ name: "Pro", field: "price", before: "$20", after: "$25" }],
      },
      hops: 2,
      // noise-a, noise-b and noise-at-end: the interval is open at T1 and closed at T3.
      noise_suppressed_between: 3,
    });

    // One row cached, under the two version ids, holding exactly what was served.
    const rows = await cacheRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ from_version_id: "ver-1", to_version_id: "ver-3", json: firstText });

    // R20: rewrite the cached row; a second call returns the rewritten content, so it was read, not recomputed.
    const sentinel = JSON.stringify({ cached: true, hops: 99 });
    await db.prepare("UPDATE diff_cache SET json = ? WHERE from_version_id = 'ver-1' AND to_version_id = 'ver-3'").bind(sentinel).run();
    const second = await get(diffPath(T1, T3));
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toContain("application/json");
    expect(await second.text()).toBe(sentinel);
    expect(await cacheRows()).toHaveLength(1);

    // Any times that resolve to the same two versions use the same cache row.
    const sameVersions = await get(diffPath("2026-11-01T10:00:00Z", "2026-12-01T00:00:00Z"));
    expect(await sameVersions.text()).toBe(sentinel);
    expect(await cacheRows()).toHaveLength(1);
  });

  // A fourth version, in the state a fresh catch is in while its captures are still running.
  const T4 = "2026-11-04T10:00:00.000Z";
  const text4 = text3.replace("$25 per month", "$30 per month").replace("3 November 2026", "4 November 2026");
  const pro30 = { ...pro25, price: "$30" };
  const facts4 = [hobby, pro30, ultra, enterprise];
  const freshCatch = (over: Partial<NewVersion> = {}) =>
    versionInput("ver-4", {
      captured_at: T4,
      text: text4,
      judgment_summary: "Pro went to $30.",
      screenshot_key: null,
      html_key: null,
      facts_json: null,
      capture_status: "pending",
      ...over,
    });

  it("does not keep a diff while a version is still being captured, and shows its screenshot and facts once they arrive (R73)", async () => {
    await seed();
    await insertVersion(db, freshCatch());

    // The feed's "compare" link on a fresh catch: no screenshot, no source, no facts yet.
    const early = await getJson(diffPath(T3, T4));
    expect(early.status).toBe(200);
    expect(early.body.to).toEqual({ version_id: "ver-4", captured_at: T4, screenshot_url: null, source_url: null, trigger: null, facts_status: "pending" });
    expect(early.body.facts).toBeNull();
    expect(early.body.blocks.changed).toEqual([
      { section: "Pro", before: "$25 per month per seat. Includes 10 projects.", after: "$30 per month per seat. Includes 10 projects." },
    ]);
    expect(await cacheRows()).toHaveLength(0);
    // Asked again while it is still running, it is computed again and still not kept.
    expect((await getJson(diffPath(T3, T4))).body).toEqual(early.body);
    expect(await cacheRows()).toHaveLength(0);

    // The captures finish: the same request now shows the urls and the facts, and this answer is kept.
    await updateCapture(db, "ver-4", {
      screenshot_key: "shots/ver-4.jpg",
      html_key: "html/ver-4.html",
      facts_json: JSON.stringify(facts4),
      capture_status: "complete",
      facts_status: "ok",
    });
    const late = await getJson(diffPath(T3, T4));
    expect(late.body.to).toEqual({
      version_id: "ver-4",
      captured_at: T4,
      screenshot_url: `${BASE}/shots/ver-4.jpg`,
      source_url: `${BASE}/sources/ver-4.html`,
      trigger: null, // seeded without a run
      facts_status: "ok",
    });
    expect(late.body.facts).toEqual({ added: [], removed: [], changed: [{ name: "Pro", field: "price", before: "$25", after: "$30" }] });
    const rows = await cacheRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.json)).toEqual(late.body);
  });

  it("keeps a diff only when both versions are complete or failed", async () => {
    await seed();
    const T5 = "2026-11-05T10:00:00.000Z";
    await insertVersion(db, freshCatch({ capture_status: "complete" }));
    // With a summary of its own, so only the capture status decides (a `to` without one is never stored).
    await insertVersion(db, versionInput("ver-5", { captured_at: T5, text: `${text4}\n\nNew line.`, capture_status: "complete", judgment_summary: "A line was added." }));

    for (const status of ["pending", "partial", "awaiting_facts", "complete", "failed"] as const) {
      await db.prepare("DELETE FROM diff_cache").run();
      await db.prepare("UPDATE versions SET capture_status = ? WHERE id = 'ver-4'").bind(status).run();
      // ver-4 as the later end, then as the earlier end (ver-5 is complete).
      for (const [from, to] of [[T3, T4], [T4, T5]] as const) {
        const res = await get(diffPath(from, to));
        expect(res.status, `${status} ${from}`).toBe(200);
        await res.text();
      }
      const final = status === "complete" || status === "failed";
      expect(await cacheRows(), status).toHaveLength(final ? 2 : 0);
    }
  });

  it("does not serve a stored diff while one of its versions is still being captured", async () => {
    await seed();
    await insertVersion(db, freshCatch());
    // A row as an earlier build, which stored a diff at once, would have left.
    await db
      .prepare("INSERT INTO diff_cache (from_version_id, to_version_id, json, created_at) VALUES ('ver-3', 'ver-4', ?, ?)")
      .bind(JSON.stringify({ stale: true }), T4)
      .run();
    const { body } = await getJson(diffPath(T3, T4));
    expect(body.stale).toBeUndefined();
    expect(body.to.version_id).toBe("ver-4");
    expect((await cacheRows())[0]!.json).toBe('{"stale":true}'); // left as it was
  });

  it("drops the page's cached diffs when its ignore patterns or its label are edited, and no other page's", async () => {
    await seed();
    await insertPage(db, pageInput({ id: "page-2", url: "https://notion.com/pricing", label: "Notion pricing", monitor_id: "mon-2" }));
    await insertVersion(db, versionInput("n-1", { page_id: "page-2", is_baseline: 1, captured_at: T1 }));
    await insertVersion(db, versionInput("n-2", { page_id: "page-2", captured_at: T2, judgment_summary: "Notion changed." }));
    const patch = (body: Json) =>
      get(`/api/pages/${PAGE}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const pairs = async () => (await cacheRows()).map((r) => `${r.from_version_id}>${r.to_version_id}`);

    await getJson(diffPath(T1, T3));
    await getJson(diffPath(T1, T2));
    await getJson(diffPath(T1, T2, "page-2"));
    expect(await pairs()).toEqual(["n-1>n-2", "ver-1>ver-2", "ver-1>ver-3"]);

    // An edit that changes neither leaves the cache alone.
    expect((await patch({ kind: "fees" })).status).toBe(200);
    expect(await pairs()).toEqual(["n-1>n-2", "ver-1>ver-2", "ver-1>ver-3"]);

    // Ignore patterns: this page's diffs go, the other page's stays, and the next answer uses the new patterns.
    expect((await patch({ ignore_patterns: ["Includes unlimited projects"] })).status).toBe(200);
    expect(await pairs()).toEqual(["n-1>n-2"]);
    expect((await getJson(diffPath(T1, T3))).body.blocks.added).toEqual([{ section: "Ultra", text: "## Ultra" }]);
    expect(await pairs()).toEqual(["n-1>n-2", "ver-1>ver-3"]);

    // The label is in every stored answer.
    expect((await patch({ label: "Vercel plans" })).status).toBe(200);
    expect(await pairs()).toEqual(["n-1>n-2"]);
    expect((await getJson(diffPath(T1, T3))).body.page.label).toBe("Vercel plans");
  });

  it("between two adjacent versions counts one hop and only the noise inside that interval", async () => {
    await seed();
    const { status, body } = await getJson(diffPath(T1, T2));
    expect(status).toBe(200);
    expect(body.summary).toBe(SUMMARY2);
    expect(body.hops).toBe(1);
    expect(body.noise_suppressed_between).toBe(1); // noise-a; the run at T1 itself is outside
    expect(body.blocks).toEqual({
      added: [],
      removed: [],
      changed: [
        { section: "Pro", before: "$20 per month per seat. Includes 10 projects.", after: "$25 per month per seat. Includes 10 projects." },
      ],
    });
    expect(body.facts).toEqual({ added: [], removed: [], changed: [{ name: "Pro", field: "price", before: "$20", after: "$25" }] });

    const next = (await getJson(diffPath(T2, T3))).body;
    expect(next.hops).toBe(1);
    expect(next.noise_suppressed_between).toBe(2); // noise-b and noise-at-end
  });

  it("gives an empty diff with hops 0 when both times fall in one version", async () => {
    await seed();
    const { status, body } = await getJson(diffPath("2026-11-02T10:00:00Z", "2026-11-02T20:00:00Z"));
    expect(status).toBe(200);
    expect(body.from.version_id).toBe("ver-2");
    expect(body.to.version_id).toBe("ver-2");
    expect(body.summary).toBe(SUMMARY2);
    expect(body.blocks).toEqual({ added: [], removed: [], changed: [] });
    expect(body.facts).toEqual({ added: [], removed: [], changed: [] });
    expect(body.hops).toBe(0);
    expect(body.noise_suppressed_between).toBe(0);

    // The baseline diffed with itself: no summary, no facts change.
    const baseline = (await getJson(diffPath(T1, T1))).body;
    expect(baseline.summary).toBeNull();
    expect(baseline.hops).toBe(0);
  });

  it("gives facts null when either side has none", async () => {
    await seed();
    await insertVersion(
      db,
      versionInput("ver-4", { captured_at: "2026-11-04T00:00:00.000Z", text: text3, facts_json: null, judgment_summary: "Facts are not in yet." }),
    );
    const { body } = await getJson(diffPath(T3, "2026-11-04T01:00:00Z"));
    expect(body.facts).toBeNull();
    expect(body.to.version_id).toBe("ver-4");
    // Blocks still diff (identical text here), and the same version on both sides with no facts is null too.
    expect(body.blocks).toEqual({ added: [], removed: [], changed: [] });
    expect((await getJson(diffPath("2026-11-04T01:00:00Z", "2026-11-04T02:00:00Z"))).body.facts).toBeNull();
  });

  it("diffs the text as the page's current ignore patterns normalize it", async () => {
    await seed();
    await updatePage(db, PAGE, { ignore_patterns: JSON.stringify(["Includes unlimited projects", "(unclosed"]) });
    const { body } = await getJson(diffPath(T1, T3));
    // The Ultra price line matches the pattern, so only its heading is left to report; the bad regex is skipped.
    expect(body.blocks.added).toEqual([{ section: "Ultra", text: "## Ultra" }]);
    expect(body.blocks.changed).toHaveLength(1);
  });

  it("is 404 before_baseline for a from or to before the baseline, with the baseline time", async () => {
    await seed();
    for (const [from, to] of [
      [BEFORE, T3],
      [BEFORE, BEFORE],
      [T2, BEFORE],
    ] as const) {
      const { status, body } = await getJson(diffPath(from, to));
      expect(status, `${from} ${to}`).toBe(404);
      expect(body, `${from} ${to}`).toEqual({ error: "before_baseline", baseline_at: T1 });
    }
    expect(await cacheRows()).toHaveLength(0);
  });

  it("is 400 invalid_range when from resolves to a later version than to", async () => {
    await seed();
    const { status, body } = await getJson(diffPath(T3, T1));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid_range" });
    expect(await cacheRows()).toHaveLength(0);
  });

  it("is 400 for a missing or unreadable from or to, 404 for an unknown page and 404 no_versions for an empty one", async () => {
    await seed();
    const table: [string, number, Json][] = [
      [`/api/pages/${PAGE}/diff`, 400, { error: "invalid_from" }],
      [`/api/pages/${PAGE}/diff?to=${T3}`, 400, { error: "invalid_from" }],
      [`/api/pages/${PAGE}/diff?from=${T1}`, 400, { error: "invalid_to" }],
      [`/api/pages/${PAGE}/diff?from=garbage&to=${T3}`, 400, { error: "invalid_from" }],
      [`/api/pages/${PAGE}/diff?from=${T1}&to=garbage`, 400, { error: "invalid_to" }],
      [`/api/pages/nope/diff?from=${T1}&to=${T3}`, 404, { error: "not_found" }],
      [`/api/pages/page-other/diff?from=${T1}&to=${T3}`, 404, { error: "no_versions" }],
    ];
    for (const [path, expectedStatus, expectedBody] of table) {
      const { status, body } = await getJson(path);
      expect(status, path).toBe(expectedStatus);
      expect(body, path).toEqual(expectedBody);
    }
  });
});

// --- Changes feed -------------------------------------------------------------------------------

describe("GET /api/changes", () => {
  async function seedSecondPage(): Promise<void> {
    await seed();
    await insertPage(db, pageInput({ id: "page-2", url: "https://notion.com/pricing", label: "Notion pricing", monitor_id: "mon-2" }));
    await insertVersion(db, versionInput("n-1", { page_id: "page-2", is_baseline: 1, captured_at: "2026-11-01T10:00:00.000Z" }));
    await insertVersion(
      db,
      versionInput("n-2", { page_id: "page-2", captured_at: "2026-11-02T10:00:00.000Z", judgment_summary: "Plus went up.", html_key: null }),
    );
  }

  it("excludes baselines, lists real changes newest first across pages, and respects limit", async () => {
    await seedSecondPage();
    const all = await getJson("/api/changes");
    expect(all.status).toBe(200);
    expect(all.body.changes.map((c: Json) => c.version_id)).toEqual(["ver-3", "n-2", "ver-2"]);
    expect(all.body.changes[0]).toEqual({
      version_id: "ver-3",
      page_id: PAGE,
      page_label: "Vercel pricing",
      url: URL1,
      captured_at: T3,
      summary: SUMMARY3,
      summary_source: "tinyfish",
      screenshot_url: null,
      trigger: "webhook",
      facts_status: "ok",
      kind: "pricing",
      delta: null,
      thumb_url: null,
    });
    expect(all.body.changes[1]).toEqual({
      version_id: "n-2",
      page_id: "page-2",
      page_label: "Notion pricing",
      url: "https://notion.com/pricing",
      captured_at: "2026-11-02T10:00:00.000Z",
      summary: "Plus went up.",
      summary_source: "tinyfish",
      screenshot_url: `${BASE}/shots/n-2.jpg`,
      trigger: null, // seeded without a run
      facts_status: "pending",
      kind: "pricing",
      delta: null,
      thumb_url: null,
    });

    const limited = await getJson("/api/changes?limit=2");
    expect(limited.body.changes.map((c: Json) => c.version_id)).toEqual(["ver-3", "n-2"]);
  });

  it("filters with since (inclusive, any ISO form) and answers 400 for a since it cannot read", async () => {
    await seedSecondPage();
    const since = async (value: string) =>
      (await getJson(`/api/changes?since=${encodeURIComponent(value)}`)).body.changes.map((c: Json) => c.version_id);
    expect(await since(T3)).toEqual(["ver-3"]);
    expect(await since("2026-11-02T10:00:00Z")).toEqual(["ver-3", "n-2"]); // no milliseconds
    expect(await since("2026-11-02")).toEqual(["ver-3", "n-2", "ver-2"]);
    expect(await since("2027-01-01T00:00:00Z")).toEqual([]);

    for (const path of ["/api/changes?since=garbage", "/api/changes?since="]) {
      const res = await getJson(path);
      expect(res.status, path).toBe(400);
      expect(res.body, path).toEqual({ error: "invalid_since" });
    }
  });

  it("treats limit as 50 when it is not a number and clamps it to 1..200", async () => {
    await seed();
    const statements = Array.from({ length: 205 }, (_, i) =>
      db
        .prepare(
          `INSERT INTO versions (id, page_id, is_baseline, captured_at, text, normalized_hash, capture_status)
           VALUES (?, ?, 0, ?, 't', 'h', 'complete')`,
        )
        .bind(`bulk-${i}`, "page-other", new Date(Date.parse("2026-12-01T00:00:00.000Z") + i * 60_000).toISOString()),
    );
    await db.batch(statements);

    const count = async (query: string) => (await getJson(`/api/changes${query}`)).body.changes.length;
    expect(await count("")).toBe(50);
    expect(await count("?limit=abc")).toBe(50);
    expect(await count("?limit=")).toBe(50);
    expect(await count("?limit=10")).toBe(10);
    expect(await count("?limit=0")).toBe(1);
    expect(await count("?limit=-5")).toBe(1);
    expect(await count("?limit=1000")).toBe(200);
    expect(await count("?limit=200")).toBe(200);
  });

  it("is an empty list when nothing has changed yet", async () => {
    const { status, body } = await getJson("/api/changes");
    expect(status).toBe(200);
    expect(body).toEqual({ changes: [] });
  });
});

// --- Export -------------------------------------------------------------------------------------

describe("GET /api/export.json", () => {
  it("contains absolute screenshot urls and no text", async () => {
    await seed();
    const { status, body, res } = await getJson("/api/export.json");
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(Number.isNaN(Date.parse(body.generated_at))).toBe(false);
    expect(new Date(body.generated_at).toISOString()).toBe(body.generated_at);

    expect(body.pages.map((p: Json) => p.id)).toEqual([PAGE, "page-other"]);
    const page = body.pages[0];
    expect(page).toMatchObject({ id: PAGE, url: URL1, label: "Vercel pricing", kind: "pricing", status: "active", ignore_patterns: [] });
    expect(page.versions).toEqual([
      // The shared version shape (src/handlers/versionJson.ts), with the run's trigger.
      {
        id: "ver-3",
        page_id: PAGE,
        captured_at: T3,
        is_baseline: false,
        summary: SUMMARY3,
        summary_source: "tinyfish",
        judgment_summary: SUMMARY3,
        screenshot_url: null,
        source_url: `${BASE}/sources/ver-3.html`,
        thumb_url: null,
        facts: facts3,
        delta: null,
        capture_status: "failed",
        facts_status: "ok",
        trigger: "webhook",
        notes: null,
      },
      {
        id: "ver-2",
        page_id: PAGE,
        captured_at: T2,
        is_baseline: false,
        summary: SUMMARY2,
        summary_source: "tinyfish",
        judgment_summary: SUMMARY2,
        screenshot_url: `${BASE}/shots/ver-2.jpg`,
        source_url: `${BASE}/sources/ver-2.html`,
        thumb_url: null,
        facts: facts2,
        delta: null,
        capture_status: "complete",
        facts_status: "ok",
        trigger: "webhook",
        notes: null,
      },
      {
        id: "ver-1",
        page_id: PAGE,
        captured_at: T1,
        is_baseline: true,
        summary: null,
        summary_source: null,
        judgment_summary: null,
        screenshot_url: `${BASE}/shots/ver-1.jpg`,
        source_url: `${BASE}/sources/ver-1.html`,
        thumb_url: null,
        facts: facts1,
        delta: null,
        capture_status: "complete",
        facts_status: "ok",
        trigger: "create",
        notes: null,
      },
    ]);
    expect(body.pages[1].versions).toEqual([]);

    // Never the page text, under any key.
    for (const version of page.versions) expect("text" in version).toBe(false);
    expect(JSON.stringify(body)).not.toContain("Includes 10 projects");
    expect(JSON.stringify(body)).not.toContain("Custom pricing.");
  });

  it("reads everything in two queries however many pages there are, and never selects the text column", async () => {
    await seed();
    for (let i = 0; i < 6; i++) {
      await insertPage(db, pageInput({ id: `extra-${i}`, url: `https://example.com/${i}`, monitor_id: `mon-extra-${i}` }));
      await insertVersion(db, versionInput(`extra-v-${i}`, { page_id: `extra-${i}`, is_baseline: 1, captured_at: T1 }));
    }
    const prepare = vi.spyOn(db, "prepare");
    const { status, body } = await getJson("/api/export.json");
    expect(status).toBe(200);
    expect(body.pages).toHaveLength(8);

    const sql = prepare.mock.calls.map((call) => String(call[0]));
    expect(sql).toHaveLength(2);
    for (const statement of sql) {
      expect(statement).not.toMatch(/SELECT\s+\*/i);
      expect(statement).not.toMatch(/\btext\b/i);
    }
  });

  it("is an empty export on an empty database", async () => {
    const { status, body } = await getJson("/api/export.json");
    expect(status).toBe(200);
    expect(body.pages).toEqual([]);
  });
});

// --- Stats --------------------------------------------------------------------------------------

describe("GET /api/stats", () => {
  it("reports spend by kind and cost per catch", async () => {
    await seed();
    // Statuses: page-1 is active, page-other is active; add one page in each other status.
    const extra: [string, PageStatus][] = [
      ["page-paused", "paused"],
      ["page-failed", "failed"],
      ["page-expired", "expired"],
    ];
    for (const [id, status] of extra) {
      await insertPage(db, pageInput({ id, url: `https://example.com/${id}`, monitor_id: `mon-${id}`, status }));
    }
    for (let i = 0; i < 3; i++) await recordSpend(db, "monitor_check", 0.005, `run-${i}`);
    for (let i = 0; i < 2; i++) await recordSpend(db, "screenshot", 0.002, `ver-${i}`);
    await recordSpend(db, "agent_step", 0.016 * 2, "agent-run-1");
    await recordSpend(db, "fetch", 0, "page-1");
    await recordSpend(db, "fetch", 0, "page-2");

    const { status, body } = await getJson("/api/stats");
    expect(status).toBe(200);
    expect(body).toEqual({
      pages: 5,
      runs: 10, // seed(): three version runs, run-quiet and the six noise runs
      versions: 3,
      noise_suppressed: NOISE_RUNS,
      facts_unavailable: 0,
      // ver-3's screenshot capture gave up; every version has its source and its facts; no thumbnail was made.
      versions_with_screenshot: 2,
      versions_with_source: 3,
      versions_with_facts: 3,
      thumbnails: 0,
      // The seeded noise runs carry the reason "last updated": a reason the code does not know has its own key.
      noise_by_reason: { normalized_identical: 0, partial_render: 0, flap: 0, layout_hold: 0, "last updated": NOISE_RUNS },
      spend_usd: 0.051,
      spend_paused: false,
      facts_paused: false,
      spend_by_kind: { monitor_check: 0.015, screenshot: 0.004, agent_step: 0.032, fetch: 0, search: 0 },
      monitors: { active: 2, paused: 1, failed: 1, expired: 1, retired: 0 },
      // Two catches: the baseline is not one.
      cost_per_catch_usd: 0.0255,
      // run-1 is the create baseline; the other nine arrived by webhook.
      runs_by_trigger: { create: 1, webhook: 9, pull: 0 },
      changes: 2,
      layout_only: 0,
      // The earliest page's insert time.
      recording_since: (await db.prepare("SELECT MIN(created_at) AS t FROM pages").first<{ t: string }>())!.t,
      public_slots: { total: 4, used: 0, next_free_at: null },
    });
  });

  it("has every key at zero on an empty database, and no cost per catch without a catch", async () => {
    const { status, body } = await getJson("/api/stats");
    expect(status).toBe(200);
    expect(body).toEqual({
      pages: 0,
      runs: 0,
      versions: 0,
      noise_suppressed: 0,
      facts_unavailable: 0,
      versions_with_screenshot: 0,
      versions_with_source: 0,
      versions_with_facts: 0,
      thumbnails: 0,
      noise_by_reason: { normalized_identical: 0, partial_render: 0, flap: 0, layout_hold: 0 },
      spend_usd: 0,
      spend_paused: false,
      facts_paused: false,
      spend_by_kind: { monitor_check: 0, screenshot: 0, agent_step: 0, fetch: 0, search: 0 },
      monitors: { active: 0, paused: 0, failed: 0, expired: 0, retired: 0 },
      cost_per_catch_usd: null,
      runs_by_trigger: { create: 0, webhook: 0, pull: 0 },
      changes: 0,
      layout_only: 0,
      recording_since: null,
      public_slots: { total: 4, used: 0, next_free_at: null },
    });
  });

  it("says when the facts runs are paused ($6 total spend) and when everything is ($8)", async () => {
    // One ledger row at a time, so no sum of floats stands between the total and the limit.
    const flagsAt = async (total: number) => {
      await db.prepare("DELETE FROM spend").run();
      await recordSpend(db, "monitor_check", total, "ledger");
      const { body } = await getJson("/api/stats");
      return { spend_usd: body.spend_usd, facts_paused: body.facts_paused, spend_paused: body.spend_paused };
    };

    expect(await flagsAt(0)).toEqual({ spend_usd: 0, facts_paused: false, spend_paused: false });
    expect(await flagsAt(5.99)).toEqual({ spend_usd: 5.99, facts_paused: false, spend_paused: false });
    expect(await flagsAt(6)).toEqual({ spend_usd: 6, facts_paused: true, spend_paused: false });
    expect(await flagsAt(7.99)).toEqual({ spend_usd: 7.99, facts_paused: true, spend_paused: false });
    expect(await flagsAt(8)).toEqual({ spend_usd: 8, facts_paused: true, spend_paused: true });
    expect(await flagsAt(9.5)).toEqual({ spend_usd: 9.5, facts_paused: true, spend_paused: true });
  });

  it("rounds money to six decimals and has no cost per catch while only a baseline exists", async () => {
    await insertPage(db, pageInput());
    await insertVersion(db, versionInput("ver-1", { is_baseline: 1 }));
    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    await recordSpend(db, "monitor_check", 0.1, "a");
    await recordSpend(db, "monitor_check", 0.2, "b");
    const { body } = await getJson("/api/stats");
    expect(body.spend_usd).toBe(0.3);
    expect(body.spend_by_kind.monitor_check).toBe(0.3);
    expect(body.cost_per_catch_usd).toBeNull();

    await insertVersion(db, versionInput("ver-2", { captured_at: T2 }));
    await insertVersion(db, versionInput("ver-3", { captured_at: T3 }));
    await insertVersion(db, versionInput("ver-4", { captured_at: "2026-11-04T00:00:00.000Z" }));
    expect((await getJson("/api/stats")).body.cost_per_catch_usd).toBe(0.1); // 0.3 / 3
  });
});

// --- CORS ---------------------------------------------------------------------------------------

describe("CORS", () => {
  it("allows any origin on the read API, including its error answers, and answers a preflight", async () => {
    await seed();
    for (const path of ["/api/stats", `/api/pages/${PAGE}/versions/ver-1`, `/api/pages/${PAGE}/as-of`, `/api/pages/nope/diff`, "/api/changes", "/api/export.json"]) {
      const res = await get(path, { headers: { Origin: "https://judge.example" } });
      expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
    }

    // A 200 diff, computed and stored by the first request and read from the cache by the second.
    const diffUrl = `/api/pages/${PAGE}/diff?from=${T1}&to=${T3}`;
    const computed = await get(diffUrl, { headers: { Origin: "https://judge.example" } });
    expect(computed.status).toBe(200);
    expect(computed.headers.get("access-control-allow-origin")).toBe("*");
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM diff_cache").first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const cached = await get(diffUrl, { headers: { Origin: "https://judge.example" } });
    expect(cached.status).toBe(200);
    expect(cached.headers.get("access-control-allow-origin")).toBe("*");
    expect(await cached.text()).toBe(await computed.text());

    const preflight = await get(`/api/pages/${PAGE}/diff`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://judge.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
