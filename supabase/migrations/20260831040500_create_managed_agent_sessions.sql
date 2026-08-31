-- Durable state for Anthropic Managed Agent sessions.
-- This was previously (and incorrectly) written into the aggregate agent_runs
-- table, whose schema intentionally contains no provider session fields.

create table public.managed_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid,
  session_id text not null unique,
  context_key text,
  agent_id text not null,
  environment_id text not null,
  source text not null,
  status text not null default 'running',
  event_count integer not null default 0 check (event_count >= 0),
  error text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint managed_agent_sessions_workspace_project_fkey
    foreign key (workspace_id, project_id)
    references public.projects(workspace_id, id)
    on delete cascade
);

create index managed_agent_sessions_context_idx
  on public.managed_agent_sessions (workspace_id, context_key, started_at desc)
  where context_key is not null;

create index managed_agent_sessions_status_idx
  on public.managed_agent_sessions (workspace_id, status, started_at desc);

alter table public.managed_agent_sessions enable row level security;

revoke all on table public.managed_agent_sessions from public, anon, authenticated;
grant all on table public.managed_agent_sessions to service_role;

create policy "Deny API access (service-only)" on public.managed_agent_sessions
  as restrictive for all to public
  using (false)
  with check (false);
