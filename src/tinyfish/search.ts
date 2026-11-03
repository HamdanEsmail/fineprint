// TinySearch: finds the fine-print pages of a domain. Free (12,000 requests a day).
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { tinyfishFetch } from "./client";

const SEARCH_API = "https://api.search.tinyfish.ai";
const SEARCH_PURPOSE = "find the fine-print pages of a website";

export type FinePrintKind = "pricing" | "policy" | "fees" | "other";
export type FinePrintHit = { url: string; title: string; kind: FinePrintKind };

// Query order matters: when two queries find the same URL, the first one names its kind.
const QUERIES: readonly { query: string; kind: FinePrintKind }[] = [
  { query: "pricing plans", kind: "pricing" },
  { query: "terms of service", kind: "policy" },
  { query: "privacy policy", kind: "policy" },
  { query: "fees and charges", kind: "fees" },
];

async function searchOnce(env: Env, domain: string, query: string): Promise<{ url: string; title: string }[]> {
  const u = new URL(SEARCH_API);
  u.searchParams.set("query", query);
  u.searchParams.set("include_domains", domain);
  u.searchParams.set("purpose", SEARCH_PURPOSE);
  const res = await tinyfishFetch(env, u.toString(), {
    method: "GET",
    spend: { kind: "search", amountUsd: PRICES.search, ref: domain },
  });
  // Shape confirmed live: { query, results: [{ position, site_name, snippet, title, url, date? }], total_results, page }
  const body = (await res.json()) as { results?: unknown };
  if (!Array.isArray(body.results)) return [];
  const hits: { url: string; title: string }[] = [];
  for (const r of body.results as Record<string, unknown>[]) {
    if (r === null || typeof r !== "object" || typeof r.url !== "string" || r.url === "") continue;
    hits.push({ url: r.url, title: typeof r.title === "string" ? r.title : "" });
  }
  return hits;
}

export async function discoverFinePrint(env: Env, domain: string): Promise<FinePrintHit[]> {
  const perQuery = await Promise.all(QUERIES.map((q) => searchOnce(env, domain, q.query)));
  const seen = new Set<string>();
  const out: FinePrintHit[] = [];
  perQuery.forEach((hits, i) => {
    for (const hit of hits) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      out.push({ url: hit.url, title: hit.title, kind: QUERIES[i]!.kind });
    }
  });
  return out;
}
