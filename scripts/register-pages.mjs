#!/usr/bin/env node
// Registers the curated pages (pages.json) with a running Fineprint Worker.
//
//   node scripts/register-pages.mjs --base <worker url> [--token <admin token>] [--limit 20] [--delay 10]
//
// For each entry of pages.json, in order, it POSTs {url, label, kind} to <base>/api/pages with the
// admin token. A 201 (new page) and a 409 already_watched (page exists) both count as registered, so
// a re-run resumes where the last one stopped. It stops once <limit> pages are registered. Anything
// else (a refusal such as 422 unfetchable, a 5xx, a network error) is recorded and skipped, and the
// next entry is tried. After each new page it waits <delay> seconds; Fineprint's facts runs form
// their own serial queue after the pages are added, so nothing here waits for them.
//
// The token comes from --token or the ADMIN_TOKEN environment variable and is never printed or
// written. The script prints a table (# | url | status | reason) and writes docs/registration-log.md
// (override with --log <path>), which feeds the README's "tried and skipped" table. The log is
// rewritten after every entry, so an interrupted run still leaves what it learned.
//
// Exit code: 0 when <limit> pages are registered, 1 in every other case (including refusing to run).
// Plain Node (24+), no dependencies.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PAGES_FILE = fileURLToPath(new URL("../pages.json", import.meta.url));
const DEFAULT_LOG = fileURLToPath(new URL("../docs/registration-log.md", import.meta.url));
const ADD_TIMEOUT_MS = 180_000; // an add runs TinyFetch, creates a Monitor and waits for its first check
const PREFLIGHT_TIMEOUT_MS = 20_000;
const ID_PROBE = "token-check"; // an id no page has; see preflight()

const USAGE = "usage: node scripts/register-pages.mjs --base <worker url> [--token <admin token>] [--limit 20] [--delay 10] [--log <file>]";

// A reason to stop. main() is wrapped below, which prints it and sets the exit code, so that
// buffered output is flushed (process.exit() can cut off a pipe on Windows).
class Fatal extends Error {}

function fail(message) {
  throw new Fatal(message);
}

// --- Arguments ----------------------------------------------------------------

function parseArgs(argv) {
  const known = new Set(["base", "token", "limit", "delay", "log"]);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(arg);
    if (!m || !known.has(m[1])) {
      // Name the flag only: what follows it (or a bare word) could be a token that was typed in the wrong place.
      const flag = /^--[a-z]+/.exec(arg)?.[0];
      fail(`${flag ? `unknown argument ${flag}` : "unexpected argument without a flag name"}\n${USAGE}`);
    }
    let value = m[2];
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith("--")) fail(`--${m[1]} needs a value\n${USAGE}`);
    }
    args[m[1]] = value;
  }
  return args;
}

