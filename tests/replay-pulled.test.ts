// The admin replay reads the raw bodies of pulled runs as well as webhook payloads, decides every run with the
// shared gate (partial-render guard and flap rule included), and reports a decision per run.
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashText, normalize } from "../src/core/normalize";
import { putCachedDiff } from "../src/db/diffCache";
import { insertPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { RunRow, VersionRow } from "../src/db/types";
import { insertVersion } from "../src/db/versions";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import changedReal from "./fixtures/webhooks/changed-real.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ADMIN = { Authorization: "Bearer test-admin" };
const PAGE = "page-rp";
const BASE_TEXT: string = monitorCreate.run.results[0]!.text;
const REAL_TEXT: string = changedReal.results[0]!.text;
const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-02T01:00:00.000Z";
const T2 = "2026-11-02T02:00:00.000Z";
const T3 = "2026-11-02T03:00:00.000Z";

const para = (i: number) => `Item ${String(i).padStart(3, "0")}: the price is $${i}.50 per 1M tokens, billed monthly in arrears.`;
const build = (n: number) => Array.from({ length: n }, (_, k) => para(k)).join("\n\n");

const replay = () => callWorker(`/api/pages/${PAGE}/replay`, { method: "POST", headers: ADMIN });
const all = async <T>(sql: string, ...b: unknown[]): Promise<T[]> => (await env.DB.prepare(sql).bind(...b).all<T>()).results;
const versions = () => all<VersionRow>("SELECT * FROM versions WHERE page_id = ? ORDER BY captured_at, rowid", PAGE);
const runRow = async (id: string) => (await all<RunRow>("SELECT * FROM runs WHERE id = ?", id))[0]!;

async function seedPage(): Promise<void> {
  await insertPage(env.DB, {
    id: PAGE, url: "https://example.com/p", label: "P", kind: "pricing", monitor_id: "mon-rp", schedule_cron: "0 0 * * *",
    purpose: "watch", status: "active", added_by: "curated", ignore_patterns: "[]", expires_at: null,
  });
}

async function seedBaseline(text: string, at = T0): Promise<string> {
  const id = "v-base";
  await insertVersion(env.DB, {
    id, page_id: PAGE, run_id: null, is_baseline: 1, captured_at: at, text,
    normalized_hash: await hashText(normalize(text, []).text), judgment_summary: null,
    screenshot_key: "s", html_key: "h", facts_json: "[]", capture_status: "complete",
  });
  return id;
}

/** The webhook payload of a run, or (pull) the run-now 201 body. */
const webhookBody = (id: string, text: string): Json => ({ ...structuredClone(changedReal), id, results: [{ text }] });
const pullBody = (id: string, text: string, errors: unknown[] = []): Json => ({ run: { id, is_baseline: false, results: [{ text }], errors } });

async function seedRun(n: number, at: string, body: Json | string | null, over: Partial<RunRow> = {}): Promise<string> {
  const key = `raw/mrun-${n}.json`;
  if (body !== null) await env.STORE.put(key, typeof body === "string" ? body : JSON.stringify(body));
  await insertRun(env.DB, {
    id: `run-${n}`, page_id: PAGE, monitor_run_id: `mrun-${n}`, outcome: "changed", is_baseline: 0, judgment_relevant: 1,
    judgment_summary: null, diff_truncated: 0, noise_suppressed: 0, noise_reason: null, raw_key: key, received_at: at,
    trigger_kind: "pull", ...over,
  });
  return `run-${n}`;
}

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => {
  fetchMock.reset();
  vi.restoreAllMocks();
});

