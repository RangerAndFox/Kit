alter table public.elevenlabs_studio_jobs
  add column if not exists slack_notified_at timestamptz,
  add column if not exists slack_notification_claim_token uuid,
  add column if not exists slack_notification_claimed_at timestamptz;
create index if not exists elevenlabs_slack_outbox_idx
  on public.elevenlabs_studio_jobs (status, completed_at)
  where slack_notified_at is null;

