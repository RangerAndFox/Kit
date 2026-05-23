-- 017_pre_meeting_briefings.sql
-- Pre-meeting briefings: cron-scheduled meeting reminders with project context.
-- Spec: docs/superpowers/specs/2026-05-21-pre-meeting-briefings-design.md

begin;

create table if not exists public.meeting_briefings (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  calendar_id text,
  project_id uuid references public.projects(id) on delete set null,
  meeting_title text,
  meeting_start_time timestamptz,
  attendees_json jsonb,
  briefing_md text,
  slack_channel_id text,
  slack_message_ts text,
  producer_dm_ts text,
  confidence numeric,
  status text not null default 'pending'
    constraint meeting_briefings_status_check
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists meeting_briefings_event_id_key
  on public.meeting_briefings (event_id);

create index if not exists meeting_briefings_status_start_idx
  on public.meeting_briefings (status, meeting_start_time);

commit;
