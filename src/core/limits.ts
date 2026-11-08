// Hard caps. Every limit in the product comes from here.

/** Monitors we will ever hold on TinyFish at once. */
export const MAX_MONITORS = 24;
/** Of those, slots open to public visitors. */
export const PUBLIC_SLOTS = 4;
/** Public pages are recorded for this long, then removed. */
export const PUBLIC_TTL_DAYS = 7;
export const PUBLIC_ADDS_PER_IP_PER_DAY = 1;
/** Discover-by-domain lookups a public caller gets per day (the admin has no limit). */
export const DISCOVER_PER_IP_PER_DAY = 10;
/** The longest url `POST /api/pages` accepts, as sent and in its stored (canonical) form. */
export const MAX_URL_LENGTH = 2048;

/** The facts run on a pricing page may take at most this many Agent steps... */
export const AGENT_MAX_STEPS = 6;
/** ...and this long. */
export const AGENT_MAX_DURATION_SECONDS = 120;

/** A version whose capture keeps failing is retried this many times, then left as it is. */
export const CAPTURE_MAX_ATTEMPTS = 3;
/**
 * The hourly cron repairs at most this many versions per tick, oldest first. Each capture
 * makes several outbound requests, and the free plan allows 50 per invocation.
 */
export const REPAIR_PER_TICK = 3;
/** The cron's health check looks up at most this many Monitors missing from the list, one request each, per tick. */
export const MONITOR_LOOKUPS_PER_TICK = 3;
/**
 * The cron pulls at most this many overdue checks per tick (run-now, each in its own Worker
 * invocation), oldest overdue tick first. Each pull is one of the cron's 50 subrequests, beside
 * facts upkeep, expiry, health and repair; with staggered twice-daily schedules about two pages come
 * due an hour, so the cap only matters for catching up.
 */
export const PULLS_PER_TICK = 20;
/**
 * The pull backoff (src/handlers/admin.ts, src/cron.ts): after this many consecutive failed pulls of a
 * page (no text, a fetch error, or run-now failing), the hourly cron pulls it at most once every
 * PULL_BACKOFF_MS, until a pull returns usable text or a webhook run arrives for the page.
 */
export const PULL_BACKOFF_AFTER_FAILURES = 3;
export const PULL_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** Full-page screenshots are cut off at this height in pixels. */
export const SCREENSHOT_MAX_HEIGHT = 8000;

/** When total spend reaches this many US dollars, the Worker pauses everything that costs money. */
export const SPEND_PAUSE_USD = 8;
/**
 * From this much total spend on, no facts run is started (a version waiting for one has facts_status "paused"
 * and stays eligible, src/capture.ts); overdue
 * pulls and screenshot and source captures go on until SPEND_PAUSE_USD. Facts runs are the one cost
 * a page's changes multiply, so they stop first and cannot use up the budget that keeps checks coming.
 */
export const FACTS_PAUSE_USD = 6;

/**
 * The hourly job moves at most this many queued versions a tick to facts_status "paused" once the price-table
 * pause holds (and back to "pending" if the line is raised above the total), oldest first, and drops the stored
 * screens of their pages after the overdue pulls (one R2 list per page and one delete, so at most six calls). The
 * queue is serial, so at the pause it holds a handful of versions at most; the rest move on later ticks.
 */
export const FACTS_HOLD_PER_TICK = 5;

/**
 * The partial-render guard (src/core/gate.ts). A changed read is suspect, and held for a confirm read
 * instead of becoming a version, when its normalized text is under PARTIAL_RENDER_RATIO of the latest
 * version's and adds no block, or when it is under PARTIAL_RENDER_SMALL_CHARS while the latest is over
 * PARTIAL_RENDER_LARGE_CHARS.
 */
export const PARTIAL_RENDER_RATIO = 0.7;
export const PARTIAL_RENDER_SMALL_CHARS = 500;
export const PARTIAL_RENDER_LARGE_CHARS = 2000;
/**
 * The layout hold (src/core/gate.ts), beside the partial-render guard: a changed read whose normalized
 * text is under LAYOUT_HOLD_RATIO of the latest version's, that removes at least LAYOUT_HOLD_MIN_REMOVED
 * blocks and whose added blocks are at most LAYOUT_HOLD_MAX_ADDED_SHARE of the removed ones is held for
 * a confirm read the same way (GitHub pricing on 5 Nov: 228 blocks removed, 1 added, 91% of the length).
 */
