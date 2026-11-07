# Fineprint Site Implementation Plan

Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Fineprint its public face: four server-rendered screens (change feed, page history with as-of and compare, watchlist with add-a-page, about) in the Stamped Ledger world, on the same Worker that records, without disturbing the recorder.

**Architecture:** The existing Hono Worker renders HTML with `hono/jsx`. Site routes call the same read functions as the JSON API, so the site and the API can never disagree. Styles, fonts and one small optional script are static files served by Workers Static Assets. Every screen works with JavaScript off: selection, as-of, compare, add and discover are plain links and forms. Previews go up with `wrangler versions upload`, which gives a URL on the real data without replacing the deployed recorder.

**Tech Stack:** TypeScript (ESM, strict), Hono 4 with `hono/jsx`, Cloudflare Workers + D1 + R2 + Static Assets, `diff` (already a dependency) for word-level marks, Vitest in the existing workers pool. No client framework, no bundler, no new runtime dependency. Fonts self-hosted as woff2.

**Spec:** `docs/specs/2026-11-03-fineprint-design.md` section 4.10 (behaviour) and sections 4.7 to 4.9 (data); `DESIGN.md` (the look, copied in Task 1 from `../family/fineprint/DESIGN.md`); `design/PRINCIPLES.md` (shared craft rules, copied from `../family/PRINCIPLES.md`). This plan amends one line of the spec: section 4 says "the React viewer as static assets"; the viewer is server-rendered `hono/jsx` instead (a choice made for one toolchain, real HTML for readers and link previews, nothing to break the JSON 404 contract).

## Starts when

Task 15 of the recorder work is committed on `main` and deployed (it changes `src/index.ts`, `src/handlers/*`, `package.json` and adds `summary_source`; this plan builds on those). One writer at a time on this repo.

## Global Constraints

