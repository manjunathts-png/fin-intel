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


-- ════════════════════════════════════════════════════════════════════════════
-- Stock ML tables (mirrors the MF tables above but for NSE-listed stocks)
-- ════════════════════════════════════════════════════════════════════════════

-- ─── stock_features ──────────────────────────────────────────────────────────
-- One row per (symbol, as_of_date) holding the full ~40-dimensional feature
-- vector for model training and daily inference.

CREATE TABLE IF NOT EXISTS stock_features (
  symbol              TEXT        NOT NULL,     -- NSE ticker without .NS, e.g. "TCS"
  as_of_date          DATE        NOT NULL,

  -- Identity
  stock_name          TEXT,
  sector              TEXT,

  -- Returns (%)
  ret1w               DOUBLE PRECISION,
  ret1m               DOUBLE PRECISION,
  ret3m               DOUBLE PRECISION,
  ret6m               DOUBLE PRECISION,
  ret1y               DOUBLE PRECISION,

  -- Risk
  vol_30d             DOUBLE PRECISION,
  vol_90d             DOUBLE PRECISION,
  vol_1y              DOUBLE PRECISION,
  max_dd_1y           DOUBLE PRECISION,
  downside_dev_1y     DOUBLE PRECISION,
  sharpe_1y           DOUBLE PRECISION,
  sortino_1y          DOUBLE PRECISION,

  -- Technical indicators
  rsi_14              DOUBLE PRECISION,   -- Wilder RSI(14); 0–100
  macd_hist           DOUBLE PRECISION,   -- MACD histogram (MACD line − signal)
  bb_pct              DOUBLE PRECISION,   -- Bollinger Band %B: 0=lower, 1=upper band
  vol_ratio           DOUBLE PRECISION,   -- today volume / 20-day avg volume
  high52w_pct         DOUBLE PRECISION,   -- % below 52-week high (negative means below)

  -- Momentum
  z1w                 DOUBLE PRECISION,   -- z-score of weekly return vs trailing 12 weeks
  positive_months_12m INTEGER,

  -- Cross-sectional (computed across full cohort on same date)
  sector_rank_1m      DOUBLE PRECISION,   -- percentile rank within sector (0=worst, 1=best)
  sector_rank_3m      DOUBLE PRECISION,
  sector_rank_1y      DOUBLE PRECISION,
  sector_z            DOUBLE PRECISION,   -- z-score of z1w within sector
  univ_rank_1m        DOUBLE PRECISION,   -- percentile rank across all stocks
  univ_rank_3m        DOUBLE PRECISION,
  univ_rank_1y        DOUBLE PRECISION,

  -- Style vs Nifty benchmark
  beta_nifty          DOUBLE PRECISION,
  alpha_nifty         DOUBLE PRECISION,   -- annualized excess return
  corr_nifty          DOUBLE PRECISION,

  -- Fundamentals snapshot (current values; historical rows approximate)
  pe_ratio            DOUBLE PRECISION,
  pb_ratio            DOUBLE PRECISION,
  roe                 DOUBLE PRECISION,   -- return on equity (%)
  revenue_growth      DOUBLE PRECISION,   -- YoY (%)
  earnings_growth     DOUBLE PRECISION,   -- YoY (%)
  profit_margins      DOUBLE PRECISION,   -- net profit margin (%)
  debt_to_equity      DOUBLE PRECISION,
  dividend_yield      DOUBLE PRECISION,   -- (%)

  -- Macro context (same across stocks on same date)
  nifty_ret1m         DOUBLE PRECISION,
  nifty_ret3m         DOUBLE PRECISION,
  india_vix           DOUBLE PRECISION,
  usd_inr             DOUBLE PRECISION,
  us_10y_yield        DOUBLE PRECISION,

  -- Target labels (backfilled once forward window has elapsed)
  fwd_ret_3m          DOUBLE PRECISION,   -- realized 3-month forward return (%)
  fwd_quartile_3m     SMALLINT,           -- 1 (top) to 4 (bottom) within sector
  fwd_top_q_3m        BOOLEAN,            -- binary target for classifier

  -- Bookkeeping
  computed_at         TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (symbol, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_features_date     ON stock_features (as_of_date);
CREATE INDEX IF NOT EXISTS idx_stock_features_sector   ON stock_features (sector, as_of_date);


-- ─── stock_predictions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stock_predictions (
  symbol              TEXT        NOT NULL,
  prediction_date     DATE        NOT NULL,
  model_version       TEXT        NOT NULL,

  p_top_quartile_3m   DOUBLE PRECISION,   -- calibrated probability [0, 1]
  pred_rank           INTEGER,            -- overall rank by p_top_quartile_3m
  pred_sector_rank    INTEGER,            -- rank within sector

  top_features        JSONB,              -- [{name, value, shap}] top 5 contributors

  computed_at         TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (symbol, prediction_date, model_version)
);

CREATE INDEX IF NOT EXISTS idx_stock_predictions_date ON stock_predictions (prediction_date);


-- ─── stock_model_runs ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stock_model_runs (
  id                  SERIAL PRIMARY KEY,
  model_version       TEXT        NOT NULL,
  trained_at          TIMESTAMPTZ DEFAULT NOW(),

  feature_count       INTEGER,
  training_samples    INTEGER,
  training_window     TEXT,

  cv_auc              DOUBLE PRECISION,
  cv_precision_top_q  DOUBLE PRECISION,
  backtest_ann_return DOUBLE PRECISION,
  backtest_benchmark  DOUBLE PRECISION,
  backtest_alpha      DOUBLE PRECISION,

  hyperparams         JSONB,
  feature_importance  JSONB,
  notes               TEXT
);
