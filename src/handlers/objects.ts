// The stored copies of a version: `/shots/<version id>.jpg` serves R2 `shots/<id>.jpg`
// and `/sources/<version id>.html` serves R2 `html/<id>.html`. A version's objects are
// written once and never change, so they are cached for a year.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";

export const objectsRouter = new Hono<{ Bindings: Env }>();

const CACHE_FOREVER = "public, max-age=31536000, immutable";
const NAME = /^[A-Za-z0-9-]+\.(jpg|html)$/;
const FALLBACK_TYPE = { jpg: "image/jpeg", html: "text/html; charset=utf-8" } as const;

async function serve(c: Context<{ Bindings: Env }>, prefix: string, extension: "jpg" | "html"): Promise<Response> {
  const name = c.req.param("name") ?? "";
  // The name becomes part of an R2 key: nothing but a plain id and the route's own extension.
  if (NAME.exec(name)?.[1] !== extension) return c.json({ error: "not_found" }, 404);
  const object = await c.env.STORE.get(prefix + name);
  if (object === null) return c.json({ error: "not_found" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("content-type")) headers.set("content-type", FALLBACK_TYPE[extension]);
  headers.set("cache-control", CACHE_FOREVER);
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

objectsRouter.get("/shots/:name", (c) => serve(c, "shots/", "jpg"));
objectsRouter.get("/sources/:name", (c) => serve(c, "html/", "html"));
