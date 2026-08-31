-- Add Harvest tracking fields to projects
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS harvest_project_id bigint,
  ADD COLUMN IF NOT EXISTS harvest_task_id bigint;

CREATE INDEX IF NOT EXISTS idx_projects_harvest_project_id
  ON projects(harvest_project_id)
  WHERE harvest_project_id IS NOT NULL;

-- Store Harvest user mappings (Slack user ID → Harvest user ID)
CREATE TABLE IF NOT EXISTS harvest_user_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slack_user_id text NOT NULL,
  harvest_user_id bigint NOT NULL,
  harvest_user_name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE(workspace_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_harvest_user_map_slack
  ON harvest_user_map(workspace_id, slack_user_id);

ALTER TABLE harvest_user_map ENABLE ROW LEVEL SECURITY;
