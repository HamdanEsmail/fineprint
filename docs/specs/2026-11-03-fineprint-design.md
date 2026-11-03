# Fineprint: design

*Working name. Submission for the TinyFish Student Bounty Drop 002 "Time Machine" bounty. Written 2026-11-03. Deadline 2026-11-17.*

## 1. Intent

Pricing pages, terms of service, privacy policies, visa rules, fee tables and insurance wording change quietly, and the old version is gone. Fineprint is a version-history recorder for exactly those pages. It watches a list of pages with TinyFish Monitor, stores every real version with a full-page screenshot and the HTML source, and lets anyone ask three questions through a JSON API and a viewer:

1. What did this page say, and look like, on date X?
2. What changed between date A and date B, as a structured diff (added, removed, changed), not a text dump?
3. What changed on the web this week? (a feed of real catches)

The judges weigh: Monitor depth (pages tracked, how often, how cleanly each change is captured), diff quality (real changes stand out, noise ignored), a queryable history with a stored screenshot for every change, the value of the pages, and reusability by other tools.

Approval criteria the build must meet, verbatim from the bounty: Monitor does the core work and removing it stops the build; diffs are structured; it works for any page you add; real changes were caught live with a stored screenshot for each; output is reusable (API or JSON export). It must run live for at least 3 days before submission, with logs of real changes. We target 10 or more days: the recorder goes live by the evening of 2026-11-05.

## 2. Goals, non-goals, anti-goals

**Goals**
- 20 real, genuinely useful pages tracked from day one by TinyFish Monitor, with room for pages judges add.
- Every real version has: captured time, the extracted text, a full-page screenshot, an HTML source snapshot, TinyFish's own judgment summary of the change, and, for pricing-style pages, extracted facts (plan name, price).
- As-of lookup, two-date structured diff, per-page timeline, site-wide change feed, full JSON export.
- Noise (dates, counters, tracking codes, cookie banners) never creates a version. Suppressed noise is counted and visible.
- Budget: about $5 of TinyFish wallet for the whole run. Hosting is free.
- A spend ledger in the app itself, so the README can show cost per catch.

**Non-goals**
- Crawling whole sites, following links, or tracking pages behind a login.
- Alerting users by email or push. The feed and API are the notification.
- History from before Fineprint started watching a page.
- Diffing screenshots pixel by pixel. Screenshots are evidence, text is the diff.

**Anti-goals (a build that does these fails even if it works)**
- Our own polling of pages. Monitor is the only trigger. If every Monitor is deleted, no versions are ever created.
- Simulated or hand-made changes. Every version comes from a scheduled Monitor run.
- Raw unified-diff text shown as "the diff".
- A version created by a timestamp or a rotating banner.
- A hardcoded page list that cannot be extended at runtime.
- Spending more than $8 total without Hamdan's explicit okay.

## 3. Constraints and verified facts

All of these were verified on 2026-11-03 with real calls (see `spikes/` in the parent folder) or in the TinyFish docs.

