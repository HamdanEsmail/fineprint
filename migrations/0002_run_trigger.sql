-- Which way a run reached Fineprint: 'create' (the baseline the Monitor create returned),
-- 'webhook' (a scheduled run TinyFish delivered to /hooks/monitor) or 'pull' (an overdue check
-- run with run-now). TRIGGER is an SQL keyword, hence trigger_kind; the API calls it `trigger`.
ALTER TABLE runs ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'webhook';
UPDATE runs SET trigger_kind = 'create' WHERE is_baseline = 1 AND outcome = 'baseline';

-- A stored diff names the trigger of both its versions from now on; one stored before this
-- migration does not, so the cache is emptied and each diff is computed again on its next request.
DELETE FROM diff_cache;
