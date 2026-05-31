-- Migration 007: stock pipeline improvements — sector momentum + Sharpe labels
--
-- Run in Supabase SQL Editor. Idempotent (ADD COLUMN IF NOT EXISTS).

-- ─── stock_features: cross-sector momentum features ─────────────────────────
ALTER TABLE stock_features
  ADD COLUMN IF NOT EXISTS sector_momentum_3m    DOUBLE PRECISION,  -- median ret3m of this sector
  ADD COLUMN IF NOT EXISTS sector_vs_univ_3m     DOUBLE PRECISION;  -- pct rank of that median vs all sectors

-- ─── stock_features: risk-adjusted (Sharpe) forward labels ──────────────────
ALTER TABLE stock_features
  ADD COLUMN IF NOT EXISTS fwd_sharpe_3m         DOUBLE PRECISION,  -- realized Sharpe over forward window
  ADD COLUMN IF NOT EXISTS fwd_sharpe_q_3m       SMALLINT,          -- 1 (top) to 4 (bottom), universe-wide
  ADD COLUMN IF NOT EXISTS fwd_top_sharpe_q_3m   BOOLEAN;           -- binary target for Sharpe-based model

-- ─── stock_predictions: Sharpe-based probability output ─────────────────────
ALTER TABLE stock_predictions
  ADD COLUMN IF NOT EXISTS p_top_sharpe_q_3m     DOUBLE PRECISION;