**TinyFish Monitor**
- `POST https://agent.tinyfish.ai/v1/monitors` with `type: "fetch"`, `config: {url, format: "markdown"}`, `schedule_cron` (5 fields, UTC), `name`, `purpose`, `webhook_url`. Creation runs a baseline immediately and returns it in the 201 body (`run.results[0].text`). That baseline is **not** sent to the webhook, so the add-page handler stores it directly.
- Webhooks fire on **every scheduled run**, including unchanged ones. Payload fields: `fetch_monitor_id`, `id`, `is_baseline`, `outcome` (`baseline` | `changed` | `unchanged`), `diff` (unified diff vs previous run, null unless changed), `diff_truncated`, `judgment` (`{purpose, is_relevant, summary, error}`, only when changed and a purpose is set), `results[]` (full page text every run), `errors[]`.
- Manual "run now" (`POST /v1/monitors/{id}/runs`) does **not** fire the webhook. Use it only for testing the baseline path, never to manufacture a version.
- There is no REST endpoint to list run history. History lives in TinyFish's dashboard only. Fineprint's database is therefore the only durable history, which is the point of the product.
- Webhook delivery is best-effort, retried 3 times, and carries no signature. The webhook URL contains a random secret path segment and the handler checks `fetch_monitor_id` against known monitors.
- Each completed check costs $0.005. Failed checks are free. Max 50 monitors per account.
- Monitor fetches with `ttl: 0` and cannot fill forms, so only pages with a stable public GET URL can be watched.
- **Verified by spike on 2026-11-03** (`../spikes/spike-monitor.mjs`, responses in `../spikes/out/monitor-*.json`): create returned 201 in 3.1 s with `{monitor: {id, name, type, config{url, format, links, image_links, ttl: 0}, schedule_cron, status, last_error, webhook_url, created_at, updated_at}, run: {id, is_baseline: true, results: [1], errors: []}}`; `run.results[0].text` was the full 13,696-character page, identical in length to a direct TinyFetch. The run object carries **no timestamp**, so `captured_at` is the Worker's receipt time (creation time for the baseline). `GET /v1/monitors/{id}` returns the monitor fields flat, not wrapped. Run-now returns `{run: {id, is_baseline: false, results, errors}}` with no `outcome`, `diff` or `judgment`; those appear only in scheduled webhook payloads. `PATCH /v1/monitors/{id}` is a union: either `{status: "active" | "paused"}` alone, or an edit object that **must include `schedule_cron`** and may include `name`, `purpose`, `webhook_url` (null clears it). `{webhook_url}` alone is a 400. The monitor list on this account was empty before the spike; one spike monitor (`e92c04d7-...`, paused) was kept for the day-1 webhook rehearsal.
- Not yet observed locally: a scheduled webhook payload. The documented shape is in the bullets above; day 1 opens by capturing a real one (section 9) before the 20 pages are registered, and the handler stores the raw payload first and parses tolerantly.

**TinySearch (discover-by-domain)**
- `GET https://api.search.tinyfish.ai?query=<text>&include_domains=<domain>&purpose=<why>` with the `X-API-Key` header; also `language`, `exclude_domains`, `recency_minutes`. Free, 12,000 requests per day. Returns ranked results with `url`, `title`, `snippet`. Discover runs four queries per domain (pricing, terms, privacy, fees) restricted to that domain and dedupes the URLs. Hamdan's FirstRole repo (`server/tinyfish.ts`) calls it the same way.

**TinyBrowser (screenshots)**
- `POST https://api.browser.tinyfish.ai` with `{url}` returns `{session_id, cdp_url, base_url}` in about 1.3 s. A Cloudflare Worker can open `cdp_url` as a WebSocket (fetch with `Upgrade: websocket`, then `.accept()`), drive the Chrome DevTools Protocol directly (`Target.getTargets`, `Target.attachToTarget {flatten: true}`, `Page.enable`, `Emulation.setDeviceMetricsOverride 1280x800`, `Page.navigate`, wait, `Page.getLayoutMetrics`, `Page.captureScreenshot {format: jpeg, quality: 80, captureBeyondViewport: true, clip up to 8000 px tall}`), then `Browser.close`. Verified under `wrangler dev`: a 540 KB full-page JPEG of vercel.com/pricing stored in R2 in 15 s. No Playwright, no Node APIs. Decode base64 with `fetch("data:image/jpeg;base64,...")`, not a JS loop, to keep CPU time tiny. Cost: $0.002 per browser-minute, so about $0.002 per screenshot. Always send `Browser.close` so billing stops. The spike Worker is in `../spikes/worker-shot/src/index.js`; port it, do not rediscover it.

**TinyFetch**
- `POST https://api.fetch.tinyfish.ai` with `{urls, format: "markdown" | "html" | "json", ttl: 0, include_etag_and_last_modified}`. Free within 1,000 URLs per day. Per-URL error codes include `login_required`, `bot_blocked`, `timeout`, `target_http_error`. `format: "json"` returns a tree of `heading` and `paragraph` nodes only (no tables), so it is useful for section-aware diffing but not for prices. `format: "html"` returns cleaned HTML (about 18 KB for the Vercel page).

