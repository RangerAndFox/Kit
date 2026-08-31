-- 024_accessibility_jobs.sql
-- Accessibility pipeline: captions (SRT/TTML/TXT via Whisper) + descriptive
-- audio MP3 (vision + ElevenLabs) for videos dropped into Dropbox at
-- /Accessibility-Queue/. The Dropbox-watcher half of this pipeline reuses
-- the existing seen_dropbox_files table from migration 019 (delivery
-- pipeline) — no new watcher state needed.
--
-- Schema is reverse-engineered from src/lib/accessibility/storage.ts
-- (the AccessibilityJobRow interface is the contract).

begin;

create table if not exists public.accessibility_jobs (
  id uuid primary key default gen_random_uuid(),

  -- State machine (matches AccessibilityJobStatus in storage.ts)
  status text not null default 'pending'
    constraint accessibility_jobs_status_check check (status in (
      'pending',
      'transcribing',
      'analyzing',
      'narrating',
      'mixing',
      'uploading',
      'complete',
      'failed'
    )),

  -- Source video (Dropbox)
  source_video_path text not null,
  source_dropbox_id text not null,
  source_size_bytes bigint,
  source_duration_seconds numeric,

  -- Outputs in Dropbox (subfolder per video, paths populated as each
  -- artifact is uploaded)
  output_folder_path text,
  output_srt_path text,
  output_ttml_path text,
  output_txt_path text,
  output_dv_mp3_path text,

  -- Intermediate payloads we want to persist for retry / audit
  whisper_segments_json jsonb,
  pause_windows_json jsonb,
  narration_script_json jsonb,

  -- Cost accounting (cents). Lets us roll up monthly without inventing
  -- a separate billing log.
  whisper_cost_cents integer,
  vision_cost_cents integer,
  elevenlabs_cost_cents integer,

  -- Slack progress UX. Same pattern as delivery pipeline: post once on
  -- state transitions, edit-in-place via chat.update during processing.
  -- slack_notified_status is a composite idempotency token like
  -- "processing:30" so the cron doesn't re-edit the same percentage.
  slack_channel text,
  slack_thread_ts text,
  slack_message_ts text,
  slack_notified_status text,

  -- Failure handling
  error_message text,
  retry_count int not null default 0,
  max_retries int not null default 3,

  -- Live progress (Slack message + /kit access status command)
  progress_percent int not null default 0,
  progress_message text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One job per Dropbox file. The watcher uses this for idempotent upserts —
-- if the same file is re-detected during a recovery sweep, we return the
-- existing job instead of starting a duplicate.
create unique index if not exists accessibility_jobs_dropbox_id_uq
  on public.accessibility_jobs (source_dropbox_id);

-- The status command lists recent jobs ordered by created_at. The
-- partial index keeps the active-job dashboard query fast even after
-- thousands of completed rows accumulate.
create index if not exists accessibility_jobs_status_created_idx
  on public.accessibility_jobs (status, created_at desc);

create index if not exists accessibility_jobs_active_idx
  on public.accessibility_jobs (created_at desc)
  where status not in ('complete', 'failed');

-- Match the workspace-wide RLS pattern (migration 016): RLS on, no policies.
-- The Kit backend uses the service role (bypasses RLS) for all reads/writes.
alter table public.accessibility_jobs enable row level security;

commit;
