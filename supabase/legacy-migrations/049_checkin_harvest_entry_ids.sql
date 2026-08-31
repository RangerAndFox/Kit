-- Store the Harvest time-entry ids a confirm actually created, so a
-- "logged" status is auditable (and duplicates are traceable when someone
-- also enters time by hand).
alter table daily_hours_checkins
  add column if not exists harvest_entry_ids jsonb;