**TinyAgent**
- `POST https://agent.tinyfish.ai/v1/automation/run-async` then poll `GET /v1/runs/{id}`, or pass `webhook_url` and get called back. `output_schema` is accepted on this account (verified). A 4-step capped run with a vague goal returned `{"plans": []}`, so extraction goals must be explicit: name the fields, say where on the page they are, say "return every plan". Cost $0.016 per step; cap at `max_steps: 6` ($0.10 max per run). The account allows 2 concurrent runs, shared with the other three bounty builds.

**Cloudflare free plan**
- Workers: 100k requests/day, **10 ms CPU per request**. Time waiting on TinyFish does not count. Design rule: handlers store and forward; expensive diffs are computed lazily on read and cached. If a real deployment trips the limit, Workers Paid is $5/month and the design does not change.
- D1 (SQLite): 5 GB, 100k row writes/day. R2: 10 GB. Cron Triggers available. Workflows available on free.
- **Account state on 2026-11-03** (checked with wrangler): logged in via a `CLOUDFLARE_API_TOKEN` environment variable. R2 is **not enabled** on the account (`code 10042`, must be enabled once in the dashboard; it asks for a payment method but the free allowance is not billed). The token **lacks D1 permission** (`Authentication error 10000` on `d1 list`). Both must be fixed by Hamdan before the first deploy; the design assumes they are. The webhook host for the whole run is the `workers.dev` URL of the deployed Worker; if it ever changes, every monitor is re-pointed with one PATCH each (schedule included), which is an admin endpoint, not a redesign.

**Monitor allocation across Hamdan's four bounty builds (50 per account)**
- Fineprint: 24 (20 curated + 4 public "try it" slots). TinyVerify: 10. Property Dossier: 10. Site to MCP: 2. Spare: 4. Fineprint must never create a 25th monitor.

## 4. Architecture

One Cloudflare Worker serves everything: the webhook receiver, the JSON API, the admin endpoints, and the React viewer as static assets. State lives in D1 (rows) and R2 (screenshots, HTML sources, raw webhook payloads). No Supabase, no other accounts. One `wrangler deploy`.

```
                       scheduled run (every 12 h, staggered)
   TinyFish Monitor  ---------------------------------------->  POST /hooks/monitor/<secret>
         ^                                                              |
         | create (baseline in 201)                                     v
   POST /api/pages  <-- Fetch validates URL first            runs table (every run)
         |                                                              | outcome = changed
         v                                                              v
   pages table                                         normalize -> compare to last version
                                                                        | real change
                                                                        v
                                                           versions table (text, judgment)
                                                                        | capture (durable)
                                            +---------------------------+---------------------------+
                                            v                           v                           v
                                   TinyBrowser CDP               TinyFetch html            TinyAgent (facts pages)
                                   full-page JPEG -> R2          source -> R2              facts JSON -> D1
                                                                        |
                       GET /api/pages/:id/as-of   GET .../diff   GET /api/changes   GET /api/export.json   viewer
```

### 4.1 Adding a page (`POST /api/pages`)

Input: `{url, label?, kind?, ignore_patterns?}`. `kind` is one of `pricing`, `fees`, `policy`, `rules`, `other`; it only controls whether facts extraction runs (`pricing` and `fees` do).

1. Reject if the account would exceed 24 Fineprint monitors, or the caller is public and the 4 public slots are full. Public callers (no admin token) are limited to 1 add per IP per day and may not delete. **Public pages expire after 7 days**: the hourly cron deletes their Monitor, keeps their history, labels the page "expired", and the slot frees. The add form says so up front ("Fineprint will watch this page twice a day for 7 days"). Admin can promote a public page to curated, which removes the expiry. This keeps "any page you add" true for every judge, not just the first four.
2. **TinyFetch validation** (free): fetch the URL with `format: "markdown", ttl: 0, include_etag_and_last_modified: true`. Any per-URL error (`login_required`, `bot_blocked`, `timeout`, `target_http_error`) rejects the add with that reason shown to the user. This is why "any page you add" works: unfetchable pages are refused clearly rather than silently failing later.
3. **Create the Monitor**: `type: "fetch"`, `config: {url, format: "markdown"}`, `name: label`, `schedule_cron` chosen by the stagger rule in 4.6, `purpose` from 4.5, `webhook_url: https://<host>/hooks/monitor/<WEBHOOK_SECRET>`.
4. Store the page row with `monitor_id`, and store the baseline version from the 201 response's `run.results[0].text` (outcome `baseline`).
5. Start the capture pipeline (4.4) for the baseline so every page has a day-zero screenshot and source.

