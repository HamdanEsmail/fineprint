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
