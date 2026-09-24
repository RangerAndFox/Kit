-- Distinguish a cron's last ATTEMPT from its last SUCCESS.
--
-- The health watchdog needs to tell "running but failing" (fresh attempt, stale
-- success) from "not running at all" (both stale). That requires a second
-- timestamp, and it requires a heartbeat row to be able to exist for a cron
-- that has attempted but never succeeded — so last_success_at becomes nullable
-- and loses its now() default (writers always set it explicitly on success;
-- an attempt-only write must NOT imply a success).
--
-- Backfill-safe: every existing row already has last_success_at set, so
-- dropping NOT NULL/default changes nothing for current data. Additive column
-- is nullable. Old code that only writes/reads last_success_at keeps working.

alter table public.cron_heartbeats
  add column if not exists last_attempt_at timestamptz;

alter table public.cron_heartbeats
  alter column last_success_at drop not null;

alter table public.cron_heartbeats
  alter column last_success_at drop default;
