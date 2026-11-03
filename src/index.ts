import { Hono } from "hono";
import type { Env } from "./env";
import { objectsRouter } from "./handlers/objects";
import { pagesRouter } from "./handlers/pages";
import { webhooksRouter } from "./handlers/webhooks";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/pages", pagesRouter);
app.route("/hooks", webhooksRouter);
app.route("/", objectsRouter);

// Temporary: Task 9 replaces this with the real stats endpoint.
app.get("/api/stats", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM pages) AS pages,
       (SELECT COUNT(*) FROM runs) AS runs,
       (SELECT COUNT(*) FROM versions) AS versions,
       (SELECT COUNT(*) FROM runs WHERE noise_suppressed = 1) AS noise_suppressed,
       (SELECT COALESCE(SUM(amount_usd), 0) FROM spend) AS spend_usd`,
  ).first();
  return c.json(row);
});

// Stub until Task 11 adds the hourly repair and expiry sweep.
async function scheduled(
  _controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {}

export { app };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
