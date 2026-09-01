create table if not exists public.frameio_project_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  frameio_project_id text not null unique,
  frameio_project_name text not null,
  frameio_project_url text not null,
  status text not null default 'queued' check (status in (
    'queued', 'claimed', 'opening_project', 'deleting', 'verifying',
    'complete', 'retryable', 'failed', 'cancelled'
  )),
  claimed_by text,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  attempt integer not null default 0,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists frameio_project_deletion_jobs_claim_idx
  on public.frameio_project_deletion_jobs(status, created_at);
create index if not exists frameio_project_deletion_jobs_project_idx
  on public.frameio_project_deletion_jobs(project_id, updated_at desc);

create table if not exists public.frameio_workers (
  worker_id text primary key,
  display_name text not null,
  status text not null check (status in ('idle', 'working', 'needs_login', 'error')),
  current_job_id uuid references public.frameio_project_deletion_jobs(id) on delete set null,
  browser_version text,
  last_error text,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists frameio_workers_current_job_idx
  on public.frameio_workers(current_job_id)
  where current_job_id is not null;

alter table public.frameio_project_deletion_jobs enable row level security;
alter table public.frameio_workers enable row level security;
revoke all on public.frameio_project_deletion_jobs from anon, authenticated;
revoke all on public.frameio_workers from anon, authenticated;
