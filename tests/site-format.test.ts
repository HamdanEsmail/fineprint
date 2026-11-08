import { describe, expect, it } from "vitest";
import type { Stats } from "../src/readModel";
import { EvidenceLine } from "../src/site/components";
import {
  checksRun,
  costLine,
  daysSince,
  formatDate,
  formatUsd,
  formatUtc,
  liveLine,
  plural,
  sourceLabel,
  spendMeter,
  stampFor,
  triggerLabel,
  unitBeside,
  webHref,
} from "../src/site/format";

describe("site formatters", () => {
  it("leaves out a unit the price already says", () => {
    expect(unitBeside("$20", "per month")).toBe("per month");
    expect(unitBeside("$1 per 1,000", "per 1,000")).toBe("");
    expect(unitBeside("1M / month included", "per month")).toBe("");
    expect(unitBeside("$0.25 / million tokens", "per million tokens")).toBe("");
    expect(unitBeside("$10 / project / month", "per month")).toBe("");
    expect(unitBeside("$20/month", "per month")).toBe("");
    expect(unitBeside("$20", "")).toBe("");
    expect(unitBeside("Custom", "per seat")).toBe("per seat");
  });

  it("writes times as UTC, day first, with no relative time", () => {
    expect(formatUtc("2026-11-05T09:12:44.120Z")).toBe("5 Nov 2026, 09:12 UTC");
    expect(formatUtc("2026-01-30T23:59:59.999Z")).toBe("30 Jan 2026, 23:59 UTC");
    expect(formatUtc("2026-11-05T12:15:00+03:00")).toBe("5 Nov 2026, 09:15 UTC");
  });

  it("writes money with two decimals", () => {
    expect(formatUsd(3.1)).toBe("$3.10");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.206667)).toBe("$0.21");
    expect(formatUsd(12)).toBe("$12.00");
  });

  it("chooses one or many", () => {
    expect(plural(1, "page")).toBe("1 page");
    expect(plural(2, "page")).toBe("2 pages");
    expect(plural(0, "page")).toBe("0 pages");
    expect(plural(1, "was", "were")).toBe("1 was");
    expect(plural(3, "was", "were")).toBe("3 were");
  });

  it("writes a date alone, in UTC", () => {
    expect(formatDate("2026-11-03T14:17:38.543Z")).toBe("3 Nov 2026");
    expect(formatDate("2026-11-04T23:59:59.999Z")).toBe("4 Nov 2026");
    expect(formatDate("2026-11-05T01:15:00+03:00")).toBe("4 Nov 2026");
    expect(formatDate("not a time")).toBe("not a time");
  });

  it("counts whole days of recording, at least one", () => {
    const since = "2026-11-03T14:17:38.543Z";
    expect(daysSince(since, Date.parse("2026-11-03T15:00:00.000Z"))).toBe(1);
    expect(daysSince(since, Date.parse("2026-11-05T14:17:38.542Z"))).toBe(1);
    expect(daysSince(since, Date.parse("2026-11-05T14:17:38.543Z"))).toBe(2);
    expect(daysSince(since, Date.parse("2026-11-07T13:00:00.000Z"))).toBe(3);
    // A clock behind the record still says one day, never zero or less.
    expect(daysSince(since, Date.parse("2026-11-01T00:00:00.000Z"))).toBe(1);
  });

  const stats = (over: Partial<Stats> = {}): Stats =>
    ({
      recording_since: "2026-11-03T14:17:38.543Z",
      monitors: { active: 20, paused: 0, failed: 0, expired: 0, retired: 1 },
      changes: 11,
      runs_by_trigger: { create: 20, webhook: 143, pull: 7 },
      noise_suppressed: 8,
      spend_usd: 3.435,
      ...over,
    }) as Stats;

  it("writes the home's live line from the stats, one or many for every count", () => {
    expect(checksRun(stats())).toBe(150);
    expect(liveLine(stats())).toBe("Recording since 3 Nov 2026 · 20 pages · 11 real changes · 150 checks · 8 noise events filtered");
    expect(
      liveLine(
        stats({
          monitors: { active: 1, paused: 0, failed: 0, expired: 0, retired: 0 },
          changes: 1,
          runs_by_trigger: { create: 1, webhook: 1, pull: 0 },
          noise_suppressed: 1,
        }),
      ),
    ).toBe("Recording since 3 Nov 2026 · 1 page · 1 real change · 1 check · 1 noise event filtered");
    expect(liveLine(stats({ recording_since: null }))).toBe("Not recording yet: no page has been added.");
  });

  it("puts the paused pages right after the pages part of the live line, only while any is paused", () => {
    expect(liveLine(stats({ monitors: { active: 1, paused: 20, failed: 0, expired: 0, retired: 1 } }))).toBe(
      "Recording since 3 Nov 2026 · 1 page · 20 paused · 11 real changes · 150 checks · 8 noise events filtered",
    );
    expect(liveLine(stats({ monitors: { active: 0, paused: 1, failed: 0, expired: 0, retired: 0 } }))).toBe(
      "Recording since 3 Nov 2026 · 0 pages · 1 paused · 11 real changes · 150 checks · 8 noise events filtered",
    );
    expect(liveLine(stats())).not.toContain("paused");
  });

  it("writes the cost line, with a cost per real change only when there is one, and the two caps", () => {
    expect(costLine(stats())).toBe("TinyFish spend so far $3.44 · $0.31 per real change · caps at $6 and $8 by design.");
    expect(costLine(stats({ spend_usd: 0.3, changes: 0 }))).toBe("TinyFish spend so far $0.30 · caps at $6 and $8 by design.");
    expect(costLine(stats({ spend_usd: 0.3, changes: 1 }))).toBe("TinyFish spend so far $0.30 · $0.30 per real change · caps at $6 and $8 by design.");
  });

  it("links only http and https sources, and shows anything else as text", async () => {
    expect(webHref("https://example.com/pricing")).toBe("https://example.com/pricing");
    expect(webHref("http://example.com/")).toBe("http://example.com/");
    expect(webHref("javascript:alert(1)")).toBeNull();
    expect(webHref("JavaScript:alert(1)")).toBeNull();
    expect(webHref("data:text/html,<b>x</b>")).toBeNull();
    expect(webHref("not a url")).toBeNull();
    expect(sourceLabel("javascript:alert(1)")).toBe("javascript:alert(1)");

    const render = async (url: string): Promise<string> =>
      String(await EvidenceLine({ url, readAt: "2026-11-05T09:12:44.120Z", trigger: "webhook" }).toString());
    expect(await render("javascript:alert(1)")).toBe(
      '<p class="evidence">Source: javascript:alert(1) · read 5 Nov 2026, 09:12 UTC · Monitor (webhook)</p>',
    );
    expect(await render("https://example.com/pricing")).toBe(
      '<p class="evidence">Source: <a href="https://example.com/pricing">example.com/pricing</a> · read 5 Nov 2026, 09:12 UTC · Monitor (webhook)</p>',
    );
  });

  it("writes the spend meter, with a cost per catch only when there is a catch", () => {
    expect(spendMeter({ spend_usd: 3.1, changes: 15, cost_per_catch_usd: 0.206667 } as Stats)).toBe(
      "TinyFish spend $3.10 · 15 real changes · $0.21 per catch",
    );
    expect(spendMeter({ spend_usd: 0.3, changes: 0, cost_per_catch_usd: null } as Stats)).toBe("TinyFish spend $0.30 · 0 real changes");
    expect(spendMeter({ spend_usd: 0.3, changes: 1, cost_per_catch_usd: 0.3 } as Stats)).toBe(
      "TinyFish spend $0.30 · 1 real change · $0.30 per catch",
    );
    // Per catch is over the changes the line shows (retired pages left out), so the line adds up as read.
    expect(spendMeter({ spend_usd: 3.12, changes: 5, cost_per_catch_usd: 0.52 } as Stats)).toBe(
      "TinyFish spend $3.12 · 5 real changes · $0.62 per catch",
    );
  });

  it("labels a source by host and path, without scheme, query or trailing slash, cut at 48 characters", () => {
    expect(sourceLabel("https://docs.claude.com/en/release-notes/overview?utm=1")).toBe("docs.claude.com/en/release-notes/overview");
    expect(sourceLabel("https://openai.com/api/pricing/")).toBe("openai.com/api/pricing");
    expect(sourceLabel("https://vercel.com/pricing#pro")).toBe("vercel.com/pricing");
    expect(sourceLabel("https://example.com/")).toBe("example.com");
    const long = sourceLabel("https://www.example-airline.com/en-gb/travel-information/baggage/checked-baggage-fees");
    expect(long).toHaveLength(48);
    expect(long.endsWith("…")).toBe(true);
    expect(long.startsWith("www.example-airline.com/en-gb/travel-informatio")).toBe(true);
    expect(sourceLabel("not a url")).toBe("not a url");
  });

  it("names how a version was read", () => {
    expect(triggerLabel("create")).toBe("Monitor (baseline)");
    expect(triggerLabel("webhook")).toBe("Monitor (webhook)");
    expect(triggerLabel("pull")).toBe("Monitor (pulled)");
  });

  it("stamps the header RECORDING while any Monitor is active, at the budget line too, and PAUSED when none is", () => {
    expect(stampFor({ monitors: { active: 20 }, spend_paused: false } as Stats)).toEqual({ text: "RECORDING", live: true });
    expect(stampFor({ monitors: { active: 20 }, spend_paused: true } as Stats)).toEqual({ text: "RECORDING", live: true });
    expect(stampFor({ monitors: { active: 0 }, spend_paused: false } as Stats)).toEqual({ text: "PAUSED", live: false });
    expect(stampFor({ monitors: { active: 0 }, spend_paused: true } as Stats)).toEqual({ text: "PAUSED", live: false });
  });
});
