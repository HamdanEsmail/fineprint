import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedDiff, putCachedDiff } from "../src/db/diffCache";
import {
  countMonitors,
  getPage,
  getPageByMonitorId,
  getPageByUrl,
  insertPage,
  listPages,
  updatePage,
} from "../src/db/pages";
import { publicAddsToday, recordPublicAdd } from "../src/db/publicAdds";
import { countNoise, countRuns, insertRun, markNoise } from "../src/db/runs";
import type { PageRow, RunRow, VersionRow } from "../src/db/types";
import {
  getVersion,
  getVersionByAgentRunId,
  insertVersion,
  latestVersion,
  listChanges,
  listVersions,
  pendingCaptures,
  updateCapture,
  versionAsOf,
} from "../src/db/versions";

const db = env.DB;

const T1 = "2026-11-03T10:00:00.000Z";
const T2 = "2026-11-03T12:00:00.000Z";
const T3 = "2026-11-04T09:30:00.000Z";
const MINUTE = 60_000;
const plusMinutes = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * MINUTE).toISOString();

type NewPage = Omit<PageRow, "created_at" | "last_run_at" | "last_change_at">;

function pageInput(over: Partial<NewPage> = {}): NewPage {
  return {
    id: "page-1",
    url: "https://example.com/pricing",
    label: "Example pricing",
    kind: "pricing",
    monitor_id: "mon-1",
    schedule_cron: "0 */6 * * *",
    purpose: "watch prices",
    status: "active",
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
    ...over,
  };
}

function runInput(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    page_id: "page-1",
    monitor_run_id: "mrun-1",
    outcome: "changed",
    is_baseline: 0,
    judgment_relevant: 1,
    judgment_summary: "price went up",
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: "raw/mrun-1.json",
    received_at: T1,
    trigger_kind: "webhook",
    ...over,
  };
}

