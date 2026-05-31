-- Migration 006: category-group models + risk-adjusted labels
--
-- Run in Supabase SQL Editor after backing up mf_features and mf_predictions.
-- Idempotent: uses ADD COLUMN IF NOT EXISTS.

-- ─── mf_features: cross-category momentum features ──────────────────────────
ALTER TABLE mf_features
  ADD COLUMN IF NOT EXISTS cat_momentum_3m     DOUBLE PRECISION,  -- median ret3m of this category
  ADD COLUMN IF NOT EXISTS cat_vs_univ_3m      DOUBLE PRECISION;  -- pct rank of that median vs all categories

-- ─── mf_features: risk-adjusted (Sharpe) forward labels ─────────────────────
ALTER TABLE mf_features
  ADD COLUMN IF NOT EXISTS fwd_sharpe_3m       DOUBLE PRECISION,  -- realized Sharpe over forward window
  ADD COLUMN IF NOT EXISTS fwd_sharpe_q_3m     SMALLINT,          -- 1 (top) to 4 (bottom) within category
  ADD COLUMN IF NOT EXISTS fwd_top_sharpe_q_3m BOOLEAN;           -- target for Sharpe-based classifier

-- ─── mf_predictions: category group tag ─────────────────────────────────────
ALTER TABLE mf_predictions
  ADD COLUMN IF NOT EXISTS category_group      TEXT,              -- equity / sector / fixed_income / hybrid / commodity / other
  ADD COLUMN IF NOT EXISTS p_top_sharpe_q_3m  DOUBLE PRECISION;  -- output of --sharpe-target model
