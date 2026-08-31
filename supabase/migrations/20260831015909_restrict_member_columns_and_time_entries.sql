-- Data API grants are a second boundary in addition to RLS. Authenticated
-- members receive only the columns required for safe role-native reads;
-- privileged mutations continue through Kit's audited server workflows.

revoke all on table public.projects from anon, authenticated;
grant select (id, workspace_id, name, project_code, project_type, status)
  on table public.projects to authenticated;

revoke all on table public.team_members from anon, authenticated;
grant select (id, workspace_id, name, role, avatar_url, slack_user_id, is_active, created_at, updated_at)
  on table public.team_members to authenticated;

revoke all on table public.time_entries from anon, authenticated;
grant select (id, workspace_id, project_id, team_member_id, description, hours, date, task_category, entry_source, synced_at)
  on table public.time_entries to authenticated;

revoke all on table public.integrations from anon, authenticated;
grant select (id, workspace_id, service, status, last_synced_at, connected_at, updated_at)
  on table public.integrations to authenticated;

drop policy if exists "Admin/producer can create projects" on public.projects;
drop policy if exists "Admin/producer can update projects" on public.projects;
drop policy if exists "Admins can delete projects" on public.projects;

drop policy if exists "Founders can insert team members" on public.team_members;
drop policy if exists "Founders can update team members" on public.team_members;
drop policy if exists "Founders can delete team members" on public.team_members;

drop policy if exists "Members can insert time entries" on public.time_entries;
drop policy if exists "Admin/producer can update time entries" on public.time_entries;
drop policy if exists "Members can view time entries" on public.time_entries;
create policy "Members can view permitted time entries"
  on public.time_entries for select to authenticated
  using (
    private.is_founder_or_producer(workspace_id)
    or exists (
      select 1 from public.team_members tm
      where tm.id = time_entries.team_member_id
        and tm.workspace_id = time_entries.workspace_id
        and tm.auth_user_id = (select auth.uid())
    )
  );

drop policy if exists "Admin/producer can manage integrations" on public.integrations;
drop policy if exists "Admin/producer can update integrations" on public.integrations;
drop policy if exists "Admins can delete integrations" on public.integrations;
