# Fineprint

Fineprint keeps the version history of pricing pages, terms of service, privacy policies, visa rules and fee tables. It watches each page with TinyFish Monitor. When a page really changes, it stores the text, a full-page screenshot and the HTML source, so you can ask what a page said on a given date and what changed between two dates.

Live: https://fineprint.hamdanesmail12-7a9.workers.dev: the site (the change feed, each page's history with as-of and compare, the watchlist and About) and the JSON API (`/api/stats`), from one Cloudflare Worker with D1 and R2. The site has been on since 7 Nov 2026.

## Status

Recording since 3 November 2026: 20 curated pages on 20 TinyFish Monitors (the list and the pages that were skipped, with their reasons, are in [docs/registration-log.md](docs/registration-log.md)). Every endpoint in the table below is built and deployed.

## How it works

- **Every version comes from a TinyFish Monitor run.** Fineprint never reads a page itself to find a change. A scheduled run arrives by webhook; when a scheduled run is overdue (none 15 minutes after its time), the hourly job asks TinyFish to run that Monitor now (run-now) and records the result under TinyFish's run id. Each version says which way its run came in `trigger`: `create` (the baseline taken when the page was added), `webhook` or `pull`. Delete the Monitors and no new version is ever created.
- **Pulls back off.** After 3 failed pulls of a page in a row (no text, a fetch error, or run-now failing), the hourly job pulls it at most once every 6 hours, until a pull returns text or a webhook arrives. A pulled check is put on the spend ledger as soon as run-now returns text, once per run id.
- **Two checks before a version exists.** TinyFish says a page changed; Fineprint then normalizes the old and new text (timestamps, "last updated" lines, cookie banners, tracking parameters) and creates a version only if something real differs. Suppressed noise is counted.
- **A page that rendered only in part is not a change.** If a new read is much shorter than the last version and only loses content (nothing new appears), Fineprint treats it as a half-loaded page: it records no version, marks the run as suppressed (`partial_render`) and reads the page again within the hour. If the second read agrees, the version is created, with a note naming the suspect read; if it does not, nothing was lost.
- **A page that flips back is not a change either.** A text that is identical, after normalization, to a version recorded in the last 72 hours is suppressed (`flap`): a page alternating between two renderings gets no new version each time.
- **Every change has a one-line summary.** `summary` is TinyFish's own summary of the change when the run carried one (`summary_source: "tinyfish"`); otherwise Fineprint builds it from its own structured diff against the previous version (`summary_source: "diff"`), for example `3 blocks added, 1 changed: "Claude Code is now included in the Pro plan"`. A pulled check never carries TinyFish's summary, so its summary always comes from the diff. Baselines have none.
- **Facts are labelled honestly.** Each version has a `facts_status`: `ok` (plans and prices stored), `pending` (still being extracted), `unavailable` (the extraction found no price table, which is final after one run, or failed on every attempt) or `not_needed` (not a pricing or fee page, or a change judged not relevant). A version whose screenshot and source are stored is `complete` whatever happens to its facts; `failed` is only for a screenshot or source that could not be stored. `/api/stats` counts the versions with `facts_unavailable`.
- **A page can be retired.** `POST /api/admin/pages/:id/retire` (admin) deletes the page's Monitor and sets its status to `retired`. Its versions, runs and stored files stay and it still appears in the list, the export and the history, but it is no longer checked, pulled or repaired, and its Monitor slot is free again.
- **Every version is kept with evidence:** the extracted text, a full-page screenshot, the HTML source, its summary, and, for pricing and fee pages, the plans and prices as structured facts.
- **Any page can be added at run time** with `POST /api/pages` (a URL of at most 2,048 characters). The URL is validated first, so a page that cannot be fetched is refused with a reason instead of failing silently later.
- **Open to other sites.** The JSON API and the stored screenshots and sources answer any origin (CORS). The stored sources are served sandboxed: their scripts never run on Fineprint's origin.

## How TinyFish is used

