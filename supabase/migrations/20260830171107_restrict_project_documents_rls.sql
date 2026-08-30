-- Raw knowledge documents may contain contact, financial, transcript, or
-- founder context. Artists receive deliberately filtered answers through
-- Kit's Slack gateway; they must not bypass that boundary with direct REST.

drop policy if exists "Founders can view all documents" on public.project_documents;
drop policy if exists "Non-founders see non-founder documents" on public.project_documents;
drop policy if exists "Members can insert documents" on public.project_documents;

create policy "Founders can view all documents"
on public.project_documents
for select
to authenticated
using (public.is_founder(workspace_id));

create policy "Producers can view non-founder documents"
on public.project_documents
for select
to authenticated
using (
  public.is_founder_or_producer(workspace_id)
  and visibility_tier <> 'founder'
);

create policy "Founders and producers can insert documents"
on public.project_documents
for insert
to authenticated
with check (public.is_founder_or_producer(workspace_id));
