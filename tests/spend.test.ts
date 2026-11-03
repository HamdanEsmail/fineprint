import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PRICES, recordSpend } from "../src/core/spend";
import { callWorker } from "./helpers/app";

describe("spend ledger", () => {
  it("prices match the spec", () => {
    expect(PRICES).toEqual({ monitor_check: 0.005, screenshot: 0.002, agent_step: 0.016, fetch: 0, search: 0 });
  });

  it("recordSpend appends one row and /api/stats sums it", async () => {
    await recordSpend(env.DB, "monitor_check", PRICES.monitor_check, "page-1");
    const { results } = await env.DB.prepare("SELECT id, kind, amount_usd, ref, at FROM spend").all<{
      id: string;
      kind: string;
      amount_usd: number;
      ref: string;
      at: string;
    }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "monitor_check", amount_usd: 0.005, ref: "page-1" });
    expect(results[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(results[0]!.at).toISOString()).toBe(results[0]!.at);

    const res = await callWorker("/api/stats");
    expect(await res.json()).toMatchObject({ spend_usd: 0.005 });
  });
});
