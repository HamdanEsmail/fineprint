// The parts of the change gate (spec 4.3) that more than one route runs: the webhook receiver
// decides a new run with them, and the admin replay decides every stored run again with the
// same ones, so the two can never disagree about what counts as "the same page".
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
