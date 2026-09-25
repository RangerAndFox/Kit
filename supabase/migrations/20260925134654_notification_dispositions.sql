-- Explicit holds are not successful delivery. Historical provider jobs remain intact.
alter table public.elevenlabs_studio_jobs
  add column slack_notification_disposition text not null default 'pending'
    check (slack_notification_disposition in ('pending','manual_review','retired')),
  add column slack_notification_disposition_reason text,
  add column slack_notification_disposition_by text,
  add column slack_notification_disposition_at timestamptz;
alter table public.elevenlabs_studio_jobs add constraint notification_disposition_evidence
  check (slack_notification_disposition = 'pending' or
    (slack_notified_at is null and slack_notification_disposition_at is not null
     and nullif(trim(slack_notification_disposition_reason),'') is not null
     and nullif(trim(slack_notification_disposition_by),'') is not null));
create index elevenlabs_notification_pending_idx on public.elevenlabs_studio_jobs(updated_at)
  where slack_notified_at is null and slack_notification_disposition='pending';

-- Operator-only append-only receipt for explicit queue cleanup (not provider success).
create table public.queue_disposition_audit (
  id uuid primary key default gen_random_uuid(),
  queue_name text not null check (queue_name in ('dropbox_event_inbox','elevenlabs_studio_jobs')),
  record_id uuid not null,
  disposition text not null check (disposition in ('retired','manual_review')),
  reason text not null check (length(trim(reason)) > 0),
  actor text not null check (length(trim(actor)) > 0),
  prior_status text not null,
  recorded_at timestamptz not null default now(),
  unique(queue_name,record_id,disposition)
);
alter table public.queue_disposition_audit enable row level security;
revoke all on public.queue_disposition_audit from public,anon,authenticated,service_role;
grant select,insert on public.queue_disposition_audit to service_role;
create trigger queue_disposition_audit_immutable before update or delete
  on public.queue_disposition_audit for each row
  execute function public.reject_frameio_retirement_audit_mutation();
