# Fineprint demo script

A shot list for the demo video of the TinyFish Time Machine bounty entry: seven shots, 87 seconds of narration, 96 seconds with the title and end cards. Each shot is one URL on the live site and one line of narration, read at an even pace (about 2.5 words a second). Shots 2 to 4 open fixed records (fixed version ids and a fixed date), so what they answer is the same on any day; the home, the watchlist, About and `/api/stats` show live data.

Live site: https://fineprint.hamdanesmail12-7a9.workers.dev

## Shots

### 1. The home: what it is, the live line (11 s)

https://fineprint.hamdanesmail12-7a9.workers.dev/

On screen: the top of the home, still: the wordmark with its RECORDING stamp, the line "A dated record of the web's small print.", the two buttons and the live line under them (recording since, pages, real changes, checks, noise filtered).

> Fineprint keeps a dated record of the small print people agree to without reading: pricing, fees, terms and privacy policies. The line under the buttons is live.

### 2. The featured catch: before and after, word marks (14 s)

https://fineprint.hamdanesmail12-7a9.workers.dev/pages/d53d1b28-3480-42e1-a498-8224025dd840/compare?from=d0f38678-44d9-45e2-b411-96efa1efb646&to=100dbf11-07db-483c-9f00-54d1b7471ed5

On screen: Anthropic pricing, 3 Nov 2026 21:03 UTC to 7 Nov 2026 21:03 UTC. The Pro block before and after, with "Claude Code" marked as new, the three removed "Claude Code included" lines under Pro, Max and Ultra, then a slow scroll to the two screenshots. On 8 Nov this is the catch the home features ("The latest catch, up close") and the one in the hero and social images. When a newer change has replaced it on the home by the recording day, this URL still shows the same comparison.

> A real catch from 7 November: Anthropic's pricing page added Claude Code to the Pro plan's list and removed the "Claude Code included" lines under Pro, Max and Ultra. The changed words are marked.

### 3. A page's history: timeline, as-of date, check log (16 s)

https://fineprint.hamdanesmail12-7a9.workers.dev/pages/233d04d4-77e6-4ebc-bc5f-15fecc07296a?at=2026-11-03T21%3A16%3A17.282Z

On screen: Claude release notes, the page behind the home's "What did this page say on 3 Nov 2026?" link. The timeline with the AS OF marker at 3 Nov 2026 21:16 UTC, the version in force then (the baseline, recorded 3 Nov 2026 16:18 UTC) with its screenshot, then a scroll down past "Versions, newest first" to "Every check", the check log with how each run arrived and its outcome.

> Each page has a timeline. This link asks what the Claude release notes said on 3 November at 21:16 UTC: the version in force then, with its screenshot. Below, the check log lists every Monitor run and its outcome.

### 4. The largest compare (13 s)

https://fineprint.hamdanesmail12-7a9.workers.dev/pages/233d04d4-77e6-4ebc-bc5f-15fecc07296a/compare?to=3a8d2ae1-b51b-4e69-8a64-edadc7278281

On screen: Claude release notes, 4 Nov 2026 02:14 UTC to 5 Nov 2026 14:14 UTC, 23 changed blocks. Hold on the first block, under "October 30, 2026", with its marked words, then scroll slowly through a few more.

> Any two versions can be compared. Here, 23 blocks changed between 4 and 5 November, each under the page's own heading: words that went are struck through, new words are marked.

### 5. The watchlist: the public add, explained (13 s)

https://fineprint.hamdanesmail12-7a9.workers.dev/watchlist

On screen: the table of watched pages with their schedules, down to the Stripe pricing row ("Public until 14 Nov 2026, 14:20 UTC"), then the "Add a page" form with its line on the public slots. Nothing is typed and nothing is submitted: the add is explained, not performed.

> Each watched page has its own TinyFish Monitor, reading it twice a day. Anyone can add a page for seven days with this form; Stripe pricing was added that way.

### 6. About: the TinyFish table (13 s)

https://fineprint.hamdanesmail12-7a9.workers.dev/about#tinyfish

On screen: "How TinyFish is used", the table of the five products with what each does here and its spend so far, down to the line "If every Monitor were deleted, nothing new would ever be recorded."

> Five TinyFish services do the work: Monitor reads every page, Browser takes the screenshots, Fetch keeps the HTML source, Agent reads price tables and Search finds a site's small print.

### 7. The figures as JSON (7 s)

https://fineprint.hamdanesmail12-7a9.workers.dev/api/stats

On screen: the raw JSON in the browser (with Chrome's pretty-print turned on if it offers it), still.

> Every figure on the site is public JSON: pages, runs, versions, changes, noise and spend.

## Total

| Shot | Screen | Duration |
|---|---|---|
| 1 | Home | 11 s |
| 2 | Featured catch | 14 s |
| 3 | Page history | 16 s |
| 4 | Largest compare | 13 s |
| 5 | Watchlist | 13 s |
| 6 | About, TinyFish table | 13 s |
| 7 | `/api/stats` | 7 s |
| | **Total** | **87 s** |

## The video as made

The demo was produced on 8 Nov 2026 from screenshots of the live site rather than a screen recording, so that it could be made in one sitting on submission day:

- **Shots.** The seven shots above, in order, between a title card (the wordmark, the lede and the bounty's name) and an end card (the live URL, the repository URL and the author). Each shot is a screenshot of its URL taken that afternoon at 1280 CSS pixels wide (rendered at 1.5x), still for the home and the figures, and a slow scroll for the others, ending where the narration's subject sits.
- **Narration.** Each shot's narration line is shown as a caption on a paper band along the bottom of the frame, numbered 1 to 7, in the site's own type. There is no voice track and no music.
- **The figures shot** shows the JSON of `/api/stats` as read at 17:05 UTC, set in the site's mono face on paper. The home's stored copy read 203 checks at the time, trailing `/api/stats` by its usual margin.
- **Format.** 1920x1080, 30 frames a second, H.264, 96 seconds, silent. Shot durations follow the table above plus the crossfades between shots.
- **Stripe pricing** was a live public page when the watchlist was photographed (shot 5); it expires on 14 Nov 2026 at 14:20 UTC, and its history stays.

The video is not in the repository; its link is in the demo slot of [submission.md](submission.md).
