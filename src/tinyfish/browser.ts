// TinyBrowser: a full-page screenshot over raw Chrome DevTools Protocol, from inside
// a Worker. A straight port of the verified spike (spikes/worker-shot/src/index.js):
// no Playwright, no Node APIs. The same session also takes the version's thumbnail, and
// the thumbnail backfill (src/thumbs.ts) photographs stored screenshots in one session.
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
/** How long the thumbnail backfill waits for a stored screenshot to load in its wrapper page. */
const IMAGE_WAIT_MS = 15_000;
/**
 * How long a thumbnail capture may take before it is given up (null): a clip that stalls must not hold
 * the full screenshot, which a capture in waitUntil has only about 30 seconds to store.
 */
const THUMB_TIMEOUT_MS = 4_000;
/** How long the browser's answer to Browser.close is waited for; the command is sent either way. */
const CLOSE_WAIT_MS = 5_000;

/**
 * The thumbnail: the top 1280 by 800 of the page (the viewport the device metrics set, so what a visitor
 * first sees) at half scale, a 640 by 400 JPEG at quality 70. Taken without captureBeyondViewport: the clip
 * lies inside the viewport.
 */
export const THUMB_CAPTURE = {
  format: "jpeg",
  quality: 70,
  clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, scale: 0.5 },
} as const;

type CdpReply = { id?: number; result?: unknown; error?: unknown };
type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One attached page of a TinyBrowser session: CDP commands go to it. */
type Page = { send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>; sessionId: string };

/** The answer of `work`, or null when it fails or `ms` pass first (a late answer is dropped). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Base64 to bytes in plain JS: right for a thumbnail's few dozen KB, and no subrequest. */
function decodeBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Opens one TinyBrowser session (the billed step: one `screenshot` spend row, with `spendRef`), attaches to
 * its page at a 1280 by 800 viewport, runs `work`, and always closes the browser so billing stops, then the
 * socket. Browser.close is always sent; its answer is waited for at most `closeWaitMs`.
 */
