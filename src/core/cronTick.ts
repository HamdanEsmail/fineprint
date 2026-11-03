// When a Monitor's schedule last ticked. The hourly cron uses it to tell an overdue check (its
// scheduled run never arrived) from one that is not due yet.
//
// Standard 5-field cron in UTC: minute, hour, day of month, month, day of week (0 or 7 is
// Sunday). Each field is `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, or a comma list
// of those. Names (JAN, MON) and `a/n` without a range are not read. Day of month and day of week
// follow the usual rule: when both are restricted a day matches either one; when either field
// starts with `*` a day must match both (so `*` alone leaves the other field in charge).

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** How far back the search looks before it gives up: a schedule that has not ticked in this many days has no tick. */
const MAX_DAYS_BACK = 400;

type Field = { allowed: boolean[]; star: boolean };
type Schedule = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

const PART = /^(?:\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/;

/** One field's allowed values (indexes min..max set to true), or null when it cannot be read. */
function parseField(text: string, min: number, max: number): Field | null {
  const allowed = new Array<boolean>(max + 1).fill(false);
  for (const part of text.split(",")) {
    const m = PART.exec(part);
    if (m === null) return null;
    const [, from, to, by] = m;
    if (from !== undefined && to === undefined && by !== undefined) return null; // `a/n`
    const lo = from === undefined ? min : Number(from);
    const hi = from === undefined ? max : to === undefined ? lo : Number(to);
    const step = by === undefined ? 1 : Number(by);
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) allowed[v] = true;
  }
  return { allowed, star: text.startsWith("*") };
}

function parseSchedule(cron: string): Schedule | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dom = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12);
  const dow = parseField(fields[4]!, 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.allowed[7]) dow.allowed[0] = true; // 7 is Sunday too
  return { minute, hour, dom, month, dow };
}

function dayMatches(s: Schedule, day: Date): boolean {
  if (!s.month.allowed[day.getUTCMonth() + 1]) return false;
  const domOk = s.dom.allowed[day.getUTCDate()] === true;
  const dowOk = s.dow.allowed[day.getUTCDay()] === true;
  return s.dom.star || s.dow.star ? domOk && dowOk : domOk || dowOk;
}

/** The allowed values of a field, largest first. */
const descending = (f: Field): number[] =>
  f.allowed.flatMap((ok, v) => (ok ? [v] : [])).reverse();

/**
 * The latest tick of `cron` at or before `at` (a tick at exactly `at`, to the minute, counts), or
 * null when the cron cannot be read or has no tick in the last 400 days. It walks back a day at a
 * time and, within a matching day, tries the allowed hours and minutes from the latest down, so a
 * twice-daily schedule costs a few iterations.
 */
export function lastTickAtOrBefore(cron: string, at: Date): Date | null {
  const schedule = parseSchedule(cron);
  const t = at.getTime();
  if (schedule === null || !Number.isFinite(t)) return null;
  const hours = descending(schedule.hour);
  const minutes = descending(schedule.minute);
  const atHour = at.getUTCHours();
  const atMinute = at.getUTCMinutes();

  let day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  for (let back = 0; back < MAX_DAYS_BACK; back++, day -= DAY_MS) {
    if (!dayMatches(schedule, new Date(day))) continue;
    for (const h of hours) {
      if (back === 0 && h > atHour) continue;
      for (const m of minutes) {
        if (back === 0 && h === atHour && m > atMinute) continue;
        return new Date(day + h * HOUR_MS + m * MINUTE_MS);
      }
    }
  }
  return null;
}
