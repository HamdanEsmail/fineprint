# Fineprint Recorder and API Implementation Plan

Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Fineprint recorder (TinyFish Monitor webhooks in, versions with screenshots and sources out) and its public JSON API on one Cloudflare Worker, ready to register 20 pages and start the live clock.

**Architecture:** A Hono app on a Cloudflare Worker with D1 for rows and R2 for screenshots, HTML sources and raw webhook payloads. TinyFish Monitor is the only trigger: webhooks land at `POST /hooks/monitor/:secret`, pass a normalization gate, become versions, and captures (TinyBrowser screenshot over raw CDP, TinyFetch HTML, TinyAgent facts) run after the response via `waitUntil` with an hourly repair cron as the safety net. All read endpoints are public JSON; writes need an admin bearer token except a capped public "add a page".

**Tech Stack:** TypeScript (ESM, strict), Hono, Cloudflare Workers + D1 + R2 + Cron Triggers, `diff` (jsdiff) for line diffs, Vitest with `@cloudflare/vitest-pool-workers` (tests run inside workerd with real D1/R2 bindings and `fetchMock` for TinyFish), Wrangler 4. No ORM, no Supabase. The viewer (React) is a separate later plan.

**Spec:** `docs/specs/2026-11-03-fineprint-design.md`. The spec travels with this plan; read both. The spike code it references is in `../spikes/` (one folder up from the repo).

## Global Constraints

- Node `>=24`, `"type": "module"`, `"private": true`, every dependency pinned to the exact version `npm view <pkg> version` prints at install time (no `^`, no `~`).
- `npm run check` = `tsc --noEmit && vitest run && wrangler deploy --dry-run`. It must pass at the end of every task.
- Secrets only via Worker secrets / `.dev.vars`: `TINYFISH_API_KEY`, `ADMIN_TOKEN`, `WEBHOOK_SECRET`. Never in code, never in the client, never logged. `.dev.vars.example` lists all three with placeholder values.
- Hard caps, as constants in `src/core/limits.ts`: `MAX_MONITORS = 24`, `PUBLIC_SLOTS = 4`, `PUBLIC_TTL_DAYS = 7`, `PUBLIC_ADDS_PER_IP_PER_DAY = 1`, `AGENT_MAX_STEPS = 6`, `AGENT_MAX_DURATION_SECONDS = 120`, `CAPTURE_MAX_ATTEMPTS = 3`, `SCREENSHOT_MAX_HEIGHT = 8000`, `SPEND_PAUSE_USD = 8`.
- Prices in `src/core/spend.ts`: `monitor_check 0.005`, `screenshot 0.002`, `agent_step 0.016`, `fetch 0`, `search 0`.
- Monitor purpose text (verbatim from spec 4.5): "A price, plan, limit, fee, rule, eligibility condition, deadline or policy term was added, removed or changed. Ignore timestamps, 'last updated' notes, cookie banners, layout and wording-only edits."
- The Worker never fetches a watched page on its own schedule. Only the add-page validation, the capture of a version, and admin replay touch TinyFetch.
- All timestamps are ISO 8601 UTC strings. IDs are `crypto.randomUUID()`.
- Every TinyFish HTTP call goes through `src/tinyfish/client.ts` so spend is recorded in one place and the key is read in one place.
- Deploy and GitHub push happen only once the Cloudflare account is ready (R2 enabled, token has D1 permission). Until then everything runs under `wrangler dev` and `vitest`.

## Review Focus

1. A TinyFish webhook retry (same `id`) must not create a second run row or a second version: `runs.monitor_run_id` is unique and the handler returns 200 on a duplicate. Test in Task 7.
2. A page whose Monitor says `changed` but whose normalized text is identical to the last version (a "last updated" stamp moved) must create no version and no screenshot, and must count as suppressed. Test in Task 7.
3. A pricing page baseline whose Agent facts run fails must still have its screenshot and source, and `capture_status` must say exactly which capture failed. Test in Task 8.
4. `GET /api/pages/:id/as-of?at=` with a time before the baseline returns 404 with `{"error": "before_baseline", "baseline_at": "..."}`, not a 500 and not the baseline. Test in Task 9.
5. A public caller who has used their daily add, or arrives when the four public slots are full, gets a 429 or 409 with a plain-language reason, and no Monitor is created on TinyFish. Test in Task 6.

---

## File Structure

```
fineprint/
  package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts  .dev.vars.example  LICENSE  README.md
  migrations/0001_init.sql
  pages.json                      curated page list (url, label, kind), spec section 6
  scripts/register-pages.mjs      seeds pages.json through the admin API against a base URL
  src/index.ts                    Hono app wiring + `scheduled` export
  src/env.ts                      `Env` bindings type
  src/core/limits.ts              constants above
  src/core/spend.ts               PRICES, `recordSpend`
  src/core/normalize.ts           `normalize`, `hashText`
  src/core/diff.ts                `structuredDiff`, `factsDiff`
  src/core/schedule.ts            `cronForIndex`, `PURPOSE`
  src/tinyfish/client.ts          `tinyfishFetch` (auth header, JSON, spend hook, error mapping)
  src/tinyfish/fetch.ts           `fetchPage`
  src/tinyfish/monitor.ts         `createMonitor`, `updateMonitor`, `setMonitorStatus`, `deleteMonitor`, `listMonitors`
  src/tinyfish/browser.ts         `screenshotFullPage` (ported from ../spikes/worker-shot/src/index.js)
  src/tinyfish/agent.ts           `startFactsRun`, `FACTS_GOAL`, `FACTS_SCHEMA`, `parseFacts`
  src/tinyfish/search.ts          `discoverFinePrint`
  src/db/types.ts                 row types
  src/db/pages.ts                 page repository
  src/db/runs.ts                  run repository
  src/db/versions.ts              version repository incl. `versionAsOf`
  src/db/diffCache.ts             cache get/put
  src/db/publicAdds.ts            per-IP daily counter
  src/auth.ts                     `adminOnly` middleware, `isAdmin`
  src/capture.ts                  `captureVersion`, `recordFactsResult`
  src/handlers/pages.ts           /api/pages CRUD
  src/handlers/webhooks.ts        /hooks/monitor/:secret, /hooks/agent/:secret
  src/handlers/history.ts         versions, as-of, diff, changes, export, stats
  src/handlers/discover.ts        /api/discover
  src/handlers/objects.ts         /shots/:key, /sources/:key
  src/handlers/admin.ts           replay, rotate-webhook
  src/cron.ts                     repair, expiry, monitor health
  tests/fixtures/                 real TinyFish responses (copied from ../spikes/out and recorded webhooks)
  tests/*.test.ts                 one file per task below
  .github/workflows/check.yml     runs `npm run check` on push
```

