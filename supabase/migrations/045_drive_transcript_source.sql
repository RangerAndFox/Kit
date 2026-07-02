-- Drive-sourced transcripts (Plaud → Zapier → Google Drive folder).
--
-- Migration 022 removed the 'drive' source value when Drive ingestion was
-- shelved. The studio now has a Zap dropping Plaud transcripts into a Drive
-- folder, and Kit ingests from there (driveTranscriptScan cron) — so 'drive'
-- returns as a valid call_transcripts source.

alter table public.call_transcripts
  drop constraint if exists call_transcripts_source_check;

alter table public.call_transcripts
  add constraint call_transcripts_source_check
  check (source in ('plaud', 'manual', 'granola', 'drive'));
