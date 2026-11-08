# Fineprint submission sheet

Everything that goes into the TinyFish Time Machine bounty dashboard. Entries close on 17 Nov 2026. The repository has been public since 8 Nov 2026.

Figures below are `/api/stats` on 8 Nov 2026, 16:47 UTC, unless a line gives another time.

## Paste into the dashboard

| Field | Value |
|---|---|
| Project | Fineprint |
| Repository | https://github.com/HamdanEsmail/fineprint |
| Live site | https://fineprint.hamdanesmail12-7a9.workers.dev |
| Demo video | [DEMO LINK: paste after upload] |
| X post | [X POST LINK: paste after posting] |
| LinkedIn post | [LINKEDIN POST LINK: paste after posting] |

**Description**

> Fineprint is a dated record of the web's small print: it watches pricing pages, fees, terms, privacy policies and travel rules, and keeps every real change with its date, text, full-page screenshot and HTML source. Each page has its own TinyFish Monitor and every version comes from a Monitor run; noise is filtered out first, and each change is shown as a structured diff, block by block under the page's own headings, with the changed words marked. Anyone can ask what a page said on a given day, compare any two dates, follow the live change feed, add a page of their own for seven days, or read everything through an open JSON API.

## How each requirement is met

| Requirement | Where to see it | `/api/stats` field | On 8 Nov 2026, 16:47 UTC |
|---|---|---|---|
| TinyFish Monitor on at least 20 changing pages, doing the core work | [The watchlist](https://fineprint.hamdanesmail12-7a9.workers.dev/watchlist): every page with its own Monitor and its twice-daily schedule; [About](https://fineprint.hamdanesmail12-7a9.workers.dev/about#tinyfish): "If every Monitor were deleted, nothing new would ever be recorded." | `monitors.active`; `runs_by_trigger` | 21 active (20 curated, 1 public); 225 runs: 21 baselines, 193 by webhook, 11 pulled when a scheduled run was overdue |
| A stored screenshot for every change | [The featured comparison](https://fineprint.hamdanesmail12-7a9.workers.dev/pages/d53d1b28-3480-42e1-a498-8224025dd840/compare?from=d0f38678-44d9-45e2-b411-96efa1efb646&to=100dbf11-07db-483c-9f00-54d1b7471ed5), with both screenshots; any version's screenshot at `/shots/<version id>.jpg` | `versions_with_screenshot` against `versions` (also `versions_with_source`, `thumbnails`) | 42 of 42 versions, each with its HTML source and thumbnail too |
| As-of lookup | [Claude release notes as of 3 Nov 2026, 21:16 UTC](https://fineprint.hamdanesmail12-7a9.workers.dev/pages/233d04d4-77e6-4ebc-bc5f-15fecc07296a?at=2026-11-03T21%3A16%3A17.282Z) (the home's example) and the same question as JSON: [`/api/pages/:id/as-of?at=`](https://fineprint.hamdanesmail12-7a9.workers.dev/api/pages/233d04d4-77e6-4ebc-bc5f-15fecc07296a/as-of?at=2026-11-03T21:16:17.282Z) | No counter of its own; it answers from the stored `versions` | 42 versions to answer from |
| Structured diff | [The largest comparison](https://fineprint.hamdanesmail12-7a9.workers.dev/pages/233d04d4-77e6-4ebc-bc5f-15fecc07296a/compare?to=3a8d2ae1-b51b-4e69-8a64-edadc7278281): 23 changed blocks under the page's own headings, with word marks; as JSON: [`/api/pages/:id/diff?from=&to=`](https://fineprint.hamdanesmail12-7a9.workers.dev/api/pages/233d04d4-77e6-4ebc-bc5f-15fecc07296a/diff?from=2026-11-04T02:14:08.143Z&to=2026-11-05T14:14:07.927Z) | `changes`, `layout_only`, `noise_suppressed`, `noise_by_reason` | 13 real changes, 4 labelled layout-only, 8 noise events filtered (2 the same after cleaning, 6 flaps) |
| Live at least 3 days before submission, with logs of real changes | [`/api/stats`](https://fineprint.hamdanesmail12-7a9.workers.dev/api/stats); [the registration log](https://github.com/HamdanEsmail/fineprint/blob/main/docs/registration-log.md); [the change feed](https://fineprint.hamdanesmail12-7a9.workers.dev/#feed) and [`/api/changes`](https://fineprint.hamdanesmail12-7a9.workers.dev/api/changes); each page's check log | `recording_since`; `runs` | Recording since 3 Nov 2026, 14:17 UTC. The 20 curated pages were registered between 16:17 and 16:26 UTC that day, so three days were met on 6 Nov 2026, 16:26 UTC |
| Works for any page you add | [The watchlist's form](https://fineprint.hamdanesmail12-7a9.workers.dev/watchlist#add) and `POST /api/pages`; a page that cannot be read is refused with the reason | `public_slots` | 1 of 4 public slots used: Stripe pricing, added through the site on 7 Nov 2026, 14:19 UTC, watched until 14 Nov 2026, 14:20 UTC |
| Reusable output | [`/api/export.json`](https://fineprint.hamdanesmail12-7a9.workers.dev/api/export.json) and the endpoints on [About](https://fineprint.hamdanesmail12-7a9.workers.dev/about#data); open to any origin (CORS) | None | The export holds every page and every version, with absolute screenshot and source URLs |

When Stripe pricing expires on 14 Nov 2026 at 14:20 UTC, `monitors.active` reads 20 (the curated pages) unless another page has been added; the floor of 20 holds either way.

## TinyFish endpoints

Fineprint uses five TinyFish services. Spend is `spend_by_kind` in US dollars.

| Service | Its job in Fineprint | Spend |
|---|---|---|
| Monitor | Every version comes from a Monitor run. One Monitor per page, on a staggered twice-daily schedule; its webhook delivers each run, and run-now pulls a run that is overdue. | `monitor_check` 1.125 |
| Fetch | Validates a URL before a Monitor is created, and stores each version's HTML source. | `fetch` 0 |
| Browser | Full-page screenshot of every version, and a thumbnail of the top of the page in the same browser connection, over raw Chrome DevTools Protocol from the Worker. | `screenshot` 0.094 |
| Agent | Extracts plan, fee and price facts for curated pricing and fee pages, one run at a time. | `agent_step` 2.608 |
| Search | Finds a site's pricing, terms, privacy and fee pages by domain (`POST /api/discover` and the watchlist's search). | `search` 0 |
| | | `spend_usd` 3.827 |

None of the five is padding: each does a job nothing else in Fineprint does. Without Monitor no version would exist, without Fetch no URL would be checked before it is watched and no HTML source kept, without Browser no change would have its screenshot, without Agent no pricing page would have its price table, and without Search no one could find a site's small print by its domain.

## The reviewer's three clicks

1. [The home](https://fineprint.hamdanesmail12-7a9.workers.dev/): the change feed, the latest catch up close, and the TinyFish Time Machine bounty's requirements with live proof.
2. [Claude release notes](https://fineprint.hamdanesmail12-7a9.workers.dev/pages/233d04d4-77e6-4ebc-bc5f-15fecc07296a), the page with the most versions (6 on 8 Nov 2026): its timeline, the as-of picker that shows what the page said at any moment, each version with its screenshot, and the check log of its runs.
3. [Its largest compare](https://fineprint.hamdanesmail12-7a9.workers.dev/pages/233d04d4-77e6-4ebc-bc5f-15fecc07296a/compare?to=3a8d2ae1-b51b-4e69-8a64-edadc7278281), 4 Nov 2026 02:14 UTC to 5 Nov 2026 14:14 UTC: 23 changed blocks under the page's own headings, with word marks and both screenshots.

## Read further

- [The design spec](https://github.com/HamdanEsmail/fineprint/blob/main/docs/specs/2026-11-03-fineprint-design.md)
- [The recorder and site plans](https://github.com/HamdanEsmail/fineprint/tree/main/docs/plans)
- [The build log](https://github.com/HamdanEsmail/fineprint/blob/main/docs/build-log.md): what changed while building, and every live TinyFish call made during the build with its cost
- [The deploy runbook](https://github.com/HamdanEsmail/fineprint/blob/main/docs/runbook.md)
- [The demo script](demo-script.md) and [the posts](posts.md)
