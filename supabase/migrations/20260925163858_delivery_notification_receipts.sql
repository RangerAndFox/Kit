-- Durable ownership survives process/step retries. Ambiguous posts never get
-- a new automatic claim; only an authenticated Slack receipt can resolve them.
create table public.delivery_notification_receipts (
  delivery_key text primary key,
  owner uuid not null,
  channel_id text not null,
  thread_ts text,
  message_ts text,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  check ((message_ts is null) = (acknowledged_at is null))
);
alter table public.delivery_notification_receipts enable row level security;
revoke all on public.delivery_notification_receipts from public, anon, authenticated;
grant select, insert, update, delete on public.delivery_notification_receipts to service_role;
create index delivery_notification_unconfirmed on public.delivery_notification_receipts(created_at) where message_ts is null;
