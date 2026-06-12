-- Migration 013: system_health — queryable history of the nightly health digest
--
-- ml/health_report.py rolls every monitoring signal (source probe, feature
-- freshness, IC drift, OOS-vs-CV model gap, realized hit rate) into one row
-- per component per day. The markdown digest on the Actions run page is the
-- human view; this table is the machine-readable history, so "when did the
-- mfapi source start flapping?" is a one-line query.
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS system_health (
  run_date   DATE NOT NULL,
  component  TEXT NOT NULL,            -- sources | freshness | ic_drift | stock_model | mf_model | outcomes
  status     TEXT NOT NULL,            -- ok | unknown | warn | critical
  detail     TEXT,
  metrics    JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (run_date, component)
);

CREATE INDEX IF NOT EXISTS idx_system_health_status
  ON system_health (status, run_date) WHERE status IN ('warn', 'critical');
