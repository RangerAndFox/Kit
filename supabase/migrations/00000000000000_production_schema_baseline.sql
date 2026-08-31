-- Generated from the production catalog on 2026-08-30.
-- This file is the immutable schema baseline for clean environments.
-- Do not edit it after production has recorded it; add a new timestamped migration instead.

set check_function_bodies = off;

-- extensions
create extension if not exists pg_stat_statements with schema extensions;

create extension if not exists pgcrypto with schema extensions;

create extension if not exists "uuid-ossp" with schema extensions;

create extension if not exists vector with schema public;

-- sequences
create sequence public.brain_revisions_id_seq as bigint increment by 1 minvalue 1 maxvalue 9223372036854775807 start with 1 cache 1 no cycle;

create sequence public.brain_scavenger_candidates_id_seq as bigint increment by 1 minvalue 1 maxvalue 9223372036854775807 start with 1 cache 1 no cycle;

-- tables
create table public.accessibility_jobs (\n  id uuid default gen_random_uuid() not null,
  status text default 'pending'::text not null,
  source_video_path text not null,
  source_dropbox_id text not null,
  source_size_bytes bigint,
  source_duration_seconds numeric,
  output_folder_path text,
  output_srt_path text,
  output_ttml_path text,
  output_txt_path text,
  output_dv_mp3_path text,
  whisper_segments_json jsonb,
  pause_windows_json jsonb,
  narration_script_json jsonb,
  whisper_cost_cents integer,
  vision_cost_cents integer,
  elevenlabs_cost_cents integer,
  slack_channel text,
  slack_thread_ts text,
  slack_message_ts text,
  slack_notified_status text,
  error_message text,
  retry_count integer default 0 not null,
  max_retries integer default 3 not null,
  progress_percent integer default 0 not null,
  progress_message text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()\n);

create table public.action_breakdowns (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid not null,
  transcript_source text,
  call_date timestamp with time zone,
  call_summary text,
  assignments jsonb not null,
  scope_concerns jsonb default '[]'::jsonb,
  draft_client_email text,
  status text default 'draft'::text,
  approved_by uuid,
  distributed_at timestamp with time zone,
  created_at timestamp with time zone default now()\n);

create table public.agent_runs (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  run_type text not null,
  trigger text,
  projects_processed uuid[],
  actions_created uuid[],
  tokens_used integer,
  duration_ms integer,
  status text default 'running'::text,
  error text,
  started_at timestamp with time zone default now(),
  completed_at timestamp with time zone\n);

create table public.archive_activity (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid,
  action text not null,
  file_name text,
  details jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now()\n);

create table public.archive_job_steps (\n  id uuid default gen_random_uuid() not null,
  job_id uuid not null,
  step_name text not null,
  status text default 'pending'::text not null,
  attempt integer default 0 not null,
  result jsonb default '{}'::jsonb not null,
  error text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  claim_token uuid,
  claimed_by text,
  claimed_at timestamp with time zone\n);

create table public.archive_jobs (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid not null,
  requested_by_slack_user_id text not null,
  status text default 'awaiting_confirmation'::text not null,
  source_video_path text not null,
  project_snapshot jsonb default '{}'::jsonb not null,
  settings jsonb default '{}'::jsonb not null,
  destinations text[] default '{}'::text[] not null,
  progress jsonb default '{}'::jsonb not null,
  results jsonb default '{}'::jsonb not null,
  error text,
  slack_channel_id text,
  slack_message_ts text,
  idempotency_key text not null,
  attempt integer default 0 not null,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  claim_token uuid,
  claimed_by text,
  claimed_at timestamp with time zone\n);

create table public.artifacts (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  artifact_type text not null,
  version integer default 1 not null,
  data jsonb not null,
  created_by text not null,
  created_at timestamp with time zone default now() not null\n);

create table public.autonomy_settings (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid,
  action_type text not null,
  autonomy_level text not null,
  set_by uuid,
  created_at timestamp with time zone default now()\n);

