-- Parsed confirmation cards outside the safe automatic logging window are no
-- longer actionable. Preserve them as an explicit terminal state so health
-- reporting can distinguish manual-review history from live lost hours.
alter table public.daily_hours_checkins
  drop constraint daily_hours_checkins_status_check;

alter table public.daily_hours_checkins
  add constraint daily_hours_checkins_status_check
  check (status in (
    'sent', 'replied', 'parsed', 'confirmed', 'logging', 'logged', 'skipped',
    'nudged', 'failed', 'expired'
  ));
