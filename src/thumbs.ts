// Thumbnails for versions captured before thumbnails existed (site plan, Task 2). A new version's thumbnail is
// taken with its screenshot, in the same browser session (src/capture.ts). For an older version the page as
// it was is gone, so its stored screenshot is photographed instead: one TinyBrowser session for the whole
// batch (one `screenshot` spend unit), each image opened in a wrapper page and its top 1280 by 800 clipped at
// half scale. Nothing here runs unattended: the admin route POST /api/admin/thumbs calls it, and the hourly
// repair never chases thumbnails (a version without one simply shows its screenshot).
import { spendPaused } from "./capture";
import { setThumbKey } from "./db/versions";
import type { Env } from "./env";
import { thumbnailsOfShots } from "./tinyfish/browser";

/**
 * Makes the thumbnails of these versions (each must have a stored screenshot) in one browser session, stores
 * each at `thumbs/<id>.jpg` and records its key. Returns how many it made. Nothing is opened at the spend
 * pause, or for an empty list. A version whose image did not load is skipped; a later call can try again.
 */
export async function thumbnailFromScreenshot(env: Env, versionIds: string[]): Promise<number> {
  if (versionIds.length === 0 || (await spendPaused(env.DB))) return 0;
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const shots = await thumbnailsOfShots(
    env,
    versionIds.map((id) => ({ id, imageUrl: `${base}/shots/${id}.jpg` })),
  );
  let made = 0;
  for (const id of versionIds) {
    const thumb = shots.get(id);
    if (!thumb) continue;
    const key = `thumbs/${id}.jpg`;
    await env.STORE.put(key, thumb, { httpMetadata: { contentType: "image/jpeg" } });
    if (await setThumbKey(env.DB, id, key)) made++;
  }
  return made;
}
