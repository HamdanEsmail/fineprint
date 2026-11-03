# Fineprint build log

What changed from the plan (`docs/plans/2026-11-03-fineprint-recorder.md`) while building it, why, and every live TinyFish call made during the build with its cost.

## Order of work

- 3 Nov: deploy was cleared early and the order changed: Tasks 1 to 8, then the deploy parts of Task 12 (`pages.json`, `scripts/register-pages.mjs`, `docs/runbook.md`), then deploy, webhook rehearsal and registration of 20 pages, then Tasks 9, 10, 11 and the rest of Task 12, redeploying after each.
- Commits go to `main` and are pushed after each task.

## Deviations from the plan

| # | Plan said | We did | Why |
|---|---|---|---|
| D1 | `@cloudflare/vitest-pool-workers` with `defineWorkersConfig` | `@cloudflare/vitest-plugin` 1.5.0 with `cloudflareTest()` in `vitest.config.ts` | The pool package was renamed; the old name is deprecated and frozen at 0.23.0 (vitest 4 only, older runtime). The renamed package supports vitest 5 and bundles a runtime newer than our compatibility date. Same tool, current name. `defineWorkersConfig` no longer exists in either. |
| D2 | `fetchMock` from `cloudflare:test` | `tests/helpers/fetch-mock.ts`, a small interceptor on `globalThis.fetch` that throws on any unmatched request | `fetchMock` was removed from the Workers Vitest integration. Unmatched requests throw, so tests can never reach TinyFish. |
| D3 | `@types/diff` dev dependency | not installed | `diff` 9 ships its own types; `@types/diff` 8 is a deprecated stub. |
| D4 | `pages.json` with 29 entries | 30 entries | Spec section 6 lists items 1 to 28 plus two insurance pages. |
| D5 | Live browser test reads the key from `.dev.vars` when present | runs only with `FINEPRINT_LIVE=1` | `.dev.vars` always exists on the build machine, so the plan's rule would spend money on every `npm run check`. |

## Choices where the plan left room

