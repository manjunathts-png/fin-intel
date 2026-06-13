-- Multi-window labels, fundamentals history, 1M prediction columns
-- Run once in Supabase SQL Editor
-- Dashboard → SQL Editor → New Query → paste → Run

-- ── 1. 1-month label columns on stock_features ────────────────────────────────
ALTER TABLE stock_features ADD COLUMN IF NOT EXISTS fwd_ret_1m      DOUBLE PRECISION;
ALTER TABLE stock_features ADD COLUMN IF NOT EXISTS fwd_quartile_1m SMALLINT;
ALTER TABLE stock_features ADD COLUMN IF NOT EXISTS fwd_top_q_1m    BOOLEAN;

-- ── 2. 1-month label columns on mf_features ───────────────────────────────────
ALTER TABLE mf_features ADD COLUMN IF NOT EXISTS fwd_ret_1m      DOUBLE PRECISION;
ALTER TABLE mf_features ADD COLUMN IF NOT EXISTS fwd_quartile_1m SMALLINT;
ALTER TABLE mf_features ADD COLUMN IF NOT EXISTS fwd_top_q_1m    BOOLEAN;

-- ── 3. 1-month prediction column on predictions tables ────────────────────────
ALTER TABLE stock_predictions ADD COLUMN IF NOT EXISTS p_top_quartile_1m DOUBLE PRECISION;
ALTER TABLE mf_predictions    ADD COLUMN IF NOT EXISTS p_top_quartile_1m DOUBLE PRECISION;

-- ── 4. Point-in-time fundamentals history ────────────────────────────────────
-- Grows one row per (symbol, date) each daily run; used to join proper
-- historical fundamentals instead of today's snapshot for all past rows.
CREATE TABLE IF NOT EXISTS stock_fundamentals_history (
  symbol          TEXT             NOT NULL,
  snapshot_date   DATE             NOT NULL,
  pe_ratio        DOUBLE PRECISION,
  pb_ratio        DOUBLE PRECISION,
  roe             DOUBLE PRECISION,
  revenue_growth  DOUBLE PRECISION,
  earnings_growth DOUBLE PRECISION,
  profit_margins  DOUBLE PRECISION,
  debt_to_equity  DOUBLE PRECISION,
  dividend_yield  DOUBLE PRECISION,
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (symbol, snapshot_date)
);

ALTER TABLE stock_fundamentals_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='stock_fundamentals_history' AND policyname='Allow public read on stock_fundamentals_history') THEN
    CREATE POLICY "Allow public read on stock_fundamentals_history" ON stock_fundamentals_history FOR SELECT USING (true);
  END IF;
END $$;
