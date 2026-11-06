// One shape for a version wherever the API lists it (Task 15): GET /api/pages/:id, the export, and (with
// its text and live url) versions/:vid and as-of all go through the same mapper. And a diff is stored only
// once both of its versions are final: capture finished, no facts run in flight, and the `to` version's
// summary filled.
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashText, normalize } from "../src/core/normalize";
import { insertPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { TriggerKind } from "../src/db/types";
import { insertVersion, type NewVersion } from "../src/db/versions";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const BASE = "https://fineprint.test";
const PAGE = "page-vj";
const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-02T00:00:00.000Z";
const T2 = "2026-11-03T00:00:00.000Z";
const TEXT0 = "# Plans\n\n## Pro\n\n$20 per month";
const TEXT1 = "# Plans\n\n## Pro\n\n$25 per month";
const TEXT2 = "# Plans\n\n## Pro\n\n$30 per month";
const FACTS = [{ name: "Pro", price: "$25", unit: "month", notes: null }];

async function seedPage(): Promise<void> {
  await insertPage(env.DB, {
    id: PAGE, url: "https://example.com/pricing", label: "Pricing", kind: "pricing", monitor_id: "mon-vj",
    schedule_cron: "0 0 * * *", purpose: "watch", status: "active", added_by: "curated", ignore_patterns: "[]", expires_at: null,
  });
}

async function seed(id: string, at: string, text: string, trigger: TriggerKind, over: Partial<NewVersion> = {}): Promise<void> {
  await insertRun(env.DB, {
    id: `run-${id}`, page_id: PAGE, monitor_run_id: `m-${id}`, outcome: trigger === "create" ? "baseline" : "changed",
    is_baseline: trigger === "create" ? 1 : 0, judgment_relevant: null, judgment_summary: null, diff_truncated: 0,
    noise_suppressed: 0, noise_reason: null, raw_key: null, received_at: at, trigger_kind: trigger,
  });
  await insertVersion(env.DB, {
    id, page_id: PAGE, run_id: `run-${id}`, is_baseline: trigger === "create" ? 1 : 0, captured_at: at, text,
    normalized_hash: await hashText(normalize(text).text), judgment_summary: null, screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`, capture_status: "complete", ...over,
  });
}

const get = async (path: string): Promise<Json> => (await callWorker(path)).json();
const cacheRows = async () => (await env.DB.prepare("SELECT from_version_id, to_version_id FROM diff_cache").all()).results;
const diff = (from: string, to: string) => get(`/api/pages/${PAGE}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => {
  fetchMock.reset();
  vi.restoreAllMocks();
});

describe("the version shape", () => {
  it("GET /api/pages/:id lists versions through the shared mapper: booleans, parsed facts, urls, trigger, facts_status, notes, summary", async () => {
    await seedPage();
    await seed("v-0", T0, TEXT0, "create", { facts_json: JSON.stringify([{ name: "Pro", price: "$20", unit: "month", notes: null }]) });
    await seed("v-1", T1, TEXT1, "pull", {
      facts_json: JSON.stringify(FACTS), notes: "created by replay on 2026-11-05T00:00:00.000Z",
      summary: '1 block changed: "$25 per month"', summary_source: "diff", agent_run_id: "agent-run-1",
    });

    const detail = await get(`/api/pages/${PAGE}`);

    expect(detail.versions).toEqual([
      {
        id: "v-1", page_id: PAGE, captured_at: T1, is_baseline: false,
        summary: '1 block changed: "$25 per month"', summary_source: "diff", judgment_summary: null,
        facts: FACTS, screenshot_url: `${BASE}/shots/v-1.jpg`, source_url: `${BASE}/sources/v-1.html`,
        delta: null, thumb_url: null,
        capture_status: "complete", facts_status: "ok", trigger: "pull",
        notes: "created by replay on 2026-11-05T00:00:00.000Z",
      },
      {
        id: "v-0", page_id: PAGE, captured_at: T0, is_baseline: true, summary: null, summary_source: null, judgment_summary: null,
        facts: [{ name: "Pro", price: "$20", unit: "month", notes: null }], screenshot_url: `${BASE}/shots/v-0.jpg`,
        source_url: `${BASE}/sources/v-0.html`, delta: null, thumb_url: null, capture_status: "complete", facts_status: "ok",
        trigger: "create", notes: null,
      },
    ]);

    // The same object as the export's and, with the text and the live url, as versions/:vid's.
    const exported = await get("/api/export.json");
    expect(exported.pages[0].versions).toEqual(detail.versions);
    const one = await get(`/api/pages/${PAGE}/versions/v-1`);
    expect(one).toEqual({ ...detail.versions[0], text: TEXT1, live_url: "https://example.com/pricing" });
    const asOf = await get(`/api/pages/${PAGE}/as-of?at=${encodeURIComponent(T1)}`);
    expect(asOf).toEqual(one);
  });

  it("never leaks a raw row: no run id, hash, storage keys, facts json, attempts, error or agent run id", async () => {
    await seedPage();
    await seed("v-0", T0, TEXT0, "create", { capture_error: "screenshot: cdp_failed", capture_attempts: 2, agent_run_id: "claim:x" });
    const raw = ["run_id", "normalized_hash", "screenshot_key", "html_key", "facts_json", "capture_attempts", "capture_error", "agent_run_id", "text"];
    const detail = await get(`/api/pages/${PAGE}`);
    const exported = await get("/api/export.json");
    for (const version of [detail.versions[0], exported.pages[0].versions[0]]) {
      for (const key of raw) expect(version, key).not.toHaveProperty(key);
    }
  });
});

describe("diff cache finality", () => {
  it("an end that is complete but has a facts run in flight (a run id or a claim, no facts yet) is not stored; once the facts land it is", async () => {
    await seedPage();
    await seed("v-0", T0, TEXT0, "create", { facts_json: "[]" });
    await seed("v-1", T1, TEXT1, "webhook", { agent_run_id: "agent-run-1", summary: "s", summary_source: "diff" });

    const early = await diff(T0, T1);
    expect(early.to.facts_status).toBe("pending");
    expect(await cacheRows()).toEqual([]);

    await env.DB.prepare("UPDATE versions SET agent_run_id = 'claim:2026-11-02T00:00:00.000Z' WHERE id = 'v-1'").run();
    await diff(T0, T1);
    expect(await cacheRows()).toEqual([]);

    await env.DB.prepare(`UPDATE versions SET agent_run_id = 'agent-run-1', facts_json = ?, facts_status = 'ok' WHERE id = 'v-1'`).bind(JSON.stringify(FACTS)).run();
    const late = await diff(T0, T1);
    expect(late.to.facts_status).toBe("ok");
    expect(late.facts).not.toBeNull();
    expect(await cacheRows()).toEqual([{ from_version_id: "v-0", to_version_id: "v-1" }]);
  });

  it("the diff's summary is the `to` version's stored summary with its source; a `to` still without one is not stored", async () => {
    await seedPage();
    await seed("v-0", T0, TEXT0, "create", { facts_json: "[]" });
    await seed("v-1", T1, TEXT1, "pull", { facts_json: "[]", summary: null, summary_source: null });
    await seed("v-2", T2, TEXT2, "webhook", { facts_json: "[]", judgment_summary: "Pro rose to $30." });

    const first = await diff(T0, T1);
    expect([first.summary, first.summary_source]).toEqual([null, null]);
    expect(await cacheRows()).toEqual([]);

    await env.DB.prepare(`UPDATE versions SET summary = '1 block changed: "$25 per month"', summary_source = 'diff' WHERE id = 'v-1'`).run();
    const filled = await diff(T0, T1);
    expect([filled.summary, filled.summary_source]).toEqual(['1 block changed: "$25 per month"', "diff"]);
    expect(await cacheRows()).toEqual([{ from_version_id: "v-0", to_version_id: "v-1" }]);

    const latest = await diff(T1, T2);
    expect([latest.summary, latest.summary_source]).toEqual(["Pro rose to $30.", "tinyfish"]);
  });
});
