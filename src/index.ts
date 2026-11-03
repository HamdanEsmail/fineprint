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
// Registered first, so it wraps every /api route mounted below.
app.use("/api/*", cors());

app.route("/api/pages", pagesRouter);
app.route("/api/discover", discoverRouter);
app.route("/api", adminRouter);
app.route("/api", historyRouter);
app.route("/hooks", webhooksRouter);
app.route("/", objectsRouter);

// The hourly cron (wrangler.jsonc `triggers.crons`): capture repair, facts upkeep, public
// page expiry and Monitor health. runCron never throws.
async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(runCron(env));
}

export { app };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
