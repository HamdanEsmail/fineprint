// POST /api/discover: finds the fine-print pages of a domain with TinySearch (free) and says which
// of them Fineprint already watches. Public, so it is rate limited: a public caller gets ten
// lookups a day (the admin has no limit). Nothing here creates a page or a Monitor. The site's
// watchlist (`GET /watchlist?domain=`) calls the same discover(), with the same limit.
import { Hono } from "hono";
import { isAdmin } from "../auth";
import { DISCOVER_PER_IP_PER_DAY } from "../core/limits";
import { claimPublicAdd, releasePublicAdd } from "../db/publicAdds";
import type { PageStatus } from "../db/types";
import type { Env } from "../env";
import { searchFinePrint, type FinePrintKind } from "../tinyfish/search";
import { codeOf, isPrivateHost, logError, readBody, visitorHash, type AddCaller } from "./pages";

export const discoverRouter = new Hono<{ Bindings: Env }>();

discoverRouter.onError((err, c) => {
  logError("discover handler failed", err);
  return c.json({ error: "internal_error" }, 500);
});

// At least two labels, letters and digits and inner hyphens, and a last label that is not all
// digits (that is what an IPv4 address looks like, however it was written). The url parser has
// already lower-cased the host and turned an internationalized name into its ASCII form.
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The public hostname in what the caller sent (a bare hostname or a url), or null. Anything
 * that is not a name on the public internet is refused with the rules `POST /api/pages` uses:
 * IP addresses, single-label names, loopback, private ranges and local names.
 */
function parseDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.replace(/\.$/, "");
  if (!HOSTNAME.test(host) || /^\d+$/.test(host.slice(host.lastIndexOf(".") + 1))) return null;
  return isPrivateHost(host) ? null : host;
}

/** A url as pages are stored (and so as duplicates are found): canonical, without the fragment. */
function storedForm(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return raw;
  }
}

/** A page Fineprint has, of any status: the url is unique, so one no longer watched cannot be added again either. */
export type KnownPage = { id: string; url: string; status: PageStatus };

/** One page the search found, with the page Fineprint already has at that url (null when it has none). */
export type DiscoverResult = {
  url: string;
  title: string;
  snippet: string;
  kind: FinePrintKind;
  watched: { id: string; status: PageStatus } | null;
};

/** A lookup's answer: the hostname searched and what was found, or the status and error code `POST /api/discover` answers with. */
export type DiscoverAnswer =
  | { ok: true; domain: string; results: DiscoverResult[] }
  | { ok: false; status: 400 | 429 | 502; error: string; reason?: string };

async function lookup(env: Env, domain: string, known: readonly KnownPage[] | undefined): Promise<DiscoverAnswer> {
  let hits: Awaited<ReturnType<typeof searchFinePrint>>;
  try {
    hits = await searchFinePrint(env, domain);
  } catch (err) {
    logError("discover: search failed", err);
    return { ok: false, status: 502, error: "search_failed", reason: codeOf(err) };
  }
  const pages = known ?? (await env.DB.prepare("SELECT id, url, status FROM pages").all<KnownPage>()).results;
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  return {
    ok: true,
    domain,
    results: hits.map((h) => {
      const page = byUrl.get(storedForm(h.url));
      return { ...h, watched: page === undefined ? null : { id: page.id, status: page.status } };
    }),
  };
}

/**
 * Finds the fine-print pages of `rawDomain` (a hostname or a url, as sent), for `POST /api/discover` and the
 * site's watchlist alike. A public caller's lookup is taken before the search, in one statement, so parallel
 * requests cannot pass the limit together, and given back unless the lookup answered; the admin has no limit.
 * `known` is the pages the caller has already read (the watchlist has them); without it they are read here.
 */
export async function discover(env: Env, rawDomain: unknown, caller: AddCaller, known?: readonly KnownPage[]): Promise<DiscoverAnswer> {
  const domain = parseDomain(rawDomain);
  if (!domain) return { ok: false, status: 400, error: "invalid_domain" };
  if (caller.admin) return lookup(env, domain, known);

  const db = env.DB;
  const key = "discover:" + (await caller.ipHash());
  if (!(await claimPublicAdd(db, key, DISCOVER_PER_IP_PER_DAY))) {
    return { ok: false, status: 429, error: "daily_limit", reason: "Ten discover lookups per day per visitor" };
  }
  let answer: DiscoverAnswer | undefined;
  try {
    answer = await lookup(env, domain, known);
    return answer;
  } finally {
    if (!answer?.ok) {
      try {
        await releasePublicAdd(db, key);
      } catch (err) {
        logError("discover: giving back the daily lookup failed", err);
      }
    }
  }
}

discoverRouter.post("/", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const answer = await discover(c.env, body.domain, { admin: isAdmin(c), ipHash: () => visitorHash(c) });
  if (!answer.ok) {
    return c.json(answer.reason === undefined ? { error: answer.error } : { error: answer.error, reason: answer.reason }, answer.status);
  }
  return c.json({
    candidates: answer.results.map((r) => ({ url: r.url, title: r.title, kind: r.kind, already_watched: r.watched !== null })),
  });
});
