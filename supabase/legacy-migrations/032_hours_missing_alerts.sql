-- Missing-time monitor (Feature #10 extension).
--
-- A daily scan flags any in-house creative who has gone N consecutive working
-- days (default 3) with zero hours logged in Harvest — excluding days they
-- explicitly marked "skip"/PTO. This table records each flag so producers are
-- alerted ONCE per streak, not every day the gap persists.
--
-- Idempotency key is (staff_id, streak_start_date): while a gap keeps growing
-- the streak_start stays fixed, so the unique constraint suppresses re-alerts.
-- When the artist logs again the streak breaks; the next lapse has a new
-- streak_start and is therefore allowed to alert again.

CREATE TABLE IF NOT EXISTS hours_missing_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  slack_user_id text,
  streak_start_date date NOT NULL,
  streak_days integer NOT NULL,
  missing_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_logged_date date,
  alert_channel_id text,
  alert_ts text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, streak_start_date)
);

CREATE INDEX IF NOT EXISTS hours_missing_alerts_staff_idx
  ON hours_missing_alerts (staff_id, created_at DESC);

COMMENT ON TABLE hours_missing_alerts IS
  'One row per missing-time flag. (staff_id, streak_start_date) is unique so a persisting gap alerts producers only once.';
COMMENT ON COLUMN hours_missing_alerts.streak_start_date IS
  'Earliest missing working day in the streak — the idempotency anchor.';
COMMENT ON COLUMN hours_missing_alerts.missing_dates IS
  'JSON array of the YYYY-MM-DD working days with no logged time at flag time.';
COMMENT ON COLUMN hours_missing_alerts.last_logged_date IS
  'Most recent day Harvest shows any logged time, if known.';

-- Match the rest of the schema: RLS on, no policies. Kit reaches this table
-- only through the service-role client, which bypasses RLS.
ALTER TABLE hours_missing_alerts ENABLE ROW LEVEL SECURITY;
