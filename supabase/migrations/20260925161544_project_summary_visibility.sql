-- Full summaries may include budgets, SOWs, rates, and private notes.
-- Protect existing documents and old writers during the rolling deployment.
create function public.protect_project_summary_visibility()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.doc_type = 'project_summary' then new.visibility_tier := 'founder'; end if;
  return new;
end;
$$;
revoke all on function public.protect_project_summary_visibility() from public, anon, authenticated;
create trigger protect_project_summary_visibility before insert or update on public.project_documents
for each row execute function public.protect_project_summary_visibility();
update public.project_documents set visibility_tier='founder'
where doc_type='project_summary' and visibility_tier is distinct from 'founder';
