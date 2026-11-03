-- Fineprint schema. Timestamps are ISO 8601 UTC strings; ids are UUIDs.

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE,
  label TEXT,
  kind TEXT CHECK (kind IN ('pricing', 'fees', 'policy', 'rules', 'other')),
  monitor_id TEXT,
  schedule_cron TEXT,
  purpose TEXT,
  status TEXT CHECK (status IN ('active', 'paused', 'failed', 'expired')),
  added_by TEXT CHECK (added_by IN ('curated', 'public', 'admin')),
  ignore_patterns TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  created_at TEXT,
  last_run_at TEXT,
  last_change_at TEXT
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  page_id TEXT,
  monitor_run_id TEXT UNIQUE,
  outcome TEXT,
  is_baseline INTEGER,
  judgment_relevant INTEGER,
  judgment_summary TEXT,
  diff_truncated INTEGER,
  noise_suppressed INTEGER DEFAULT 0,
  noise_reason TEXT,
  raw_key TEXT,
  received_at TEXT
);
CREATE INDEX idx_runs_page_received ON runs (page_id, received_at);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  page_id TEXT,
  run_id TEXT,
  is_baseline INTEGER,
  captured_at TEXT,
  text TEXT,
  normalized_hash TEXT,
  judgment_summary TEXT,
  screenshot_key TEXT,
  html_key TEXT,
  facts_json TEXT,
  capture_status TEXT NOT NULL DEFAULT 'pending',
  capture_error TEXT,
  capture_attempts INTEGER DEFAULT 0,
  agent_run_id TEXT
);
CREATE INDEX idx_versions_page_captured ON versions (page_id, captured_at);

CREATE TABLE diff_cache (
  from_version_id TEXT,
  to_version_id TEXT,
  json TEXT,
  created_at TEXT,
  PRIMARY KEY (from_version_id, to_version_id)
);

CREATE TABLE spend (
  id TEXT PRIMARY KEY,
  kind TEXT,
  amount_usd REAL,
  ref TEXT,
  at TEXT
);

CREATE TABLE public_adds (
  ip_hash TEXT,
  day TEXT,
  count INTEGER,
  PRIMARY KEY (ip_hash, day)
);
