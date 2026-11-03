import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MAX_DURATION_SECONDS, AGENT_MAX_STEPS } from "../src/core/limits";
import { cronForIndex, PURPOSE } from "../src/core/schedule";
import { FACTS_GOAL, FACTS_SCHEMA, getRun, parseFacts, startFactsRun } from "../src/tinyfish/agent";
import { screenshotFullPage } from "../src/tinyfish/browser";
import { TinyFishError, tinyfishFetch } from "../src/tinyfish/client";
import { fetchPage } from "../src/tinyfish/fetch";
import { createMonitor, deleteMonitor, listMonitors, setMonitorStatus, updateMonitor } from "../src/tinyfish/monitor";
import { discoverFinePrint } from "../src/tinyfish/search";
import { fetchMock } from "./helpers/fetch-mock";
import agentSchemaRun from "./fixtures/tinyfish/agent-schema-run.json";
import browserCreate from "./fixtures/tinyfish/browser-create.json";
import fetchFixture from "./fixtures/tinyfish/fetch.json";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import monitorGet from "./fixtures/tinyfish/monitor-get.json";
import searchFixture from "./fixtures/tinyfish/search.json";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const BROWSER_API = "https://api.browser.tinyfish.ai";
const PRICING_URL = "https://vercel.com/pricing";

type SpendRow = { kind: string; amount_usd: number; ref: string };

async function spendRows(): Promise<SpendRow[]> {
  const { results } = await env.DB.prepare("SELECT kind, amount_usd, ref FROM spend ORDER BY at, rowid").all<SpendRow>();
  return results;
}

function callsTo(method: string, url: string) {
  return fetchMock.calls.filter((c) => c.method === method && c.url === new URL(url).href);
}

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => fetchMock.reset());

