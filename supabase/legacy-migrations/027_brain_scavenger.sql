-- 027_brain_scavenger.sql
-- Brain Phase 5 — scavenger candidates pending-approval queue.
-- Spec: KIT-BRAIN-SPEC.md §5
--
-- The scavenger finds context outside a channel (other projects' docs,
-- transcripts) that might be relevant to a brain's open decisions or
-- watchlist. Cross-boundary context donation is STRUCTURALLY GATED — the
-- channel creator must approve via DM before anything is added. This
-- table is the pending queue.

begin;

create table if not exists public.brain_scavenger_candidates (
  id              bigserial primary key,
  brain_id        text not null references public.brains(id) on delete cascade,
  workspace_id    uuid not null,
  source_ref      text,
  source_doc_id   uuid references public.project_documents(id) on delete set null,
  summary         text,
  why_relevant    text,
  similarity      numeric,
  status          text not null default 'pending'
    constraint brain_scavenger_status_check
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  approver        text,
  approval_dm_ts  text,
  applied_section text,
  decided_at      timestamptz,
  created_at      timestamptz default now()
);

create index if not exists brain_scavenger_pending_idx
  on public.brain_scavenger_candidates (brain_id, status, created_at desc)
  where status = 'pending';

create index if not exists brain_scavenger_brain_idx
  on public.brain_scavenger_candidates (brain_id);

alter table public.brain_scavenger_candidates enable row level security;

commit;