### 4.2 Webhook receiver (`POST /hooks/monitor/:secret`)

Must respond 200 within a few seconds and do almost no CPU work.

1. Check the secret segment; look up the page by `fetch_monitor_id`; unknown monitor: 404, logged.
2. Store the raw payload in R2 (`raw/<run id>.json`) for fixtures and audit.
3. Insert a `runs` row: outcome, `is_baseline`, judgment fields, `diff_truncated`, `received_at`. Unchanged runs are heartbeat rows only; no text is stored for them.
4. If `outcome = changed`: run the two-stage gate (4.3). If it passes, insert a `versions` row and start capture (4.4). If it fails, mark the run `noise_suppressed = 1` with the reason.

### 4.3 The two-stage change gate (noise)

Stage one is TinyFish's: Monitor only says `changed` when the extracted markdown differs. Stage two is ours: normalize both the new text and the previous version's text, and only a non-empty difference after normalization creates a version.

Normalization, in order:
- Collapse whitespace; drop blank-line runs.
- Remove tracking query parameters from links (`utm_*`, `gclid`, `fbclid`, `ref`, `_ga`, and similar).
- Remove **metadata lines only**: whole lines that match "last updated", "updated on", "published", "effective date", "page generated", "as of", copyright lines, and relative times ("3 hours ago"). Dates that are content (a visa bulletin's cutoff dates, a deadline in a rule, a release note's date heading) are never stripped; they are exactly what a deadline change looks like. This is the scope rule: strip the line that merely says when the page was touched, keep every date the page is about.
- Remove lines matching a built-in noise list (cookie consent wording, "Skip to content", share counts, "x people viewing") and the page's own `ignore_patterns` (regex list, editable by admin).
- Keep every number. Prices, limits, fees and dates in content are the signal.
- Because raw payloads are kept in R2, a wrong rule is recoverable: an admin `POST /api/pages/:id/replay` re-runs the gate over stored raw payloads and creates the versions it should have created (screenshots for replayed versions are taken at replay time and marked as such).

Store the normalized text's hash on each version. The gate compares hashes, then falls back to a line diff only to produce the structured diff later. The suppressed count per page is shown in the UI and the stats endpoint ("Fineprint suppressed 37 noise events across 20 pages").

`judgment.is_relevant` from TinyFish is stored and shown, but it does **not** decide whether a version is created. It decides whether the facts extraction (Agent) runs and how the change is labelled in the feed.

### 4.4 Capture pipeline (durable)

For each new version, three captures, each recorded independently so a failure in one does not lose the others:

1. **Screenshot**: TinyBrowser raw CDP as verified in the spike, stored at `shots/<version id>.jpg` in R2. Store `screenshot_key` on the version.
2. **Source**: TinyFetch `format: "html"`, stored at `html/<version id>.html` in R2. Store `html_key`. Also store the live URL; "source link" in the viewer means both.
3. **Facts** (only `kind` in `pricing`, `fees`; on the baseline always, and on later versions only if `judgment.is_relevant` is not `false`): TinyAgent run with an explicit goal and `output_schema` `{items: [{name, price, unit, notes}]}`, `max_steps: 6`, `max_duration_seconds: 120`. Store `facts_json`. Use `webhook_url` on the run so the Worker is called back, or poll from the repair job; either is fine. Baselines need facts so the first diff of a pricing page can show "Pro: $20 to $25" rather than "facts unavailable".

`captured_at` on a version is the moment the Worker received the webhook (or created the Monitor, for the baseline). TinyFish's payload has no run timestamp and delivery can be retried, so the viewer shows `captured_at` as "recorded at" and the as-of rule uses it as is.

