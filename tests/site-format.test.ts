import { describe, expect, it } from "vitest";
import type { Stats } from "../src/readModel";
import {
  formatUsd,
  formatUtc,
  heroLine,
  plural,
  sourceLabel,
  spendMeter,
  stampFor,
  triggerLabel,
} from "../src/site/format";

describe("site formatters", () => {
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

  it("writes the hero line from the week's count", () => {
    expect(heroLine(0)).toBe("Nothing changed this week.");
    expect(heroLine(1)).toBe("The web changed its mind once this week.");
    expect(heroLine(14)).toBe("The web changed its mind 14 times this week.");
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

  it("stamps the header RECORDING, or PAUSED at the budget line", () => {
    expect(stampFor({ monitors: { active: 20 }, spend_paused: false } as Stats)).toEqual({ text: "RECORDING", live: true });
    expect(stampFor({ monitors: { active: 20 }, spend_paused: true } as Stats)).toEqual({ text: "PAUSED", live: false });
  });
});
