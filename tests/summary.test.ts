// Summaries (Task 15): every non-baseline version carries a plain one-line `summary` and its
// `summary_source`: TinyFish's judgment summary when the run had one ("tinyfish"), otherwise a line built
// from Fineprint's own structured diff against the previous version ("diff"). The diff line is built out
// of band (the admin fill route, in its own Worker invocation), never inside the webhook or pull request.
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { captureDeps } from "../src/capture";
import { structuredDiff } from "../src/core/diff";
import { SUMMARY_TEXT_BUDGET_CHARS } from "../src/core/limits";
import { hashText, normalize } from "../src/core/normalize";
import { diffSummary, oneLine, SUMMARY_MAX_CHARS } from "../src/core/summary";
import { cronDeps, runCron } from "../src/cron";
import { insertPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { VersionRow } from "../src/db/types";
import { insertVersion, type NewVersion } from "../src/db/versions";
import type { Env } from "../src/env";
import { summaryDeps } from "../src/summary";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import runNowFixture from "./fixtures/tinyfish/monitor-runnow.json";
import changedReal from "./fixtures/webhooks/changed-real.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ADMIN = { Authorization: "Bearer test-admin" };
const FETCH_API = "https://api.fetch.tinyfish.ai/";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";

const BASE_TEXT = ["# Example pricing", "", "## Pro", "", "$20 per month per seat.", "", "Includes 10 projects."].join("\n");
const REAL_TEXT = BASE_TEXT.replace("$20 per month", "$25 per month");

const summarize = (from: string, to: string) => {
  const next = normalize(to).text;
  return diffSummary(structuredDiff(normalize(from).text, next), next);
};

// --- The diff line -------------------------------------------------------------------------------

describe("diffSummary", () => {
  it("counts the blocks and quotes the first added or changed line, as in the plan's example", () => {
    const from = ["# Plans", "", "## Pro", "", "Pro is $20 a month.", "", "Footer"].join("\n");
    const to = [
      "# Plans",
      "",
      "## Pro",
      "",
      "Claude Code is now included in the Pro plan",
      "",
      "Pro is $25 a month.",
      "",
      "A second new paragraph.",
      "",
      "A third new paragraph.",
      "",
      "Footer",
    ].join("\n");
    expect(summarize(from, to)).toBe('3 blocks added, 1 changed: "Claude Code is now included in the Pro plan"');
  });

  it("one changed block: names the line that changed, not the block's first line", () => {
    const from = ["## Pro", "", "Pro plan for growing teams and agencies", "$20 per month for every seat in the team", "10 projects"].join("\n");
    const to = ["## Pro", "", "Pro plan for growing teams and agencies", "$25 per month for every seat in the team", "10 projects"].join("\n");
    expect(summarize(from, to)).toBe('1 block changed: "$25 per month for every seat in the team"');
  });

  it("takes whichever of the first added and first changed block comes first in the new text", () => {
    const from = ["## A", "", "Alpha costs $1 per month for each seat.", "", "## B", "", "Beta"].join("\n");
    const to = ["## A", "", "Alpha costs $2 per month for each seat.", "", "## B", "", "Beta", "", "Gamma is a new plan for large teams."].join("\n");
    expect(summarize(from, to)).toBe('1 block added, 1 changed: "Alpha costs $2 per month for each seat."');
  });

  it("lists added, changed and removed counts, and quotes a removed line only when nothing was added or changed", () => {
    const from = ["## A", "", "Kept.", "", "Dropped paragraph one, about the old plan.", "", "Dropped paragraph two."].join("\n");
    const to = ["## A", "", "Kept."].join("\n");
    expect(summarize(from, to)).toBe('2 blocks removed: "Dropped paragraph one, about the old plan."');
    const mixed = ["## A", "", "Kept.", "", "Brand new line that replaces the old ones."].join("\n");
    expect(summarize(from, mixed)).toBe('1 block added, 2 removed: "Brand new line that replaces the old ones."');
  });

  it("is plain text: markdown heading marks, emphasis, code marks and link targets are dropped", () => {
    const from = "Intro";
    const to = ["Intro", "", "* **New**: `Claude` [Code](https://example.com/x) is here for every plan"].join("\n");
    expect(summarize(from, to)).toBe('1 block added: "New: Claude Code is here for every plan"');
  });

  it(`is cut to at most ${SUMMARY_MAX_CHARS} characters, with the quote shortened and closed`, () => {
    const long = "word ".repeat(100).trim();
    const out = summarize("Intro", `Intro\n\n${long}`);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(out).toMatch(/^1 block added: "word word .*…"$/);
  });

  it("never cuts a character made of two UTF-16 units (an emoji) in half", () => {
    // "1 block added" leaves room for 183 characters of quote; the cut keeps 182, and the emoji starts at 181.
    const quote = `${"a".repeat(181)}😀${"b".repeat(60)}`;
    const out = summarize("Intro", `Intro\n\n${quote}`);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    // Booleans, not the string: a lone surrogate in a failure message cannot cross the test pool's socket.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), "a lone surrogate").toBe(false);
    expect(out === `1 block added: "${"a".repeat(181)}…"`, "cut before the emoji").toBe(true);
    // An emoji that fits whole is kept.
    expect(summarize("Intro", `Intro\n\n${"a".repeat(170)}😀${"b".repeat(60)}`)).toContain("😀");
  });

  it("still says something when the two texts split into the same blocks", () => {
    expect(diffSummary({ added: [], removed: [], changed: [] }, "x")).toBe("No block-level change after normalization");
  });

  it("oneLine collapses whitespace and treats a blank text as absent", () => {
    expect(oneLine("  The Pro plan\n rose  to $25. ")).toBe("The Pro plan rose to $25.");
    expect(oneLine(" \n ")).toBeNull();
    expect(oneLine(null)).toBeNull();
  });
});

// --- Storage and the API --------------------------------------------------------------------------

const PAGE = "page-sum";
const MONITOR = "mon-sum";
let seq = 0;

async function seedPage(over: Record<string, unknown> = {}): Promise<void> {
  await insertPage(env.DB, {
    id: PAGE, url: "https://example.com/sum", label: "Summary page", kind: "policy", monitor_id: MONITOR,
    schedule_cron: "0 0,12 * * *", purpose: "watch", status: "active", added_by: "curated", ignore_patterns: "[]",
    expires_at: null, ...over,
  });
}

/** A fully captured version; `run` adds a run row with this judgment summary. */
async function seedVersion(id: string, at: string, text: string, over: Partial<NewVersion> = {}, judgment: string | null = null): Promise<void> {
  const runId = `run-${id}`;
  await insertRun(env.DB, {
    id: runId, page_id: PAGE, monitor_run_id: `m-${id}-${++seq}`, outcome: over.is_baseline === 1 ? "baseline" : "changed",
    is_baseline: over.is_baseline ?? 0, judgment_relevant: null, judgment_summary: judgment, diff_truncated: 0, noise_suppressed: 0,
    noise_reason: null, raw_key: null, received_at: at, trigger_kind: over.is_baseline === 1 ? "create" : "pull",
  });
  await insertVersion(env.DB, {
    id, page_id: PAGE, run_id: runId, is_baseline: 0, captured_at: at, text, normalized_hash: await hashText(normalize(text).text),
    judgment_summary: judgment, screenshot_key: `shots/${id}.jpg`, html_key: `html/${id}.html`, capture_status: "complete",
    facts_status: "not_needed", ...over,
  });
}

const all = async <T>(sql: string, ...b: unknown[]): Promise<T[]> => (await env.DB.prepare(sql).bind(...b).all<T>()).results;
const versionRow = async (id: string) => (await all<VersionRow>("SELECT * FROM versions WHERE id = ?", id))[0]!;
const get = async (path: string): Promise<Json> => (await callWorker(path)).json();
const backfill = (query = "", headers: Record<string, string> = ADMIN) =>
  callWorker(`/api/admin/backfill-summaries${query}`, { method: "POST", headers });

let shot: MockInstance<typeof captureDeps.screenshotFullPage>;
let errorLog: MockInstance<typeof console.error>;
const realFill = summaryDeps.fill;
const realNow = cronDeps.now;

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  shot = vi
    .spyOn(captureDeps, "screenshotFullPage")
    .mockImplementation(async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer, height: 800, sessionId: "sess-1" }));
  fetchMock.intercept({ method: "POST", url: FETCH_API, times: Infinity, reply: { json: { results: [{ text: "<html></html>" }] } } });
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fetchMock.reset();
  summaryDeps.fill = realFill;
  cronDeps.now = realNow;
  shot.mockRestore();
  errorLog.mockRestore();
});

