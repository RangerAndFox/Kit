-- Per-person briefing channel (Feature #14 delivery change).
--
-- Pre-meeting briefings used to DM the recipient. Because Kit is registered as
-- a Slack "Agents & AI Apps" assistant, Slack routes proactive DMs into the
-- assistant's History tab instead of notifying like a normal message — so
-- recipients missed their prep.
--
-- Instead, Kit posts each briefing in a PRIVATE channel shared only with that
-- one recipient (just them + Kit). It notifies like any channel message and
-- stays fully private — no bleeding to anyone who wasn't on the call. This
-- column caches the resolved channel id so Kit creates it once, then reuses it.

ALTER TABLE staff ADD COLUMN IF NOT EXISTS briefing_channel_id text;

COMMENT ON COLUMN staff.briefing_channel_id IS
  'Slack id of the private 1:1 channel Kit posts this person''s pre-meeting briefings to (only them + Kit). Created lazily on first briefing, then reused.';
