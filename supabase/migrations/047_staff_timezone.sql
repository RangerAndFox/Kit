-- Per-person timezone (IANA name, e.g. 'America/New_York'), sourced from the
-- Slack profile. Half the team is Pacific but Central/Eastern folks need
-- check-ins at 5pm THEIR time and dates resolved on THEIR calendar. Kept as
-- a cache column so src/lib code (no Slack client) can read it; bolt-side
-- resolvers refresh it from users.info.
alter table staff
  add column if not exists timezone text;