create table public.behance_draft_jobs (\n  id uuid default gen_random_uuid() not null,
  archive_job_id uuid not null,
  workspace_id uuid not null,
  project_id uuid not null,
  requested_by_slack_user_id text not null,
  status text default 'queued'::text not null,
  manifest jsonb default '{}'::jsonb not null,
  draft_url text,
  proof_dropbox_path text,
  proof_url text,
  claimed_by text,
  claimed_at timestamp with time zone,
  heartbeat_at timestamp with time zone,
  attempt integer default 0 not null,
  error text,
  slack_synced_at timestamp with time zone,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.behance_workers (\n  worker_id text not null,
  display_name text,
  status text default 'offline'::text not null,
  current_job_id uuid,
  browser_version text,
  last_error text,
  last_seen_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.bible_versions (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  version integer not null,
  markdown text not null,
  sections jsonb default '{}'::jsonb not null,
  updated_by text not null,
  changelog text not null,
  created_at timestamp with time zone default now() not null\n);

create table public.birthdays (\n  slack_user_id text not null,
  month_day text not null,
  full_name text,
  created_by text,
  created_at timestamp with time zone default now() not null\n);

create table public.brain_revisions (\n  id bigint default nextval('brain_revisions_id_seq'::regclass) not null,
  brain_id text not null,
  revision integer not null,
  section text,
  operation text,
  diff text,
  provenance jsonb,
  author text,
  created_at timestamp with time zone default now()\n);

create table public.brain_scavenger_candidates (\n  id bigint default nextval('brain_scavenger_candidates_id_seq'::regclass) not null,
  brain_id text not null,
  workspace_id uuid not null,
  source_ref text,
  source_doc_id uuid,
  summary text,
  why_relevant text,
  similarity numeric,
  status text default 'pending'::text not null,
  approver text,
  approval_dm_ts text,
  applied_section text,
  decided_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  dm_sent_at timestamp with time zone\n);

create table public.brains (\n  id text not null,
  workspace_id uuid not null,
  scope text not null,
  project_code text,
  project_id uuid,
  slack_channel text,
  revision integer default 0 not null,
  markdown text default ''::text not null,
  canvas_id text,
  canvas_url text,
  autonomy text default 'autonomous'::text not null,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  visibility text default 'producers_only'::text not null\n);

create table public.call_classifications (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  document_id uuid,
  project_id uuid,
  call_type text not null,
  confidence integer,
  reasoning text,
  key_topics text[],
  classified_by text default 'kit'::text,
  workflow_triggered text,
  created_at timestamp with time zone default now()\n);

create table public.call_transcripts (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid,
  project_id uuid,
  source text default 'plaud'::text not null,
  external_recording_id text,
  external_file_id text,
  transcript text,
  participants jsonb,
  duration_seconds integer,
  start_time timestamp with time zone,
  end_time timestamp with time zone,
  ingest_status text default 'pending'::text not null,
  ingest_error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  project_match_attempted_at timestamp with time zone\n);

create table public.character_sheets (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  character_name text not null,
  role text not null,
  brief text not null,
  consistency_anchors jsonb default '{}'::jsonb not null,
  design_sheets jsonb default '[]'::jsonb not null,
  status text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.client_profiles (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  client_name text not null,
  primary_contacts jsonb default '[]'::jsonb,
  health_score numeric(3,1),
  health_trend text,
  avg_response_time_hours numeric(6,1),
  avg_revision_rounds numeric(3,1),
  payment_reliability text,
  scope_creep_tendency text,
  total_lifetime_revenue numeric(12,2),
  project_count integer default 0,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  harvest_client_id bigint\n);

create table public.conversation_state (\n  key text not null,
  state jsonb not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.cron_heartbeats (\n  cron_id text not null,
  last_success_at timestamp with time zone default now() not null\n);

create table public.daily_hours_checkins (\n  id uuid default gen_random_uuid() not null,
  staff_id uuid not null,
  slack_user_id text not null,
  check_in_date date not null,
  status text not null,
  candidate_projects jsonb,
  parsed_entries jsonb,
  dm_channel_id text,
  dm_ts text,
  reply_ts text,
  nudged_at timestamp with time zone,
  logged_at timestamp with time zone,
  error_message text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  origin text default 'scheduled'::text not null,
  harvest_entry_ids jsonb\n);

create table public.daily_hours_reminders (\n  id uuid default gen_random_uuid() not null,
  staff_id uuid not null,
  slack_user_id text not null,
  local_date date not null,
  reminder_type text default 'daily_hours'::text not null,
  status text default 'pending'::text not null,
  resolved_timezone text,
  slack_channel_id text,
  slack_message_ts text,
  check_in_id uuid,
  attempts integer default 0 not null,
  claimed_at timestamp with time zone,
  lease_expires_at timestamp with time zone,
  skip_reason text,
  error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.daily_task_cards (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  team_member_id uuid not null,
  card_date date not null,
  projects jsonb not null,
  generated_content text not null,
  approved_content text,
  status text default 'draft'::text,
  approved_by uuid,
  distributed_at timestamp with time zone,
  eod_checkin_sent boolean default false,
  eod_checkin_response jsonb,
  created_at timestamp with time zone default now()\n);

create table public.deliverables (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid not null,
  name text not null,
  description text,
  status text default 'not_started'::text,
  due_date date,
  delivered_at timestamp with time zone,
  delivery_url text,
  created_at timestamp with time zone default now()\n);

create table public.delivery_profiles (\n  id uuid default gen_random_uuid() not null,
  name text not null,
  description text,
  created_by text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  video_codec text default 'prores_422'::text not null,
  video_bitrate text,
  resolution_w integer default 1920 not null,
  resolution_h integer default 1080 not null,
  frame_rate text default '59.94'::text not null,
  frame_rate_mode text default 'cfr'::text not null,
  scan_mode text default 'progressive'::text not null,
  pixel_format text default 'yuv422p10le'::text,
  color_space text,
  audio_codec text default 'pcm_s24le'::text not null,
  audio_sample_rate integer default 48000 not null,
  audio_bit_depth integer default 24 not null,
  audio_bitrate text,
  audio_channels jsonb default '[{"label": "Stereo Mix Left", "source": "L", "channel": 1}, {"label": "Stereo Mix Right", "source": "R", "channel": 2}]'::jsonb not null,
  lufs_target double precision,
  true_peak_limit double precision,
  loudness_standard text default 'ITU-R BS.1770-3'::text,
  lufs_lra double precision,
  container text default 'mov'::text not null,
  head_pad_seconds double precision default 0,
  tail_pad_seconds double precision default 0,
  naming_template text,
  naming_example text,
  qc_checklist jsonb default '[]'::jsonb not null,
  notes text,
  pixel_map_url text,
  archived boolean default false not null,
  video_filters text\n);

create table public.delivery_spec_intake (\n  id uuid default gen_random_uuid() not null,
  channel_id text not null,
  thread_ts text not null,
  sources jsonb default '[]'::jsonb not null,
  status text default 'open'::text not null,
  created_at timestamp with time zone default now() not null,
  consumed_at timestamp with time zone,
  output_dir text\n);

create table public.delivery_specs (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  resolution text not null,
  codec text not null,
  frame_rate numeric(5,2) not null,
  color_space text not null,
  audio_format text not null,
  platform_requirements jsonb default '{}'::jsonb not null,
  checklist jsonb default '[]'::jsonb not null,
  status text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null,
  delivered_at timestamp with time zone\n);

create table public.delivery_specs_scan_frontier (\n  path text not null,
  created_at timestamp with time zone default now() not null\n);

create table public.delivery_specs_scan_state (\n  id text default 'singleton'::text not null,
  phase text default 'bootstrap'::text not null,
  cursor text,
  lease_holder text,
  lease_expires_at timestamp with time zone,
  fence bigint default 0 not null,
  updated_at timestamp with time zone default now() not null,
  backlog_complete boolean default false not null\n);

create table public.dropbox_event_inbox (\n  id uuid default gen_random_uuid() not null,
  event_key text not null,
  event_type text not null,
  payload jsonb not null,
  source_cursor text not null,
  status text default 'pending'::text not null,
  attempt_count integer default 0 not null,
  max_attempts integer default 8 not null,
  next_attempt_at timestamp with time zone default now() not null,
  claim_token uuid,
  claimed_by text,
  claimed_at timestamp with time zone,
  completed_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.dropbox_state (\n  id text default 'singleton'::text not null,
  cursor text,
  updated_at timestamp with time zone default now() not null\n);

create table public.edit_decisions (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  shot_ref text not null,
  time_in numeric(10,3) not null,
  time_out numeric(10,3) not null,
  duration numeric(10,3) not null,
  transition text default 'cut'::text not null,
  editorial_note text,
  order_index integer not null,
  created_at timestamp with time zone default now() not null\n);

create table public.elevenlabs_studio_jobs (\n  id uuid default gen_random_uuid() not null,
  storyboard_job_id uuid not null,
  workspace_id uuid,
  requested_by_slack_user_id text,
  slack_channel_id text,
  slack_thread_ts text,
  status text default 'queued'::text not null,
  project_name text not null,
  voiceover_paragraphs jsonb default '[]'::jsonb not null,
  studio_project_id text,
  studio_url text,
  claimed_by text,
  claimed_at timestamp with time zone,
  heartbeat_at timestamp with time zone,
  attempt integer default 0 not null,
  error text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.elevenlabs_workers (\n  worker_id text not null,
  display_name text not null,
  status text default 'offline'::text not null,
  current_job_id uuid,
  last_error text,
  browser_version text,
  last_seen_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.farm_status (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  check_time timestamp with time zone default now(),
  overall_health text,
  nodes_online integer,
  nodes_offline integer,
  nodes_rendering integer,
  jobs_active integer,
  jobs_failed integer,
  canary_passed boolean,
  canary_time_seconds numeric(6,2),
  node_details jsonb default '{}'::jsonb,
  diagnostics jsonb,
  summary text\n);

create table public.feedback_items (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid,
  source text not null,
  source_id text,
  source_url text,
  content text not null,
  summary text,
  sentiment text,
  status text default 'new'::text,
  assigned_to uuid,
  related_asset text,
  client_contact text,
  revision_round integer,
  received_at timestamp with time zone not null,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone default now()\n);

create table public.financial_entries (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  entry_type text,
  vendor_or_client text,
  amount numeric(10,2),
  due_date date,
  status text,
  project_id uuid,
  external_id text,
  synced_at timestamp with time zone default now()\n);

create table public.founder_content_access (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  accessed_by uuid not null,
  document_id uuid,
  query text,
  accessed_at timestamp with time zone default now()\n);

create table public.frameio_token_state (\n  id text default 'singleton'::text not null,
  refresh_token text,
  updated_at timestamp with time zone default now() not null,
  access_token text,
  access_expires_at timestamp with time zone,
  refreshing_until timestamp with time zone\n);

create table public.freelancer_onboardings (\n  id uuid default gen_random_uuid() not null,
  project_id uuid,
  artist_email text not null,
  artist_name text,
  artist_slack_user_id text,
  artist_staff_id uuid,
  requested_by_slack_user_id text not null,
  slack_status text,
  slack_error text,
  dropbox_status text,
  dropbox_error text,
  frameio_status text,
  frameio_error text,
  harvest_status text,
  harvest_error text,
  welcome_dm_status text,
  welcome_dm_error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  nda_status text,
  nda_error text,
  nda_sent_at timestamp with time zone,
  artist_legal_name text\n);

create table public.freelancer_paperwork (\n  email text not null,
  legal_name text,
  status text default 'sent'::text not null,
  nda_sent_at timestamp with time zone,
  nda_completed_at timestamp with time zone,
  nda_completed_by text,
  last_onboarding_id uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.gates (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  gate_number integer not null,
  gate_name text not null,
  status text default 'pending'::text not null,
  requested_by text not null,
  responded_by text,
  responded_via text,
  revision_notes text,
  slack_message_ts text,
  created_at timestamp with time zone default now() not null,
  resolved_at timestamp with time zone\n);

create table public.generated_documents (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid,
  doc_type text not null,
  title text not null,
  file_url text not null,
  generation_params jsonb default '{}'::jsonb,
  created_by uuid,
  created_at timestamp with time zone default now()\n);

create table public.generation_tasks (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  task_type text not null,
  phase integer not null,
  agent_name text not null,
  model_id text not null,
  model_provider text not null,
  prompt text not null,
  negative_prompt text,
  parameters jsonb default '{}'::jsonb not null,
  status text default 'pending'::text not null,
  result_url text,
  result_metadata jsonb,
  cost_usd numeric(10,6) default 0 not null,
  attempt_number integer default 1 not null,
  parent_task_id uuid,
  qc_decision text,
  qc_notes text,
  bible_section text,
  created_at timestamp with time zone default now() not null,
  completed_at timestamp with time zone\n);

create table public.harvest_user_map (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  slack_user_id text not null,
  harvest_user_id bigint not null,
  harvest_user_name text,
  created_at timestamp with time zone default now() not null\n);

create table public.hours_missing_alerts (\n  id uuid default gen_random_uuid() not null,
  staff_id uuid not null,
  slack_user_id text,
  streak_start_date date not null,
  streak_days integer not null,
  missing_dates jsonb default '[]'::jsonb not null,
  last_logged_date date,
  alert_channel_id text,
  alert_ts text,
  created_at timestamp with time zone default now() not null\n);

create table public.intake_messages (\n  id uuid default gen_random_uuid() not null,
  session_id uuid not null,
  role text not null,
  content text not null,
  attachments jsonb default '[]'::jsonb,
  extracted_data jsonb,
  turn_number integer not null,
  created_at timestamp with time zone default now() not null\n);

create table public.intake_sessions (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.integrations (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  service text not null,
  status text default 'pending'::text,
  credentials jsonb default '{}'::jsonb not null,
  config jsonb default '{}'::jsonb,
  scopes text[],
  connected_by uuid,
  last_synced_at timestamp with time zone,
  error_message text,
  connected_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()\n);

create table public.kit_actions (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid,
  action_type text not null,
  title text not null,
  body text not null,
  priority text default 'normal'::text,
  target_audience text[],
  status text default 'pending'::text,
  channel text,
  requires_approval boolean default true,
  min_tier_to_view text default 'producer'::text,
  approved_by uuid,
  created_at timestamp with time zone default now(),
  acted_at timestamp with time zone\n);

create table public.managed_agent_registry (\n  kind text not null,
  key text not null,
  external_id text not null,
  version text,
  model text,
  metadata jsonb default '{}'::jsonb,
  registered_at timestamp with time zone default now() not null\n);

create table public.meeting_briefing_deliveries (\n  id uuid default gen_random_uuid() not null,
  meeting_briefing_id uuid not null,
  internal_recipient_id uuid not null,
  slack_user_id text not null,
  slack_channel_id text,
  slack_message_ts text,
  status text default 'pending'::text not null,
  attempts integer default 0 not null,
  claimed_at timestamp with time zone,
  lease_expires_at timestamp with time zone,
  error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.meeting_briefings (\n  id uuid default gen_random_uuid() not null,
  event_id text not null,
  calendar_id text,
  project_id uuid,
  meeting_title text,
  meeting_start_time timestamp with time zone,
  attendees_json jsonb,
  briefing_md text,
  slack_channel_id text,
  slack_message_ts text,
  producer_dm_ts text,
  confidence numeric,
  status text default 'pending'::text not null,
  error text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  notified_user_ids jsonb,
  meeting_type text default 'project'::text not null\n);

create table public.milestones (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid not null,
  name text not null,
  description text,
  due_date date not null,
  status text default 'upcoming'::text,
  phase_type text,
  owner text,
  assigned_to uuid,
  dependencies uuid[],
  reminded_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now()\n);

create table public.model_catalog (\n  id text not null,
  name text not null,
  provider text not null,
  type text not null,
  api_endpoint text not null,
  capabilities jsonb default '{}'::jsonb not null,
  constraints jsonb default '{}'::jsonb not null,
  strengths text[] default '{}'::text[] not null,
  weaknesses text[] default '{}'::text[] not null,
  best_for text[] default '{}'::text[] not null,
  avoid text[] default '{}'::text[] not null,
  style_compatibility jsonb default '{}'::jsonb not null,
  pricing jsonb default '{}'::jsonb not null,
  release_date date,
  status text default 'active'::text not null,
  notes text,
  last_verified timestamp with time zone default now() not null,
  added_by text default 'system'::text not null,
  evaluation_notes text,
  benchmark_results jsonb,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.model_research_log (\n  id uuid default gen_random_uuid() not null,
  source text not null,
  query text not null,
  findings jsonb default '[]'::jsonb not null,
  actions_taken jsonb default '[]'::jsonb not null,
  models_affected text[] default '{}'::text[] not null,
  run_at timestamp with time zone default now() not null\n);

create table public.model_scores (\n  id uuid default gen_random_uuid() not null,
  agent_run_id uuid not null,
  model text not null,
  score numeric(4,2),
  criteria text not null,
  notes text,
  created_at timestamp with time zone default now() not null\n);

create table public.permission_requests (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  requester_id uuid not null,
  project_id uuid,
  requested_access text not null,
  original_question text,
  context text,
  status text default 'pending'::text,
  responded_by uuid,
  response_message text,
  created_at timestamp with time zone default now(),
  responded_at timestamp with time zone\n);

create table public.pilot_evidence (\n  id uuid default gen_random_uuid() not null,
  pilot_id uuid not null,
  category text not null,
  metric_key text,
  label text,
  value_numeric numeric,
  value_text text,
  unit text,
  observed_at timestamp with time zone,
  provenance jsonb,
  author text not null,
  created_at timestamp with time zone default now() not null\n);

create table public.pilot_generations (\n  id uuid default gen_random_uuid() not null,
  pilot_id uuid not null,
  source text,
  kind text,
  external_ref text,
  label text,
  acceptance text default 'pending'::text not null,
  accepted_by text,
  accepted_at timestamp with time zone,
  notes text,
  provenance jsonb,
  author text not null,
  created_at timestamp with time zone default now() not null\n);

create table public.pilot_material_maps (\n  id uuid default gen_random_uuid() not null,
  pilot_id uuid not null,
  package_name text not null,
  map_type text not null,
  purpose text not null,
  external_ref text,
  provenance jsonb,
  author text not null,
  created_at timestamp with time zone default now() not null\n);

create table public.pilot_references (\n  id uuid default gen_random_uuid() not null,
  pilot_id uuid not null,
  ref_type text not null,
  url text,
  label text,
  description text,
  provenance jsonb,
  author text not null,
  created_at timestamp with time zone default now() not null\n);

create table public.pilot_validations (\n  id uuid default gen_random_uuid() not null,
  pilot_id uuid not null,
  tool text not null,
  evidence_ref text not null,
  subject text,
  passed boolean default true not null,
  note text,
  provenance jsonb,
  author text not null,
  created_at timestamp with time zone default now() not null\n);

create table public.pilots (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  workspace_id uuid,
  pilot_type text default 'visual_development'::text not null,
  title text,
  status text default 'active'::text not null,
  visual_language text,
  recommendation text,
  recommendation_rationale text,
  recommendation_by text,
  recommendation_at timestamp with time zone,
  canvas_id text,
  canvas_url text,
  created_by text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.pitch_log (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  client text not null,
  project_description text,
  project_type text,
  budget_range text,
  competitors text[],
  outcome text,
  outcome_reason text,
  pitch_date date,
  decision_date date,
  notes text,
  created_at timestamp with time zone default now()\n);

create table public.plaud_token_state (\n  id text not null,
  refresh_token text,
  access_token text,
  access_expires_at timestamp with time zone,
  refreshing_until timestamp with time zone,
  updated_at timestamp with time zone default now() not null\n);

create table public.project_access (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid not null,
  team_member_id uuid not null,
  project_role text,
  deliverables text[],
  added_at timestamp with time zone default now(),
  removed_at timestamp with time zone,
  can_see_financials boolean default false,
  custom_permissions jsonb default '{}'::jsonb\n);

create table public.project_control_bindings (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  spreadsheet_id text not null,
  sheet_id bigint not null,
  row_metadata_id bigint,
  source_template_file_id text,
  source_template_hash text,
  template_markdown text,
  canvas_id text,
  canvas_url text,
  creation_state text default 'pending_sheet'::text not null,
  sync_status text default 'pending'::text not null,
  last_row_hash text,
  last_synced_at timestamp with time zone,
  error text,
  error_notified_key text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.project_control_canvases (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  canvas_type text not null,
  source_template_file_id text,
  source_template_hash text,
  template_markdown text,
  canvas_id text,
  canvas_url text,
  last_source_hash text,
  last_synced_at timestamp with time zone,
  sync_status text default 'pending'::text not null,
  error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.project_creation_requests (\n  id uuid default gen_random_uuid() not null,
  request_key text not null,
  workspace_id uuid,
  requested_by_slack_user_id text,
  submission jsonb default '{}'::jsonb not null,
  decision text,
  replace_target_project_id uuid,
  project_id uuid,
  status text default 'pending'::text not null,
  attempts integer default 0 not null,
  claimed_by text,
  claimed_at timestamp with time zone,
  lease_expires_at timestamp with time zone,
  fence bigint default 0 not null,
  error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.project_documents (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid,
  doc_type text not null,
  title text not null,
  content text not null,
  source_url text,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  indexed_at timestamp with time zone default now(),
  created_at timestamp with time zone default now(),
  visibility_tier text default 'team'::text not null\n);

create table public.project_provisioning_steps (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  service text not null,
  status text default 'pending'::text not null,
  result jsonb,
  error text,
  claim_holder text,
  claimed_at timestamp with time zone,
  lease_expires_at timestamp with time zone,
  fence bigint default 0 not null,
  attempts integer default 0 not null,
  input_hash text,
  external_id text,
  external_url text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.project_settings (\n  project_id uuid not null,
  frameio_upload_enabled boolean default true not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text\n);

create table public.project_share_events (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  dropbox_file_id text not null,
  dropbox_rev text not null,
  file_name text not null,
  share_url text not null,
  suggested_milestone text,
  match_confidence text,
  status text default 'pending'::text not null,
  slack_channel_id text,
  slack_message_ts text,
  decided_by_slack_user_id text,
  decided_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.project_update_requests (\n  id uuid default gen_random_uuid() not null,
  request_key text not null,
  workspace_id uuid,
  project_id uuid not null,
  requested_by_slack_user_id text,
  submission jsonb default '{}'::jsonb not null,
  plan jsonb default '{}'::jsonb not null,
  decision text,
  status text default 'pending'::text not null,
  attempts integer default 0 not null,
  claimed_by text,
  claimed_at timestamp with time zone,
  lease_expires_at timestamp with time zone,
  fence bigint default 0 not null,
  error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.project_update_steps (\n  id uuid default gen_random_uuid() not null,
  update_request_id uuid not null,
  project_id uuid not null,
  service text not null,
  status text default 'pending'::text not null,
  result jsonb,
  error text,
  claim_holder text,
  claimed_at timestamp with time zone,
  lease_expires_at timestamp with time zone,
  fence bigint default 0 not null,
  attempts integer default 0 not null,
  input_hash text,
  external_id text,
  external_url text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.projects (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  name text not null,
  client text not null,
  project_code text,
  project_type text,
  status text default 'active'::text,
  start_date date,
  target_delivery date,
  budget_total numeric(10,2),
  budget_spent numeric(10,2) default 0,
  budget_alert_threshold numeric(3,2) default 0.75,
  margin_target numeric(3,2) default 0.40,
  revision_rounds_budgeted integer default 2,
  revision_rounds_used integer default 0,
  sow_summary text,
  brief_summary text,
  external_links jsonb default '{}'::jsonb,
  external_ids jsonb default '{}'::jsonb,
  financial_sheet_url text,
  project_ops_id text,
  provisioning_status jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  slack_channel_id text,
  harvest_project_id bigint,
  harvest_task_id bigint,
  project_manager_slack_id text,
  creation_request_id text\n);

create table public.render_jobs (\n  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  status text default 'pending'::text not null,
  requested_by text not null,
  slack_channel text,
  slack_thread_ts text,
  profile_id uuid,
  profile_snapshot jsonb,
  source_files jsonb not null,
  naming_fields jsonb,
  output_path text,
  output_filename text,
  output_size_bytes bigint,
  claimed_by text,
  claimed_at timestamp with time zone,
  processing_started_at timestamp with time zone,
  completed_at timestamp with time zone,
  progress_percent integer default 0,
  progress_message text,
  ffmpeg_command text,
  duration_seconds double precision,
  error_message text,
  retry_count integer default 0 not null,
  max_retries integer default 2 not null,
  qc_checklist_status jsonb,
  slack_notified_at timestamp with time zone,
  slack_notified_status text,
  slack_message_ts text,
  job_type text default 'transcode'::text not null,
  parent_job_id uuid,
  chunk_index integer,
  chunk_count integer,
  frame_start integer,
  frame_end integer,
  total_frames integer,
  ae_project_path text,
  ae_comp text,
  ae_render_settings_template text,
  ae_output_module_template text,
  ae_output_pattern text,
  ae_output_dir text,
  frame_rate text,
  delivery_profile_id uuid,
  aerender_command text,
  ae_rqindex integer,
  ae_is_movie boolean default false not null,
  render_queue jsonb,
  render_backend text default 'kit-worker'::text not null,
  deadline_jobs jsonb\n);

create table public.render_workers (\n  id uuid default gen_random_uuid() not null,
  hostname text not null,
  display_name text,
  registered_at timestamp with time zone default now() not null,
  role text default 'fallback'::text not null,
  priority integer default 10 not null,
  status text default 'offline'::text not null,
  last_heartbeat timestamp with time zone,
  cpu_usage_percent double precision,
  memory_usage_percent double precision,
  disk_free_gb double precision,
  ffmpeg_version text,
  os_version text,
  current_job_id uuid,
  max_concurrent_jobs integer default 1 not null,
  cpu_threshold double precision default 50.0 not null,
  dropbox_sync_path text,
  ffmpeg_path text default 'ffmpeg'::text not null,
  opted_out_by text,
  opted_out_at timestamp with time zone,
  opted_out_reason text,
  ae_capable boolean default false not null,
  aerender_path text,
  ae_version text\n);

create table public.review_extractions (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid,
  asset_id text not null,
  asset_name text not null,
  source_url text,
  slack_channel_id text,
  slack_thread_ts text,
  notes jsonb default '[]'::jsonb not null,
  total_comments integer default 0,
  thumbnails_found integer default 0,
  created_at timestamp with time zone default now() not null\n);

create table public.scope_events (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid not null,
  feedback_item_id uuid,
  description text not null,
  classification text,
  estimated_hours numeric(6,2),
  estimated_cost numeric(8,2),
  resolution text,
  created_at timestamp with time zone default now()\n);

create table public.seen_dropbox_files (\n  dropbox_id text not null,
  path text not null,
  size_bytes bigint,
  first_seen_at timestamp with time zone default now() not null,
  notified_at timestamp with time zone,
  stable_check_count integer default 0 not null\n);

create table public.sentiment_snapshots (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid not null,
  snapshot_date date not null,
  client_satisfaction numeric(3,1),
  client_trend text,
  client_latest_signal text,
  team_morale numeric(3,1),
  team_trend text,
  team_notes text,
  analysis jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now()\n);

create table public.sheet_sync_state (\n  spreadsheet_id text not null,
  drive_version text,
  cursor_advanced_at timestamp with time zone,
  creation_lease_holder text,
  creation_lease_expires_at timestamp with time zone,
  creation_fence bigint default 0 not null,
  sync_lease_holder text,
  sync_lease_expires_at timestamp with time zone,
  sync_fence bigint default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null\n);

create table public.staff (\n  id uuid default gen_random_uuid() not null,
  slack_user_id text not null,
  email text,
  full_name text,
  role text,
  harvest_user_id bigint,
  frameio_user_id text,
  is_active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  employment_type text,
  email_aliases text[] default '{}'::text[] not null,
  briefing_channel_id text,
  daily_checkin boolean default false not null,
  timezone text\n);

create table public.staff_time_off (\n  id uuid default gen_random_uuid() not null,
  staff_id uuid not null,
  start_date date not null,
  end_date date not null,
  kind text default 'pto'::text not null,
  note text,
  created_by text,
  created_at timestamp with time zone default now() not null\n);

create table public.storyboard_jobs (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid,
  user_id text,
  channel_id text,
  project_name text not null,
  frames jsonb not null,
  last_frame_index integer default 0 not null,
  status text default 'pending'::text not null,
  aspect_ratio text,
  seconds_per_frame integer,
  video_style text,
  mode_used text,
  boords_storyboard_id text,
  boords_url text,
  last_error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  elevenlabs_project_id text,
  elevenlabs_url text,
  elevenlabs_status text,
  elevenlabs_error text\n);

create table public.storyboard_panels (\n  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  scene_number integer not null,
  panel_number integer not null,
  shot_size text not null,
  angle text,
  movement text,
  action text not null,
  dialogue text,
  duration text,
  transition text,
  generation_task_id uuid,
  status text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null\n);

create table public.system_health (\n  key text not null,
  status text not null,
  detail text,
  since timestamp with time zone default now() not null,
  checked_at timestamp with time zone default now() not null\n);

create table public.team_members (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  auth_user_id uuid,
  name text not null,
  email text not null,
  role text not null,
  permission_tier text default 'artist'::text not null,
  hourly_rate numeric(6,2),
  avatar_url text,
  slack_user_id text,
  clockify_user_id text,
  notion_user_id text,
  frameio_user_id text,
  is_active boolean default true,
  notification_preferences jsonb default '{"slack_dm": true, "email_digest": false}'::jsonb,
  invited_by uuid,
  invited_at timestamp with time zone,
  accepted_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  harvest_user_id text\n);

create table public.templates (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  category text not null,
  name text not null,
  description text,
  content text not null,
  variables jsonb default '[]'::jsonb,
  is_active boolean default true,
  created_at timestamp with time zone default now()\n);

create table public.time_entries (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid,
  team_member_id uuid,
  external_entry_id text,
  description text,
  hours numeric(6,2) not null,
  cost numeric(8,2),
  date date not null,
  task_category text,
  entry_source text default 'integration'::text,
  vendor_name text,
  synced_at timestamp with time zone default now()\n);

create table public.transcription_routing (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  rule_type text not null,
  rule_value text not null,
  target_stream text not null,
  priority integer default 0,
  created_at timestamp with time zone default now()\n);

create table public.workback_schedules (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  project_id uuid not null,
  version integer default 1,
  is_active boolean default true,
  schedule jsonb not null,
  confidence_score integer,
  confidence_notes text,
  risks jsonb default '[]'::jsonb,
  open_questions jsonb default '[]'::jsonb,
  historical_comparison text,
  created_at timestamp with time zone default now()\n);

create table public.workspace_config (\n  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  config_key text not null,
  config_value jsonb not null,
  updated_at timestamp with time zone default now()\n);

create table public.workspaces (\n  id uuid default gen_random_uuid() not null,
  name text not null,
  slug text not null,
  logo_url text,
  plan text default 'trial'::text,
  onboarding_completed boolean default false,
  settings jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  slack_team_id text\n);

-- seqowned
alter sequence brain_revisions_id_seq owned by brain_revisions.id;

alter sequence brain_scavenger_candidates_id_seq owned by brain_scavenger_candidates.id;

-- constraints
alter table accessibility_jobs add constraint accessibility_jobs_pkey PRIMARY KEY (id);

alter table action_breakdowns add constraint action_breakdowns_pkey PRIMARY KEY (id);

alter table agent_runs add constraint agent_runs_pkey PRIMARY KEY (id);

alter table archive_activity add constraint archive_activity_pkey PRIMARY KEY (id);

alter table archive_job_steps add constraint archive_job_steps_pkey PRIMARY KEY (id);

alter table archive_jobs add constraint archive_jobs_pkey PRIMARY KEY (id);

alter table artifacts add constraint artifacts_pkey PRIMARY KEY (id);

alter table autonomy_settings add constraint autonomy_settings_pkey PRIMARY KEY (id);

alter table behance_draft_jobs add constraint behance_draft_jobs_pkey PRIMARY KEY (id);

alter table behance_workers add constraint behance_workers_pkey PRIMARY KEY (worker_id);

alter table bible_versions add constraint bible_versions_pkey PRIMARY KEY (id);

alter table birthdays add constraint birthdays_pkey PRIMARY KEY (slack_user_id);

alter table brain_revisions add constraint brain_revisions_pkey PRIMARY KEY (id);

alter table brain_scavenger_candidates add constraint brain_scavenger_candidates_pkey PRIMARY KEY (id);

alter table brains add constraint brains_pkey PRIMARY KEY (id);

alter table call_classifications add constraint call_classifications_pkey PRIMARY KEY (id);

alter table call_transcripts add constraint call_transcripts_pkey PRIMARY KEY (id);

alter table character_sheets add constraint character_sheets_pkey PRIMARY KEY (id);

alter table client_profiles add constraint client_profiles_pkey PRIMARY KEY (id);

alter table conversation_state add constraint conversation_state_pkey PRIMARY KEY (key);

alter table cron_heartbeats add constraint cron_heartbeats_pkey PRIMARY KEY (cron_id);

alter table daily_hours_checkins add constraint daily_hours_checkins_pkey PRIMARY KEY (id);

alter table daily_hours_reminders add constraint daily_hours_reminders_pkey PRIMARY KEY (id);

alter table daily_task_cards add constraint daily_task_cards_pkey PRIMARY KEY (id);

alter table deliverables add constraint deliverables_pkey PRIMARY KEY (id);

alter table delivery_profiles add constraint delivery_profiles_pkey PRIMARY KEY (id);

alter table delivery_spec_intake add constraint delivery_spec_intake_pkey PRIMARY KEY (id);

alter table delivery_specs add constraint delivery_specs_pkey PRIMARY KEY (id);

alter table delivery_specs_scan_frontier add constraint delivery_specs_scan_frontier_pkey PRIMARY KEY (path);

alter table delivery_specs_scan_state add constraint delivery_specs_scan_state_pkey PRIMARY KEY (id);

alter table dropbox_event_inbox add constraint dropbox_event_inbox_pkey PRIMARY KEY (id);

alter table dropbox_state add constraint dropbox_state_pkey PRIMARY KEY (id);

alter table edit_decisions add constraint edit_decisions_pkey PRIMARY KEY (id);

alter table elevenlabs_studio_jobs add constraint elevenlabs_studio_jobs_pkey PRIMARY KEY (id);

alter table elevenlabs_workers add constraint elevenlabs_workers_pkey PRIMARY KEY (worker_id);

alter table farm_status add constraint farm_status_pkey PRIMARY KEY (id);

alter table feedback_items add constraint feedback_items_pkey PRIMARY KEY (id);

alter table financial_entries add constraint financial_entries_pkey PRIMARY KEY (id);

alter table founder_content_access add constraint founder_content_access_pkey PRIMARY KEY (id);

alter table frameio_token_state add constraint frameio_token_state_pkey PRIMARY KEY (id);

alter table freelancer_onboardings add constraint freelancer_onboardings_pkey PRIMARY KEY (id);

alter table freelancer_paperwork add constraint freelancer_paperwork_pkey PRIMARY KEY (email);

alter table gates add constraint gates_pkey PRIMARY KEY (id);

alter table generated_documents add constraint generated_documents_pkey PRIMARY KEY (id);

alter table generation_tasks add constraint generation_tasks_pkey PRIMARY KEY (id);

alter table harvest_user_map add constraint harvest_user_map_pkey PRIMARY KEY (id);

alter table hours_missing_alerts add constraint hours_missing_alerts_pkey PRIMARY KEY (id);

alter table intake_messages add constraint intake_messages_pkey PRIMARY KEY (id);

alter table intake_sessions add constraint intake_sessions_pkey PRIMARY KEY (id);

alter table integrations add constraint integrations_pkey PRIMARY KEY (id);

alter table kit_actions add constraint kit_actions_pkey PRIMARY KEY (id);

alter table managed_agent_registry add constraint managed_agent_registry_pkey PRIMARY KEY (kind, key);

alter table meeting_briefing_deliveries add constraint meeting_briefing_deliveries_pkey PRIMARY KEY (id);

alter table meeting_briefings add constraint meeting_briefings_pkey PRIMARY KEY (id);

alter table milestones add constraint milestones_pkey PRIMARY KEY (id);

alter table model_catalog add constraint model_catalog_pkey PRIMARY KEY (id);

alter table model_research_log add constraint model_research_log_pkey PRIMARY KEY (id);

alter table model_scores add constraint model_scores_pkey PRIMARY KEY (id);

alter table permission_requests add constraint permission_requests_pkey PRIMARY KEY (id);

alter table pilot_evidence add constraint pilot_evidence_pkey PRIMARY KEY (id);

alter table pilot_generations add constraint pilot_generations_pkey PRIMARY KEY (id);

alter table pilot_material_maps add constraint pilot_material_maps_pkey PRIMARY KEY (id);

alter table pilot_references add constraint pilot_references_pkey PRIMARY KEY (id);

alter table pilot_validations add constraint pilot_validations_pkey PRIMARY KEY (id);

alter table pilots add constraint pilots_pkey PRIMARY KEY (id);

alter table pitch_log add constraint pitch_log_pkey PRIMARY KEY (id);

alter table plaud_token_state add constraint plaud_token_state_pkey PRIMARY KEY (id);

alter table project_access add constraint project_access_pkey PRIMARY KEY (id);

alter table project_control_bindings add constraint project_control_bindings_pkey PRIMARY KEY (id);

alter table project_control_canvases add constraint project_control_canvases_pkey PRIMARY KEY (id);

alter table project_creation_requests add constraint project_creation_requests_pkey PRIMARY KEY (id);

alter table project_documents add constraint project_documents_pkey PRIMARY KEY (id);

alter table project_provisioning_steps add constraint project_provisioning_steps_pkey PRIMARY KEY (id);

alter table project_settings add constraint project_settings_pkey PRIMARY KEY (project_id);

alter table project_share_events add constraint project_share_events_pkey PRIMARY KEY (id);

alter table project_update_requests add constraint project_update_requests_pkey PRIMARY KEY (id);

alter table project_update_steps add constraint project_update_steps_pkey PRIMARY KEY (id);

alter table projects add constraint projects_pkey PRIMARY KEY (id);

alter table render_jobs add constraint render_jobs_pkey PRIMARY KEY (id);

alter table render_workers add constraint render_workers_pkey PRIMARY KEY (id);

alter table review_extractions add constraint review_extractions_pkey PRIMARY KEY (id);

alter table scope_events add constraint scope_events_pkey PRIMARY KEY (id);

alter table seen_dropbox_files add constraint seen_dropbox_files_pkey PRIMARY KEY (dropbox_id);

alter table sentiment_snapshots add constraint sentiment_snapshots_pkey PRIMARY KEY (id);

alter table sheet_sync_state add constraint sheet_sync_state_pkey PRIMARY KEY (spreadsheet_id);

alter table staff add constraint staff_pkey PRIMARY KEY (id);

alter table staff_time_off add constraint staff_time_off_pkey PRIMARY KEY (id);

alter table storyboard_jobs add constraint storyboard_jobs_pkey PRIMARY KEY (id);

alter table storyboard_panels add constraint storyboard_panels_pkey PRIMARY KEY (id);

alter table system_health add constraint system_health_pkey PRIMARY KEY (key);

alter table team_members add constraint team_members_pkey PRIMARY KEY (id);

alter table templates add constraint templates_pkey PRIMARY KEY (id);

alter table time_entries add constraint time_entries_pkey PRIMARY KEY (id);

alter table transcription_routing add constraint transcription_routing_pkey PRIMARY KEY (id);

alter table workback_schedules add constraint workback_schedules_pkey PRIMARY KEY (id);

alter table workspace_config add constraint workspace_config_pkey PRIMARY KEY (id);

alter table workspaces add constraint workspaces_pkey PRIMARY KEY (id);

alter table archive_job_steps add constraint archive_job_steps_job_step_unique UNIQUE (job_id, step_name);

alter table archive_jobs add constraint archive_jobs_idempotency_unique UNIQUE (idempotency_key);

alter table artifacts add constraint artifacts_project_id_artifact_type_version_key UNIQUE (project_id, artifact_type, version);

alter table autonomy_settings add constraint autonomy_settings_workspace_id_project_id_action_type_key UNIQUE (workspace_id, project_id, action_type);

alter table behance_draft_jobs add constraint behance_draft_jobs_archive_job_id_key UNIQUE (archive_job_id);

alter table bible_versions add constraint bible_versions_project_id_version_key UNIQUE (project_id, version);

alter table call_transcripts add constraint call_transcripts_external_recording_id_key UNIQUE (external_recording_id);

alter table client_profiles add constraint client_profiles_workspace_id_client_name_key UNIQUE (workspace_id, client_name);

alter table daily_hours_reminders add constraint daily_hours_reminders_occurrence_key UNIQUE (staff_id, local_date, reminder_type);

alter table daily_task_cards add constraint daily_task_cards_workspace_id_team_member_id_card_date_key UNIQUE (workspace_id, team_member_id, card_date);

alter table delivery_spec_intake add constraint delivery_spec_intake_channel_id_thread_ts_key UNIQUE (channel_id, thread_ts);

alter table dropbox_event_inbox add constraint dropbox_event_inbox_event_key_key UNIQUE (event_key);

alter table elevenlabs_studio_jobs add constraint elevenlabs_studio_jobs_storyboard_job_id_key UNIQUE (storyboard_job_id);

alter table harvest_user_map add constraint harvest_user_map_workspace_id_slack_user_id_key UNIQUE (workspace_id, slack_user_id);

alter table hours_missing_alerts add constraint hours_missing_alerts_staff_id_streak_start_date_key UNIQUE (staff_id, streak_start_date);

alter table integrations add constraint integrations_workspace_id_service_key UNIQUE (workspace_id, service);

alter table meeting_briefing_deliveries add constraint meeting_briefing_deliveries_recipient_key UNIQUE (meeting_briefing_id, internal_recipient_id);

alter table pilots add constraint pilots_canvas_unique UNIQUE (canvas_id);

alter table project_access add constraint project_access_project_id_team_member_id_key UNIQUE (project_id, team_member_id);

alter table project_control_bindings add constraint project_control_bindings_canvas_unique UNIQUE (canvas_id);

alter table project_control_bindings add constraint project_control_bindings_metadata_unique UNIQUE (spreadsheet_id, row_metadata_id);

alter table project_control_bindings add constraint project_control_bindings_project_unique UNIQUE (project_id);

alter table project_control_canvases add constraint project_control_canvases_canvas_unique UNIQUE (canvas_id);

alter table project_control_canvases add constraint project_control_canvases_project_type_unique UNIQUE (project_id, canvas_type);

alter table project_creation_requests add constraint project_creation_requests_request_key_unique UNIQUE (request_key);

alter table project_provisioning_steps add constraint project_provisioning_steps_project_service_unique UNIQUE (project_id, service);

alter table project_share_events add constraint project_share_events_file_revision_unique UNIQUE (project_id, dropbox_file_id, dropbox_rev);

alter table project_update_requests add constraint project_update_requests_request_key_unique UNIQUE (request_key);

alter table project_update_steps add constraint project_update_steps_request_service_unique UNIQUE (update_request_id, service);

alter table render_workers add constraint render_workers_hostname_key UNIQUE (hostname);

alter table staff add constraint staff_email_key UNIQUE (email);

alter table staff add constraint staff_slack_user_id_key UNIQUE (slack_user_id);

alter table storyboard_panels add constraint storyboard_panels_project_id_scene_number_panel_number_key UNIQUE (project_id, scene_number, panel_number);

alter table team_members add constraint team_members_workspace_id_email_key UNIQUE (workspace_id, email);

alter table time_entries add constraint time_entries_workspace_id_external_entry_id_key UNIQUE (workspace_id, external_entry_id);

alter table workspace_config add constraint workspace_config_workspace_id_config_key_key UNIQUE (workspace_id, config_key);

alter table workspaces add constraint workspaces_slug_key UNIQUE (slug);

alter table accessibility_jobs add constraint accessibility_jobs_status_check CHECK (status = ANY (ARRAY['pending'::text, 'transcribing'::text, 'analyzing'::text, 'narrating'::text, 'mixing'::text, 'uploading'::text, 'complete'::text, 'failed'::text]));

alter table action_breakdowns add constraint action_breakdowns_status_check CHECK (status = ANY (ARRAY['draft'::text, 'approved'::text, 'distributed'::text]));

alter table archive_job_steps add constraint archive_job_steps_status_check CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'complete'::text, 'failed'::text, 'skipped'::text]));

alter table archive_jobs add constraint archive_jobs_status_check CHECK (status = ANY (ARRAY['awaiting_confirmation'::text, 'queued'::text, 'validating'::text, 'preparing_media'::text, 'uploading_vimeo'::text, 'creating_wordpress'::text, 'creating_buffer'::text, 'preparing_behance'::text, 'complete'::text, 'partial'::text, 'failed'::text, 'cancelled'::text]));

alter table autonomy_settings add constraint autonomy_settings_autonomy_level_check CHECK (autonomy_level = ANY (ARRAY['ask_first'::text, 'auto_draft'::text, 'auto_send'::text]));

alter table behance_draft_jobs add constraint behance_draft_jobs_status_check CHECK (status = ANY (ARRAY['queued'::text, 'claimed'::text, 'opening_editor'::text, 'uploading_media'::text, 'filling_details'::text, 'saving_draft'::text, 'awaiting_review'::text, 'retryable'::text, 'failed'::text, 'cancelled'::text]));

alter table behance_workers add constraint behance_workers_status_check CHECK (status = ANY (ARRAY['idle'::text, 'working'::text, 'needs_login'::text, 'error'::text, 'offline'::text]));

alter table brain_revisions add constraint brain_revisions_operation_check CHECK (operation = ANY (ARRAY['add'::text, 'update'::text, 'supersede'::text, 'replace'::text, 'seed'::text]));

alter table brain_scavenger_candidates add constraint brain_scavenger_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text]));

alter table brains add constraint brains_autonomy_check CHECK (autonomy = ANY (ARRAY['autonomous'::text, 'gated'::text, 'ask_first'::text]));

alter table brains add constraint brains_scope_check CHECK (scope = ANY (ARRAY['studio'::text, 'project'::text]));

alter table brains add constraint brains_visibility_check CHECK (visibility = ANY (ARRAY['team'::text, 'producers_only'::text]));

alter table call_classifications add constraint call_classifications_call_type_check CHECK (call_type = ANY (ARRAY['scoping_call'::text, 'project_kickoff'::text, 'client_review'::text, 'status_checkin'::text, 'internal_team'::text, 'post_mortem'::text, 'founder_strategy'::text, 'unknown'::text]));

alter table call_transcripts add constraint call_transcripts_ingest_status_check CHECK (ingest_status = ANY (ARRAY['pending'::text, 'ingested'::text, 'failed'::text]));

alter table call_transcripts add constraint call_transcripts_source_check CHECK (source = ANY (ARRAY['plaud'::text, 'manual'::text, 'granola'::text, 'drive'::text]));

alter table character_sheets add constraint character_sheets_status_check CHECK (status = ANY (ARRAY['pending'::text, 'generating'::text, 'completed'::text, 'approved'::text, 'rejected'::text, 'failed'::text]));

alter table client_profiles add constraint client_profiles_health_trend_check CHECK (health_trend = ANY (ARRAY['improving'::text, 'stable'::text, 'declining'::text]));

alter table daily_hours_checkins add constraint daily_hours_checkins_origin_check CHECK (origin = ANY (ARRAY['scheduled'::text, 'adhoc'::text, 'manual-reconciliation'::text]));

alter table daily_hours_checkins add constraint daily_hours_checkins_status_check CHECK (status = ANY (ARRAY['sent'::text, 'replied'::text, 'parsed'::text, 'confirmed'::text, 'logging'::text, 'logged'::text, 'skipped'::text, 'nudged'::text, 'failed'::text, 'expired'::text]));

alter table daily_hours_reminders add constraint daily_hours_reminders_status_check CHECK (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'posting'::text, 'unconfirmed'::text, 'sent'::text, 'skipped'::text, 'failed'::text]));

alter table daily_task_cards add constraint daily_task_cards_status_check CHECK (status = ANY (ARRAY['draft'::text, 'pending_review'::text, 'approved'::text, 'distributed'::text, 'skipped'::text]));

alter table deliverables add constraint deliverables_status_check CHECK (status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'in_review'::text, 'approved'::text, 'delivered'::text]));

alter table delivery_specs add constraint delivery_specs_status_check CHECK (status = ANY (ARRAY['pending'::text, 'packaging'::text, 'delivered'::text]));

alter table delivery_specs_scan_state add constraint delivery_specs_scan_state_phase_check CHECK (phase = ANY (ARRAY['bootstrap'::text, 'delta'::text]));

alter table dropbox_event_inbox add constraint dropbox_event_inbox_attempt_count_check CHECK (attempt_count >= 0);

alter table dropbox_event_inbox add constraint dropbox_event_inbox_event_type_check CHECK (event_type = ANY (ARRAY['accessibility_srt'::text, 'ae_render'::text, 'frameio_delivery'::text]));

alter table dropbox_event_inbox add constraint dropbox_event_inbox_max_attempts_check CHECK (max_attempts > 0);

alter table dropbox_event_inbox add constraint dropbox_event_inbox_status_check CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'retryable'::text, 'complete'::text, 'dead_letter'::text]));

alter table elevenlabs_studio_jobs add constraint elevenlabs_studio_jobs_status_check CHECK (status = ANY (ARRAY['queued'::text, 'claimed'::text, 'opening_studio'::text, 'filling_project'::text, 'saving_draft'::text, 'complete'::text, 'retryable'::text, 'failed'::text, 'cancelled'::text]));

alter table elevenlabs_workers add constraint elevenlabs_workers_status_check CHECK (status = ANY (ARRAY['idle'::text, 'working'::text, 'needs_login'::text, 'error'::text, 'offline'::text]));

alter table feedback_items add constraint feedback_items_sentiment_check CHECK (sentiment = ANY (ARRAY['positive'::text, 'neutral'::text, 'negative'::text, 'urgent'::text]));

alter table feedback_items add constraint feedback_items_status_check CHECK (status = ANY (ARRAY['new'::text, 'acknowledged'::text, 'in_progress'::text, 'resolved'::text, 'wont_fix'::text]));

alter table financial_entries add constraint financial_entries_entry_type_check CHECK (entry_type = ANY (ARRAY['receivable'::text, 'payable'::text]));

alter table freelancer_onboardings add constraint freelancer_onboardings_dropbox_status_check CHECK (dropbox_status = ANY (ARRAY['pending'::text, 'ok'::text, 'failed'::text, 'skipped'::text]));

alter table freelancer_onboardings add constraint freelancer_onboardings_frameio_status_check CHECK (frameio_status = ANY (ARRAY['pending'::text, 'ok'::text, 'failed'::text, 'skipped'::text]));

alter table freelancer_onboardings add constraint freelancer_onboardings_harvest_status_check CHECK (harvest_status = ANY (ARRAY['pending'::text, 'ok'::text, 'failed'::text, 'skipped'::text]));

alter table freelancer_onboardings add constraint freelancer_onboardings_slack_status_check CHECK (slack_status = ANY (ARRAY['pending'::text, 'ok'::text, 'failed'::text, 'skipped'::text]));

alter table freelancer_onboardings add constraint freelancer_onboardings_welcome_dm_status_check CHECK (welcome_dm_status = ANY (ARRAY['pending'::text, 'ok'::text, 'failed'::text, 'skipped'::text]));

alter table freelancer_paperwork add constraint freelancer_paperwork_status_check CHECK (status = ANY (ARRAY['sent'::text, 'on_file'::text, 'waived'::text]));

alter table gates add constraint gates_responded_via_check CHECK (responded_via = ANY (ARRAY['slack'::text, 'dashboard'::text]));

alter table gates add constraint gates_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'revision_requested'::text, 'killed'::text]));

alter table generation_tasks add constraint generation_tasks_qc_decision_check CHECK (qc_decision IS NULL OR (qc_decision = ANY (ARRAY['approved'::text, 'revise'::text, 'reject'::text])));

alter table generation_tasks add constraint generation_tasks_status_check CHECK (status = ANY (ARRAY['pending'::text, 'generating'::text, 'completed'::text, 'approved'::text, 'rejected'::text, 'failed'::text]));

alter table generation_tasks add constraint generation_tasks_task_type_check CHECK (task_type = ANY (ARRAY['concept_art'::text, 'style_frame'::text, 'character_sheet'::text, 'storyboard'::text, 'color_key'::text, 'title_card'::text, 'video_shot'::text, 'video_transition'::text, 'voiceover'::text, 'music'::text, 'sound_design'::text, '3d_model'::text]));

alter table intake_messages add constraint intake_messages_role_check CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text]));

alter table intake_sessions add constraint intake_sessions_status_check CHECK (status = ANY (ARRAY['active'::text, 'handed_off'::text, 'closed'::text]));

alter table integrations add constraint integrations_status_check CHECK (status = ANY (ARRAY['pending'::text, 'connected'::text, 'error'::text, 'disconnected'::text]));

alter table kit_actions add constraint kit_actions_priority_check CHECK (priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'critical'::text]));

