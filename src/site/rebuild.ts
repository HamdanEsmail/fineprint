// Rebuilding one stored screen on demand (POST /api/admin/rebuild-html): the site route renders it exactly as
// for a visitor, in a mode no request can ask for (the env value HTML_CACHE "rebuild", set here only), which
// skips the stored copy and writes the fresh one. Nothing about rendering is repeated.
import type { Env } from "../env";
import { parseScreenKey, storedKey } from "./htmlCache";
import { siteEnabled, siteRouter } from "./router";

/** The site path that renders the screen under `key`, or null for a key that is not one of the five kinds. */
export function pathForKey(key: string): string | null {
  const screen = parseScreenKey(key);
  if (screen === null) return null;
  switch (screen.kind) {
    case "home":
      return "/";
    case "about":
      return "/about";
    case "watchlist":
      return "/watchlist";
    case "page":
      return `/pages/${encodeURIComponent(screen.pageId)}`;
    case "compare":
      return `/pages/${encodeURIComponent(screen.pageId)}/compare?from=${encodeURIComponent(screen.fromVersionId)}&to=${encodeURIComponent(screen.toVersionId)}`;
  }
}

/** Renders the screen fresh and stores it; true when a copy was written. False for a screen that is not stored (a 404, a page still refreshing). */
export async function rebuildScreen(env: Env, origin: string, key: string): Promise<boolean | null> {
  const path = pathForKey(key);
  if (path === null) return null;
  if (!siteEnabled(env)) return false;
  const startedAt = Date.now();
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (work: Promise<unknown>) => void pending.push(work), passThroughOnException: () => {} } as unknown as ExecutionContext;
  const res = await siteRouter.fetch(new Request(origin + path), { ...env, HTML_CACHE: "rebuild" }, ctx);
  await res.arrayBuffer();
  await Promise.all(pending);
  if (res.headers.get("x-fineprint-cache") !== "miss") return false;
  const head = await env.STORE.head(storedKey(env, key));
  return head !== null && head.uploaded.getTime() >= startedAt - 1000;
}
