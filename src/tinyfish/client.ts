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

const MAX_MESSAGE_CHARS = 300;

function pickString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === "string" && v !== "") return v;
  return null;
}

// Reads an error response tolerantly: JSON with `error.code` / `code`, or any text.
async function errorFrom(res: Response): Promise<TinyFishError> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON; fall back to the text below
  }
  const obj = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const inner = obj.error !== null && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : {};
  const code = pickString(inner.code, obj.code) ?? `http_${res.status}`;
  const detail =
    pickString(inner.message, obj.message, typeof obj.error === "string" ? obj.error : null) ??
    (body === null ? text.trim() : "");
  const message = `TinyFish HTTP ${res.status} ${code}${detail ? `: ${detail.slice(0, MAX_MESSAGE_CHARS)}` : ""}`;
  return new TinyFishError(res.status, code, message);
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
