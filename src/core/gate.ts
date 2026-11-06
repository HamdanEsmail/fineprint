// The parts of the change gate (spec 4.3) that more than one route runs: the webhook receiver and
// the overdue-check pull decide a new run with them, and the admin replay decides every stored run
// again with the same ones, so they can never disagree about what counts as "the same page".
import { getVersion, hasVersionWithHashSince, latestVersionHash } from "../db/versions";
import type { PageRow } from "../db/types";
import { blockSetDifference, structuredDiff } from "./diff";
import {
  CONFIRM_WINDOW_MS,
  FLAP_WINDOW_MS,
  LAYOUT_HOLD_MAX_ADDED_SHARE,
  LAYOUT_HOLD_MIN_REMOVED,
  LAYOUT_HOLD_RATIO,
  PARTIAL_RENDER_LARGE_CHARS,
  PARTIAL_RENDER_RATIO,
  PARTIAL_RENDER_SMALL_CHARS,
} from "./limits";
import { hashText, normalize } from "./normalize";

/** A page's ignore patterns from its column; a value that is not a JSON array of strings counts as none. */
export function readIgnorePatterns(column: string): string[] {
  try {
    const parsed: unknown = JSON.parse(column);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The hash two texts are compared by: SHA-256 of the text normalized with the page's ignore
 * patterns. Two texts are the same version exactly when their hashes are equal. A stored
 * `normalized_hash` dates from the rules in force when it was written, so a caller that must
 * judge with the current rules (an admin edit of the patterns, a replay) hashes both sides again.
 */
export async function normalizedHash(text: string, patterns: string[]): Promise<string> {
  return hashText(normalize(text, patterns).text);
}

/** An empty page or a run with an error entry is a failed fetch, not a change in the page. */
export function isFetchFailure(run: { text: string; hasErrors: boolean }): boolean {
  return run.text.trim() === "" || run.hasErrors;
}

export type Verdict =
  | { kind: "fetch_error" }
  /**
   * `reason` is the run's `noise_reason`. `heal` is set when the newest version's stored hash was
   * stale and should be rewritten. `clearPending` says the page's pending confirm read ends here.
   */
  | {
      kind: "suppressed";
      reason: "normalized_identical" | "flap";
      heal: { versionId: string; hash: string } | null;
      clearPending?: true;
    }
  /** A read that looks like a partial render: no version, the run is noise, and the page awaits a confirm read. */
  | { kind: "partial_suspect"; hash: string }
  /** A read that looks like a shrinking restructure (see looksLikeLayoutHold): held for a confirm read the same way. */
  | { kind: "layout_hold"; hash: string }
  /**
   * `baseline` is set only for the first version of a page that has none. `notes` is the new
   * version's note (a confirmed suspect read); `clearPending` says the page's pending confirm read
   * ends here.
   */
  | { kind: "new_version"; hash: string; baseline: boolean; notes?: string; clearPending?: true };

/**
 * Whether a read that differs from the latest version looks like the page rendered only in part
 * (the OpenAI pricing page on night 1: 2,297 normalized characters became 725, 25 blocks gone and
 * none added). The cheap length checks come first; the block diff, the costly part, runs only when
 * the read is under PARTIAL_RENDER_RATIO of the latest.
 */
function looksPartial(latestNormalized: string, newNormalized: string): boolean {
  const before = latestNormalized.length;
  const after = newNormalized.length;
  if (after < PARTIAL_RENDER_SMALL_CHARS && before > PARTIAL_RENDER_LARGE_CHARS) return true;
  if (after >= before * PARTIAL_RENDER_RATIO) return false;
  return structuredDiff(latestNormalized, newNormalized).added.length === 0;
}

/**
 * Whether a read that differs from the latest version is a shrinking restructure, held for a confirm read
 * like a partial render (GitHub pricing on 5 Nov: 18,823 normalized characters became 17,061, 228 blocks
 * removed and 1 added): under LAYOUT_HOLD_RATIO of the latest's length, at least LAYOUT_HOLD_MIN_REMOVED
 * blocks removed, and added blocks at most LAYOUT_HOLD_MAX_ADDED_SHARE of the removed ones. This runs on
 * the webhook path, so the length test comes first and decides almost every read; only a read under the
 * ratio counts blocks, and it counts them with blockSetDifference (two splits and a map, linear in the
 * text) rather than the aligned structuredDiff.
 */
export function looksLikeLayoutHold(latestNormalized: string, newNormalized: string): boolean {
  if (newNormalized.length >= latestNormalized.length * LAYOUT_HOLD_RATIO) return false;
  const { added, removed } = blockSetDifference(latestNormalized, newNormalized);
  return removed >= LAYOUT_HOLD_MIN_REMOVED && added <= removed * LAYOUT_HOLD_MAX_ADDED_SHARE;
}

/**
 * What the admin replay changes about a judgment. `latest` is the version the run is compared with
 * (the replay's chain) in place of the page's newest; `text` spares reading it again. `replay` judges
 * the run as of its own receipt time: the flap check ignores versions captured after it, and
 * `exceptVersionId` is the version the run itself made (when it made one).
 */
export type JudgeOptions = {
  latest?: { id: string; normalized_hash: string; text?: string } | null;
  replay?: { exceptVersionId?: string };
};

type JudgedPage = Pick<PageRow, "id" | "ignore_patterns"> &
  Partial<Pick<PageRow, "pending_hash" | "pending_run_id" | "pending_at">>;

/**
 * Stage two of the gate (spec 4.3) for a run that differs from the page as last recorded (a
 * webhook run TinyFish called `changed`, a pulled run whose text is not the latest version's, or any
 * run of a page with a confirm read pending). It only reads; the caller computes it before the run
 * is claimed (see src/record.ts).
 *
 * Normalizing a 100 KB page costs several ms of the 10 ms budget, so each text is normalized once:
 * the new text's hash is compared with the newest version's stored hash, and only that hash is
 * read. When they differ, the stored text is read and normalized again with the page's current
 * patterns, because the stored hash dates from the rules in force when it was written and an admin
 * edit of the ignore patterns makes it stale. If the two texts then agree, the verdict says to
 * rewrite the stored hash so later runs take the cheap path again.
 *
 * A read that really differs from the latest version then meets, in this order:
 * - The partial-render guard (looksPartial), then the layout hold (looksLikeLayoutHold), unless this read
 *   is the confirm of a pending suspect: the page has a pending read (pending_at within 24 hours) with the
 *   same hash, so two consecutive reads agree. A suspect read makes no version; the caller marks the page
 *   for a confirm read. The confirm's version notes which of the two held the first read.
 * - Flap suppression: a hash equal to any version of the page captured in the last 72 hours is a
 *   flap, a confirm read included. (The latest-equal case above is checked first.)
 * - Otherwise a new version; a confirm read's carries a note naming the suspect run.
 * Any judgment of a page's next read, whatever it decides, ends its pending confirm read, except a
 * new suspect, which replaces it.
 */
export async function judgeChange(
  db: D1Database,
  page: JudgedPage,
  run: { text: string; hasErrors: boolean },
  nowMs: number = Date.now(),
  opts: JudgeOptions = {},
): Promise<Verdict> {
  if (isFetchFailure(run)) return { kind: "fetch_error" };

  const patterns = readIgnorePatterns(page.ignore_patterns);
  const newNormalized = normalize(run.text, patterns).text;
  const hash = await hashText(newNormalized);
  const clear = page.pending_at != null ? ({ clearPending: true } as const) : {};
  const confirming =
    page.pending_hash != null &&
    page.pending_at != null &&
    nowMs - Date.parse(page.pending_at) <= CONFIRM_WINDOW_MS &&
    hash === page.pending_hash;

  const latest: JudgeOptions["latest"] = opts.latest !== undefined ? opts.latest : await latestVersionHash(db, page.id);
  if (latest === null) return { kind: "new_version", hash, baseline: false, ...clear };
  if (hash === latest.normalized_hash) return { kind: "suppressed", reason: "normalized_identical", heal: null, ...clear };

  const previousText = latest.text ?? (await getVersion(db, latest.id))?.text ?? null;
  const previousNormalized = previousText === null ? null : normalize(previousText, patterns).text;
  if (previousNormalized !== null && (await hashText(previousNormalized)) === hash) {
    return { kind: "suppressed", reason: "normalized_identical", heal: { versionId: latest.id, hash }, ...clear };
  }

  const partial = previousNormalized !== null && looksPartial(previousNormalized, newNormalized);
  if (!confirming && partial) return { kind: "partial_suspect", hash };
  const held = !partial && previousNormalized !== null && looksLikeLayoutHold(previousNormalized, newNormalized);
  if (!confirming && held) return { kind: "layout_hold", hash };
  const bounds = opts.replay ? { untilIso: new Date(nowMs).toISOString(), exceptVersionId: opts.replay.exceptVersionId } : {};
  if (await hasVersionWithHashSince(db, page.id, hash, new Date(nowMs - FLAP_WINDOW_MS).toISOString(), bounds)) {
    return { kind: "suppressed", reason: "flap", heal: null, ...clear };
  }
  return {
    kind: "new_version",
    hash,
    baseline: false,
    ...(confirming ? { notes: `confirmed after ${held ? "layout-hold" : "partial-render"} suspect run ${page.pending_run_id}` } : {}),
    ...clear,
  };
}