The webhook handler must not wait for these. Use a Cloudflare Workflow if it is straightforward; otherwise `ctx.waitUntil` plus the repair cron. Either way the **repair cron is mandatory**: every hour, find versions older than 10 minutes with a missing screenshot, source or facts, and retry (max 3 attempts, then mark `capture_failed` with the reason). The cron also calls `GET /v1/monitors` and flags any Fineprint monitor whose status is not `active`.

### 4.5 Monitor purpose text

Same for every page unless the admin overrides it:

> "A price, plan, limit, fee, rule, eligibility condition, deadline or policy term was added, removed or changed. Ignore timestamps, 'last updated' notes, cookie banners, layout and wording-only edits."

### 4.6 Schedule

Every page runs twice a day. Stagger so payloads do not land together and the feed looks alive: page *n* gets `schedule_cron = "<m> <h>,<h+12> * * *"` with `m = (n * 7) % 60` and `h = n % 12`. Admin can set a page to `0 */6 * * *` (four times a day) for pages known to move fast; the spend ledger shows the cost of doing so. Cost at the default: 24 pages x 2 x $0.005 = $0.24 per day.

### 4.7 Structured diff (`GET /api/pages/:id/diff?from=A&to=B`)

`from` and `to` are ISO timestamps; each resolves to the version in force at that time (as-of rule: latest version with `captured_at <= t`, baseline included; before the baseline: 404 with the baseline time in the body). Result:

```json
{
  "page": {"id": "...", "url": "...", "label": "..."},
  "from": {"version_id": "...", "captured_at": "...", "screenshot_url": "...", "source_url": "..."},
  "to":   {"version_id": "...", "captured_at": "...", "screenshot_url": "...", "source_url": "..."},
  "summary": "The Pro plan went from $20 to $25 per month.",
  "blocks": {
    "added":   [{"section": "Pro", "text": "..."}],
    "removed": [{"section": "Hobby", "text": "..."}],
    "changed": [{"section": "Pro", "before": "...", "after": "..."}]
  },
  "facts": {
    "added":   [{"name": "Ultra", "price": "$200", "unit": "month"}],
    "removed": [],
    "changed": [{"name": "Pro", "field": "price", "before": "$20", "after": "$25"}]
  },
  "hops": 3,
  "noise_suppressed_between": 5
}
```

`summary` is TinyFish's judgment of the latest hop, when present. Blocks come from splitting normalized markdown on headings and blank lines; a block's `section` is the nearest preceding heading. Changed blocks are matched by similarity (the algorithm is open; a line-diff library is fine). `facts` appears only when both versions have facts. Diffs are cached in `diff_cache` keyed by the two version ids, so the viewer never recomputes.

### 4.8 API surface (public, read-only, CORS on, JSON)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/pages` | all pages with latest version time, version count, noise count |
| GET | `/api/pages/:id` | page plus its version list (no text) |
| GET | `/api/pages/:id/versions/:vid` | one version: text, facts, screenshot and source URLs, judgment |
| GET | `/api/pages/:id/as-of?at=ISO` | the version in force at that time |
| GET | `/api/pages/:id/diff?from=ISO&to=ISO` | structured diff (4.7) |
| GET | `/api/changes?since=ISO&limit=` | feed of real versions across all pages, newest first |
| GET | `/api/export.json` | everything except raw text bodies, with absolute screenshot and source URLs |
| GET | `/api/stats` | pages, runs, versions, noise suppressed, spend ledger totals, monitor health |
| GET | `/shots/:key`, `/sources/:key` | the R2 objects, cached at the edge |
| POST | `/api/pages` | add (public capped, admin uncapped) |
| POST | `/api/discover` | `{domain}`: TinySearch finds that site's pricing, terms, privacy, fees pages |
| PATCH / DELETE | `/api/pages/:id` | admin only (label, kind, ignore_patterns, schedule, purpose, promote; delete also deletes the Monitor). Schedule and purpose edits go to TinyFish as one PATCH that always includes `schedule_cron` |
| POST | `/api/pages/:id/replay` | admin only: re-run the noise gate over stored raw payloads (4.3) |
| POST | `/api/admin/rotate-webhook` | admin only: re-point every Fineprint monitor at the current host |

