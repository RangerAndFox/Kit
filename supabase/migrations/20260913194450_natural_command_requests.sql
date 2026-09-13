-- Private, single-use command review cards. Only the Bolt service may access.
-- CLI-created migration aligned with the applied production history version.
create table public.kit_command_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  team_id text not null,
  user_id text not null,
  source_channel text not null,
  dm_channel text not null check (dm_channel like 'D%'),
  thread_ts text,
  command text not null,
  args text not null default '' check (length(args) <= 1600),
  status text not null default 'pending' check (status in ('pending','running','complete','cancelled','review')),
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.kit_command_requests enable row level security;
revoke all on public.kit_command_requests from public, anon, authenticated;
grant select, insert, update, delete on public.kit_command_requests to service_role;
create index kit_command_requests_workspace on public.kit_command_requests(workspace_id);
create index kit_command_requests_expiry on public.kit_command_requests(expires_at) where status='pending';
