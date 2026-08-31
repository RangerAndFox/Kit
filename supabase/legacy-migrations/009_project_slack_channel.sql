-- Add Slack channel tracking + external links to projects
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS slack_channel_id text,
  ADD COLUMN IF NOT EXISTS external_links jsonb DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_projects_slack_channel_id
  ON projects(slack_channel_id)
  WHERE slack_channel_id IS NOT NULL;