describe("replay of pulled runs", () => {
  it("reads a run-now body: it makes the version a webhook payload would, and says `created`", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun(1, T1, pullBody("mrun-1", REAL_TEXT));

    const res = await replay();
    expect(await res.json()).toEqual({
      created: 1,
      suppressed: 0,
      decisions: [{ run_id: "run-1", monitor_run_id: "mrun-1", received_at: T1, decision: "created" }],
    });
    const stored = await versions();
    expect(stored).toHaveLength(2);
    expect(stored[1]).toMatchObject({ run_id: "run-1", captured_at: T1, text: REAL_TEXT, capture_status: "pending", capture_error: "replayed", facts_status: "pending" });
    expect((await all<{ last_change_at: string }>("SELECT last_change_at FROM pages WHERE id = ?", PAGE))[0]!.last_change_at).toBe(T1);
  });

  it("a run-now body with an errors entry, no text or no run id is skipped_unreadable", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun(1, T1, pullBody("mrun-1", REAL_TEXT, [{ code: "timeout" }]));
    await seedRun(2, T1, pullBody("mrun-2", ""));
    await seedRun(3, T1, { run: { results: [{ text: REAL_TEXT }] } });
    await seedRun(4, T1, "not json");
    await seedRun(5, T1, null);

    const body = (await (await replay()).json()) as Json;
    expect(body).toMatchObject({ created: 0, suppressed: 0 });
    expect(body.decisions.map((d: Json) => d.decision)).toEqual(Array(5).fill("skipped_unreadable"));
    expect(await versions()).toHaveLength(1);
  });

  it("reports normalized_identical for a read that is the chain's text again", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun(1, T1, pullBody("mrun-1", `${BASE_TEXT}\n\nLast updated: 3 November 2026\n`));
    const body = (await (await replay()).json()) as Json;
    expect(body).toMatchObject({ created: 0, suppressed: 1, decisions: [{ decision: "normalized_identical" }] });
    expect(await runRow("run-1")).toMatchObject({ noise_suppressed: 1, noise_reason: "normalized_identical" });
  });

  it("holds a suspect partial render back: counted as suppressed with reason partial_render, no version, no confirm read", async () => {
    await seedPage();
    await seedBaseline(build(32));
    await seedRun(1, T1, pullBody("mrun-1", build(10)));

    const body = (await (await replay()).json()) as Json;
    expect(body).toMatchObject({ created: 0, suppressed: 1, decisions: [{ run_id: "run-1", decision: "partial_render" }] });
    expect(await versions()).toHaveLength(1);
    expect(await runRow("run-1")).toMatchObject({ noise_suppressed: 1, noise_reason: "partial_render" });
    expect((await all<{ pending_at: string | null }>("SELECT pending_at FROM pages WHERE id = ?", PAGE))[0]!.pending_at).toBeNull();
  });

  it("suppresses a flap: a text the page had within the last 72 hours", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT); // 1 Nov
    await seedRun(1, T1, webhookBody("mrun-1", REAL_TEXT)); // a real change
    await seedRun(2, T2, pullBody("mrun-2", BASE_TEXT)); // back to the baseline text a day later

    const body = (await (await replay()).json()) as Json;
    expect(body.decisions.map((d: Json) => d.decision)).toEqual(["created", "flap"]);
    expect(body).toMatchObject({ created: 1, suppressed: 1 });
    expect(await runRow("run-2")).toMatchObject({ noise_suppressed: 1, noise_reason: "flap" });
    expect(await versions()).toHaveLength(2);
  });

  it("a text last seen more than 72 hours before the run is not a flap", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT, "2026-10-01T00:00:00.000Z");
    await seedRun(1, T1, webhookBody("mrun-1", REAL_TEXT));
    await seedRun(2, T2, pullBody("mrun-2", BASE_TEXT));
    const body = (await (await replay()).json()) as Json;
    expect(body.decisions.map((d: Json) => d.decision)).toEqual(["created", "created"]);
  });

  it("does not see a version captured after the run (the flap check is as of the run's own time)", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun(1, T1, pullBody("mrun-1", REAL_TEXT)); // no version yet
    // A later version that already holds the same text, made by a later run.
    const later = await seedRun(2, T3, webhookBody("mrun-2", REAL_TEXT));
    await insertVersion(env.DB, {
      id: "v-later", page_id: PAGE, run_id: later, is_baseline: 0, captured_at: T3, text: REAL_TEXT,
      normalized_hash: await hashText(normalize(REAL_TEXT, []).text), judgment_summary: null, capture_status: "complete",
    });
    const body = (await (await replay()).json()) as Json;
    expect(body.decisions[0]).toMatchObject({ run_id: "run-1", decision: "created" });
  });

  it("lists a run that already has a version as existing_version, with what the gate would decide now, and changes nothing", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    const r1 = await seedRun(1, T1, webhookBody("mrun-1", REAL_TEXT));
    await insertVersion(env.DB, {
      id: "v-1", page_id: PAGE, run_id: r1, is_baseline: 0, captured_at: T1, text: REAL_TEXT, normalized_hash: "hash-from-older-rules",
      judgment_summary: "Pro rose", screenshot_key: "s", html_key: "h", facts_json: "[]", capture_status: "complete", facts_status: "ok",
    });
    // Run 2 made a version too, but its text is only the first one with a stamp: today's gate would call it identical.
    const r2 = await seedRun(2, T2, pullBody("mrun-2", `${REAL_TEXT}\n\nLast updated: 3 November 2026\n`));
    await insertVersion(env.DB, {
      id: "v-2", page_id: PAGE, run_id: r2, is_baseline: 0, captured_at: T2, text: `${REAL_TEXT}\n\nLast updated: 3 November 2026\n`,
      normalized_hash: "x", judgment_summary: null, capture_status: "complete", facts_status: "pending",
    });
    // Run 3 has a version whose raw body is gone.
    const r3 = await seedRun(3, T3, null);
    await insertVersion(env.DB, { id: "v-3", page_id: PAGE, run_id: r3, is_baseline: 0, captured_at: T3, text: "x", normalized_hash: "y", judgment_summary: null, capture_status: "complete" });
    await putCachedDiff(env.DB, "v-base", "v-1", "{}");
    const before = await versions();
    const runsBefore = await all("SELECT * FROM runs ORDER BY id");

    const body = (await (await replay()).json()) as Json;
    expect(body.created).toBe(0);
    expect(body.decisions).toEqual([
      { run_id: "run-1", monitor_run_id: "mrun-1", received_at: T1, decision: "existing_version", would_now_be: "created" },
      { run_id: "run-2", monitor_run_id: "mrun-2", received_at: T2, decision: "existing_version", would_now_be: "normalized_identical" },
      { run_id: "run-3", monitor_run_id: "mrun-3", received_at: T3, decision: "existing_version", would_now_be: "skipped_unreadable" },
    ]);
    // Additive (R79): not one version row changed (the stale stored hash included), no run row changed, and nothing was written.
    expect(await versions()).toEqual(before);
    expect(await all("SELECT * FROM runs ORDER BY id")).toEqual(runsBefore);
    expect(await all("SELECT * FROM diff_cache")).toHaveLength(1);
  });

  it("drops the page's cached diffs at the first write", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun(1, T1, pullBody("mrun-1", REAL_TEXT));
    await putCachedDiff(env.DB, "v-base", "v-elsewhere", "{}");
    await putCachedDiff(env.DB, "v-x", "v-y", "{}");
    await replay();
    expect(await all("SELECT from_version_id FROM diff_cache")).toEqual([{ from_version_id: "v-x" }]);
  });

  it("sets last_change_at for each created version, never backwards", async () => {
    await seedPage();
    await seedBaseline(BASE_TEXT);
    await seedRun(1, T1, pullBody("mrun-1", REAL_TEXT));
    await seedRun(2, T3, pullBody("mrun-2", `${REAL_TEXT}\n\nAnother line that is a real change in the page.\n`));
    await replay();
    expect((await all<{ last_change_at: string }>("SELECT last_change_at FROM pages WHERE id = ?", PAGE))[0]!.last_change_at).toBe(T3);
  });
});