Admin is a single bearer token in a Worker secret. The TinyFish key never reaches the client.

### 4.9 Spend ledger

Every TinyFish call appends a `spend` row: `kind` (`monitor_check`, `screenshot`, `fetch`, `agent_step`, `search`), `amount_usd`, `ref`. Monitor checks are counted from webhook arrivals at $0.005. Screenshots at $0.002. Agent at $0.016 x `num_of_steps`. Fetch and Search at $0. `/api/stats` and the viewer footer show the total and cost per real catch.

### 4.10 Viewer (behavior only; visual world decided in the mockup round)

- **Home**: the change feed. Each real catch is a card: page label, when, TinyFish's summary, screenshot thumbnail, "compare" link. Sidebar: pages watched, versions captured, noise suppressed, spend so far.
- **Page**: a timeline of versions with a screenshot per version. Pick any date to see the as-of version. Pick two to see the structured diff with the two screenshots side by side.
- **Watchlist**: all pages with status, schedule, last check, last change; "add a page" with the discover-by-domain helper; public adds show the remaining slots.
- **About**: how TinyFish Monitor, Fetch, Browser, Agent and Search are used, with the architecture diagram, written for the judges.

Judges must be able to add a page and see it validated, baselined and screenshotted within a minute.

## 5. Data model (D1)

```
pages      id, url, label, kind, monitor_id, schedule_cron, purpose, status (active|paused|failed),
           added_by (curated|public|admin), ignore_patterns (json), created_at, last_run_at, last_change_at
runs       id, page_id, monitor_run_id, outcome, is_baseline, judgment_relevant, judgment_summary,
           diff_truncated, noise_suppressed, noise_reason, raw_key, received_at
versions   id, page_id, run_id, captured_at, text, normalized_hash, judgment_summary,
           screenshot_key, html_key, facts_json, capture_status, capture_error
diff_cache from_version_id, to_version_id, json, created_at
spend      id, kind, amount_usd, ref, at
```

`versions.text` stays in D1 (markdown, usually under 100 KB). HTML and screenshots go to R2.

## 6. Initial page list

Twenty curated pages must be live by 2026-11-05 evening. Candidates below are grouped by how likely they are to change inside the window; the implementation validates each with TinyFetch at registration and takes the first that pass, in order, until 20 are live. Pages that fail validation (bot-blocked, login) are logged in the README's "tried and skipped" table, which is itself evidence of honest coverage. Hamdan may swap any of these.

**Likely to change within days (high catch probability, genuinely useful)**
1. https://help.openai.com/en/articles/6825453-chatgpt-release-notes (rules)
2. https://docs.claude.com/en/release-notes/overview (other)
3. https://developers.cloudflare.com/workers/platform/pricing/ (pricing)
4. https://www.gov.uk/guidance/visa-decision-waiting-times-applications-outside-the-uk (rules)
5. https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html (rules)
6. https://www.ryanair.com/gb/en/useful-info/help-centre/fees (fees)
7. https://www.emirates.com/ae/english/before-you-fly/baggage/ (rules)
8. https://www.salik.ae/en (fees, Dubai tolls; find the tariff page)

**Pricing pages (plausible change, high value)**
9. https://openai.com/api/pricing/ (pricing)
10. https://www.anthropic.com/pricing (pricing)
11. https://ai.google.dev/gemini-api/docs/pricing (pricing)
12. https://vercel.com/pricing (pricing)
13. https://cursor.com/pricing (pricing)
14. https://www.notion.com/pricing (pricing)
15. https://supabase.com/pricing (pricing)
16. https://github.com/pricing (pricing)
17. https://help.netflix.com/en/node/24926 (pricing, plans)
18. https://www.spotify.com/ae/premium/ (pricing, UAE)

