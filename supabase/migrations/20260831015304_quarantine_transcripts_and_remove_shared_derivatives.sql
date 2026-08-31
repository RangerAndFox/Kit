-- Full transcripts and derivatives are founder-only. The previous
-- call_transcript_safe rows were produced by the same regex guard used at
-- egress and therefore were not an independent privacy control.

delete from public.project_documents
where doc_type = 'call_transcript_safe';

update public.project_documents
set visibility_tier = 'founder'
where doc_type = 'call_transcript'
  and visibility_tier <> 'founder';

alter table public.project_documents
  drop constraint if exists project_documents_transcripts_founder_only;

alter table public.project_documents
  add constraint project_documents_transcripts_founder_only
  check (
    doc_type not in ('call_transcript', 'call_transcript_safe')
    or visibility_tier = 'founder'
  );