describe("tinyfishFetch", () => {
  it("sends the key and JSON content type, merges caller headers, and records spend on a 2xx", async () => {
    fetchMock.intercept({
      method: "POST",
      url: BROWSER_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        expect(req.headers.get("Content-Type")).toBe("application/json");
        expect(req.headers.get("X-Caller")).toBe("kept");
        return Response.json({ ok: true });
      },
    });
    const res = await tinyfishFetch(env, BROWSER_API, {
      method: "POST",
      headers: { "X-Caller": "kept" },
      body: JSON.stringify({ url: PRICING_URL }),
      spend: { kind: "screenshot", amountUsd: 0.002, ref: PRICING_URL },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await spendRows()).toEqual([{ kind: "screenshot", amount_usd: 0.002, ref: PRICING_URL }]);
  });

  it("returns the response and logs, instead of throwing, when the spend write fails after a 2xx", async () => {
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: { session: "made" } } });
    const brokenDb = {
      prepare() {
        throw new Error("D1 is down");
      },
    } as unknown as D1Database;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await tinyfishFetch({ ...env, DB: brokenDb, TINYFISH_API_KEY: env.TINYFISH_API_KEY }, BROWSER_API, {
        method: "POST",
        body: "{}",
        spend: { kind: "screenshot", amountUsd: 0.002, ref: PRICING_URL },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ session: "made" });
      expect(logged).toHaveBeenCalledWith("spend write failed", "screenshot");
      // The log line names the kind only: no key, no url, no error text.
      expect(JSON.stringify(logged.mock.calls)).not.toContain("test-tinyfish-key");
    } finally {
      logged.mockRestore();
    }
  });

  it("maps a 402 to TinyFishError INSUFFICIENT_CREDITS and records no spend", async () => {
    fetchMock.intercept({
      method: "POST",
      url: BROWSER_API,
      reply: { status: 402, json: { error: { code: "INSUFFICIENT_CREDITS", message: "Top up your account" } } },
    });
    const err = await tinyfishFetch(env, BROWSER_API, {
      method: "POST",
      body: "{}",
      spend: { kind: "screenshot", amountUsd: 0.002, ref: PRICING_URL },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ status: 402, code: "INSUFFICIENT_CREDITS" });
    // The message holds the status and the code only: no text from the response body.
    expect((err as Error).message).toBe("TinyFish HTTP 402 INSUFFICIENT_CREDITS");
    expect((err as Error).message).not.toContain("Top up your account");
    expect((err as Error).message).not.toContain("test-tinyfish-key");
    expect(await spendRows()).toEqual([]);
  });

  it("keeps whatever the response echoes (a rejected webhook url with its secret) out of the error message", async () => {
    const webhook = `https://fineprint.test/hooks/monitor/${env.WEBHOOK_SECRET}`;
    const echoes = [
      { status: 400, json: { error: { code: "INVALID_WEBHOOK_URL", message: `webhook_url ${webhook} is not allowed` } } },
      { status: 400, json: { code: "BAD_INPUT", message: `rejected ${webhook}` } },
      { status: 400, json: { error: `rejected ${webhook}` } },
      { status: 502, body: `<html>upstream saw ${webhook}</html>` },
    ];
    const messages: string[] = [];
    for (const reply of echoes) {
      fetchMock.intercept({ method: "POST", url: BROWSER_API, reply });
      const err = await tinyfishFetch(env, BROWSER_API, { method: "POST", body: JSON.stringify({ webhook_url: webhook }) }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TinyFishError);
      messages.push((err as Error).message);
    }
    expect(messages).toEqual([
      "TinyFish HTTP 400 INVALID_WEBHOOK_URL",
      "TinyFish HTTP 400 BAD_INPUT",
      "TinyFish HTTP 400 http_400",
      "TinyFish HTTP 502 http_502",
    ]);
    expect(messages.join("\n")).not.toContain(env.WEBHOOK_SECRET);
  });

  it("falls back to body.code, then to http_<status> for a body that is not JSON", async () => {
    fetchMock.intercept({ url: BROWSER_API, reply: { status: 400, json: { code: "BAD_INPUT", message: "no" } } });
    fetchMock.intercept({ url: BROWSER_API, reply: { status: 502, body: "<html>Bad gateway</html>" } });
    const first = await tinyfishFetch(env, BROWSER_API, { method: "POST" }).catch((e: unknown) => e);
    expect(first).toMatchObject({ status: 400, code: "BAD_INPUT" });
    expect((first as Error).message).toBe("TinyFish HTTP 400 BAD_INPUT");
    const second = await tinyfishFetch(env, BROWSER_API, { method: "POST" }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(TinyFishError);
    expect(second).toMatchObject({ status: 502, code: "http_502" });
    expect((second as Error).message).toBe("TinyFish HTTP 502 http_502");
    expect((second as Error).message).not.toContain("test-tinyfish-key");
  });
});

describe("fetchPage", () => {
  it("returns text for a 200 result and an error code for a per-URL error", async () => {
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(fetchFixture);
      },
    });
    const ok = await fetchPage(env, PRICING_URL, "markdown");
    expect(ok).toMatchObject({
      ok: true,
      title: "Vercel Pricing: Hobby, Pro, and Enterprise plans",
      finalUrl: "https://vercel.com/pricing",
    });
    expect(ok.ok && ok.text.length).toBe(13696);
    expect(callsTo("POST", FETCH_API)[0]!.body).toEqual({
      urls: [PRICING_URL],
      format: "markdown",
      ttl: 0,
      include_etag_and_last_modified: true,
      per_url_timeout_ms: 45000,
    });
    expect(await spendRows()).toEqual([{ kind: "fetch", amount_usd: 0, ref: PRICING_URL }]);

    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      reply: { json: { results: [], errors: [{ url: PRICING_URL, error: "bot_blocked" }] } },
    });
    expect(await fetchPage(env, PRICING_URL, "html")).toEqual({ ok: false, error: "bot_blocked" });
    expect(callsTo("POST", FETCH_API)[1]!.body).toMatchObject({ format: "html" });
  });

  it("returns no_result when there is neither a result nor an error, and the HTTP code on a failed call", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { json: { results: [], errors: [] } } });
    expect(await fetchPage(env, PRICING_URL, "markdown")).toEqual({ ok: false, error: "no_result" });

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { status: 500, json: { error: { code: "INTERNAL" } } } });
    expect(await fetchPage(env, PRICING_URL, "markdown")).toEqual({ ok: false, error: "INTERNAL", status: 500 });

    fetchMock.intercept({ method: "POST", url: FETCH_API, reply: { status: 503, body: "down" } });
    expect(await fetchPage(env, PRICING_URL, "markdown")).toEqual({ ok: false, error: "http_503", status: 503 });
  });
});

