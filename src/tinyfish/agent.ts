// TinyAgent: one capped run per pricing-page version that extracts the plans and
// fees as structured facts. Steps are billed later, when the run finishes.
import { AGENT_MAX_DURATION_SECONDS, AGENT_MAX_STEPS } from "../core/limits";
import type { Fact } from "../core/diff";
import type { Env } from "../env";
import { TinyFishError, tinyfishFetch } from "./client";

const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const RUNS_API = "https://agent.tinyfish.ai/v1/runs";

export const FACTS_GOAL =
  "This is a pricing or fee page. List every plan, tier, product or fee shown on this page with its price. For each item return: name (the plan or fee name exactly as written), price (the amount with its currency symbol exactly as written, or Free, or Custom), unit (per month, per year, per request, per GB, or null), notes (one short line saying what the price includes, or null). Include every item, including free and enterprise or custom tiers. If a monthly/yearly toggle exists, use the monthly values. Do not navigate away from this page except to dismiss a cookie banner. Return items in the order they appear.";

export const FACTS_SCHEMA = {
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
};

/** What the Agent run looks like to the rest of the Worker. */
export type AgentRun = { status: string; result: unknown; num_of_steps: number | null };

/** The account allows 2 concurrent runs, shared with other projects: wait and retry when full. */
const RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_RETRIES = 3;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRateLimit(err: unknown): err is TinyFishError {
  return err instanceof TinyFishError && (err.status === 429 || err.code === "RATE_LIMIT_EXCEEDED");
}

export async function startFactsRun(
  env: Env,
  url: string,
  callbackUrl: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ runId: string }> {
  const sleep = opts.sleep ?? realSleep;
  const body = JSON.stringify({
    url,
    goal: FACTS_GOAL,
    browser_profile: "lite",
    agent_config: { max_steps: AGENT_MAX_STEPS, max_duration_seconds: AGENT_MAX_DURATION_SECONDS },
    output_schema: FACTS_SCHEMA,
    webhook_url: callbackUrl,
  });

  for (let retry = 0; ; retry++) {
    try {
      const res = await tinyfishFetch(env, RUN_ASYNC_API, { method: "POST", body });
      const json = (await res.json()) as { run_id?: unknown };
      if (typeof json.run_id !== "string" || json.run_id === "") {
        throw new TinyFishError(502, "no_run_id", "TinyFish accepted the Agent run but returned no run_id");
      }
      return { runId: json.run_id };
    } catch (err) {
      if (!isRateLimit(err)) throw err;
      if (retry >= RATE_LIMIT_RETRIES) {
        // A bare 429 has no error code of its own; callers match on RATE_LIMIT_EXCEEDED.
        if (err.code === "RATE_LIMIT_EXCEEDED") throw err;
        throw new TinyFishError(err.status, "RATE_LIMIT_EXCEEDED", err.message);
      }
      await sleep(RATE_LIMIT_WAIT_MS);
    }
  }
}

export async function getRun(env: Env, runId: string): Promise<AgentRun> {
  const res = await tinyfishFetch(env, `${RUNS_API}/${encodeURIComponent(runId)}?screenshots=none&html=none`, {
    method: "GET",
  });
  const json = (await res.json()) as { status?: unknown; result?: unknown; num_of_steps?: unknown };
  return {
    status: typeof json.status === "string" ? json.status : "UNKNOWN",
    result: json.result ?? null,
    num_of_steps: typeof json.num_of_steps === "number" ? json.num_of_steps : null,
  };
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Reads the Agent's `result` as a list of facts. Returns null unless `result.items` is an
 * array of objects that each have a string `name` and `price`; `unit` and `notes` become
 * null when absent or not strings. Nothing is dropped silently: one bad item makes it null.
 */
export function parseFacts(result: unknown): Fact[] | null {
  if (result === null || typeof result !== "object") return null;
  const items = (result as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const facts: Fact[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") return null;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.price !== "string") return null;
    facts.push({ name: o.name, price: o.price, unit: optionalString(o.unit), notes: optionalString(o.notes) });
  }
  return facts;
}