alter table kit_actions add constraint kit_actions_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'sent'::text, 'dismissed'::text, 'auto_sent'::text]));

alter table managed_agent_registry add constraint managed_agent_registry_kind_check CHECK (kind = ANY (ARRAY['agent'::text, 'environment'::text]));

alter table meeting_briefing_deliveries add constraint meeting_briefing_deliveries_status_check CHECK (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'posting'::text, 'unconfirmed'::text, 'sent'::text, 'failed'::text]));

alter table meeting_briefings add constraint meeting_briefings_meeting_type_check CHECK (meeting_type = ANY (ARRAY['project'::text, 'bizdev'::text]));

alter table meeting_briefings add constraint meeting_briefings_status_check CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text]));

alter table milestones add constraint milestones_owner_check CHECK (owner = ANY (ARRAY['studio'::text, 'client'::text, 'both'::text]));

alter table milestones add constraint milestones_phase_type_check CHECK (phase_type = ANY (ARRAY['internal'::text, 'client_review'::text, 'buffer'::text, 'delivery'::text]));

alter table milestones add constraint milestones_status_check CHECK (status = ANY (ARRAY['upcoming'::text, 'in_progress'::text, 'completed'::text, 'overdue'::text, 'at_risk'::text]));

alter table model_catalog add constraint model_catalog_status_check CHECK (status = ANY (ARRAY['active'::text, 'beta'::text, 'deprecated'::text, 'coming_soon'::text, 'evaluating'::text]));

