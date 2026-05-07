-- Run this in the Supabase SQL Editor (once, during setup)

create table if not exists radar_cache (
  key       text        primary key,
  data      jsonb       not null,
  built_at  timestamptz not null default now()
);

-- Row-level security: authenticated users can read, nobody can write via client
alter table radar_cache enable row level security;

create policy "authenticated read"
  on radar_cache for select
  to authenticated
  using (true);

-- The service_role key used by GitHub Actions bypasses RLS automatically.
-- No insert/update policy needed for the client.