describe("storing a summary when a version is created", () => {
  it("a version whose run carried TinyFish's summary stores it at insert, on one line; a baseline stores none", async () => {
    await seedPage();
    await seedVersion("v-base", "2026-11-01T00:00:00.000Z", BASE_TEXT, { is_baseline: 1 }, "A baseline judgment is never a change summary");
    await seedVersion("v-1", "2026-11-02T00:00:00.000Z", REAL_TEXT, {}, "The Pro plan\nrose to $25.");
    expect(await versionRow("v-base")).toMatchObject({ summary: null, summary_source: null });
    expect(await versionRow("v-1")).toMatchObject({ summary: "The Pro plan rose to $25.", summary_source: "tinyfish", judgment_summary: "The Pro plan\nrose to $25." });
  });

  it("a pulled change (no judgment) gets the diff line, filled in its own invocation, and every read API shows it", async () => {
    await seedPage();
    await seedVersion("v-base", "2026-01-15T00:30:00.000Z", BASE_TEXT, { is_baseline: 1 });
    const body = structuredClone(runNowFixture) as Json;
    body.run.id = "tf-pull-1";
    body.run.results[0].text = REAL_TEXT;
    fetchMock.intercept({ method: "POST", url: `${MONITORS_API}/${MONITOR}/runs`, reply: { status: 201, json: body } });
    const fills = vi.fn(realFill);
    summaryDeps.fill = fills;

    const res: Json = await (await callWorker(`/api/admin/pull/${PAGE}`, { method: "POST", headers: ADMIN })).json();

    expect(res).toMatchObject({ pulled: true, outcome: "changed" });
    const expected = "1 block changed";
    expect(await versionRow(res.version_id)).toMatchObject({ summary: expected, summary_source: "diff" });
    // Asked for once, for that version, through the fill seam (by default a SELF request to the admin route).
    expect(fills.mock.calls.map(([, id]) => id)).toEqual([res.version_id]);

    const version = await get(`/api/pages/${PAGE}/versions/${res.version_id}`);
    expect(version).toMatchObject({ summary: expected, summary_source: "diff", judgment_summary: null });
    const feed = await get("/api/changes");
    expect(feed.changes[0]).toMatchObject({ version_id: res.version_id, summary: expected, summary_source: "diff" });
    const detail = await get(`/api/pages/${PAGE}`);
    expect(detail.versions.map((v: Json) => [v.summary, v.summary_source])).toEqual([[expected, "diff"], [null, null]]);
    const exported = await get("/api/export.json");
    expect(exported.pages[0].versions[0]).toMatchObject({ summary: expected, summary_source: "diff" });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("a webhook change with TinyFish's summary is stored as tinyfish, and no diff line is asked for", async () => {
    await seedPage({ monitor_id: changedReal.fetch_monitor_id });
    const base = (changedReal.results[0]!.text as string).replace("$25/mo.", "$20/mo.");
    await seedVersion("v-base", "2026-11-01T00:00:00.000Z", base, { is_baseline: 1 });
    const fills = vi.fn(async () => new Response(null));
    summaryDeps.fill = fills;

    const res: Json = await (
      await callWorker("/hooks/monitor/test-secret", { method: "POST", body: JSON.stringify(changedReal) })
    ).json();

    expect(await versionRow(res.version_id)).toMatchObject({ summary: changedReal.judgment.summary, summary_source: "tinyfish" });
    expect(fills).not.toHaveBeenCalled();
    const feed = await get("/api/changes");
    expect(feed.changes[0]).toMatchObject({ summary: changedReal.judgment.summary, summary_source: "tinyfish" });
  });

  it("a failed fill request is logged and changes nothing else: the version stays, and the backfill fills it later", async () => {
    await seedPage();
    await seedVersion("v-base", "2026-01-15T00:30:00.000Z", BASE_TEXT, { is_baseline: 1 });
    const body = structuredClone(runNowFixture) as Json;
    body.run.id = "tf-pull-2";
    body.run.results[0].text = REAL_TEXT;
    fetchMock.intercept({ method: "POST", url: `${MONITORS_API}/${MONITOR}/runs`, reply: { status: 201, json: body } });
    summaryDeps.fill = async () => {
      throw new Error("subrequest failed");
    };

    const res: Json = await (await callWorker(`/api/admin/pull/${PAGE}`, { method: "POST", headers: ADMIN })).json();

    expect(res).toMatchObject({ pulled: true });
    expect(await versionRow(res.version_id)).toMatchObject({ summary: null, summary_source: null, capture_status: "complete" });
    expect(errorLog.mock.calls.flat().map(String).join(" ")).toContain("subrequest failed");
    summaryDeps.fill = realFill;
    expect(await (await backfill()).json()).toEqual({ filled: 1, remaining: 0, oversized: [] });
    expect(await versionRow(res.version_id)).toMatchObject({ summary: "1 block changed", summary_source: "diff" });
  });
});

describe("POST /api/admin/backfill-summaries", () => {
  async function seedHistory(): Promise<void> {
    await seedPage();
    await seedVersion("v-0", "2026-11-01T00:00:00.000Z", BASE_TEXT, { is_baseline: 1 });
    // Rows written before the summary columns existed: no summary, whatever the run said.
    await seedVersion("v-1", "2026-11-02T00:00:00.000Z", REAL_TEXT, { summary: null, summary_source: null }, "TinyFish: Pro rose to $25.");
    await seedVersion("v-2", "2026-11-03T00:00:00.000Z", `${REAL_TEXT}\n\nIncludes 20 seats.`, { summary: null, summary_source: null });
  }

  it("is admin only, and the token is checked first", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong" }] as Record<string, string>[]) {
      const res = await backfill("", headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "admin_required" });
    }
  });

  it("fills every non-baseline version without a summary, oldest first, against the version before it; baselines stay null; a second call fills nothing", async () => {
    await seedHistory();

    expect(await (await backfill()).json()).toEqual({ filled: 2, remaining: 0, oversized: [] });

    expect(await versionRow("v-0")).toMatchObject({ summary: null, summary_source: null });
    expect(await versionRow("v-1")).toMatchObject({ summary: "TinyFish: Pro rose to $25.", summary_source: "tinyfish" });
    expect(await versionRow("v-2")).toMatchObject({ summary: "1 block added", summary_source: "diff" });
    const before = await all("SELECT * FROM versions ORDER BY rowid");
    expect(await (await backfill()).json()).toEqual({ filled: 0, remaining: 0, oversized: [] });
    expect(await all("SELECT * FROM versions ORDER BY rowid")).toEqual(before);
  });

  it("never replaces a stored summary, and uses the page's current ignore patterns", async () => {
    await seedPage({ ignore_patterns: JSON.stringify(["^Includes 20 seats\\.$"]) });
    await seedVersion("v-0", "2026-11-01T00:00:00.000Z", BASE_TEXT, { is_baseline: 1 });
    await seedVersion("v-1", "2026-11-02T00:00:00.000Z", REAL_TEXT, { summary: "kept as it is", summary_source: "diff" });
    await seedVersion("v-2", "2026-11-03T00:00:00.000Z", `${REAL_TEXT}\n\nIncludes 20 seats.\n\nNew footnote.`, { summary: null, summary_source: null });
    expect(await (await backfill()).json()).toEqual({ filled: 1, remaining: 0, oversized: [] });
    expect(await versionRow("v-1")).toMatchObject({ summary: "kept as it is" });
    expect(await versionRow("v-2")).toMatchObject({ summary: "1 block added", summary_source: "diff" });
  });

  it("?version=<id> fills only that version (an unknown id, a baseline or one already filled: nothing)", async () => {
    await seedHistory();
    expect(await (await backfill("?version=v-2")).json()).toEqual({ filled: 1, remaining: 1, oversized: [] });
    expect(await versionRow("v-1")).toMatchObject({ summary: null });
    expect(await versionRow("v-2")).toMatchObject({ summary_source: "diff" });
    for (const id of ["v-2", "v-0", "nope"]) expect(await (await backfill(`?version=${id}`)).json()).toEqual({ filled: 0, remaining: 1, oversized: [] });
  });

  it("a non-baseline version with no earlier version is described against an empty page", async () => {
    await seedPage();
    await seedVersion("v-only", "2026-11-02T00:00:00.000Z", BASE_TEXT, { summary: null, summary_source: null });
    expect(await (await backfill()).json()).toEqual({ filled: 1, remaining: 0, oversized: [] });
    expect(await versionRow("v-only")).toMatchObject({ summary: "4 blocks added", summary_source: "diff" });
  });

  it(`works on at most ${SUMMARY_TEXT_BUDGET_CHARS} characters of text a call and says how many remain`, async () => {
    await seedPage();
    const big = (n: number) => Array.from({ length: 500 }, (_, k) => `Paragraph ${k} of version ${n}: the fee is $${k}.`).join("\n\n");
    // Each version and the one before it fit the budget, but two such pairs do not.
    expect(big(0).length * 2).toBeGreaterThan(SUMMARY_TEXT_BUDGET_CHARS / 2);
    expect(big(0).length * 2).toBeLessThanOrEqual(SUMMARY_TEXT_BUDGET_CHARS);
    await seedVersion("v-0", "2026-11-01T00:00:00.000Z", big(0), { is_baseline: 1 });
    for (let n = 1; n <= 4; n++) {
      await seedVersion(`v-${n}`, `2026-11-0${n + 1}T00:00:00.000Z`, big(n), { summary: null, summary_source: null });
    }

    expect(await (await backfill()).json()).toEqual({ filled: 1, remaining: 3, oversized: [] });
    let rounds = 1;
    for (let left = 3; left > 0; rounds++) left = ((await (await backfill()).json()) as Json).remaining;
    expect(rounds).toBe(4);
    expect(await all("SELECT id FROM versions WHERE is_baseline = 0 AND summary IS NULL")).toEqual([]);
  });

  describe("versions too large to diff in one call", () => {
    const PAGE_B = "page-sum-b";
    /** Text this long, with its predecessor as long, is over the per-call budget. */
    const huge = (n: number) => "x".repeat(Math.ceil(SUMMARY_TEXT_BUDGET_CHARS / 2) + 500) + `\n\nEntry ${n}.`;

    // No Monitor and no schedule on either page, so the cron's pull and health steps leave them alone.
    async function seedOversizedFirst(): Promise<void> {
      await seedPage({ monitor_id: null, schedule_cron: null });
      await seedVersion("big-0", "2026-11-01T00:00:00.000Z", huge(0), { is_baseline: 1 });
      await seedVersion("big-1", "2026-11-02T00:00:00.000Z", huge(1), { summary: null, summary_source: null }); // the oldest missing
      await insertPage(env.DB, {
        id: PAGE_B, url: "https://example.com/sum-b", label: "B", kind: "policy", monitor_id: null, schedule_cron: null,
        purpose: null, status: "active", added_by: "curated", ignore_patterns: "[]", expires_at: null,
      });
      await seedVersion("b-0", "2026-11-01T00:00:00.000Z", BASE_TEXT, { page_id: PAGE_B, is_baseline: 1 });
      await seedVersion("b-1", "2026-11-03T00:00:00.000Z", REAL_TEXT, { page_id: PAGE_B, summary: null, summary_source: null });
    }

    it("an oversized oldest version is skipped and listed, and blocks neither a smaller later one nor any TinyFish summary", async () => {
      await seedOversizedFirst();
      // 60 versions with TinyFish's summary and none stored yet (rows from before the columns): all in the one call.
      for (let i = 0; i < 60; i++) {
        const at = new Date(Date.parse("2026-11-04T00:00:00.000Z") + i * 60_000).toISOString();
        await seedVersion(`tf-${i}`, at, `${REAL_TEXT}\n\nNote ${i}.`, { page_id: PAGE_B, summary: null, summary_source: null }, `TinyFish says ${i}`);
      }

      expect(await (await backfill()).json()).toEqual({ filled: 61, remaining: 1, oversized: ["big-1"] });

      expect(await versionRow("big-1")).toMatchObject({ summary: null, summary_source: null });
      expect(await versionRow("b-1")).toMatchObject({ summary: "1 block changed", summary_source: "diff" });
      expect(await all("SELECT id FROM versions WHERE summary_source = 'tinyfish'")).toHaveLength(60);
      expect(await versionRow("tf-59")).toMatchObject({ summary: "TinyFish says 59", summary_source: "tinyfish" });
      // Called again, it fills nothing and lists the oversized one again.
      expect(await (await backfill()).json()).toEqual({ filled: 0, remaining: 1, oversized: ["big-1"] });
    });

    it("?version=<id> fills an oversized version, in its own invocation", async () => {
      await seedOversizedFirst();
      expect(await (await backfill("?version=big-1")).json()).toEqual({ filled: 1, remaining: 1, oversized: [] });
      expect(await versionRow("big-1")).toMatchObject({ summary: "1 block changed", summary_source: "diff" });
    });

    it("the hourly cron asks for one default fill and at most one ?version= fill a tick, for the oldest oversized version", async () => {
      await seedOversizedFirst();
      await seedVersion("big-2", "2026-11-05T00:00:00.000Z", huge(2), { summary: null, summary_source: null }); // oversized too, newer
      const fills = vi.fn((e: Env, id?: string) => realFill(e, id));
      summaryDeps.fill = fills;
      vi.spyOn(console, "log").mockImplementation(() => {});
      // The ?version= request takes the oversized versions in turn by the hour (site Task 2): an even hour takes the first.
      cronDeps.now = () => new Date("2026-11-07T00:30:00.000Z");

      await runCron(env);
      expect(fills.mock.calls.map(([, id]) => id)).toEqual([undefined, "big-1"]);
      expect(await versionRow("b-1")).toMatchObject({ summary_source: "diff" });
      expect(await versionRow("big-1")).toMatchObject({ summary_source: "diff" });
      expect(await versionRow("big-2")).toMatchObject({ summary: null });

      fills.mockClear();
      await runCron(env);
      expect(fills.mock.calls.map(([, id]) => id)).toEqual([undefined, "big-2"]);
      expect(await versionRow("big-2")).toMatchObject({ summary_source: "diff" });

      fills.mockClear();
      await runCron(env);
      expect(fills).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    });
  });
});

