-- Project Control v2: three generated canvases and durable share progression.
begin;

create table if not exists public.project_control_canvases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  canvas_type text not null constraint project_control_canvases_type_check
    check (canvas_type in ('overview', 'reference', 'schedule')),
  source_template_file_id text,
  source_template_hash text,
  template_markdown text,
  canvas_id text,
  canvas_url text,
  last_source_hash text,
  last_synced_at timestamptz,
  sync_status text not null default 'pending' constraint project_control_canvases_status_check
    check (sync_status in ('pending', 'synced', 'error', 'orphaned')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_control_canvases_project_type_unique unique (project_id, canvas_type),
  constraint project_control_canvases_canvas_unique unique (canvas_id)
);

create index if not exists project_control_canvases_sync_idx
  on public.project_control_canvases (sync_status, last_synced_at);

create table if not exists public.project_share_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dropbox_file_id text not null,
  dropbox_rev text not null,
  file_name text not null,
  share_url text not null,
  suggested_milestone text,
  match_confidence text constraint project_share_events_confidence_check
    check (match_confidence is null or match_confidence in ('exact', 'probable', 'uncertain')),
  status text not null default 'pending' constraint project_share_events_status_check
    check (status in ('pending', 'applying', 'applied', 'dismissed', 'superseded')),
  slack_channel_id text,
  slack_message_ts text,
  decided_by_slack_user_id text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_share_events_file_revision_unique
    unique (project_id, dropbox_file_id, dropbox_rev)
);

create index if not exists project_share_events_pending_idx
  on public.project_share_events (status, created_at) where status = 'pending';

alter table public.project_control_canvases enable row level security;
alter table public.project_share_events enable row level security;

comment on table public.project_control_canvases is
  'One durable generated Slack Canvas binding per project and view: overview, reference, schedule.';
comment on table public.project_share_events is
  'Idempotent Dropbox-to-Frame share ledger and producer-confirmed workback progression.';

commit;
