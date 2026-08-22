begin;

-- Semantic search uses the service role and therefore bypasses RLS. Enforce
-- the requester's allowed knowledge tiers inside the function itself instead
-- of relying on callers to discard sensitive rows after retrieval.
drop function if exists public.match_documents(vector(1536), integer, uuid, uuid);

create function public.match_documents(
  query_embedding vector(1536),
  match_count integer default 10,
  filter_workspace_id uuid default null,
  filter_project_id uuid default null,
  filter_visibility_tiers text[] default array['team']::text[]
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
    and (filter_project_id is null or pd.project_id = filter_project_id)
    and pd.visibility_tier = any(
      case
        when coalesce(cardinality(filter_visibility_tiers), 0) > 0
          then filter_visibility_tiers
        else array['team']::text[]
      end
    )
    and pd.embedding is not null
  order by pd.embedding <=> query_embedding
  limit greatest(match_count, 1);
end
$$;

revoke execute on function public.match_documents(vector, integer, uuid, uuid, text[])
  from public, anon, authenticated;
grant execute on function public.match_documents(vector, integer, uuid, uuid, text[])
  to service_role;

-- Repair already-embedded Plaud/Drive transcripts. A project association is
-- the positive signal that makes a transcript team knowledge; unmatched
-- hardware-recorder content remains founder/admin-only.
update public.project_documents pd
set visibility_tier = 'founder'
from public.call_transcripts ct
where pd.doc_type = 'call_transcript'
  and pd.metadata->>'call_transcripts_id' = ct.id::text
  and ct.source in ('plaud', 'drive')
  and ct.project_id is null
  and pd.visibility_tier <> 'founder';

commit;
