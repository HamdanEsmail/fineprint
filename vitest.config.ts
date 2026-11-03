import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Fixed test values. They win over anything in .dev.vars, so unit
          // tests never see the real TinyFish key.
          TINYFISH_API_KEY: "test-tinyfish-key",
          ADMIN_TOKEN: "test-admin",
          WEBHOOK_SECRET: "test-secret",
          PUBLIC_BASE_URL: "https://fineprint.test",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
});