function versionInput(over: Partial<VersionRow> = {}): VersionRow {
  return {
    id: "v-1",
    page_id: "page-1",
    run_id: null,
    is_baseline: 0,
    captured_at: T1,
    text: "the full page text",
    normalized_hash: "hash-1",
    judgment_summary: null,
    screenshot_key: null,
    html_key: null,
    facts_json: null,
    capture_status: "pending",
    capture_error: null,
    capture_attempts: 0,
    agent_run_id: null,
    ...over,
  };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pages", () => {
  it("insertPage stamps created_at and the getters find the row by id, monitor id and url", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(T1));
    await insertPage(db, pageInput());
    vi.useRealTimers();

    const byId = await getPage(db, "page-1");
    expect(byId).toEqual({
      ...pageInput(),
      created_at: T1,
      last_run_at: null,
      last_change_at: null,
    });
    expect(await getPageByMonitorId(db, "mon-1")).toEqual(byId);
    expect(await getPageByUrl(db, "https://example.com/pricing")).toEqual(byId);

    expect(await getPage(db, "nope")).toBeNull();
    expect(await getPageByMonitorId(db, "nope")).toBeNull();
    expect(await getPageByUrl(db, "https://example.com/other")).toBeNull();
  });

  it("updatePage changes only whitelisted columns and binds every value", async () => {
    await insertPage(db, pageInput());

    const hostile = "x'; DROP TABLE pages; --";
    await updatePage(db, "page-1", {
      label: hostile,
      status: "paused",
      last_run_at: T2,
      expires_at: T3,
      // Not in the whitelist: must be ignored, never turned into SQL.
      id: "hijacked",
      url: "https://evil.example",
      monitor_id: "other",
      "label = 'pwned', status": "expired",
    } as never);

    const page = await getPage(db, "page-1");
    expect(page).toMatchObject({
      id: "page-1",
      url: "https://example.com/pricing",
      monitor_id: "mon-1",
      label: hostile,
      status: "paused",
      last_run_at: T2,
      expires_at: T3,
    });
    expect(await getPage(db, "hijacked")).toBeNull();
  });

  it("updatePage skips undefined, sets null, and an empty patch does nothing", async () => {
    await insertPage(db, pageInput({ expires_at: T3, purpose: "keep me" }));
    const before = await getPage(db, "page-1");

    await updatePage(db, "page-1", {});
    await updatePage(db, "page-1", { label: undefined });
    expect(await getPage(db, "page-1")).toEqual(before);

    await updatePage(db, "page-1", { expires_at: null, ignore_patterns: '["^Copyright"]' });
    expect(await getPage(db, "page-1")).toMatchObject({
      expires_at: null,
      ignore_patterns: '["^Copyright"]',
      purpose: "keep me",
    });
  });

  it("countMonitors counts active, paused and failed but not expired, optionally per added_by", async () => {
    await insertPage(db, pageInput({ id: "a", url: "https://e.com/a", status: "active", added_by: "curated" }));
    await insertPage(db, pageInput({ id: "b", url: "https://e.com/b", status: "paused", added_by: "public" }));
    await insertPage(db, pageInput({ id: "c", url: "https://e.com/c", status: "failed", added_by: "public" }));
    await insertPage(db, pageInput({ id: "d", url: "https://e.com/d", status: "expired", added_by: "public" }));
    await insertPage(db, pageInput({ id: "e", url: "https://e.com/e", status: "active", added_by: "admin" }));

    expect(await countMonitors(db)).toBe(4);
    expect(await countMonitors(db, "public")).toBe(2);
    expect(await countMonitors(db, "curated")).toBe(1);
    expect(await countMonitors(db, "admin")).toBe(1);
  });

  it("listPages returns every page with version, noise and latest-version figures, ordered by created_at", async () => {
    // Inserted late first, early second: the order must follow created_at, not insertion.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(T3));
    await insertPage(db, pageInput({ id: "late", url: "https://e.com/late", monitor_id: "m-late" }));
    vi.setSystemTime(new Date(T1));
    await insertPage(db, pageInput({ id: "early", url: "https://e.com/early", monitor_id: "m-early" }));
    vi.useRealTimers();

    await insertVersion(db, versionInput({ id: "v1", page_id: "early", is_baseline: 1, captured_at: T1 }));
    await insertVersion(db, versionInput({ id: "v2", page_id: "early", captured_at: T2 }));
    await insertRun(db, runInput({ id: "r1", page_id: "early", monitor_run_id: "m1", noise_suppressed: 1 }));
    await insertRun(db, runInput({ id: "r2", page_id: "early", monitor_run_id: "m2", noise_suppressed: 1 }));
    await insertRun(db, runInput({ id: "r3", page_id: "early", monitor_run_id: "m3", noise_suppressed: 0 }));
    // Another page's rows must not leak in.
    await insertRun(db, runInput({ id: "r4", page_id: "late", monitor_run_id: "m4", noise_suppressed: 1 }));

    const pages = await listPages(db);
    expect(pages.map((p) => p.id)).toEqual(["early", "late"]);
    expect(pages[0]).toMatchObject({
      id: "early",
      url: "https://e.com/early",
      version_count: 2,
      noise_count: 2,
      latest_version_at: T2,
    });
    expect(pages[1]).toMatchObject({ id: "late", version_count: 0, noise_count: 1, latest_version_at: null });
  });
});

