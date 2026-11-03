// Row types mirroring migrations/0001_init.sql. Column names stay snake_case so a
// row read from D1 is the object. Booleans are stored as the integers 1 and 0;
// a nullable column that was never set is NULL (null here).

import type { SpendKind } from "../core/spend";

export type PageKind = "pricing" | "fees" | "policy" | "rules" | "other";
export type PageStatus = "active" | "paused" | "failed" | "expired";
export type AddedBy = "curated" | "public" | "admin";

/**
 * pending: no capture attempted yet, or retries remain. partial: one of the
 * captures (screenshot, source, facts) is still missing. awaiting_facts: the
 * Agent run has started and a callback will finish it; a serial facts queue
 * owns the version, so the repair cron must not touch it. complete / failed:
 * terminal.
 */
export type CaptureStatus = "pending" | "partial" | "awaiting_facts" | "complete" | "failed";

export interface PageRow {
  id: string;
  url: string;
  label: string;
  kind: PageKind;
  monitor_id: string | null;
  schedule_cron: string | null;
  purpose: string | null;
  status: PageStatus;
  added_by: AddedBy;
  /** JSON array of regex strings, stored as text. Defaults to '[]'. */
  ignore_patterns: string;
  expires_at: string | null;
  created_at: string;
  last_run_at: string | null;
  last_change_at: string | null;
}

/**
 * Which way a run reached Fineprint (migrations/0002_run_trigger.sql): create, the baseline the
 * Monitor create returned; webhook, a scheduled run TinyFish delivered; pull, an overdue check
 * the hourly cron ran with run-now. The API calls it `trigger`.
 */
export type TriggerKind = "create" | "webhook" | "pull";

export interface RunRow {
  id: string;
  page_id: string;
  /** TinyFish's run id; unique, so a webhook retry or a second pull of one run cannot create a second row. */
  monitor_run_id: string;
  outcome: string;
  /** 1 or 0. */
  is_baseline: number;
  /** 1, 0, or null when the Monitor gave no judgment. */
  judgment_relevant: number | null;
  judgment_summary: string | null;
  /** 1 or 0. */
  diff_truncated: number;
  /** 1 or 0. */
  noise_suppressed: number;
  noise_reason: string | null;
  raw_key: string | null;
  received_at: string;
  trigger_kind: TriggerKind;
}

export interface VersionRow {
  id: string;
  page_id: string;
  run_id: string | null;
  /** 1 or 0. */
  is_baseline: number;
  captured_at: string;
  text: string;
  normalized_hash: string;
  judgment_summary: string | null;
  screenshot_key: string | null;
  html_key: string | null;
  facts_json: string | null;
  capture_status: CaptureStatus;
  capture_error: string | null;
  capture_attempts: number;
  agent_run_id: string | null;
}

export interface SpendRow {
  id: string;
  kind: SpendKind;
  amount_usd: number;
  ref: string;
  at: string;
}