alter table model_catalog add constraint model_catalog_type_check CHECK (type = ANY (ARRAY['image'::text, 'video'::text, 'audio'::text, '3d'::text, 'music'::text]));

alter table permission_requests add constraint permission_requests_status_check CHECK (status = ANY (ARRAY['pending'::text, 'granted_project'::text, 'granted_all'::text, 'denied'::text, 'responded_directly'::text]));

alter table pilot_evidence add constraint pilot_evidence_category_check CHECK (category = ANY (ARRAY['measurement'::text, 'observation'::text, 'judgment'::text, 'assumption'::text, 'unknown'::text, 'risk'::text, 'decision'::text]));

alter table pilot_evidence add constraint pilot_evidence_measurement_has_value CHECK (category <> 'measurement'::text OR value_numeric IS NOT NULL OR value_text IS NOT NULL AND length(btrim(value_text)) > 0);

alter table pilot_evidence add constraint pilot_evidence_measurement_metric_key CHECK (category <> 'measurement'::text OR metric_key IS NOT NULL);

alter table pilot_evidence add constraint pilot_evidence_metric_key_scope CHECK (category = 'measurement'::text OR metric_key IS NULL);

alter table pilot_generations add constraint pilot_generations_acceptance_check CHECK (acceptance = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text]));

alter table pilot_generations add constraint pilot_generations_accepted_requires_actor CHECK (acceptance <> 'accepted'::text OR accepted_by IS NOT NULL);

alter table pilot_material_maps add constraint pilot_material_maps_map_type_check CHECK (map_type = ANY (ARRAY['albedo'::text, 'roughness'::text, 'normal'::text, 'height'::text, 'displacement'::text, 'metalness'::text, 'ao'::text, 'opacity'::text, 'other'::text]));

alter table pilot_material_maps add constraint pilot_material_maps_purpose_nonempty CHECK (length(btrim(purpose)) > 0);

alter table pilot_references add constraint pilot_references_link_requires_url CHECK ((ref_type <> ALL (ARRAY['pinterest'::text, 'figma_moodboard'::text])) OR url IS NOT NULL AND length(btrim(url)) > 0);

alter table pilot_references add constraint pilot_references_ref_type_check CHECK (ref_type = ANY (ARRAY['pinterest'::text, 'figma_moodboard'::text, 'styleframe_direction'::text, 'other'::text]));

alter table pilot_validations add constraint pilot_validations_evidence_nonempty CHECK (length(btrim(evidence_ref)) > 0);

alter table pilot_validations add constraint pilot_validations_tool_check CHECK (tool = ANY (ARRAY['cinema4d'::text, 'redshift'::text]));

alter table pilots add constraint pilots_finalized_requires_recommendation CHECK (status <> 'finalized'::text OR recommendation IS NOT NULL AND recommendation_by IS NOT NULL);

alter table pilots add constraint pilots_pilot_type_check CHECK (pilot_type = 'visual_development'::text);

alter table pilots add constraint pilots_recommendation_check CHECK (recommendation IS NULL OR (recommendation = ANY (ARRAY['adopt'::text, 'revise'::text, 'repeat'::text, 'discontinue'::text])));

alter table pilots add constraint pilots_status_check CHECK (status = ANY (ARRAY['active'::text, 'finalized'::text, 'abandoned'::text]));

alter table pitch_log add constraint pitch_log_outcome_check CHECK (outcome = ANY (ARRAY['won'::text, 'lost'::text, 'pending'::text, 'no_decision'::text]));

alter table plaud_token_state add constraint plaud_token_state_id_check CHECK (id = 'singleton'::text);

alter table project_control_bindings add constraint project_control_bindings_creation_state_check CHECK (creation_state = ANY (ARRAY['pending_sheet'::text, 'sheet_bound'::text, 'pending_canvas'::text, 'connected'::text]));

alter table project_control_bindings add constraint project_control_bindings_sync_status_check CHECK (sync_status = ANY (ARRAY['pending'::text, 'synced'::text, 'error'::text, 'orphaned'::text]));

alter table project_control_canvases add constraint project_control_canvases_status_check CHECK (sync_status = ANY (ARRAY['pending'::text, 'synced'::text, 'error'::text, 'orphaned'::text]));

alter table project_control_canvases add constraint project_control_canvases_type_check CHECK (canvas_type = ANY (ARRAY['overview'::text, 'reference'::text, 'schedule'::text]));

alter table project_creation_requests add constraint project_creation_requests_decision_check CHECK (decision IS NULL OR (decision = ANY (ARRAY['create'::text, 'duplicate'::text, 'replace'::text])));

alter table project_creation_requests add constraint project_creation_requests_status_check CHECK (status = ANY (ARRAY['pending'::text, 'awaiting_decision'::text, 'provisioning'::text, 'completed'::text, 'error'::text, 'cancelled'::text]));

alter table project_documents add constraint project_documents_visibility_tier_check CHECK (visibility_tier = ANY (ARRAY['founder'::text, 'producer'::text, 'team'::text, 'freelancer'::text]));

alter table project_provisioning_steps add constraint project_provisioning_steps_status_check CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text, 'terminal'::text]));

alter table project_share_events add constraint project_share_events_confidence_check CHECK (match_confidence IS NULL OR (match_confidence = ANY (ARRAY['exact'::text, 'probable'::text, 'uncertain'::text])));

alter table project_share_events add constraint project_share_events_status_check CHECK (status = ANY (ARRAY['pending'::text, 'applying'::text, 'applied'::text, 'dismissed'::text, 'superseded'::text]));

alter table project_update_requests add constraint project_update_requests_decision_check CHECK (decision IS NULL OR (decision = ANY (ARRAY['apply'::text, 'cancel'::text])));

alter table project_update_requests add constraint project_update_requests_status_check CHECK (status = ANY (ARRAY['pending'::text, 'awaiting_confirm'::text, 'applying'::text, 'completed'::text, 'error'::text, 'needs_attention'::text, 'cancelled'::text]));

alter table project_update_steps add constraint project_update_steps_status_check CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text, 'terminal'::text]));

alter table projects add constraint projects_status_check CHECK (status = ANY (ARRAY['scoping'::text, 'provisioning'::text, 'active'::text, 'on_hold'::text, 'wrapping'::text, 'completed'::text, 'archived'::text]));

alter table render_jobs add constraint render_jobs_job_type_check CHECK (job_type = ANY (ARRAY['transcode'::text, 'ae_render'::text, 'ae_inspect'::text, 'ae_chunk'::text, 'ae_stitch'::text]));

alter table render_jobs add constraint render_jobs_render_backend_check CHECK (render_backend = ANY (ARRAY['kit-worker'::text, 'deadline'::text]));

alter table render_jobs add constraint render_jobs_status_check CHECK (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'processing'::text, 'complete'::text, 'failed'::text, 'cancelled'::text]));

alter table render_workers add constraint render_workers_role_check CHECK (role = ANY (ARRAY['primary'::text, 'fallback'::text]));

alter table render_workers add constraint render_workers_status_check CHECK (status = ANY (ARRAY['online'::text, 'offline'::text, 'busy'::text, 'opted_out'::text]));

alter table scope_events add constraint scope_events_classification_check CHECK (classification = ANY (ARRAY['in_scope'::text, 'scope_expansion'::text, 'gray_area'::text]));

alter table scope_events add constraint scope_events_resolution_check CHECK (resolution = ANY (ARRAY['absorbed'::text, 'change_order'::text, 'declined'::text, 'pending'::text]));

alter table staff add constraint staff_employment_type_check CHECK (employment_type = ANY (ARRAY['employee'::text, 'freelancer'::text, 'contractor'::text]));

alter table staff add constraint staff_role_check CHECK (role = ANY (ARRAY['creative'::text, 'producer'::text, 'cd'::text, 'admin'::text, 'bizdev'::text]));

alter table staff_time_off add constraint staff_time_off_kind_valid CHECK (kind = ANY (ARRAY['pto'::text, 'sick'::text, 'leave'::text, 'other'::text]));

alter table staff_time_off add constraint staff_time_off_range_valid CHECK (end_date >= start_date);

alter table storyboard_jobs add constraint storyboard_jobs_status_check CHECK (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'complete'::text, 'failed'::text]));

alter table storyboard_panels add constraint storyboard_panels_status_check CHECK (status = ANY (ARRAY['pending'::text, 'generating'::text, 'completed'::text, 'approved'::text, 'rejected'::text, 'failed'::text]));

alter table system_health add constraint system_health_status_check CHECK (status = ANY (ARRAY['up'::text, 'down'::text]));

alter table team_members add constraint team_members_permission_tier_check CHECK (permission_tier = ANY (ARRAY['founder'::text, 'producer'::text, 'artist'::text, 'freelancer'::text]));

alter table team_members add constraint team_members_role_check CHECK (role = ANY (ARRAY['creative_director'::text, 'producer'::text, 'animator'::text, 'designer'::text, 'editor'::text, 'compositor'::text, 'developer'::text, 'admin'::text, 'other'::text]));

alter table time_entries add constraint time_entries_entry_source_check CHECK (entry_source = ANY (ARRAY['integration'::text, 'slack_checkin'::text, 'manual'::text, 'vendor'::text]));

alter table transcription_routing add constraint transcription_routing_rule_type_check CHECK (rule_type = ANY (ARRAY['calendar'::text, 'title_pattern'::text, 'participant'::text]));

alter table transcription_routing add constraint transcription_routing_target_stream_check CHECK (target_stream = ANY (ARRAY['founder'::text, 'team'::text]));

alter table workspaces add constraint workspaces_plan_check CHECK (plan = ANY (ARRAY['trial'::text, 'starter'::text, 'pro'::text, 'enterprise'::text]));

alter table action_breakdowns add constraint action_breakdowns_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES team_members(id);

alter table action_breakdowns add constraint action_breakdowns_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table action_breakdowns add constraint action_breakdowns_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table agent_runs add constraint agent_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table archive_activity add constraint archive_activity_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table archive_activity add constraint archive_activity_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table archive_job_steps add constraint archive_job_steps_job_id_fkey FOREIGN KEY (job_id) REFERENCES archive_jobs(id) ON DELETE CASCADE;

alter table archive_jobs add constraint archive_jobs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table archive_jobs add constraint archive_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table artifacts add constraint artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table autonomy_settings add constraint autonomy_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table autonomy_settings add constraint autonomy_settings_set_by_fkey FOREIGN KEY (set_by) REFERENCES team_members(id);

alter table autonomy_settings add constraint autonomy_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table behance_draft_jobs add constraint behance_draft_jobs_archive_job_id_fkey FOREIGN KEY (archive_job_id) REFERENCES archive_jobs(id) ON DELETE CASCADE;

alter table behance_draft_jobs add constraint behance_draft_jobs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table behance_draft_jobs add constraint behance_draft_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table behance_workers add constraint behance_workers_current_job_id_fkey FOREIGN KEY (current_job_id) REFERENCES behance_draft_jobs(id) ON DELETE SET NULL;

alter table bible_versions add constraint bible_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table brain_revisions add constraint brain_revisions_brain_id_fkey FOREIGN KEY (brain_id) REFERENCES brains(id) ON DELETE CASCADE;

alter table brain_scavenger_candidates add constraint brain_scavenger_candidates_brain_id_fkey FOREIGN KEY (brain_id) REFERENCES brains(id) ON DELETE CASCADE;

alter table brain_scavenger_candidates add constraint brain_scavenger_candidates_source_doc_id_fkey FOREIGN KEY (source_doc_id) REFERENCES project_documents(id) ON DELETE SET NULL;

alter table brains add constraint brains_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

alter table call_classifications add constraint call_classifications_document_id_fkey FOREIGN KEY (document_id) REFERENCES project_documents(id);

alter table call_classifications add constraint call_classifications_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table call_classifications add constraint call_classifications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table call_transcripts add constraint call_transcripts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

alter table call_transcripts add constraint call_transcripts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table character_sheets add constraint character_sheets_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table client_profiles add constraint client_profiles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table daily_hours_checkins add constraint daily_hours_checkins_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE;

alter table daily_hours_reminders add constraint daily_hours_reminders_check_in_id_fkey FOREIGN KEY (check_in_id) REFERENCES daily_hours_checkins(id) ON DELETE SET NULL;

alter table daily_hours_reminders add constraint daily_hours_reminders_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE;

alter table daily_task_cards add constraint daily_task_cards_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES team_members(id);

alter table daily_task_cards add constraint daily_task_cards_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES team_members(id);

alter table daily_task_cards add constraint daily_task_cards_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table deliverables add constraint deliverables_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table deliverables add constraint deliverables_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table delivery_specs add constraint delivery_specs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table edit_decisions add constraint edit_decisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table elevenlabs_studio_jobs add constraint elevenlabs_studio_jobs_storyboard_job_id_fkey FOREIGN KEY (storyboard_job_id) REFERENCES storyboard_jobs(id) ON DELETE CASCADE;

alter table elevenlabs_studio_jobs add constraint elevenlabs_studio_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

alter table elevenlabs_workers add constraint elevenlabs_workers_current_job_id_fkey FOREIGN KEY (current_job_id) REFERENCES elevenlabs_studio_jobs(id) ON DELETE SET NULL;

alter table farm_status add constraint farm_status_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table feedback_items add constraint feedback_items_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES team_members(id);

alter table feedback_items add constraint feedback_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table feedback_items add constraint feedback_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table financial_entries add constraint financial_entries_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table financial_entries add constraint financial_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table founder_content_access add constraint founder_content_access_accessed_by_fkey FOREIGN KEY (accessed_by) REFERENCES team_members(id);

alter table founder_content_access add constraint founder_content_access_document_id_fkey FOREIGN KEY (document_id) REFERENCES project_documents(id);

alter table founder_content_access add constraint founder_content_access_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table freelancer_onboardings add constraint freelancer_onboardings_artist_staff_id_fkey FOREIGN KEY (artist_staff_id) REFERENCES staff(id) ON DELETE SET NULL;

alter table freelancer_onboardings add constraint freelancer_onboardings_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

alter table gates add constraint gates_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table generated_documents add constraint generated_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES team_members(id);

alter table generated_documents add constraint generated_documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table generated_documents add constraint generated_documents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table generation_tasks add constraint generation_tasks_parent_task_id_fkey FOREIGN KEY (parent_task_id) REFERENCES generation_tasks(id);

alter table generation_tasks add constraint generation_tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table harvest_user_map add constraint harvest_user_map_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table hours_missing_alerts add constraint hours_missing_alerts_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE;

alter table intake_messages add constraint intake_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES intake_sessions(id) ON DELETE CASCADE;

alter table intake_sessions add constraint intake_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table integrations add constraint integrations_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES team_members(id);

alter table integrations add constraint integrations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table kit_actions add constraint kit_actions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES team_members(id);

alter table kit_actions add constraint kit_actions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table kit_actions add constraint kit_actions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table meeting_briefing_deliveries add constraint meeting_briefing_deliveries_internal_recipient_id_fkey FOREIGN KEY (internal_recipient_id) REFERENCES staff(id) ON DELETE CASCADE;

alter table meeting_briefing_deliveries add constraint meeting_briefing_deliveries_meeting_briefing_id_fkey FOREIGN KEY (meeting_briefing_id) REFERENCES meeting_briefings(id) ON DELETE CASCADE;

alter table meeting_briefings add constraint meeting_briefings_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

alter table milestones add constraint milestones_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES team_members(id);

alter table milestones add constraint milestones_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table milestones add constraint milestones_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table model_scores add constraint model_scores_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;

alter table permission_requests add constraint permission_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table permission_requests add constraint permission_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES team_members(id);

alter table permission_requests add constraint permission_requests_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES team_members(id);

alter table permission_requests add constraint permission_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table pilot_evidence add constraint pilot_evidence_pilot_id_fkey FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE;

alter table pilot_generations add constraint pilot_generations_pilot_id_fkey FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE;

alter table pilot_material_maps add constraint pilot_material_maps_pilot_id_fkey FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE;

alter table pilot_references add constraint pilot_references_pilot_id_fkey FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE;

alter table pilot_validations add constraint pilot_validations_pilot_id_fkey FOREIGN KEY (pilot_id) REFERENCES pilots(id) ON DELETE CASCADE;

alter table pilots add constraint pilots_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table pilots add constraint pilots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table pitch_log add constraint pitch_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table project_access add constraint project_access_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table project_access add constraint project_access_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE;

alter table project_access add constraint project_access_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table project_control_bindings add constraint project_control_bindings_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table project_control_canvases add constraint project_control_canvases_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table project_creation_requests add constraint project_creation_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

