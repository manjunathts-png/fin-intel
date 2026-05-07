-- Run this in the Supabase SQL Editor (once, during setup)

-- ─── Radar cache ─────────────────────────────────────────────────────────────

create table if not exists radar_cache (
  key       text        primary key,
  data      jsonb       not null,
  built_at  timestamptz not null default now()
);

alter table radar_cache enable row level security;

create policy "authenticated read"
  on radar_cache for select
  to authenticated
  using (true);

-- The service_role key used by GitHub Actions bypasses RLS automatically.

-- ─── User profiles ────────────────────────────────────────────────────────────
-- Populated on first login from the frontend. Mirrors key auth.users fields.

create table if not exists profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  email       text        not null,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Each user can upsert their own row
create policy "upsert own profile"
  on profiles for all
  to authenticated
  using  (auth.uid() = id)
  with check (auth.uid() = id);

-- Admin can read all profiles
create policy "admin read profiles"
  on profiles for select
  to authenticated
  using ((auth.jwt() ->> 'email') = 'manjunathts@gmail.com');

-- ─── User events ─────────────────────────────────────────────────────────────
-- Page views and actions logged from the frontend.

create table if not exists user_events (
  id         bigserial   primary key,
  user_id    uuid        references auth.users(id) on delete cascade,
  email      text,
  event      text        not null,  -- e.g. 'login', 'page_view'
  page       text,                  -- e.g. '/mf', '/stocks'
  created_at timestamptz not null default now()
);

alter table user_events enable row level security;

-- Users can insert their own events
create policy "insert own events"
  on user_events for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Admin can read all events
create policy "admin read events"
  on user_events for select
  to authenticated
  using ((auth.jwt() ->> 'email') = 'manjunathts@gmail.com');
