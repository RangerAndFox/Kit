-- Explicit deny policies document the service-only boundary and keep the
-- Supabase security advisor green. service_role bypasses RLS.
begin;

create index if not exists project_deletion_requests_workspace_idx
  on public.project_deletion_requests (workspace_id, created_at desc);

create policy "Deny API access (service-only)"
  on public.project_deletion_requests
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "Deny API access (service-only)"
  on public.project_deletion_steps
  for all
  to anon, authenticated
  using (false)
  with check (false);

commit;
