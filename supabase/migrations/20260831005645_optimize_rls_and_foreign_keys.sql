create index if not exists idx_meeting_briefing_deliveries_internal_recipient_id on public.meeting_briefing_deliveries (internal_recipient_id);
create index if not exists idx_pilots_workspace_id on public.pilots (workspace_id);
create index if not exists idx_project_creation_requests_project_id on public.project_creation_requests (project_id);
create index if not exists idx_project_creation_requests_workspace_id on public.project_creation_requests (workspace_id);
create index if not exists idx_project_update_requests_workspace_id on public.project_update_requests (workspace_id);
create index if not exists idx_render_jobs_delivery_profile_id on public.render_jobs (delivery_profile_id);
create index if not exists idx_storyboard_panels_generation_task_id on public.storyboard_panels (generation_task_id);

alter policy "Members can view projects" on public.projects
using (
  workspace_id in (select private.get_user_workspace_ids())
  and (
    private.is_founder_or_producer(workspace_id)
    or exists (
      select 1
      from public.project_access pa
      join public.team_members tm on tm.id = pa.team_member_id
      where pa.project_id = projects.id
        and tm.auth_user_id = (select auth.uid())
        and pa.removed_at is null
    )
  )
);

alter policy "Authenticated users can create workspaces" on public.workspaces
with check ((select auth.uid()) is not null);

drop policy "Founder/producer can view all task cards" on public.daily_task_cards;
drop policy "Members can view their own task cards" on public.daily_task_cards;
create policy "Members can view permitted task cards" on public.daily_task_cards
for select to public
using (
  private.is_founder_or_producer(workspace_id)
  or team_member_id in (
    select id from public.team_members
    where auth_user_id = (select auth.uid()) and is_active = true
  )
);

drop policy "Founders can view all permission requests" on public.permission_requests;
drop policy "Members can view their own permission requests" on public.permission_requests;
create policy "Members can view permitted permission requests" on public.permission_requests
for select to public
using (
  private.is_founder(workspace_id)
  or requester_id in (
    select id from public.team_members
    where auth_user_id = (select auth.uid()) and is_active = true
  )
);

drop policy "Admin/producer can manage client profiles" on public.client_profiles;
create policy "Admin/producer can insert client profiles" on public.client_profiles
for insert to public with check (private.is_founder_or_producer(workspace_id));
create policy "Admin/producer can update client profiles" on public.client_profiles
for update to public using (private.is_founder_or_producer(workspace_id))
with check (private.is_founder_or_producer(workspace_id));
create policy "Admin/producer can delete client profiles" on public.client_profiles
for delete to public using (private.is_founder_or_producer(workspace_id));

drop policy "Admins can manage pitch log" on public.pitch_log;
create policy "Admins can insert pitch log" on public.pitch_log
for insert to public with check (private.is_founder(workspace_id));
create policy "Admins can update pitch log" on public.pitch_log
for update to public using (private.is_founder(workspace_id))
with check (private.is_founder(workspace_id));
create policy "Admins can delete pitch log" on public.pitch_log
for delete to public using (private.is_founder(workspace_id));

drop policy "Founders can view all documents" on public.project_documents;
drop policy "Producers can view non-founder documents" on public.project_documents;
create policy "Founders and producers can view permitted documents" on public.project_documents
for select to authenticated
using (
  private.is_founder(workspace_id)
  or (
    private.is_founder_or_producer(workspace_id)
    and visibility_tier <> 'founder'::text
  )
);