describe("monitors", () => {
  const params = {
    url: PRICING_URL,
    name: "Vercel pricing",
    scheduleCron: "7 1,13 * * *",
    purpose: PURPOSE,
    webhookUrl: "https://fineprint.test/hooks/monitor/s3cret",
  };

  it("createMonitor returns monitorId and the baseline text from the 201 body, and records one monitor_check", async () => {
    fetchMock.intercept({
      method: "POST",
      url: MONITORS_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(monitorCreate, { status: 201 });
      },
    });
    const out = await createMonitor(env, params);
    expect(out.monitorId).toBe(monitorCreate.monitor.id);
    expect(out.baselineRunId).toBe(monitorCreate.run.id);
    expect(out.baselineText.length).toBe(13696);
    expect(callsTo("POST", MONITORS_API)[0]!.body).toEqual({
      type: "fetch",
      name: "Vercel pricing",
      config: { url: PRICING_URL, format: "markdown" },
      schedule_cron: "7 1,13 * * *",
      purpose: PURPOSE,
      webhook_url: "https://fineprint.test/hooks/monitor/s3cret",
    });
    expect(await spendRows()).toEqual([{ kind: "monitor_check", amount_usd: 0.005, ref: PRICING_URL }]);
  });

  it("createMonitor deletes the new monitor and throws baseline_failed when the baseline has no text", async () => {
    const id = monitorCreate.monitor.id;
    const failed = { ...monitorCreate, run: { ...monitorCreate.run, results: [], errors: [{ url: PRICING_URL, error: "bot_blocked" }] } };
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: failed } });
    fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/${id}`, reply: { status: 200, json: {} } });
    const err = await createMonitor(env, params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: "baseline_failed" });
    expect(callsTo("DELETE", `${MONITORS_API}/${id}`)).toHaveLength(1);
  });

  it("createMonitor still throws baseline_failed when the cleanup delete itself fails", async () => {
    const id = monitorCreate.monitor.id;
    const empty = { ...monitorCreate, run: { ...monitorCreate.run, results: [{ ...monitorCreate.run.results[0], text: "" }] } };
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: empty } });
    fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/${id}`, reply: { status: 500, body: "boom" } });
    const err = await createMonitor(env, params).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "baseline_failed" });
    expect(callsTo("DELETE", `${MONITORS_API}/${id}`)).toHaveLength(1);
  });

  it("setMonitorStatus sends {status} alone and updateMonitor always includes schedule_cron", async () => {
    const id = monitorGet.id;
    const url = `${MONITORS_API}/${id}`;
    fetchMock.intercept({ method: "PATCH", url, reply: { json: monitorGet }, times: 5 });

    await setMonitorStatus(env, id, "paused");
    await updateMonitor(env, id, { scheduleCron: "0 */6 * * *" });
    await updateMonitor(env, id, { scheduleCron: "5 1,13 * * *", name: "New name", purpose: "New purpose", webhookUrl: "https://fineprint.test/hooks/monitor/new" });
    await updateMonitor(env, id, { scheduleCron: "5 1,13 * * *", webhookUrl: null });
    await setMonitorStatus(env, id, "active");

    const bodies = callsTo("PATCH", url).map((c) => c.body);
    expect(bodies).toEqual([
      { status: "paused" },
      { schedule_cron: "0 */6 * * *" },
      { schedule_cron: "5 1,13 * * *", name: "New name", purpose: "New purpose", webhook_url: "https://fineprint.test/hooks/monitor/new" },
      { schedule_cron: "5 1,13 * * *", webhook_url: null },
      { status: "active" },
    ]);
    expect(await spendRows()).toEqual([]);
  });

  it("deleteMonitor treats a 404 as already deleted and surfaces other failures", async () => {
    const url = `${MONITORS_API}/gone`;
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 404, json: { error: { code: "NOT_FOUND" } } } });
    await expect(deleteMonitor(env, "gone")).resolves.toBeUndefined();
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 500, body: "boom" } });
    await expect(deleteMonitor(env, "gone")).rejects.toMatchObject({ status: 500 });
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 204 } });
    await expect(deleteMonitor(env, "gone")).resolves.toBeUndefined();
    expect(await spendRows()).toEqual([]);
  });

  it("listMonitors maps the account's monitors to id, status and name", async () => {
    fetchMock.intercept({
      method: "GET",
      url: MONITORS_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json({ monitors: [monitorGet, { id: "m2", status: "paused", name: null, config: {} }] });
      },
    });
    expect(await listMonitors(env)).toEqual([
      { id: monitorGet.id, status: "active", name: "spike-fineprint" },
      { id: "m2", status: "paused", name: null },
    ]);
    expect(await spendRows()).toEqual([]);
  });
});