export const LAYOUT_HOLD_RATIO = 0.95;
export const LAYOUT_HOLD_MIN_REMOVED = 20;
export const LAYOUT_HOLD_MAX_ADDED_SHARE = 0.05;
/** A suspect read is confirmed (pulled for) for this long, then forgotten. */
export const CONFIRM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The layout-only label (src/core/diff.ts isLayoutOnly). A label, never a suppression: a change that touches
 * at least LAYOUT_ONLY_MIN_BLOCKS blocks (added plus removed), is skewed at least LAYOUT_ONLY_MIN_SKEW one
 * way (|added − removed| / (added + removed)), and whose changed region (what went against what came)
 * carries the same price tokens on both sides and shares at least LAYOUT_ONLY_MIN_OVERLAP of its words.
 * Validated on 7 Nov against the 15 changes recorded so far: it marks GitHub pricing 5 Nov 14:38 (region
 * overlap 0.925) and OpenAI privacy policy 3 Nov 18:06 (0.878) and no other; a pure addition scores 0.
 */
export const LAYOUT_ONLY_MIN_OVERLAP = 0.85;
export const LAYOUT_ONLY_MIN_BLOCKS = 20;
export const LAYOUT_ONLY_MIN_SKEW = 0.4;
/**
 * A changed region longer than this (both sides together, in characters) is not labelled, and no word is
 * counted. The two labelled restructures are 27,613 (GitHub) and 28,950 (OpenAI privacy) characters, so
 * this leaves them room; counting the words of 40,000 characters takes about 2.5 ms, which keeps the label
 * a small part of a delta's CPU even beside two 228 KB normalizations.
 */
export const LAYOUT_ONLY_MAX_REGION_CHARS = 40_000;
/** A read whose text equals any version captured this recently is a flap, not a new version. */
export const FLAP_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * One call of the summary fill (src/summary.ts) stops once the page texts it has normalized and diffed
 * (each version's and the one before it) add up to this many characters, after at least one version.
 * Normalizing is about 1 ms per 15 KB, so this keeps a call to a few ms of the 10 ms CPU budget.
 */
export const SUMMARY_TEXT_BUDGET_CHARS = 60_000;
/**
 * One default fill call (summaries or deltas) diffs at most this many versions, whatever the text budget
 * leaves: each costs a read and a write, and the free plan allows 50 D1 queries an invocation.
 */
export const FILL_DIFFS_PER_CALL = 12;
/**
 * A diff whose texts are longer than this (either side, in characters) is never computed on a reader's
 * request when it can be helped: the home's featured catch reads it only from diff_cache, and the hourly
 * cron stores it ahead of readers, one pair a tick (`POST /api/admin/warm-diff`). On the 6 Nov texts, in
 * Node, normalize on both texts plus structuredDiff takes about 1.2 ms at 29 KB and 8 to 11 ms at 228 KB.
 */
export const LARGE_DIFF_TEXT_CHARS = 40_000;
/**
 * The hourly job rebuilds stored screens (src/cron.ts): at most this many in a tick, each in an invocation of its
 * own. The first three are always home, About and the watchlist, whose live counts move with every check; the
 * rest, REBUILD_CALLS_PER_TICK minus those, pre-warm the views of pages with a version captured in the last
 * REBUILD_WINDOW_HOURS, taken in turn by the hour of day when there are more.
 */
export const REBUILD_CALLS_PER_TICK = 8;
export const REBUILD_FIXED_SCREENS = ["home", "about", "watchlist"] as const;
export const REBUILD_WINDOW_HOURS = 24;
/** A tick that has already made more SELF calls than this (pulls, fills, the large diff) rebuilds only the fixed screens. */
export const REBUILD_BUSY_TICK_CALLS = 12;
/** The large pairs the cron looks at in a tick; it stores one of them, taken in turn by the hour of day. */
export const WARM_DIFF_CANDIDATES = 24;