alter table project_creation_requests add constraint project_creation_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table project_documents add constraint project_documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table project_documents add constraint project_documents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table project_provisioning_steps add constraint project_provisioning_steps_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table project_settings add constraint project_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table project_share_events add constraint project_share_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table project_update_requests add constraint project_update_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table project_update_requests add constraint project_update_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table project_update_steps add constraint project_update_steps_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table project_update_steps add constraint project_update_steps_update_request_id_fkey FOREIGN KEY (update_request_id) REFERENCES project_update_requests(id) ON DELETE CASCADE;

alter table projects add constraint projects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table render_jobs add constraint render_jobs_delivery_profile_id_fkey FOREIGN KEY (delivery_profile_id) REFERENCES delivery_profiles(id) ON DELETE SET NULL;

alter table render_jobs add constraint render_jobs_parent_job_id_fkey FOREIGN KEY (parent_job_id) REFERENCES render_jobs(id) ON DELETE CASCADE;

alter table render_jobs add constraint render_jobs_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES delivery_profiles(id) ON DELETE SET NULL;

alter table render_workers add constraint render_workers_current_job_id_fkey FOREIGN KEY (current_job_id) REFERENCES render_jobs(id) ON DELETE SET NULL;

alter table review_extractions add constraint review_extractions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table scope_events add constraint scope_events_feedback_item_id_fkey FOREIGN KEY (feedback_item_id) REFERENCES feedback_items(id);

alter table scope_events add constraint scope_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table scope_events add constraint scope_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table sentiment_snapshots add constraint sentiment_snapshots_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table sentiment_snapshots add constraint sentiment_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table staff_time_off add constraint staff_time_off_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE;

alter table storyboard_jobs add constraint storyboard_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

alter table storyboard_panels add constraint storyboard_panels_generation_task_id_fkey FOREIGN KEY (generation_task_id) REFERENCES generation_tasks(id);

alter table storyboard_panels add constraint storyboard_panels_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table team_members add constraint team_members_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id);

alter table team_members add constraint team_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table templates add constraint templates_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table time_entries add constraint time_entries_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

alter table time_entries add constraint time_entries_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES team_members(id);

alter table time_entries add constraint time_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table transcription_routing add constraint transcription_routing_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table workback_schedules add constraint workback_schedules_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

alter table workback_schedules add constraint workback_schedules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

alter table workspace_config add constraint workspace_config_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- indexes
CREATE INDEX accessibility_jobs_active_idx ON public.accessibility_jobs USING btree (created_at DESC) WHERE (status <> ALL (ARRAY['complete'::text, 'failed'::text]));

CREATE UNIQUE INDEX accessibility_jobs_dropbox_id_uq ON public.accessibility_jobs USING btree (source_dropbox_id);

CREATE INDEX accessibility_jobs_status_created_idx ON public.accessibility_jobs USING btree (status, created_at DESC);

CREATE INDEX action_breakdowns_approved_by_idx ON public.action_breakdowns USING btree (approved_by);

CREATE INDEX idx_action_breakdowns_project ON public.action_breakdowns USING btree (project_id);

CREATE INDEX idx_action_breakdowns_workspace ON public.action_breakdowns USING btree (workspace_id);

CREATE INDEX idx_agent_runs_status ON public.agent_runs USING btree (workspace_id, status);

CREATE INDEX idx_agent_runs_workspace ON public.agent_runs USING btree (workspace_id);

CREATE INDEX archive_activity_project_id_idx ON public.archive_activity USING btree (project_id);

CREATE INDEX idx_archive_workspace ON public.archive_activity USING btree (workspace_id);

CREATE INDEX archive_job_steps_job_idx ON public.archive_job_steps USING btree (job_id, created_at);

CREATE INDEX archive_jobs_project_idx ON public.archive_jobs USING btree (project_id, created_at DESC);

CREATE INDEX archive_jobs_recovery_idx ON public.archive_jobs USING btree (status, updated_at) WHERE (status = ANY (ARRAY['queued'::text, 'validating'::text, 'preparing_media'::text, 'uploading_vimeo'::text, 'creating_wordpress'::text, 'creating_buffer'::text, 'preparing_behance'::text]));

CREATE INDEX archive_jobs_workspace_idx ON public.archive_jobs USING btree (workspace_id, created_at DESC);

CREATE INDEX idx_artifacts_project_id ON public.artifacts USING btree (project_id);

CREATE INDEX autonomy_settings_project_id_idx ON public.autonomy_settings USING btree (project_id);

CREATE INDEX autonomy_settings_set_by_idx ON public.autonomy_settings USING btree (set_by);

CREATE INDEX idx_autonomy_workspace ON public.autonomy_settings USING btree (workspace_id);

CREATE INDEX behance_draft_jobs_claim_idx ON public.behance_draft_jobs USING btree (status, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'retryable'::text]));

CREATE INDEX behance_draft_jobs_project_idx ON public.behance_draft_jobs USING btree (project_id, created_at DESC);

CREATE INDEX behance_draft_jobs_recovery_idx ON public.behance_draft_jobs USING btree (status, heartbeat_at) WHERE (status = ANY (ARRAY['claimed'::text, 'opening_editor'::text, 'uploading_media'::text, 'filling_details'::text, 'saving_draft'::text]));

CREATE INDEX behance_draft_jobs_sync_idx ON public.behance_draft_jobs USING btree (updated_at) WHERE (status = ANY (ARRAY['awaiting_review'::text, 'failed'::text]));

CREATE INDEX behance_draft_jobs_workspace_idx ON public.behance_draft_jobs USING btree (workspace_id, created_at DESC);

CREATE INDEX behance_workers_current_job_idx ON public.behance_workers USING btree (current_job_id) WHERE (current_job_id IS NOT NULL);

CREATE INDEX idx_bible_versions_project_id ON public.bible_versions USING btree (project_id);

CREATE INDEX brain_revisions_brain_idx ON public.brain_revisions USING btree (brain_id, revision DESC);

CREATE INDEX brain_scavenger_brain_idx ON public.brain_scavenger_candidates USING btree (brain_id);

CREATE INDEX brain_scavenger_candidates_source_doc_id_idx ON public.brain_scavenger_candidates USING btree (source_doc_id);

CREATE INDEX brain_scavenger_pending_idx ON public.brain_scavenger_candidates USING btree (brain_id, status, created_at DESC) WHERE (status = 'pending'::text);

CREATE INDEX brains_project_idx ON public.brains USING btree (project_id) WHERE (project_id IS NOT NULL);

CREATE INDEX brains_visibility_idx ON public.brains USING btree (visibility);

CREATE UNIQUE INDEX brains_workspace_channel_uq ON public.brains USING btree (workspace_id, slack_channel) WHERE (slack_channel IS NOT NULL);

CREATE INDEX brains_workspace_idx ON public.brains USING btree (workspace_id);

CREATE INDEX call_classifications_document_id_idx ON public.call_classifications USING btree (document_id);

CREATE INDEX idx_call_classifications_project ON public.call_classifications USING btree (project_id);

CREATE INDEX idx_call_classifications_workspace ON public.call_classifications USING btree (workspace_id);

CREATE INDEX call_transcripts_project_idx ON public.call_transcripts USING btree (project_id);

CREATE INDEX call_transcripts_source_ingest_status_idx ON public.call_transcripts USING btree (source, ingest_status);

CREATE INDEX call_transcripts_workspace_idx ON public.call_transcripts USING btree (workspace_id);

CREATE INDEX idx_character_sheets_project_id ON public.character_sheets USING btree (project_id);

CREATE INDEX idx_character_sheets_status ON public.character_sheets USING btree (status);

CREATE INDEX client_profiles_client_name_idx ON public.client_profiles USING btree (client_name);

CREATE UNIQUE INDEX client_profiles_harvest_client_id_key ON public.client_profiles USING btree (harvest_client_id) WHERE (harvest_client_id IS NOT NULL);

CREATE INDEX idx_client_profiles_workspace ON public.client_profiles USING btree (workspace_id);

CREATE INDEX conversation_state_updated_idx ON public.conversation_state USING btree (updated_at);

CREATE INDEX daily_hours_checkins_staff_id_idx ON public.daily_hours_checkins USING btree (staff_id);

CREATE INDEX idx_daily_hours_checkins_origin_date ON public.daily_hours_checkins USING btree (origin, check_in_date);

CREATE INDEX idx_daily_hours_checkins_user_status_date ON public.daily_hours_checkins USING btree (slack_user_id, status, check_in_date);

CREATE INDEX daily_hours_reminders_check_in_id_idx ON public.daily_hours_reminders USING btree (check_in_id);

CREATE INDEX daily_hours_reminders_lookup_idx ON public.daily_hours_reminders USING btree (slack_user_id, local_date);

CREATE INDEX daily_hours_reminders_reclaim_idx ON public.daily_hours_reminders USING btree (status, lease_expires_at);

CREATE INDEX daily_task_cards_approved_by_idx ON public.daily_task_cards USING btree (approved_by);

CREATE INDEX idx_task_cards_date ON public.daily_task_cards USING btree (workspace_id, card_date);

CREATE INDEX idx_task_cards_member ON public.daily_task_cards USING btree (team_member_id);

CREATE INDEX idx_task_cards_status ON public.daily_task_cards USING btree (workspace_id, status);

CREATE INDEX idx_task_cards_workspace ON public.daily_task_cards USING btree (workspace_id);

CREATE INDEX idx_deliverables_project ON public.deliverables USING btree (project_id);

CREATE INDEX idx_deliverables_workspace ON public.deliverables USING btree (workspace_id);

CREATE INDEX delivery_profiles_active_idx ON public.delivery_profiles USING btree (archived) WHERE (archived = false);

CREATE INDEX delivery_profiles_name_idx ON public.delivery_profiles USING btree (name);

CREATE INDEX delivery_spec_intake_open_idx ON public.delivery_spec_intake USING btree (channel_id, thread_ts) WHERE (status = 'open'::text);

CREATE INDEX idx_delivery_specs_project_id ON public.delivery_specs USING btree (project_id);

CREATE INDEX delivery_specs_scan_frontier_order_idx ON public.delivery_specs_scan_frontier USING btree (created_at, path);

CREATE INDEX dropbox_event_inbox_claim_idx ON public.dropbox_event_inbox USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'retryable'::text, 'processing'::text]));

CREATE INDEX idx_edit_decisions_order ON public.edit_decisions USING btree (project_id, order_index);

CREATE INDEX idx_edit_decisions_project_id ON public.edit_decisions USING btree (project_id);

CREATE INDEX elevenlabs_studio_jobs_queue_idx ON public.elevenlabs_studio_jobs USING btree (status, created_at);

CREATE INDEX elevenlabs_studio_jobs_workspace_idx ON public.elevenlabs_studio_jobs USING btree (workspace_id);

CREATE INDEX elevenlabs_workers_current_job_idx ON public.elevenlabs_workers USING btree (current_job_id);

CREATE INDEX idx_farm_status_workspace ON public.farm_status USING btree (workspace_id);

CREATE INDEX feedback_items_assigned_to_idx ON public.feedback_items USING btree (assigned_to);

CREATE INDEX idx_feedback_project ON public.feedback_items USING btree (project_id);

CREATE INDEX idx_feedback_status ON public.feedback_items USING btree (workspace_id, status);

CREATE INDEX idx_feedback_workspace ON public.feedback_items USING btree (workspace_id);

CREATE INDEX idx_financial_project ON public.financial_entries USING btree (project_id);

CREATE INDEX idx_financial_workspace ON public.financial_entries USING btree (workspace_id);

CREATE INDEX founder_content_access_document_id_idx ON public.founder_content_access USING btree (document_id);

CREATE INDEX idx_founder_access_member ON public.founder_content_access USING btree (accessed_by);

CREATE INDEX idx_founder_access_workspace ON public.founder_content_access USING btree (workspace_id);

CREATE INDEX freelancer_onboardings_artist_staff_id_idx ON public.freelancer_onboardings USING btree (artist_staff_id);

CREATE INDEX idx_freelancer_onboardings_email ON public.freelancer_onboardings USING btree (artist_email);

CREATE INDEX idx_freelancer_onboardings_project ON public.freelancer_onboardings USING btree (project_id);

CREATE INDEX idx_gates_project_id ON public.gates USING btree (project_id);

CREATE INDEX generated_documents_created_by_idx ON public.generated_documents USING btree (created_by);

CREATE INDEX idx_gen_docs_project ON public.generated_documents USING btree (project_id);

CREATE INDEX idx_gen_docs_workspace ON public.generated_documents USING btree (workspace_id);

CREATE INDEX idx_generation_tasks_parent_task_id ON public.generation_tasks USING btree (parent_task_id);

CREATE INDEX idx_generation_tasks_phase ON public.generation_tasks USING btree (phase);

CREATE INDEX idx_generation_tasks_project_id ON public.generation_tasks USING btree (project_id);

CREATE INDEX idx_generation_tasks_status ON public.generation_tasks USING btree (status);

CREATE INDEX idx_harvest_user_map_slack ON public.harvest_user_map USING btree (workspace_id, slack_user_id);

CREATE INDEX hours_missing_alerts_staff_idx ON public.hours_missing_alerts USING btree (staff_id, created_at DESC);

CREATE INDEX idx_intake_messages_session_id ON public.intake_messages USING btree (session_id);

CREATE INDEX idx_intake_sessions_project_id ON public.intake_sessions USING btree (project_id);

CREATE INDEX idx_integrations_workspace ON public.integrations USING btree (workspace_id);

CREATE INDEX integrations_connected_by_idx ON public.integrations USING btree (connected_by);

CREATE INDEX idx_kit_actions_project ON public.kit_actions USING btree (project_id);

CREATE INDEX idx_kit_actions_status ON public.kit_actions USING btree (workspace_id, status);

CREATE INDEX idx_kit_actions_workspace ON public.kit_actions USING btree (workspace_id);

CREATE INDEX kit_actions_approved_by_idx ON public.kit_actions USING btree (approved_by);

CREATE INDEX meeting_briefing_deliveries_reclaim_idx ON public.meeting_briefing_deliveries USING btree (status, lease_expires_at);

CREATE UNIQUE INDEX meeting_briefings_event_id_key ON public.meeting_briefings USING btree (event_id);

CREATE INDEX meeting_briefings_project_id_idx ON public.meeting_briefings USING btree (project_id);

CREATE INDEX meeting_briefings_status_start_idx ON public.meeting_briefings USING btree (status, meeting_start_time);

CREATE INDEX idx_milestones_project ON public.milestones USING btree (project_id);

CREATE INDEX idx_milestones_status ON public.milestones USING btree (workspace_id, status);

CREATE INDEX idx_milestones_workspace ON public.milestones USING btree (workspace_id);

CREATE INDEX milestones_assigned_to_idx ON public.milestones USING btree (assigned_to);

CREATE INDEX idx_model_catalog_provider ON public.model_catalog USING btree (provider);

CREATE INDEX idx_model_catalog_status ON public.model_catalog USING btree (status);

CREATE INDEX idx_model_catalog_type ON public.model_catalog USING btree (type);

CREATE INDEX idx_model_research_log_run_at ON public.model_research_log USING btree (run_at);

CREATE INDEX idx_model_scores_agent_run_id ON public.model_scores USING btree (agent_run_id);

CREATE INDEX idx_permission_requests_requester ON public.permission_requests USING btree (requester_id);

CREATE INDEX idx_permission_requests_status ON public.permission_requests USING btree (workspace_id, status);

CREATE INDEX idx_permission_requests_workspace ON public.permission_requests USING btree (workspace_id);

CREATE INDEX permission_requests_project_id_idx ON public.permission_requests USING btree (project_id);

CREATE INDEX permission_requests_responded_by_idx ON public.permission_requests USING btree (responded_by);

CREATE INDEX pilot_evidence_metric_idx ON public.pilot_evidence USING btree (pilot_id, metric_key) WHERE (metric_key IS NOT NULL);

CREATE INDEX pilot_evidence_pilot_idx ON public.pilot_evidence USING btree (pilot_id, category);

CREATE INDEX pilot_generations_pilot_idx ON public.pilot_generations USING btree (pilot_id, acceptance);

CREATE INDEX pilot_material_maps_pilot_idx ON public.pilot_material_maps USING btree (pilot_id, package_name);

CREATE UNIQUE INDEX pilot_references_one_figma_moodboard ON public.pilot_references USING btree (pilot_id) WHERE (ref_type = 'figma_moodboard'::text);

CREATE INDEX pilot_references_pilot_idx ON public.pilot_references USING btree (pilot_id, ref_type);

CREATE INDEX pilot_validations_pilot_idx ON public.pilot_validations USING btree (pilot_id, tool);

CREATE UNIQUE INDEX pilots_one_active_per_project_type ON public.pilots USING btree (project_id, pilot_type) WHERE (status = 'active'::text);

CREATE INDEX pilots_project_idx ON public.pilots USING btree (project_id);

CREATE INDEX idx_pitch_log_workspace ON public.pitch_log USING btree (workspace_id);

CREATE INDEX idx_project_access_member ON public.project_access USING btree (team_member_id);

CREATE INDEX idx_project_access_project ON public.project_access USING btree (project_id);

CREATE INDEX idx_project_access_workspace ON public.project_access USING btree (workspace_id);

CREATE INDEX project_control_bindings_creation_idx ON public.project_control_bindings USING btree (creation_state);

CREATE INDEX project_control_bindings_recovery_idx ON public.project_control_bindings USING btree (spreadsheet_id, creation_state);

CREATE INDEX project_control_bindings_sync_idx ON public.project_control_bindings USING btree (sync_status, last_synced_at);

CREATE INDEX project_control_canvases_sync_idx ON public.project_control_canvases USING btree (sync_status, last_synced_at);

CREATE INDEX project_creation_requests_status_idx ON public.project_creation_requests USING btree (status, lease_expires_at);

CREATE INDEX idx_project_docs_project ON public.project_documents USING btree (project_id);

CREATE INDEX idx_project_docs_workspace ON public.project_documents USING btree (workspace_id);

CREATE INDEX idx_project_documents_visibility ON public.project_documents USING btree (workspace_id, project_id, visibility_tier);

CREATE INDEX project_provisioning_steps_project_idx ON public.project_provisioning_steps USING btree (project_id);

CREATE INDEX project_provisioning_steps_recovery_idx ON public.project_provisioning_steps USING btree (status, lease_expires_at);

CREATE INDEX project_share_events_pending_idx ON public.project_share_events USING btree (status, created_at) WHERE (status = 'pending'::text);

CREATE INDEX project_update_requests_project_idx ON public.project_update_requests USING btree (project_id);

CREATE INDEX project_update_requests_status_idx ON public.project_update_requests USING btree (status, lease_expires_at);

CREATE INDEX project_update_steps_project_idx ON public.project_update_steps USING btree (project_id);

CREATE INDEX project_update_steps_recovery_idx ON public.project_update_steps USING btree (status, lease_expires_at);

CREATE INDEX project_update_steps_request_idx ON public.project_update_steps USING btree (update_request_id);

