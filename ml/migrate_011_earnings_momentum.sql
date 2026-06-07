-- Migration 011: earnings momentum features
--
--   Derived from Yahoo Finance earningsHistory + earningsTrend modules
--   (same quoteSummary call — zero extra HTTP requests):
--
--   earningsHistory  → last 4 quarters actual vs estimate
--     eps_beat_rate_4q     fraction of last 4 quarters where actual > estimate (0–1)
--     eps_surprise_avg_4q  average % surprise (positive = beat, negative = miss)
--     eps_qoq_slope        linear slope of actual EPS over last 4 quarters
--                          (positive = EPS growing, negative = shrinking)
--
--   earningsTrend   → analyst consensus estimate revisions
--     eps_rev_30d          % change in current-quarter EPS estimate over 30 days
--                          (positive = analysts raised estimate = bullish revision)
--     eps_rev_90d          % change in current-quarter EPS estimate over 90 days
--
--   Coverage note: Yahoo Finance analyst estimates cover ~60–70% of Nifty 500 stocks.
--   The remaining ~30–40% will have NULLs; the null-rate filter in train_stock.py
--   will retain these columns as long as coverage exceeds 70%.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Safe to re-run.

-- ─── stock_features ──────────────────────────────────────────────────────────
ALTER TABLE stock_features
  ADD COLUMN IF NOT EXISTS eps_beat_rate_4q     DOUBLE PRECISION,  -- 0-1, fraction of last 4 qtrs beating estimate
  ADD COLUMN IF NOT EXISTS eps_surprise_avg_4q  DOUBLE PRECISION,  -- avg % EPS surprise (positive = beat)
  ADD COLUMN IF NOT EXISTS eps_qoq_slope        DOUBLE PRECISION,  -- linear trend of actual EPS (direction signal)
  ADD COLUMN IF NOT EXISTS eps_rev_30d          DOUBLE PRECISION,  -- % analyst estimate revision over 30 days
  ADD COLUMN IF NOT EXISTS eps_rev_90d          DOUBLE PRECISION;  -- % analyst estimate revision over 90 days

-- ─── stock_fundamentals_history (daily snapshot) ─────────────────────────────
ALTER TABLE stock_fundamentals_history
  ADD COLUMN IF NOT EXISTS eps_beat_rate_4q     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS eps_surprise_avg_4q  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS eps_qoq_slope        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS eps_rev_30d          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS eps_rev_90d          DOUBLE PRECISION;
