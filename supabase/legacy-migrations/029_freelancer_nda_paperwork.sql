-- 029_freelancer_nda_paperwork.sql
-- NDA / paperwork tracking for freelancer onboarding.
--
-- Two pieces:
--   1. Per-onboarding-run NDA status on freelancer_onboardings (mirrors the
--      existing slack_/dropbox_/frameio_/harvest_ status+error convention).
--   2. A durable, email-keyed record of whether a freelancer already has
--      paperwork on file — the source of truth for the "have we worked with
--      them before?" first-timer check. Keyed on email (not slack_user_id)
--      because Connect-invited freelancers have no Slack id at onboarding time.

alter table public.freelancer_onboardings
  add column if not exists nda_status text,
  add column if not exists nda_error text,
  add column if not exists nda_sent_at timestamptz,
  add column if not exists artist_legal_name text;

create table if not exists public.freelancer_paperwork (
  email              text primary key,
  legal_name         text,
  -- sent     = NDA emailed, awaiting a signed copy back (out-of-band)
  -- on_file  = a signed copy has been confirmed received (manually marked)
  -- waived   = manually exempted (e.g. agency already has a master NDA)
  status             text not null default 'sent'
                       check (status in ('sent', 'on_file', 'waived')),
  nda_sent_at        timestamptz,
  nda_completed_at   timestamptz,
  nda_completed_by   text,            -- slack user id of whoever marked it on file
  last_onboarding_id uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.freelancer_paperwork is
  'Email-keyed source of truth for freelancer NDA/paperwork status. '
  'status=sent: NDA emailed, awaiting signed copy. on_file: signed copy confirmed. '
  'waived: manually exempted. Used to suppress re-sending the NDA to returning freelancers.';
