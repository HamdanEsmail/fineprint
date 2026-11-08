// A stored copy of the screens a visitor is likely to open, kept in R2 under screens/<stamp>/<key>. The stamp is
// the deploy's (the Worker version id, wrangler.jsonc `version_metadata`), so a deploy that changes the markup
// starts with no copies instead of serving the old markup for up to a day, and a preview version never shares a
// copy with production. The key comes from the screen's identity (never the raw query string); the object carries
// the headers a fresh render sends, so a replay is the same response. Writing happens off the response path; a
// failed read or write is a miss.
//
// R2 also holds each version's HTML source at html/<versionId>.html, under the prefix the copies used before the
// stamp (html/<key>). Every delete here goes through one guard that refuses any key or listing prefix that is not a
// stored screen, so nothing ever lists or deletes under html/ broadly and a version's source can never be removed.
import type { Env } from "../env";

export const CACHE_HEADER = "x-fineprint-cache";
/** Where the stored screens live: screens/<stamp>/<key>, and the marker below. Nothing else is kept under it. */
const ROOT = "screens/";
/** The stamp the hourly job last cleaned up for (see sweepStoredScreens). */
export const STAMP_MARKER = "screens/stamp";
/** The copies kept before the stamp (html/<key>), beside the version sources (html/<versionId>.html). */
const LEGACY_ROOT = "html/";
/** A stamp as a key segment: a version id (a UUID), or the fallback below. */
const STAMP_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
/** The stamp of a Worker that runs without the version metadata binding. */
const NO_VERSION = "unversioned";
/** A stored copy older than this is not served. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The headers a fresh render sends, replayed from the stored copy. */
const KEPT_HEADERS = ["content-type", "content-security-policy", "x-content-type-options", "referrer-policy", "cache-control"];

export const cacheKey = {
  home: () => "home",
  about: () => "about",
  watchlist: () => "watchlist",
  page: (pageId: string) => `page/${pageId}`,
  compare: (pageId: string, fromVersionId: string, toVersionId: string) => `compare/${pageId}/${fromVersionId}/${toVersionId}`,
} as const;

/** One of the five kinds of stored screen, read from its key. */
export type ScreenKey =
  | { kind: "home" | "about" | "watchlist" }
  | { kind: "page"; pageId: string }
  | { kind: "compare"; pageId: string; fromVersionId: string; toVersionId: string };

const FIXED = new Set(["home", "about", "watchlist"]);
const isSegment = (part: string): boolean => part !== "" && part !== "." && part !== "..";

/**
 * The screen a key names, or null for a key that is not one of the five shapes: `home`, `about`, `watchlist`,
 * `page/<pageId>`, `compare/<pageId>/<from>/<to>`. A version source's name (`<versionId>.html`) is none of them.
 */
export function parseScreenKey(key: string): ScreenKey | null {
  const parts = key.split("/");
  if (!parts.every(isSegment)) return null;
  if (parts.length === 1) return FIXED.has(key) ? { kind: key as "home" | "about" | "watchlist" } : null;
  if (parts[0] === "page" && parts.length === 2) return { kind: "page", pageId: parts[1]! };
  if (parts[0] === "compare" && parts.length === 4) {
    return { kind: "compare", pageId: parts[1]!, fromVersionId: parts[2]!, toVersionId: parts[3]! };
  }
  return null;
}

/** This deploy's stamp: the Worker version's id. */
export function deployStamp(env: Env): string {
  const id = env.CF_VERSION_METADATA?.id ?? "";
  return STAMP_SHAPE.test(id) ? id : NO_VERSION;
}

const stampRoot = (stamp: string): string => `${ROOT}${stamp}/`;

/** The R2 key of the stored copy of `key` under this deploy's stamp. */
export const storedKey = (env: Env, key: string): string => stampRoot(deployStamp(env)) + key;

// --- The guard ----------------------------------------------------------------------------------------

/**
 * True for an R2 key that is a stored screen: screens/<stamp>/<one of the five shapes>, or a copy from before the
 * stamp, html/<one of the five shapes>. False for everything else, a version's source html/<versionId>.html first.
 */
export function isStoredScreen(r2Key: string): boolean {
  if (r2Key.startsWith(ROOT)) {
    const rest = r2Key.slice(ROOT.length);
    const cut = rest.indexOf("/");
    return cut > 0 && STAMP_SHAPE.test(rest.slice(0, cut)) && parseScreenKey(rest.slice(cut + 1)) !== null;
  }
  if (r2Key.startsWith(LEGACY_ROOT)) return parseScreenKey(r2Key.slice(LEGACY_ROOT.length)) !== null;
  return false;
}

/**
 * True for a listing prefix that holds stored screens only: one page's compares under a stamp
 * (screens/<stamp>/compare/<pageId>/) or before it (html/compare/<pageId>/), or the whole of an earlier stamp
 * (screens/<stamp>/, never this deploy's own). Anything broader (html/, html/compare/, screens/) is refused.
 */
export function isScreenListing(env: Env, prefix: string): boolean {
  const parts = prefix.split("/");
  if (parts.at(-1) !== "") return false;
  const segments = parts.slice(0, -1);
  if (!segments.every(isSegment)) return false;
  if (segments[0] === "screens" && STAMP_SHAPE.test(segments[1] ?? "")) {
    if (segments.length === 2) return segments[1] !== deployStamp(env);
    return segments.length === 4 && segments[2] === "compare";
  }
  return segments.length === 3 && segments[0] === "html" && segments[1] === "compare";
}

/** R2 deletes at most this many keys in one call. */
const DELETE_BATCH = 1000;