async function withPage<T>(
  env: Env,
  url: string,
  spendRef: string,
  work: (page: Page) => Promise<T>,
  closeWaitMs: number = CLOSE_WAIT_MS,
): Promise<T> {
  // Session creation is the billed step, so it records the spend row (one browser-minute).
  const created = await tinyfishFetch(env, BROWSER_API, {
    method: "POST",
    body: JSON.stringify({ url }),
    spend: { kind: "screenshot", amountUsd: PRICES.screenshot, ref: spendRef },
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
    return await work({ send: <R>(method: string, params?: Record<string, unknown>) => send<R>(method, params, cdpSession), sessionId });
  } finally {
    // Always close the browser so billing stops, then the socket. A browser that does not answer (it may
    // already be gone, or stuck) is not waited for past closeWaitMs.
    await within(send("Browser.close"), closeWaitMs);
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}

/**
 * What a screenshot session returns: the full-page JPEG (`bytes`) and its thumbnail. `thumb` is null when the
 * thumbnail capture failed; it is optional in the type so a stand-in that takes no thumbnail stays valid.
 */
export type Screenshot = { bytes: ArrayBuffer; thumb?: ArrayBuffer | null; height: number; sessionId: string };

/** The thumbnail clip, or null when it fails or takes over `ms`. */
async function captureThumb(page: Page, ms: number): Promise<ArrayBuffer | null> {
  const shot = await within(page.send<{ data: string }>("Page.captureScreenshot", THUMB_CAPTURE), ms);
  if (shot == null || typeof shot.data !== "string") return null;
  try {
    return decodeBase64(shot.data);
  } catch {
    return null;
  }
}

/**
 * A full-page screenshot of `url` (at most SCREENSHOT_MAX_HEIGHT pixels high) and, as a second capture in
 * the same session before the browser closes, its thumbnail (THUMB_CAPTURE): no second session and no
 * second spend row. The full image is decoded before the thumbnail is asked for, and the thumbnail gets at
 * most `thumbTimeoutMs` (4 s): `thumb` is null when it fails or stalls, and the full screenshot is returned
 * either way. `settleMs` is the wait for the page to load and paint; tests shorten all three waits.
 */
export async function screenshotFullPage(
  env: Env,
  url: string,
  opts: { settleMs?: number; thumbTimeoutMs?: number; closeWaitMs?: number } = {},
): Promise<Screenshot> {
  return withPage(
    env,
    url,
    url,
    async (page) => {
    await page.send("Page.navigate", { url });
    await new Promise<void>((resolve) => setTimeout(resolve, opts.settleMs ?? SETTLE_MS));
    const metrics = await page.send<{ cssContentSize?: { height?: number }; contentSize?: { height?: number } }>("Page.getLayoutMetrics");
    const height = Math.min(
      Math.ceil(metrics.cssContentSize?.height || metrics.contentSize?.height || VIEWPORT_HEIGHT),
      SCREENSHOT_MAX_HEIGHT,
    );
    const shot = await page.send<{ data: string }>("Page.captureScreenshot", {
      format: "jpeg",
      quality: 80,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height, scale: 1 },
    });
    // Decoding through fetch keeps CPU time tiny; a JS loop over ~1 MB of base64 would not.
    const bytes = await (await fetch(`data:image/jpeg;base64,${shot.data}`)).arrayBuffer();
    // No thumbnail (failed or stalled): the version keeps its screenshot, and the site shows that instead.
    const thumb = await captureThumb(page, opts.thumbTimeoutMs ?? THUMB_TIMEOUT_MS);
    return { bytes, thumb, height, sessionId: page.sessionId };
    },
    opts.closeWaitMs,
  );
}

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The page a stored screenshot is photographed in: the image at its own width, top left, nothing else. */
const wrapperUrl = (imageUrl: string): string =>
  `data:text/html,${encodeURIComponent(
    `<body style="margin:0"><img src="${escapeAttribute(imageUrl)}" width="${VIEWPORT_WIDTH}" style="display:block"></body>`,
  )}`;

/**
 * An expression that resolves true once the wrapper's image, the one at `imageUrl`, has loaded, and false
 * when it fails or takes over IMAGE_WAIT_MS. It checks the image's own src, so an evaluation that lands
 * before the navigation is in place waits for the new page instead of reading the previous image.
 */
const waitForImage = (imageUrl: string): string => `new Promise((resolve) => {
  const expected = ${JSON.stringify(imageUrl)};
  const deadline = Date.now() + ${IMAGE_WAIT_MS};
  const check = () => {
    const img = document.images[0];
    if (location.protocol === "data:" && img && img.src === expected && img.complete) return resolve(img.naturalWidth > 0);
    if (Date.now() > deadline) return resolve(false);
    setTimeout(check, 100);
  };
  check();
})`;

/**
 * Thumbnails of stored screenshots (the backfill of versions that were captured before thumbnails existed:
 * the page as it was is gone, so its screenshot is photographed instead). One session for the whole list:
 * each image is opened in a `data:` wrapper page, waited for, and clipped with THUMB_CAPTURE, and each
 * thumbnail is handed to `store` as soon as it is made, before the next image is opened, so a session that
 * is cut off keeps what it made. An image that does not load, or a clip that fails or stalls, is skipped.
 * The browser is always closed.
 */
export async function thumbnailsOfShots(
  env: Env,
  items: { id: string; imageUrl: string }[],
  store: (id: string, thumb: ArrayBuffer) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  // The session opens on the first stored screenshot (a plain https url, as a screenshot session opens on
  // its page); each image is then shown in its wrapper.
  await withPage(env, items[0]!.imageUrl, `thumbnail backfill: ${items.length} versions`, async (page) => {
    for (const item of items) {
      try {
        await page.send("Page.navigate", { url: wrapperUrl(item.imageUrl) });
        const loaded = await page.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
          expression: waitForImage(item.imageUrl),
          awaitPromise: true,
          returnByValue: true,
        });
        if (loaded.result?.value !== true) continue;
        const thumb = await captureThumb(page, THUMB_TIMEOUT_MS);
        if (thumb !== null) await store(item.id, thumb);
      } catch {
        // This one is skipped; a later call can try it again.
      }
    }
  });
}
