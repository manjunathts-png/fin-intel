-- Migration 014: pick_ai_rationales — AI-generated investment rationales for MF picks
--
-- One row per fund (keyed on fund_code). Populated either by the dynamic
-- generate-ai-rationales.js (requires ANTHROPIC_API_KEY) or the point-in-time
-- seed scripts (backend/seed-ai-rationales-*.js). Both upsert with
-- onConflict:'fund_code', which requires the unique constraint below.
--
-- This table was missing from supabase-setup.sql; the seed scripts relied on
-- it already existing in the live database. This migration makes the schema
-- authoritative and idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS pick_ai_rationales (
  id           bigserial    primary key,
  fund_code    text         unique not null,
  fund_name    text         not null,
  category     text         not null,
  rank         int,
  analysis     jsonb        not null,
  generated_at timestamptz  not null default now()
);

-- Ensure the unique constraint exists even on tables created before this migration
-- (CREATE TABLE IF NOT EXISTS won't add a constraint to a pre-existing table).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'pick_ai_rationales'::regclass
      AND contype = 'u'
      AND conname = 'pick_ai_rationales_fund_code_key'
  ) THEN
    ALTER TABLE pick_ai_rationales ADD CONSTRAINT pick_ai_rationales_fund_code_key UNIQUE (fund_code);
  END IF;
END
$$;

ALTER TABLE pick_ai_rationales ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS — guard with a DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pick_ai_rationales'
      AND policyname = 'authenticated read ai rationales'
  ) THEN
    EXECUTE 'CREATE POLICY "authenticated read ai rationales"
      ON pick_ai_rationales FOR SELECT
      TO authenticated
      USING (true)';
  END IF;
END
$$;
