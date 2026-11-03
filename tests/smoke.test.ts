import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("GET /api/stats returns zero counts", async () => {
    const res = await SELF.fetch("http://x/api/stats");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pages: 0, runs: 0, versions: 0, noise_suppressed: 0, spend_usd: 0 });
  });

  it("runs with the fixed test bindings, never the real TinyFish key", () => {
    expect(env.TINYFISH_API_KEY === "test-tinyfish-key").toBe(true);
    expect(env.ADMIN_TOKEN).toBe("test-admin");
    expect(env.WEBHOOK_SECRET).toBe("test-secret");
    expect(env.PUBLIC_BASE_URL).toBe("https://fineprint.test");
  });
});
