/// <reference types="vite/client" />
import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/env";

// `vite/client` types `import.meta.glob` and `?raw` imports, which tests use to
// load text fixtures (the Workers pool has no filesystem).

// Types the bindings for tests. TEST_MIGRATIONS is set by vitest.config.ts and
// exists only in the test environment, so it is not part of src/env.ts.
// LIVE_TINYFISH_API_KEY is set by vitest.config.ts only for a FINEPRINT_LIVE=1 run.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      LIVE_TINYFISH_API_KEY?: string;
    }
  }
}
