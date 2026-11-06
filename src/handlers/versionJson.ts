// The one mapping from a version row to API JSON (Task 15). Every endpoint that shows a version uses it:
// GET /api/pages/:id and the export list versions with it, versions/:vid and as-of add the text and the
// live url, and the diff and the change feed take its urls and facts from the helpers here.
import type { Delta, Fact } from "../core/diff";
import type { VersionSummary, WithTrigger } from "../db/versions";
import type { Env } from "../env";

/** The public urls of a version's stored copies (R18): null for a capture the version does not have. */
export function objectUrls(
  env: Env,
  v: Pick<VersionSummary, "id" | "screenshot_key" | "html_key">,
): { screenshot_url: string | null; source_url: string | null } {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return {
    screenshot_url: v.screenshot_key ? `${base}/shots/${v.id}.jpg` : null,
    source_url: v.html_key ? `${base}/sources/${v.id}.html` : null,
  };
}

/** The public url of a version's thumbnail (site plan Task 2), or null when it has none: the page then shows its screenshot. */
export function thumbUrl(env: Env, v: Pick<VersionSummary, "id" | "thumb_key">): string | null {
  return v.thumb_key ? `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/thumbs/${v.id}.jpg` : null;
}

/** A version's stored delta, or null when it has none (a baseline, or not computed yet) or what is stored cannot be read. */
export function parseDelta(stored: string | null): Delta | null {
  if (stored === null) return null;
  try {
    const value = JSON.parse(stored) as Delta | null;
    return value !== null && typeof value === "object" && typeof value.blocks === "object" ? value : null;
  } catch {
    return null;
  }
}

/** A version's stored facts, or null when it has none or what is stored is not a JSON array. */
export function parseFacts(stored: string | null): Fact[] | null {
  if (stored === null) return null;
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) ? (value as Fact[]) : null;
  } catch {
    return null;
  }
}

/**
 * A version without its text. Booleans are booleans, facts are parsed, stored copies are public urls, and
 * nothing of the raw row (run id, hash, storage keys, attempts, errors, the Agent run id) is shown.
 * `trigger` says which way the run that made it arrived: `create` (the baseline), `webhook` (a scheduled
 * run) or `pull` (an overdue check run with run-now). `summary` is the one-line summary of the change and
 * `summary_source` where it came from (`tinyfish` or `diff`; both null for a baseline, and until it is
 * filled); `judgment_summary` is TinyFish's own text as it came. `notes` says why the version exists when
 * it is not the plain result of one read (a confirmed suspect read, a replay). `delta` is the change in counts
 * against the version before it, with the layout-only label (null for a baseline, and until it is computed
 * out of band); `thumb_url` is the 640 by 400 thumbnail beside `screenshot_url` (null when there is none).
 */
export function versionSummaryJson(env: Env, v: WithTrigger<VersionSummary>) {
  return {
    id: v.id,
    page_id: v.page_id,
    captured_at: v.captured_at,
    is_baseline: v.is_baseline === 1,
    summary: v.summary,
    summary_source: v.summary_source,
    judgment_summary: v.judgment_summary,
    facts: parseFacts(v.facts_json),
    delta: parseDelta(v.delta_json),
    ...objectUrls(env, v),
    thumb_url: thumbUrl(env, v),
    capture_status: v.capture_status,
    facts_status: v.facts_status,
    trigger: v.trigger_kind,
    notes: v.notes,
  };
}

/**
 * A version with its text and the page's live url, as versions/:vid and as-of return it (src/readModel.ts
 * getVersion and getVersionAsOf). `text` is null only for a caller that did not read it.
 */
export function versionJson(env: Env, liveUrl: string, v: WithTrigger<VersionSummary>, text: string | null) {
  return { ...versionSummaryJson(env, v), text, live_url: liveUrl };
}