**Policies, terms, visa rules, insurance (rare change, highest value when it happens)**
19. https://openai.com/policies/terms-of-use/ (policy)
20. https://openai.com/policies/privacy-policy/ (policy)
21. https://x.com/en/tos (policy)
22. https://www.facebook.com/privacy/policy/ (policy)
23. https://www.anthropic.com/legal/aup (policy)
24. https://developer.apple.com/app-store/review/guidelines/ (rules)
25. https://u.ae/en/information-and-services/visa-and-emirates-id/do-you-need-an-entry-permit-or-a-visa-to-enter-the-uae (rules, UAE)
26. https://home-affairs.ec.europa.eu/policies/schengen-borders-and-visa/visa-policy_en (rules)
27. https://www.dewa.gov.ae/en/consumer/billing/slab-tariff (fees, Dubai utilities)
28. https://www.rta.ae/wps/portal/rta/ae/public-transport/nol-cards/nol-card-fares (fees, Dubai transport; confirm the URL)
29. Two insurance coverage pages (to be proposed, e.g. a travel insurance policy-wording page and the Dubai Health Authority essential benefits plan page), validated the same way.

Kinds drive facts extraction only for `pricing` and `fees`.

## 7. Security and safety

- TinyFish key and admin token are Worker secrets. Nothing secret in the client bundle.
- Webhook path secret; `fetch_monitor_id` must match a known page.
- Public add: 4 slots, 1 per IP per day, URL must pass TinyFetch validation, no private hosts.
- Hard caps: 24 monitors, `max_steps: 6` on every Agent run, one screenshot per version, retries capped at 3. A `spend` total above $8 pauses captures and sets a visible warning; checks continue.
- Delete a page: delete its Monitor (`DELETE /v1/monitors/{id}`), keep its history.

## 8. Testing

- Unit tests for: normalization (every noise rule has a fixture that must be suppressed and a near-miss that must not be), the as-of rule, the structured diff (added, removed, changed, section attribution), the public-slot and per-IP caps, the webhook secret check.
- Fixtures are real: the spike outputs in `../spikes/out/` seed them, and the first real webhook payloads (stored in R2 as `raw/*.json`) are copied into `tests/fixtures/`. Tests never call TinyFish.
- One opt-in integration test that, with a key present, adds a page, receives the baseline, takes a screenshot and deletes the Monitor.
- `npm run check` runs typecheck, tests and build. GitHub Actions runs it on every push.

## 9. Delivery order

1. **Day 1 (2026-11-04):** Worker, D1 schema, R2, add-page with TinyFetch validation and Monitor creation, webhook receiver, noise gate, screenshot and source capture, spend ledger, repair cron. Deploy. **Webhook rehearsal before registering anything**: re-point the kept spike monitor (`e92c04d7-...`) at the deployed webhook with a tight schedule (`*/10 * * * *`), resume it, wait for one real scheduled payload, store it as `tests/fixtures/webhook-unchanged.json`, confirm the handler parsed it, then pause the spike monitor again. Only then register the 20 pages. The clock starts.
2. **Day 2 (2026-11-05):** JSON API complete (as-of, diff, feed, export, stats), facts extraction for pricing pages, discover-by-domain, tests and CI. Verify the first scheduled webhooks arrive and land correctly.
3. **Later (after the mockup round):** the viewer. Then README with architecture, the "how TinyFish is used" section, the catches log, a demo GIF, and the X/LinkedIn post drafts.

## 10. Left open

- Router (Hono is suggested) and project layout; React structure; the diff library.
- Workflow vs `waitUntil` plus repair cron for captures (repair cron is required either way).
- Exact regexes in the noise list, as long as each has a test.
- How to wait for page load in CDP (a fixed 5 to 6 s wait is acceptable; `Page.loadEventFired` plus a short settle is better).
- The two insurance pages and the exact Salik and RTA tariff URLs.
- Names of tables and endpoints may change if the shape above is preserved.

## 11. Repository conventions (shared across the four bounty repos)

TypeScript, ESM, exact version pins, `npm run check`, `.dev.vars.example` with every secret named, MIT license, `docs/` with this design and the plan, `artifacts/` for screenshots and the demo GIF, a README that opens with what it does, the live URL, and a "How TinyFish is used" table. Private on GitHub until submission day, then public.
