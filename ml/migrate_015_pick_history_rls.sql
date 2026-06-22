-- Migration 015: add RLS read policy for pick_history
--
-- migrate_012 created the pick_history table but did not add an RLS SELECT
-- policy, so authenticated frontend users get 0 rows back from Supabase
-- (even though the table exists and contains data). The track-record panel
-- on /stocks/picks reads this table and must be accessible to all logged-in
-- users.
--
-- Safe to re-run.

ALTER TABLE pick_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pick_history'
      AND policyname = 'authenticated read pick_history'
  ) THEN
    EXECUTE 'CREATE POLICY "authenticated read pick_history"
      ON pick_history FOR SELECT
      TO authenticated
      USING (true)';
  END IF;
END
$$;
