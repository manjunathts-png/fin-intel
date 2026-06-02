-- Migration 008: Add category-relative risk z-score columns to mf_features
-- These are within-peer z-scores of absolute risk metrics.
-- A -25% drawdown in Small Cap ≠ -25% in Large Cap — normalization fixes this.
-- Computed nightly in extract_features.py (add_cross_sectional).

ALTER TABLE mf_features
    ADD COLUMN IF NOT EXISTS cat_rel_max_dd_1y    FLOAT,
    ADD COLUMN IF NOT EXISTS cat_rel_vol_1y        FLOAT,
    ADD COLUMN IF NOT EXISTS cat_rel_sharpe_1y     FLOAT,
    ADD COLUMN IF NOT EXISTS cat_rel_downside_dev  FLOAT;

COMMENT ON COLUMN mf_features.cat_rel_max_dd_1y    IS 'Within-category z-score of max_dd_1y. Negative = safer than peers.';
COMMENT ON COLUMN mf_features.cat_rel_vol_1y        IS 'Within-category z-score of vol_1y. Negative = less volatile than peers.';
COMMENT ON COLUMN mf_features.cat_rel_sharpe_1y     IS 'Within-category z-score of sharpe_1y. Positive = better risk-adj return than peers.';
COMMENT ON COLUMN mf_features.cat_rel_downside_dev  IS 'Within-category z-score of downside_dev_1y. Negative = lower downside vol than peers.';
