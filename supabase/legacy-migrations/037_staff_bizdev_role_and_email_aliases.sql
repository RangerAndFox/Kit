-- Staff: add the 'bizdev' role and an email-alias column.
--
-- Two additions, both driven by onboarding the core team:
--
-- 1. 'bizdev' role — business-development staff (e.g. Erin). They appear in the
--    directory and receive pre-meeting briefings like anyone matched on a
--    calendar invite, but get no operational powers: not enrolled in the hours
--    monitor, can't run /kit onboard. Roles don't gate briefings, so no code
--    path change is needed for them to receive briefings — only the CHECK
--    constraint must allow the value.
--
-- 2. email_aliases — some staff use a Slack email that differs from the address
--    on their calendar invites (e.g. jared@ in Slack vs jareddoud@ on invites).
--    The briefing matcher keys recipients on email, so without the alias the
--    invite wouldn't match and they'd silently miss their prep. This column
--    holds any additional addresses that should resolve to the same person.

-- 1. Allow the new role.
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role = ANY (ARRAY['creative'::text, 'producer'::text, 'cd'::text, 'admin'::text, 'bizdev'::text]));

-- 2. Alias addresses (calendar invites that differ from the primary email).
ALTER TABLE staff ADD COLUMN IF NOT EXISTS email_aliases text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN staff.email_aliases IS
  'Additional email addresses that resolve to this person (e.g. a calendar-invite address that differs from the primary/Slack email). The briefing matcher matches on primary email plus every alias.';