describe("runs", () => {
  it("insertRun is idempotent on monitor_run_id", async () => {
    expect(await insertRun(db, runInput())).toBe("inserted");
    expect(await countRuns(db)).toBe(1);

    // A webhook retry: same monitor_run_id, new local id, different content.
    expect(await insertRun(db, runInput({ id: "run-2", outcome: "unchanged", judgment_summary: "retry" }))).toBe(
      "duplicate",
    );
    expect(await countRuns(db)).toBe(1);

    // The first row is untouched.
    const row = await db.prepare("SELECT * FROM runs").first();
    expect(row).toMatchObject({ id: "run-1", outcome: "changed", judgment_summary: "price went up" });

    // A different monitor_run_id is a new run.
    expect(await insertRun(db, runInput({ id: "run-3", monitor_run_id: "mrun-3" }))).toBe("inserted");
    expect(await countRuns(db)).toBe(2);
  });

  it("insertRun stores the run's trigger", async () => {
    for (const [n, trigger] of (["create", "webhook", "pull"] as const).entries()) {
      await insertRun(db, runInput({ id: `run-${trigger}`, monitor_run_id: `mrun-t${n}`, trigger_kind: trigger }));
    }
    const { results } = await db.prepare("SELECT id, trigger_kind FROM runs ORDER BY rowid").all();
    expect(results).toEqual([
      { id: "run-create", trigger_kind: "create" },
      { id: "run-webhook", trigger_kind: "webhook" },
      { id: "run-pull", trigger_kind: "pull" },
    ]);
  });

  it("migration 0002 marks the add-page baselines create, every other recorded run webhook, and empties the diff cache", async () => {
    // A database as 0001 left it, with the rows the add flow and the webhook wrote before 0002.
    await reset();
    const [first, second] = env.TEST_MIGRATIONS;
    expect(second!.name).toBe("0002_run_trigger.sql");
    await applyD1Migrations(db, [first!]);
    const insert = db.prepare(
      "INSERT INTO runs (id, page_id, monitor_run_id, outcome, is_baseline, raw_key, received_at) VALUES (?, 'page-1', ?, ?, ?, ?, ?)",
    );
    await db.batch([
      insert.bind("run-base", "mrun-base", "baseline", 1, null, T1),
      insert.bind("run-same", "mrun-same", "unchanged", 0, "raw/mrun-same.json", T2),
      insert.bind("run-changed", "mrun-changed", "changed", 0, "raw/mrun-changed.json", T3),
    ]);
    await putCachedDiff(db, "v1", "v2", '{"from":{},"to":{}}');

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    const { results } = await db.prepare("SELECT id, trigger_kind FROM runs ORDER BY rowid").all();
    expect(results).toEqual([
      { id: "run-base", trigger_kind: "create" },
      { id: "run-same", trigger_kind: "webhook" },
      { id: "run-changed", trigger_kind: "webhook" },
    ]);
    // A diff stored before 0002 has no trigger on its ends; it is computed again on the next request.
    expect(await getCachedDiff(db, "v1", "v2")).toBeNull();
  });

  it("insertRun stores booleans as 1/0 and keeps unset judgment fields NULL", async () => {
    await insertRun(
      db,
      runInput({
        id: "run-unjudged",
        monitor_run_id: "mrun-u",
        is_baseline: 1,
        judgment_relevant: null,
        judgment_summary: null,
        diff_truncated: 0,
        raw_key: null,
      }),
    );
    const row = await db.prepare("SELECT * FROM runs WHERE id = 'run-unjudged'").first();
    expect(row).toMatchObject({
      is_baseline: 1,
      judgment_relevant: null,
      judgment_summary: null,
      diff_truncated: 0,
      noise_suppressed: 0,
      noise_reason: null,
      raw_key: null,
      received_at: T1,
    });
  });

  it("markNoise flags the run with its reason and countNoise counts only flagged runs", async () => {
    await insertRun(db, runInput({ id: "r1", monitor_run_id: "m1" }));
    await insertRun(db, runInput({ id: "r2", monitor_run_id: "m2" }));
    expect(await countNoise(db)).toBe(0);

    await markNoise(db, "r1", "normalized_identical");
    expect(await countNoise(db)).toBe(1);
    expect(await countRuns(db)).toBe(2);

    const row = await db.prepare("SELECT noise_suppressed, noise_reason FROM runs WHERE id = 'r1'").first();
    expect(row).toEqual({ noise_suppressed: 1, noise_reason: "normalized_identical" });
    const other = await db.prepare("SELECT noise_suppressed, noise_reason FROM runs WHERE id = 'r2'").first();
    expect(other).toEqual({ noise_suppressed: 0, noise_reason: null });
  });
});