- Test bindings are fixed test values (`TINYFISH_API_KEY=test-tinyfish-key`, `ADMIN_TOKEN=test-admin`, `WEBHOOK_SECRET=test-secret`, `PUBLIC_BASE_URL=https://fineprint.test`), and a test asserts the real key never reaches unit tests.
- Tests that depend on `waitUntil` work call the Worker in-process through `tests/helpers/app.ts`, which awaits the execution context before asserting.
- `fetchMock` interception was checked with a throwaway route (removed again): a fetch made inside a request handler is intercepted when the handler is called through `callWorker` (yes) and through `SELF.fetch` (yes), both for a fetch awaited in the handler and one scheduled with `waitUntil`; an unmatched fetch inside a handler throws, Hono answers 500, and the call is recorded. `callWorker` is still the one to use when a test asserts on `waitUntil` side effects, because `SELF.fetch` does not wait for them.
- Test storage (D1 and R2) is isolated per test file, not per test. Tests that need a clean database run `await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);` (from `cloudflare:test`) in `beforeEach`; this was checked to clear both D1 rows and R2 objects.
- Typecheck runs on TypeScript 7.0.2 (the native port) with no pin to 6.x needed; it resolves the Workers and plugin types. One `tsconfig.json` covers `src`, `tests` and `vitest.config.ts`. `tests/env.d.ts` augments `Cloudflare.Env` with `TEST_MIGRATIONS`, so that binding exists only in the test environment and not in `src/env.ts`.
- Tests import `env` from `cloudflare:workers` and `SELF` plus the execution-context helpers from `cloudflare:test`. The plugin marks `env` and `SELF` in `cloudflare:test` as deprecated in favour of `cloudflare:workers` (`env`, `exports.default.fetch()`); `SELF` is kept because the plan uses it.
- `callWorker` accepts a bare path such as `/api/stats` and resolves it against `https://fineprint.test`.
- The CI workflow `.github/workflows/check.yml` (push and pull_request, Node 24, `npm ci`, `npm run check`) is created in Task 1; Task 12 only verifies it.
- Beyond the smoke test, Task 1 adds `tests/fetch-mock.test.ts` (the helper's own tests) and `tests/spend.test.ts` (prices and `recordSpend`). The smoke test also asserts the four fixed test bindings, so a real key from `.dev.vars` can never leak into tests; the assertion was checked to fail without the explicit binding.
- npm 11 prints an `allow-scripts` warning for the `esbuild` and `workerd` postinstall scripts. They are not needed (the platform binaries come from optional dependencies) and tests, typecheck and `wrangler deploy --dry-run` all work, so no `allowScripts` entry was added.
- Noise rules (spec 4.3 scope rule): metadata markers (`last updated`, `updated on`, `updated:`, `published`, `effective date`, `page generated`, `as of`) drop a line only when what follows the marker is a date or time stamp, so "As of 1 December 2026 the checked bag fee is $35" is kept. Relative-time lines are dropped whole. Copyright lines are dropped only when they start with "©", "(c)" or "copyright", contain a year (19xx or 20xx) and are at most 200 characters, so "Copyright and trademark complaints: send notices to legal@x.com" and "© Vercel" stay. Cookie banner phrases ("we use cookies", "accept all cookies", "cookie settings") drop the line only when it is at most 300 characters, so a privacy-policy paragraph that says "we use cookies" stays; the length caps exist because many watched pages are privacy and terms policies. Share counters are a number followed by "share(s)"; viewer counters are "N people viewing". Every rule has a suppressed fixture and a near-miss fixture.
- Spend ledger (spec 4.9 "every TinyFish call appends a spend row"): Fetch and Search calls write $0 rows; Monitor creation writes one `monitor_check` $0.005 row for the baseline check; screenshot session creation writes $0.002; Agent steps are written when a run finishes. Monitor update, pause, delete and list write nothing.
- The CDP WebSocket upgrade to TinyBrowser's `cdp_url` is a plain `fetch` outside `client.ts` (no API key, 101 response). The session-creation POST goes through `client.ts`.
- The change gate normalizes both the incoming text and the latest version's stored text with the page's current ignore patterns (spec 4.3), so editing ignore patterns never creates a false version.
- A `changed` run with fetch errors or empty text is stored with `noise_reason "fetch_error"` but is not counted as suppressed noise.
- `captureVersion` checks the spend pause first (no attempt used), skips captures already done, and never starts a second Agent run for a version that already has one.
- The repair cron only retries versions in `pending` or `partial`; versions in `awaiting_facts` are handled only by the facts follow-up.
- Public URLs: `/shots/<version id>.jpg` reads R2 `shots/<version id>.jpg`; `/sources/<version id>.html` reads R2 `html/<version id>.html`.
- Diff with `from` later than `to` returns 400 `invalid_range`.
- Discover's 10 per IP per day limit applies to public callers only.
- Replay walks only `changed` runs that have a raw payload, in `received_at` order from the baseline; versions it creates are `pending` with `capture_error "replayed"`, and their runs are un-marked as noise.
- Normalization details: a metadata line is dropped when what follows the marker is made only of date and time parts (month names, years, numeric and ISO dates, clock times, weekdays, time zones, "on/at/of/the", "today"/"yesterday") with at least one real date or time part, optionally followed by "by" and up to four name words. A bare day number or a URL is not a stamp. "Updated" without a colon or "on" is not a marker, because the spec lists only "updated on" and "updated:".
- Normalization details: "copyright" must be a whole word at line start (so "Copyrighted material..." stays); the caps (200 characters for copyright, 300 for cookie banner phrases) are measured on the trimmed line with whitespace collapsed, and "skip to content" has no cap. Relative time is exactly the plan's `\b\d+ (seconds?|minutes?|hours?|days?) ago\b` anywhere in a line, so "an hour ago" and "3 weeks ago" are not caught. Markdown markers (`# * _ > - + | ~` and backticks) are ignored in front of a line and around a share counter.
- Normalization details: tracking parameter names match case-insensitively and exactly (`utm_` prefix, `ref` only, so `reference` and `ref_src` stay). The link is rebuilt from its own pieces without re-encoding, and sentence punctuation after a URL is kept. A tracking parameter on a line that is dropped anyway is not listed separately. `suppressed` keeps repeats (the same parameter on ten links appears ten times); the webhook handler decides how much of it to store.
- Normalization details: an `ignore_patterns` entry that is not a string, is blank, or matches the empty string (such as `x*`) is skipped like an invalid regex, because it would match every line and wipe the page.
- Normalization tests load fixtures with `import.meta.glob(..., { query: "?raw" })` because the Workers pool has no filesystem; `tests/env.d.ts` references `vite/client` for the types. A test checks that every rule has both a suppressed and a near-miss fixture.

## Live TinyFish calls during the build

| When (UTC) | Call | Why | Cost |
|---|---|---|---|

Total so far: $0.00
