// The Monitor schedule and the purpose text sent with every Monitor (spec 4.5, 4.6).

/**
 * Page n runs twice a day, staggered so payloads do not land together:
 * minute (n * 7) % 60, hours n % 12 and that plus 12 (UTC).
 */
export function cronForIndex(n: number): string {
  return `${(n * 7) % 60} ${n % 12},${(n % 12) + 12} * * *`;
}

/** Same for every page unless the admin overrides it (spec 4.5). */
export const PURPOSE =
  "A price, plan, limit, fee, rule, eligibility condition, deadline or policy term was added, removed or changed. Ignore timestamps, 'last updated' notes, cookie banners, layout and wording-only edits.";