describe("the hourly cron as a safety net", () => {
  it("asks for one fill when any non-baseline version has no summary, and none otherwise", async () => {
    await insertPage(env.DB, {
      id: PAGE, url: "https://example.com/sum", label: "S", kind: "policy", monitor_id: null, schedule_cron: null,
      purpose: null, status: "active", added_by: "curated", ignore_patterns: "[]", expires_at: null,
    });
    await seedVersion("v-0", "2026-11-01T00:00:00.000Z", BASE_TEXT, { is_baseline: 1 });
    const fills = vi.fn((e: Env, id?: string) => realFill(e, id));
    summaryDeps.fill = fills;
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runCron(env);
    expect(fills).not.toHaveBeenCalled();

    await seedVersion("v-1", "2026-11-02T00:00:00.000Z", REAL_TEXT, { summary: null, summary_source: null });
    await runCron(env);
    expect(fills.mock.calls.map(([, id]) => id)).toEqual([undefined]);
    expect(await versionRow("v-1")).toMatchObject({ summary: "1 block changed", summary_source: "diff" });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("the default fill is a POST to the admin route through the SELF binding, with the admin token", async () => {
    const requests: Request[] = [];
    const fakeEnv = { ...env, SELF: { fetch: async (req: Request) => (requests.push(req), Response.json({ filled: 1, remaining: 0 })) } } as unknown as Env;
    await realFill(fakeEnv, "v/odd id");
    await realFill(fakeEnv);
    expect(requests.map((r) => [r.method, r.url, r.headers.get("Authorization")])).toEqual([
      ["POST", "https://fineprint.internal/api/admin/backfill-summaries?version=v%2Fodd%20id", "Bearer test-admin"],
      ["POST", "https://fineprint.internal/api/admin/backfill-summaries", "Bearer test-admin"],
    ]);
  });
});
