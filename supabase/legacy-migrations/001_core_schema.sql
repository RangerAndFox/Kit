-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Workspaces table
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_workspaces_slug ON workspaces(slug);

-- Team members table
CREATE TABLE team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('founder', 'producer', 'artist', 'freelancer')),
  email text NOT NULL,
  display_name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_team_members_workspace_id ON team_members(workspace_id);
CREATE INDEX idx_team_members_user_id ON team_members(user_id);
CREATE UNIQUE INDEX idx_team_members_workspace_user ON team_members(workspace_id, user_id);

-- Workspace configuration table
CREATE TABLE workspace_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  margin_target_percent numeric,
  budget_alert_threshold numeric,
  default_revision_rounds int,
  formality int DEFAULT 50 CHECK (formality >= 0 AND formality <= 100),
  playfulness int DEFAULT 50 CHECK (playfulness >= 0 AND playfulness <= 100),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_workspace_config_workspace_id ON workspace_config(workspace_id);

-- Integrations table
CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_name text NOT NULL,
  status text,
  config jsonb,
  access_token_encrypted text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_integrations_workspace_id ON integrations(workspace_id);
CREATE INDEX idx_integrations_service_name ON integrations(workspace_id, service_name);

-- Enable RLS on all core tables
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;

-- RLS Policies for team_members
CREATE POLICY "Users can view team members in their workspace"
  ON team_members
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can insert team members"
  ON team_members
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

CREATE POLICY "Founders can update team members"
  ON team_members
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for workspaces
CREATE POLICY "Users can view their workspaces"
  ON workspaces
  FOR SELECT
  USING (
    id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

-- RLS Policies for workspace_config
CREATE POLICY "Workspace members can view config"
  ON workspace_config
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can update config"
  ON workspace_config
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for integrations
CREATE POLICY "Workspace members can view integrations"
  ON integrations
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can manage integrations"
  ON integrations
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

CREATE POLICY "Founders can update integrations"
  ON integrations
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RPC function to create workspace
CREATE OR REPLACE FUNCTION create_workspace(
  workspace_name text,
  workspace_slug text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
BEGIN
  -- Create the workspace
  INSERT INTO workspaces (name, slug)
  VALUES (workspace_name, workspace_slug)
  RETURNING id INTO v_workspace_id;

  -- Create team member record for the calling user as founder
  INSERT INTO team_members (workspace_id, user_id, role, email, display_name)
  VALUES (
    v_workspace_id,
    auth.uid(),
    'founder',
    (SELECT email FROM auth.users WHERE id = auth.uid()),
    (SELECT raw_user_meta_data->>'display_name' FROM auth.users WHERE id = auth.uid())
  );

  -- Create default workspace config
  INSERT INTO workspace_config (workspace_id, formality, playfulness)
  VALUES (v_workspace_id, 50, 50);

  RETURN v_workspace_id;
END;
$$;
