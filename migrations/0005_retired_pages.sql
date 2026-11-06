-- Retired pages (Task 14b). pages.status gains 'retired': a page whose Monitor was deleted on purpose
-- while its history stays. SQLite cannot alter a CHECK constraint, so the table is rebuilt with every
-- column (0003's pending_* included), every row and the UNIQUE index on url. Nothing references pages
-- by foreign key, and the row order (rowid) is kept: the lists order by created_at, then rowid.
CREATE TABLE pages_new (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE,
  label TEXT,
  kind TEXT CHECK (kind IN ('pricing', 'fees', 'policy', 'rules', 'other')),
  monitor_id TEXT,
  schedule_cron TEXT,
  purpose TEXT,
  status TEXT CHECK (status IN ('active', 'paused', 'failed', 'expired', 'retired')),
  added_by TEXT CHECK (added_by IN ('curated', 'public', 'admin')),
  ignore_patterns TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  created_at TEXT,
  last_run_at TEXT,
  last_change_at TEXT,
  pending_hash TEXT,
  pending_run_id TEXT,
  pending_at TEXT
);

INSERT INTO pages_new
  (id, url, label, kind, monitor_id, schedule_cron, purpose, status, added_by, ignore_patterns,
   expires_at, created_at, last_run_at, last_change_at, pending_hash, pending_run_id, pending_at)
SELECT
   id, url, label, kind, monitor_id, schedule_cron, purpose, status, added_by, ignore_patterns,
   expires_at, created_at, last_run_at, last_change_at, pending_hash, pending_run_id, pending_at
FROM pages ORDER BY rowid;

DROP TABLE pages;
ALTER TABLE pages_new RENAME TO pages;
