-- Stock ML tables — run this once in the Supabase SQL Editor
-- Dashboard → SQL Editor → New Query → paste → Run
--
-- Mirrors the MF tables (mf_features, mf_predictions, mf_model_runs)
-- but keyed by NSE ticker symbol instead of scheme_code.

CREATE TABLE IF NOT EXISTS stock_features (
  symbol              TEXT        NOT NULL,
  as_of_date          DATE        NOT NULL,
  stock_name          TEXT,
  sector              TEXT,
  ret1w               DOUBLE PRECISION,
  ret1m               DOUBLE PRECISION,
  ret3m               DOUBLE PRECISION,
  ret6m               DOUBLE PRECISION,
  ret1y               DOUBLE PRECISION,
  vol_30d             DOUBLE PRECISION,
  vol_90d             DOUBLE PRECISION,
  vol_1y              DOUBLE PRECISION,
  max_dd_1y           DOUBLE PRECISION,
  downside_dev_1y     DOUBLE PRECISION,
  sharpe_1y           DOUBLE PRECISION,
  sortino_1y          DOUBLE PRECISION,
  rsi_14              DOUBLE PRECISION,
  macd_hist           DOUBLE PRECISION,
  bb_pct              DOUBLE PRECISION,
  vol_ratio           DOUBLE PRECISION,
  high52w_pct         DOUBLE PRECISION,
  z1w                 DOUBLE PRECISION,
  positive_months_12m INTEGER,
  sector_rank_1m      DOUBLE PRECISION,
  sector_rank_3m      DOUBLE PRECISION,
  sector_rank_1y      DOUBLE PRECISION,
  sector_z            DOUBLE PRECISION,
  univ_rank_1m        DOUBLE PRECISION,
  univ_rank_3m        DOUBLE PRECISION,
  univ_rank_1y        DOUBLE PRECISION,
  beta_nifty          DOUBLE PRECISION,
  alpha_nifty         DOUBLE PRECISION,
  corr_nifty          DOUBLE PRECISION,
  pe_ratio            DOUBLE PRECISION,
  pb_ratio            DOUBLE PRECISION,
  roe                 DOUBLE PRECISION,
  revenue_growth      DOUBLE PRECISION,
  earnings_growth     DOUBLE PRECISION,
  profit_margins      DOUBLE PRECISION,
  debt_to_equity      DOUBLE PRECISION,
  dividend_yield      DOUBLE PRECISION,
  nifty_ret1m         DOUBLE PRECISION,
  nifty_ret3m         DOUBLE PRECISION,
  india_vix           DOUBLE PRECISION,
  usd_inr             DOUBLE PRECISION,
  us_10y_yield        DOUBLE PRECISION,
  fwd_ret_3m          DOUBLE PRECISION,
  fwd_quartile_3m     SMALLINT,
  fwd_top_q_3m        BOOLEAN,
  computed_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (symbol, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_features_date
  ON stock_features (as_of_date);
CREATE INDEX IF NOT EXISTS idx_stock_features_sector
  ON stock_features (sector, as_of_date);


CREATE TABLE IF NOT EXISTS stock_predictions (
  symbol              TEXT        NOT NULL,
  prediction_date     DATE        NOT NULL,
  model_version       TEXT        NOT NULL,
  p_top_quartile_3m   DOUBLE PRECISION,
  pred_rank           INTEGER,
  pred_sector_rank    INTEGER,
  top_features        JSONB,
  computed_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (symbol, prediction_date, model_version)
);

CREATE INDEX IF NOT EXISTS idx_stock_predictions_date
  ON stock_predictions (prediction_date);


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


-- ── RLS (mirrors mf_features / mf_predictions / mf_model_runs setup) ──────────

ALTER TABLE stock_features     ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_predictions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_model_runs   ENABLE ROW LEVEL SECURITY;

-- Allow anyone (anon + authenticated) to SELECT — same as MF tables
CREATE POLICY "Allow public read on stock_features"
  ON stock_features FOR SELECT USING (true);

CREATE POLICY "Allow public read on stock_predictions"
  ON stock_predictions FOR SELECT USING (true);

CREATE POLICY "Allow public read on stock_model_runs"
  ON stock_model_runs FOR SELECT USING (true);
