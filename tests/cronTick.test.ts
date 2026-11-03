import { describe, expect, it } from "vitest";
import { lastTickAtOrBefore } from "../src/core/cronTick";
import { cronForIndex } from "../src/core/schedule";

// 2026-11-01 is a Sunday, 2026-11-02 a Monday, 2026-11-03 a Tuesday, 2026-10-30 a Friday.
const tick = (cron: string, at: string): string | null => lastTickAtOrBefore(cron, new Date(at))?.toISOString() ?? null;

describe("lastTickAtOrBefore", () => {
  it('"0 0,12 * * *": the latest of midnight and noon', () => {
    expect(tick("0 0,12 * * *", "2026-11-03T13:00:00.000Z")).toBe("2026-11-03T12:00:00.000Z");
    expect(tick("0 0,12 * * *", "2026-11-03T11:59:59.999Z")).toBe("2026-11-03T00:00:00.000Z");
    expect(tick("0 0,12 * * *", "2026-11-02T23:59:00.000Z")).toBe("2026-11-02T12:00:00.000Z");
  });

  it('"31 1,13 * * *"', () => {
    expect(tick("31 1,13 * * *", "2026-11-03T13:30:59.000Z")).toBe("2026-11-03T01:31:00.000Z");
    expect(tick("31 1,13 * * *", "2026-11-03T13:31:00.000Z")).toBe("2026-11-03T13:31:00.000Z");
    // Before the day's first tick: yesterday's last one.
    expect(tick("31 1,13 * * *", "2026-11-03T01:30:00.000Z")).toBe("2026-11-02T13:31:00.000Z");
  });

  it('"*/10 * * * *"', () => {
    expect(tick("*/10 * * * *", "2026-11-03T10:59:59.000Z")).toBe("2026-11-03T10:50:00.000Z");
    expect(tick("*/10 * * * *", "2026-11-03T10:09:00.000Z")).toBe("2026-11-03T10:00:00.000Z");
    expect(tick("*/10 * * * *", "2026-11-03T00:05:00.000Z")).toBe("2026-11-03T00:00:00.000Z");
  });

  it('"0 */6 * * *"', () => {
    expect(tick("0 */6 * * *", "2026-11-03T05:59:00.000Z")).toBe("2026-11-03T00:00:00.000Z");
    expect(tick("0 */6 * * *", "2026-11-03T23:59:00.000Z")).toBe("2026-11-03T18:00:00.000Z");
    expect(tick("0 */6 * * *", "2026-11-03T06:00:00.000Z")).toBe("2026-11-03T06:00:00.000Z");
  });

  it('"17 3,15 * * *"', () => {
    expect(tick("17 3,15 * * *", "2026-11-03T03:16:59.000Z")).toBe("2026-11-02T15:17:00.000Z");
    expect(tick("17 3,15 * * *", "2026-11-03T20:00:00.000Z")).toBe("2026-11-03T15:17:00.000Z");
  });

  it("at exactly a tick returns that tick", () => {
    expect(tick("17 3,15 * * *", "2026-11-03T03:17:00.000Z")).toBe("2026-11-03T03:17:00.000Z");
    expect(tick("0 0,12 * * *", "2026-11-03T00:00:00.000Z")).toBe("2026-11-03T00:00:00.000Z");
    // Seconds within the tick's minute still belong to it.
    expect(tick("17 3,15 * * *", "2026-11-03T03:17:42.500Z")).toBe("2026-11-03T03:17:00.000Z");
  });

  it("ranges, lists of ranges and stepped ranges", () => {
    expect(tick("0 9-17/4 * * *", "2026-11-03T16:00:00.000Z")).toBe("2026-11-03T13:00:00.000Z"); // 9, 13, 17
    expect(tick("0 9-17/4 * * *", "2026-11-03T08:00:00.000Z")).toBe("2026-11-02T17:00:00.000Z");
    expect(tick("0,30 8-10 * * *", "2026-11-03T12:00:00.000Z")).toBe("2026-11-03T10:30:00.000Z");
    expect(tick("5-20/5,45 * * * *", "2026-11-03T12:44:00.000Z")).toBe("2026-11-03T12:20:00.000Z");
  });

  it("day of month, month and day of week (0 and 7 are both Sunday)", () => {
    expect(tick("0 0 15 * *", "2026-11-03T10:00:00.000Z")).toBe("2026-10-15T00:00:00.000Z");
    expect(tick("0 0 1 1 *", "2026-11-03T10:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(tick("0 0 * * 0", "2026-11-03T10:00:00.000Z")).toBe("2026-11-01T00:00:00.000Z");
    expect(tick("0 0 * * 7", "2026-11-03T10:00:00.000Z")).toBe("2026-11-01T00:00:00.000Z");
    expect(tick("0 0 * * 1-5", "2026-11-01T10:00:00.000Z")).toBe("2026-10-30T00:00:00.000Z");
    // The 31st of a month that has 31 days.
    expect(tick("0 0 31 * *", "2026-11-03T10:00:00.000Z")).toBe("2026-10-31T00:00:00.000Z");
  });

  it("day of month and day of week both restricted: either one matches (the usual OR rule)", () => {
    // 12:00 on the 1st, or on a Friday.
    expect(tick("0 12 1 * 5", "2026-10-31T00:00:00.000Z")).toBe("2026-10-30T12:00:00.000Z"); // Friday the 30th
    expect(tick("0 12 1 * 5", "2026-11-01T13:00:00.000Z")).toBe("2026-11-01T12:00:00.000Z"); // the 1st, a Sunday
    expect(tick("0 12 1 * 5", "2026-11-03T10:00:00.000Z")).toBe("2026-11-01T12:00:00.000Z");
    // A field that starts with "*" counts as unrestricted, so the two must both match.
    expect(tick("0 0 */2 * 1", "2026-11-03T10:00:00.000Z")).toBe("2026-10-19T00:00:00.000Z"); // the 19th: odd, a Monday
  });

  it("every Fineprint schedule (cronForIndex) has a tick within the last 12 hours", () => {
    const at = new Date("2026-11-03T10:00:00.000Z");
    for (let n = 0; n < 24; n++) {
      const t = lastTickAtOrBefore(cronForIndex(n), at);
      expect(t, cronForIndex(n)).not.toBeNull();
      expect(at.getTime() - t!.getTime(), cronForIndex(n)).toBeLessThanOrEqual(12 * 3_600_000);
    }
  });

  it("is null when no tick falls within the bounded search (about 400 days back)", () => {
    expect(tick("0 0 30 2 *", "2026-11-03T10:00:00.000Z")).toBeNull(); // 30 February never comes
    expect(tick("0 0 29 2 *", "2026-11-03T10:00:00.000Z")).toBeNull(); // 29 February 2024 is too far back
    expect(tick("0 0 29 2 *", "2028-03-01T00:00:00.000Z")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("is null for a cron it cannot parse", () => {
    for (const cron of [
      "",
      "* * * *",
      "* * * * * *",
      "61 * * * *",
      "0 24 * * *",
      "0 0 0 * *",
      "0 0 32 * *",
      "0 0 * 13 *",
      "0 0 * 0 *",
      "0 0 * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "1,,2 * * * *",
      "a b c d e",
      "0 0 * JAN *",
      "0 0 * * MON",
      "-1 * * * *",
      "1.5 * * * *",
      "0/5 * * * *",
    ]) {
      expect(lastTickAtOrBefore(cron, new Date("2026-11-03T10:00:00.000Z")), JSON.stringify(cron)).toBeNull();
    }
  });

  it("tolerates extra whitespace between fields", () => {
    expect(tick("  0   0,12 *  * *  ", "2026-11-03T13:00:00.000Z")).toBe("2026-11-03T12:00:00.000Z");
  });
});