describe("agent", () => {
  it("FACTS_GOAL and FACTS_SCHEMA are the exact texts", () => {
    expect(FACTS_GOAL).toBe(
      "This is a pricing or fee page. List every plan, tier, product or fee shown on this page with its price. For each item return: name (the plan or fee name exactly as written), price (the amount with its currency symbol exactly as written, or Free, or Custom), unit (per month, per year, per request, per GB, or null), notes (one short line saying what the price includes, or null). Include every item, including free and enterprise or custom tiers. If a monthly/yearly toggle exists, use the monthly values. Do not navigate away from this page except to dismiss a cookie banner. Return items in the order they appear.",
    );
    expect(FACTS_SCHEMA).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              price: { type: "string" },
              unit: { type: "string", nullable: true },
              notes: { type: "string", nullable: true },
            },
            required: ["name", "price"],
          },
        },
      },
      required: ["items"],
    });
  });

  it("startFactsRun posts the capped goal with the schema and callback and returns the run id", async () => {
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json({ run_id: "run-1" });
      },
    });
    const out = await startFactsRun(env, PRICING_URL, "https://fineprint.test/hooks/agent/s3cret");
    expect(out).toEqual({ runId: "run-1" });
    expect(callsTo("POST", RUN_ASYNC_API)[0]!.body).toEqual({
      url: PRICING_URL,
      goal: FACTS_GOAL,
      browser_profile: "lite",
      agent_config: { max_steps: AGENT_MAX_STEPS, max_duration_seconds: AGENT_MAX_DURATION_SECONDS },
      output_schema: FACTS_SCHEMA,
      webhook_url: "https://fineprint.test/hooks/agent/s3cret",
    });
    expect(await spendRows()).toEqual([]);
  });

  it("startFactsRun waits 60 s and retries on a 429: two 429s then a 200 returns the run id after 3 calls", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 429, body: "slow down" }, times: 2 });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "run-2" } } });
    const out = await startFactsRun(env, PRICING_URL, "https://fineprint.test/cb", { sleep });
    expect(out).toEqual({ runId: "run-2" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(3);
    expect(sleep.mock.calls).toEqual([[60_000], [60_000]]);
  });

  it("startFactsRun gives up after 3 retries: four 429s throw RATE_LIMIT_EXCEEDED after 4 calls", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 429, body: "slow down" }, times: 4 });
    const err = await startFactsRun(env, PRICING_URL, "https://fineprint.test/cb", { sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMIT_EXCEEDED" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("startFactsRun retries on the RATE_LIMIT_EXCEEDED code and does not retry other errors", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 400, json: { error: { code: "RATE_LIMIT_EXCEEDED" } } } });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "run-3" } } });
    expect(await startFactsRun(env, PRICING_URL, "https://fineprint.test/cb", { sleep })).toEqual({ runId: "run-3" });
    expect(sleep).toHaveBeenCalledTimes(1);

    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 400, json: { error: { code: "INVALID_INPUT" } } } });
    const err = await startFactsRun(env, PRICING_URL, "https://fineprint.test/cb", { sleep }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("getRun asks for no screenshots or html and returns status, result and step count", async () => {
    const id = agentSchemaRun.run_id;
    fetchMock.intercept({
      method: "GET",
      url: `https://agent.tinyfish.ai/v1/runs/${id}?screenshots=none&html=none`,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(agentSchemaRun);
      },
    });
    expect(await getRun(env, id)).toEqual({ status: "COMPLETED", result: { plans: [] }, num_of_steps: 3 });

    fetchMock.intercept({
      method: "GET",
      url: "https://agent.tinyfish.ai/v1/runs/r2?screenshots=none&html=none",
      reply: { json: { run_id: "r2", status: "RUNNING" } },
    });
    expect(await getRun(env, "r2")).toEqual({ status: "RUNNING", result: null, num_of_steps: null });
  });

  it("parseFacts accepts the schema shape and rejects junk", () => {
    expect(parseFacts({ items: [{ name: "Pro", price: "$20" }] })).toEqual([{ name: "Pro", price: "$20", unit: null, notes: null }]);
    expect(parseFacts({ plans: [] })).toBeNull();
  });

  it("parseFacts keeps string unit and notes, nulls the rest, and rejects any item without a string name or price", () => {
    expect(
      parseFacts({
        items: [
          { name: "Pro", price: "$20", unit: "per month", notes: "Includes 1 seat" },
          { name: "Free", price: "Free", unit: null, notes: 5 },
          { name: "Team", price: "$40", unit: 12 },
        ],
      }),
    ).toEqual([
      { name: "Pro", price: "$20", unit: "per month", notes: "Includes 1 seat" },
      { name: "Free", price: "Free", unit: null, notes: null },
      { name: "Team", price: "$40", unit: null, notes: null },
    ]);
    expect(parseFacts({ items: [] })).toEqual([]);

    for (const junk of [
      null,
      undefined,
      "items",
      42,
      [],
      { items: "nope" },
      { items: { name: "Pro", price: "$20" } },
      { items: [null] },
      { items: ["Pro"] },
      { items: [{ name: "Pro" }] },
      { items: [{ price: "$20" }] },
      { items: [{ name: "Pro", price: 20 }] },
      { items: [{ name: 7, price: "$20" }] },
      { items: [{ name: "Pro", price: "$20" }, { name: "Team" }] },
    ]) {
      expect(parseFacts(junk)).toBeNull();
    }
  });
});

