-- Migration 010: stock feature enhancements
--   - Multi-horizon momentum: ret2m, ret9m
--   - Delivery volume %: delivery_pct, delivery_pct_5d_avg
--   - Sector-relative z-scores (sector_rel_*) — mirror of cat_rel_* for MF
--   - Universe-relative z-scores (univ_rel_*)
--   - FII/DII rolling flows as macro features
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Safe to re-run.

-- ─── Multi-horizon momentum ──────────────────────────────────────────────────
ALTER TABLE stock_features
  ADD COLUMN IF NOT EXISTS ret2m              DOUBLE PRECISION,   -- 60-day return (%)
  ADD COLUMN IF NOT EXISTS ret9m              DOUBLE PRECISION;   -- 270-day return (%)

-- ─── Delivery volume % ────────────────────────────────────────────────────────
ALTER TABLE stock_features
  ADD COLUMN IF NOT EXISTS delivery_pct          DOUBLE PRECISION,  -- today's delivery % (DELIV_PER from NSE bhavcopy)
  ADD COLUMN IF NOT EXISTS delivery_pct_5d_avg   DOUBLE PRECISION;  -- 5-day rolling average delivery %

-- ─── Sector-relative z-scores (same pattern as MF cat_rel_*) ─────────────────
ALTER TABLE stock_features
  ADD COLUMN IF NOT EXISTS sector_rel_ret1m    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_ret2m    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_ret3m    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_ret6m    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_ret9m    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_vol30d   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_vol90d   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_vol1y    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_sharpe   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_sortino  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_rsi      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_bb       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_high52w  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_beta     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_maxdd    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sector_rel_delivery DOUBLE PRECISION;

-- ─── Universe-relative z-scores ───────────────────────────────────────────────
ALTER TABLE stock_features
  ADD COLUMN IF NOT EXISTS univ_rel_ret1m    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS univ_rel_ret3m    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS univ_rel_vol30d   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS univ_rel_sharpe   DOUBLE PRECISION;

-- ─── FII/DII rolling flow features (macro-level, same for all stocks on a date)
ALTER TABLE stock_features
  ADD COLUMN IF NOT EXISTS fii_net_5d       DOUBLE PRECISION,   -- 5-day rolling FII net (₹ crore)
  ADD COLUMN IF NOT EXISTS fii_net_20d      DOUBLE PRECISION,   -- 20-day rolling FII net (₹ crore)
  ADD COLUMN IF NOT EXISTS dii_net_5d       DOUBLE PRECISION,   -- 5-day rolling DII net (₹ crore)
  ADD COLUMN IF NOT EXISTS dii_net_20d      DOUBLE PRECISION,   -- 20-day rolling DII net (₹ crore)
  ADD COLUMN IF NOT EXISTS fiidii_net_5d    DOUBLE PRECISION,   -- combined FII+DII 5-day net
  ADD COLUMN IF NOT EXISTS fiidii_net_20d   DOUBLE PRECISION;   -- combined FII+DII 20-day net
