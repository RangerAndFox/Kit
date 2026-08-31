-- Explicit per-person opt-in for the 5pm hours check-in.
--
-- Membership was hard-coded to role='creative' + employment_type='employee',
-- which can't express "Steve (admin) and Jonathan (cd) also want check-ins".
-- The flag decouples check-in membership from role: flip it in Supabase (or
-- a future /kit command) to add/remove anyone.

ALTER TABLE staff ADD COLUMN IF NOT EXISTS daily_checkin boolean NOT NULL DEFAULT false;

-- Backfill: everyone the old rule covered, plus Steve + Jonathan.
UPDATE staff
SET daily_checkin = true
WHERE (role = 'creative' AND employment_type = 'employee')
   OR slack_user_id IN ('U4CA7HXT9', 'U03LS6PNWV9');

COMMENT ON COLUMN staff.daily_checkin IS
  'Receives the 5pm daily hours check-in DM. Independent of role — flip to add/remove anyone.';