describe("schedule", () => {
  it("cronForIndex staggers minutes and hours", () => {
    expect(cronForIndex(0)).toBe("0 0,12 * * *");
    expect(cronForIndex(13)).toBe("31 1,13 * * *");
    expect(cronForIndex(1)).toBe("7 1,13 * * *");
    expect(cronForIndex(12)).toBe("24 0,12 * * *");
  });

  it("PURPOSE is the spec 4.5 text", () => {
    expect(PURPOSE).toBe(
      "A price, plan, limit, fee, rule, eligibility condition, deadline or policy term was added, removed or changed. Ignore timestamps, 'last updated' notes, cookie banners, layout and wording-only edits.",
    );
  });
});

describe("discoverFinePrint", () => {
  const SEARCH = "https://api.search.tinyfish.ai/";
  const PURPOSE_QS = "purpose=find\\+the\\+fine-print\\+pages\\+of\\+a\\+website";
  const queryUrl = (q: string) => new RegExp(`^${SEARCH.replace(/\./g, "\\.")}\\?query=${q}&include_domains=vercel\\.com&${PURPOSE_QS}$`);
  const hit = (url: string, title: string) => ({ position: 1, site_name: "vercel.com", snippet: "…", title, url });

  it("dedupes URLs and labels kinds by the query that found them first", async () => {
    const pricingHits = searchFixture.results; // 4 results, the first is /pricing
    fetchMock.intercept({
      method: "GET",
      url: queryUrl("pricing\\+plans"),
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(searchFixture);
      },
    });
    fetchMock.intercept({
      method: "GET",
      url: queryUrl("terms\\+of\\+service"),
      reply: { json: { query: "terms of service", results: [hit("https://vercel.com/docs/pricing", "Pricing on Vercel"), hit("https://vercel.com/legal/terms", "Terms of Service")], total_results: 2, page: 0 } },
    });
    fetchMock.intercept({
      method: "GET",
      url: queryUrl("privacy\\+policy"),
      reply: { json: { query: "privacy policy", results: [hit("https://vercel.com/legal/privacy-policy", "Privacy Policy"), hit("https://vercel.com/legal/terms", "Terms of Service")], total_results: 2, page: 0 } },
    });
    fetchMock.intercept({
      method: "GET",
      url: queryUrl("fees\\+and\\+charges"),
      reply: { json: { query: "fees and charges", results: [hit("https://vercel.com/docs/pricing", "Pricing on Vercel"), { position: 2, url: "https://vercel.com/docs/billing" }], total_results: 2, page: 0 } },
    });

    const found = await discoverFinePrint(env, "vercel.com");

    expect(found.map((f) => f.url)).toEqual([
      ...pricingHits.map((r) => r.url),
      "https://vercel.com/legal/terms",
      "https://vercel.com/legal/privacy-policy",
      "https://vercel.com/docs/billing",
    ]);
    expect(new Set(found.map((f) => f.url)).size).toBe(found.length);
    const kind = (url: string) => found.find((f) => f.url === url)?.kind;
    expect(kind(PRICING_URL)).toBe("pricing");
    expect(kind("https://vercel.com/docs/pricing")).toBe("pricing"); // first occurrence wins
    expect(kind("https://vercel.com/legal/terms")).toBe("policy");
    expect(kind("https://vercel.com/legal/privacy-policy")).toBe("policy");
    expect(kind("https://vercel.com/docs/billing")).toBe("fees");
    expect(found[0]).toEqual({ url: PRICING_URL, title: "Vercel Pricing: Hobby, Pro, and Enterprise plans", kind: "pricing" });
    expect(found.find((f) => f.url === "https://vercel.com/docs/billing")!.title).toBe("");

    const urls = fetchMock.calls.map((c) => c.url);
    expect(urls).toHaveLength(4);
    expect(urls.every((u) => u.includes("include_domains=vercel.com") && u.includes("purpose=find+the+fine-print+pages+of+a+website"))).toBe(true);
    expect(await spendRows()).toEqual([
      { kind: "search", amount_usd: 0, ref: "vercel.com" },
      { kind: "search", amount_usd: 0, ref: "vercel.com" },
      { kind: "search", amount_usd: 0, ref: "vercel.com" },
      { kind: "search", amount_usd: 0, ref: "vercel.com" },
    ]);
  });

  it("returns an empty list when nothing is found", async () => {
    fetchMock.intercept({ method: "GET", url: /^https:\/\/api\.search\.tinyfish\.ai\//, reply: { json: { query: "x", results: [], total_results: 0, page: 0 } }, times: 4 });
    expect(await discoverFinePrint(env, "example.com")).toEqual([]);
  });
});

describe("screenshotFullPage", () => {
  it("records a screenshot spend row at session creation and throws a clear error when there is no cdp_url", async () => {
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: { session_id: "tf-1" } } });
    await expect(screenshotFullPage(env, PRICING_URL)).rejects.toThrow(/cdp_url/);
    expect(callsTo("POST", BROWSER_API)[0]!.body).toEqual({ url: PRICING_URL });
    expect(await spendRows()).toEqual([{ kind: "screenshot", amount_usd: 0.002, ref: PRICING_URL }]);
  });

  it("opens the CDP socket without the API key and throws a clear error when the upgrade is refused", async () => {
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: browserCreate } });
    fetchMock.intercept({
      method: "GET",
      url: browserCreate.base_url,
      reply: (req) => {
        expect(req.headers.get("Upgrade")).toBe("websocket");
        expect(req.headers.get("X-API-Key")).toBeNull();
        return new Response("not a websocket", { status: 200 });
      },
    });
    await expect(screenshotFullPage(env, PRICING_URL)).rejects.toThrow(/websocket/i);
  });
});
