-- 'logging' is the confirm handler's claim state (compare-and-set between
-- 'parsed' and 'logged'/'failed') but was never added to the status check,
-- so EVERY confirm — button click or typed yes — failed the claim write
-- silently and no check-in ever reached Harvest.
alter table daily_hours_checkins
  drop constraint daily_hours_checkins_status_check;
alter table daily_hours_checkins
  add constraint daily_hours_checkins_status_check
  check (status in ('sent', 'replied', 'parsed', 'confirmed', 'logging', 'logged', 'skipped', 'nudged', 'failed'));
