create unique index if not exists team_members_workspace_slack_user_unique
  on public.team_members (workspace_id, slack_user_id)
  where slack_user_id is not null;

create unique index if not exists team_members_workspace_harvest_user_unique
  on public.team_members (workspace_id, harvest_user_id)
  where harvest_user_id is not null;

create unique index if not exists team_members_workspace_email_unique
  on public.team_members (workspace_id, lower(email))
  where email is not null;

create unique index if not exists staff_slack_user_unique
  on public.staff (slack_user_id)
  where slack_user_id is not null;

create unique index if not exists staff_harvest_user_unique
  on public.staff (harvest_user_id)
  where harvest_user_id is not null;

create unique index if not exists staff_email_unique
  on public.staff (lower(email))
  where email is not null;

create unique index if not exists projects_workspace_slack_channel_unique
  on public.projects (workspace_id, slack_channel_id)
  where slack_channel_id is not null;

create unique index if not exists projects_workspace_harvest_project_unique
  on public.projects (workspace_id, harvest_project_id)
  where harvest_project_id is not null;
