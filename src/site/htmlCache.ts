// A stored copy of the screens a visitor is likely to open, kept in R2 under html/<key>. The key comes from the
// screen's identity (never the raw query string); the object carries the headers a fresh render sends, so a
// replay is the same response. Writing happens off the response path; a failed read or write is a miss.
import type { Env } from "../env";

export const CACHE_HEADER = "x-fineprint-cache";
const PREFIX = "html/";
/** The headers a fresh render sends, replayed from the stored copy. */
const KEPT_HEADERS = ["content-type", "content-security-policy", "x-content-type-options", "referrer-policy", "cache-control"];

export const cacheKey = {
  home: () => "home",
  about: () => "about",
  watchlist: () => "watchlist",
  page: (pageId: string) => `page/${pageId}`,
  compare: (pageId: string, fromVersionId: string, toVersionId: string) => `compare/${pageId}/${fromVersionId}/${toVersionId}`,
} as const;

/** True when the request carries no query parameter outside `allowed`: any other parameter makes it a screen of its own. */
export function onlyParams(url: string, allowed: readonly string[] = []): boolean {
  for (const name of new URL(url).searchParams.keys()) if (!allowed.includes(name)) return false;
  return true;
}

/** The stored copy of `key` as a response marked `hit`, or null (also when R2 fails). */
export async function readCached(env: Env, key: string): Promise<Response | null> {
  try {
    const object = await env.STORE.get(PREFIX + key);
    if (object === null) return null;
    const headers = new Headers(JSON.parse(object.customMetadata?.headers ?? "{}") as Record<string, string>);
    headers.set(CACHE_HEADER, "hit");
    return new Response(object.body, { status: 200, headers });
  } catch (err) {
    console.error("html cache read failed", err instanceof Error ? err.name : "unknown error");
    return null;
  }
}

/**
 * Marks a fresh render `miss` and, when `store` holds and the request is a GET, saves a copy after the response
 * is sent. `schedule` is the execution context's waitUntil.
 */
export function markMiss(
  env: Env,
  schedule: (work: Promise<unknown>) => void,
  method: string,
  key: string,
  res: Response,
  store: boolean,
): Response {
  const out = new Response(res.body, res);
  out.headers.set(CACHE_HEADER, "miss");
  if (!store || method !== "GET" || res.status !== 200) return out;
  const copy = out.clone();
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = out.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  schedule(
    copy
      .text()
      .then((html) => env.STORE.put(PREFIX + key, html, { customMetadata: { headers: JSON.stringify(headers) } }))
      .catch((err) => console.error("html cache write failed", err instanceof Error ? err.name : "unknown error")),
  );
  return out;
}

/** R2 deletes at most this many keys in one call. */
const DELETE_BATCH = 1000;

/** Every key under html/<prefix>, without the html/ (listed up to 1,000 at a time). */
async function keysUnder(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.STORE.list({ prefix: PREFIX + prefix, cursor });
    for (const o of listed.objects) keys.push(o.key.slice(PREFIX.length));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

/**
 * A new summary or delta for versions of these pages: drops the home feed, About, each page's view and every
 * compare of each page. For one page that is two R2 calls (one list, one delete). Never throws.
 */
export async function dropCachedPages(env: Env, pageIds: string[]): Promise<void> {
  if (pageIds.length === 0) return;
  try {
    const keys = [cacheKey.home(), cacheKey.about(), ...pageIds.map(cacheKey.page)];
    for (const id of pageIds) keys.push(...(await keysUnder(env, `compare/${id}/`)));
    for (let i = 0; i < keys.length; i += DELETE_BATCH) await env.STORE.delete(keys.slice(i, i + DELETE_BATCH).map((k) => PREFIX + k));
  } catch (err) {
    console.error("html cache drop failed", err instanceof Error ? err.name : "unknown error");
  }
}

/** The watchlist changed (an add, a retirement, an expiry, a deletion): drops it, the home feed and About, and the page's own view when given. One R2 call. */
export function dropCachedWatchlist(env: Env, pageId?: string): Promise<void> {
  return dropCached(env, [cacheKey.watchlist(), cacheKey.home(), cacheKey.about(), ...(pageId === undefined ? [] : [cacheKey.page(pageId)])]);
}

/** Removes stored copies (the seam for invalidation); a failure is logged, never thrown. */
export async function dropCached(env: Env, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await env.STORE.delete(keys.map((key) => PREFIX + key));
  } catch (err) {
    console.error("html cache delete failed", err instanceof Error ? err.name : "unknown error");
  }
}
