-- 026_brain.sql
-- Kit Brain — Phase 1 schema.
-- One brain per project channel (v1). The canonical brain content is the
-- markdown body; brain sections also embed into project_documents with
-- doc_type='brain_section' so the existing match_documents RPC can serve
-- retrieval without new search infra.
--
-- Spec: KIT-BRAIN-SPEC.md §5
-- Phase 5 (scavenger) will add brain_scavenger_candidates in a later migration.

begin;

create table if not exists public.brains (
  id            text primary key,                       -- e.g. 'proj-STUDIO100-ignite25'
  workspace_id  uuid not null,
  scope         text not null
    constraint brains_scope_check check (scope in ('studio', 'project')),
  project_code  text,
  project_id    uuid references public.projects(id) on delete set null,
  slack_channel text,
  revision      int not null default 0,
  markdown      text not null default '',
  canvas_id     text,
  canvas_url    text,
  autonomy      text not null default 'autonomous'
    constraint brains_autonomy_check check (autonomy in ('autonomous', 'gated', 'ask_first')),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- A workspace can only have one brain per project channel.
create unique index if not exists brains_workspace_channel_uq
  on public.brains (workspace_id, slack_channel)
  where slack_channel is not null;

create index if not exists brains_workspace_idx
  on public.brains (workspace_id);

create index if not exists brains_project_idx
  on public.brains (project_id)
  where project_id is not null;

-- Audit trail: every patch to the brain writes a row here. Lets us diff
-- the brain over time and back out bad entries.
create table if not exists public.brain_revisions (
  id          bigserial primary key,
  brain_id    text not null references public.brains(id) on delete cascade,
  revision    int not null,
  section     text,
  operation   text
    constraint brain_revisions_operation_check
    check (operation in ('add', 'update', 'supersede', 'replace', 'seed')),
  diff        text,
  provenance  jsonb,
  author      text,                                     -- slack user id, system, etc.
  created_at  timestamptz default now()
);

create index if not exists brain_revisions_brain_idx
  on public.brain_revisions (brain_id, revision desc);

commit;
