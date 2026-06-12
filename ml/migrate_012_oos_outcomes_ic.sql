-- Migration 012: validation + feedback-loop infrastructure
--
--   1. oos_* columns on model-run audit tables — walk-forward out-of-sample
--      metrics (last 90 days of labeled history held out from training).
--      The ML blend gate now prefers oos_auc over cv_auc when present.
--
--   2. pick_history — nightly snapshot of the top-ranked picks, later
--      backfilled with realized forward returns by ml/track_pick_outcomes.py.
--      This is the realized-P&L feedback loop: without it there is no ground
--      truth on whether the published picks actually made money.
--
--   3. signal_ic_history — rolling 30-date cross-sectional IC per signal,
--      written nightly by ml/ic_monitor.py. Detects signal drift (e.g. the
--      mean-reversion edge on ret3m flipping sign in a new regime).
--
--   4. stock_features.delivery_z — delivery-spike z-score: recent 5-session
--      mean DELIV_PER vs its own 63-session baseline. The *spike* in delivery
--      is more informative than the level (a stock that always prints 35%
--      delivery is less interesting than one jumping from 15% to 30%).
--
-- Idempotent (IF NOT EXISTS everywhere). Safe to re-run.

-- ─── 1. Out-of-sample metrics on model runs ──────────────────────────────────
ALTER TABLE stock_model_runs
  ADD COLUMN IF NOT EXISTS oos_auc             DOUBLE PRECISION,  -- AUC on 90d holdout
  ADD COLUMN IF NOT EXISTS oos_precision_top_q DOUBLE PRECISION,  -- hit rate of holdout top quartile
  ADD COLUMN IF NOT EXISTS oos_samples         INTEGER;           -- holdout row count

ALTER TABLE mf_model_runs
  ADD COLUMN IF NOT EXISTS oos_auc             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS oos_precision_top_q DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS oos_samples         INTEGER;

-- ─── 2. Pick history + realized outcomes ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS pick_history (
  pick_date        DATE NOT NULL,
  symbol           TEXT NOT NULL,
  rank             INTEGER NOT NULL,
  composite_score  DOUBLE PRECISION,
  eod_base_score   DOUBLE PRECISION,
  ml_score         DOUBLE PRECISION,
  days_in_top50    INTEGER,
  -- Realized outcomes, backfilled by ml/track_pick_outcomes.py.
  -- Entry = first close strictly AFTER pick_date (next trading day) — picks
  -- are computed at EOD, so this is the earliest realistic fill.
  entry_close      DOUBLE PRECISION,
  ret_5d           DOUBLE PRECISION,   -- % return entry → entry+5 trading days
  ret_10d          DOUBLE PRECISION,
  ret_21d          DOUBLE PRECISION,   -- ~1 calendar month
  outcomes_updated_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (pick_date, symbol)
);

CREATE INDEX IF NOT EXISTS idx_pick_history_pending
  ON pick_history (pick_date) WHERE ret_21d IS NULL;

-- ─── 3. Rolling signal IC history ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signal_ic_history (
  run_date      DATE NOT NULL,
  horizon       TEXT NOT NULL,            -- '1m' | '3m'
  signal        TEXT NOT NULL,
  ic_mean       DOUBLE PRECISION,         -- mean per-date Spearman IC over the window
  ic_tstat      DOUBLE PRECISION,
  n_dates       INTEGER,
  expected_sign INTEGER,                  -- -1 / +1 from the calibration backtest
  sign_flipped  BOOLEAN,                  -- true = significant IC opposite to expectation
  created_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (run_date, horizon, signal)
);

-- ─── 4. Delivery-spike z-score feature ───────────────────────────────────────
ALTER TABLE stock_features
  ADD COLUMN IF NOT EXISTS delivery_z DOUBLE PRECISION;
