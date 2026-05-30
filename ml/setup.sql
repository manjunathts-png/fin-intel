-- Supabase schema for the MF ML pipeline.
--
-- Run this in the Supabase SQL editor once.
-- Idempotent: safe to re-run (uses CREATE TABLE IF NOT EXISTS).

-- ─── mf_features ────────────────────────────────────────────────────────────
-- One row per (scheme_code, as_of_date) holding the full feature vector for
-- model training and inference.
--
-- All numeric features are stored as DOUBLE PRECISION. Categorical features
-- (like `category`) stored as TEXT. Add columns over time as the feature set
-- evolves — Postgres handles that gracefully.

CREATE TABLE IF NOT EXISTS mf_features (
  scheme_code        TEXT        NOT NULL,
  as_of_date         DATE        NOT NULL,

  -- Identity
  fund_name          TEXT,
  category           TEXT,

  -- Returns over standard windows (%)
  ret1w              DOUBLE PRECISION,
  ret1m              DOUBLE PRECISION,
  ret3m              DOUBLE PRECISION,
  ret6m              DOUBLE PRECISION,
  ret1y              DOUBLE PRECISION,
  ret3y              DOUBLE PRECISION,
  ret5y              DOUBLE PRECISION,
  cagr5y             DOUBLE PRECISION,
  cagr10y            DOUBLE PRECISION,

  -- Volatility + risk
  vol_30d            DOUBLE PRECISION,    -- annualized stddev of daily returns over last 30d
  vol_90d            DOUBLE PRECISION,
  vol_1y             DOUBLE PRECISION,
  max_dd_1y          DOUBLE PRECISION,    -- max drawdown over last 1y (%)
  downside_dev_1y    DOUBLE PRECISION,    -- downside deviation (negative-returns-only stddev)
  sharpe_1y          DOUBLE PRECISION,    -- (ret1y - rf) / vol_1y, rf assumed 7% India
  sortino_1y         DOUBLE PRECISION,

  -- Momentum z-score (existing fin-intel metric)
  z1w                DOUBLE PRECISION,
  z1m                DOUBLE PRECISION,

  -- Category-relative (cross-sectional rank within category)
  cat_rank_1m        DOUBLE PRECISION,    -- 0 (worst) to 1 (best)
  cat_rank_3m        DOUBLE PRECISION,
  cat_rank_1y        DOUBLE PRECISION,
  cat_z              DOUBLE PRECISION,    -- category-level z-score (peer group momentum)

  -- Cross-sectional rank vs ALL funds
  univ_rank_1m       DOUBLE PRECISION,
  univ_rank_3m       DOUBLE PRECISION,
  univ_rank_1y       DOUBLE PRECISION,

  -- Style / consistency
  positive_months_12m INTEGER,             -- count of positive-return months in last 12
  beta_nifty         DOUBLE PRECISION,    -- regression slope vs Nifty 1y daily returns
  alpha_nifty        DOUBLE PRECISION,    -- intercept × 252 (annualized excess)
  corr_nifty         DOUBLE PRECISION,    -- correlation with Nifty

  -- Macro snapshot (replicated per row — same value across funds on same date)
  nifty_ret1m        DOUBLE PRECISION,
  nifty_ret3m        DOUBLE PRECISION,
  india_vix          DOUBLE PRECISION,
  usd_inr            DOUBLE PRECISION,
  us_10y_yield       DOUBLE PRECISION,

  -- Target labels (filled in retroactively for training rows)
  -- These are NULL on the latest as_of_date; populated on backfill once
  -- the future window has elapsed.
  fwd_ret_3m         DOUBLE PRECISION,    -- realized 3-month forward return
  fwd_quartile_3m    SMALLINT,            -- 1 (top) to 4 (bottom) within category
  fwd_top_q_3m       BOOLEAN,             -- target for binary classifier

  -- Bookkeeping
  computed_at        TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (scheme_code, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_mf_features_date ON mf_features (as_of_date);
CREATE INDEX IF NOT EXISTS idx_mf_features_category_date ON mf_features (category, as_of_date);


-- ─── mf_predictions ─────────────────────────────────────────────────────────
-- One row per (scheme_code, prediction_date) with the model's output.
-- Multiple models can coexist via model_version.

CREATE TABLE IF NOT EXISTS mf_predictions (
  scheme_code        TEXT        NOT NULL,
  prediction_date    DATE        NOT NULL,
  model_version      TEXT        NOT NULL,     -- e.g., "lgbm_v1.0_2026-05-30"

  -- Predictions
  p_top_quartile_3m  DOUBLE PRECISION,         -- calibrated probability [0, 1]
  pred_rank          INTEGER,                  -- overall rank by p_top_quartile_3m
  pred_cat_rank      INTEGER,                  -- rank within category

  -- Feature importance for THIS prediction (top 5 contributors)
  top_features       JSONB,                    -- [{name, value, shap}]

  -- Bookkeeping
  computed_at        TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (scheme_code, prediction_date, model_version)
);

CREATE INDEX IF NOT EXISTS idx_mf_predictions_date ON mf_predictions (prediction_date);


-- ─── mf_model_runs ──────────────────────────────────────────────────────────
-- Audit log of every training run + backtest result.

CREATE TABLE IF NOT EXISTS mf_model_runs (
  id                 SERIAL PRIMARY KEY,
  model_version      TEXT        NOT NULL,
  trained_at         TIMESTAMPTZ DEFAULT NOW(),

  -- What went in
  feature_count      INTEGER,
  training_samples   INTEGER,
  training_window    TEXT,                     -- e.g., "2023-01-01 to 2025-12-31"

  -- What came out
  cv_auc             DOUBLE PRECISION,         -- cross-validated AUC
  cv_precision_top_q DOUBLE PRECISION,         -- precision on top quartile prediction
  backtest_ann_return DOUBLE PRECISION,        -- annualized return of predicted top quartile
  backtest_benchmark  DOUBLE PRECISION,        -- Nifty 50 same period
  backtest_alpha     DOUBLE PRECISION,         -- model return - benchmark

  -- Model metadata
  hyperparams        JSONB,
  feature_importance JSONB,                    -- top 20 features ranked
  notes              TEXT
);