---

### Task 1: Project scaffold, schema, smoke test

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.dev.vars.example`, `LICENSE` (MIT, Hamdan Esmail), `migrations/0001_init.sql`, `src/env.ts`, `src/index.ts`, `src/core/limits.ts`, `src/core/spend.ts`, `.github/workflows/check.yml`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: `Env` in `src/env.ts` = `{ DB: D1Database; STORE: R2Bucket; TINYFISH_API_KEY: string; ADMIN_TOKEN: string; WEBHOOK_SECRET: string; PUBLIC_BASE_URL: string }`.
- Produces: `app` (Hono) and `export default { fetch: app.fetch, scheduled }` from `src/index.ts`; `scheduled` is a stub until Task 11.
- Produces: `recordSpend(db: D1Database, kind: SpendKind, amountUsd: number, ref: string): Promise<void>` and `PRICES: Record<SpendKind, number>` where `SpendKind = "monitor_check" | "screenshot" | "agent_step" | "fetch" | "search"`.
- Produces: the D1 schema below, applied in tests by `applyD1Migrations`.

`migrations/0001_init.sql` creates:
- `pages(id TEXT PK, url TEXT UNIQUE, label TEXT, kind TEXT CHECK(kind IN ('pricing','fees','policy','rules','other')), monitor_id TEXT, schedule_cron TEXT, purpose TEXT, status TEXT CHECK(status IN ('active','paused','failed','expired')), added_by TEXT CHECK(added_by IN ('curated','public','admin')), ignore_patterns TEXT NOT NULL DEFAULT '[]', expires_at TEXT, created_at TEXT, last_run_at TEXT, last_change_at TEXT)`
- `runs(id TEXT PK, page_id TEXT, monitor_run_id TEXT UNIQUE, outcome TEXT, is_baseline INTEGER, judgment_relevant INTEGER, judgment_summary TEXT, diff_truncated INTEGER, noise_suppressed INTEGER DEFAULT 0, noise_reason TEXT, raw_key TEXT, received_at TEXT)` with index on `(page_id, received_at)`
- `versions(id TEXT PK, page_id TEXT, run_id TEXT, is_baseline INTEGER, captured_at TEXT, text TEXT, normalized_hash TEXT, judgment_summary TEXT, screenshot_key TEXT, html_key TEXT, facts_json TEXT, capture_status TEXT NOT NULL DEFAULT 'pending', capture_error TEXT, capture_attempts INTEGER DEFAULT 0, agent_run_id TEXT)` with index on `(page_id, captured_at)`
- `diff_cache(from_version_id TEXT, to_version_id TEXT, json TEXT, created_at TEXT, PRIMARY KEY(from_version_id, to_version_id))`
- `spend(id TEXT PK, kind TEXT, amount_usd REAL, ref TEXT, at TEXT)`
- `public_adds(ip_hash TEXT, day TEXT, count INTEGER, PRIMARY KEY(ip_hash, day))`

`wrangler.jsonc`: `name: "fineprint"`, `main: "src/index.ts"`, `compatibility_date: "2026-09-01"`, `d1_databases: [{binding: "DB", database_name: "fineprint", database_id: "TBD-after-create", migrations_dir: "migrations"}]`, `r2_buckets: [{binding: "STORE", bucket_name: "fineprint"}]`, `triggers: {crons: ["0 * * * *"]}`, `vars: {PUBLIC_BASE_URL: "http://localhost:8787"}`, `observability: {enabled: true}`.

`vitest.config.ts`: `defineWorkersConfig` with `wrangler: {configPath: "./wrangler.jsonc"}` and `miniflare.bindings.TEST_MIGRATIONS = readD1Migrations("./migrations")`; a `tests/setup.ts` that runs `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` and sets `ADMIN_TOKEN`, `WEBHOOK_SECRET`, `TINYFISH_API_KEY` test values via `miniflare.bindings`.

- [ ] **Step 1: Write the failing smoke test**

```ts
// tests/smoke.test.ts
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
describe("smoke", () => {
  it("GET /api/stats returns zero counts", async () => {
    const res = await SELF.fetch("http://x/api/stats");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pages: 0, runs: 0, versions: 0, noise_suppressed: 0, spend_usd: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/smoke.test.ts`
Expected: FAIL (no app yet / module not found)

- [ ] **Step 3: Create the scaffold files listed above; `src/index.ts` mounts a temporary `/api/stats` that counts rows in `pages`, `runs`, `versions`, sums `spend.amount_usd`, counts `runs.noise_suppressed = 1`**

`npm install` exact versions of: `hono`, `diff`, and dev `typescript`, `vitest`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, `wrangler`, `@types/diff`. Scripts: `dev`, `deploy`, `test`, `typecheck`, `check`, `migrate:local` (`wrangler d1 migrations apply fineprint --local`), `migrate:remote`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS

- [ ] **Step 5: Run `npm run check` and commit**

```bash
git add -A
git commit -m "feat: scaffold Worker, D1 schema, R2 binding, spend ledger, smoke test"
```

---

### Task 2: Normalization gate

**Files:**
- Create: `src/core/normalize.ts`
- Test: `tests/normalize.test.ts`, fixtures `tests/fixtures/normalize/*.txt`

**Interfaces:**
- Produces: `normalize(text: string, ignorePatterns: string[] = []): { text: string; suppressed: string[] }` and `hashText(text: string): Promise<string>` (SHA-256 hex via `crypto.subtle`).
- `suppressed` lists each removed line or parameter, so the webhook handler can store a `noise_reason`.

Rules, in order (spec 4.3): collapse runs of whitespace to one space and runs of blank lines to one; strip tracking query parameters (`utm_*`, `gclid`, `fbclid`, `ref`, `_ga`, `mc_cid`, `mc_eid`, `igshid`) from any URL in the text; drop whole lines that match the metadata list (case-insensitive, anchored at line start after optional markdown markers): `last updated`, `updated on`, `updated:`, `published`, `effective date`, `page generated`, `as of`, `©` or `copyright`, and relative times (`\b\d+ (seconds?|minutes?|hours?|days?) ago\b`); drop whole lines matching the built-in noise list (`skip to content`, `we use cookies`, `accept all cookies`, `cookie settings`, `people viewing`, `shares?$`); drop lines matching any `ignorePatterns` regex (invalid regex is ignored, never throws). Never remove dates that are not on a metadata line.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/normalize.test.ts
import { normalize, hashText } from "../src/core/normalize";
it("drops a 'Last updated' line but keeps a cutoff date in content", () => {
  const { text, suppressed } = normalize("## Visa Bulletin\nFinal action date: 01 MAR 2023\nLast updated: 3 November 2026\n");
  expect(text).toContain("01 MAR 2023");
  expect(text).not.toContain("Last updated");
  expect(suppressed).toEqual(["Last updated: 3 November 2026"]);
});
it("strips utm parameters from links but keeps the link", () => {
  expect(normalize("[Pricing](https://a.com/p?utm_source=x&plan=pro)").text).toBe("[Pricing](https://a.com/p?plan=pro)");
});
it("applies page ignore patterns and tolerates an invalid regex", () => {
  const { text } = normalize("Price $20\nVisitors today: 1234\n", ["^Visitors today", "(["]);
  expect(text).toBe("Price $20");
});
it("keeps prices and plain numbers", () => {
  expect(normalize("Pro $25 /mo, 1,000 requests, 2026 model").text).toBe("Pro $25 /mo, 1,000 requests, 2026 model");
});
it("same input gives same hash, one changed digit gives a different hash", async () => {
  expect(await hashText("a")).toBe(await hashText("a"));
  expect(await hashText("Pro $20")).not.toBe(await hashText("Pro $25"));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/normalize.test.ts`
Expected: FAIL with "normalize is not defined" or module not found

- [ ] **Step 3: Implement `normalize` and `hashText` in `src/core/normalize.ts`**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/normalize.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/normalize.ts tests/normalize.test.ts
git commit -m "feat: normalization gate with metadata-line and tracking-param rules"
```

---

### Task 3: Structured diff

**Files:**
- Create: `src/core/diff.ts`
- Test: `tests/diff.test.ts`

**Interfaces:**
- Produces: `splitBlocks(normalizedText: string): Block[]` where `Block = { section: string; text: string }` (section = nearest preceding markdown heading text, `""` before the first heading; blocks split on blank lines; a heading line starts a new block and becomes the section for following blocks).
- Produces: `structuredDiff(fromText: string, toText: string): { added: Block[]; removed: Block[]; changed: { section: string; before: string; after: string }[] }`. Uses `diffArrays` from `diff` on block texts; a removed block immediately followed by an added block in the same section with Dice similarity ≥ 0.5 (bigram) pairs into one `changed` entry.
- Produces: `Fact = { name: string; price: string; unit: string | null; notes: string | null }` and `factsDiff(from: Fact[] | null, to: Fact[] | null): { added: Fact[]; removed: Fact[]; changed: { name: string; field: "price" | "unit" | "notes"; before: string | null; after: string | null }[] } | null` (null when either side is null; facts matched by case-insensitive `name`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/diff.test.ts
import { splitBlocks, structuredDiff, factsDiff } from "../src/core/diff";
const A = "# Plans\n\n## Pro\n\n$20 per month\nUnlimited projects\n\n## Hobby\n\nFree";
const B = "# Plans\n\n## Pro\n\n$25 per month\nUnlimited projects\n\n## Hobby\n\nFree\n\n## Ultra\n\n$200 per month";
it("attributes blocks to the nearest heading", () => {
  expect(splitBlocks(A).map(b => b.section)).toEqual(["Plans", "Pro", "Pro", "Hobby", "Hobby"]);
});
it("reports a price change as changed, a new tier as added, nothing removed", () => {
  const d = structuredDiff(A, B);
  expect(d.changed).toEqual([{ section: "Pro", before: "$20 per month\nUnlimited projects", after: "$25 per month\nUnlimited projects" }]);
  expect(d.added.map(b => b.section)).toEqual(["Ultra", "Ultra"]);
  expect(d.removed).toEqual([]);
});
it("identical input gives an empty diff", () => {
  expect(structuredDiff(A, A)).toEqual({ added: [], removed: [], changed: [] });
});
it("diffs facts by name", () => {
  const d = factsDiff([{ name: "Pro", price: "$20", unit: "month", notes: null }], [{ name: "Pro", price: "$25", unit: "month", notes: null }, { name: "Ultra", price: "$200", unit: "month", notes: null }]);
  expect(d).toEqual({ added: [{ name: "Ultra", price: "$200", unit: "month", notes: null }], removed: [], changed: [{ name: "Pro", field: "price", before: "$20", after: "$25" }] });
  expect(factsDiff(null, [])).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/diff.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/core/diff.ts`**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/diff.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/diff.ts tests/diff.test.ts
git commit -m "feat: structured block diff and facts diff"
```

---

### Task 4: TinyFish clients

**Files:**
- Create: `src/tinyfish/client.ts`, `src/tinyfish/fetch.ts`, `src/tinyfish/monitor.ts`, `src/tinyfish/browser.ts`, `src/tinyfish/agent.ts`, `src/tinyfish/search.ts`, `src/core/schedule.ts`
- Test: `tests/tinyfish.test.ts`, fixtures copied from `../spikes/out/`: `fetch.json`, `monitor-create.json`, `monitor-get.json`, `monitor-runnow.json`, `agent-run.json`, `agent-schema-run.json`, `browser-create.json` into `tests/fixtures/tinyfish/`
- Integration (opt-in, skipped without `TINYFISH_API_KEY` in `process.env`): `tests/integration/browser.live.test.ts`

**Interfaces:**
- `client.ts`: `tinyfishFetch(env: Env, url: string, init: RequestInit & { spend?: { kind: SpendKind; amountUsd: number; ref: string } }): Promise<Response>`. Adds `X-API-Key`, `Content-Type: application/json`, records spend after a 2xx when `spend` is given, maps non-2xx to `TinyFishError { status, code, message }` (code from `body.error.code` when present).
- `fetch.ts`: `fetchPage(env, url, format: "markdown" | "html"): Promise<{ ok: true; text: string; title: string | null; finalUrl: string } | { ok: false; error: string; status?: number }>`. Body `{urls: [url], format, ttl: 0, include_etag_and_last_modified: true, per_url_timeout_ms: 45000}`; a per-URL entry in `errors[]` becomes `{ok: false, error: errors[0].error}`.
- `monitor.ts`: `createMonitor(env, p: { url: string; name: string; scheduleCron: string; purpose: string; webhookUrl: string }): Promise<{ monitorId: string; baselineText: string; baselineRunId: string }>`; `updateMonitor(env, id, p: { scheduleCron: string; name?: string; purpose?: string; webhookUrl?: string | null })`; `setMonitorStatus(env, id, status: "active" | "paused")` (sends `{status}` alone, spec: union); `deleteMonitor(env, id)`; `listMonitors(env): Promise<{ id: string; status: string; name: string | null }[]>`.
- `browser.ts`: `screenshotFullPage(env, url: string): Promise<{ bytes: ArrayBuffer; height: number; sessionId: string }>`, a straight port of `../spikes/worker-shot/src/index.js` (same CDP sequence, 6 s settle, height capped at `SCREENSHOT_MAX_HEIGHT`, `Browser.close` in a `finally`, base64 decoded through `fetch("data:image/jpeg;base64,...")`). Records spend `screenshot 0.002`.
- `agent.ts`: `FACTS_GOAL` (exact copy below), `FACTS_SCHEMA` (JSON schema: `{type: "object", properties: {items: {type: "array", items: {type: "object", properties: {name: {type: "string"}, price: {type: "string"}, unit: {type: "string", nullable: true}, notes: {type: "string", nullable: true}}, required: ["name", "price"]}}}, required: ["items"]}`), `startFactsRun(env, url: string, callbackUrl: string): Promise<{ runId: string }>` posting to `/v1/automation/run-async` with `browser_profile: "lite"`, `agent_config: {max_steps: AGENT_MAX_STEPS, max_duration_seconds: AGENT_MAX_DURATION_SECONDS}`, `output_schema: FACTS_SCHEMA`, `webhook_url: callbackUrl`; `getRun(env, runId)` (GET `/v1/runs/{id}?screenshots=none&html=none`); `parseFacts(result: unknown): Fact[] | null` (null unless `result.items` is an array of objects with string `name` and `price`).
- `search.ts`: `discoverFinePrint(env, domain: string): Promise<{ url: string; title: string; kind: "pricing" | "policy" | "fees" | "other" }[]>`: four GETs to `https://api.search.tinyfish.ai` with `query` in `["pricing plans", "terms of service", "privacy policy", "fees and charges"]`, `include_domains=<domain>`, `purpose="find the fine-print pages of a website"`; results deduped by URL, `kind` inferred from the query.
- `schedule.ts`: `cronForIndex(n: number): string` = `` `${(n * 7) % 60} ${n % 12},${(n % 12) + 12} * * *` `` and `export const PURPOSE = "<spec 4.5 text>"`.

`FACTS_GOAL` (exact): "This is a pricing or fee page. List every plan, tier, product or fee shown on this page with its price. For each item return: name (the plan or fee name exactly as written), price (the amount with its currency symbol exactly as written, or Free, or Custom), unit (per month, per year, per request, per GB, or null), notes (one short line saying what the price includes, or null). Include every item, including free and enterprise or custom tiers. If a monthly/yearly toggle exists, use the monthly values. Do not navigate away from this page except to dismiss a cookie banner. Return items in the order they appear."

- [ ] **Step 1: Write the failing tests (use `fetchMock` from `cloudflare:test`, `fetchMock.disableNetConnect()` in `beforeAll`)**

```ts
// tests/tinyfish.test.ts
it("fetchPage returns text for a 200 result and an error code for a per-URL error", async () => { /* intercept POST https://api.fetch.tinyfish.ai -> fixtures/tinyfish/fetch.json, expect ok:true, title "Vercel Pricing: Hobby, Pro, and Enterprise plans"; second intercept -> {results:[],errors:[{url, error:"bot_blocked"}]}, expect {ok:false, error:"bot_blocked"} */ });
it("createMonitor returns monitorId and the baseline text from the 201 body", async () => { /* intercept POST /v1/monitors -> fixtures/tinyfish/monitor-create.json; expect baselineText.length === 13696 */ });
it("setMonitorStatus sends {status} alone and updateMonitor always includes schedule_cron", async () => { /* assert request bodies via intercept callbacks */ });
it("tinyfishFetch records spend on 2xx and maps a 402 to TinyFishError INSUFFICIENT_CREDITS", async () => { /* expect a spend row kind "screenshot" amount 0.002 after a mocked 200; expect thrown error.code === "INSUFFICIENT_CREDITS" after a mocked 402 {error:{code:"INSUFFICIENT_CREDITS"}} */ });
it("parseFacts accepts the schema shape and rejects junk", () => { expect(parseFacts({ items: [{ name: "Pro", price: "$20" }] })).toEqual([{ name: "Pro", price: "$20", unit: null, notes: null }]); expect(parseFacts({ plans: [] })).toBeNull(); });
it("cronForIndex staggers minutes and hours", () => { expect(cronForIndex(0)).toBe("0 0,12 * * *"); expect(cronForIndex(13)).toBe("31 1,13 * * *"); });
it("discoverFinePrint dedupes URLs and labels kinds", async () => { /* four intercepts of GET api.search.tinyfish.ai returning overlapping urls; expect unique urls and kind "pricing" for the pricing query hit */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tinyfish.test.ts`
Expected: FAIL (modules not found)

- [ ] **Step 3: Implement the six client files and `schedule.ts`**

- [ ] **Step 4: Run to verify they pass; run the live browser test once with the key to prove the port**

Run: `npx vitest run tests/tinyfish.test.ts`
Expected: PASS (7 tests)
Run: `TINYFISH_API_KEY=... npx vitest run tests/integration/browser.live.test.ts` (reads the key from `../.dev.vars` if not in env; skipped otherwise)
Expected: PASS, logs `bytes > 100000`, costs about $0.002

- [ ] **Step 5: Commit**

```bash
git add src/tinyfish src/core/schedule.ts tests/tinyfish.test.ts tests/integration tests/fixtures/tinyfish
git commit -m "feat: TinyFish clients for Fetch, Monitor, Browser, Agent, Search with spend recording"
```

---

### Task 5: Repositories and the as-of rule

**Files:**
- Create: `src/db/types.ts`, `src/db/pages.ts`, `src/db/runs.ts`, `src/db/versions.ts`, `src/db/diffCache.ts`, `src/db/publicAdds.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- `types.ts`: `PageRow`, `RunRow`, `VersionRow`, `SpendRow` mirroring the schema (snake_case columns as-is).
- `pages.ts`: `insertPage(db, p: Omit<PageRow, "created_at" | "last_run_at" | "last_change_at">)`, `getPage(db, id)`, `getPageByMonitorId(db, monitorId)`, `getPageByUrl(db, url)`, `listPages(db): Promise<(PageRow & { version_count: number; noise_count: number; latest_version_at: string | null })[]>`, `updatePage(db, id, patch: Partial<Pick<PageRow, "label" | "kind" | "schedule_cron" | "purpose" | "status" | "ignore_patterns" | "expires_at" | "added_by" | "last_run_at" | "last_change_at">>)`, `countMonitors(db, addedBy?: PageRow["added_by"]): Promise<number>` (counts pages with status in `active`, `paused`, `failed`).
- `runs.ts`: `insertRun(db, r: RunRow): Promise<"inserted" | "duplicate">` (duplicate when `monitor_run_id` exists), `markNoise(db, runId, reason)`, `countRuns(db)`, `countNoise(db)`.
- `versions.ts`: `insertVersion(db, v)`, `getVersion(db, id)`, `latestVersion(db, pageId)`, `listVersions(db, pageId)` (no `text`), `versionAsOf(db, pageId, atIso): Promise<VersionRow | "before_baseline" | "no_versions">`, `listChanges(db, sinceIso: string | null, limit: number)` (non-baseline versions newest first, joined with page label and url), `pendingCaptures(db, olderThanIso, maxAttempts)`, `updateCapture(db, id, patch: Partial<Pick<VersionRow, "screenshot_key" | "html_key" | "facts_json" | "capture_status" | "capture_error" | "capture_attempts" | "agent_run_id">>)`, `getVersionByAgentRunId(db, runId)`.
- `diffCache.ts`: `getCachedDiff(db, fromId, toId): Promise<string | null>`, `putCachedDiff(db, fromId, toId, json)`.
- `publicAdds.ts`: `publicAddsToday(db, ipHash): Promise<number>`, `recordPublicAdd(db, ipHash)`; `ipHash = sha256(ip + WEBHOOK_SECRET)` computed by the caller.

- [ ] **Step 1: Write the failing tests against the real D1 binding**

```ts
// tests/db.test.ts
it("versionAsOf returns the latest version at or before the time, baseline included", async () => { /* insert page, versions at T1 (baseline), T2, T3; expect asOf(T2 + 1min).id === v2; asOf(T1).id === v1; asOf(T1 - 1min) === "before_baseline"; asOf on a page with no versions === "no_versions" */ });
it("insertRun is idempotent on monitor_run_id", async () => { /* second insert returns "duplicate", countRuns stays 1 */ });
it("listChanges excludes baselines and orders newest first", async () => {});
it("countMonitors counts active, paused and failed but not expired", async () => {});
it("publicAddsToday counts per ip per UTC day", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the six repository files with prepared statements (`db.prepare(...).bind(...)`)**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db tests/db.test.ts
git commit -m "feat: D1 repositories with as-of lookup, idempotent runs, public add counter"
```

---

### Task 6: Add, read, update and delete pages

**Files:**
- Create: `src/auth.ts`, `src/handlers/pages.ts`
- Modify: `src/index.ts` (mount `/api/pages`)
- Test: `tests/pages.test.ts`

**Interfaces:**
- `auth.ts`: `isAdmin(c): boolean` (header `Authorization: Bearer <ADMIN_TOKEN>`, constant-time compare), `adminOnly` Hono middleware returning 401 `{error: "admin_required"}`.
- `POST /api/pages` body `{url, label?, kind?, ignore_patterns?}` → 201 `{page, baseline_version_id}`. Order of checks (spec 4.1): URL must be `http(s)` and not a private host → 400 `{error: "invalid_url"}`; existing URL → 409 `{error: "already_watched", page_id}`; `countMonitors(db) >= MAX_MONITORS` → 409 `{error: "watchlist_full"}`; public caller and `countMonitors(db, "public") >= PUBLIC_SLOTS` → 409 `{error: "public_slots_full", retry_after: <earliest expires_at>}`; public caller and `publicAddsToday >= 1` → 429 `{error: "daily_limit", reason: "One public page per day per visitor"}`; `fetchPage` fails → 422 `{error: "unfetchable", reason: <TinyFetch error code>}`; then `createMonitor` with `cronForIndex(countMonitors)`, `PURPOSE`, `webhookUrl = ${PUBLIC_BASE_URL}/hooks/monitor/${WEBHOOK_SECRET}`; insert page (`added_by` = `admin` or `public`, `expires_at` = now + 7 days for public, `kind` defaults `other`, label defaults to the fetched title or hostname); insert run (`is_baseline 1`, `outcome "baseline"`, `monitor_run_id = baselineRunId`); insert version (`is_baseline 1`, `text`, `normalized_hash`, `capture_status "pending"`); `c.executionCtx.waitUntil(captureVersion(c.env, version.id))` (Task 8; until then call a stub `captureVersion(env: Env, versionId: string): Promise<void>` exported from `src/capture.ts` that resolves immediately).
- `GET /api/pages` → `{pages: [...]}` from `listPages`. `GET /api/pages/:id` → `{page, versions: [...]}` (no text).
- `PATCH /api/pages/:id` (admin) body any of `label, kind, ignore_patterns, schedule_cron, purpose, promote: true` → applies `updateMonitor` when `schedule_cron` or `purpose` present (always sending the current or new `schedule_cron`); `promote` sets `added_by "curated"`, `expires_at null`. → 200 `{page}`.
- `DELETE /api/pages/:id` (admin) → `deleteMonitor`, set `status "expired"`, keep rows → 200 `{deleted: true}`.

- [ ] **Step 1: Write the failing tests (all TinyFish calls mocked with `fetchMock`; assert that on every rejected add **no** request reached `agent.tinyfish.ai`)**

```ts
// tests/pages.test.ts
it("admin add validates with TinyFetch, creates a Monitor with the staggered cron and purpose, stores baseline version", async () => { /* expect 201, monitor create body.schedule_cron === "0 0,12 * * *", body.purpose === PURPOSE, body.webhook_url endsWith "/hooks/monitor/test-secret"; a versions row with is_baseline 1 and text length 13696 */ });
it("rejects a second add of the same url with 409 already_watched", async () => {});
it("rejects an unfetchable url with 422 and the TinyFetch error code, creating no Monitor", async () => {});
it("public add sets expires_at 7 days out and counts against the ip; second add same day is 429", async () => {});
it("public add when 4 public pages exist is 409 public_slots_full", async () => {});
it("25th monitor is refused with 409 watchlist_full", async () => {});
it("PATCH schedule sends one Monitor PATCH that includes schedule_cron; PATCH without admin token is 401", async () => {});
it("DELETE deletes the Monitor and marks the page expired", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/pages.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/auth.ts`, `src/handlers/pages.ts`, mount in `src/index.ts`**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/pages.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/handlers/pages.ts src/index.ts src/capture.ts tests/pages.test.ts
git commit -m "feat: add/read/update/delete pages with TinyFetch validation, Monitor creation and public caps"
```

---

### Task 7: Monitor webhook receiver and the change gate

**Files:**
- Create: `src/handlers/webhooks.ts`
- Modify: `src/index.ts`
- Test: `tests/webhook.test.ts`, fixtures `tests/fixtures/webhooks/{unchanged,changed-real,changed-noise}.json` (hand-built from the spec's documented payload shape until real ones are recorded on day 1; the file names stay the same so the real recordings replace them)

**Interfaces:**
- `POST /hooks/monitor/:secret`: wrong secret → 404 (no body). Parse JSON; `fetch_monitor_id` unknown → 404 `{error: "unknown_monitor"}`. Put raw body at `raw/${payload.id}.json` in R2. `insertRun` with `monitor_run_id = payload.id`, `outcome`, `is_baseline`, `judgment_relevant` (`judgment?.is_relevant` as 1/0/null), `judgment_summary`, `diff_truncated`, `raw_key`, `received_at = now`; on `"duplicate"` → 200 `{ok: true, duplicate: true}`. `recordSpend(monitor_check, 0.005, payload.id)`. Update `pages.last_run_at`. Respond 200 `{ok: true, run_id}` for `unchanged` and `baseline` (a baseline here means a re-baseline on TinyFish's side; store the run, create no version).
- On `changed`: `text = payload.results[0]?.text ?? ""`; if empty or `payload.errors.length` → mark run `noise_reason "fetch_error"` and 200. Else `normalize(text, page.ignore_patterns)`, `hash`; compare with `latestVersion.normalized_hash`; equal → `markNoise(run, "normalized_identical")` and 200 `{ok: true, suppressed: true}`; different → `insertVersion` (`is_baseline 0`, `captured_at = received_at`, `judgment_summary`), update `pages.last_change_at`, `c.executionCtx.waitUntil(captureVersion(c.env, version.id))`, 200 `{ok: true, version_id}`.
- `POST /hooks/agent/:secret`: Task 8.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/webhook.test.ts
it("wrong secret is 404 and stores nothing", async () => {});
it("unchanged run stores a run row and spend 0.005, no version", async () => {});
it("changed run with a real difference creates a version with captured_at = receipt time and keeps the raw payload in R2", async () => { /* expect env.STORE.get(`raw/${id}.json`) not null; versions count 2 */ });
it("changed run whose only difference is a Last updated line is suppressed: no version, run.noise_suppressed 1, reason normalized_identical", async () => {});
it("the same payload id delivered twice yields one run and one version", async () => {});
it("unknown fetch_monitor_id is 404 unknown_monitor", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/handlers/webhooks.ts` (monitor route only) and mount it**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/handlers/webhooks.ts src/index.ts tests/webhook.test.ts tests/fixtures/webhooks
git commit -m "feat: Monitor webhook receiver with idempotent runs and the normalization gate"
```

---

### Task 8: Capture pipeline and Agent callback

**Files:**
- Create: `src/capture.ts` (replace the stub), `src/handlers/objects.ts`
- Modify: `src/handlers/webhooks.ts` (add `/hooks/agent/:secret`), `src/index.ts`
- Test: `tests/capture.test.ts`

**Interfaces:**
- `captureVersion(env: Env, versionId: string): Promise<void>`: loads version and page; increments `capture_attempts`; runs the three captures independently, each in its own try/catch: screenshot → `STORE.put("shots/<id>.jpg", bytes, {httpMetadata: {contentType: "image/jpeg"}})` and `screenshot_key`; source → `fetchPage(env, url, "html")` → `STORE.put("html/<id>.html", ...)` and `html_key`; facts only if `page.kind in ("pricing", "fees")` and (`version.is_baseline` or the run's `judgment_relevant !== 0`) → `startFactsRun(env, url, ${PUBLIC_BASE_URL}/hooks/agent/${WEBHOOK_SECRET})` and `agent_run_id`. Then `capture_status` = `"complete"` when screenshot and html keys exist and (no facts needed or `facts_json` set), `"awaiting_facts"` when only facts are outstanding, else `"partial"`; `capture_error` = joined failure messages or null. If `capture_attempts >= CAPTURE_MAX_ATTEMPTS` and not complete → `"failed"`.
- `recordFactsResult(env, runId: string, status: string, result: unknown, numSteps: number | null)`: finds the version by `agent_run_id`; `COMPLETED` with `parseFacts` non-null → `facts_json`, recompute `capture_status`; else `capture_error "facts: <status or parse failure>"`. Records spend `agent_step 0.016 × numSteps` when known.
- `POST /hooks/agent/:secret`: TinyFish run-lifecycle webhook; accept any JSON that has `run_id` and `status`; when `status` is terminal, if `result` is absent call `getRun` to fetch it, then `recordFactsResult`. 200 always after the secret check.
- `objects.ts`: `GET /shots/:key` and `GET /sources/:key` stream the R2 object with its content type and `Cache-Control: public, max-age=31536000, immutable`; 404 when missing.
- Spend pause: before any capture, if `SUM(spend.amount_usd) >= SPEND_PAUSE_USD`, set `capture_error "spend_paused"` and return without calling TinyFish.

- [ ] **Step 1: Write the failing tests (TinyBrowser CDP is mocked at the module level by stubbing `screenshotFullPage` with `vi.mock("../src/tinyfish/browser")`; Fetch and Agent via `fetchMock`)**

```ts
// tests/capture.test.ts
it("captures screenshot and html for a policy page and marks complete without an Agent run", async () => { /* expect STORE has shots/<id>.jpg and html/<id>.html, no request to /v1/automation */ });
it("a pricing baseline starts a facts run with FACTS_GOAL, the schema and the callback url, status awaiting_facts", async () => {});
it("agent callback with COMPLETED result stores facts and completes; spend has agent_step rows", async () => {});
it("screenshot failure leaves html captured, status partial, capture_error names screenshot; third attempt marks failed", async () => {});
it("captures are skipped with spend_paused when the ledger is at $8", async () => {});
it("GET /shots/:key serves image/jpeg with immutable cache headers and 404s when missing", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/capture.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/capture.ts`, the agent route, `src/handlers/objects.ts`**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/capture.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts src/handlers/webhooks.ts src/handlers/objects.ts src/index.ts tests/capture.test.ts
git commit -m "feat: capture pipeline (screenshot, source, facts) with Agent callback and spend pause"
```

---

### Task 9: History API

**Files:**
- Create: `src/handlers/history.ts`
- Modify: `src/index.ts` (mount; replace the temporary `/api/stats`)
- Test: `tests/history.test.ts`

**Interfaces (all GET, JSON, `Access-Control-Allow-Origin: *`):**
- `/api/pages/:id/versions/:vid` → version with `text`, `facts` (parsed), `screenshot_url` (`${PUBLIC_BASE_URL}/shots/<key>` or null), `source_url` (`${PUBLIC_BASE_URL}/sources/<key>` or null), `live_url`, `judgment_summary`, `capture_status`.
- `/api/pages/:id/as-of?at=ISO` → same shape as above for `versionAsOf`; `"before_baseline"` → 404 `{error: "before_baseline", baseline_at}`; `"no_versions"` → 404 `{error: "no_versions"}`; missing or invalid `at` → 400.
- `/api/pages/:id/diff?from=ISO&to=ISO` → spec 4.7 shape exactly; `from` and `to` each resolve with `versionAsOf`; same version on both sides → empty diff with `hops: 0`; `hops` = number of versions with `captured_at` in `(from.captured_at, to.captured_at]`; `noise_suppressed_between` = runs with `noise_suppressed 1` in that interval; `summary` = `judgment_summary` of the `to` version; `facts` = `factsDiff` or null; cached via `diffCache` keyed by the two version ids.
- `/api/changes?since=ISO&limit=N` (limit default 50, max 200) → `{changes: [{version_id, page_id, page_label, url, captured_at, summary, screenshot_url}]}`.
- `/api/export.json` → `{generated_at, pages: [{...page, versions: [{id, captured_at, is_baseline, summary, screenshot_url, source_url, facts, capture_status}]}]}` (no `text`).
- `/api/stats` → `{pages, runs, versions, noise_suppressed, spend_usd, spend_by_kind, monitors: {active, paused, failed, expired}, cost_per_catch_usd}` where catches = non-baseline versions.

- [ ] **Step 1: Write the failing tests (seed D1 directly with three versions of one pricing page with facts)**

```ts
// tests/history.test.ts
it("as-of returns the version in force, 404 before_baseline with the baseline time, 400 without at", async () => {});
it("diff between first and third version reports Pro price change in facts and blocks, hops 2, and is served from cache the second time", async () => { /* assert diff_cache has one row after first call; spy that structuredDiff is not called again */ });
it("changes feed excludes baselines and respects limit", async () => {});
it("export.json contains absolute screenshot urls and no text", async () => {});
it("stats reports spend by kind and cost per catch", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/history.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/handlers/history.ts` and mount it**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/history.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/handlers/history.ts src/index.ts tests/history.test.ts
git commit -m "feat: history API: versions, as-of, structured diff with cache, changes feed, export, stats"
```

---

### Task 10: Discover, replay, rotate-webhook

**Files:**
- Create: `src/handlers/discover.ts`, `src/handlers/admin.ts`
- Modify: `src/index.ts`
- Test: `tests/admin.test.ts`

**Interfaces:**
- `POST /api/discover` body `{domain}` (public, rate limited to 10 per IP per day using `publicAdds` with key prefix `discover:`) → `{candidates: [{url, title, kind, already_watched: boolean}]}` via `discoverFinePrint`.
- `POST /api/pages/:id/replay` (admin): lists R2 objects under `raw/` for runs of this page (via `runs.raw_key`), re-runs the gate in `received_at` order against a rebuilt chain starting from the baseline, creates the versions that are missing (`captured_at` = the run's `received_at`, `judgment_summary` from the raw payload), marks them `capture_status "pending"` with `capture_error "replayed"` so the repair cron captures them, and returns `{created: n, suppressed: m}`.
- `POST /api/admin/rotate-webhook` (admin) body `{base_url}`: `PUBLIC_BASE_URL` itself is a Worker var changed at deploy time, so this endpoint only re-points TinyFish: for every page with a `monitor_id` and status not `expired`, `updateMonitor(env, id, {scheduleCron: page.schedule_cron, webhookUrl: ${base_url}/hooks/monitor/${WEBHOOK_SECRET}})`; returns `{updated: n, failed: [...]}`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/admin.test.ts
it("discover returns deduped candidates with already_watched flags", async () => {});
it("replay creates the versions a stricter gate missed and leaves suppressed ones out", async () => { /* store two raw payloads: one real change, one Last-updated-only; expect created 1, suppressed 1 */ });
it("rotate-webhook PATCHes every live monitor with schedule_cron and the new webhook url", async () => {});
it("admin routes reject missing token with 401", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/admin.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the two handler files and mount them**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/admin.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/handlers/discover.ts src/handlers/admin.ts src/index.ts tests/admin.test.ts
git commit -m "feat: discover-by-domain, admin replay and rotate-webhook"
```

---

### Task 11: Hourly cron: repair, expiry, monitor health

**Files:**
- Create: `src/cron.ts`
- Modify: `src/index.ts` (`scheduled` calls `runCron`)
- Test: `tests/cron.test.ts`

**Interfaces:**
- `runCron(env: Env): Promise<{ repaired: number; expired: number; unhealthy: string[] }>`:
  1. Repair: `pendingCaptures(db, now - 10 min, CAPTURE_MAX_ATTEMPTS)` → `captureVersion` each, sequentially (TinyBrowser sessions are cheap but Agent concurrency is 2 account-wide).
  2. Facts follow-up: versions with `capture_status "awaiting_facts"` older than 15 min → `getRun(agent_run_id)`; terminal → `recordFactsResult`.
  3. Expiry: pages with `added_by "public"` and `expires_at <= now` and status not `expired` → `deleteMonitor`, `status "expired"`.
  4. Health: `listMonitors` → for each page with a `monitor_id`, if the monitor is missing or its status is not `active` while the page is `active`, set page `status "failed"` and record `unhealthy`.
- Triggered by `scheduled(event, env, ctx)` with `ctx.waitUntil(runCron(env))`; test invokes `runCron` directly.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/cron.test.ts
it("repair retries a partial capture older than 10 minutes and stops at 3 attempts", async () => {});
it("expiry deletes the Monitor of a public page past expires_at and marks it expired, keeping its versions", async () => {});
it("health marks a page failed when TinyFish reports its monitor paused", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/cron.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/cron.ts` and wire `scheduled`**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/cron.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cron.ts src/index.ts tests/cron.test.ts
git commit -m "feat: hourly cron for capture repair, public page expiry and monitor health"
```

---

### Task 12: Page list, register script, runbook, CI

**Files:**
- Create: `pages.json`, `scripts/register-pages.mjs`, `docs/runbook.md`, `README.md` (skeleton: what it is, live URL placeholder, how TinyFish is used table, run locally, deploy), `.github/workflows/check.yml`
- Test: `tests/pages-json.test.ts`

**Interfaces:**
- `pages.json`: array of `{url, label, kind}` in the spec's section 6 order (29 entries; the two insurance pages chosen during the build and the Salik and RTA tariff URLs confirmed by a free TinyFetch call each).
- `scripts/register-pages.mjs`: `node scripts/register-pages.mjs --base <url> --token <admin token> [--limit 20]` reads `pages.json`, POSTs each to `/api/pages` in order, stops after `limit` successes, prints a table of `url | status | reason`, and writes `docs/registration-log.md` (the README's "tried and skipped" table comes from it). Reads the token from `ADMIN_TOKEN` env when `--token` is absent.
- `docs/runbook.md`, in order: enable R2 and token permissions (already done by Hamdan by then), `wrangler d1 create fineprint` and paste the id into `wrangler.jsonc`, `wrangler r2 bucket create fineprint`, `wrangler secret put` for the three secrets (`WEBHOOK_SECRET` made with `openssl rand -hex 24` or `node -e "console.log(crypto.randomUUID())"`), set `PUBLIC_BASE_URL` to the workers.dev URL, `npm run migrate:remote`, `npm run deploy`, **webhook rehearsal** (spec section 9: PATCH spike monitor `e92c04d7-9243-4abe-b7fa-09a769c5a9c7` with `schedule_cron "*/10 * * * *"` and the real webhook URL, set status active, wait for one scheduled payload, copy it from R2 `raw/` into `tests/fixtures/webhooks/unchanged.json`, re-run the webhook tests, then set status paused), then `node scripts/register-pages.mjs --base <url> --limit 20`, then check `/api/stats` shows 20 pages and 20 complete captures within 10 minutes.

- [ ] **Step 1: Write the failing test**

```ts
// tests/pages-json.test.ts
it("pages.json has at least 20 unique https urls with valid kinds and labels", async () => {});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/pages-json.test.ts`
Expected: FAIL (file missing)

- [ ] **Step 3: Write `pages.json`, the register script, the runbook, the README skeleton and the CI workflow**

- [ ] **Step 4: Run the full check**

Run: `npm run check`
Expected: typecheck clean, all test files pass, `wrangler deploy --dry-run` prints the bindings

- [ ] **Step 5: Commit**

```bash
git add pages.json scripts docs/runbook.md README.md .github tests/pages-json.test.ts
git commit -m "feat: curated page list, registration script, deploy runbook and CI"
```

---

## After Task 12

Stop. Do not deploy, do not create the D1 database or R2 bucket, and do not push, until the Cloudflare account is ready and the GitHub repo exists. Then follow `docs/runbook.md` exactly, record the registration log, and report `/api/stats` output plus the first real webhook payload's shape.

## Self-review notes

- Spec coverage: 4.1 (Task 6), 4.2 and 4.3 (Task 7), 4.4 (Task 8), 4.5 and 4.6 (Task 4), 4.7 to 4.9 (Task 9), discover/replay/rotate (Task 10), 4.10 viewer (separate plan, by design), 5 (Task 1), 6 (Task 12), 7 (Tasks 6, 7, 8), 8 (every task; fixtures in Tasks 4 and 7), 9 day-1 rehearsal (Task 12 runbook).
- Names used across tasks: `fetchPage`, `createMonitor`, `updateMonitor`, `setMonitorStatus`, `deleteMonitor`, `listMonitors`, `screenshotFullPage`, `startFactsRun`, `getRun`, `parseFacts`, `discoverFinePrint`, `cronForIndex`, `PURPOSE`, `normalize`, `hashText`, `structuredDiff`, `factsDiff`, `versionAsOf`, `insertRun`, `captureVersion`, `recordFactsResult`, `runCron`, `recordSpend`. Each is defined once, in the task that lists it under Produces.
