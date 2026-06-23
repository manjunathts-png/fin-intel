-- Migration 016: macro_flows — daily FII/DII equity flow time-series
--
-- Stores daily FII and DII net equity cash-segment flows (₹ crore) plus
-- rolling aggregates. Populated nightly by macro_features.py after fetching
-- from NSE's /api/fiidiiTradeReact endpoint. Read by the frontend FII tracker.
--
-- Safe to re-run (all statements are idempotent).

CREATE TABLE IF NOT EXISTS macro_flows (
  trade_date   DATE             PRIMARY KEY,
  fii_net_cr   DOUBLE PRECISION,            -- daily FII net equity (₹ crore)
  dii_net_cr   DOUBLE PRECISION,            -- daily DII net equity (₹ crore)
  fii_net_5d   DOUBLE PRECISION,            -- 5-day rolling sum FII (₹ crore)
  fii_net_20d  DOUBLE PRECISION,            -- 20-day rolling sum FII (₹ crore)
  dii_net_5d   DOUBLE PRECISION,            -- 5-day rolling sum DII (₹ crore)
  dii_net_20d  DOUBLE PRECISION,            -- 20-day rolling sum DII (₹ crore)
  updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);

ALTER TABLE macro_flows ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'macro_flows'
      AND policyname = 'authenticated read macro_flows'
  ) THEN
    EXECUTE 'CREATE POLICY "authenticated read macro_flows"
      ON macro_flows FOR SELECT
      TO authenticated
      USING (true)';
  END IF;
END
$$;
