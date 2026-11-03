// Outbound fetch mocking for tests (the plan's `fetchMock` from cloudflare:test
// no longer exists). It wraps globalThis.fetch, answers from interceptors, and
// throws on anything unmatched, so a test can never reach TinyFish or the
// network. Call activate() in beforeEach and reset() in afterEach.
import { vi, type MockInstance } from "vitest";

interface Reply {
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
}

type Responder = Reply | ((req: Request, body: unknown) => Response | Promise<Response>);

interface InterceptOptions {
  /** Omit to match any method. */
  method?: string;
  /** A string must equal the full request URL; a RegExp is tested against it. */
  url: string | RegExp;
  reply: Responder;
  /** How many requests it answers. Default 1; use Infinity for a persistent one. */
  times?: number;
}

interface Call {
  method: string;
  url: string;
  /** JSON-parsed when it parses, else the text, else null when there is none. */
  body: unknown;
}

interface Interceptor extends InterceptOptions {
  left: number;
}

let spy: MockInstance<typeof fetch> | undefined;
let interceptors: Interceptor[] = [];
const calls: Call[] = [];

function matches(i: Interceptor, req: Request): boolean {
  if (i.left <= 0) return false;
  if (i.method && i.method.toUpperCase() !== req.method) return false;
  return typeof i.url === "string" ? new URL(i.url).href === req.url : i.url.test(req.url);
}

function toResponse(reply: Reply): Response {
  const headers = new Headers(reply.headers);
  let body = reply.body ?? null;
  if (reply.json !== undefined) {
    body = JSON.stringify(reply.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Response(body, { status: reply.status ?? 200, headers });
}

async function readBody(req: Request): Promise<unknown> {
  const text = await req.clone().text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const body = await readBody(req);
  calls.push({ method: req.method, url: req.url, body });
  const hit = interceptors.find((i) => matches(i, req));
  if (!hit) throw new Error(`fetchMock: no interceptor for ${req.method} ${req.url}`);
  hit.left -= 1;
  return typeof hit.reply === "function" ? hit.reply(req, body) : toResponse(hit.reply);
}

export const fetchMock = {
  calls,

  /** Replace globalThis.fetch. Safe to call twice. */
  activate(): void {
    spy ??= vi.spyOn(globalThis, "fetch").mockImplementation(handle);
  },

  /** Restore the real fetch and forget every interceptor and call. */
  reset(): void {
    spy?.mockRestore();
    spy = undefined;
    interceptors = [];
    calls.length = 0;
  },

  /** Register an answer. The first matching interceptor with uses left wins. */
  intercept(options: InterceptOptions): void {
    interceptors.push({ ...options, left: options.times ?? 1 });
  },
};
