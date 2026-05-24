-- 022_revert_drive_transcript_watcher.sql
-- Reverts migration 021. The user opted not to ingest Drive-sourced
-- conversation transcripts into Kit's RAG, so the empty seen_drive_files
-- table and the 'drive' source-enum value are both removed.
--
-- Safe to run because:
--   - seen_drive_files was never written to (the watcher code on
--     feature/drive-transcript-watcher was never merged or activated).
--   - No call_transcripts row exists with source='drive' (the only writer
--     was the unmerged watcher).

begin;

drop table if exists public.seen_drive_files;

alter table public.call_transcripts
  drop constraint if exists call_transcripts_source_check;

alter table public.call_transcripts
  add constraint call_transcripts_source_check
  check (source in ('plaud', 'manual', 'granola'));

commit;
