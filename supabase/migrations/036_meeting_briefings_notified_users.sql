-- Pre-meeting briefings: record who received each briefing (Feature #14).
--
-- Briefings are now DM'd privately to the R&F people actually on the invite
-- (no project-channel post by default), so nothing bleeds to people who
-- weren't on the call. This column is the audit trail — the exact Slack user
-- ids that were DM'd for each meeting.

ALTER TABLE meeting_briefings ADD COLUMN IF NOT EXISTS notified_user_ids jsonb;

COMMENT ON COLUMN meeting_briefings.notified_user_ids IS
  'Slack user ids the briefing was DM''d to (the matched R&F attendees). Privacy audit trail.';
