#!/usr/bin/env node
// Ops helper for the webhook rehearsal (docs/runbook.md, step 8): reads, re-points, resumes and
// pauses the kept spike Monitor on TinyFish. It never prints a secret, the TinyFish key, a webhook
// url or a response body: only an HTTP status, an error code and a few booleans.
//
//   node scripts/spike-monitor.mjs GET [--expect active|paused]
//   node scripts/spike-monitor.mjs PATCH --webhook
//   node scripts/spike-monitor.mjs PATCH '{"status":"active"}'
//
// GET reads the Monitor. `--expect <status>` also fails (exit 1) unless the Monitor has that status.
// PATCH --webhook sends {schedule_cron: "*/10 * * * *", webhook_url: <PUBLIC_BASE_URL>/hooks/monitor/<WEBHOOK_SECRET>}.
//   PUBLIC_BASE_URL is read from wrangler.jsonc and must be https://<host>; WEBHOOK_SECRET from
//   ../.fineprint-prod.env (the file next to the repo folder, step 5 of the runbook).
// PATCH '<json>' sends that JSON as it is (TinyFish's PATCH is a union: a status change goes alone,
//   an edit must carry schedule_cron).
//
// The TinyFish key comes from .dev.vars. Paths are relative to this script, so the working
// directory does not matter. Exit code: 0 only for a 2xx answer (and a met --expect), else 1.
// Plain Node (24+), no dependencies.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MONITOR_ID = "e92c04d7-9243-4abe-b7fa-09a769c5a9c7"; // the spike Monitor (watches https://vercel.com/pricing)
const API = `https://agent.tinyfish.ai/v1/monitors/${MONITOR_ID}`;
const REHEARSAL_CRON = "*/10 * * * *";
const TIMEOUT_MS = 30_000;
const ROOT = new URL("../", import.meta.url);

const USAGE = [
  "usage: node scripts/spike-monitor.mjs GET [--expect active|paused]",
  "       node scripts/spike-monitor.mjs PATCH --webhook",
  "       node scripts/spike-monitor.mjs PATCH '<json body>'",
].join("\n");

// A reason to stop; main() is wrapped below so that output is flushed and the exit code is set.
class Fatal extends Error {}
const fail = (message) => {
  throw new Fatal(message);
};

// --- Files ----------------------------------------------------------------------

function readFileOrFail(relative, what) {
  try {
    return readFileSync(fileURLToPath(new URL(relative, ROOT)), "utf8");
  } catch {
    return fail(`cannot read ${what}`);
  }
}

// The value of NAME=value in an env-style file, or fail naming the variable and the file only.
function readVar(relative, label, name) {
  const text = readFileOrFail(relative, label);
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(`${name}=`)) {
      const value = line.slice(name.length + 1).trim();
      if (value !== "") return value;
    }
  }
  return fail(`${name} is missing in ${label}`);
}

// PUBLIC_BASE_URL from wrangler.jsonc, guarded to https://<host> so that a webhook url is never built from the
// localhost default (TinyFish could not reach it) or from anything with a path.
function readBase() {
  const text = readFileOrFail("wrangler.jsonc", "wrangler.jsonc");
  const m = /"PUBLIC_BASE_URL"\s*:\s*"([^"]*)"/.exec(text);
  const base = m ? m[1] : "";
  if (!/^https:\/\/[^/\s]+$/.test(base)) {
    fail("PUBLIC_BASE_URL in wrangler.jsonc is not https://<host> yet (runbook step 6 sets it); nothing was sent");
  }
  return base;
}

const webhookUrl = () => `${readBase()}/hooks/monitor/${readVar("../.fineprint-prod.env", "../.fineprint-prod.env", "WEBHOOK_SECRET")}`;

// --- Arguments ------------------------------------------------------------------

function parseArgs(argv) {
  const [method, ...rest] = argv;
  if (method === "GET") {
    if (rest.length === 0) return { method };
    if (rest.length === 2 && rest[0] === "--expect" && /^[a-z_]{1,32}$/.test(rest[1])) return { method, expect: rest[1] };
    return fail(`bad arguments after GET\n${USAGE}`);
  }
  if (method === "PATCH") {
    if (rest.length !== 1) return fail(`PATCH needs exactly one argument\n${USAGE}`);
    if (rest[0] === "--webhook") return { method, webhook: true };
    let body;
    try {
      body = JSON.parse(rest[0]);
    } catch {
      return fail(`the PATCH body is not valid JSON\n${USAGE}`);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return fail(`the PATCH body must be a JSON object\n${USAGE}`);
    return { method, body };
  }
  return fail(USAGE);
}

// --- Output ---------------------------------------------------------------------

// A short, safe rendering of a value the API sent back: only characters a status, a code or a cron can hold.
const safe = (value, pattern) => (typeof value === "string" && pattern.test(value) ? value : null);
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const STATUS = /^[a-z_]{1,32}$/;
const CRON = /^[0-9*/,\- ]{1,40}$/;

// The reason a network call failed, as text: undici wraps the real reason in `cause`.
function describeNetworkError(err) {
  const cause = err?.cause?.code ?? err?.code;
  const text = err?.name === "TimeoutError" ? "timeout" : (cause ?? "request failed");
  return `network: ${String(text).slice(0, 60)}`;
}

// --- Main -----------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const key = readVar(".dev.vars", ".dev.vars", "TINYFISH_API_KEY");
  let payload;
  if (args.method === "PATCH") payload = args.webhook ? { schedule_cron: REHEARSAL_CRON, webhook_url: webhookUrl() } : args.body;

  let res;
  try {
    res = await fetch(API, {
      method: args.method,
      headers: { "X-API-Key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fail(describeNetworkError(err));
  }
  const body = await res.json().catch(() => null);
  const ok = res.status >= 200 && res.status < 300;

  const code = safe(body?.error?.code, CODE) ?? safe(body?.code, CODE);
  console.log(`HTTP ${res.status}${ok || !code ? "" : ` ${code}`}`);
  if (!ok) {
    process.exitCode = 1;
    return;
  }

  const status = safe(body?.status, STATUS);
  if (args.method === "GET") {
    // Whether the Monitor's webhook is ours: needs the secret, so it is "unknown" where that is not available.
    let ours = "unknown";
    try {
      ours = String(typeof body?.webhook_url === "string" && body.webhook_url === webhookUrl());
    } catch {
      // base or secret not available: leave it unknown
    }
    const cron = safe(body?.schedule_cron, CRON);
    console.log(`monitor status=${status ?? "unknown"} schedule_cron=${cron === null ? "unknown" : JSON.stringify(cron)} webhook_is_ours=${ours} last_error_set=${Boolean(body?.last_error)}`);
  } else if (status !== null) {
    console.log(`monitor status=${status}`);
  }

  if (args.expect !== undefined && status !== args.expect) {
    console.log(`expected status=${args.expect} but the Monitor has status=${status ?? "unknown"}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Fatal ? err.message : `unexpected error: ${err?.name ?? "Error"}`);
  process.exitCode = 1;
}
