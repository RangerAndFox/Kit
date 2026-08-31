-- Cover the optional daily_hours_checkins foreign key used to link a durable
-- reminder occurrence to its conversation row. This avoids a full ledger scan
-- when a check-in row is updated or deleted.

create index if not exists daily_hours_reminders_check_in_id_idx
  on public.daily_hours_reminders (check_in_id);
