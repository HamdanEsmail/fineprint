import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/env";

// Types the bindings for tests. TEST_MIGRATIONS is set by vitest.config.ts and
// exists only in the test environment, so it is not part of src/env.ts.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