- **Design authority.** `DESIGN.md` and `public/assets/tokens.css` are fixed. Never change a token value, add a second accent, or add a dark mode. Components beyond the tokens go in `public/assets/site.css` and use only token variables for colour, type, radius, border and shadow.
- **The comp.** `design/comp-home.html` (copied in Task 1 from `../family/fineprint/comp-home.html`, built from live data on 6 Nov and shown to Hamdan) is the reference for the home screen: layout, spacing, type sizes and the treatment of every component on it. The other screens extend the same treatment. Its inline CSS is the starting point for `site.css`. Its Google Fonts link is for the comp only; the site self-hosts.
- **Show and explain.** A first-time visitor must understand what Fineprint is and see one real change, before and after, without leaving the home screen. Every screen leads with the thing itself (the change, the page, the difference) and explains it in one plain sentence.
- **Bans (verbatim from PRINCIPLES 7 to 9):** "No gradients, no blur, no glow, no glassmorphism, no illustration packs, no decorative icons." Three faces at most; tabular numerals on every figure; reading measure 60 to 72 characters; no text under 11.5px. Motion 150 to 240 ms, ease-out, one property; `prefers-reduced-motion` turns it all off.
- **Every record ends with an evidence line**, in this exact shape: `Source: <link host+path> · read 5 Nov 2026, 09:12 UTC · Monitor (webhook)`. The method is `Monitor (baseline)`, `Monitor (webhook)` or `Monitor (pulled)`, from the version's `trigger`.
- **Dates in UI:** `5 Nov 2026, 09:12 UTC` (always UTC, no relative times). In data and URLs: ISO 8601.
- **Copy:** plain sentences that say what happened and when; no exclamation marks, no emoji. The exact strings in the "Honest states" table below are part of the contract; tests assert them.
- **No JavaScript required.** `public/assets/enhance.js` may only add comfort (a `<dialog>` lightbox over the screenshot link, copy buttons on About). No inline `<script>`.
- **Static assets:** `wrangler.jsonc` gets exactly `"assets": { "directory": "./public" }` and `"preview_urls": true`. No `run_worker_first`, no `not_found_handling`, and no `.html` file anywhere under `public/`. A request that matches no file reaches the Worker as before.
- **The site is behind a switch.** `vars.SITE_ENABLED` is `"0"` in `wrangler.jsonc` until Task 8. With it off, every site route answers exactly as the Worker does today, so recorder deploys from `main` never publish an unapproved screen. Previews upload with `--var SITE_ENABLED:1`; the test environment sets it to `"1"`.
- **Recorder safety.** The webhook handler's work does not grow: no diff, no thumbnail, no extra query on the `/hooks/*` path. JSON responses change only by the additions named in Tasks 1 and 2; every existing test keeps passing without edits to its assertions.
- **One read function per shape.** The JSON handler and the site route for the same data call the same function in `src/readModel.ts`. No second SQL for the same answer.
- **Security headers on every HTML response:** `content-security-policy: default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`. All recorded text, summaries, labels and URLs are escaped by JSX; nothing from a watched page is ever emitted as markup. No request to any third-party host from any screen.
- **Same-origin paths in HTML.** The site links screenshots, thumbnails and stored sources by path (`/shots/<id>.jpg`, `/thumbs/<id>.jpg`, `/sources/<id>.html`), never by the absolute `PUBLIC_BASE_URL` form the JSON carries. A preview lives on another hostname, and `img-src 'self'` would block absolute production URLs there.
- **Budget.** `FACTS_PAUSE_USD = 6` and `SPEND_PAUSE_USD = 8` stay as they are (Hamdan's decision, 6 Nov). Public adds never start a facts run. Live calls cleared for this plan: additive migrations, `wrangler versions upload`, one thumbnail trial ($0.002), the thumbnail backfill (about $0.01), one public test add in Task 7 (about $0.08 over its 7 days). Anything else that costs wallet money: ask Hamdan first.
- **Deploy rule.** Previews: `wrangler versions upload --var SITE_ENABLED:1 --message "<what>"`. `wrangler deploy` or `wrangler versions deploy` only on Hamdan's go-ahead (Task 8), with the remote prefix from the runbook.
- **Commits:** Hamdan is the sole author. Stage files by path. `npm run check` passes at the end of every task.
- **Design pass.** UI work in Tasks 1 and 3 to 7 follows `DESIGN.md` as fixed (refine, never replace the world). Feed, page, compare and watchlist are Operate surfaces; About is a Read surface. Look at the rendered result at 375px and 1280px before calling a screen done.

### Honest states (exact copy)

| Situation | Copy |
|---|---|
| Facts not read yet | `Reading prices…` |
| Facts could not be read | `Price table unavailable for this version.` |
| Facts paused by the budget | `Price tables are paused at the budget line. Changes are still recorded.` |
| Screenshot not taken yet | `Taking the screenshot…` |
| Screenshot failed | `Screenshot unavailable.` followed by links `Stored source` (when there is one) and `Live page` |
| Suspect read waiting (page has `pending_hash`) | `A suspect read is waiting for a second check. Nothing is recorded until two reads agree.` |
| Retired page | chip `Retired`, line `No longer watched. Its history is kept.` |
| Expired public page | chip `Expired`, line `Watched for 7 days as a public page. Its history is kept.` |
| As-of before the baseline | `Fineprint started watching this page on {time}. There is no earlier record.` |
| As-of date unreadable | `That is not a date Fineprint can read. Use the picker, or a time like 2026-11-05T09:12.` |
| Layout-only change | tag `Layout only`, line `Same words and figures, different structure.` |
| Retired pages have changes | under the feed: `{n} page was retired for unreliable reads. Its history is kept.` (plural: `{n} pages were retired for unreliable reads. Their history is kept.`), linking to `/watchlist#retired` |
| No changes yet | `No changes recorded yet. {n} pages are checked twice a day.` |
| Spend pause reached | banner `Spending is paused at the budget line. Changes the Monitors report are still recorded, without screenshots or price tables.`; the stamp keeps reading `RECORDING` while any Monitor is active |
| No Monitor active | stamp reads `PAUSED` (it follows the Monitors, not the spend) |
| Unknown page, version or route | title `No such page in the ledger.` with a link home, status 404 |

## Review Focus

1. A version whose screenshot failed or is still pending must never render a broken image: the card shows the copy above and the live link. Test in Task 3.
2. Text from a watched page that contains markup (`<script>alert(1)</script>`, `[x](javascript:alert(1))`) must appear as text or be dropped, in the feed, the version card and the diff. Test in Tasks 1 and 4.
3. `GET /api/pages/nope` must still answer JSON 404 and `POST /hooks/monitor/wrong-secret` must still reach the webhook handler after the assets block lands; neither may return HTML or a 405. Test in Task 1.
4. An as-of time before the baseline, in the future, or unparseable must render the page with the honest message, never a 500. Test in Task 3.
5. A retired or expired page must show its whole history with the chip and line above, and must not offer "add" or imply it is still watched. Test in Task 3 and Task 5.
6. The largest real diff (Claude release notes, about 50 blocks, 100 KB of text) must render within the block cap and stay under the CPU budget. Test in Task 4, measurement in Task 7.
7. A public visitor's add that is refused (slots full, daily limit, login-walled or bot-blocked page) must come back as the watchlist screen with the reason beside the form and the typed URL kept, and no Monitor created. Test in Task 5.

---

## File Structure

```
fineprint/
  DESIGN.md  PRODUCT.md  design/PRINCIPLES.md      design authority (Task 1)
  public/robots.txt  public/favicon.svg
  public/assets/tokens.css                        copied unchanged from ../family/fineprint/tokens.css
  public/assets/site.css                          layout and components built on the tokens
  public/assets/enhance.js                        optional lightbox and copy buttons
  public/assets/fonts/*.woff2  LICENSES.md        Fraunces, Inter, JetBrains Mono (latin, variable, OFL)
  migrations/0007_site_fields.sql                 versions.delta_json, versions.thumb_key (additive)
  src/readModel.ts                                one function per public JSON shape
  src/thumbs.ts                                   thumbnailFromScreenshot
  src/site/router.tsx                             GET /, /pages/:id, /pages/:id/compare, /watchlist, /about; POST /watchlist; 404
  src/site/layout.tsx                             Document, Header (wordmark + stamp), Footer (spend meter)
  src/site/components.tsx                         EvidenceLine, Stamp, StatusChip, Thumb, StatBlock, DeltaBadge, FactsTable, Notice
  src/site/format.ts                              pure text formatters
  src/site/blockText.tsx                          safe rendering of one recorded markdown block
  src/site/wordDiff.ts                            word-level marks for a changed block
  src/site/views/home.tsx  page.tsx  compare.tsx  watchlist.tsx  about.tsx  notFound.tsx
  tests/site-routing.test.ts  site-format.test.ts  site-home.test.ts  site-fields.test.ts
  tests/site-page.test.ts  site-compare.test.tsx  site-watchlist.test.ts  site-about.test.ts
```

`PRODUCT.md` (create with exactly this content; it is the product record the design pass reads):

```markdown
# Product

Fineprint is a public version history for the pages people sign up under: pricing, fees, terms, privacy policies, visa and baggage rules. It records each real change with a screenshot and shows what was true on any date.

## Platform
web

## Stack
Cloudflare Worker (Hono), server-rendered HTML with hono/jsx, D1, R2. No client framework.

## Users
- Judges of the TinyFish Time Machine bounty, on a laptop, with a few minutes: they want proof that real changes were caught, a diff they can read, and to add a page of their own.
- Developers who want the JSON API or the export.
- Readers arriving from a post on X or LinkedIn, mostly on a phone.

## Product Purpose
Answer three questions: what did this page say on date X, what changed between A and B, what changed this week.

## Positioning
A notary's ledger for the web's small print. Evidence first: every claim sits beside the screenshot, the source and the read time.

## Operating Context
Read-mostly. Twenty curated pages checked twice a day by TinyFish Monitor; four public slots that expire after seven days. Runs on a small fixed budget, shown in the footer.

## Capabilities and Constraints
- Records only from the moment a page is added. No earlier history.
- Text is the diff; screenshots are evidence.
- Works without JavaScript. Phone first.

## Brand Commitments
The Stamped Ledger world in DESIGN.md is fixed: paper, ink, one oxblood accent used like a stamp. No dark mode. No gradients, blur, glow, illustration packs or decorative icons.

## Evidence on Hand
Live data at the production URL: recorded changes with screenshots across 20 pages, a noise count by reason, and a spend ledger.

## Product Principles
See design/PRINCIPLES.md: evidence line, screenshot beside the claim, honest states, spend meter, restraint, plain copy.

## Accessibility & Inclusion
WCAG AA contrast (7:1 for body text), visible focus, labelled controls, alt text naming source and time, reduced motion respected, no text under 11.5px.
```

---

### Task 1: Shell, static assets and the home feed (ends at the look gate)

**Files:**
- Create: `DESIGN.md`, `PRODUCT.md`, `design/PRINCIPLES.md`, `public/**` (all but `enhance.js`), `src/readModel.ts`, `src/site/router.tsx`, `src/site/layout.tsx`, `src/site/components.tsx`, `src/site/format.ts`, `src/site/views/home.tsx`, `src/site/views/notFound.tsx`
- Modify: `wrangler.jsonc` (assets, preview_urls, `SITE_ENABLED: "0"`), `vitest.config.ts` (`SITE_ENABLED: "1"` in the test bindings), `src/env.ts`, `tsconfig.json` (`"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`), `src/index.ts` (mount `siteRouter` last; `notFound` answers JSON for `/api/*` and `/hooks/*`, the HTML 404 otherwise), `src/handlers/history.ts` (changes and stats call `readModel`)
- Test: `tests/site-routing.test.ts`, `tests/site-format.test.ts`, `tests/site-home.test.ts`

**Interfaces:**
- Consumes: the existing D1 repositories and the `/api/changes` and `/api/stats` logic in `src/handlers/history.ts`.
- Produces:
  - `listChanges(env: Env, opts: { since?: string; before?: string; limit: number; includeRetired?: boolean }): Promise<ChangeItem[]>` and `getStats(env: Env): Promise<Stats>` in `src/readModel.ts`, returning what the two JSON endpoints return today plus two additions: `Stats` gains `changes` (the number of versions that are not baselines, on pages that are not retired) and `/api/changes` gains `before=<ISO>` (strictly older than) and `retired=0` (leave out retired pages; without it they stay in, so today's output does not change). `ChangeItem` and `Stats` are exported types.
  - `siteRouter: Hono<{ Bindings: Env }>`.
  - `Layout(props: { title: string; description: string; stats: Stats; current: "home" | "watchlist" | "about" | null; children: Child })`.
  - `EvidenceLine(props: { url: string; readAt: string; trigger: "create" | "webhook" | "pull" })`, `Stamp(props: { text: string; live?: boolean })`, `StatusChip(props: { status: PageStatus })`, `Thumb(props: { src: string | null; href: string; alt: string })`, `StatBlock(props: { figure: string; label: string; isKey?: boolean })`, `Notice(props: { children: Child })`.
  - In `src/site/format.ts`: `formatUtc(iso: string): string`, `formatUsd(n: number): string`, `plural(n: number, one: string, many?: string): string`, `heroLine(changes7d: number): string`, `spendMeter(s: Stats): string`, `sourceLabel(url: string): string`, `triggerLabel(t: "create" | "webhook" | "pull"): string`, `stampFor(s: Stats): { text: "RECORDING" | "PAUSED"; live: boolean }`.

**Screen: home (`GET /`, optional `before=<ISO>`).** As in the comp. Hero line from live data, with the count in the accent. Under it the lede, exactly: `Fineprint watches the pages you agree to without reading: prices, fees, terms, visa rules. Every time one of them changes, it keeps a dated record with a screenshot, so you can see what was true on any day.` Then the three steps as one ruled row (not cards), exactly: `Watch` / `TinyFish Monitor reads each of {n} pages twice a day.`, `Catch` / `A real difference becomes a dated version with a screenshot. Noise is filtered out.`, `Compare` / `Pick any two dates and see exactly which words changed.` Then the section `Every change, newest first`: a feed of the 20 newest changes as catch cards (DESIGN "Catch card"): thumbnail linking to the compare view, mono accent label row (time, kind), page label as title linking to the page view, summary clamped to two lines, evidence line. An "Older changes" link when there are more. The feed, the hero count and the stat blocks leave out retired pages (`includeRetired: false`): a page retired for unreliable reads is not news. Its record is not hidden: the retired line from the honest-states table sits under the feed whenever a retired page has changes. Stat column (DESIGN "Stat blocks"): pages watched (`monitors.active`), real changes (`changes`, the one accent block), checks run (`runs_by_trigger.webhook + runs_by_trigger.pull`), noise suppressed. Below 900px the column becomes a 2 by 2 grid under the hero. Header on every screen: wordmark, stamp, nav (Changes, Watchlist, About). Footer on every screen: the spend meter, links to `/api/export.json` and `/about`.

- [ ] **Step 1: Write the failing routing-safety test** (`tests/site-routing.test.ts`), seeding with the existing helpers:

```ts
it("leaves the API and the hooks alone", async () => {
  const api = await SELF.fetch("https://x/api/pages/nope");
  expect(api.status).toBe(404);
  expect(api.headers.get("content-type")).toContain("application/json");
  const hook = await SELF.fetch("https://x/hooks/monitor/wrong-secret", { method: "POST", body: "{}" });
  expect(hook.status).not.toBe(405);
  expect(hook.headers.get("content-type") ?? "").not.toContain("text/html");
});
it("serves the stylesheet as a static file and unknown routes as the ledger 404", async () => {
  const css = await SELF.fetch("https://x/assets/tokens.css");
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("text/css");
  const miss = await SELF.fetch("https://x/no/such/screen");
  expect(miss.status).toBe(404);
  expect(await miss.text()).toContain("No such page in the ledger.");
});
it("sends the security headers on HTML", async () => {
  const home = await SELF.fetch("https://x/");
  expect(home.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(home.headers.get("x-content-type-options")).toBe("nosniff");
});
it("answers as before when the site is switched off", async () => {
  // same app, env with SITE_ENABLED "0": GET / and GET /watchlist give exactly the status and body they give on main today
});
```

- [ ] **Step 2: Write the failing format test** (`tests/site-format.test.ts`):

```ts
expect(formatUtc("2026-11-05T09:12:44.120Z")).toBe("5 Nov 2026, 09:12 UTC");
expect(formatUsd(3.1)).toBe("$3.10");
expect(heroLine(0)).toBe("Nothing changed this week.");
expect(heroLine(1)).toBe("The web changed its mind once this week.");
expect(heroLine(14)).toBe("The web changed its mind 14 times this week.");
expect(spendMeter({ spend_usd: 3.1, changes: 15, cost_per_catch_usd: 0.206667 } as Stats))
  .toBe("TinyFish spend $3.10 · 15 real changes · $0.21 per catch");
expect(spendMeter({ spend_usd: 0.3, changes: 0, cost_per_catch_usd: null } as Stats))
  .toBe("TinyFish spend $0.30 · 0 real changes");
expect(sourceLabel("https://docs.claude.com/en/release-notes/overview?utm=1")).toBe("docs.claude.com/en/release-notes/overview");
expect(triggerLabel("pull")).toBe("Monitor (pulled)");
expect(stampFor({ monitors: { active: 20 }, spend_paused: false } as Stats)).toEqual({ text: "RECORDING", live: true });
expect(stampFor({ monitors: { active: 20 }, spend_paused: true } as Stats)).toEqual({ text: "PAUSED", live: false });
```

`sourceLabel` drops the scheme, the query and a trailing slash, and cuts at 48 characters with an ellipsis.

- [ ] **Step 3: Write the failing home test** (`tests/site-home.test.ts`): seed two pages, a baseline each and two later versions (one with a summary containing `<script>alert(1)</script>`).

```ts
const html = await (await SELF.fetch("https://x/")).text();
expect(html).toContain("The web changed its mind 2 times this week.");
expect(html).toContain("RECORDING");
expect(html).toContain("Fineprint watches the pages you agree to without reading");
for (const step of ["Watch", "Catch", "Compare"]) expect(html).toContain(step);
expect(html).toContain("Every change, newest first");
// with a third page seeded as retired, holding one change:
expect(html).not.toContain(retiredPageLabel);
expect(html).toContain("1 page was retired for unreliable reads. Its history is kept.");
expect(html).toContain("The web changed its mind 2 times this week.");   // the retired page's change is not counted
expect(html).not.toContain("<script>alert(1)</script>");
expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
expect(html).toMatch(/Source: <a[^>]+>example\.com\/pricing<\/a> · read \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC · Monitor \(webhook\)/);
expect(html).toContain("TinyFish spend $");
expect(html).not.toMatch(/<img[^>]+src="https?:/);          // images by path, so they load on a preview host too
// with no later versions seeded:
expect(emptyHtml).toContain("No changes recorded yet. 2 pages are checked twice a day.");
// paging: with 21 changes seeded, the first screen links to /?before=<captured_at of card 20> and that screen shows the 21st
```

- [ ] **Step 4: Run the three files; expect failures** (`npx vitest run tests/site-routing.test.ts tests/site-format.test.ts tests/site-home.test.ts`).
- [ ] **Step 5: Amend the spec and copy the design files.** Copy `../family/fineprint/comp-home.html` to `design/comp-home.html`. In `docs/specs/2026-11-03-fineprint-design.md` section 4, change "and the React viewer as static assets" to "and the server-rendered viewer (hono/jsx), with its styles and fonts as static assets". `../family/fineprint/DESIGN.md` to `DESIGN.md`, `../family/PRINCIPLES.md` to `design/PRINCIPLES.md`, `../family/fineprint/tokens.css` to `public/assets/tokens.css` (unchanged), and write `PRODUCT.md` from the block above. Fonts: fetch `@fontsource-variable/fraunces`, `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` with npm into a folder outside the repo (they do not go into `package.json`), copy only their latin variable woff2 files (Fraunces roman and italic) into `public/assets/fonts/`, commit the files, and declare them with `@font-face` and `font-display: swap` in `site.css`. Preload Fraunces roman and Inter only. `LICENSES.md` carries the three OFL notices.
- [ ] **Step 6: Extract `listChanges` and `getStats` into `src/readModel.ts`** and make the two JSON routes call them. Run the existing history tests: they pass unchanged.
- [ ] **Step 7: Implement the assets config, the router, `Layout`, the components, `format.ts`, the home view and the 404.** The hero count is `listChanges({ since: now - 7 days, limit: 500 }).length`. The "Older changes" link is `/?before={captured_at of the last card}`. Thumbnails use `screenshot_url` for now (Task 3 switches them to `thumb_url`), with `loading="lazy"`, fixed width and height, and alt text `Screenshot of {label} as recorded {time}`.
- [ ] **Step 8: Run `npm run check`; expect pass.**
- [ ] **Step 9: Look at it.** `wrangler dev` with a local D1 loaded from the production export, at 375px and 1280px. Local R2 has no screenshots: put a handful of real ones in with `wrangler r2 object put --local`, or judge the images on the preview in Step 11. Fix what one look shows before the next.
- [ ] **Step 10: Commit.**

```bash
git add docs/plans/2026-11-06-fineprint-site.md docs/specs/2026-11-03-fineprint-design.md DESIGN.md PRODUCT.md design public wrangler.jsonc tsconfig.json vitest.config.ts src/env.ts src/index.ts src/readModel.ts src/handlers/history.ts src/site tests/site-routing.test.ts tests/site-format.test.ts tests/site-home.test.ts
git commit -m "feat: site shell, static assets and the change feed"
```

- [ ] **Step 11: Upload a preview and stop for the look gate.** `wrangler versions upload --var SITE_ENABLED:1 --message "site preview: shell and feed"`; confirm it prints a preview URL and that the deployed recorder is untouched (`/api/stats` on the production URL still answers, the next scheduled webhook is recorded). Send Hamdan the preview URL. **Tasks 3 to 7 wait for his go on the look. Task 2 has no visual part: carry on with it while waiting.**

### Task 2: What the site needs from the recorder

**Files:**
- Create: `migrations/0007_site_fields.sql`, `src/thumbs.ts`, `tests/site-fields.test.ts`
- Modify: `src/readModel.ts`, `src/handlers/history.ts`, `src/handlers/pages.ts`, `src/handlers/objects.ts`, `src/handlers/admin.ts`, `src/capture.ts` (or wherever Task 15 computes the diff-derived summary), `src/cron.ts`, `src/db/versions.ts`, `src/db/types.ts`

**Interfaces:**
- Consumes: `structuredDiff` and `factsDiff` from `src/core/diff.ts`; the step Task 15 added that builds a summary from the diff; `screenshotFullPage` and its CDP driver in `src/tinyfish/browser.ts`.
- Produces (all additive):
  - `Delta = { blocks: { added: number; removed: number; changed: number }; facts: { added: number; removed: number; changed: number } | null; layout_only: boolean }`. Every non-baseline version carries `delta: Delta | null` in `/api/changes`, `/api/pages/:id`, the version endpoint and the export (`null` until computed).
  - `thumb_url: string | null` beside every `screenshot_url`; `GET /thumbs/:name` serves `thumbs/<version id>.jpg` from R2 with the same headers as `/shots`.
  - `ChangeItem` gains `kind` (the page's kind).
  - `Stats` gains `recording_since` (earliest page `created_at`) and `public_slots: { total: number; used: number; next_free_at: string | null }`.
  - `screenshotFullPage` takes a second capture in the same session and returns both images: `{ full: ArrayBuffer; thumb: ArrayBuffer }`.
  - `thumbnailFromScreenshot(env: Env, versionIds: string[]): Promise<number>` in `src/thumbs.ts` (backfill only: one browser session for the whole list, returns how many it made).
  - `POST /api/admin/thumbs?limit=<n>` (admin; default 10, max 20): makes thumbnails for versions that have a screenshot and no thumb, in one browser session; returns `{ made, remaining }`.
  - `isLayoutOnly(diff: StructuredDiff): boolean` in `src/core/diff.ts` (ruling, 7 Nov): true when all hold, on the structured diff of the normalized texts: at least 20 blocks touched (added plus removed), block skew `|added − removed| / (added + removed)` at least 0.4, the same set of price tokens on both sides of the changed region, and a word overlap of at least 0.85 over the changed region only: the removed blocks plus the before side of the changed blocks, against the added blocks plus the after side of the changed blocks (same word regex, multiset overlap). A pure addition scores 0. A changed region over 40,000 characters is not labelled and no word is counted. Re-validated on 7 Nov against all 15 recorded changes: it marks GitHub pricing 5 Nov 14:38 (region overlap 0.925) and OpenAI privacy policy 3 Nov 18:06 (0.878), and no other. Number tokens on the changed region would miss the privacy policy (its restructure moved dates), so the tokens are prices. It is a label and never suppresses: the version, its screenshot, its summary and its diff stay. Stored in `delta.layout_only`; `Stats` gains `layout_only` (the count) and `changes` no longer counts them.
  - Hold rule in the gate (`src/core/gate.ts`), next to partial render: a changed read whose normalized length is under 95% of the latest version's AND that removes at least 20 blocks AND whose added blocks are at most 5% of the removed ones creates no version yet; the run is suppressed with the reason `layout_hold` and the page is marked for a confirm read exactly as for `partial_render` (same pending fields, same 24-hour window, a version only when two consecutive reads agree).
  - Diff-built summaries quote the first added or changed line that is longer than 30 characters after cleaning (a heading or a bare date is skipped); when there is none, the counts stand alone. Existing diff summaries are rebuilt once.
  - A layout-only version never starts a facts run when the label is known before the facts decision without adding work to the webhook path; otherwise facts behave as today (a choice for the implementation; say which in the report).
  - Public adds: a page added without the admin token is stored with a kind that never triggers facts (`needsFacts` is false for `added_by: "public"`), whatever kind was sent.

**Delta.** Computed in the same out-of-band step that builds the diff-derived summary (never in the webhook handler), from the structured diff against the previous version of the page; stored as `versions.delta_json`. The hourly cron backfills versions where it is missing, a few per tick, each in its own invocation like the pulls.

**Thumbnail.** A 640 by 400 JPEG, quality 70, of the top of the page: `Page.captureScreenshot` with `clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 }`, stored at `thumbs/<id>.jpg`, with `versions.thumb_key` set.
- *New versions:* the clip is a second capture in the same CDP session as the full-page screenshot, before `Browser.close`. No extra session, no extra spend.
- *Versions that already exist (backfill only):* the page as it was is gone, so photograph the stored screenshot instead. One browser session for the whole batch: for each version, navigate to the URL-encoded form of `data:text/html,<body style="margin:0"><img src="{PUBLIC_BASE_URL}/shots/{id}.jpg" width="1280" style="display:block"></body>`, wait for the image to load, take the same clip. Always `Browser.close`. Spend is one `screenshot` unit per batch session. If the browser refuses a `data:` URL, serve the same wrapper from `GET /thumbsrc/:name` and navigate there instead; say which path was used in the build log.
- A version whose thumbnail is missing simply shows its full screenshot; the hourly repair does not chase thumbnails.

- [ ] **Step 1: Write the failing tests** (`tests/site-fields.test.ts`):

```ts
it("stores and serves a delta for a change", async () => {
  // seed a page, a baseline and one later version whose text adds a block, removes a block and changes one
  await computeDelta(env, laterVersionId);
  const { changes } = await (await SELF.fetch("https://x/api/changes")).json();
  expect(changes[0].delta).toEqual({ blocks: { added: 1, removed: 1, changed: 1 }, facts: null, layout_only: false });
  expect(changes[0].kind).toBe("pricing");
});
it("leaves a baseline's delta null", ...);                         // expect(baseline.delta).toBeNull()
it("labels a restructure with the same words and figures as layout only", ...);  // fixture: 30 price rows as separate blocks, then the same rows as one table: delta.layout_only true, the version still exists, stats.layout_only 1, stats.changes does not count it
it("does not label a real price change as layout only", ...);     // same fixture with one price changed from $20 to $25: layout_only false
it("holds a shrinking restructure for a confirm read", ...);       // 285 blocks to 57 with 1 added, length ratio 0.90: no version, run reason "layout_hold", page pending; an agreeing second read creates the version
it("skips a heading when it quotes a line in a diff summary", ...); // added lines ["November 4, 2026", "We have raised the file upload limit to 50 files per chat."]: the summary quotes the second
it("reports the counts the site needs", async () => {
  const s = await (await SELF.fetch("https://x/api/stats")).json();
  expect(s.changes).toBe(1);
  expect(s.recording_since).toBe(seededPage.created_at);
  expect(s.public_slots).toEqual({ total: 4, used: 0, next_free_at: null });
});
it("never starts a facts run for a public add", ...);              // public POST /api/pages with kind "pricing": no Agent call in fetchMock, facts_status "not_needed"
it("stores the thumbnail taken with the screenshot", ...);         // browser driver stubbed through captureDeps to return { full, thumb }: R2 has thumbs/<id>.jpg, thumb_url ends with /thumbs/<id>.jpg, one session opened
it("backfills thumbnails for older versions in one session", ...);  // POST /api/admin/thumbs?limit=10 with three versions lacking thumbs: { made: 3, remaining: 0 }, one session opened
it("returns thumb_url null and keeps screenshot_url when no thumb exists", ...);
```

- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Write `migrations/0007_site_fields.sql`:** `ALTER TABLE versions ADD COLUMN delta_json TEXT;` and `ALTER TABLE versions ADD COLUMN thumb_key TEXT;`. Nothing else.
- [ ] **Step 4: Implement** the layout label, the hold rule, the summary line rule (with its one-off rebuild), the delta step and its backfill, the second capture in `screenshotFullPage`, `src/thumbs.ts`, `/thumbs/:name`, the admin route, the stats fields, `kind` on changes, and the public-add rule.
- [ ] **Step 5: Run `npm run check`; expect pass.**
- [ ] **Step 6: Commit.**

```bash
git add migrations/0007_site_fields.sql src tests/site-fields.test.ts
git commit -m "feat: change deltas, thumbnails, site stats; public adds skip facts"
```

- [ ] **Step 7: Take it live on the go-ahead** (this step changes the deployed recorder, so it waits for the go; it does not need the look gate, because the site stays switched off). Apply migration 0007 to production (additive, safe for the deployed code), deploy with `SITE_ENABLED` still `"0"`, run one thumbnail as the trial, then the backfill with `POST /api/admin/thumbs` until `remaining` is 0. Check: the next scheduled webhook is recorded as usual; `/api/changes` items carry `delta` and `thumb_url`.

### Task 3: Page view (history, check log, version card, as-of)

**Files:**
- Create: `src/site/views/page.tsx`, `tests/site-page.test.ts`
- Modify: `src/readModel.ts`, `src/handlers/pages.ts`, `src/handlers/history.ts`, `src/site/router.tsx`, `src/site/components.tsx`, `src/site/format.ts`, `src/site/views/home.tsx` (catch cards gain the delta badge or the `Layout only` tag and use `thumb_url ?? screenshot_url`; the hero counts only changes that are not layout-only), `public/assets/site.css`

**Interfaces:**
- Consumes: Task 1's layout and components; Task 2's `delta` and `thumb_url`.
- Produces:
  - `getPageDetail(env: Env, pageId: string): Promise<PageDetail | null>` (page, versions newest first without text, runs newest first), `getVersion(env: Env, pageId: string, versionId: string, opts: { withText: boolean }): Promise<VersionDetail | null>`, `getVersionAsOf(env: Env, pageId: string, atIso: string): Promise<VersionDetail | { error: "before_baseline"; baseline_at: string } | null>` in `src/readModel.ts`; the three JSON endpoints call them.
  - `cronToWords(cron: string): string` in `format.ts`: `"14 2,14 * * *"` gives `twice a day, at 02:14 and 14:14 UTC`; `"0 */6 * * *"` gives `four times a day`; anything else returns the cron text unchanged.
  - `parseAsOfInput(raw: string): string | null`: accepts ISO 8601 and the `datetime-local` form `2026-11-05T09:12` (read as UTC); returns an ISO string or null.
  - `FactsTable(props: { facts: Fact[] })`, `DeltaBadge(props: { delta: Delta | null })`. Badge text: `+2 −1 ~3 blocks`, zero parts left out, then ` · +1 ~2 facts` when facts changed; nothing at all when `delta` is null. When `delta.layout_only` is true it renders the tag `Layout only` instead, the card's time loses the accent, and the line `Same words and figures, different structure.` follows the summary.

**Screen: `GET /pages/:id`, with `v=<version id>` or `at=<time>`, and `text=1`.**
1. Header: label, the URL as a link, kind, status chip, `Checked {cronToWords}`, last check time, `{n} versions · {m} noise events suppressed`. The suspect-read, retired and expired notices from the table.
2. Timeline (DESIGN "Timeline"): one dot per version, placed by time between the first capture and now; each dot is a link to `?v=<id>` with the accessible name `Version recorded {time}`; the selected one is the accent dot. Under the strip, the same versions as an ordered list (small thumbnail, time, delta badge, summary), which is the primary control on a phone. No page-level horizontal scroll at 375px.
3. Check log: one small mark per run, oldest to newest: unchanged, change recorded, noise (with its reason), baseline; pulled checks marked. A sentence above it: `{n} checks: {a} changes, {b} noise, {c} unchanged.` A `<details>` "All checks" lists time, how it arrived (`webhook`, `pulled`, `baseline`), the outcome and the noise reason in words (`partial render`, `flap`, `same after cleaning`).
4. As-of scrubber (DESIGN "Page as-of scrubber"): a `GET` form with one labelled `datetime-local` input named `at` (min and max set to the baseline time and now) and a button `Show this date`. When `at` resolves, the version card carries the stamp `AS OF {time}`.
5. Version card for the selected version (default: latest): `Recorded {time}`; the summary with its origin in small muted text (`TinyFish's summary` or `From the diff`); the screenshot (thumbnail, linking to the full image, alt text as in Task 1); the facts table or the facts copy from the table; links `Stored source`, `Live page`, `This version as JSON`; a link `Compare with the previous version` when there is one; a link `Show the recorded text` that reloads with `text=1#text` and then shows the text in a `<pre>` (never loaded otherwise); the evidence line.
6. A `GET` form to `/pages/:id/compare` with two labelled selects of version times (`from`, `to`) and a button `Compare`.
7. While the selected version's screenshot is pending and the version is under two minutes old, the document carries `<meta http-equiv="refresh" content="5">`; otherwise it does not.

- [ ] **Step 1: Write the failing tests** (`tests/site-page.test.ts`): seed one page with a baseline and three later versions, and runs to match: the baseline run (which the sentence does not count), three changed, one noise run with reason `flap`, two unchanged (one of them pulled).

```ts
expect(cronToWords("14 2,14 * * *")).toBe("twice a day, at 02:14 and 14:14 UTC");
expect(parseAsOfInput("2026-11-05T09:12")).toBe("2026-11-05T09:12:00.000Z");
expect(parseAsOfInput("yesterday")).toBeNull();

const html = await get(`/pages/${id}`);
expect(html).toContain("Checked twice a day, at 02:14 and 14:14 UTC");
expect(html).toContain("6 checks: 3 changes, 1 noise, 2 unchanged.");
expect(html).toContain("flap");
expect(count(html, 'class="dot')).toBe(4);

expect(await get(`/pages/${id}?at=${afterSecond}`)).toMatch(/AS OF \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC/);
expect(await get(`/pages/${id}?at=2020-01-01T00:00`)).toContain("There is no earlier record.");
expect(await get(`/pages/${id}?at=yesterday`)).toContain("That is not a date Fineprint can read.");
expect((await SELF.fetch(`https://x/pages/${id}?v=not-a-version`)).status).toBe(404);

// states, one seeded version each
expect(failedShotHtml).toContain("Screenshot unavailable.");
expect(failedShotHtml).not.toMatch(/<img[^>]+src="[^"]*\/shots\//);
expect(pendingYoungHtml).toContain('http-equiv="refresh"');
expect(pendingYoungHtml).toContain("Taking the screenshot…");
expect(pendingOldHtml).not.toContain('http-equiv="refresh"');
expect(factsPendingHtml).toContain("Reading prices…");
expect(factsUnavailableHtml).toContain("Price table unavailable for this version.");
expect(suspectHtml).toContain("A suspect read is waiting for a second check.");
expect(retiredHtml).toContain("No longer watched. Its history is kept.");
expect(await get(`/pages/${id}`)).not.toContain(recordedTextMarker);
expect(await get(`/pages/${id}?text=1`)).toContain(recordedTextMarker);
expect(layoutOnlyHtml).toContain("Layout only");
expect(layoutOnlyHtml).toContain("Same words and figures, different structure.");
```

- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Extract `getPageDetail`, `getVersion` and `getVersionAsOf` into `src/readModel.ts`** (`getVersionAsOf` wraps the existing `versionAsOf` in `src/db/versions.ts`)**;** the JSON routes call them; existing tests pass unchanged.
- [ ] **Step 4: Implement the view, the two formatters and the two components.**
- [ ] **Step 5: Run `npm run check`; expect pass. Look at it at 375px and 1280px on the page with the most versions.**
- [ ] **Step 6: Commit.**

```bash
git add src/readModel.ts src/handlers src/site public/assets/site.css tests/site-page.test.ts
git commit -m "feat: page view with timeline, check log and as-of"
```

### Task 4: Compare view (the structured diff)

**Files:**
- Create: `src/site/views/compare.tsx`, `src/site/blockText.tsx`, `src/site/wordDiff.ts`, `tests/site-compare.test.tsx`
- Modify: `src/readModel.ts`, `src/handlers/history.ts`, `src/site/router.tsx`, `src/site/views/home.tsx`, `public/assets/site.css`

**Interfaces:**
- Consumes: the diff logic behind `GET /api/pages/:id/diff` and its cache.
- Produces:
  - `getDiff(env: Env, pageId: string, fromVersionId: string, toVersionId: string): Promise<Diff | null>` in `src/readModel.ts` (the JSON route resolves its two times to versions and calls it).
  - `BlockText(props: { text: string })`: renders one recorded markdown block as safe HTML. Heading marks (`#` to `######`) become a heading-styled line without the marks; list marks (`*`, `-`, `+`, `1.`) become list items; `[label](url)` becomes `label` only; `![alt](src)` becomes `[image: alt]`; `**`, `__`, `*`, `_` emphasis marks are dropped; backtick code keeps its text in the mono face; table rows stay as one mono line. Nothing in the input can produce a tag or an attribute.
  - `wordDiff(before: string, after: string): { before: Part[]; after: Part[] } | null` with `Part = { text: string; mark: boolean }`, built on `diffWordsWithSpace`; returns null when either side is over 4,000 characters.
  - `BLOCKS_PER_GROUP = 30` and `WORD_DIFF_PAIRS = 40` in `src/site/views/compare.tsx`.
  - `featuredCatch(env: Env, changes: ChangeItem[]): Promise<Featured | null>` in `src/site/views/home.tsx`: the newest of the first 10 changes whose diff against the previous version has a changed block that, cut down to the lines that differ, is under 1,200 characters on both sides. `Featured = { change: ChangeItem; fromAt: string; before: Part[]; after: Part[]; fromThumb: string | null; toThumb: string | null }`.

**Screen: `GET /pages/:id/compare?from=<version id>&to=<version id>`.** Defaults: `to` is the latest version, `from` the one before it. If `from` is newer than `to`, swap them. If they are the same, or the page has one version, say `There is nothing to compare yet: this page has one recorded version.` (or `Pick two different versions.`) and show the form.
1. Title `{label}: what changed`; a line `From {time} to {time} · {hops} versions apart · {n} noise events suppressed between`.
2. The summary, with its origin as in Task 3.
3. Facts first, when both versions have them: a table of changed (`name`, field, before, after), added and removed facts. The after value of a changed price is the one accent figure on this screen.
4. Blocks, grouped under their section heading, in the order changed, added, removed, with a count line `{a} added · {r} removed · {c} changed`. Changed: before and after in two columns on desktop, stacked on a phone, with word-level marks (removed words struck in `--ink-muted` on the before side, added words on `--accent-wash` on the after side) for the first `WORD_DIFF_PAIRS` pairs. Added: `--accent-wash` with the 3px accent left bar. Removed: `--paper-sunken`, struck through. Never whole lines in red and green. Each group shows `BLOCKS_PER_GROUP` blocks; a link `Show all {n}` reloads with `all=1`.
5. The two screenshots side by side (stacked on a phone), each the thumbnail linking to the full image, each with its evidence line.
6. Links: `This diff as JSON` (the API URL with the two ISO times), `Back to the page`.

**Home gains the featured catch** (the comp's `The latest catch, up close`), between the hero and the feed: the label row, the summary, the before and after of the one block with word-level marks, the two thumbnails with their `The page as it was read on {time}` captions, the buttons `Open the full comparison` and `See this page's history`, and the evidence line. When `featuredCatch` returns null the section is left out.

- [ ] **Step 1: Write the failing tests** (`tests/site-compare.test.tsx`; `render` is the JSX node's `toString()`):

```ts
expect(render(<BlockText text={"### Pro plan"} />)).not.toContain("#");
expect(render(<BlockText text={"* [Docs](javascript:alert(1)) cost **$20**"} />)).toContain("Docs cost $20");
expect(render(<BlockText text={"* [Docs](javascript:alert(1))"} />)).not.toContain("javascript:");
expect(render(<BlockText text={"<img src=x onerror=alert(1)>"} />)).toContain("&lt;img");

const d = wordDiff("Pro costs $20 per month", "Pro costs $25 per month")!;
expect(d.before.filter((p) => p.mark).map((p) => p.text)).toEqual(["$20"]);
expect(d.after.filter((p) => p.mark).map((p) => p.text)).toEqual(["$25"]);
expect(wordDiff("a".repeat(4001), "b")).toBeNull();

const html = await get(`/pages/${id}/compare?from=${v1}&to=${v2}`);
expect(html).toContain("1 added · 1 removed · 1 changed");
expect(html).toContain("diff-added");
expect(html).toContain("diff-removed");
expect(html).toMatch(/<del[^>]*>\$20<\/del>/);
expect(html).toMatch(/<ins[^>]*>\$25<\/ins>/);
expect(await get(`/pages/${id}/compare?from=${v2}&to=${v1}`)).toContain("1 added · 1 removed · 1 changed"); // swapped, not an error
expect(await get(`/pages/${id}/compare?from=${v1}&to=${v1}`)).toContain("Pick two different versions.");
expect(await get(`/pages/${onePageId}/compare`)).toContain("There is nothing to compare yet");

// the large fixture: 60 added blocks
expect(count(bigHtml, "diff-added")).toBe(30);
expect(bigHtml).toContain("Show all 60");
expect(count(await get(bigUrl + "&all=1"), "diff-added")).toBe(60);
expect(factsHtml).toMatch(/Pro[\s\S]*price[\s\S]*\$20[\s\S]*\$25/);

// home: the featured catch
const home = await get("/");
expect(home).toContain("The latest catch, up close");
expect(home).toMatch(/<del[^>]*>\$20<\/del>/);
expect(home).toContain("Open the full comparison");
expect(homeWithOnlyHugeChanges).not.toContain("The latest catch, up close");
```

- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Extract `getDiff` into `src/readModel.ts`;** the JSON route calls it; existing diff tests pass unchanged.
- [ ] **Step 4: Implement `BlockText`, `wordDiff` and the view.**
- [ ] **Step 5: Run `npm run check`; expect pass. Look at it at 375px and 1280px on the Claude release notes page (the largest diff) and on a pricing page with facts.**
- [ ] **Step 6: Commit.**

```bash
git add src/readModel.ts src/handlers/history.ts src/site public/assets/site.css tests/site-compare.test.tsx
git commit -m "feat: compare view with section groups and word-level marks"
```

### Task 5: Watchlist, add a page, discover

**Files:**
- Create: `src/site/views/watchlist.tsx`, `tests/site-watchlist.test.ts`
- Modify: `src/readModel.ts`, `src/handlers/pages.ts`, `src/handlers/discover.ts`, `src/site/router.tsx`, `public/assets/site.css`

**Interfaces:**
- Consumes: the add-page and discover logic in the two handlers, with their caps and per-visitor limits.
- Produces:
  - `listPages(env: Env): Promise<PageSummary[]>` in `src/readModel.ts`.
  - `addPage(env: Env, ctx: ExecutionContext, input: { url: string; label?: string; kind?: string }, caller: { admin: boolean; ipHash: string }): Promise<AddResult>` with `AddResult = { ok: true; page: PageSummary } | { ok: false; status: number; error: string; reason: string; existing_page_id?: string }` (the statuses and error codes the JSON route answers with today), exported from `src/handlers/pages.ts`; `POST /api/pages` and `POST /watchlist` both call it. The JSON route's statuses and bodies do not change.
  - `discover(env: Env, domain: string, ipHash: string): Promise<{ ok: true; results: { url: string; title: string; snippet: string }[] } | { ok: false; status: number; reason: string }>`, exported from `src/handlers/discover.ts`; both routes call it.
  - `addErrorCopy(error: string, reason: string): string` in `src/site/views/watchlist.tsx`.

**Screen: `GET /watchlist` (optional `domain=`, `url=`, `label=`), `POST /watchlist`.**
1. "Watching": every active, paused or failed page. Table on desktop, cards on a phone: label (link), kind, status chip, schedule in words, last check, last change, versions, noise. Then "No longer watched": retired and expired pages with the same columns and their chip; history links still work.
2. "Add a page": a `POST` form with a labelled URL input and an optional label. No kind field (public pages never run facts). Under it: `Fineprint will watch this page twice a day for 7 days.` and `{free} of {total} public slots are free.` When none is free the fields are disabled and the line reads `All 4 public slots are in use. The next one frees on {time}.` The site form never accepts the admin token.
3. On success: `303` to `/pages/{id}`, where Task 3's pending states and refresh take over. On refusal: the watchlist screen again with the refusal's status, the reason beside the form, and the typed URL kept.
4. "Find a site's small print": a `GET` form with a domain input; the results list title, URL and snippet, each with a link `Watch this page` that reloads with `url=` and `label=` filled into the add form.

Refusal copy (`addErrorCopy`, keyed by the handler's error code or the TinyFetch reason it carries): `login_required` gives `That page needs a login, so it cannot be watched.`; `bot_blocked` gives `That site refuses automated reading, so it cannot be watched.`; `timeout` gives `That page did not answer in time. Try again in a minute.`; `target_http_error` gives `That page returned an error when read.`; `daily_limit` gives `One public page per visitor per day. Come back tomorrow.`; `public_slots_full` gives the slots line above; a duplicate gives `Fineprint already watches that page.` with a link to it; anything else shows the handler's own `reason`.

- [ ] **Step 1: Write the failing tests** (`tests/site-watchlist.test.ts`), TinyFish calls answered by the existing `fetchMock` helpers:

```ts
const html = await get("/watchlist");
expect(html).toContain("4 of 4 public slots are free.");
expect(html).toContain("Fineprint will watch this page twice a day for 7 days.");
expect(html).toMatch(/No longer watched[\s\S]*Retired/);

const ok = await post("/watchlist", { url: "https://example.com/pricing" });
expect(ok.status).toBe(303);
expect(ok.headers.get("location")).toMatch(/^\/pages\/[0-9a-f-]{36}$/);

const walled = await post("/watchlist", { url: "https://walled.example/terms" }); // TinyFetch answers login_required
expect(walled.status).toBe(jsonStatusForTheSameRefusal); // whatever POST /api/pages answers for it today
const body = await walled.text();
expect(body).toContain("That page needs a login, so it cannot be watched.");
expect(body).toContain('value="https://walled.example/terms"');
expect(monitorCreateCalls()).toBe(1); // only the successful add above

expect(await (await post("/watchlist", { url: "https://example.org/fees" })).text())
  .toContain("One public page per visitor per day. Come back tomorrow.");
expect(fullHtml).toContain("All 4 public slots are in use. The next one frees on");
expect(fullHtml).toMatch(/<input[^>]+name="url"[^>]+disabled/);
expect(await get("/watchlist?domain=example.com")).toContain("Watch this page");
expect(await get("/watchlist?url=https%3A%2F%2Fexample.com%2Fterms")).toContain('value="https://example.com/terms"');
```

- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Extract `addPage`, `discover` and `listPages`;** the JSON routes call them; existing pages and discover tests pass unchanged.
- [ ] **Step 4: Implement the view and the POST route.**
- [ ] **Step 5: Run `npm run check`; expect pass. Look at it at 375px and 1280px.**
- [ ] **Step 6: Commit.**

```bash
git add src/readModel.ts src/handlers/pages.ts src/handlers/discover.ts src/site public/assets/site.css tests/site-watchlist.test.ts
git commit -m "feat: watchlist with public add and discover"
```

### Task 6: About

**Files:**
- Create: `src/site/views/about.tsx`, `public/assets/enhance.js`, `tests/site-about.test.ts`
- Modify: `src/site/router.tsx`, `src/site/layout.tsx` (load `enhance.js` with `defer`), `public/assets/site.css`

**Interfaces:**
- Consumes: `getStats`.
- Produces: `GET /about`; `enhance.js` (lightbox for `a[data-full]`, copy buttons for `pre[data-copy]`; both no-ops without the elements).

**Screen: `GET /about`** (a Read surface, written for a judge with five minutes). Sections, in order:
1. What Fineprint is, in two sentences, and `Recording since {recording_since}`.
2. How a change is recorded: five numbered steps (Monitor checks the page on schedule; the read is cleaned of noise; a real difference becomes a version; the screenshot, the source and, for pricing pages, the price table are captured; the change appears in the feed and the API) beside an inline SVG diagram drawn with token colours only, with a text alternative.
3. One change, start to finish: the featured catch from the home screen again, this time annotated in four short captions (the scheduled check that found it, the cleaned text that differed, the screenshot taken, the entry in the feed), so a reader sees a real record and not a description of one.
4. How TinyFish is used: a table with one row each for Monitor, Fetch, Browser, Agent and Search: what it does here in one sentence, and the live count or spend from `stats` (`runs_by_trigger`, `spend_by_kind`). Under it: `If every Monitor were deleted, nothing new would ever be recorded.`
5. What counts as noise: the cleaning rules, partial render, flap and the layout hold in plain words, with the live counts from `noise_by_reason`. Then what is kept but labelled: layout-only changes (the count, with one linked example), and the page retired for unreliable reads, named, with the reason and a link to its kept history.
6. Honest limits: no history before a page is added; twice a day; a pulled check has no TinyFish summary, so its summary comes from the diff; text is the diff and screenshots are evidence; public pages stop after 7 days; the budget lines ($6 pauses price tables, $8 pauses recording).
7. Use the data: each public GET endpoint with a one-line description and a copyable `curl` against this host (`PUBLIC_BASE_URL`), and a link to `/api/export.json`.
8. `Built by Hamdan Esmail for the TinyFish Time Machine bounty.` A source link appears only when the `REPO_URL` variable is set (it is empty until submission day).

- [ ] **Step 1: Write the failing test** (`tests/site-about.test.ts`):

```ts
const html = await get("/about");
for (const name of ["Monitor", "Fetch", "Browser", "Agent", "Search"]) expect(html).toContain(`<th scope="row">${name}</th>`);
expect(html).toContain("If every Monitor were deleted, nothing new would ever be recorded.");
expect(html).toContain("One change, start to finish");
expect(html).toContain("curl https://fineprint.example/api/changes");
expect(html).toContain("partial render");
expect(html).not.toContain("github.com");                  // REPO_URL unset
expect(html).toMatch(/<svg[^>]+role="img"[^>]+aria-labelledby=/);
```

- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement the view and `enhance.js`.**
- [ ] **Step 4: Run `npm run check`; expect pass. Look at it at 375px and 1280px.**
- [ ] **Step 5: Commit.**

```bash
git add src/site public/assets tests/site-about.test.ts
git commit -m "feat: about page with how TinyFish is used and the API reference"
```

### Task 7: Harden, audit, polish

**Files:**
- Modify: whatever the passes below find, within `src/site/**`, `public/assets/**` and the site tests.

**Interfaces:**
- Consumes: every screen. Produces: a preview Hamdan can approve, and a short report.

- [ ] **Step 1: Upload a preview** (`wrangler versions upload --var SITE_ENABLED:1 --message "site preview: all screens"`). Task 2 must be live first: the preview reads the production database.
- [ ] **Step 2: Run the design pass: critique, then audit, then polish, on the preview** at 375px and 1280px, screen by screen: home, the page with the most versions, the largest compare, watchlist, about, the 404. Put the home screen beside `design/comp-home.html` and close every visible gap. Fix what the passes find; keep the world. The bar: each screen reads as designed, not assembled, and a stranger can say what Fineprint does after ten seconds on the home screen.
- [ ] **Step 3: Check by hand and fix:** every control reachable and visible by keyboard; a skip link; one `h1` per screen; no page-level horizontal scroll at 375px; no text under 11.5px; the pulse stops under reduced motion; every screen readable with JavaScript off; every image has width, height and alt text; no request leaves the host (network panel).
- [ ] **Step 4: Measure CPU.** Request home, the busiest page view and the largest compare ten times each on the preview and read the CPU time from Workers Logs or `wrangler tail --format json`. Target: median under 5 ms, none over 8 ms. If a screen is over, lower `BLOCKS_PER_GROUP` or `WORD_DIFF_PAIRS` and say so. If the preview's requests are not visible in the logs, say so and measure straight after Task 8.
- [ ] **Step 5: One real public add on the preview** (cleared, about $0.08): a page of your choice that is not already watched. It must show its baseline within a minute and its screenshot shortly after, with the pending copy and the refresh in between. Leave it to expire.
- [ ] **Step 6: Run `npm run check`; commit** (`git commit -m "fix: audit and polish pass on the site"`), upload the final preview, and report: the preview URL, the CPU numbers, what the audit found and what was left alone, and the test count.

### Task 8: Switch the site on (on the go-ahead only)

- [ ] **Step 1: Wait for the go-ahead.** Hamdan looks at the final preview on a phone and a laptop first.
- [ ] **Step 2: Switch the site on.** Set `vars.SITE_ENABLED` to `"1"` in `wrangler.jsonc`, commit, and `wrangler deploy` from that commit at a quiet moment between scheduled checks.
- [ ] **Step 3: Verify on production:** `/`, a page view, a compare, `/watchlist`, `/about` answer 200; `/api/stats` answers JSON; the next scheduled webhook is recorded; the hourly cron ran.
- [ ] **Step 4: Update `docs/build-log.md`** (what went live, when, the CPU numbers) and the README's live URL line; commit and push. Then stop.

## Not in this plan

Admin screens (the runbook's curl commands stay the admin surface); the README rewrite, hero image, demo recording and post drafts (the submission phase); dark mode; per-change social images; filters or search on the feed; email or push alerts.