CREATE INDEX idx_projects_client ON public.projects USING btree (workspace_id, client);

CREATE INDEX idx_projects_harvest_project_id ON public.projects USING btree (harvest_project_id) WHERE (harvest_project_id IS NOT NULL);

CREATE INDEX idx_projects_slack_channel_id ON public.projects USING btree (slack_channel_id) WHERE (slack_channel_id IS NOT NULL);

CREATE INDEX idx_projects_status ON public.projects USING btree (workspace_id, status);

CREATE INDEX idx_projects_workspace ON public.projects USING btree (workspace_id);

CREATE UNIQUE INDEX ux_projects_creation_request_id ON public.projects USING btree (creation_request_id) WHERE (creation_request_id IS NOT NULL);

CREATE INDEX render_jobs_parent_idx ON public.render_jobs USING btree (parent_job_id) WHERE (parent_job_id IS NOT NULL);

CREATE INDEX render_jobs_pending_idx ON public.render_jobs USING btree (status, created_at) WHERE (status = 'pending'::text);

CREATE INDEX render_jobs_pending_type_idx ON public.render_jobs USING btree (job_type, status, created_at) WHERE (status = 'pending'::text);

CREATE INDEX render_jobs_profile_id_idx ON public.render_jobs USING btree (profile_id);

CREATE INDEX render_jobs_status_idx ON public.render_jobs USING btree (status);

CREATE INDEX render_jobs_worker_idx ON public.render_jobs USING btree (claimed_by) WHERE (status = ANY (ARRAY['claimed'::text, 'processing'::text]));

CREATE INDEX render_workers_ae_idx ON public.render_workers USING btree (ae_capable) WHERE (ae_capable = true);

CREATE INDEX render_workers_current_job_id_idx ON public.render_workers USING btree (current_job_id);

CREATE INDEX render_workers_priority_idx ON public.render_workers USING btree (priority) WHERE (status = 'online'::text);

CREATE INDEX render_workers_status_idx ON public.render_workers USING btree (status);

CREATE INDEX idx_review_extractions_asset ON public.review_extractions USING btree (asset_id);

CREATE INDEX idx_review_extractions_workspace ON public.review_extractions USING btree (workspace_id);

CREATE INDEX idx_scope_events_project ON public.scope_events USING btree (project_id);

CREATE INDEX idx_scope_events_workspace ON public.scope_events USING btree (workspace_id);

CREATE INDEX scope_events_feedback_item_id_idx ON public.scope_events USING btree (feedback_item_id);

CREATE INDEX seen_dropbox_files_pending_idx ON public.seen_dropbox_files USING btree (stable_check_count) WHERE (notified_at IS NULL);

CREATE INDEX idx_sentiment_project ON public.sentiment_snapshots USING btree (project_id);

CREATE INDEX idx_sentiment_workspace ON public.sentiment_snapshots USING btree (workspace_id);

CREATE INDEX idx_staff_employment_active ON public.staff USING btree (employment_type, is_active);

CREATE INDEX idx_staff_harvest_user_id ON public.staff USING btree (harvest_user_id);

CREATE INDEX idx_staff_role_active ON public.staff USING btree (role, is_active);

CREATE INDEX staff_time_off_staff_range_idx ON public.staff_time_off USING btree (staff_id, start_date, end_date);

CREATE INDEX idx_storyboard_jobs_status ON public.storyboard_jobs USING btree (status, created_at DESC);

CREATE INDEX idx_storyboard_jobs_user ON public.storyboard_jobs USING btree (user_id, created_at DESC);

CREATE INDEX storyboard_jobs_workspace_id_idx ON public.storyboard_jobs USING btree (workspace_id);

CREATE INDEX idx_storyboard_panels_project_id ON public.storyboard_panels USING btree (project_id);

CREATE INDEX idx_storyboard_panels_scene ON public.storyboard_panels USING btree (project_id, scene_number);

CREATE INDEX idx_team_members_auth_user ON public.team_members USING btree (auth_user_id);

CREATE INDEX idx_team_members_slack_user_id ON public.team_members USING btree (workspace_id, slack_user_id);

CREATE INDEX idx_team_members_workspace ON public.team_members USING btree (workspace_id);

CREATE INDEX idx_templates_category ON public.templates USING btree (workspace_id, category);

CREATE INDEX idx_templates_workspace ON public.templates USING btree (workspace_id);

CREATE INDEX idx_time_entries_date ON public.time_entries USING btree (workspace_id, date);

CREATE INDEX idx_time_entries_member ON public.time_entries USING btree (team_member_id);

CREATE INDEX idx_time_entries_project ON public.time_entries USING btree (project_id);

CREATE INDEX idx_time_entries_workspace ON public.time_entries USING btree (workspace_id);

CREATE INDEX idx_transcription_routing_workspace ON public.transcription_routing USING btree (workspace_id);

CREATE INDEX idx_workbacks_project ON public.workback_schedules USING btree (project_id);

CREATE INDEX idx_workbacks_workspace ON public.workback_schedules USING btree (workspace_id);

CREATE INDEX idx_workspace_config_workspace ON public.workspace_config USING btree (workspace_id);

CREATE UNIQUE INDEX workspaces_slack_team_id_unique ON public.workspaces USING btree (slack_team_id) WHERE (slack_team_id IS NOT NULL);

-- functions
CREATE OR REPLACE FUNCTION public.acquire_archive_job_lease(p_job_id uuid, p_worker_id text, p_lease_seconds integer DEFAULT 7200)
 RETURNS SETOF archive_jobs
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
 update public.archive_jobs set claim_token=gen_random_uuid(),claimed_by=p_worker_id,claimed_at=now(),updated_at=now()
 where id=p_job_id
 and status in ('queued','validating','preparing_media','uploading_vimeo','creating_wordpress','creating_buffer','preparing_behance')
 and (claim_token is null or claimed_at < now()-make_interval(secs=>greatest(p_lease_seconds,300)))
 returning *;
$function$;


CREATE OR REPLACE FUNCTION public.check_slug_available(p_slug text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = p_slug);
END;
$function$;


CREATE OR REPLACE FUNCTION public.claim_archive_step(p_job_id uuid, p_step_name text, p_worker_id text, p_lease_seconds integer DEFAULT 7200)
 RETURNS SETOF archive_job_steps
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_step public.archive_job_steps%rowtype;
begin
 insert into public.archive_job_steps(job_id,step_name,status) values(p_job_id,p_step_name,'pending')
 on conflict(job_id,step_name) do nothing;
 select * into v_step from public.archive_job_steps where job_id=p_job_id and step_name=p_step_name for update;
 if v_step.status in ('complete','skipped') then return next v_step; return; end if;
 if v_step.status='running' and v_step.claim_token is not null
 and v_step.claimed_at >= now()-make_interval(secs=>greatest(p_lease_seconds,300)) then return; end if;
 update public.archive_job_steps set status='running',attempt=attempt+1,claim_token=gen_random_uuid(),
 claimed_by=p_worker_id,claimed_at=now(),error=null,started_at=now(),completed_at=null,updated_at=now()
 where id=v_step.id returning * into v_step;
 return next v_step;
end;
$function$;


CREATE OR REPLACE FUNCTION public.claim_dropbox_events(p_worker_id text, p_limit integer DEFAULT 10, p_lease_seconds integer DEFAULT 300)
 RETURNS SETOF dropbox_event_inbox
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  with candidates as (
    select id from public.dropbox_event_inbox
    where (status in ('pending', 'retryable') and next_attempt_at <= now())
       or (status = 'processing' and claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 30)))
    order by next_attempt_at, created_at
    for update skip locked
    limit least(greatest(p_limit, 1), 100)
  )
  update public.dropbox_event_inbox i
    set status = 'processing', attempt_count = i.attempt_count + 1,
        claim_token = gen_random_uuid(), claimed_by = p_worker_id,
        claimed_at = now(), updated_at = now()
  from candidates c where i.id = c.id
  returning i.*;
$function$;


