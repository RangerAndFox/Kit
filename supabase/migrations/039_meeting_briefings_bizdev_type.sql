-- Bizdev briefings (Feature #14 extension).
--
-- Meetings that don't classify to any active project are normally skipped
-- silently — no briefing, no Slack message. When a bizdev-role staffer
-- (e.g. Erin) is on the invite, Kit now composes a different kind of
-- briefing instead: a short web-researched bio + R&F relevance for each
-- external attendee, rather than project context. meeting_type records
-- which composer produced a given row, for auditing/debugging.

ALTER TABLE meeting_briefings ADD COLUMN IF NOT EXISTS meeting_type text NOT NULL DEFAULT 'project';

ALTER TABLE meeting_briefings DROP CONSTRAINT IF EXISTS meeting_briefings_meeting_type_check;
ALTER TABLE meeting_briefings ADD CONSTRAINT meeting_briefings_meeting_type_check
  CHECK (meeting_type = ANY (ARRAY['project'::text, 'bizdev'::text]));

COMMENT ON COLUMN meeting_briefings.meeting_type IS
  'Which composer produced this briefing: project (matched-project context) or bizdev (attendee bios for a bizdev-staffer meeting with no project match).';