function readOptions() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.base) fail(`--base is required\n${USAGE}`);
  let base;
  try {
    base = new URL(args.base);
  } catch {
    fail(`--base is not a url: ${JSON.stringify(args.base.slice(0, 80))}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    fail("--base must be https (plain http is accepted only for localhost): the admin token travels in every request");
  }

  const token = (args.token ?? process.env.ADMIN_TOKEN ?? "").trim();
  if (token === "") fail(`no admin token: pass --token or set ADMIN_TOKEN\n${USAGE}`);

  const limit = args.limit === undefined ? 20 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a whole number, 1 or more");
  const delay = args.delay === undefined ? 10 : Number(args.delay);
  if (!Number.isFinite(delay) || delay < 0) fail("--delay must be a number of seconds, 0 or more");

  return { base: base.origin + base.pathname.replace(/\/+$/, ""), token, limit, delay, logFile: args.log ?? DEFAULT_LOG };
}

// --- Requests -----------------------------------------------------------------

// A network failure as short text: undici wraps the real reason in `cause` ("fetch failed").
function describeNetworkError(err) {
  const cause = err?.cause?.code ?? err?.cause?.message ?? err?.code;
  const name = err?.name === "TimeoutError" ? "timeout" : (cause ?? err?.message ?? "unknown");
  return `network: ${String(name).slice(0, 80)}`;
}

// What a response says, in a few characters: the API's `error` code and `reason`, nothing else.
function describeBody(body) {
  const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 120) : "");
  const error = clean(body?.error);
  const reason = clean(body?.reason);
  return [error, reason].filter(Boolean).join(": ");
}

async function call(options, method, path, payload, timeoutMs) {
  const res = await fetch(options.base + path, {
    method,
    headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// A wrong token would not be refused by POST /api/pages: the Worker would treat the caller as a
// public visitor and create a public page that expires in 7 days. PATCH is admin-only and checks the
// token before it looks the page up, so a PATCH to an id no page has answers 404 for the real token
// and 401 for any other. Nothing is changed either way.
async function preflight(options) {
  let res;
  try {
    res = await call(options, "PATCH", `/api/pages/${ID_PROBE}`, {}, PREFLIGHT_TIMEOUT_MS);
  } catch (err) {
    fail(`cannot reach ${options.base}: ${describeNetworkError(err)}`);
  }
  if (res.status === 401) fail("the admin token was not accepted (HTTP 401); nothing was registered");
  if (res.status !== 404) fail(`unexpected answer from ${options.base} while checking the admin token: HTTP ${res.status} ${describeBody(res.body)}`);
}

// One entry. Returns {result: "registered" | "already watched" | "skipped", status, reason, isNew, pageId}.
async function register(options, entry) {
  let res;
  try {
    res = await call(options, "POST", "/api/pages", { url: entry.url, label: entry.label, kind: entry.kind }, ADD_TIMEOUT_MS);
  } catch (err) {
    return { result: "skipped", status: "ERR", reason: describeNetworkError(err), isNew: false };
  }

  if (res.status === 201) {
    const page = res.body?.page;
    // The token was checked first, so this should not happen; if it does, stop before more public pages are made.
    if (page?.added_by !== "admin") {
      return { result: "skipped", status: 201, reason: `created as ${JSON.stringify(page?.added_by)}, not admin`, isNew: true, abort: true };
    }
    return { result: "registered", status: 201, reason: String(page.id ?? ""), isNew: true };
  }
  if (res.status === 409 && res.body?.error === "already_watched") {
    return { result: "already watched", status: 409, reason: String(res.body.page_id ?? ""), isNew: false };
  }
  return { result: "skipped", status: res.status, reason: describeBody(res.body) || "no error body", isNew: false };
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// --- Output -------------------------------------------------------------------

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function printTable(rows) {
  const lines = rows.map((r) => ({ n: String(r.n), url: r.entry.url, status: String(r.status), reason: `${r.result}${r.reason ? `: ${r.reason}` : ""}` }));
  const w = (key, head) => Math.max(head.length, ...lines.map((l) => l[key].length));
  const wn = w("n", "#");
  const wu = w("url", "url");
  const ws = w("status", "status");
  const row = (n, url, status, reason) => `${n.padStart(wn)} | ${url.padEnd(wu)} | ${status.padEnd(ws)} | ${reason}`;
  console.log("");
  console.log(row("#", "url", "status", "reason"));
  console.log(`${"-".repeat(wn)}-+-${"-".repeat(wu)}-+-${"-".repeat(ws)}-+-${"-".repeat(24)}`);
  for (const l of lines) console.log(row(l.n, l.url, l.status, l.reason));
}

function renderLog({ startedAt, options, rows, total, summary, final }) {
  const out = [
    "# Registration log",
    "",
    `- Run started: ${startedAt} (UTC)`,
    `- Base URL: ${options.base}`,
    `- Limit: ${options.limit}, delay after each new page: ${options.delay} s`,
    `- Outcome: ${summary}`,
    "",
    "| # | Label | URL | Kind | Result | HTTP | Reason or page id |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    out.push(`| ${r.n} | ${cell(r.entry.label)} | ${cell(r.entry.url)} | ${r.entry.kind} | ${r.result} | ${r.status} | ${cell(r.reason)} |`);
  }
  if (final && rows.length < total) out.push("", `Entries ${(rows.at(-1)?.n ?? 0) + 1} to ${total} of pages.json were not tried.`);
  return out.join("\n") + "\n";
}

// --- Main ---------------------------------------------------------------------

async function main() {
  const options = readOptions();

  let entries;
  try {
    entries = JSON.parse(await readFile(PAGES_FILE, "utf8"));
  } catch (err) {
    fail(`cannot read pages.json: ${err.message}`);
  }
  if (!Array.isArray(entries) || entries.length === 0) fail("pages.json holds no entries");

  await preflight(options);

  const startedAt = new Date().toISOString();
  const rows = [];
  let registered = 0;
  let created = 0;
  let aborted = false;

  // The log is rewritten after every entry, so a run that is killed half way (a reboot, Ctrl-C) still leaves
  // the page ids and reasons it gathered. A write that fails is reported once and never stops the run.
  let warnedAboutLog = false;
  const saveLog = async (summary, final) => {
    try {
      await writeFile(options.logFile, renderLog({ startedAt, options, rows, total: entries.length, summary, final }), "utf8");
    } catch (err) {
      if (!warnedAboutLog) console.error(`cannot write ${options.logFile}: ${err.message}`);
      warnedAboutLog = true;
    }
  };

  for (let i = 0; i < entries.length && registered < options.limit; i++) {
    const entry = entries[i];
    const outcome = await register(options, entry);
    rows.push({ n: i + 1, entry, ...outcome });
    console.log(`[${i + 1}/${entries.length}] ${outcome.result} (${outcome.status}) ${entry.url}${outcome.reason ? ` - ${outcome.reason}` : ""}`);
    await saveLog("in progress (the run was interrupted if this line is still here)", false);

    if (outcome.abort) {
      aborted = true;
      break;
    }
    if (outcome.result !== "skipped") registered++;
    if (outcome.isNew) {
      created++;
      if (registered < options.limit && i + 1 < entries.length && options.delay > 0) {
        console.log(`  waiting ${options.delay} s before the next page ...`);
        await sleep(options.delay);
      }
    }
  }

  const skipped = rows.filter((r) => r.result === "skipped").length;
  const summary = aborted
    ? `stopped early: a page was created without admin rights (${registered} registered)`
    : `${registered} of ${options.limit} registered (${created} new, ${registered - created} already watched), ${skipped} skipped, ${entries.length - rows.length} not tried`;

  printTable(rows);
  console.log(`\n${summary}`);
  await saveLog(summary, true);
  if (!warnedAboutLog) console.log(`log written to ${options.logFile}`);

  process.exitCode = registered >= options.limit && !aborted ? 0 : 1;
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Fatal ? err.message : `unexpected error: ${err?.message ?? err}`);
  process.exitCode = 1;
}
