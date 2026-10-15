-- Uninet media-service schema (run after the auth-service schema: video_comments references public.profiles).

create table if not exists public.videos (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  title            text not null check (char_length(title) between 1 and 150),
  description      text not null default '',
  status           text not null default 'uploading' check (status in ('uploading', 'processing', 'ready', 'failed')),
  error            text,
  duration_seconds numeric(10, 2),
  width            integer,
  height           integer,
  renditions       text[] not null default '{}',
  hls_path         text,
  thumbnail_path   text,
  source_path      text,
  view_count       bigint not null default 0,
  like_count       integer not null default 0,
  comment_count    integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  search           tsvector generated always as (
                     to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
                   ) stored
);

create index if not exists videos_search_idx on public.videos using gin (search);
create index if not exists videos_ready_created_idx on public.videos (created_at desc) where status = 'ready';
create index if not exists videos_user_idx on public.videos (user_id, created_at desc);

create table if not exists public.video_likes (
  video_id   uuid not null references public.videos (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (video_id, user_id)
);

create table if not exists public.video_comments (
  id         uuid primary key default gen_random_uuid(),
  video_id   uuid not null references public.videos (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists video_comments_video_idx on public.video_comments (video_id, created_at desc);

create or replace function public.bump_like_count() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update public.videos set like_count = like_count + 1 where id = new.video_id;
  elsif tg_op = 'DELETE' then
    update public.videos set like_count = greatest(like_count - 1, 0) where id = old.video_id;
  end if;
  return null;
end $$;

drop trigger if exists video_likes_count on public.video_likes;
create trigger video_likes_count after insert or delete on public.video_likes
  for each row execute function public.bump_like_count();

create or replace function public.bump_comment_count() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update public.videos set comment_count = comment_count + 1 where id = new.video_id;
  elsif tg_op = 'DELETE' then
    update public.videos set comment_count = greatest(comment_count - 1, 0) where id = old.video_id;
  end if;
  return null;
end $$;

drop trigger if exists video_comments_count on public.video_comments;
create trigger video_comments_count after insert or delete on public.video_comments
  for each row execute function public.bump_comment_count();

create or replace function public.increment_video_view(p_video_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.videos set view_count = view_count + 1 where id = p_video_id and status = 'ready';
$$;

revoke all on function public.increment_video_view(uuid) from public, anon, authenticated;

alter table public.videos enable row level security;
alter table public.video_likes enable row level security;
alter table public.video_comments enable row level security;

drop policy if exists "ready videos are public" on public.videos;
create policy "ready videos are public" on public.videos for select using (status = 'ready' or auth.uid() = user_id);

drop policy if exists "comments are public" on public.video_comments;
create policy "comments are public" on public.video_comments for select using (true);

drop policy if exists "users read own likes" on public.video_likes;
create policy "users read own likes" on public.video_likes for select to authenticated using (auth.uid() = user_id);
