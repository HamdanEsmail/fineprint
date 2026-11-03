import { describe, expect, it } from "vitest";
import pages from "../pages.json";

// The curated page list (spec section 6, D4). `scripts/register-pages.mjs` posts these in
// this order and stops after the first 20 that register, so the order is part of the contract.
const KINDS = ["pricing", "fees", "policy", "rules", "other"];

// Spec section 6, items 1 to 28, as written there. The two entries the spec left open
// (item 8 Salik, item 28 RTA nol fares) are checked for host and kind only, below.
const FIXED: Record<number, [url: string, kind: string]> = {
  1: ["https://help.openai.com/en/articles/6825453-chatgpt-release-notes", "rules"],
  2: ["https://docs.claude.com/en/release-notes/overview", "other"],
  3: ["https://developers.cloudflare.com/workers/platform/pricing/", "pricing"],
  4: ["https://www.gov.uk/guidance/visa-decision-waiting-times-applications-outside-the-uk", "rules"],
  5: ["https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html", "rules"],
  6: ["https://www.ryanair.com/gb/en/useful-info/help-centre/fees", "fees"],
  7: ["https://www.emirates.com/ae/english/before-you-fly/baggage/", "rules"],
  9: ["https://openai.com/api/pricing/", "pricing"],
  10: ["https://www.anthropic.com/pricing", "pricing"],
  11: ["https://ai.google.dev/gemini-api/docs/pricing", "pricing"],
  12: ["https://vercel.com/pricing", "pricing"],
  13: ["https://cursor.com/pricing", "pricing"],
  14: ["https://www.notion.com/pricing", "pricing"],
  15: ["https://supabase.com/pricing", "pricing"],
  16: ["https://github.com/pricing", "pricing"],
  17: ["https://help.netflix.com/en/node/24926", "pricing"],
  18: ["https://www.spotify.com/ae/premium/", "pricing"],
  19: ["https://openai.com/policies/terms-of-use/", "policy"],
  20: ["https://openai.com/policies/privacy-policy/", "policy"],
  21: ["https://x.com/en/tos", "policy"],
  22: ["https://www.facebook.com/privacy/policy/", "policy"],
  23: ["https://www.anthropic.com/legal/aup", "policy"],
  24: ["https://developer.apple.com/app-store/review/guidelines/", "rules"],
  25: [
    "https://u.ae/en/information-and-services/visa-and-emirates-id/do-you-need-an-entry-permit-or-a-visa-to-enter-the-uae",
    "rules",
  ],
  26: ["https://home-affairs.ec.europa.eu/policies/schengen-borders-and-visa/visa-policy_en", "rules"],
  27: ["https://www.dewa.gov.ae/en/consumer/billing/slab-tariff", "fees"],
};

describe("pages.json", () => {
  it("has at least 20 unique https urls with valid kinds and labels", () => {
    expect(Array.isArray(pages)).toBe(true);
    expect(pages.length).toBeGreaterThanOrEqual(20);

    const seen = new Set<string>();
    for (const page of pages) {
      expect(Object.keys(page).sort()).toEqual(["kind", "label", "url"]);
      expect(new URL(page.url).protocol).toBe("https:");
      expect(KINDS).toContain(page.kind);
      expect(typeof page.label).toBe("string");
      expect(page.label.trim()).not.toBe("");
      expect(page.label.length).toBeLessThanOrEqual(200); // the API's limit for a label
      expect(seen.has(page.url), `duplicate url ${page.url}`).toBe(false);
      seen.add(page.url);
    }
  });

  it("stores every url in the canonical form the API stores and compares", () => {
    // POST /api/pages keeps `new URL(raw).href` without the fragment; a url written any other
    // way would still register but would make a re-run's duplicate check depend on it.
    for (const page of pages) {
      const url = new URL(page.url);
      expect(url.hash, page.url).toBe("");
      expect(url.href, page.url).toBe(page.url);
    }
  });

  it("holds the 30 entries of spec section 6 in order (D4)", () => {
    expect(pages).toHaveLength(30);
    for (const [index, [url, kind]] of Object.entries(FIXED)) {
      const page = pages[Number(index) - 1]!;
      expect(page.url, `item ${index}`).toBe(url);
      expect(page.kind, `item ${index}`).toBe(kind);
    }
  });

  it("puts the pages chosen during the build where the spec leaves them", () => {
    // Item 8: Dubai tolls, the tariff. TinyFetch answers bot_blocked for every salik.ae page, so
    // the Dubai government's Salik page carries the tariff instead (build log).
    const salik = pages[7]!;
    expect(new URL(salik.url).hostname).toMatch(/(^|\.)(salik|dubai)\.ae$/);
    expect(salik.url.toLowerCase()).toContain("salik");
    expect(salik.kind).toBe("fees");

    const rta = pages[27]!; // item 28: Dubai transport, nol card fares
    expect(new URL(rta.url).hostname).toMatch(/(^|\.)rta\.ae$/);
    expect(rta.kind).toBe("fees");

    // Item 29: two insurance coverage pages, after the 28 above.
    expect(pages.slice(28)).toHaveLength(2);
    for (const page of pages.slice(28)) expect(["policy", "rules"]).toContain(page.kind);
  });

  it("keeps the pricing and fees kinds (the ones that cost Agent steps) to the pages the spec marks", () => {
    const costly = pages.filter((p) => p.kind === "pricing" || p.kind === "fees").length;
    // 3, 6, 8, 9-18, 27, 28 in the spec.
    expect(costly).toBe(15);
  });
});
