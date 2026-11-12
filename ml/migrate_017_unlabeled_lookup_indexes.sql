-- Partial indexes for the "find rows still needing a forward label" queries
-- in label_targets.py / label_stock_targets.py (load_unlabeled() and
-- backfill_sharpe_labels()).
--
-- Both scripts keyset-paginate over `stock_features`/`mf_features` filtered
-- on a boolean target column IS NULL. Neither table had an index usable for
-- that filter (only (as_of_date) and (sector/category, as_of_date) exist),
-- so Postgres had to scan an as_of_date-ordered range and discard
-- already-labeled rows to find the next page of NULLs. As each table grows
-- by one row per symbol/scheme per day, that scan range grows right along
-- with it even though the actual backlog of unlabeled rows stays small —
-- this hit a statement timeout (57014) on label_stock_targets.py on
-- 2026-11-12 once stock_features grew large enough.
--
-- A partial index containing ONLY the still-unlabeled rows keeps lookup
-- cost proportional to the backlog, not to total table size.

CREATE INDEX IF NOT EXISTS idx_stock_features_unlabeled_3m
  ON stock_features (as_of_date, symbol)
  WHERE fwd_top_q_3m IS NULL;

CREATE INDEX IF NOT EXISTS idx_stock_features_unlabeled_1m
  ON stock_features (as_of_date, symbol)
  WHERE fwd_top_q_1m IS NULL;

CREATE INDEX IF NOT EXISTS idx_mf_features_unlabeled_3m
  ON mf_features (as_of_date, scheme_code)
  WHERE fwd_top_q_3m IS NULL;

CREATE INDEX IF NOT EXISTS idx_mf_features_unlabeled_1m
  ON mf_features (as_of_date, scheme_code)
  WHERE fwd_top_q_1m IS NULL;

-- backfill_sharpe_labels() in label_targets.py: rows with a return label
-- already set but the Sharpe label still missing.
CREATE INDEX IF NOT EXISTS idx_mf_features_unlabeled_sharpe_3m
  ON mf_features (as_of_date, scheme_code)
  WHERE fwd_top_q_3m IS NOT NULL AND fwd_top_sharpe_q_3m IS NULL;
