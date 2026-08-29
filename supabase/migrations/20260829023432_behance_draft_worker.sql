-- Kit Behance browser worker: private, durable, draft-only automation.
begin;

create table public.behance_draft_jobs (
  id uuid primary key default gen_random_uuid(),
  archive_job_id uuid not null unique references public.archive_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  requested_by_slack_user_id text not null,
  status text not null default 'queued' constraint behance_draft_jobs_status_check
    check (status in (
      'queued', 'claimed', 'opening_editor', 'uploading_media',
      'filling_details', 'saving_draft', 'awaiting_review',
      'retryable', 'failed', 'cancelled'
    )),
  manifest jsonb not null default '{}'::jsonb,
  draft_url text,
  proof_dropbox_path text,
  proof_url text,
  claimed_by text,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  attempt integer not null default 0,
  error text,
  slack_synced_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index behance_draft_jobs_claim_idx
  on public.behance_draft_jobs (status, created_at)
  where status in ('queued', 'retryable');
create index behance_draft_jobs_recovery_idx
  on public.behance_draft_jobs (status, heartbeat_at)
  where status in ('claimed', 'opening_editor', 'uploading_media', 'filling_details', 'saving_draft');
create index behance_draft_jobs_sync_idx
  on public.behance_draft_jobs (updated_at)
  where status in ('awaiting_review', 'failed');
create index behance_draft_jobs_workspace_idx
  on public.behance_draft_jobs (workspace_id, created_at desc);
create index behance_draft_jobs_project_idx
  on public.behance_draft_jobs (project_id, created_at desc);

create table public.behance_workers (
  worker_id text primary key,
  display_name text,
  status text not null default 'offline' constraint behance_workers_status_check
    check (status in ('idle', 'working', 'needs_login', 'error', 'offline')),
  current_job_id uuid references public.behance_draft_jobs(id) on delete set null,
  browser_version text,
  last_error text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.behance_draft_jobs enable row level security;
alter table public.behance_workers enable row level security;

-- Both tables are internal ledgers. Kit and the dedicated studio worker use
-- the service-role key on trusted servers only; browser/user roles get no access.
revoke all on table public.behance_draft_jobs from anon, authenticated;
revoke all on table public.behance_workers from anon, authenticated;
grant select, insert, update, delete on table public.behance_draft_jobs to service_role;
grant select, insert, update, delete on table public.behance_workers to service_role;

comment on table public.behance_draft_jobs is
  'Private queue for the dedicated Kit studio browser worker. It may save Behance drafts but must never publish them.';
comment on table public.behance_workers is
  'Heartbeat and operational state for dedicated Behance browser workers.';
comment on column public.behance_draft_jobs.manifest is
  'Public-safe, producer-approved portfolio copy and Dropbox asset paths only; never credentials, budgets, or private project context.';

commit;
