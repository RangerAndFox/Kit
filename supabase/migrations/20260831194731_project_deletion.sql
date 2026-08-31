-- Durable, admin-only project deletion audit and retry ledger.
begin;

create table if not exists public.project_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Intentionally no FK: this tombstone survives deletion of public.projects.
  project_id uuid not null,
  requested_by_slack_user_id text not null,
  idempotency_key text not null,
  status text not null default 'awaiting_confirmation'
    constraint project_deletion_requests_status_check
    check (status in ('awaiting_confirmation', 'running', 'partial', 'complete', 'cancelled')),
  project_snapshot jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_deletion_requests_idempotency_idx
  on public.project_deletion_requests (idempotency_key);

create index if not exists project_deletion_requests_project_idx
  on public.project_deletion_requests (project_id, created_at desc);
create index if not exists project_deletion_requests_recovery_idx
  on public.project_deletion_requests (status, updated_at)
  where status in ('running', 'partial');

create table if not exists public.project_deletion_steps (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.project_deletion_requests(id) on delete cascade,
  step_name text not null,
  status text not null default 'pending'
    constraint project_deletion_steps_status_check
    check (status in ('pending', 'running', 'complete', 'failed', 'skipped')),
  result jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_deletion_steps_request_step_unique unique (request_id, step_name)
);

alter table public.project_deletion_requests enable row level security;
alter table public.project_deletion_steps enable row level security;

revoke all on table public.project_deletion_requests from anon, authenticated;
revoke all on table public.project_deletion_steps from anon, authenticated;
grant select, insert, update, delete on table public.project_deletion_requests to service_role;
grant select, insert, update, delete on table public.project_deletion_steps to service_role;

comment on table public.project_deletion_requests is
  'Immutable project snapshot and durable state for founder/admin delete-everywhere operations; survives project deletion for audit.';
comment on table public.project_deletion_steps is
  'Idempotent per-provider deletion ledger used to resume partial project cleanup safely.';

commit;
