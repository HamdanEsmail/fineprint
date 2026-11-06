-- Summaries and the pull backoff (Task 15). Additive: new columns with defaults, nothing renamed,
-- dropped or rewritten.

-- A plain one-line summary of what a version changed, and where it came from: 'tinyfish' when the run
-- carried TinyFish's judgment summary, 'diff' when Fineprint built it from its own structured diff
-- against the previous version. Both stay NULL for a baseline. Existing versions are filled by
-- POST /api/admin/backfill-summaries, not here (the diff needs the Worker's normalization).
ALTER TABLE versions ADD COLUMN summary TEXT;
ALTER TABLE versions ADD COLUMN summary_source TEXT;

-- The pull backoff: consecutive failed pulls of a page (no text, a fetch error, or run-now failing),
-- and, once there have been PULL_BACKOFF_AFTER_FAILURES of them, the time before which the hourly
-- cron does not pull the page again (ISO). Both reset when a pull returns usable text or a webhook
-- run arrives.
ALTER TABLE pages ADD COLUMN pull_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN pull_retry_after TEXT;

-- A stored diff is now final only when no facts run is in flight for either end, and carries the
-- `to` version's stored summary; one stored under the old rule may hold neither, so the cache is
-- emptied and each diff is computed again on its next request (it is only a cache).
DELETE FROM diff_cache;
