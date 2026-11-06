import { Hono } from "hono";
import { cors } from "hono/cors";
import { runCron } from "./cron";
import type { Env } from "./env";
import { adminRouter } from "./handlers/admin";
import { discoverRouter } from "./handlers/discover";
import { historyRouter } from "./handlers/history";
import { objectsRouter } from "./handlers/objects";
import { pagesRouter } from "./handlers/pages";
import { webhooksRouter } from "./handlers/webhooks";

const app = new Hono<{ Bindings: Env }>();

// The API is public and read by pages on other origins: any origin, and the preflight answered.
// Registered first, so it wraps every /api route mounted below. The stored screenshots and sources
// too, so a page elsewhere can fetch them; they keep their own sandbox and nosniff headers.
app.use("/api/*", cors());
app.use("/shots/*", cors());
app.use("/sources/*", cors());

app.route("/api/pages", pagesRouter);
app.route("/api/discover", discoverRouter);
app.route("/api", adminRouter);
app.route("/api", historyRouter);
app.route("/hooks", webhooksRouter);
app.route("/", objectsRouter);

// The hourly cron (wrangler.jsonc `triggers.crons`): facts upkeep, overdue Monitor checks pulled
// with run-now (with the pull backoff), public page expiry, Monitor health, capture repair, and
// missing summaries asked for through the SELF binding. runCron never throws.
async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(runCron(env));
}

export { app };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
