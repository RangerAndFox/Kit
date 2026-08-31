-- 028_brain_visibility.sql
-- Per-brain visibility flag.
--
--   'team'            — channel canvas posted; visible to anyone in the channel
--                       (still gated at Kit level: artists can't /kit brain even
--                       on team-visibility brains, but the canvas tab is there)
--   'producers_only'  — NO channel canvas. Brain markdown is stored and
--                       producers can read via /kit brain (text response).
--                       Artists can't access at all.
--
-- Secure-by-default: new brains created without an explicit visibility get
-- 'producers_only'. Existing brains are migrated to 'producers_only' since
-- the assumption is that briefs / budgets / decisions in a brain are
-- producer-tier material until proven otherwise.

begin;

alter table public.brains
  add column if not exists visibility text not null default 'producers_only'
    constraint brains_visibility_check
    check (visibility in ('team', 'producers_only'));

-- Migrate any existing rows (idempotent).
update public.brains set visibility = 'producers_only' where visibility is null;

create index if not exists brains_visibility_idx
  on public.brains (visibility);

commit;
