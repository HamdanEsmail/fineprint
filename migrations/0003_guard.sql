-- Partial-render guard and flap suppression (Task 14a).
-- A `changed` read that looks like a page that rendered only in part creates no version; the page is
-- marked for a confirm read instead: pending_hash is the suspect read's normalized hash, pending_run_id
-- is Fineprint's runs.id of the suspect run, pending_at when it was received (ISO).
ALTER TABLE pages ADD COLUMN pending_hash TEXT;
ALTER TABLE pages ADD COLUMN pending_run_id TEXT;
ALTER TABLE pages ADD COLUMN pending_at TEXT;

-- Why a version exists when it is not the plain result of one read (a confirmed suspect read).
ALTER TABLE versions ADD COLUMN notes TEXT;
