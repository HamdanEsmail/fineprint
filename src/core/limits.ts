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
/** Full-page screenshots are cut off at this height in pixels. */
export const SCREENSHOT_MAX_HEIGHT = 8000;

/** When total spend reaches this many US dollars, the Worker pauses everything that costs money. */
export const SPEND_PAUSE_USD = 8;
/**
 * From this much total spend on, no facts run is started (versions stay queued for them); overdue
 * pulls and screenshot and source captures go on until SPEND_PAUSE_USD. Facts runs are the one cost
 * a page's changes multiply, so they stop first and cannot use up the budget that keeps checks coming.
 */
export const FACTS_PAUSE_USD = 6;

/**
 * The partial-render guard (src/core/gate.ts). A changed read is suspect, and held for a confirm read
 * instead of becoming a version, when its normalized text is under PARTIAL_RENDER_RATIO of the latest
 * version's and adds no block, or when it is under PARTIAL_RENDER_SMALL_CHARS while the latest is over
 * PARTIAL_RENDER_LARGE_CHARS.
 */
export const PARTIAL_RENDER_RATIO = 0.7;
export const PARTIAL_RENDER_SMALL_CHARS = 500;
export const PARTIAL_RENDER_LARGE_CHARS = 2000;
/** A suspect read is confirmed (pulled for) for this long, then forgotten. */
export const CONFIRM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A read whose text equals any version captured this recently is a flap, not a new version. */
export const FLAP_WINDOW_MS = 72 * 60 * 60 * 1000;
