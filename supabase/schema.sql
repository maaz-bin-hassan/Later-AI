-- ============================================================================
-- Later AI — Multi-tenant RAG schema (canonical design)
-- Tenancy model: per-user. Every row carries user_id; auth.uid() is the
-- tenant boundary, enforced by RLS. (Org-level tenancy notes at the bottom.)
--
-- Conventions / Supabase best practices applied here:
--   • UUID PKs via gen_random_uuid()
--   • RLS on every table; policies scoped `to authenticated`
--   • auth.uid() wrapped as (select auth.uid()) so Postgres caches it as an
--     initPlan instead of re-evaluating per row  → big win on large scans
--   • Functions are SECURITY INVOKER with `set search_path = ''`
--   • pgvector lives in the `extensions` schema; operators qualified explicitly
--   • Every foreign key is indexed (unindexed FKs are a common advisor warning)
-- ============================================================================

-- ─── Extensions ─────────────────────────────────────────────────────────────
create extension if not exists vector   with schema extensions;
create extension if not exists pgcrypto with schema extensions;


-- ─── Shared helpers ─────────────────────────────────────────────────────────
-- Auto-touch updated_at on UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ─── Enums ──────────────────────────────────────────────────────────────────
create type public.document_status as enum ('pending', 'processing', 'completed', 'failed');
create type public.message_role     as enum ('user', 'assistant', 'system');


-- ============================================================================
-- 1. profiles  (1:1 with auth.users)
-- ============================================================================
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-provision a profile row on signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Trigger-only function: must not be callable via PostgREST RPC.
revoke execute on function public.handle_new_user() from anon, authenticated, public;

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);


-- ============================================================================
-- 2. documents  (one row per uploaded file)
-- ============================================================================
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  title         text not null,
  filename      text not null,
  storage_path  text not null,                       -- <uid>/<doc_id>.pdf
  mime_type     text not null default 'application/pdf',
  file_size     bigint,
  page_count    int,
  status        public.document_status not null default 'pending',
  error         text,
  chunk_count   int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Indexes: FK + the dashboard's two hot filters.
create index documents_user_id_idx       on public.documents (user_id);
create index documents_user_created_idx  on public.documents (user_id, created_at desc);
-- Partial index keeps the ingestion-worker poll cheap (only rows in flight).
create index documents_processing_idx     on public.documents (status)
  where status in ('pending', 'processing');

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

alter table public.documents enable row level security;

create policy "documents_select_own" on public.documents
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "documents_insert_own" on public.documents
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "documents_update_own" on public.documents
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "documents_delete_own" on public.documents
  for delete to authenticated using ((select auth.uid()) = user_id);


-- ============================================================================
-- 3. document_chunks  (chunk text + embedding)
--    1536 dims = OpenAI text-embedding-3-small. Change to match your model.
-- ============================================================================
create table public.document_chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.documents (id) on delete cascade,
  user_id      uuid not null references auth.users (id)       on delete cascade,
  content      text not null,
  chunk_index  int  not null,
  page_number  int,
  token_count  int,
  embedding    extensions.vector(1536),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (document_id, chunk_index)
);

-- FK indexes.
create index document_chunks_document_id_idx on public.document_chunks (document_id);
create index document_chunks_user_id_idx     on public.document_chunks (user_id);

-- ANN index for cosine similarity. HNSW > IVFFlat here: high recall, low
-- latency, no retraining as the table grows. Tune for your data size:
--   m              = graph connectivity (default 16)
--   ef_construction= build-time accuracy (default 64; raise for better recall)
-- Query-time recall/latency is tuned per session with `set hnsw.ef_search`.
create index document_chunks_embedding_idx
  on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

alter table public.document_chunks enable row level security;

create policy "chunks_select_own" on public.document_chunks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "chunks_insert_own" on public.document_chunks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "chunks_delete_own" on public.document_chunks
  for delete to authenticated using ((select auth.uid()) = user_id);


-- ============================================================================
-- 4. conversations  (a chat thread)
-- ============================================================================
create table public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null default 'New conversation',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index conversations_user_updated_idx on public.conversations (user_id, updated_at desc);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

alter table public.conversations enable row level security;

create policy "conversations_select_own" on public.conversations
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "conversations_insert_own" on public.conversations
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "conversations_update_own" on public.conversations
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "conversations_delete_own" on public.conversations
  for delete to authenticated using ((select auth.uid()) = user_id);


-- ============================================================================
-- 5. messages  (a turn in a conversation)
--    `sources` holds citations inline (chunk_id, document_id, page, similarity,
--    snippet) to honor the 5-table requirement. For analytics on citations,
--    promote it to a normalized message_citations table instead.
-- ============================================================================
create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  user_id          uuid not null references auth.users (id)           on delete cascade,
  role             public.message_role not null,
  content          text not null,
  sources          jsonb not null default '[]'::jsonb,
  token_count      int,
  created_at       timestamptz not null default now()
);

-- Composite index: messages are always read by-thread, in time order.
create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index messages_user_id_idx      on public.messages (user_id);

alter table public.messages enable row level security;

create policy "messages_select_own" on public.messages
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "messages_insert_own" on public.messages
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "messages_delete_own" on public.messages
  for delete to authenticated using ((select auth.uid()) = user_id);


-- ============================================================================
-- Semantic search RPC
--   SECURITY INVOKER → RLS on document_chunks auto-restricts to the caller,
--   so this is tenant-safe with no explicit user_id filter needed.
-- ============================================================================
create or replace function public.match_documents(
  query_embedding    extensions.vector(1536),
  match_threshold    float default 0.3,
  match_count        int   default 6,
  filter_document_id uuid  default null
)
returns table (
  id             uuid,
  document_id    uuid,
  content        text,
  chunk_index    int,
  page_number    int,
  similarity     float,
  document_title text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    dc.id,
    dc.document_id,
    dc.content,
    dc.chunk_index,
    dc.page_number,
    1 - (dc.embedding operator(extensions.<=>) query_embedding) as similarity,
    d.title as document_title
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where dc.embedding is not null
    and (filter_document_id is null or dc.document_id = filter_document_id)
    and 1 - (dc.embedding operator(extensions.<=>) query_embedding) > match_threshold
  order by dc.embedding operator(extensions.<=>) query_embedding
  limit match_count;
$$;


-- ============================================================================
-- Performance notes
--   • Run ANALYZE after a bulk embedding load so the planner has stats.
--   • Build the HNSW index AFTER the initial bulk load when seeding lots of
--     data — building on an empty table then inserting is slower than the
--     reverse for big imports.
--   • Set per-query recall:  set hnsw.ef_search = 40;  (raise for recall)
--   • Increase maintenance_work_mem before large HNSW builds.
--   • Keep embeddings out of SELECT * (large payloads); project explicit cols.
--   • All RLS predicates use (select auth.uid()) → evaluated once per query.
-- ============================================================================
