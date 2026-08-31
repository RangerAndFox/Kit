-- ============================================================
-- 012: Access Control Columns
--
-- Ensures team_members has the columns the access control
-- system needs. Some may already exist if added via UI.
-- ============================================================

-- Add slack_user_id for identity resolution
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS slack_user_id text;
CREATE INDEX IF NOT EXISTS idx_team_members_slack_user_id
  ON team_members(workspace_id, slack_user_id);

-- Add name column (some records only have display_name)
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS name text;

-- Add permission_tier for explicit tier override
-- (defaults to null, meaning tier is derived from role)
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS permission_tier text
  CHECK (permission_tier IS NULL OR permission_tier IN ('admin', 'producer', 'artist'));

-- Add hourly_rate (admin-only field)
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS hourly_rate numeric;

-- Add is_active flag
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

-- Add integration IDs for other services
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS clockify_user_id text;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS notion_user_id text;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS frameio_user_id text;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS harvest_user_id text;

-- Ensure project_access has can_see_financials
ALTER TABLE project_access ADD COLUMN IF NOT EXISTS can_see_financials boolean DEFAULT false;
