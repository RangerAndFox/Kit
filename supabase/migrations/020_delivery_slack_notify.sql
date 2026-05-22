-- 020_delivery_slack_notify.sql
-- Tracks Slack-notification state on render_jobs so the completion watcher
-- can be idempotent without re-posting on every cron tick.
--
-- Three columns added (all nullable):
--   slack_notified_at      — last time Kit posted a Slack update for this job
--   slack_notified_status  — which status was last announced ('queued','claimed','complete','failed')
--   slack_message_ts       — the message ts so future updates can edit in place

begin;

alter table public.render_jobs
  add column if not exists slack_notified_at timestamptz;

alter table public.render_jobs
  add column if not exists slack_notified_status text;

alter table public.render_jobs
  add column if not exists slack_message_ts text;

commit;
