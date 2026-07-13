-- Health monitor: last-known status per check (alert de-dup + "down since"),
-- and per-cron success heartbeats (freshness). Service-role only.

create table if not exists system_health (
  key        text primary key,
  status     text not null check (status in ('up', 'down')),
  detail     text,
  since      timestamptz not null default now(),
  checked_at timestamptz not null default now()
);

create table if not exists cron_heartbeats (
  cron_id         text primary key,
  last_success_at timestamptz not null default now()
);

-- RLS on with no policies: only the service role (which bypasses RLS) touches
-- these. Matches the pattern used by the other internal tables.
alter table system_health enable row level security;
alter table cron_heartbeats enable row level security;
