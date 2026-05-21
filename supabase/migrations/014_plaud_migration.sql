-- 014_plaud_migration.sql
-- Generalize call_transcripts for provider-agnostic transcript ingestion.
-- Replaces the Granola integration with Plaud (https://plaud.ai).
-- Spec: docs/superpowers/specs/2026-05-21-plaud-migration-design.md

begin;

-- Rename to a provider-neutral column name.
alter table public.call_transcripts
  rename column granola_call_id to external_recording_id;

-- New columns for Plaud's two-id model and ingest status tracking.
alter table public.call_transcripts
  add column if not exists external_file_id text;

alter table public.call_transcripts
  add column if not exists ingest_status text not null default 'pending'
    check (ingest_status in ('pending', 'ingested', 'failed'));

-- Skeleton rows arrive with IDs only; fields below get hydrated later.
alter table public.call_transcripts alter column transcript drop not null;
alter table public.call_transcripts alter column participants drop not null;
alter table public.call_transcripts alter column start_time drop not null;
alter table public.call_transcripts alter column end_time drop not null;

-- Ensure uniqueness on the recording id (safe if a unique constraint
-- carried over from the rename — IF NOT EXISTS makes this idempotent).
create unique index if not exists call_transcripts_external_recording_id_key
  on public.call_transcripts (external_recording_id);

create index if not exists call_transcripts_source_ingest_status_idx
  on public.call_transcripts (source, ingest_status);

-- Hard-delete legacy Granola rows. RAG documents tied to them are not
-- reachable through a foreign key and stay in project_documents as
-- source-agnostic text+embeddings (documented trade-off in the spec).
delete from public.call_transcripts where source = 'granola';

commit;
