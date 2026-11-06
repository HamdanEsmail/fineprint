export interface Env {
  DB: D1Database;
  STORE: R2Bucket;
  TINYFISH_API_KEY: string;
  ADMIN_TOKEN: string;
  WEBHOOK_SECRET: string;
  PUBLIC_BASE_URL: string;
  /** "1" turns the site's screens on (src/site); anything else leaves every site path answering as before. */
  SITE_ENABLED: string;
  /** This Worker (wrangler.jsonc `services`): the cron runs each overdue-check pull as its own invocation. */
  SELF: Fetcher;
}
