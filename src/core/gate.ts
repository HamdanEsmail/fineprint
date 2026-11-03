// The parts of the change gate (spec 4.3) that more than one route runs: the webhook receiver and
// the overdue-check pull decide a new run with them, and the admin replay decides every stored run
// again with the same ones, so they can never disagree about what counts as "the same page".
import { getVersion, latestVersionHash } from "../db/versions";
import type { PageRow } from "../db/types";
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
  /** `heal` is set when the newest version's stored hash was stale and should be rewritten. */
  | { kind: "suppressed"; heal: { versionId: string; hash: string } | null }
  /** `baseline` is set only for the first version of a page that has none. */
  | { kind: "new_version"; hash: string; baseline: boolean };

/**
 * Stage two of the gate (spec 4.3) for a run that differs from the page as last recorded (a
 * webhook run TinyFish called `changed`, or a pulled run whose text is not the latest version's).
 * It only reads; the caller computes it before the run is claimed (see src/record.ts).
 *
 * Normalizing a 100 KB page costs several ms of the 10 ms budget, so it happens once
 * if it can: the new text's hash is compared with the newest version's stored hash,
 * and only that hash is read. When they differ, the stored text is read and
 * normalized again with the page's current patterns, because the stored hash dates
 * from the rules in force when it was written and an admin edit of the ignore
 * patterns makes it stale. If the two texts then agree, the verdict says to rewrite
 * the stored hash so later runs take the cheap path again.
 */
export async function judgeChange(
  db: D1Database,
  page: Pick<PageRow, "id" | "ignore_patterns">,
  run: { text: string; hasErrors: boolean },
): Promise<Verdict> {
  if (isFetchFailure(run)) return { kind: "fetch_error" };

  const patterns = readIgnorePatterns(page.ignore_patterns);
  const hash = await normalizedHash(run.text, patterns);
  const latest = await latestVersionHash(db, page.id);
  if (latest === null) return { kind: "new_version", hash, baseline: false };
  if (hash === latest.normalized_hash) return { kind: "suppressed", heal: null };

  const previous = await getVersion(db, latest.id);
  if (previous !== null && (await normalizedHash(previous.text, patterns)) === hash) {
    return { kind: "suppressed", heal: { versionId: latest.id, hash } };
  }
  return { kind: "new_version", hash, baseline: false };
}
