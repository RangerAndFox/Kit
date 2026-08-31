-- 015_create_call_transcripts.sql
-- Create the call_transcripts table in its post-014 target shape.
--
-- Context: migration 014 (`014_plaud_migration.sql`) was written assuming
-- a pre-existing `call_transcripts` table created by the old Granola path.
-- Pre-flight against the live database revealed the table was never
-- created — the Granola integration referenced it but no migration ever
-- shipped it. So 014 is a no-op against this database (its rename-column
-- DO block skips, its ADD COLUMN IF NOT EXISTS adds would otherwise fail
-- on the missing table).
--
-- This migration creates the table fresh in the shape 014 would have
-- produced: provider-agnostic columns, optional NULLs for the hydrate-path
-- fields, and the ingest_status state machine. It is the actual baseline
-- for Plaud's webhook + Inngest pipeline.
--
-- Idempotent: IF NOT EXISTS everywhere so re-running is safe.
-- Spec: docs/superpowers/specs/2026-05-21-plaud-migration-design.md

begin;

create table if not exists public.call_transcripts (
  id uuid primary key default gen_random_uuid(),

  -- Tenant + project scope. workspace_id is required for multi-tenant
  -- safety; project_id is set by the CALL_PROCESSOR agent post-classification.
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,

  -- Provider-agnostic source tag. Only 'plaud' and 'manual' are valid
  -- on writes; 'granola' is preserved as a historical value in case any
  -- legacy data ever shows up (none currently exists).
  source text not null default 'plaud'
    constraint call_transcripts_source_check
    check (source in ('plaud', 'manual', 'granola')),

  -- External system identifiers. Plaud uses two ids: transcription_id
  -- (the recording's transcript task) and file_id (the audio file).
  external_recording_id text unique,
  external_file_id text,

  -- Content. Populated post-hydrate; nullable so skeleton rows can be
  -- inserted from the webhook before the API fetch completes.
  transcript text,
  participants jsonb,
  duration_seconds integer,
  start_time timestamptz,
  end_time timestamptz,

  -- Ingest pipeline state. 'pending' → 'ingested' on hydrate success;
  -- 'failed' on hydrate error (Inngest retries push it back to 'pending'
  -- on the next attempt).
  ingest_status text not null default 'pending'
    constraint call_transcripts_ingest_status_check
    check (ingest_status in ('pending', 'ingested', 'failed')),
  ingest_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes match the access patterns in:
--   src/lib/inngest/plaud.ts        (upsert on external_recording_id)
--   src/lib/agent/briefing-composer.ts (filter by source + project_id)
--   future backfill query (status='pending' + start_time ordering)
create unique index if not exists call_transcripts_external_recording_id_key
  on public.call_transcripts (external_recording_id);

create index if not exists call_transcripts_workspace_idx
  on public.call_transcripts (workspace_id);

create index if not exists call_transcripts_project_idx
  on public.call_transcripts (project_id);

create index if not exists call_transcripts_source_ingest_status_idx
  on public.call_transcripts (source, ingest_status);

-- Match the RLS pattern used by other public tables in this project:
-- RLS enabled but no policies. All app access goes through the
-- service-role key which bypasses RLS; the anon key has no access.
alter table public.call_transcripts enable row level security;

commit;
