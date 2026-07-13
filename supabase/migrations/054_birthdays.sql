-- Birthdays for ANY team member, keyed by Slack user id — decoupled from the
-- Harvest `staff` directory (founders/admins live in team_members, not staff).

create table if not exists birthdays (
  slack_user_id text primary key,
  month_day     text not null,        -- 'MM-DD'
  full_name     text,
  created_by    text,
  created_at    timestamptz not null default now()
);

alter table birthdays enable row level security;

-- staff.birthday (from migration 053) is superseded by this table.
alter table staff drop column if exists birthday;
