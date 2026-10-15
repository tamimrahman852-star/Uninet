-- Uninet auth-service: profiles table, RLS and signup trigger.
-- Run in the Supabase SQL editor (or as a migration).

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text unique check (username ~ '^[a-z0-9_]{3,30}$'),
  full_name   text check (char_length(full_name) <= 120),
  avatar_url  text,
  bio         text check (char_length(bio) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists profiles_username_idx on public.profiles (username);

alter table public.profiles enable row level security;

-- Anyone signed in can read public profile data.
drop policy if exists "profiles are readable by authenticated users" on public.profiles;
create policy "profiles are readable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

-- Users can only modify their own profile when talking to Supabase directly.
-- (The auth-service uses the service role key, which bypasses RLS.)
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Create a profile row automatically for every new auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired_username text := nullif(lower(new.raw_user_meta_data ->> 'username'), '');
begin
  begin
    insert into public.profiles (id, username, full_name)
    values (new.id, desired_username, nullif(new.raw_user_meta_data ->> 'full_name', ''));
  exception when unique_violation then
    -- Username raced with another signup: create the profile without it.
    insert into public.profiles (id, full_name)
    values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''));
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Device sessions (informational; Supabase Auth owns the real sessions).
-- Lets users see and revoke the devices they are signed in on.
-- ---------------------------------------------------------------------------
create table if not exists public.device_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  device_name  text,
  platform     text check (platform in ('web', 'android', 'ios', 'other')),
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists device_sessions_user_idx on public.device_sessions (user_id, last_seen_at desc);

alter table public.device_sessions enable row level security;

drop policy if exists "users read own device sessions" on public.device_sessions;
create policy "users read own device sessions" on public.device_sessions
  for select to authenticated using (auth.uid() = user_id);
