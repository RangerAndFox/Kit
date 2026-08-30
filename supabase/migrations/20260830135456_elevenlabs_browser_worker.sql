create table public.elevenlabs_studio_jobs (
  id uuid primary key default gen_random_uuid(),
  storyboard_job_id uuid not null unique references public.storyboard_jobs(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete set null,
  requested_by_slack_user_id text,
  slack_channel_id text,
  slack_thread_ts text,
  status text not null default 'queued' constraint elevenlabs_studio_jobs_status_check
    check (status in ('queued', 'claimed', 'opening_studio', 'filling_project', 'saving_draft', 'complete', 'retryable', 'failed', 'cancelled')),
  project_name text not null,
  voiceover_paragraphs jsonb not null default '[]'::jsonb,
  studio_project_id text,
  studio_url text,
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

create index elevenlabs_studio_jobs_queue_idx
  on public.elevenlabs_studio_jobs (status, created_at);
create index elevenlabs_studio_jobs_workspace_idx
  on public.elevenlabs_studio_jobs (workspace_id);

create table public.elevenlabs_workers (
  worker_id text primary key,
  display_name text not null,
  status text not null default 'offline' constraint elevenlabs_workers_status_check
    check (status in ('idle', 'working', 'needs_login', 'error', 'offline')),
  current_job_id uuid references public.elevenlabs_studio_jobs(id) on delete set null,
  last_error text,
  browser_version text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index elevenlabs_workers_current_job_idx
  on public.elevenlabs_workers (current_job_id);

alter table public.elevenlabs_studio_jobs enable row level security;
alter table public.elevenlabs_workers enable row level security;

revoke all on table public.elevenlabs_studio_jobs from anon, authenticated;
revoke all on table public.elevenlabs_workers from anon, authenticated;
grant select, insert, update, delete on table public.elevenlabs_studio_jobs to service_role;
grant select, insert, update, delete on table public.elevenlabs_workers to service_role;

comment on table public.elevenlabs_studio_jobs is
  'Internal service-role queue for private ElevenLabs Studio drafts created by the dedicated studio Mac.';
comment on table public.elevenlabs_workers is
  'Heartbeat and current-job state for dedicated ElevenLabs browser workers.';
