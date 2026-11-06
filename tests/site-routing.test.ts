import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

// The site shares the Worker with the recorder. These tests hold the line between them: the API and
// the hooks answer as they always did, static files are served before the Worker, and with the site
// switched off every site path answers exactly as the Worker did before the site existed.

/**
 * The Worker as production reaches it: through its own service binding (wrangler.jsonc `services`),
 * which miniflare routes through the static-asset router first, as Cloudflare does for a request
 * from outside. `SELF` from cloudflare:test calls the Worker's entry directly and never sees a
 * static file, so it cannot tell whether the assets block shadows a route.
 */
const SELF = { fetch: (url: string, init?: RequestInit): Promise<Response> => env.SELF.fetch(url, init) };

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** The Worker called in-process with the site switched off (the production default until it goes live). */
async function siteOff(path: string, init?: RequestInit): Promise<Response> {
  const offEnv = { ...env, SITE_ENABLED: "0" } as Env;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(new URL(path, "https://x").href, init), offEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("site routing", () => {
  it("leaves the API and the hooks alone", async () => {
    const api = await SELF.fetch("https://x/api/pages/nope");
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
    const hook = await SELF.fetch("https://x/hooks/monitor/wrong-secret", { method: "POST", body: "{}" });
    expect(hook.status).not.toBe(405);
    expect(hook.headers.get("content-type") ?? "").not.toContain("text/html");
    // The webhook handler itself answered: a wrong secret gets its empty 404, not the JSON 404 of a
    // path no route matched.
    expect(hook.status).toBe(404);
    expect(hook.headers.get("content-type") ?? "").not.toContain("application/json");
    expect(await hook.text()).toBe("");
  });

  it("answers an unknown API or hooks path with a JSON 404, never the ledger page", async () => {
    for (const path of ["/api/no-such-route", "/api", "/hooks/no-such-hook"]) {
      const res = await SELF.fetch(`https://x${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain("application/json");
      expect(await res.json(), path).toEqual({ error: "not_found" });
    }
  });

  it("serves the stylesheet as a static file and unknown routes as the ledger 404", async () => {
    const css = await SELF.fetch("https://x/assets/tokens.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const miss = await SELF.fetch("https://x/no/such/screen");
    expect(miss.status).toBe(404);
    expect(miss.headers.get("content-type")).toContain("text/html");
    const body = await miss.text();
    expect(body).toContain("No such page in the ledger.");
    expect(body).toContain('href="/"');
  });

  it("serves the other static files", async () => {
    for (const [path, type] of [
      ["/assets/site.css", "text/css"],
      ["/robots.txt", "text/plain"],
      ["/favicon.svg", "image/svg+xml"],
    ] as const) {
      const res = await SELF.fetch(`https://x${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type);
      await res.arrayBuffer();
    }
  });

  it("sends the security headers on HTML", async () => {
    const home = await SELF.fetch("https://x/");
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(home.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(home.headers.get("content-security-policy")).toBe(CSP);
    expect(home.headers.get("x-content-type-options")).toBe("nosniff");
    expect(home.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const html = await home.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // no inline script
    expect(html).not.toMatch(/<style[\s>]/); // no inline style element

    const miss = await SELF.fetch("https://x/no/such/screen");
    expect(miss.headers.get("content-security-policy")).toBe(CSP);
    expect(miss.headers.get("x-content-type-options")).toBe("nosniff");
    expect(miss.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    await miss.text();
  });

  it("renders the ledger 404 without a single database read, with the security headers", async () => {
    const reads = [vi.spyOn(env.DB, "prepare"), vi.spyOn(env.DB, "batch"), vi.spyOn(env.DB, "exec")];
    try {
      for (const path of ["/wp-login.php", "/.env", "/apple-touch-icon.png", "/no/such/screen"]) {
        const ctx = createExecutionContext();
        const res = await worker.fetch(new Request(`https://x${path}`), env, ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status, path).toBe(404);
        expect(res.headers.get("content-type"), path).toContain("text/html");
        expect(res.headers.get("content-security-policy"), path).toBe(CSP);
        expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
        const html = await res.text();
        expect(html, path).toContain("No such page in the ledger.");
        // No stats, so no stamp and no spend meter; the footer keeps its links.
        expect(html, path).not.toContain("RECORDING");
        expect(html, path).not.toContain("TinyFish spend");
        expect(html, path).toContain('href="/api/export.json"');
      }
      for (const spy of reads) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of reads) spy.mockRestore();
    }
  });

  it("answers as before when the site is switched off", async () => {
    // Hono's own 404, as the deployed Worker gives it today for any path no route matches.
    for (const path of ["/", "/watchlist", "/no/such/screen", "/?before=2026-11-05T09:12:00.000Z"]) {
      const res = await siteOff(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toBe("text/plain; charset=UTF-8");
      expect(await res.text(), path).toBe("404 Not Found");
    }
    // The JSON 404 for the API and the hooks is the same in both states.
    const api = await siteOff("/api/no-such-route");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not_found" });
    // And the API itself still answers.
    const stats = await siteOff("/api/stats");
    expect(stats.status).toBe(200);
    expect(stats.headers.get("content-type")).toContain("application/json");
  });
});
