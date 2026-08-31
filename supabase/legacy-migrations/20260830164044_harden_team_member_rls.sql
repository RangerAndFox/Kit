-- Team membership controls authorization throughout Kit. An authenticated
-- member must never be able to promote themselves, change workspace, or set
-- financial/identity fields on their own row.

drop policy if exists "Admins can insert team members" on public.team_members;
drop policy if exists "Admins can update team members" on public.team_members;
drop policy if exists "Admins can delete team members" on public.team_members;
drop policy if exists "Members can view workspace colleagues" on public.team_members;

create policy "Founders can insert team members"
on public.team_members
for insert
to authenticated
with check (public.is_founder(workspace_id));

create policy "Founders can update team members"
on public.team_members
for update
to authenticated
using (public.is_founder(workspace_id))
with check (public.is_founder(workspace_id));

create policy "Founders can delete team members"
on public.team_members
for delete
to authenticated
using (public.is_founder(workspace_id));

create policy "Members can view workspace colleagues"
on public.team_members
for select
to authenticated
using (workspace_id in (select public.get_user_workspace_ids()));
