-- Audit SEC-2/SEC-4. Never broaden retrieval on a missing workspace.
create or replace function public.match_documents(query_embedding vector, match_count integer default 10, filter_workspace_id uuid default null, filter_project_id uuid default null, filter_visibility_tiers text[] default array['team']::text[])
returns table(id uuid, title text, content text, doc_type text, source_url text, project_id uuid, workspace_id uuid, metadata jsonb, similarity double precision)
language plpgsql security definer set search_path = public
as $$
begin
  if filter_workspace_id is null then
    raise exception 'Workspace is required for document retrieval' using errcode = '22023';
  end if;
  return query
  select pd.id, pd.title, pd.content, pd.doc_type, pd.source_url, pd.project_id,
         pd.workspace_id, pd.metadata, (1 - (pd.embedding <=> query_embedding))::float
  from public.project_documents pd
  where pd.workspace_id = filter_workspace_id
    and (filter_project_id is null or pd.project_id = filter_project_id)
    and pd.visibility_tier = any(case when coalesce(cardinality(filter_visibility_tiers), 0) > 0
      then filter_visibility_tiers else array['team']::text[] end)
    and pd.embedding is not null
  order by pd.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50);
end;
$$;
revoke all on function public.match_documents(vector, integer, uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.match_documents(vector, integer, uuid, uuid, text[]) to service_role;

-- Project ownership already has a composite FK; close the member half as well.
-- The FK also prevents moving a referenced member into a different workspace.
create unique index if not exists team_members_workspace_id_id_key on public.team_members(workspace_id, id);
create index if not exists project_access_workspace_member_idx on public.project_access(workspace_id, team_member_id);
alter table public.project_access add constraint project_access_workspace_member_fkey
  foreign key (workspace_id, team_member_id) references public.team_members(workspace_id, id) on delete cascade not valid;
alter table public.project_access validate constraint project_access_workspace_member_fkey;
