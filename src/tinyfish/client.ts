// The one place every TinyFish HTTP call goes through. It adds the API key,
// records spend after a 2xx, and turns a non-2xx into a TinyFishError. The key
// is read here and nowhere else, and never appears in an error or a log.
import type { Env } from "../env";
import { recordSpend, type SpendKind } from "../core/spend";

export class TinyFishError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TinyFishError";
    this.status = status;
    this.code = code;
  }
}

export type SpendNote = { kind: SpendKind; amountUsd: number; ref: string };

function pickString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === "string" && v !== "") return v;
  return null;
}

const ERROR_CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

// Reads an error response tolerantly: JSON with `error.code` / `code`, else `http_<status>`.
// The message carries the status and the code and nothing else from the response: an
// upstream body can echo what we sent (a rejected webhook_url holds the webhook secret),
// and error messages end up in logs.
async function errorFrom(res: Response): Promise<TinyFishError> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: there is no code in it
  }
  const obj = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const inner = obj.error !== null && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : {};
  // A code is a short token. Anything else (a sentence that echoes our request) is not trusted.
  const upstream = pickString(inner.code, obj.code);
  const code = upstream !== null && ERROR_CODE_SHAPE.test(upstream) ? upstream : `http_${res.status}`;
  return new TinyFishError(res.status, code, `TinyFish HTTP ${res.status} ${code}`);
}

export async function tinyfishFetch(
  env: Env,
  url: string,
  init: RequestInit & { spend?: SpendNote } = {},
): Promise<Response> {
  const { spend, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("X-API-Key", env.TINYFISH_API_KEY);
  headers.set("Content-Type", "application/json");
  const res = await fetch(url, { ...rest, headers });
  if (!res.ok) throw await errorFrom(res);
  if (spend) {
    // A 2xx is billed and may have created something (a Monitor); a failed ledger write must
    // not discard the response. Only the kind is logged: no key, url or error text.
    try {
      await recordSpend(env.DB, spend.kind, spend.amountUsd, spend.ref);
    } catch {
      console.error("spend write failed", spend.kind);
    }
  }
  return res;
}
