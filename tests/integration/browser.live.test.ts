// Opt-in live test: one real TinyBrowser screenshot of vercel.com/pricing (about
// $0.002). It runs only when the shell sets FINEPRINT_LIVE=1, which makes
// vitest.config.ts pass the real key in as LIVE_TINYFISH_API_KEY:
//
//   FINEPRINT_LIVE=1 npx vitest run tests/integration/browser.live.test.ts --reporter=verbose
//
// The key comes from .dev.vars (else TINYFISH_API_KEY in the shell). The default
// reporter hides console output in this pool; --reporter=verbose shows the bytes
// and height line. There is no fetchMock here: the calls are real. `npm run
// check` skips this file.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { screenshotFullPage } from "../../src/tinyfish/browser";

it.skipIf(!env.LIVE_TINYFISH_API_KEY)(
  "takes a real full-page screenshot of vercel.com/pricing",
  async () => {
    const liveEnv = { ...env, TINYFISH_API_KEY: env.LIVE_TINYFISH_API_KEY! };
    const started = Date.now();
    const shot = await screenshotFullPage(liveEnv, "https://vercel.com/pricing");
    console.log(`live screenshot: bytes=${shot.bytes.byteLength} height=${shot.height} ms=${Date.now() - started}`);
    expect(shot.bytes.byteLength).toBeGreaterThan(100_000);
    expect(shot.height).toBeGreaterThan(800);
    expect(shot.sessionId).not.toBe("");
  },
  120_000,
);
