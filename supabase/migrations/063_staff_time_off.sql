-- Per-person time off (PTO / sick / leave), so Kit stops treating a planned
-- absence as missing time.
--
-- Kit already knows about studio-wide closures (studioHolidays in
-- bolt/src/checkins/date.ts), but had no notion of ONE person being out. The
-- consequences were real: someone on a week's vacation still got a 5pm hours
-- check-in DM every day, those check-ins piled up as "stuck" (indistinguishable
-- from a genuine Kit failure), and the missing-time monitor would flag them to
-- every producer for having logged nothing.
--
-- Date range is INCLUSIVE on both ends: a single day off is start = end.

create table if not exists staff_time_off (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references staff(id) on delete cascade,
  start_date date not null,
  end_date   date not null,
  kind       text not null default 'pto',
  note       text,
  created_by text,
  created_at timestamptz not null default now(),
  constraint staff_time_off_kind_valid
    check (kind in ('pto', 'sick', 'leave', 'other')),
  constraint staff_time_off_range_valid
    check (end_date >= start_date)
);

-- Lookups are always "does this person have time off overlapping this window".
create index if not exists staff_time_off_staff_range_idx
  on staff_time_off (staff_id, start_date, end_date);

alter table staff_time_off enable row level security;

comment on table staff_time_off is
  'Per-person time off, inclusive date range. Suppresses the daily hours '
  'check-in DM and excludes the days from the missing-time monitor.';

-- Known absence this table was introduced for: Ted was out 2026-08-03 – 08-07,
-- which surfaced as four "stuck" check-ins. Backfilled by email so it does not
-- depend on a staff row id. Idempotent.
insert into staff_time_off (staff_id, start_date, end_date, kind, note, created_by)
select s.id, date '2026-08-03', date '2026-08-07', 'pto', 'Vacation', 'migration_063'
from staff s
where s.email = 'ted@rangerandfox.tv'
  and not exists (
    select 1 from staff_time_off t
    where t.staff_id = s.id
      and t.start_date = date '2026-08-03'
      and t.end_date = date '2026-08-07'
  );

-- Those check-ins were never a Kit failure — resolve them so they stop showing
-- up as recoverable/stuck. Scoped to rows that overlap a time-off range.
update daily_hours_checkins c
set status = 'skipped',
    updated_at = now()
where c.status in ('sent', 'nudged')
  and exists (
    select 1 from staff_time_off t
    where t.staff_id = c.staff_id
      and c.check_in_date between t.start_date and t.end_date
  );
