-- 018_shot_lists.sql
-- Shot lists as Slack Canvases. One canvas per project channel; rows track
-- the channel↔canvas mapping so Kit can update existing canvases.
-- Spec: docs/superpowers/specs/2026-05-21-shot-list-canvas-design.md

begin;

create table if not exists public.shot_lists (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete set null,
  slack_channel_id text not null,
  slack_canvas_id text not null,
  canvas_url text,
  shots_json jsonb not null default '[]'::jsonb,
  thumbnail_permalinks jsonb not null default '{}'::jsonb,
  last_rendered_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists shot_lists_channel_key
  on public.shot_lists (slack_channel_id);

create index if not exists shot_lists_project_idx
  on public.shot_lists (project_id);

commit;
