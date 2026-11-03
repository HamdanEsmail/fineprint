// POST /api/discover: finds the fine-print pages of a domain with TinySearch (free) and says which
// of them Fineprint already watches. Public, so it is rate limited: a public caller gets ten
// lookups a day (the admin has no limit). Nothing here creates a page or a Monitor.
import { Hono } from "hono";
import type { Context } from "hono";
import { isAdmin } from "../auth";
import { DISCOVER_PER_IP_PER_DAY } from "../core/limits";
import { hashText } from "../core/normalize";
import { listPages } from "../db/pages";
import { claimPublicAdd, releasePublicAdd } from "../db/publicAdds";
import type { Env } from "../env";
import { discoverFinePrint } from "../tinyfish/search";
import { codeOf, isPrivateHost, logError, readBody } from "./pages";

type AppContext = Context<{ Bindings: Env }>;

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

async function lookup(c: AppContext, domain: string): Promise<Response> {
  let hits: Awaited<ReturnType<typeof discoverFinePrint>>;
  try {
    hits = await discoverFinePrint(c.env, domain);
  } catch (err) {
    logError("discover: search failed", err);
    return c.json({ error: "search_failed", reason: codeOf(err) }, 502);
  }
  // Any page counts, expired ones too: the url is unique, so an expired page cannot be added again.
  const watched = new Set((await listPages(c.env.DB)).map((p) => p.url));
  return c.json({
    candidates: hits.map((h) => ({ url: h.url, title: h.title, kind: h.kind, already_watched: watched.has(storedForm(h.url)) })),
  });
}

discoverRouter.post("/", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const domain = parseDomain(body.domain);
  if (!domain) return c.json({ error: "invalid_domain" }, 400);

  if (isAdmin(c)) return lookup(c, domain);

  // A public caller's lookup is taken before the search, in one statement, so parallel requests
  // cannot pass the limit together, and given back unless the lookup answered.
  const db = c.env.DB;
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const key = "discover:" + (await hashText(ip + c.env.WEBHOOK_SECRET));
  if (!(await claimPublicAdd(db, key, DISCOVER_PER_IP_PER_DAY))) {
    return c.json({ error: "daily_limit", reason: "Ten discover lookups per day per visitor" }, 429);
  }
  let res: Response | undefined;
  try {
    res = await lookup(c, domain);
    return res;
  } finally {
    if (res?.status !== 200) {
      try {
        await releasePublicAdd(db, key);
      } catch (err) {
        logError("discover: giving back the daily lookup failed", err);
      }
    }
  }
});