CREATE OR REPLACE FUNCTION public.complete_dropbox_event(p_event_id uuid, p_claim_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  update public.dropbox_event_inbox
    set status = 'complete', completed_at = now(), claim_token = null,
        claimed_by = null, claimed_at = null, last_error = null, updated_at = now()
    where id = p_event_id and status = 'processing' and claim_token = p_claim_token;
  return found;
end;
$function$;


CREATE OR REPLACE FUNCTION public.complete_elevenlabs_studio_job(p_job_id uuid, p_worker_id text, p_claimed_at timestamp with time zone, p_project_id text, p_url text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_storyboard_job_id uuid;
begin
  update public.elevenlabs_studio_jobs
  set status = 'complete',
      studio_project_id = p_project_id,
      studio_url = p_url,
      error = null,
      completed_at = now(),
      heartbeat_at = now(),
      updated_at = now()
  where id = p_job_id
    and claimed_by = p_worker_id
    and claimed_at = p_claimed_at
    and status in ('claimed', 'opening_studio', 'filling_project', 'saving_draft')
  returning storyboard_job_id into v_storyboard_job_id;

  if v_storyboard_job_id is null then
    return false;
  end if;

  update public.storyboard_jobs
  set elevenlabs_project_id = p_project_id,
      elevenlabs_url = p_url,
      elevenlabs_status = 'complete',
      elevenlabs_error = null,
      updated_at = now()
  where id = v_storyboard_job_id;

  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.create_workspace(p_name text, p_slug text, p_user_name text, p_user_email text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_workspace_id UUID;
  v_member_id UUID;
BEGIN
  -- Create workspace
  INSERT INTO workspaces (name, slug)
  VALUES (p_name, p_slug)
  RETURNING id INTO v_workspace_id;

  -- Create founding member as admin
  INSERT INTO team_members (
    workspace_id, auth_user_id, name, email,
    role, permission_tier, is_active, accepted_at
  )
  VALUES (
    v_workspace_id, auth.uid(), p_user_name, p_user_email,
    'admin', 'founder', true, now()
  )
  RETURNING id INTO v_member_id;

  -- Create default workspace config entries
  INSERT INTO workspace_config (workspace_id, config_key, config_value) VALUES
    (v_workspace_id, 'defaults', '{"margin_target": 0.40, "budget_alert_threshold": 0.75, "revision_rounds": 2}'::jsonb),
    (v_workspace_id, 'project_types', '["Animation", "VFX", "Motion Graphics", "Live Action", "Mixed Media"]'::jsonb);

  RETURN json_build_object(
    'workspace_id', v_workspace_id,
    'member_id', v_member_id
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.fail_dropbox_event(p_event_id uuid, p_claim_token uuid, p_error text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_status text;
begin
  update public.dropbox_event_inbox
    set status = case when attempt_count >= max_attempts then 'dead_letter' else 'retryable' end,
        next_attempt_at = case when attempt_count >= max_attempts then next_attempt_at
          else now() + make_interval(secs => least(3600, 30 * (2 ^ least(attempt_count - 1, 7)))::integer) end,
        claim_token = null, claimed_by = null, claimed_at = null,
        last_error = left(coalesce(p_error, 'unknown error'), 4000), updated_at = now()
    where id = p_event_id and status = 'processing' and claim_token = p_claim_token
    returning status into v_status;
  return v_status;
end;
$function$;


CREATE OR REPLACE FUNCTION public.finish_archive_step_fenced(p_job_id uuid, p_step_name text, p_claim_token uuid, p_status text, p_result jsonb DEFAULT '{}'::jsonb, p_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
 if p_status not in ('complete','failed','skipped') then raise exception 'Invalid archive step terminal status'; end if;
 update public.archive_job_steps set status=p_status,result=coalesce(p_result,'{}'::jsonb),error=p_error,
 completed_at=now(),claim_token=null,claimed_by=null,claimed_at=null,updated_at=now()
 where job_id=p_job_id and step_name=p_step_name and status='running' and claim_token=p_claim_token;
 return found;
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_user_tier(ws_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT permission_tier FROM team_members
  WHERE auth_user_id = auth.uid()
    AND workspace_id = ws_id
    AND is_active = true
  LIMIT 1
$function$;


CREATE OR REPLACE FUNCTION public.get_user_workspace_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT workspace_id FROM team_members
  WHERE auth_user_id = auth.uid() AND is_active = true
$function$;


CREATE OR REPLACE FUNCTION public.ingest_dropbox_event_batch(p_previous_cursor text, p_new_cursor text, p_events jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_current_cursor text;
  v_inserted integer := 0;
begin
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' then
    raise exception 'p_events must be a JSON array';
  end if;
  select cursor into v_current_cursor
    from public.dropbox_state where id = 'singleton' for update;
  if not found then raise exception 'Dropbox cursor singleton is not initialized'; end if;
  if v_current_cursor is distinct from p_previous_cursor then
    raise exception 'Dropbox cursor changed concurrently';
  end if;
  insert into public.dropbox_event_inbox (event_key, event_type, payload, source_cursor)
  select e.event_key, e.event_type, e.payload, p_new_cursor
  from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb))
    as e(event_key text, event_type text, payload jsonb)
  where e.event_key is not null and e.event_type is not null and e.payload is not null
  on conflict (event_key) do nothing;
  get diagnostics v_inserted = row_count;
  update public.dropbox_state set cursor = p_new_cursor, updated_at = now() where id = 'singleton';
  return v_inserted;
end;
$function$;


CREATE OR REPLACE FUNCTION public.is_founder(ws_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM team_members
    WHERE auth_user_id = auth.uid()
      AND workspace_id = ws_id
      AND is_active = true
      AND permission_tier = 'founder'
  )
$function$;


CREATE OR REPLACE FUNCTION public.is_founder_or_producer(ws_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM team_members
    WHERE auth_user_id = auth.uid()
      AND workspace_id = ws_id
      AND is_active = true
      AND permission_tier IN ('founder', 'producer')
  )
$function$;


CREATE OR REPLACE FUNCTION public.match_documents(query_embedding vector, match_count integer DEFAULT 10, filter_workspace_id uuid DEFAULT NULL::uuid, filter_project_id uuid DEFAULT NULL::uuid, filter_visibility_tiers text[] DEFAULT ARRAY['team'::text])
 RETURNS TABLE(id uuid, title text, content text, doc_type text, source_url text, project_id uuid, workspace_id uuid, metadata jsonb, similarity double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  select
    pd.id,
    pd.title,
    pd.content,
    pd.doc_type,
    pd.source_url,
    pd.project_id,
    pd.workspace_id,
    pd.metadata,
    (1 - (pd.embedding <=> query_embedding))::float as similarity
  from public.project_documents pd
  where
    (filter_workspace_id is null or pd.workspace_id = filter_workspace_id)
    and (filter_project_id is null or pd.project_id = filter_project_id)
    and pd.visibility_tier = any(
      case
        when coalesce(cardinality(filter_visibility_tiers), 0) > 0
          then filter_visibility_tiers
        else array['team']::text[]
      end
    )
    and pd.embedding is not null
  order by pd.embedding <=> query_embedding
  limit greatest(match_count, 1);
end
$function$;


CREATE OR REPLACE FUNCTION public.pilots_evidence_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception 'pilot_evidence is append-only (% not allowed)', tg_op;
end;
$function$;


CREATE OR REPLACE FUNCTION public.pilots_generation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'pilot_generations rows cannot be deleted (append-only)';
  end if;
  if new.id is distinct from old.id
     or new.pilot_id is distinct from old.pilot_id
     or new.source is distinct from old.source
     or new.kind is distinct from old.kind
     or new.external_ref is distinct from old.external_ref
     or new.label is distinct from old.label
     or new.notes is distinct from old.notes
     or new.provenance is distinct from old.provenance
     or new.author is distinct from old.author
     or new.created_at is distinct from old.created_at then
    raise exception 'pilot_generations is immutable except acceptance fields';
  end if;
  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public.specs_backlog_commit_folder(p_holder text, p_fence bigint, p_parent text, p_children text[])
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
declare
  v_owned boolean;
begin
  select (lease_holder = p_holder and fence = p_fence)
    into v_owned
    from public.delivery_specs_scan_state
    where id = 'singleton'
    for update;

  if not coalesce(v_owned, false) then
    return false;
  end if;

  if p_children is not null and array_length(p_children, 1) is not null then
    insert into public.delivery_specs_scan_frontier (path)
    select unnest(p_children)
    on conflict (path) do nothing;
  end if;

  delete from public.delivery_specs_scan_frontier where path = p_parent;

  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.specs_backlog_mark_complete_if_empty(p_holder text, p_fence bigint)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
declare
  v_owned boolean;
  v_remaining bigint;
begin
  select (lease_holder = p_holder and fence = p_fence)
    into v_owned
    from public.delivery_specs_scan_state
    where id = 'singleton'
    for update;

  if not coalesce(v_owned, false) then
    return false;
  end if;

  select count(*) into v_remaining from public.delivery_specs_scan_frontier;
  if v_remaining > 0 then
    return false;
  end if;

  update public.delivery_specs_scan_state
    set backlog_complete = true, updated_at = now()
    where id = 'singleton';

  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;


-- triggers
CREATE TRIGGER client_profiles_updated_at BEFORE UPDATE ON client_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_intake_sessions_updated_at BEFORE UPDATE ON intake_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON integrations FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_model_catalog_updated_at BEFORE UPDATE ON model_catalog FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER pilot_evidence_no_modify BEFORE DELETE OR UPDATE ON pilot_evidence FOR EACH ROW EXECUTE FUNCTION pilots_evidence_immutable();

CREATE TRIGGER pilot_generations_guard BEFORE DELETE OR UPDATE ON pilot_generations FOR EACH ROW EXECUTE FUNCTION pilots_generation_guard();

CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER team_members_updated_at BEFORE UPDATE ON team_members FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER workspace_config_updated_at BEFORE UPDATE ON workspace_config FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- rls
alter table public.accessibility_jobs enable row level security;

alter table public.action_breakdowns enable row level security;

alter table public.agent_runs enable row level security;

alter table public.archive_activity enable row level security;

alter table public.archive_job_steps enable row level security;

alter table public.archive_jobs enable row level security;

alter table public.artifacts enable row level security;

alter table public.autonomy_settings enable row level security;

alter table public.behance_draft_jobs enable row level security;

alter table public.behance_workers enable row level security;

alter table public.bible_versions enable row level security;

alter table public.birthdays enable row level security;

alter table public.brain_revisions enable row level security;

alter table public.brain_scavenger_candidates enable row level security;

alter table public.brains enable row level security;

alter table public.call_classifications enable row level security;

alter table public.call_transcripts enable row level security;

alter table public.character_sheets enable row level security;

alter table public.client_profiles enable row level security;

alter table public.conversation_state enable row level security;

alter table public.cron_heartbeats enable row level security;

alter table public.daily_hours_checkins enable row level security;

alter table public.daily_hours_reminders enable row level security;

alter table public.daily_task_cards enable row level security;

alter table public.deliverables enable row level security;

alter table public.delivery_profiles enable row level security;

alter table public.delivery_spec_intake enable row level security;

alter table public.delivery_specs enable row level security;

alter table public.delivery_specs_scan_frontier enable row level security;

alter table public.delivery_specs_scan_state enable row level security;

alter table public.dropbox_event_inbox enable row level security;

alter table public.dropbox_state enable row level security;

alter table public.edit_decisions enable row level security;

alter table public.elevenlabs_studio_jobs enable row level security;

alter table public.elevenlabs_workers enable row level security;

alter table public.farm_status enable row level security;

alter table public.feedback_items enable row level security;

alter table public.financial_entries enable row level security;

alter table public.founder_content_access enable row level security;

alter table public.frameio_token_state enable row level security;

alter table public.freelancer_onboardings enable row level security;

alter table public.freelancer_paperwork enable row level security;

alter table public.gates enable row level security;

alter table public.generated_documents enable row level security;

alter table public.generation_tasks enable row level security;

alter table public.harvest_user_map enable row level security;

alter table public.hours_missing_alerts enable row level security;

alter table public.intake_messages enable row level security;

alter table public.intake_sessions enable row level security;

alter table public.integrations enable row level security;

alter table public.kit_actions enable row level security;

alter table public.managed_agent_registry enable row level security;

alter table public.meeting_briefing_deliveries enable row level security;

alter table public.meeting_briefings enable row level security;

alter table public.milestones enable row level security;

alter table public.model_catalog enable row level security;

alter table public.model_research_log enable row level security;

alter table public.model_scores enable row level security;

alter table public.permission_requests enable row level security;

alter table public.pilot_evidence enable row level security;

alter table public.pilot_generations enable row level security;

alter table public.pilot_material_maps enable row level security;

alter table public.pilot_references enable row level security;

alter table public.pilot_validations enable row level security;

alter table public.pilots enable row level security;

alter table public.pitch_log enable row level security;

alter table public.plaud_token_state enable row level security;

alter table public.project_access enable row level security;

alter table public.project_control_bindings enable row level security;

alter table public.project_control_canvases enable row level security;

alter table public.project_creation_requests enable row level security;

alter table public.project_documents enable row level security;

alter table public.project_provisioning_steps enable row level security;

alter table public.project_settings enable row level security;

alter table public.project_share_events enable row level security;

alter table public.project_update_requests enable row level security;

alter table public.project_update_steps enable row level security;

alter table public.projects enable row level security;

alter table public.render_jobs enable row level security;

alter table public.render_workers enable row level security;

alter table public.review_extractions enable row level security;

alter table public.scope_events enable row level security;

alter table public.seen_dropbox_files enable row level security;

alter table public.sentiment_snapshots enable row level security;

alter table public.sheet_sync_state enable row level security;

alter table public.staff enable row level security;

alter table public.staff_time_off enable row level security;

alter table public.storyboard_jobs enable row level security;

alter table public.storyboard_panels enable row level security;

alter table public.system_health enable row level security;

alter table public.team_members enable row level security;

alter table public.templates enable row level security;

alter table public.time_entries enable row level security;

alter table public.transcription_routing enable row level security;

alter table public.workback_schedules enable row level security;

alter table public.workspace_config enable row level security;

alter table public.workspaces enable row level security;

-- policies
create policy "Admin/producer can update breakdowns" on action_breakdowns as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Admin/producer can view breakdowns" on action_breakdowns as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy "System can insert breakdowns" on action_breakdowns as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admins can view agent runs" on agent_runs as permissive for select to public using (is_founder(workspace_id));

create policy "System can insert agent runs" on agent_runs as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Members can view archive activity" on archive_activity as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "System can insert archive activity" on archive_activity as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy artifacts_permissive_policy on artifacts as permissive for all to authenticated using (true);

create policy "Founder/producer can manage autonomy" on autonomy_settings as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Founder/producer can update autonomy" on autonomy_settings as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Founder/producer can view autonomy" on autonomy_settings as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy bible_versions_permissive_policy on bible_versions as permissive for all to authenticated using (true);

create policy "Founder/producer can view classifications" on call_classifications as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy "System can insert classifications" on call_classifications as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy character_sheets_delete on character_sheets as permissive for delete to authenticated using (true);

create policy character_sheets_read on character_sheets as permissive for select to authenticated using (true);

create policy character_sheets_update on character_sheets as permissive for update to authenticated using (true);

create policy character_sheets_write on character_sheets as permissive for insert to authenticated with check (true);

create policy "Admin/producer can manage client profiles" on client_profiles as permissive for all to public using (is_founder_or_producer(workspace_id));

create policy "Admin/producer can view client profiles" on client_profiles as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy "Founder/producer can update task cards" on daily_task_cards as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Founder/producer can view all task cards" on daily_task_cards as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy "Members can view their own task cards" on daily_task_cards as permissive for select to public using ((team_member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE ((team_members.auth_user_id = auth.uid()) AND (team_members.is_active = true)))));

create policy "System can insert task cards" on daily_task_cards as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admin/producer can manage deliverables" on deliverables as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Admin/producer can update deliverables" on deliverables as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Members can view deliverables" on deliverables as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy delivery_specs_delete on delivery_specs as permissive for delete to authenticated using (true);

create policy delivery_specs_read on delivery_specs as permissive for select to authenticated using (true);

create policy delivery_specs_update on delivery_specs as permissive for update to authenticated using (true);

create policy delivery_specs_write on delivery_specs as permissive for insert to authenticated with check (true);

create policy edit_decisions_delete on edit_decisions as permissive for delete to authenticated using (true);

create policy edit_decisions_read on edit_decisions as permissive for select to authenticated using (true);

create policy edit_decisions_update on edit_decisions as permissive for update to authenticated using (true);

create policy edit_decisions_write on edit_decisions as permissive for insert to authenticated with check (true);

create policy "Members can view farm status" on farm_status as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "System can insert farm status" on farm_status as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admin/producer can update feedback" on feedback_items as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Members can insert feedback" on feedback_items as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Members can view feedback" on feedback_items as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admin/producer can update financials" on financial_entries as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Admin/producer can view financials" on financial_entries as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy "System can insert financials" on financial_entries as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Founders see access log" on founder_content_access as permissive for select to public using (is_founder(workspace_id));

create policy "System logs access" on founder_content_access as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy gates_permissive_policy on gates as permissive for all to authenticated using (true);

create policy "Admin/producer can create generated documents" on generated_documents as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Members can view generated documents" on generated_documents as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy generation_tasks_delete on generation_tasks as permissive for delete to authenticated using (true);

create policy generation_tasks_read on generation_tasks as permissive for select to authenticated using (true);

create policy generation_tasks_update on generation_tasks as permissive for update to authenticated using (true);

create policy generation_tasks_write on generation_tasks as permissive for insert to authenticated with check (true);

create policy intake_messages_permissive_policy on intake_messages as permissive for all to authenticated using (true);

create policy intake_sessions_permissive_policy on intake_sessions as permissive for all to authenticated using (true);

create policy "Admin/producer can manage integrations" on integrations as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Admin/producer can update integrations" on integrations as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Admin/producer can view integrations" on integrations as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy "Admins can delete integrations" on integrations as permissive for delete to public using (is_founder(workspace_id));

create policy "Admin/producer can update actions" on kit_actions as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Admin/producer can view actions" on kit_actions as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy "System can insert actions" on kit_actions as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admin/producer can manage milestones" on milestones as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Admin/producer can update milestones" on milestones as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Members can view milestones" on milestones as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Allow all on model_catalog" on model_catalog as permissive for all to authenticated using (true) with check (true);

create policy "Allow all on model_research_log" on model_research_log as permissive for all to authenticated using (true) with check (true);

create policy model_scores_permissive_policy on model_scores as permissive for all to authenticated using (true);

create policy "Founders can update permission requests" on permission_requests as permissive for update to public using (is_founder(workspace_id));

create policy "Founders can view all permission requests" on permission_requests as permissive for select to public using (is_founder(workspace_id));

create policy "Members can create permission requests" on permission_requests as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Members can view their own permission requests" on permission_requests as permissive for select to public using ((requester_id IN ( SELECT team_members.id
   FROM team_members
  WHERE ((team_members.auth_user_id = auth.uid()) AND (team_members.is_active = true)))));

create policy "Admins can manage pitch log" on pitch_log as permissive for all to public using (is_founder(workspace_id));

create policy "Admins can view pitch log" on pitch_log as permissive for select to public using (is_founder(workspace_id));

create policy "Admin/producer can manage project access" on project_access as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Admin/producer can update project access" on project_access as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Members can view project access" on project_access as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Founders and producers can insert documents" on project_documents as permissive for insert to authenticated with check (is_founder_or_producer(workspace_id));

create policy "Founders can view all documents" on project_documents as permissive for select to authenticated using (is_founder(workspace_id));

create policy "Producers can view non-founder documents" on project_documents as permissive for select to authenticated using ((is_founder_or_producer(workspace_id) AND (visibility_tier <> 'founder'::text)));

create policy "Admin/producer can create projects" on projects as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Admin/producer can update projects" on projects as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Admins can delete projects" on projects as permissive for delete to public using (is_founder(workspace_id));

create policy "Members can view projects" on projects as permissive for select to public using (((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)) AND (is_founder_or_producer(workspace_id) OR (EXISTS ( SELECT 1
   FROM (project_access pa
     JOIN team_members tm ON ((tm.id = pa.team_member_id)))
  WHERE ((pa.project_id = projects.id) AND (tm.auth_user_id = auth.uid()) AND (pa.removed_at IS NULL)))))));

create policy "Admin/producer can view scope events" on scope_events as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy "System can insert scope events" on scope_events as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admin/producer can view sentiment" on sentiment_snapshots as permissive for select to public using (is_founder_or_producer(workspace_id));

create policy "System can insert sentiment" on sentiment_snapshots as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy storyboard_panels_delete on storyboard_panels as permissive for delete to authenticated using (true);

create policy storyboard_panels_read on storyboard_panels as permissive for select to authenticated using (true);

create policy storyboard_panels_update on storyboard_panels as permissive for update to authenticated using (true);

create policy storyboard_panels_write on storyboard_panels as permissive for insert to authenticated with check (true);

create policy "Founders can delete team members" on team_members as permissive for delete to authenticated using (is_founder(workspace_id));

create policy "Founders can insert team members" on team_members as permissive for insert to authenticated with check (is_founder(workspace_id));

create policy "Founders can update team members" on team_members as permissive for update to authenticated using (is_founder(workspace_id)) with check (is_founder(workspace_id));

create policy "Members can view workspace colleagues" on team_members as permissive for select to authenticated using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admin/producer can manage templates" on templates as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Admin/producer can update templates" on templates as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Members can view templates" on templates as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admin/producer can update time entries" on time_entries as permissive for update to public using (is_founder_or_producer(workspace_id));

create policy "Members can insert time entries" on time_entries as permissive for insert to public with check ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Members can view time entries" on time_entries as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Founders can delete routing rules" on transcription_routing as permissive for delete to public using (is_founder(workspace_id));

create policy "Founders can manage routing rules" on transcription_routing as permissive for insert to public with check (is_founder(workspace_id));

create policy "Founders can update routing rules" on transcription_routing as permissive for update to public using (is_founder(workspace_id));

create policy "Founders can view routing rules" on transcription_routing as permissive for select to public using (is_founder(workspace_id));

create policy "Admin/producer can manage workbacks" on workback_schedules as permissive for insert to public with check (is_founder_or_producer(workspace_id));

create policy "Members can view workback schedules" on workback_schedules as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admins can manage workspace config" on workspace_config as permissive for insert to public with check (is_founder(workspace_id));

create policy "Admins can update workspace config" on workspace_config as permissive for update to public using (is_founder(workspace_id));

create policy "Members can view workspace config" on workspace_config as permissive for select to public using ((workspace_id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

create policy "Admins can delete their workspace" on workspaces as permissive for delete to public using (is_founder(id));

create policy "Admins can update their workspace" on workspaces as permissive for update to public using (is_founder(id));

create policy "Authenticated users can create workspaces" on workspaces as permissive for insert to public with check ((auth.uid() IS NOT NULL));

create policy "Members can view their workspaces" on workspaces as permissive for select to public using ((id IN ( SELECT get_user_workspace_ids() AS get_user_workspace_ids)));

-- relgrants
revoke all on sequence public.brain_revisions_id_seq from public, anon, authenticated, service_role;
grant SELECT, UPDATE, USAGE on sequence public.brain_revisions_id_seq to anon;
grant SELECT, UPDATE, USAGE on sequence public.brain_revisions_id_seq to authenticated;
grant SELECT, UPDATE, USAGE on sequence public.brain_revisions_id_seq to service_role;

revoke all on sequence public.brain_scavenger_candidates_id_seq from public, anon, authenticated, service_role;
grant SELECT, UPDATE, USAGE on sequence public.brain_scavenger_candidates_id_seq to anon;
grant SELECT, UPDATE, USAGE on sequence public.brain_scavenger_candidates_id_seq to authenticated;
grant SELECT, UPDATE, USAGE on sequence public.brain_scavenger_candidates_id_seq to service_role;

revoke all on table public.accessibility_jobs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.accessibility_jobs to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.accessibility_jobs to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.accessibility_jobs to service_role;

revoke all on table public.action_breakdowns from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.action_breakdowns to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.action_breakdowns to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.action_breakdowns to service_role;

revoke all on table public.agent_runs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.agent_runs to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.agent_runs to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.agent_runs to service_role;

revoke all on table public.archive_activity from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.archive_activity to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.archive_activity to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.archive_activity to service_role;

revoke all on table public.archive_job_steps from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.archive_job_steps to service_role;

revoke all on table public.archive_jobs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.archive_jobs to service_role;

revoke all on table public.artifacts from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.artifacts to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.artifacts to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.artifacts to service_role;

revoke all on table public.autonomy_settings from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.autonomy_settings to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.autonomy_settings to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.autonomy_settings to service_role;

revoke all on table public.behance_draft_jobs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.behance_draft_jobs to service_role;

revoke all on table public.behance_workers from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.behance_workers to service_role;

revoke all on table public.bible_versions from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.bible_versions to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.bible_versions to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.bible_versions to service_role;

revoke all on table public.birthdays from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.birthdays to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.birthdays to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.birthdays to service_role;

revoke all on table public.brain_revisions from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.brain_revisions to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.brain_revisions to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.brain_revisions to service_role;

revoke all on table public.brain_scavenger_candidates from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.brain_scavenger_candidates to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.brain_scavenger_candidates to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.brain_scavenger_candidates to service_role;

revoke all on table public.brains from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.brains to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.brains to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.brains to service_role;

revoke all on table public.call_classifications from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.call_classifications to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.call_classifications to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.call_classifications to service_role;

revoke all on table public.call_transcripts from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.call_transcripts to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.call_transcripts to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.call_transcripts to service_role;

revoke all on table public.character_sheets from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.character_sheets to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.character_sheets to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.character_sheets to service_role;

revoke all on table public.client_profiles from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.client_profiles to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.client_profiles to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.client_profiles to service_role;

revoke all on table public.conversation_state from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.conversation_state to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.conversation_state to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.conversation_state to service_role;

revoke all on table public.cron_heartbeats from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.cron_heartbeats to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.cron_heartbeats to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.cron_heartbeats to service_role;

revoke all on table public.daily_hours_checkins from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_hours_checkins to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_hours_checkins to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_hours_checkins to service_role;

revoke all on table public.daily_hours_reminders from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_hours_reminders to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_hours_reminders to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_hours_reminders to service_role;

revoke all on table public.daily_task_cards from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_task_cards to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_task_cards to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_task_cards to service_role;

revoke all on table public.deliverables from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.deliverables to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.deliverables to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.deliverables to service_role;

revoke all on table public.delivery_profiles from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_profiles to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_profiles to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_profiles to service_role;

revoke all on table public.delivery_spec_intake from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_spec_intake to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_spec_intake to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_spec_intake to service_role;

revoke all on table public.delivery_specs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_specs to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_specs to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_specs to service_role;

revoke all on table public.delivery_specs_scan_frontier from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_specs_scan_frontier to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_specs_scan_frontier to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_specs_scan_frontier to service_role;

revoke all on table public.delivery_specs_scan_state from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_specs_scan_state to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_specs_scan_state to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_specs_scan_state to service_role;

revoke all on table public.dropbox_event_inbox from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.dropbox_event_inbox to service_role;

revoke all on table public.dropbox_state from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.dropbox_state to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.dropbox_state to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.dropbox_state to service_role;

revoke all on table public.edit_decisions from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.edit_decisions to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.edit_decisions to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.edit_decisions to service_role;

revoke all on table public.elevenlabs_studio_jobs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.elevenlabs_studio_jobs to service_role;

revoke all on table public.elevenlabs_workers from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.elevenlabs_workers to service_role;

revoke all on table public.farm_status from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.farm_status to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.farm_status to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.farm_status to service_role;

revoke all on table public.feedback_items from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.feedback_items to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.feedback_items to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.feedback_items to service_role;

revoke all on table public.financial_entries from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.financial_entries to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.financial_entries to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.financial_entries to service_role;

revoke all on table public.founder_content_access from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.founder_content_access to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.founder_content_access to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.founder_content_access to service_role;

revoke all on table public.frameio_token_state from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.frameio_token_state to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.frameio_token_state to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.frameio_token_state to service_role;

revoke all on table public.freelancer_onboardings from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.freelancer_onboardings to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.freelancer_onboardings to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.freelancer_onboardings to service_role;

revoke all on table public.freelancer_paperwork from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.freelancer_paperwork to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.freelancer_paperwork to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.freelancer_paperwork to service_role;

revoke all on table public.gates from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.gates to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.gates to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.gates to service_role;

revoke all on table public.generated_documents from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.generated_documents to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.generated_documents to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.generated_documents to service_role;

revoke all on table public.generation_tasks from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.generation_tasks to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.generation_tasks to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.generation_tasks to service_role;

revoke all on table public.harvest_user_map from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.harvest_user_map to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.harvest_user_map to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.harvest_user_map to service_role;

revoke all on table public.hours_missing_alerts from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.hours_missing_alerts to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.hours_missing_alerts to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.hours_missing_alerts to service_role;

revoke all on table public.intake_messages from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.intake_messages to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.intake_messages to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.intake_messages to service_role;

revoke all on table public.intake_sessions from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.intake_sessions to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.intake_sessions to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.intake_sessions to service_role;

revoke all on table public.integrations from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.integrations to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.integrations to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.integrations to service_role;

revoke all on table public.kit_actions from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.kit_actions to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.kit_actions to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.kit_actions to service_role;

revoke all on table public.managed_agent_registry from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_agent_registry to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_agent_registry to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_agent_registry to service_role;

revoke all on table public.meeting_briefing_deliveries from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meeting_briefing_deliveries to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meeting_briefing_deliveries to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meeting_briefing_deliveries to service_role;

revoke all on table public.meeting_briefings from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meeting_briefings to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meeting_briefings to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meeting_briefings to service_role;

revoke all on table public.milestones from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.milestones to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.milestones to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.milestones to service_role;

revoke all on table public.model_catalog from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.model_catalog to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.model_catalog to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.model_catalog to service_role;

revoke all on table public.model_research_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.model_research_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.model_research_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.model_research_log to service_role;

revoke all on table public.model_scores from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.model_scores to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.model_scores to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.model_scores to service_role;

revoke all on table public.permission_requests from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.permission_requests to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.permission_requests to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.permission_requests to service_role;

revoke all on table public.pilot_evidence from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_evidence to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_evidence to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_evidence to service_role;

revoke all on table public.pilot_generations from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_generations to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_generations to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_generations to service_role;

revoke all on table public.pilot_material_maps from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_material_maps to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_material_maps to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_material_maps to service_role;

revoke all on table public.pilot_references from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_references to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_references to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_references to service_role;

revoke all on table public.pilot_validations from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_validations to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_validations to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_validations to service_role;

revoke all on table public.pilots from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilots to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilots to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilots to service_role;

revoke all on table public.pitch_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pitch_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pitch_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pitch_log to service_role;

revoke all on table public.plaud_token_state from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.plaud_token_state to service_role;

revoke all on table public.project_access from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_access to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_access to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_access to service_role;

revoke all on table public.project_control_bindings from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_control_bindings to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_control_bindings to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_control_bindings to service_role;

revoke all on table public.project_control_canvases from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_control_canvases to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_control_canvases to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_control_canvases to service_role;

revoke all on table public.project_creation_requests from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_creation_requests to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_creation_requests to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_creation_requests to service_role;

revoke all on table public.project_documents from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_documents to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_documents to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_documents to service_role;

revoke all on table public.project_provisioning_steps from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_provisioning_steps to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_provisioning_steps to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_provisioning_steps to service_role;

revoke all on table public.project_settings from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_settings to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_settings to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_settings to service_role;

revoke all on table public.project_share_events from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_share_events to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_share_events to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_share_events to service_role;

revoke all on table public.project_update_requests from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_update_requests to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_update_requests to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_update_requests to service_role;

revoke all on table public.project_update_steps from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_update_steps to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_update_steps to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.project_update_steps to service_role;

revoke all on table public.projects from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.projects to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.projects to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.projects to service_role;

revoke all on table public.render_jobs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.render_jobs to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.render_jobs to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.render_jobs to service_role;

revoke all on table public.render_workers from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.render_workers to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.render_workers to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.render_workers to service_role;

revoke all on table public.review_extractions from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.review_extractions to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.review_extractions to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.review_extractions to service_role;

revoke all on table public.scope_events from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.scope_events to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.scope_events to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.scope_events to service_role;

revoke all on table public.seen_dropbox_files from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.seen_dropbox_files to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.seen_dropbox_files to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.seen_dropbox_files to service_role;

revoke all on table public.sentiment_snapshots from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sentiment_snapshots to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sentiment_snapshots to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sentiment_snapshots to service_role;

revoke all on table public.sheet_sync_state from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sheet_sync_state to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sheet_sync_state to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sheet_sync_state to service_role;

revoke all on table public.staff from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.staff to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.staff to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.staff to service_role;

revoke all on table public.staff_time_off from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.staff_time_off to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.staff_time_off to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.staff_time_off to service_role;

revoke all on table public.storyboard_jobs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.storyboard_jobs to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.storyboard_jobs to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.storyboard_jobs to service_role;

revoke all on table public.storyboard_panels from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.storyboard_panels to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.storyboard_panels to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.storyboard_panels to service_role;

revoke all on table public.system_health from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.system_health to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.system_health to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.system_health to service_role;

revoke all on table public.team_members from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.team_members to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.team_members to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.team_members to service_role;

revoke all on table public.templates from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.templates to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.templates to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.templates to service_role;

revoke all on table public.time_entries from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.time_entries to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.time_entries to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.time_entries to service_role;

revoke all on table public.transcription_routing from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.transcription_routing to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.transcription_routing to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.transcription_routing to service_role;

revoke all on table public.workback_schedules from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.workback_schedules to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.workback_schedules to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.workback_schedules to service_role;

revoke all on table public.workspace_config from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.workspace_config to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.workspace_config to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.workspace_config to service_role;

revoke all on table public.workspaces from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.workspaces to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.workspaces to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.workspaces to service_role;

-- fngrants
revoke all on function public.acquire_archive_job_lease(p_job_id uuid, p_worker_id text, p_lease_seconds integer) from public, anon, authenticated, service_role;
grant EXECUTE on function public.acquire_archive_job_lease(p_job_id uuid, p_worker_id text, p_lease_seconds integer) to service_role;

revoke all on function public.check_slug_available(p_slug text) from public, anon, authenticated, service_role;
grant EXECUTE on function public.check_slug_available(p_slug text) to authenticated;
grant EXECUTE on function public.check_slug_available(p_slug text) to service_role;

revoke all on function public.claim_archive_step(p_job_id uuid, p_step_name text, p_worker_id text, p_lease_seconds integer) from public, anon, authenticated, service_role;
grant EXECUTE on function public.claim_archive_step(p_job_id uuid, p_step_name text, p_worker_id text, p_lease_seconds integer) to service_role;

revoke all on function public.claim_dropbox_events(p_worker_id text, p_limit integer, p_lease_seconds integer) from public, anon, authenticated, service_role;
grant EXECUTE on function public.claim_dropbox_events(p_worker_id text, p_limit integer, p_lease_seconds integer) to service_role;

revoke all on function public.complete_dropbox_event(p_event_id uuid, p_claim_token uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.complete_dropbox_event(p_event_id uuid, p_claim_token uuid) to service_role;

revoke all on function public.complete_elevenlabs_studio_job(p_job_id uuid, p_worker_id text, p_claimed_at timestamp with time zone, p_project_id text, p_url text) from public, anon, authenticated, service_role;
grant EXECUTE on function public.complete_elevenlabs_studio_job(p_job_id uuid, p_worker_id text, p_claimed_at timestamp with time zone, p_project_id text, p_url text) to service_role;

revoke all on function public.create_workspace(p_name text, p_slug text, p_user_name text, p_user_email text) from public, anon, authenticated, service_role;
grant EXECUTE on function public.create_workspace(p_name text, p_slug text, p_user_name text, p_user_email text) to authenticated;
grant EXECUTE on function public.create_workspace(p_name text, p_slug text, p_user_name text, p_user_email text) to service_role;

revoke all on function public.fail_dropbox_event(p_event_id uuid, p_claim_token uuid, p_error text) from public, anon, authenticated, service_role;
grant EXECUTE on function public.fail_dropbox_event(p_event_id uuid, p_claim_token uuid, p_error text) to service_role;

revoke all on function public.finish_archive_step_fenced(p_job_id uuid, p_step_name text, p_claim_token uuid, p_status text, p_result jsonb, p_error text) from public, anon, authenticated, service_role;
grant EXECUTE on function public.finish_archive_step_fenced(p_job_id uuid, p_step_name text, p_claim_token uuid, p_status text, p_result jsonb, p_error text) to service_role;

revoke all on function public.get_user_tier(ws_id uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.get_user_tier(ws_id uuid) to authenticated;
grant EXECUTE on function public.get_user_tier(ws_id uuid) to service_role;

revoke all on function public.get_user_workspace_ids() from public, anon, authenticated, service_role;
grant EXECUTE on function public.get_user_workspace_ids() to authenticated;
grant EXECUTE on function public.get_user_workspace_ids() to service_role;

revoke all on function public.ingest_dropbox_event_batch(p_previous_cursor text, p_new_cursor text, p_events jsonb) from public, anon, authenticated, service_role;
grant EXECUTE on function public.ingest_dropbox_event_batch(p_previous_cursor text, p_new_cursor text, p_events jsonb) to service_role;

revoke all on function public.is_founder(ws_id uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.is_founder(ws_id uuid) to authenticated;
grant EXECUTE on function public.is_founder(ws_id uuid) to service_role;

revoke all on function public.is_founder_or_producer(ws_id uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.is_founder_or_producer(ws_id uuid) to authenticated;
grant EXECUTE on function public.is_founder_or_producer(ws_id uuid) to service_role;

revoke all on function public.match_documents(query_embedding vector, match_count integer, filter_workspace_id uuid, filter_project_id uuid, filter_visibility_tiers text[]) from public, anon, authenticated, service_role;
grant EXECUTE on function public.match_documents(query_embedding vector, match_count integer, filter_workspace_id uuid, filter_project_id uuid, filter_visibility_tiers text[]) to service_role;

revoke all on function public.pilots_evidence_immutable() from public, anon, authenticated, service_role;
grant EXECUTE on function public.pilots_evidence_immutable() to public;
grant EXECUTE on function public.pilots_evidence_immutable() to anon;
grant EXECUTE on function public.pilots_evidence_immutable() to authenticated;
grant EXECUTE on function public.pilots_evidence_immutable() to service_role;

revoke all on function public.pilots_generation_guard() from public, anon, authenticated, service_role;
grant EXECUTE on function public.pilots_generation_guard() to public;
grant EXECUTE on function public.pilots_generation_guard() to anon;
grant EXECUTE on function public.pilots_generation_guard() to authenticated;
grant EXECUTE on function public.pilots_generation_guard() to service_role;

revoke all on function public.specs_backlog_commit_folder(p_holder text, p_fence bigint, p_parent text, p_children text[]) from public, anon, authenticated, service_role;
grant EXECUTE on function public.specs_backlog_commit_folder(p_holder text, p_fence bigint, p_parent text, p_children text[]) to service_role;

revoke all on function public.specs_backlog_mark_complete_if_empty(p_holder text, p_fence bigint) from public, anon, authenticated, service_role;
grant EXECUTE on function public.specs_backlog_mark_complete_if_empty(p_holder text, p_fence bigint) to service_role;

revoke all on function public.update_updated_at() from public, anon, authenticated, service_role;
grant EXECUTE on function public.update_updated_at() to public;
grant EXECUTE on function public.update_updated_at() to anon;
grant EXECUTE on function public.update_updated_at() to authenticated;
grant EXECUTE on function public.update_updated_at() to service_role;

revoke all on function public.update_updated_at_column() from public, anon, authenticated, service_role;
grant EXECUTE on function public.update_updated_at_column() to public;
grant EXECUTE on function public.update_updated_at_column() to anon;
grant EXECUTE on function public.update_updated_at_column() to authenticated;
grant EXECUTE on function public.update_updated_at_column() to service_role;

-- publication
alter publication supabase_realtime add table public.agent_runs;

alter publication supabase_realtime add table public.bible_versions;

alter publication supabase_realtime add table public.gates;

-- comments
comment on table public.archive_job_steps is 'Idempotent per-step archive workflow ledger used for retries, resume, and operator audit.';

comment on table public.archive_jobs is 'Private, producer-approved Kit archive/publishing jobs. Destinations create drafts or unlisted media only.';

comment on table public.behance_draft_jobs is 'Private queue for the dedicated Kit studio browser worker. It may save Behance drafts but must never publish them.';

comment on column public.behance_draft_jobs.manifest is 'Public-safe, producer-approved portfolio copy and Dropbox asset paths only; never credentials, budgets, or private project context.';

comment on table public.behance_workers is 'Heartbeat and operational state for dedicated Behance browser workers.';

comment on column public.brain_scavenger_candidates.dm_sent_at is 'When the approval DM for this candidate was last sent. Null = never DM''d. Dispatch re-sends only after a stale cutoff (weekly re-remind).';

comment on function public.complete_elevenlabs_studio_job(p_job_id uuid, p_worker_id text, p_claimed_at timestamp with time zone, p_project_id text, p_url text) is 'Atomically fences a Studio worker attempt and checkpoints the related storyboard job.';

comment on table public.conversation_state is 'Write-through mirror of Kit''s in-memory conversation state (15-min TTL). Exists so a Railway redeploy doesn''t drop mid-conversation context.';

comment on table public.daily_hours_reminders is 'Authoritative durable occurrence + delivery state for the scheduled daily-hours reminder. One row per (staff.id, local workday, reminder_type). Owns whether/when the reminder is owed and delivered; daily_hours_checkins remains the conversation record. Service-role owned (written only via the admin client), consistent with meeting_briefing_deliveries.';

comment on column public.delivery_profiles.video_filters is 'Extra FFmpeg -vf chain prepended to scaling (e.g. v360 for 360 video). Plain argv, no shell.';

comment on table public.delivery_spec_intake is 'Pending delivery prompts awaiting a spec reply (text/PDF/screenshot) in their thread.';

comment on table public.elevenlabs_studio_jobs is 'Internal service-role queue for private ElevenLabs Studio drafts created by the dedicated studio Mac.';

comment on table public.elevenlabs_workers is 'Heartbeat and current-job state for dedicated ElevenLabs browser workers.';

comment on column public.frameio_token_state.access_token is 'Shared short-lived Adobe IMS access token. All runtimes read this; only the lock holder refreshes.';

comment on column public.frameio_token_state.access_expires_at is 'When access_token expires (UTC). Refreshed under the refreshing_until lock before this.';

comment on column public.frameio_token_state.refreshing_until is 'Cross-runtime refresh lock. A runtime claims the right to exchange by setting this to now()+TTL via a conditional UPDATE; NULL/past means free.';

comment on table public.freelancer_paperwork is 'Email-keyed source of truth for freelancer NDA/paperwork status. status=sent: NDA emailed, awaiting signed copy. on_file: signed copy confirmed. waived: manually exempted. Used to suppress re-sending the NDA to returning freelancers.';

comment on table public.hours_missing_alerts is 'One row per missing-time flag. (staff_id, streak_start_date) is unique so a persisting gap alerts producers only once.';

comment on table public.meeting_briefing_deliveries is 'Authoritative per-recipient delivery state for pre-meeting briefings. One row per (meeting_briefings.id, staff.id). Replaces meeting_briefings.notified_user_ids as the source of truth.';

comment on column public.meeting_briefings.notified_user_ids is 'Slack user ids the briefing was DM''d to (the matched R&F attendees). Privacy audit trail.';

comment on column public.meeting_briefings.meeting_type is 'Which composer produced this briefing: project (matched-project context) or bizdev (attendee bios for a bizdev-staffer meeting with no project match).';

comment on table public.pilot_evidence is 'Append-only pilot evidence. Categories are strictly separated (measurement/observation/judgment/assumption/unknown/risk/decision). Objective measurements carry structured value+unit+timestamp; subjective judgments stay in value_text. No update path (trigger-enforced).';

comment on table public.pilot_generations is 'Append-only generated outputs (reference/upload) with an explicit, attributed human acceptance decision. Default acceptance is pending; nothing is accepted by default. Only acceptance fields may be updated (trigger-enforced); rows are never deleted.';

comment on table public.pilot_material_maps is 'Material-package maps for a pilot. A material package is a distinct package_name. Every map carries a map_type and a REQUIRED non-empty production purpose (structurally enforced).';

comment on table public.pilot_references is 'External references for a pilot (Pinterest research, the one designated Figma moodboard, deliberately distinct styleframe directions). Exactly one figma_moodboard per pilot. External tools remain references, not integrations.';

comment on table public.pilot_validations is 'Cinema 4D / Redshift technical validation records for a pilot. A non-empty recorded evidence_ref is required, so technical validity always has evidence behind it.';

comment on table public.pilots is 'Bounded evidence-driven experiment attached to one project. Supabase is authoritative; any Slack Canvas is a read-only projection. At most one active pilot per (project, type). Finalization requires a human-authored recommendation.';

comment on table public.project_control_bindings is 'Authoritative binding of a Kit project to one Master Project List row (via Sheets developer metadata kit_project_id) and one Slack Project Control Canvas. Creation and sync lifecycles are separate. Renders always use the stored template snapshot, not the live template.';

comment on table public.project_control_canvases is 'One durable generated Slack Canvas binding per project and view: overview, reference, schedule.';

comment on table public.project_creation_requests is 'Idempotency ledger for new-project provisioning, keyed by Slack view.id. Replaces the in-memory pending-provision Map so restarts/retries resume the same request. One row per submission; an intentional duplicate is a new view.id.';

comment on column public.project_creation_requests.replace_target_project_id is 'Immutable identity of the project a ''replace'' decision must archive, captured at prompt time. Intentionally NOT a foreign key: the value must survive the target project''s deletion so a crash mid-replace resumes against the same target and the durable replace_cleanup step stays required until done. A dangling id after cleanup is expected (the cleanup step then no-ops idempotently).';

comment on table public.project_provisioning_steps is 'Per-(project, service) durable provisioning step ledger with deterministic per-step ownership (holder/fence/lease), attempts, input hash, and persisted external id. Memoizes each external service provision so a restart resumes only the incomplete services; final writes are holder/fence-conditional.';

comment on table public.project_settings is 'Per-project toggles. A missing row means defaults apply.';

comment on column public.project_settings.frameio_upload_enabled is 'When false, the Dropbox->Frame.io delivery watcher skips mirroring this project''s delivery files; they stay in Dropbox only.';

comment on column public.project_settings.updated_by is 'Slack user ID of whoever last changed a setting.';

comment on table public.project_share_events is 'Idempotent Dropbox-to-Frame share ledger and producer-confirmed workback progression.';

comment on table public.project_update_requests is 'Idempotency ledger for the update-project ripple, keyed by the update modal Slack view.id. Holds the submitted form + computed plan; the confirm/cancel actions rehydrate from here. One row per submission; a restart/redelivery resumes the same ripple.';

comment on table public.project_update_steps is 'Per-(update_request, service) durable step ledger for the update-project ripple, with deterministic per-step ownership (holder/fence/lease). Memoizes each external rename so a restart resumes only the incomplete services; final writes are holder/fence-conditional. Separate from project_provisioning_steps so update recovery never crosses into create recovery.';

comment on table public.sheet_sync_state is 'Per-workbook coarse Drive-version cursor plus exclusive creation and sync leases (with monotonic ownership fences) for Project Control synchronization.';

comment on column public.staff.email_aliases is 'Additional email addresses that resolve to this person (e.g. a calendar-invite address that differs from the primary/Slack email). The briefing matcher matches on primary email plus every alias.';

comment on column public.staff.briefing_channel_id is 'Slack id of the private 1:1 channel Kit posts this person''s pre-meeting briefings to (only them + Kit). Created lazily on first briefing, then reused.';

comment on column public.staff.daily_checkin is 'Receives the 5pm daily hours check-in DM. Independent of role — flip to add/remove anyone.';

comment on table public.staff_time_off is 'Per-person time off, inclusive date range. Suppresses the daily hours check-in DM and excludes the days from the missing-time monitor.';

comment on column public.storyboard_jobs.elevenlabs_project_id is 'ElevenLabs Studio project created from the storyboard voiceover.';

comment on column public.storyboard_jobs.elevenlabs_status is 'pending, complete, skipped, or failed; independently retryable from Boords.';
