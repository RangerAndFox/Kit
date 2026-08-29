-- Kit Archive Publisher: durable, private, draft-only publishing jobs.
begin;

create table if not exists public.archive_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  requested_by_slack_user_id text not null,
  status text not null default 'awaiting_confirmation' constraint archive_jobs_status_check
    check (status in (
      'awaiting_confirmation', 'queued', 'validating', 'preparing_media',
      'uploading_vimeo', 'creating_wordpress', 'creating_buffer',
      'preparing_behance', 'complete', 'partial', 'failed', 'cancelled'
    )),
  source_video_path text not null,
  project_snapshot jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  destinations text[] not null default '{}'::text[],
  progress jsonb not null default '{}'::jsonb,
  results jsonb not null default '{}'::jsonb,
  error text,
  slack_channel_id text,
  slack_message_ts text,
  idempotency_key text not null,
  attempt integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint archive_jobs_idempotency_unique unique (idempotency_key)
);

create index if not exists archive_jobs_project_idx
  on public.archive_jobs (project_id, created_at desc);
create index if not exists archive_jobs_recovery_idx
  on public.archive_jobs (status, updated_at)
  where status in ('queued', 'validating', 'preparing_media', 'uploading_vimeo',
    'creating_wordpress', 'creating_buffer', 'preparing_behance');

create table if not exists public.archive_job_steps (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.archive_jobs(id) on delete cascade,
  step_name text not null,
  status text not null default 'pending' constraint archive_job_steps_status_check
    check (status in ('pending', 'running', 'complete', 'failed', 'skipped')),
  attempt integer not null default 0,
  result jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint archive_job_steps_job_step_unique unique (job_id, step_name)
);

create index if not exists archive_job_steps_job_idx
  on public.archive_job_steps (job_id, created_at);

alter table public.archive_jobs enable row level security;
alter table public.archive_job_steps enable row level security;

-- These are server-owned internal ledgers. They must be reachable through
-- PostgREST by Kit's service role, but never by browser anon/authenticated keys.
revoke all on table public.archive_jobs from anon, authenticated;
revoke all on table public.archive_job_steps from anon, authenticated;
grant select, insert, update, delete on table public.archive_jobs to service_role;
grant select, insert, update, delete on table public.archive_job_steps to service_role;

comment on table public.archive_jobs is
  'Private, producer-approved Kit archive/publishing jobs. Destinations create drafts or unlisted media only.';
comment on table public.archive_job_steps is
  'Idempotent per-step archive workflow ledger used for retries, resume, and operator audit.';

commit;
