-- Migration 001: Add sentiment columns + mf_sentiment table
-- Run this in the Supabase SQL editor.
-- Idempotent: uses IF NOT EXISTS / DO $$ blocks.

-- ─── New column on mf_features ───────────────────────────────────────────────
-- sentiment_score: -1.0 (very negative) → 0 (neutral) → +1.0 (very positive)
-- Updated weekly by sentiment.py; NULL until first sentiment run.

DO $$ BEGIN
  ALTER TABLE mf_features ADD COLUMN sentiment_score DOUBLE PRECISION;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE mf_features ADD COLUMN sentiment_label TEXT;   -- Positive / Neutral / Negative
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE mf_features ADD COLUMN sentiment_as_of TIMESTAMPTZ; -- when sentiment was last computed
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ─── mf_sentiment ────────────────────────────────────────────────────────────
-- Full sentiment record per fund per week.
-- scheme_code + week_start_date is the natural key.

CREATE TABLE IF NOT EXISTS mf_sentiment (
  scheme_code        TEXT        NOT NULL,
  week_start_date    DATE        NOT NULL,   -- Monday of the analysis week

  -- Structured Claude output
  sentiment_score    DOUBLE PRECISION,       -- -1.0 to +1.0
  sentiment_label    TEXT,                   -- Positive / Neutral / Negative
  summary            TEXT,                   -- 2-3 sentence summary
  key_themes         JSONB,                  -- ["theme1", "theme2", ...]

  -- Raw input for auditability
  headlines_used     JSONB,                  -- list of headlines passed to Claude
  headline_count     INTEGER,

  -- Metadata
  model_used         TEXT DEFAULT 'claude-3-haiku-20240307',
  computed_at        TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (scheme_code, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_mf_sentiment_date
  ON mf_sentiment (week_start_date);
CREATE INDEX IF NOT EXISTS idx_mf_sentiment_score
  ON mf_sentiment (sentiment_score);
