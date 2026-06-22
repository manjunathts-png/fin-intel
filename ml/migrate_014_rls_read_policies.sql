-- Migration 014: RLS read policies for frontend-visible tables
--
-- Supabase enables RLS by default; without explicit policies the anon/
-- authenticated client returns 0 rows even when data exists. The backend
-- writes with the service key (bypasses RLS) so data is present — the
-- frontend just couldn't read it.
--
-- Tables here are read-only for the frontend (non-sensitive operational
-- data). We grant SELECT to authenticated users only, which matches the
-- Auth guard already in place on the Admin page.
--
-- Idempotent — safe to re-run.

-- system_health: nightly pipeline digest (Admin page health tab)
ALTER TABLE system_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "system_health_select_authenticated" ON system_health;
CREATE POLICY "system_health_select_authenticated"
  ON system_health FOR SELECT
  TO authenticated
  USING (true);

-- signal_ic_history: IC drift data (Admin page model tab)
ALTER TABLE signal_ic_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signal_ic_history_select_authenticated" ON signal_ic_history;
CREATE POLICY "signal_ic_history_select_authenticated"
  ON signal_ic_history FOR SELECT
  TO authenticated
  USING (true);

-- stock_model_runs: AUC audit log (Admin page model tab)
ALTER TABLE stock_model_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_model_runs_select_authenticated" ON stock_model_runs;
CREATE POLICY "stock_model_runs_select_authenticated"
  ON stock_model_runs FOR SELECT
  TO authenticated
  USING (true);

-- mf_model_runs: MF model AUC log (Admin page model tab)
ALTER TABLE mf_model_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mf_model_runs_select_authenticated" ON mf_model_runs;
CREATE POLICY "mf_model_runs_select_authenticated"
  ON mf_model_runs FOR SELECT
  TO authenticated
  USING (true);
