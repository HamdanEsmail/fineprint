import { applyD1Migrations, createExecutionContext, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertPage } from "../src/db/pages";
import { insertRun } from "../src/db/runs";
import type { TriggerKind } from "../src/db/types";
import { insertVersion } from "../src/db/versions";
import worker from "../src/index";

// Link previews (submission Task 10.3): every screen's head carries the Open Graph and Twitter card tags, with
// absolute urls built from PUBLIC_BASE_URL (never the request's host), og:url being the screen's canonical
// address without its varying query parameters, and the 1200 by 630 social image served as a static file.

const db = env.DB;
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const BASE = "https://fineprint.test"; // PUBLIC_BASE_URL in vitest.config.ts
const PRODUCTION = "https://fineprint.hamdanesmail12-7a9.workers.dev";

/** The content of the <meta> whose `attr` (property or name) is `key`, or null when there is none (or more than one). */
function meta(html: string, attr: "property" | "name", key: string): string | null {
  const found = [...html.matchAll(new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)"`, "g"))];
  return found.length === 1 ? found[0]![1]!.replaceAll("&amp;", "&") : null;
}

async function get(path: string): Promise<string> {
  const res = await SELF.fetch(`https://preview.example${path}`);
  expect(res.status, path).toBe(200);
  return res.text();
}

/** The Worker with some of its settings replaced. */
async function callWith(path: string, over: Record<string, string>): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://preview.example${path}`), { ...env, ...over }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function version(id: string, pageId: string, at: string, trigger: TriggerKind): Promise<void> {
  const baseline = trigger === "create";
  await insertRun(db, {
    id: `run-${id}`,
    page_id: pageId,
    monitor_run_id: `m-${id}`,
    outcome: baseline ? "baseline" : "changed",
    is_baseline: baseline ? 1 : 0,
    judgment_relevant: null,
    judgment_summary: null,
    diff_truncated: 0,
    noise_suppressed: 0,
    noise_reason: null,
    raw_key: null,
    received_at: at,
    trigger_kind: trigger,
  });
  await insertVersion(db, {
    id,
    page_id: pageId,
    run_id: `run-${id}`,
    is_baseline: baseline ? 1 : 0,
    captured_at: at,
    text: `Plan costs ${id} dollars`,
    normalized_hash: `hash-${id}`,
    judgment_summary: null,
    screenshot_key: `shots/${id}.jpg`,
    html_key: `html/${id}.html`,
    capture_status: "complete",
    facts_status: "not_needed",
  });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await insertPage(db, {
    id: "alpha",
    url: "https://example.com/pricing",
    label: "Alpha pricing",
    kind: "pricing",
    monitor_id: "mon-alpha",
    schedule_cron: "14 2,14 * * *",
    purpose: "watch",
    status: "active",
    added_by: "curated",
    ignore_patterns: "[]",
    expires_at: null,
  });
  await version("a-1", "alpha", ago(3 * HOUR), "create");
  await version("a-2", "alpha", ago(2 * HOUR), "webhook");
  await version("a-3", "alpha", ago(HOUR), "webhook");
});

describe("link previews", () => {
  it("the home's head has every Open Graph and Twitter card tag, with absolute urls", async () => {
    const html = await get("/");
    expect(meta(html, "property", "og:type")).toBe("website");
    expect(meta(html, "property", "og:site_name")).toBe("Fineprint");
    expect(meta(html, "property", "og:title")).toBe("Fineprint: a dated record of the web&#39;s small print");
    expect(meta(html, "property", "og:description")).not.toBeNull();
    expect(meta(html, "property", "og:url")).toBe(`${BASE}/`);
    expect(meta(html, "property", "og:image")).toBe(`${BASE}/assets/social.png`);
    expect(meta(html, "property", "og:image:width")).toBe("1200");
    expect(meta(html, "property", "og:image:height")).toBe("630");
    expect(meta(html, "name", "twitter:card")).toBe("summary_large_image");
    expect(meta(html, "name", "twitter:image")).toBe(`${BASE}/assets/social.png`);
  });

  it("on production the image is the workers.dev social card", async () => {
    const res = await callWith("/", { PUBLIC_BASE_URL: `${PRODUCTION}/` });
    const html = await res.text();
    expect(meta(html, "property", "og:image")).toBe(`${PRODUCTION}/assets/social.png`);
    expect(meta(html, "name", "twitter:image")).toBe(`${PRODUCTION}/assets/social.png`);
    expect(meta(html, "property", "og:url")).toBe(`${PRODUCTION}/`);
  });

  it("og:url is each screen's canonical address, without its varying query parameters", async () => {
    const cases: [string, string][] = [
      ["/?before=2030-01-01T00:00:00Z", "/"],
      ["/about", "/about"],
      ["/about?x=1", "/about"],
      ["/watchlist", "/watchlist"],
      ["/watchlist?url=https://example.com&label=x", "/watchlist"],
      ["/pages/alpha", "/pages/alpha"],
      ["/pages/alpha?v=a-2", "/pages/alpha"],
      ["/pages/alpha?at=2030-01-01&text=1", "/pages/alpha"],
      // A compare is the pair it resolves to, so the default and its explicit form share one address.
      ["/pages/alpha/compare", "/pages/alpha/compare?from=a-2&to=a-3"],
      ["/pages/alpha/compare?to=a-3", "/pages/alpha/compare?from=a-2&to=a-3"],
      ["/pages/alpha/compare?from=a-3&to=a-1&all=1", "/pages/alpha/compare?from=a-1&to=a-3"],
      ["/pages/alpha/compare?from=a-2&to=a-2", "/pages/alpha/compare"],
    ];
    for (const [path, canonical] of cases) {
      const html = await get(path);
      expect(meta(html, "property", "og:url"), path).toBe(`${BASE}${canonical}`);
      expect(meta(html, "property", "og:image"), path).toBe(`${BASE}/assets/social.png`);
      expect(meta(html, "name", "twitter:card"), path).toBe("summary_large_image");
    }
  });

  it("the ledger 404 keeps the card tags but names no canonical address", async () => {
    const res = await SELF.fetch("https://x/no/such/screen");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(meta(html, "property", "og:url")).toBeNull();
    expect(meta(html, "property", "og:image")).toBe(`${BASE}/assets/social.png`);
  });

  it("serves /assets/social.png as a PNG through the asset router", async () => {
    const res = await env.SELF.fetch("https://x/assets/social.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