describe("versions", () => {
  async function seedThreeVersions(): Promise<void> {
    await insertPage(db, pageInput());
    await insertVersion(db, versionInput({ id: "v1", is_baseline: 1, captured_at: T1 }));
    await insertVersion(db, versionInput({ id: "v2", captured_at: T2 }));
    await insertVersion(db, versionInput({ id: "v3", captured_at: T3 }));
  }

  it("insertVersion applies the capture defaults and getVersion returns the full row with text", async () => {
    await insertPage(db, pageInput());
    await insertVersion(db, {
      id: "v1",
      page_id: "page-1",
      run_id: "run-1",
      is_baseline: 1,
      captured_at: T1,
      text: "hello",
      normalized_hash: "h",
      judgment_summary: "first sight",
    });
    expect(await getVersion(db, "v1")).toEqual({
      id: "v1",
      page_id: "page-1",
      run_id: "run-1",
      is_baseline: 1,
      captured_at: T1,
      text: "hello",
      normalized_hash: "h",
      judgment_summary: "first sight",
      screenshot_key: null,
      html_key: null,
      facts_json: null,
      capture_status: "pending",
      capture_error: null,
      capture_attempts: 0,
      agent_run_id: null,
    });
    expect(await getVersion(db, "missing")).toBeNull();
  });

  it("versionAsOf returns the latest version at or before the time, baseline included", async () => {
    await seedThreeVersions();
    // Another page's versions must never answer for this page.
    await insertPage(db, pageInput({ id: "page-2", url: "https://e.com/2", monitor_id: "mon-2" }));
    await insertVersion(db, versionInput({ id: "other", page_id: "page-2", captured_at: plusMinutes(T2, 30) }));

    const at = async (iso: string) => {
      const r = await versionAsOf(db, "page-1", iso);
      return typeof r === "string" ? r : r.id;
    };

    expect(await at(plusMinutes(T2, 1))).toBe("v2");
    expect(await at(T1)).toBe("v1"); // exactly at the baseline
    expect(await at(T2)).toBe("v2"); // exactly at a version
    expect(await at(plusMinutes(T1, 1))).toBe("v1");
    expect(await at(plusMinutes(T3, 1))).toBe("v3"); // after the last version
    expect(await at(plusMinutes(T1, -1))).toBe("before_baseline");
    expect(await at("2000-01-01T00:00:00.000Z")).toBe("before_baseline");

    // The full row comes back, text included (the diff needs it).
    const hit = await versionAsOf(db, "page-1", plusMinutes(T2, 1));
    expect(hit).toMatchObject({ id: "v2", page_id: "page-1", text: "the full page text" });

    // A page with no versions at all.
    await insertPage(db, pageInput({ id: "empty", url: "https://e.com/empty", monitor_id: "mon-e" }));
    expect(await versionAsOf(db, "empty", T3)).toBe("no_versions");
    expect(await versionAsOf(db, "unknown-page", T3)).toBe("no_versions");
  });

  it("latestVersion returns the newest version with text, or null", async () => {
    await insertPage(db, pageInput());
    expect(await latestVersion(db, "page-1")).toBeNull();
    await insertVersion(db, versionInput({ id: "v1", is_baseline: 1, captured_at: T1 }));
    await insertVersion(db, versionInput({ id: "v3", captured_at: T3 }));
    await insertVersion(db, versionInput({ id: "v2", captured_at: T2 }));
    expect(await latestVersion(db, "page-1")).toMatchObject({ id: "v3", text: "the full page text" });
  });

  it("listVersions never selects text and lists newest first", async () => {
    await seedThreeVersions();
    const versions = await listVersions(db, "page-1");
    expect(versions.map((v) => v.id)).toEqual(["v3", "v2", "v1"]);
    for (const v of versions) expect(v).not.toHaveProperty("text");
    expect(versions[2]).toMatchObject({ id: "v1", is_baseline: 1, normalized_hash: "hash-1", captured_at: T1 });
    expect(await listVersions(db, "unknown-page")).toEqual([]);
  });

  it("listChanges excludes baselines and orders newest first", async () => {
    await insertPage(db, pageInput({ id: "page-1", label: "Pricing", url: "https://e.com/1" }));
    await insertPage(db, pageInput({ id: "page-2", label: "Terms", url: "https://e.com/2", monitor_id: "mon-2" }));
    await insertVersion(db, versionInput({ id: "b1", page_id: "page-1", is_baseline: 1, captured_at: T1 }));
    await insertVersion(db, versionInput({ id: "b2", page_id: "page-2", is_baseline: 1, captured_at: T1 }));
    await insertVersion(db, versionInput({ id: "c1", page_id: "page-1", captured_at: T2, judgment_summary: "up" }));
    await insertVersion(db, versionInput({ id: "c2", page_id: "page-2", captured_at: T3 }));
    await insertVersion(db, versionInput({ id: "c3", page_id: "page-1", captured_at: plusMinutes(T2, 5) }));

    const all = await listChanges(db, null, 50);
    expect(all.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
    expect(all[0]).toMatchObject({ page_id: "page-2", page_label: "Terms", url: "https://e.com/2", captured_at: T3 });
    expect(all[2]).toMatchObject({ page_label: "Pricing", url: "https://e.com/1", judgment_summary: "up" });
    for (const c of all) expect(c).not.toHaveProperty("text");

    // since is inclusive.
    expect((await listChanges(db, T3, 50)).map((c) => c.id)).toEqual(["c2"]);
    expect((await listChanges(db, plusMinutes(T2, 5), 50)).map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(await listChanges(db, plusMinutes(T3, 1), 50)).toEqual([]);

    // limit
    expect((await listChanges(db, null, 2)).map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(await listChanges(db, null, 0)).toEqual([]);
    // A negative limit must not turn into SQLite's "no limit".
    expect(await listChanges(db, null, -1)).toEqual([]);
  });

  it("pendingCaptures returns pending and partial versions only, oldest first, within the attempt and age bounds", async () => {
    await insertPage(db, pageInput());
    const cutoff = plusMinutes(T3, -10);
    await insertVersion(db, versionInput({ id: "p-new", captured_at: plusMinutes(T2, 20), capture_status: "pending" }));
    await insertVersion(db, versionInput({ id: "p-old", captured_at: T1, capture_status: "pending" }));
    await insertVersion(db, versionInput({ id: "partial", captured_at: T2, capture_status: "partial", capture_attempts: 2 }));
    // Excluded:
    await insertVersion(db, versionInput({ id: "awaiting", captured_at: T1, capture_status: "awaiting_facts" }));
    await insertVersion(db, versionInput({ id: "complete", captured_at: T1, capture_status: "complete" }));
    await insertVersion(db, versionInput({ id: "failed", captured_at: T1, capture_status: "failed" }));
    await insertVersion(db, versionInput({ id: "maxed", captured_at: T1, capture_status: "pending", capture_attempts: 3 }));
    await insertVersion(db, versionInput({ id: "too-fresh", captured_at: plusMinutes(cutoff, 1), capture_status: "pending" }));

    const due = await pendingCaptures(db, cutoff, 3);
    expect(due.map((v) => v.id)).toEqual(["p-old", "partial", "p-new"]);
    for (const v of due) expect(v).not.toHaveProperty("text");

    // A version captured exactly at the cutoff is due.
    await insertVersion(db, versionInput({ id: "on-cutoff", captured_at: cutoff, capture_status: "partial" }));
    expect((await pendingCaptures(db, cutoff, 3)).map((v) => v.id)).toContain("on-cutoff");

    // A tighter attempt budget drops the one that already used two.
    expect((await pendingCaptures(db, cutoff, 2)).map((v) => v.id)).not.toContain("partial");
  });

  it("pendingCaptures never returns awaiting_facts, however old and however few attempts", async () => {
    await insertPage(db, pageInput());
    await insertVersion(
      db,
      versionInput({ id: "waiting", captured_at: "2020-01-01T00:00:00.000Z", capture_status: "awaiting_facts", agent_run_id: "agent-1" }),
    );
    expect(await pendingCaptures(db, T3, 3)).toEqual([]);
  });

  it("updateCapture changes only the capture columns, binds values and skips undefined", async () => {
    await insertPage(db, pageInput());
    await insertVersion(db, versionInput({ id: "v1", captured_at: T1 }));

    const hostile = "boom'; DELETE FROM versions; --";
    await updateCapture(db, "v1", {
      screenshot_key: "shots/v1.jpg",
      html_key: "html/v1.html",
      facts_json: '{"items":[]}',
      capture_status: "partial",
      capture_error: hostile,
      capture_attempts: 2,
      agent_run_id: "agent-9",
      // Not in the whitelist: ignored.
      text: "overwritten",
      page_id: "elsewhere",
      is_baseline: 1,
      "capture_status = 'complete', text": "x",
    } as never);

    expect(await getVersion(db, "v1")).toMatchObject({
      page_id: "page-1",
      is_baseline: 0,
      text: "the full page text",
      screenshot_key: "shots/v1.jpg",
      html_key: "html/v1.html",
      facts_json: '{"items":[]}',
      capture_status: "partial",
      capture_error: hostile,
      capture_attempts: 2,
      agent_run_id: "agent-9",
    });

    const before = await getVersion(db, "v1");
    await updateCapture(db, "v1", {});
    await updateCapture(db, "v1", { capture_status: undefined });
    expect(await getVersion(db, "v1")).toEqual(before);

    await updateCapture(db, "v1", { capture_error: null, agent_run_id: null });
    expect(await getVersion(db, "v1")).toMatchObject({ capture_error: null, agent_run_id: null, capture_status: "partial" });
  });

  it("getVersionByAgentRunId finds the version that owns the run, or null", async () => {
    await insertPage(db, pageInput());
    await insertVersion(db, versionInput({ id: "v1", captured_at: T1, agent_run_id: "agent-1", capture_status: "awaiting_facts" }));
    await insertVersion(db, versionInput({ id: "v2", captured_at: T2 }));
    expect(await getVersionByAgentRunId(db, "agent-1")).toMatchObject({ id: "v1", capture_status: "awaiting_facts" });
    expect(await getVersionByAgentRunId(db, "agent-unknown")).toBeNull();
  });
});

describe("diff cache", () => {
  it("stores a diff by version pair and returns null on a miss", async () => {
    expect(await getCachedDiff(db, "v1", "v2")).toBeNull();
    await putCachedDiff(db, "v1", "v2", '{"blocks":[]}');
    expect(await getCachedDiff(db, "v1", "v2")).toBe('{"blocks":[]}');
    // The pair is directional.
    expect(await getCachedDiff(db, "v2", "v1")).toBeNull();
    expect(await getCachedDiff(db, "v1", "v3")).toBeNull();
  });

  it("putCachedDiff twice for the same pair does not throw and keeps the latest", async () => {
    await putCachedDiff(db, "v1", "v2", '{"n":1}');
    await putCachedDiff(db, "v1", "v2", '{"n":2}');
    expect(await getCachedDiff(db, "v1", "v2")).toBe('{"n":2}');
    const count = await db.prepare("SELECT COUNT(*) AS n FROM diff_cache").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("public adds", () => {
  it("publicAddsToday counts per ip per UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T23:59:30.000Z"));

    expect(await publicAddsToday(db, "ip-a")).toBe(0);
    await recordPublicAdd(db, "ip-a");
    expect(await publicAddsToday(db, "ip-a")).toBe(1);
    await recordPublicAdd(db, "ip-a");
    expect(await publicAddsToday(db, "ip-a")).toBe(2);

    // Another caller is counted separately, and so is the "discover:" namespace.
    expect(await publicAddsToday(db, "ip-b")).toBe(0);
    await recordPublicAdd(db, "discover:ip-a");
    expect(await publicAddsToday(db, "discover:ip-a")).toBe(1);
    expect(await publicAddsToday(db, "ip-a")).toBe(2);

    // The row is keyed by the UTC calendar day.
    const rows = await db.prepare("SELECT ip_hash, day, count FROM public_adds ORDER BY ip_hash").all();
    expect(rows.results).toEqual([
      { ip_hash: "discover:ip-a", day: "2026-11-03", count: 1 },
      { ip_hash: "ip-a", day: "2026-11-03", count: 2 },
    ]);

    // Thirty seconds later it is the next UTC day: the count starts again.
    vi.setSystemTime(new Date("2026-11-04T00:00:10.000Z"));
    expect(await publicAddsToday(db, "ip-a")).toBe(0);
    await recordPublicAdd(db, "ip-a");
    expect(await publicAddsToday(db, "ip-a")).toBe(1);

    // And yesterday's count is still on file under its own day.
    const old = await db
      .prepare("SELECT count FROM public_adds WHERE ip_hash = 'ip-a' AND day = '2026-11-03'")
      .first<{ count: number }>();
    expect(old?.count).toBe(2);
  });
});
