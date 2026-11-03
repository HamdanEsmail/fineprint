// TinyFetch: one page as markdown or cleaned HTML. Free (within 1,000 URLs a day),
// but each call still appends a $0 spend row.
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { TinyFishError, tinyfishFetch } from "./client";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const PER_URL_TIMEOUT_MS = 45_000;

export type FetchPageResult =
  | { ok: true; text: string; title: string | null; finalUrl: string }
  | { ok: false; error: string; status?: number };

type FetchBody = {
  results?: { text?: unknown; title?: unknown; final_url?: unknown }[];
  errors?: { error?: unknown }[];
};

function errorText(entry: { error?: unknown } | undefined): string {
  const e = entry?.error;
  if (typeof e === "string" && e !== "") return e;
  if (e !== null && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return "fetch_error";
}

export async function fetchPage(env: Env, url: string, format: "markdown" | "html"): Promise<FetchPageResult> {
  let body: FetchBody;
  try {
    const res = await tinyfishFetch(env, FETCH_API, {
      method: "POST",
      body: JSON.stringify({
        urls: [url],
        format,
        ttl: 0,
        include_etag_and_last_modified: true,
        per_url_timeout_ms: PER_URL_TIMEOUT_MS,
      }),
      spend: { kind: "fetch", amountUsd: PRICES.fetch, ref: url },
    });
    body = (await res.json()) as FetchBody;
  } catch (err) {
    if (err instanceof TinyFishError) return { ok: false, error: err.code, status: err.status };
    throw err;
  }

  if (body.errors && body.errors.length > 0) return { ok: false, error: errorText(body.errors[0]) };
  const first = body.results?.[0];
  if (!first || typeof first.text !== "string") return { ok: false, error: "no_result" };
  return {
    ok: true,
    text: first.text,
    title: typeof first.title === "string" ? first.title : null,
    finalUrl: typeof first.final_url === "string" && first.final_url !== "" ? first.final_url : url,
  };
}
