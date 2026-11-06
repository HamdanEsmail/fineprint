-- Facts labelling (Task 14b). facts_status says what became of a version's price facts, apart from
-- whether its screenshot and source were stored:
--   ok           facts_json is stored
--   pending      facts are needed and not settled yet (queued or in flight)
--   unavailable  facts are needed, the attempts are used up and none were stored
--   not_needed   the page is not a pricing or fees page, or the version's run was judged not relevant
-- capture_status now says `complete` once the screenshot and the source are stored, whatever the facts
-- outcome; `failed` is kept for a missing screenshot or source at the attempt cap.
ALTER TABLE versions ADD COLUMN facts_status TEXT;

UPDATE versions SET facts_status = CASE
  WHEN facts_json IS NOT NULL THEN 'ok'
  WHEN (SELECT p.kind FROM pages p WHERE p.id = versions.page_id) NOT IN ('pricing', 'fees') THEN 'not_needed'
  WHEN is_baseline = 0 AND (SELECT r.judgment_relevant FROM runs r WHERE r.id = versions.run_id) = 0 THEN 'not_needed'
  WHEN capture_status = 'failed' AND screenshot_key IS NOT NULL AND html_key IS NOT NULL THEN 'unavailable'
  ELSE 'pending'
END;

-- A version that failed only for want of facts is complete: the screenshot and the source are stored.
UPDATE versions SET capture_status = 'complete' WHERE facts_status = 'unavailable' AND capture_status = 'failed';

-- A stored diff names the facts status of both its versions from now on; one stored before this
-- migration does not, so the cache is emptied and each diff is computed again on its next request.
DELETE FROM diff_cache;
