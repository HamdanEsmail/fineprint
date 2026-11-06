# Fineprint

Fineprint keeps the version history of pricing pages, terms of service, privacy policies, visa rules and fee tables. It watches each page with TinyFish Monitor. When a page really changes, it stores the text, a full-page screenshot and the HTML source, so you can ask what a page said on a given date and what changed between two dates.

Live: https://fineprint.hamdanesmail12-7a9.workers.dev (one Cloudflare Worker with D1 and R2; the JSON API answers at `/api/stats`).

## Status

The Worker is deployed. Recording of the curated pages has not started: the list is `pages.json` (30 candidates in priority order), and the first 20 that pass validation are registered by the steps in [docs/runbook.md](docs/runbook.md). Pages that cannot be read are skipped with their reason in `docs/registration-log.md`, which the registration script writes.

## How it works

- **Monitor is the only trigger.** Fineprint never polls a page on its own schedule. Delete the Monitors and no new version is ever created.
- **Two checks before a version exists.** TinyFish says a page changed; Fineprint then normalizes the old and new text (timestamps, "last updated" lines, cookie banners, tracking parameters) and creates a version only if something real differs. Suppressed noise is counted.
- **A page that rendered only in part is not a change.** If a new read is much shorter than the last version and only loses content (nothing new appears), Fineprint treats it as a half-loaded page: it records no version, marks the run as suppressed (`partial_render`) and reads the page again within the hour. If the second read agrees, the version is created, with a note naming the suspect read; if it does not, nothing was lost.
- **A page that flips back is not a change either.** A text that is identical, after normalization, to a version recorded in the last 72 hours is suppressed (`flap`): a page alternating between two renderings gets no new version each time.
- **Facts are labelled honestly.** Each version has a `facts_status`: `ok` (plans and prices stored), `pending` (still being extracted), `unavailable` (extraction failed or found no price table, after its attempts) or `not_needed` (not a pricing or fee page, or a change judged not relevant). A version whose screenshot and source are stored is `complete` whatever happens to its facts; `failed` is only for a screenshot or source that could not be stored. `/api/stats` counts the versions with `facts_unavailable`.
- **A page can be retired.** `POST /api/admin/pages/:id/retire` (admin) deletes the page's Monitor and sets its status to `retired`. Its versions, runs and stored files stay and it still appears in the list, the export and the history, but it is no longer checked, pulled or repaired, and its Monitor slot is free again.
- **Every version is kept with evidence:** the extracted text, a full-page screenshot, the HTML source, TinyFish's summary of the change, and, for pricing and fee pages, the plans and prices as structured facts.
- **Any page can be added at run time** with `POST /api/pages`. The URL is validated first, so a page that cannot be fetched is refused with a reason instead of failing silently later.

Monitor webhooks are the primary trigger. When a scheduled check is overdue (no run 15 minutes after its scheduled time), the hourly job asks TinyFish to run that Monitor now and records the result under TinyFish's run id, marked `pull`. Fineprint never fetches a page to detect changes itself.

## How TinyFish is used

| Product | What Fineprint uses it for | Where in the code |
|---|---|---|
| Monitor | The only trigger. One Monitor per page, on a staggered twice-daily schedule. Its webhooks create the runs and the versions. | `src/tinyfish/monitor.ts`, `src/handlers/webhooks.ts` |
| Fetch | Validates a URL before a Monitor is created, and stores each version's HTML source. | `src/tinyfish/fetch.ts` |
| Browser | Full-page screenshot of every version, over raw Chrome DevTools Protocol from the Worker. | `src/tinyfish/browser.ts` |
| Agent | Extracts plan, fee and price facts for pricing and fee pages, one run at a time. | `src/tinyfish/agent.ts`, `src/capture.ts` |
| Search | Finds a site's pricing, terms, privacy and fee pages by domain. Planned: the client exists, the `/api/discover` endpoint does not yet. | `src/tinyfish/search.ts` |

## API

Read endpoints are public JSON. Endpoints marked admin need `Authorization: Bearer <ADMIN_TOKEN>`. Status is what exists in the code today.

| Method | Path | Returns | Status |
|---|---|---|---|
| GET | `/api/pages` | All pages with latest version time, version count and noise count | built |
| GET | `/api/pages/:id` | One page and its version list (no text) | built |
| POST | `/api/pages` | Add a page. Without the admin token: 4 public slots, 1 add per visitor per day, removed after 7 days | built |
| PATCH | `/api/pages/:id` | Admin: label, kind, ignore patterns, schedule, purpose, promote to curated | built |
| DELETE | `/api/pages/:id` | Admin: deletes the Monitor, keeps the history | built |
| GET | `/api/stats` | Counts of pages, runs, versions, noise suppressed, and spend (more fields in progress) | built, being extended |
| GET | `/shots/:name`, `/sources/:name` | The stored screenshot and HTML source of a version | built |
| GET | `/api/pages/:id/versions/:vid` | One version: text, facts, screenshot and source URLs, judgment | in progress |
| GET | `/api/pages/:id/as-of?at=ISO` | The version in force at that time | in progress |
| GET | `/api/pages/:id/diff?from=ISO&to=ISO` | Structured diff: added, removed and changed blocks, and facts | in progress |
| GET | `/api/changes?since=ISO&limit=` | Feed of real versions across all pages, newest first | in progress |
| GET | `/api/export.json` | Everything except raw text bodies, with absolute screenshot and source URLs | in progress |
| POST | `/api/discover` | `{domain}`: find that site's pricing, terms, privacy and fee pages | planned |
| POST | `/api/pages/:id/replay` | Admin: re-run the noise gate over stored webhook payloads | planned |
| POST | `/api/admin/rotate-webhook` | Admin: re-point every Monitor at the current host | planned |
| POST | `/api/admin/pull/:pageId` | Admin: run the page's Monitor now and record the run, marked `pull` (what the hourly job does for an overdue check) | built |

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

Follow [docs/runbook.md](docs/runbook.md). It covers the D1 database, the R2 bucket, the three secrets, the first deploy, the webhook rehearsal and registering the pages.

## Design

The full design is in [docs/specs/2026-11-03-fineprint-design.md](docs/specs/2026-11-03-fineprint-design.md). What changed while building it is in [docs/build-log.md](docs/build-log.md).

## License

MIT. See [LICENSE](LICENSE).
