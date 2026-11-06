// Migrations 0004 (facts_status), 0005 (the pages table rebuilt so status can be 'retired') and 0006
// (summaries and the pull backoff), applied to a database that already holds rows written under the
// earlier ones, as production does.
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

type Row = Record<string, unknown>;

const upTo = (n: string) => env.TEST_MIGRATIONS.filter((m) => m.name < n);

async function all<T = Row>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}
const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();

async function page(id: string, kind: string, over: Row = {}): Promise<void> {
  const row: Row = {
    id,
    url: `https://example.com/${id}`,
    label: id,
    kind,
    monitor_id: `mon-${id}`,
    schedule_cron: "0 0 * * *",
    purpose: "watch",
    status: "active",
    added_by: "curated",
    ignore_patterns: '["^x$"]',
    expires_at: null,
    created_at: "2026-11-01T00:00:00.000Z",
    last_run_at: "2026-11-02T00:00:00.000Z",
    last_change_at: "2026-11-02T00:00:00.000Z",
    pending_hash: "hash-p",
    pending_run_id: "run-p",
    pending_at: "2026-11-02T01:00:00.000Z",
    ...over,
  };
  const cols = Object.keys(row);
  await run(`INSERT INTO pages (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => row[c]));
}

async function runRow(id: string, pageId: string, relevant: number | null): Promise<void> {
  await run(
    `INSERT INTO runs (id, page_id, monitor_run_id, outcome, is_baseline, judgment_relevant, received_at)
     VALUES (?, ?, ?, 'changed', 0, ?, '2026-11-02T00:00:00.000Z')`,
    id,
    pageId,
    `m-${id}`,
    relevant,
  );
}

async function version(id: string, pageId: string, runId: string | null, over: Row = {}): Promise<void> {
  const row: Row = {
    id,
    page_id: pageId,
    run_id: runId,
    is_baseline: 1,
    captured_at: "2026-11-01T00:00:00.000Z",
    text: "t",
    normalized_hash: "h",
    screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`,
    facts_json: null,
    capture_status: "complete",
    capture_error: null,
    capture_attempts: 0,
    ...over,
  };
  const cols = Object.keys(row);
  await run(`INSERT INTO versions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => row[c]));
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, upTo("0004"));
});

describe("migration 0005: the pages table rebuild", () => {
  it("keeps every column, every row (in order) and the unique url, and allows status retired afterwards", async () => {
    // Same created_at on purpose: the lists tie-break on rowid, so the copy must keep the insertion order.
    await page("p-z", "pricing");
    await page("p-a", "policy", { status: "failed", added_by: "public", expires_at: "2026-11-09T00:00:00.000Z" });
    await page("p-m", "fees", { status: "expired", pending_hash: null, pending_run_id: null, pending_at: null, last_run_at: null, last_change_at: null });
    await page("p-n", "other", { status: "paused", ignore_patterns: "[]" });

    const columns = await all("PRAGMA table_info(pages)");
    const rows = await all("SELECT rowid AS rid, * FROM pages ORDER BY rowid");
    const sql = (await all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'pages'"))[0]!.sql;
    expect(sql).not.toContain("retired");
    await expect(page("p-r", "pricing", { status: "retired" })).rejects.toThrow();

    await applyD1Migrations(env.DB, upTo("0006"));

    expect(await all("PRAGMA table_info(pages)")).toEqual(columns); // name, type, notnull, default and pk of every column
    expect((columns as { name: string }[]).map((c) => c.name)).toEqual([
      "id", "url", "label", "kind", "monitor_id", "schedule_cron", "purpose", "status", "added_by", "ignore_patterns",
      "expires_at", "created_at", "last_run_at", "last_change_at", "pending_hash", "pending_run_id", "pending_at",
    ]);
    expect(await all("SELECT rowid AS rid, * FROM pages ORDER BY rowid")).toEqual(rows);
    expect(await all("SELECT id FROM pages ORDER BY created_at, rowid")).toEqual([{ id: "p-z" }, { id: "p-a" }, { id: "p-m" }, { id: "p-n" }]);

    // The unique index on url is back; the other checks still hold.
    const indexes = await all<{ name: string; unique: number }>("PRAGMA index_list(pages)");
    const unique = indexes.filter((i) => i.unique === 1);
    const onUrl = await Promise.all(unique.map(async (i) => (await all<{ name: string }>(`PRAGMA index_info("${i.name}")`)).map((c) => c.name)));
    expect(onUrl).toContainEqual(["url"]);
    await expect(page("p-dup", "pricing", { url: "https://example.com/p-z" })).rejects.toThrow(/UNIQUE/);
    await expect(page("p-bad", "pricing", { status: "bogus" })).rejects.toThrow(/CHECK/);
    await expect(page("p-bad", "bogus")).rejects.toThrow(/CHECK/);
    await expect(page("p-bad", "pricing", { added_by: "bogus" })).rejects.toThrow(/CHECK/);
    await page("p-r", "pricing", { status: "retired" });
    expect((await all("SELECT status FROM pages WHERE id = 'p-r'"))[0]).toEqual({ status: "retired" });
    // ignore_patterns keeps its NOT NULL DEFAULT '[]'.
    await run("INSERT INTO pages (id, url, status) VALUES ('p-d', 'https://example.com/d', 'active')");
    expect((await all("SELECT ignore_patterns FROM pages WHERE id = 'p-d'"))[0]).toEqual({ ignore_patterns: "[]" });
  });

  it("leaves the other tables as they were", async () => {
    await page("p1", "pricing");
    await runRow("r1", "p1", 1);
    await version("v1", "p1", "r1", { is_baseline: 0 });
    const before = [await all("SELECT * FROM runs"), await all("SELECT id, page_id, run_id FROM versions")];
    await applyD1Migrations(env.DB, upTo("0006"));
    expect([await all("SELECT * FROM runs"), await all("SELECT id, page_id, run_id FROM versions")]).toEqual(before);
  });
});

describe("migration 0006: summaries and the pull backoff", () => {
  it("only adds columns (with their defaults) and empties the diff cache; every existing value is kept", async () => {
    await applyD1Migrations(env.DB, upTo("0006"));
    await page("p1", "pricing");
    await page("p2", "policy", { status: "retired" });
    await runRow("r1", "p1", 1);
    await version("v1", "p1", null);
    await version("v2", "p1", "r1", { is_baseline: 0, captured_at: "2026-11-02T00:00:00.000Z", judgment_summary: "Pro rose" });
    await run("INSERT INTO diff_cache (from_version_id, to_version_id, json, created_at) VALUES ('v1', 'v2', '{}', 'x')");
    const before = {
      pages: await all("SELECT rowid AS rid, * FROM pages ORDER BY rowid"),
      versions: await all("SELECT rowid AS rid, * FROM versions ORDER BY rowid"),
      runs: await all("SELECT * FROM runs"),
      pageColumns: await all<{ name: string }>("PRAGMA table_info(pages)"),
      versionColumns: await all<{ name: string }>("PRAGMA table_info(versions)"),
    };

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const pageColumns = await all<{ name: string; type: string; notnull: number; dflt_value: string | null }>("PRAGMA table_info(pages)");
    const versionColumns = await all<{ name: string; type: string; notnull: number; dflt_value: string | null }>("PRAGMA table_info(versions)");
    // The old columns are untouched and in place; the new ones come after them.
    expect(pageColumns.slice(0, before.pageColumns.length)).toEqual(before.pageColumns);
    expect(versionColumns.slice(0, before.versionColumns.length)).toEqual(before.versionColumns);
    expect(pageColumns.slice(before.pageColumns.length).map((c) => [c.name, c.type, c.notnull, c.dflt_value])).toEqual([
      ["pull_failures", "INTEGER", 1, "0"],
      ["pull_retry_after", "TEXT", 0, null],
    ]);
    expect(versionColumns.slice(before.versionColumns.length).map((c) => [c.name, c.type, c.notnull, c.dflt_value])).toEqual([
      ["summary", "TEXT", 0, null],
      ["summary_source", "TEXT", 0, null],
    ]);
    // Every row keeps every value; the new columns start at their defaults (the admin backfill fills summaries).
    expect(await all("SELECT rowid AS rid, * FROM pages ORDER BY rowid")).toEqual(
      before.pages.map((p) => ({ ...p, pull_failures: 0, pull_retry_after: null })),
    );
    expect(await all("SELECT rowid AS rid, * FROM versions ORDER BY rowid")).toEqual(
      before.versions.map((v) => ({ ...v, summary: null, summary_source: null })),
    );
    expect(await all("SELECT * FROM runs")).toEqual(before.runs);
    // A diff stored under the old finality rule may hold an end whose facts run was still in flight.
    expect(await all("SELECT * FROM diff_cache")).toEqual([]);
  });
});

describe("migration 0004: facts_status backfill", () => {
  it("labels every existing version, and turns a version that failed only for want of facts into a complete one", async () => {
    await page("pr", "pricing");
    await page("po", "policy");
    await runRow("r-irrelevant", "pr", 0);
    await runRow("r-relevant", "pr", 1);
    await runRow("r-unjudged", "pr", null);
    const day = (n: number) => `2026-11-0${n}T00:00:00.000Z`;

    // facts stored -> ok (also on a policy page)
    await version("ok-pricing", "pr", null, { facts_json: "[]", captured_at: day(1) });
    await version("ok-policy", "po", null, { facts_json: "[]", captured_at: day(2) });
    // not a pricing or fees page -> not_needed
    await version("policy", "po", null, { captured_at: day(3), capture_status: "complete" });
    await version("policy-failed", "po", null, { captured_at: day(3), capture_status: "failed", capture_attempts: 3, screenshot_key: null });
    // a later version of a pricing page whose run was judged not relevant -> not_needed
    await version("irrelevant", "pr", "r-irrelevant", { is_baseline: 0, captured_at: day(4), capture_status: "complete" });
    // a baseline always needs facts on a pricing page, whatever its run says
    await version("baseline-irrelevant-run", "pr", "r-irrelevant", { is_baseline: 1, captured_at: day(4), capture_status: "awaiting_facts", capture_attempts: 1 });
    // failed with both keys and no facts -> unavailable, and complete (the three live rows: Ryanair, OpenAI API pricing, Spotify)
    await version("live-1", "pr", null, { captured_at: day(5), capture_status: "failed", capture_attempts: 3, capture_error: "facts: unparseable" });
    await version("live-2", "pr", "r-relevant", { is_baseline: 0, captured_at: day(5), capture_status: "failed", capture_attempts: 3, capture_error: "facts: no_attempts_left" });
    await version("live-3", "pr", "r-unjudged", { is_baseline: 0, captured_at: day(5), capture_status: "failed", capture_attempts: 3 });
    // awaiting_facts -> pending; anything else that needs facts -> pending
    await version("awaiting", "pr", "r-relevant", { is_baseline: 0, captured_at: day(6), capture_status: "awaiting_facts", capture_attempts: 1 });
    await version("pending", "pr", null, { captured_at: day(6), capture_status: "pending", screenshot_key: null, html_key: null });
    await version("partial", "pr", null, { captured_at: day(6), capture_status: "partial", screenshot_key: null, capture_attempts: 1 });
    await version("failed-no-shot", "pr", null, { captured_at: day(6), capture_status: "failed", screenshot_key: null, capture_attempts: 3 });
    await version("complete-no-facts", "pr", "r-relevant", { is_baseline: 0, captured_at: day(7), capture_status: "complete" });
    await run("INSERT INTO diff_cache (from_version_id, to_version_id, json, created_at) VALUES ('a', 'b', '{}', 'x')");
    const before = await all("SELECT * FROM versions ORDER BY rowid");

    await applyD1Migrations(env.DB, upTo("0006"));

    const after = await all<{ id: string; facts_status: string; capture_status: string }>("SELECT * FROM versions ORDER BY rowid");
    expect(after.map((v) => [v.id, v.facts_status, v.capture_status])).toEqual([
      ["ok-pricing", "ok", "complete"],
      ["ok-policy", "ok", "complete"],
      ["policy", "not_needed", "complete"],
      ["policy-failed", "not_needed", "failed"],
      ["irrelevant", "not_needed", "complete"],
      ["baseline-irrelevant-run", "pending", "awaiting_facts"],
      ["live-1", "unavailable", "complete"],
      ["live-2", "unavailable", "complete"],
      ["live-3", "unavailable", "complete"],
      ["awaiting", "pending", "awaiting_facts"],
      ["pending", "pending", "pending"],
      ["partial", "pending", "partial"],
      ["failed-no-shot", "pending", "failed"],
      ["complete-no-facts", "pending", "complete"],
    ]);
    // Nothing else of a version changed, and the diff cache was emptied.
    const strip = (rows: Row[]) => rows.map(({ facts_status: _f, capture_status: _c, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
    expect(await all("SELECT * FROM diff_cache")).toEqual([]);
  });
});