/** Deletes the keys that pass the guard; a refused key is logged by count and left. Throws when R2 does. */
async function deleteScreens(env: Env, r2Keys: string[]): Promise<number> {
  const safe = [...new Set(r2Keys)].filter(isStoredScreen);
  if (safe.length < r2Keys.length) console.error("html cache refused to delete", `${r2Keys.length - safe.length} key(s) that are not stored screens`);
  for (let i = 0; i < safe.length; i += DELETE_BATCH) await env.STORE.delete(safe.slice(i, i + DELETE_BATCH));
  return safe.length;
}

/** Every key under a listing prefix that passes the guard (up to 1,000 a call); none for a refused prefix. Throws when R2 does. */
async function listScreens(env: Env, prefix: string): Promise<string[]> {
  if (!isScreenListing(env, prefix)) {
    console.error("html cache refused to list", "a prefix that is not one page's compares or an earlier stamp");
    return [];
  }
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.STORE.list({ prefix, cursor });
    for (const o of listed.objects) keys.push(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

// --- Serving and storing ---------------------------------------------------------------------------

/** True when the request carries no query parameter outside `allowed`: any other parameter makes it a screen of its own. */
export function onlyParams(url: string, allowed: readonly string[] = []): boolean {
  for (const name of new URL(url).searchParams.keys()) if (!allowed.includes(name)) return false;
  return true;
}

/** The stored copy of `key` as a response marked `hit`, or null (also when R2 fails). */
export async function readCached(env: Env, key: string): Promise<Response | null> {
  try {
    const object = await env.STORE.get(storedKey(env, key));
    if (object === null) return null;
    // A copy older than a day is a miss (rendered, served and stored again): the bound on any change the drops miss.
    const wrote = Number(object.customMetadata?.at) || object.uploaded.getTime();
    if (Date.now() - wrote > MAX_AGE_MS) return null;
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
      .then((html) => env.STORE.put(storedKey(env, key), html, { customMetadata: { headers: JSON.stringify(headers), at: String(Date.now()) } }))
      .catch((err) => console.error("html cache write failed", err instanceof Error ? err.name : "unknown error")),
  );
  return out;
}

// --- Invalidation ----------------------------------------------------------------------------------

/**
 * A new summary or delta for versions of these pages: drops the home feed, About, each page's view and every
 * compare of each page, under this deploy's stamp. For one page that is two R2 calls (one list, one delete). Never throws.
 */
export async function dropCachedPages(env: Env, pageIds: string[]): Promise<void> {
  if (pageIds.length === 0) return;
  try {
    const keys = [cacheKey.home(), cacheKey.about(), ...pageIds.map(cacheKey.page)].map((k) => storedKey(env, k));
    for (const id of pageIds) keys.push(...(await listScreens(env, storedKey(env, `compare/${id}/`))));
    await deleteScreens(env, keys);
  } catch (err) {
    console.error("html cache drop failed", err instanceof Error ? err.name : "unknown error");
  }
}

/** The watchlist changed (an add, a retirement, an expiry, a deletion): drops it, the home feed and About, and the page's own view when given. One R2 call. */
export function dropCachedWatchlist(env: Env, pageId?: string): Promise<void> {
  return dropCached(env, [cacheKey.watchlist(), cacheKey.home(), cacheKey.about(), ...(pageId === undefined ? [] : [cacheKey.page(pageId)])]);
}

/** Removes the stored copies of these screen keys under this deploy's stamp (the seam for invalidation); a failure is logged, never thrown. */
export async function dropCached(env: Env, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await deleteScreens(env, keys.map((key) => storedKey(env, key)));
  } catch (err) {
    console.error("html cache delete failed", err instanceof Error ? err.name : "unknown error");
  }
}

// --- After a deploy -----------------------------------------------------------------------------------

/** What a sweep found and did: this deploy's stamp, the one the marker held before (null: none yet), and the copies deleted. */
export type Sweep = { stamp: string; previous: string | null; deleted: number };

/** The stamp the marker holds, or null when there is none. Throws when R2 does. */
export async function sweptStamp(env: Env): Promise<string | null> {
  const marker = await env.STORE.get(STAMP_MARKER);
  return marker === null ? null : (await marker.text()).trim();
}

/**
 * The hourly job's clean-up after a deploy (POST /api/admin/sweep-screens, from the rebuild step). The marker
 * (screens/stamp) holds the stamp the last sweep was for. The same stamp: nothing to do. Another stamp: that
 * stamp's copies are deleted (screens/<previous>/ holds nothing else), never this deploy's. No marker yet (the
 * deploy that brought the stamp): the copies kept before it are deleted once, by name: html/home, html/about,
 * html/watchlist and html/page/<id> for every page id given, and each page's compares by listing
 * html/compare/<id>/. The marker is written only after the deletes, so a sweep that is cut off runs again on the
 * next tick, and once it is written the html/ clean-up never runs again. Throws when R2 does.
 */
export async function sweepStoredScreens(env: Env, pageIds: () => Promise<string[]>): Promise<Sweep> {
  const stamp = deployStamp(env);
  const previous = await sweptStamp(env);
  if (previous === stamp) return { stamp, previous, deleted: 0 };
  const keys: string[] = [];
  if (previous === null) {
    const ids = await pageIds();
    keys.push(...[cacheKey.home(), cacheKey.about(), cacheKey.watchlist(), ...ids.map(cacheKey.page)].map((k) => LEGACY_ROOT + k));
    for (const id of ids) keys.push(...(await listScreens(env, `${LEGACY_ROOT}compare/${id}/`)));
  } else if (STAMP_SHAPE.test(previous)) {
    keys.push(...(await listScreens(env, stampRoot(previous))));
  }
  const deleted = await deleteScreens(env, keys);
  await env.STORE.put(STAMP_MARKER, stamp);
  return { stamp, previous, deleted };
}
