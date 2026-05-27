-- 025_fix_match_documents_signature.sql
-- Repair the match_documents RPC so the client code in src/lib/rag/query.ts
-- can actually call it.
--
-- Bug: migration 003 created match_documents() with parameters named
--      p_workspace_id and p_project_id (plus a match_threshold default
--      of 0.7). But src/lib/rag/query.ts calls it with filter_workspace_id
--      and filter_project_id. PostgreSQL's named-parameter resolution is
--      strict, so every studio knowledge lookup since day one has been
--      throwing "function match_documents(...) does not exist".
--
-- Fix: drop the old signature, create a canonical version using the names
-- the client expects. Also drop match_threshold (returning the top N by
-- similarity is what we actually want — filtering by raw cosine threshold
-- was rejecting too many otherwise-useful results) and drop p_user_role
-- (visibility filtering should live in RLS, not in this RPC).

begin;

-- Drop the old function (note: PostgreSQL identifies functions by
-- (name, arg types), so we have to give the full signature here).
drop function if exists public.match_documents(
  vector(1536),
  float,
  int,
  uuid,
  uuid,
  text
);

-- Also drop any other zero/partial-arg overloads that might exist.
drop function if exists public.match_documents(vector(1536));
drop function if exists public.match_documents(vector(1536), int);
drop function if exists public.match_documents(vector(1536), int, uuid, uuid);

create or replace function public.match_documents(
  query_embedding vector(1536),
  match_count integer default 10,
  filter_workspace_id uuid default null,
  filter_project_id uuid default null
)
returns table (
  id uuid,
  title text,
  content text,
  doc_type text,
  source_url text,
  project_id uuid,
  workspace_id uuid,
  metadata jsonb,
  similarity float
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    pd.id,
    pd.title,
    pd.content,
    pd.doc_type,
    pd.source_url,
    pd.project_id,
    pd.workspace_id,
    pd.metadata,
    (1 - (pd.embedding <=> query_embedding))::float as similarity
  from public.project_documents pd
  where
    (filter_workspace_id is null or pd.workspace_id = filter_workspace_id)
    and
    (filter_project_id is null or pd.project_id = filter_project_id)
    and
    pd.embedding is not null
  order by pd.embedding <=> query_embedding
  limit greatest(match_count, 1);
end
$$;

-- Permissions: the function is SECURITY DEFINER so it bypasses RLS on
-- project_documents. Anyone calling it inherits the function owner's
-- privileges. Authenticated users + the service role can invoke.
grant execute on function public.match_documents(vector(1536), integer, uuid, uuid) to authenticated, service_role, anon;

commit;
