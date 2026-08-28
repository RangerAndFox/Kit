-- Raw Plaud/Drive transcripts may include personal conversations, client
-- contacts, budgets, contracts, or credentials. A project match is routing
-- metadata, not consent to expose the source. Keep every historical raw chunk
-- founder-only; application code creates a separately redacted
-- call_transcript_safe derivative for project/team retrieval.
update public.project_documents
set visibility_tier = 'founder'
where doc_type = 'call_transcript'
  and coalesce(metadata ->> 'source', '') in ('plaud', 'drive')
  and visibility_tier is distinct from 'founder';
