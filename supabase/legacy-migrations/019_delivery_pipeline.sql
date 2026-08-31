-- 019_delivery_pipeline.sql
-- Distributed video transcoding pipeline.
-- Three tables (profiles, jobs, workers) + Microsoft Ignite 2025 seed profile.
-- Spec: DELIVERY-PIPELINE-SPEC.md (repo root).
-- Plan: docs/superpowers/plans/2026-05-22-delivery-pipeline.md

begin;

-- ─── delivery_profiles ─────────────────────────────────────

create table if not exists public.delivery_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Video
  video_codec text not null default 'prores_422',
  video_bitrate text,
  resolution_w integer not null default 1920,
  resolution_h integer not null default 1080,
  frame_rate text not null default '59.94',
  frame_rate_mode text not null default 'cfr',
  scan_mode text not null default 'progressive',
  pixel_format text default 'yuv422p10le',
  color_space text,

  -- Audio
  audio_codec text not null default 'pcm_s24le',
  audio_sample_rate integer not null default 48000,
  audio_bit_depth integer not null default 24,
  audio_bitrate text,
  audio_channels jsonb not null default '[
    {"channel": 1, "label": "Stereo Mix Left", "source": "L"},
    {"channel": 2, "label": "Stereo Mix Right", "source": "R"}
  ]'::jsonb,

  -- Loudness
  lufs_target double precision,
  true_peak_limit double precision,
  loudness_standard text default 'ITU-R BS.1770-3',
  lufs_lra double precision,

  -- Container & padding
  container text not null default 'mov',
  head_pad_seconds double precision default 0,
  tail_pad_seconds double precision default 0,

  -- Naming
  naming_template text,
  naming_example text,

  -- QC
  qc_checklist jsonb not null default '[]'::jsonb,

  -- Notes / references
  notes text,
  pixel_map_url text,

  -- Soft delete
  archived boolean not null default false
);

create index if not exists delivery_profiles_name_idx
  on public.delivery_profiles(name);

create index if not exists delivery_profiles_active_idx
  on public.delivery_profiles(archived) where archived = false;

-- ─── render_jobs ───────────────────────────────────────────

create table if not exists public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  status text not null default 'pending'
    constraint render_jobs_status_check
    check (status in ('pending', 'claimed', 'processing', 'complete', 'failed', 'cancelled')),

  requested_by text not null,
  slack_channel text,
  slack_thread_ts text,

  profile_id uuid references public.delivery_profiles(id) on delete set null,
  profile_snapshot jsonb,

  source_files jsonb not null,
  naming_fields jsonb,

  output_path text,
  output_filename text,
  output_size_bytes bigint,

  claimed_by text,
  claimed_at timestamptz,
  processing_started_at timestamptz,
  completed_at timestamptz,

  progress_percent integer default 0,
  progress_message text,

  ffmpeg_command text,
  duration_seconds double precision,

  error_message text,
  retry_count integer not null default 0,
  max_retries integer not null default 2,

  qc_checklist_status jsonb
);

create index if not exists render_jobs_status_idx on public.render_jobs(status);

create index if not exists render_jobs_pending_idx
  on public.render_jobs(status, created_at) where status = 'pending';

create index if not exists render_jobs_worker_idx
  on public.render_jobs(claimed_by) where status in ('claimed', 'processing');

-- ─── render_workers ────────────────────────────────────────

create table if not exists public.render_workers (
  id uuid primary key default gen_random_uuid(),
  hostname text not null unique,
  display_name text,
  registered_at timestamptz not null default now(),

  role text not null default 'fallback'
    constraint render_workers_role_check
    check (role in ('primary', 'fallback')),
  priority integer not null default 10,

  status text not null default 'offline'
    constraint render_workers_status_check
    check (status in ('online', 'offline', 'busy', 'opted_out')),
  last_heartbeat timestamptz,

  cpu_usage_percent double precision,
  memory_usage_percent double precision,
  disk_free_gb double precision,
  ffmpeg_version text,
  os_version text,

  current_job_id uuid references public.render_jobs(id) on delete set null,

  max_concurrent_jobs integer not null default 1,
  cpu_threshold double precision not null default 50.0,
  dropbox_sync_path text,
  ffmpeg_path text not null default 'ffmpeg',

  opted_out_by text,
  opted_out_at timestamptz,
  opted_out_reason text
);

create index if not exists render_workers_status_idx on public.render_workers(status);

create index if not exists render_workers_priority_idx
  on public.render_workers(priority) where status = 'online';

-- ─── seen_dropbox_files (Phase 5 watcher state) ────────────

create table if not exists public.seen_dropbox_files (
  dropbox_id text primary key,
  path text not null,
  size_bytes bigint,
  first_seen_at timestamptz not null default now(),
  notified_at timestamptz,
  stable_check_count integer not null default 0
);

create index if not exists seen_dropbox_files_pending_idx
  on public.seen_dropbox_files(stable_check_count) where notified_at is null;

-- ─── Seed: Microsoft Ignite 2025 profile ───────────────────

insert into public.delivery_profiles (
  name, description, created_by,
  video_codec, resolution_w, resolution_h, frame_rate, frame_rate_mode,
  scan_mode, pixel_format,
  audio_codec, audio_sample_rate, audio_bit_depth, audio_channels,
  lufs_target, true_peak_limit, loudness_standard,
  container, head_pad_seconds, tail_pad_seconds,
  naming_template, naming_example,
  qc_checklist,
  notes
) values (
  'Microsoft Ignite 2025',
  'ProRes 422 1080p59.94 progressive, stereo PCM 24-bit/48kHz, -24 LUFS / -10 dBTP',
  'system',
  'prores_422', 1920, 1080, '59.94', 'cfr',
  'progressive', 'yuv422p10le',
  'pcm_s24le', 48000, 24,
  '[
    {"channel": 1, "label": "Stereo Mix Left", "source": "L"},
    {"channel": 2, "label": "Stereo Mix Right", "source": "R"}
  ]'::jsonb,
  -24.0, -10.0, 'ITU-R BS.1770-3',
  'mov', 1.0, 3.0,
  '{session}_{speaker}_V{version}_{event}',
  'STUDIO100_BradS_V1_Ignite25',
  '[
    "File name includes session code",
    "Audio post pass completed",
    "Non-English supertitles burned in",
    "Lower thirds match pixel map",
    "Color corrected",
    "No flash frames or dropped frames",
    "Audio in sync throughout"
  ]'::jsonb,
  'Microsoft Ignite delivery spec — ProRes 422, broadcast loudness target.'
)
on conflict do nothing;

-- ─── RLS — service role only (matching project convention) ─

alter table public.delivery_profiles enable row level security;
alter table public.render_jobs enable row level security;
alter table public.render_workers enable row level security;
alter table public.seen_dropbox_files enable row level security;

commit;
