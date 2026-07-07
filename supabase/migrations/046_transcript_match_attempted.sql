-- Track when project matching was last attempted for a transcript, so the
-- drive-transcript-scan's rematch pass processes each unmatched row exactly
-- once instead of re-running the (LLM-backed) matcher every 15 minutes.
alter table call_transcripts
  add column if not exists project_match_attempted_at timestamptz;
