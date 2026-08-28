-- An operator may verify that hours already exist in Harvest even when Kit did
-- not create the entries and therefore has no provider entry IDs to retain.
-- Keep that completion state explicit and auditable instead of treating the
-- row as a migration-048 logging failure forever.
alter table public.daily_hours_checkins
  drop constraint if exists daily_hours_checkins_origin_check;

alter table public.daily_hours_checkins
  add constraint daily_hours_checkins_origin_check
  check (origin in ('scheduled', 'adhoc', 'manual-reconciliation'));
