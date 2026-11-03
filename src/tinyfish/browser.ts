// TinyBrowser: a full-page screenshot over raw Chrome DevTools Protocol, from inside
// a Worker. A straight port of the verified spike (spikes/worker-shot/src/index.js):
// no Playwright, no Node APIs.
import { SCREENSHOT_MAX_HEIGHT } from "../core/limits";
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { tinyfishFetch } from "./client";

const BROWSER_API = "https://api.browser.tinyfish.ai";
const COMMAND_TIMEOUT_MS = 45_000;
/** Time for the page to finish loading and painting before it is measured. */
const SETTLE_MS = 6_000;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

type CdpReply = { id?: number; result?: unknown; error?: unknown };
type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

export async function screenshotFullPage(
  env: Env,
  url: string,
): Promise<{ bytes: ArrayBuffer; height: number; sessionId: string }> {
  // Session creation is the billed step, so it records the spend row (one browser-minute).
  const created = await tinyfishFetch(env, BROWSER_API, {
    method: "POST",
    body: JSON.stringify({ url }),
    spend: { kind: "screenshot", amountUsd: PRICES.screenshot, ref: url },
  });
  const session = (await created.json()) as { session_id?: unknown; cdp_url?: unknown };
  if (typeof session.cdp_url !== "string" || session.cdp_url === "") {
    throw new Error("TinyBrowser returned no cdp_url");
  }
  const sessionId = typeof session.session_id === "string" ? session.session_id : "";

  // The CDP socket lives on the session's own host and needs no API key.
  const upgrade = await fetch(session.cdp_url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } });
  const ws = upgrade.webSocket;
  if (!ws) throw new Error(`TinyBrowser did not upgrade to a websocket (HTTP ${upgrade.status})`);
  ws.accept();

  let nextId = 0;
  const pending = new Map<number, Pending>();
  const failAll = (reason: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pending.delete(id);
    }
  };
  ws.addEventListener("message", (m) => {
    let reply: CdpReply;
    try {
      reply = JSON.parse(String(m.data)) as CdpReply;
    } catch {
      return;
    }
    if (typeof reply.id !== "number") return;
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.error) p.reject(new Error(`CDP error: ${JSON.stringify(reply.error)}`));
    else p.resolve(reply.result);
  });
  ws.addEventListener("close", () => failAll("TinyBrowser closed the connection"));
  ws.addEventListener("error", () => failAll("TinyBrowser connection error"));

  const send = <T>(method: string, params: Record<string, unknown> = {}, cdpSessionId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params, ...(cdpSessionId ? { sessionId: cdpSessionId } : {}) }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  try {
    const { targetInfos } = await send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
    let targetId = targetInfos.find((t) => t.type === "page")?.targetId;
    if (!targetId) {
      targetId = (await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
    }
    const { sessionId: cdpSession } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await send("Page.enable", {}, cdpSession);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      cdpSession,
    );
    await send("Page.navigate", { url }, cdpSession);
    await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
    const metrics = await send<{ cssContentSize?: { height?: number }; contentSize?: { height?: number } }>(
      "Page.getLayoutMetrics",
      {},
      cdpSession,
    );
    const height = Math.min(
      Math.ceil(metrics.cssContentSize?.height || metrics.contentSize?.height || VIEWPORT_HEIGHT),
      SCREENSHOT_MAX_HEIGHT,
    );
    const shot = await send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 80,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height, scale: 1 },
      },
      cdpSession,
    );
    // Decoding through fetch keeps CPU time tiny; a JS loop over ~1 MB of base64 would not.
    const bytes = await (await fetch(`data:image/jpeg;base64,${shot.data}`)).arrayBuffer();
    return { bytes, height, sessionId };
  } finally {
    // Always close the browser so billing stops, then the socket.
    try {
      await send("Browser.close");
    } catch {
      // The browser may already be gone, or the socket closed first.
    }
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
