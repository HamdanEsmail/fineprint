// TinyFish Monitor: one Monitor per watched page. Creating one runs a baseline
// check at once and returns it in the 201 body (the webhook is not called for it).
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { TinyFishError, tinyfishFetch } from "./client";

const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";

const monitorUrl = (id: string) => `${MONITORS_API}/${encodeURIComponent(id)}`;

export type CreateMonitorParams = {
  url: string;
  name: string;
  scheduleCron: string;
  purpose: string;
  webhookUrl: string;
};

type CreateBody = {
  monitor?: { id?: unknown };
  run?: { id?: unknown; results?: { text?: unknown }[]; errors?: unknown[] };
};

/**
 * Creates a fetch Monitor and returns its baseline. If TinyFish answers 201 but the
 * baseline has no text (no result, or errors), the Monitor is deleted again and a
 * `baseline_failed` error is thrown, so no orphan Monitor keeps a slot and bills us.
 */
export async function createMonitor(
  env: Env,
  p: CreateMonitorParams,
): Promise<{ monitorId: string; baselineText: string; baselineRunId: string }> {
  const res = await tinyfishFetch(env, MONITORS_API, {
    method: "POST",
    body: JSON.stringify({
      type: "fetch",
      name: p.name,
      config: { url: p.url, format: "markdown" },
      schedule_cron: p.scheduleCron,
      purpose: p.purpose,
      webhook_url: p.webhookUrl,
    }),
    // The baseline is a completed check.
    spend: { kind: "monitor_check", amountUsd: PRICES.monitor_check, ref: p.url },
  });
  const body = (await res.json()) as CreateBody;

  const monitorId = typeof body.monitor?.id === "string" ? body.monitor.id : null;
  const baselineRunId = typeof body.run?.id === "string" ? body.run.id : null;
  const text = body.run?.results?.[0]?.text;
  const failedChecks = body.run?.errors?.length ?? 0;

  if (monitorId !== null && baselineRunId !== null && typeof text === "string" && text !== "" && failedChecks === 0) {
    return { monitorId, baselineText: text, baselineRunId };
  }

  if (monitorId !== null) {
    try {
      await deleteMonitor(env, monitorId);
    } catch {
      // Best effort. The caller still gets baseline_failed.
    }
  }
  throw new TinyFishError(
    502,
    "baseline_failed",
    `TinyFish created the monitor but the baseline check returned no page text${failedChecks > 0 ? ` (${failedChecks} fetch error${failedChecks === 1 ? "" : "s"})` : ""}`,
  );
}

// The run id becomes an R2 key (`raw/<id>.json`), as a webhook's does; a longer one is refused.
const MAX_RUN_ID_LENGTH = 200;

/**
 * Runs a Monitor's check now (`POST /v1/monitors/{id}/runs`): the overdue-check fallback when a
 * scheduled run never arrived. The 201 body is `{run: {id, is_baseline, results: [{text}], errors}}`
 * (no outcome, diff or judgment) and TinyFish does not call the webhook for it. `text` is null when
 * there is no result text. A body without a run id is an `unexpected_body` failure.
 *
 * No spend is recorded here: TinyFish bills a completed check only, so the caller records it after
 * it has read the run and claimed it (src/record.ts), once per run id.
 */
export async function runMonitorNow(
  env: Env,
  monitorId: string,
): Promise<{ runId: string; text: string | null; errors: unknown[]; raw: string }> {
  const res = await tinyfishFetch(env, `${monitorUrl(monitorId)}/runs`, { method: "POST" });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // not JSON: there is no run in it
  }
  const run = isRecord(body) && isRecord(body.run) ? body.run : {};
  const runId = run.id;
  if (typeof runId !== "string" || runId === "" || runId.length > MAX_RUN_ID_LENGTH) {
    throw new TinyFishError(502, "unexpected_body", "TinyFish answered run-now without a run id");
  }
  const first = Array.isArray(run.results) ? run.results[0] : undefined;
  return {
    runId,
    text: isRecord(first) && typeof first.text === "string" ? first.text : null,
    errors: Array.isArray(run.errors) ? run.errors : [],
    raw,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function updateMonitor(
  env: Env,
  id: string,
  p: { scheduleCron: string; name?: string; purpose?: string; webhookUrl?: string | null },
): Promise<void> {
  // TinyFish PATCH is a union: an edit must carry schedule_cron. The other fields are
  // sent only when the caller names them, and `webhookUrl: null` clears the webhook.
  const body: Record<string, unknown> = { schedule_cron: p.scheduleCron };
  if ("name" in p) body.name = p.name;
  if ("purpose" in p) body.purpose = p.purpose;
  if ("webhookUrl" in p) body.webhook_url = p.webhookUrl;
  await tinyfishFetch(env, monitorUrl(id), { method: "PATCH", body: JSON.stringify(body) });
}

export async function setMonitorStatus(env: Env, id: string, status: "active" | "paused"): Promise<void> {
  // The status change must be sent alone; mixed with other fields it is not a valid PATCH.
  await tinyfishFetch(env, monitorUrl(id), { method: "PATCH", body: JSON.stringify({ status }) });
}

/** A Monitor that is already gone (404) counts as deleted; the expiry step relies on that. */
export async function deleteMonitor(env: Env, id: string): Promise<void> {
  try {
    await tinyfishFetch(env, monitorUrl(id), { method: "DELETE" });
  } catch (err) {
    if (err instanceof TinyFishError && err.status === 404) return;
    throw err;
  }
}

/**
 * One Monitor by id, or null when TinyFish answers 404 (it does not exist). Any other
 * failure throws, and so does a 2xx whose body is not a Monitor: only a 404 means missing.
 */
export async function getMonitor(env: Env, id: string): Promise<{ id: string; status: string; name: string | null } | null> {
  let res: Response;
  try {
    res = await tinyfishFetch(env, monitorUrl(id), { method: "GET" });
  } catch (err) {
    if (err instanceof TinyFishError && err.status === 404) return null;
    throw err;
  }
  const body = (await res.json()) as Record<string, unknown> | null;
  // The spike saw the Monitor itself; a `{monitor: {...}}` wrapper is accepted too.
  const m = body !== null && typeof body.monitor === "object" && body.monitor !== null ? (body.monitor as Record<string, unknown>) : body;
  if (m === null || typeof m !== "object" || typeof m.id !== "string") {
    throw new TinyFishError(502, "unexpected_body", "TinyFish answered the Monitor read without a Monitor");
  }
  return {
    id: m.id,
    status: typeof m.status === "string" ? m.status : "unknown",
    name: typeof m.name === "string" ? m.name : null,
  };
}

export async function listMonitors(env: Env): Promise<{ id: string; status: string; name: string | null }[]> {
  const res = await tinyfishFetch(env, MONITORS_API, { method: "GET" });
  const body = (await res.json()) as { monitors?: unknown } | unknown[];
  const list = Array.isArray(body) ? body : (body as { monitors?: unknown }).monitors;
  if (!Array.isArray(list)) return [];
  const out: { id: string; status: string; name: string | null }[] = [];
  for (const m of list as Record<string, unknown>[]) {
    if (m === null || typeof m !== "object" || typeof m.id !== "string") continue;
    out.push({
      id: m.id,
      status: typeof m.status === "string" ? m.status : "unknown",
      name: typeof m.name === "string" ? m.name : null,
    });
  }
  return out;
}
