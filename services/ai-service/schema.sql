-- Uninet ai-service: conversation history. Run in the Supabase SQL editor.
-- The service writes with the service-role key; RLS lets users read only their own rows
-- if the tables are ever queried directly from a client.

create table if not exists public.ai_conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null default 'New chat' check (char_length(title) <= 200),
  model       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.ai_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.ai_conversations (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  input_tokens     integer,
  output_tokens    integer,
  created_at       timestamptz not null default now()
);

create index if not exists ai_conversations_user_updated_idx
  on public.ai_conversations (user_id, updated_at desc);
create index if not exists ai_messages_conversation_created_idx
  on public.ai_messages (conversation_id, created_at);

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;

drop policy if exists "owner reads conversations" on public.ai_conversations;
create policy "owner reads conversations" on public.ai_conversations
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "owner reads messages" on public.ai_messages;
create policy "owner reads messages" on public.ai_messages
  for select to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- RAG: documents + embeddings (pgvector). Dimension must match EMBEDDING_DIMENSIONS (default 1536).
-- ---------------------------------------------------------------------------
create extension if not exists vector;

create table if not exists public.ai_documents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  source      text,
  char_count  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.ai_document_chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.ai_documents (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  chunk_index  integer not null,
  content      text not null,
  embedding    vector(1536) not null
);

create index if not exists ai_documents_user_idx on public.ai_documents (user_id, created_at desc);
create index if not exists ai_document_chunks_doc_idx on public.ai_document_chunks (document_id, chunk_index);
create index if not exists ai_document_chunks_embedding_idx
  on public.ai_document_chunks using hnsw (embedding vector_cosine_ops);

alter table public.ai_documents enable row level security;
alter table public.ai_document_chunks enable row level security;

drop policy if exists "owner reads documents" on public.ai_documents;
create policy "owner reads documents" on public.ai_documents
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "owner reads chunks" on public.ai_document_chunks;
create policy "owner reads chunks" on public.ai_document_chunks
  for select to authenticated using (auth.uid() = user_id);

create or replace function public.match_document_chunks(
  p_user_id uuid,
  p_query_embedding vector(1536),
  p_match_count integer default 5,
  p_min_similarity double precision default 0.2
)
returns table (id uuid, document_id uuid, title text, chunk_index integer, content text, similarity double precision)
language sql stable
security definer
set search_path = public
as $$
  select c.id, c.document_id, d.title, c.chunk_index, c.content,
         1 - (c.embedding <=> p_query_embedding) as similarity
    from public.ai_document_chunks c
    join public.ai_documents d on d.id = c.document_id
   where c.user_id = p_user_id
     and 1 - (c.embedding <=> p_query_embedding) >= p_min_similarity
   order by c.embedding <=> p_query_embedding
   limit least(p_match_count, 20);
$$;

revoke all on function public.match_document_chunks(uuid, vector, integer, double precision) from public, anon, authenticated;