| Product | What Fineprint uses it for | Where in the code |
|---|---|---|
| Monitor | Every version comes from a Monitor run. One Monitor per page, on a staggered twice-daily schedule; its webhook delivers each run, and run-now pulls a run that is overdue. | `src/tinyfish/monitor.ts`, `src/handlers/webhooks.ts`, `src/handlers/admin.ts` |
| Fetch | Validates a URL before a Monitor is created, and stores each version's HTML source. | `src/tinyfish/fetch.ts` |
| Browser | Full-page screenshot of every version, over raw Chrome DevTools Protocol from the Worker. | `src/tinyfish/browser.ts` |
| Agent | Extracts plan, fee and price facts for pricing and fee pages, one run at a time. | `src/tinyfish/agent.ts`, `src/capture.ts` |
| Search | Finds a site's pricing, terms, privacy and fee pages by domain (`POST /api/discover`). | `src/tinyfish/search.ts`, `src/handlers/discover.ts` |

## API

Read endpoints are public JSON. Endpoints marked admin need `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/pages` | All pages with latest version time, version count and noise count |
| GET | `/api/pages/:id` | One page, its versions (no text) and its newest 100 runs |
| GET | `/api/pages/:id/versions/:vid` | One version with its text and live URL |
| GET | `/api/pages/:id/as-of?at=ISO` | The version in force at that time |
| GET | `/api/pages/:id/diff?from=ISO&to=ISO` | Structured diff: added, removed and changed blocks, facts, the latest hop's summary |
| GET | `/api/changes?since=ISO&limit=` | Feed of real changes across all pages, newest first, each with its summary |
| GET | `/api/export.json` | Everything except the page texts, with absolute screenshot and source URLs |
| GET | `/api/stats` | Counts of pages, runs by trigger, versions, noise by reason, spend by kind, monitor health, the two spend pauses |
| GET | `/shots/:name`, `/sources/:name` | The stored screenshot and HTML source of a version |
| POST | `/api/pages` | Add a page. Without the admin token: 4 public slots, 1 add per visitor per day, removed after 7 days |
| POST | `/api/discover` | `{domain}`: find that site's pricing, terms, privacy and fee pages |
| PATCH | `/api/pages/:id` | Admin: label, kind, ignore patterns, schedule, purpose, promote to curated |
| DELETE | `/api/pages/:id` | Admin: deletes the Monitor, keeps the history |
| POST | `/api/admin/pages/:id/retire` | Admin: deletes the Monitor, marks the page `retired`, keeps the history |
| POST | `/api/admin/pull/:pageId` | Admin: run the page's Monitor now and record the run, marked `pull` (what the hourly job does for an overdue check) |
| POST | `/api/pages/:id/replay` | Admin: run the change gate again over the stored raw runs; `?would_now_be=1` also judges runs that already have a version |
| POST | `/api/admin/rotate-webhook` | Admin: re-point every live Monitor at `{base_url}` |
| POST | `/api/admin/backfill-summaries` | Admin: fill missing summaries, `{filled, remaining}`; call until `remaining` is 0 |

Every version has the same fields wherever it appears (`/api/pages/:id`, the export, versions/:vid and as-of, which add `text` and `live_url`): `id`, `page_id`, `captured_at`, `is_baseline`, `summary`, `summary_source`, `judgment_summary` (TinyFish's text as it came), `facts`, `screenshot_url`, `source_url`, `capture_status`, `facts_status`, `trigger` and `notes` (why a version exists when it is not the plain result of one read: a confirmed suspect read, or a replay).

TinyFish calls `POST /hooks/monitor/<secret>` on every scheduled run. That path is not part of the public API.

## Run locally

Needs Node 24 or later.

```bash
npm install
cp .dev.vars.example .dev.vars    # then fill in TINYFISH_API_KEY, ADMIN_TOKEN, WEBHOOK_SECRET
npm run migrate:local
npm run dev
```

```bash
npm test          # unit tests, no network: every TinyFish call is mocked
npm run check     # typecheck, tests, and wrangler deploy --dry-run (what CI runs)
```

Tests never call TinyFish. Adding a page under `npm run dev` does: it creates a real Monitor on the TinyFish account the key belongs to.

## Deploy

Follow [docs/runbook.md](docs/runbook.md). It covers the D1 database, the R2 bucket, the three secrets, the first deploy, the webhook rehearsal, registering the pages, and updating the live Worker (migrations first, then the deploy).

## Design

The full design is in [docs/specs/2026-11-03-fineprint-design.md](docs/specs/2026-11-03-fineprint-design.md). What changed while building it is in [docs/build-log.md](docs/build-log.md).

## License

MIT. See [LICENSE](LICENSE).
