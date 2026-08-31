-- Kit actions table
CREATE TABLE kit_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  title text NOT NULL,
  description text,
  priority text CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'dismissed', 'auto_completed')) DEFAULT 'pending',
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at timestamp with time zone
);

CREATE INDEX idx_kit_actions_workspace_id ON kit_actions(workspace_id);
CREATE INDEX idx_kit_actions_project_id ON kit_actions(project_id);
CREATE INDEX idx_kit_actions_status ON kit_actions(workspace_id, status);
CREATE INDEX idx_kit_actions_priority ON kit_actions(workspace_id, priority);
CREATE INDEX idx_kit_actions_created_at ON kit_actions(workspace_id, created_at DESC);

-- Action breakdowns table
CREATE TABLE action_breakdowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  call_type text,
  summary text,
  action_items jsonb,
  draft_email text,
  transcript_excerpt text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_action_breakdowns_workspace_id ON action_breakdowns(workspace_id);
CREATE INDEX idx_action_breakdowns_project_id ON action_breakdowns(project_id);
CREATE INDEX idx_action_breakdowns_created_at ON action_breakdowns(workspace_id, created_at DESC);

-- Agent runs table
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_type text NOT NULL,
  status text NOT NULL,
  actions_created int DEFAULT 0,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  error text
);

CREATE INDEX idx_agent_runs_workspace_id ON agent_runs(workspace_id);
CREATE INDEX idx_agent_runs_status ON agent_runs(workspace_id, status);
CREATE INDEX idx_agent_runs_completed_at ON agent_runs(workspace_id, completed_at DESC);

-- Call classifications table
CREATE TABLE call_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  call_type text NOT NULL,
  stream text NOT NULL CHECK (stream IN ('team', 'founder')),
  source text,
  participants jsonb,
  classified_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_call_classifications_workspace_id ON call_classifications(workspace_id);
CREATE INDEX idx_call_classifications_project_id ON call_classifications(project_id);
CREATE INDEX idx_call_classifications_classified_at ON call_classifications(workspace_id, classified_at DESC);

-- Enable RLS on all agent tables
ALTER TABLE kit_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_breakdowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_classifications ENABLE ROW LEVEL SECURITY;

-- RLS Policies for kit_actions
CREATE POLICY "Workspace members can view actions"
  ON kit_actions
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can manage actions"
  ON kit_actions
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

CREATE POLICY "Founders can update actions"
  ON kit_actions
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for action_breakdowns
CREATE POLICY "Workspace members can view breakdowns"
  ON action_breakdowns
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can create breakdowns"
  ON action_breakdowns
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for agent_runs
CREATE POLICY "Workspace members can view agent runs"
  ON agent_runs
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can create agent runs"
  ON agent_runs
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for call_classifications
CREATE POLICY "Workspace members can view classifications"
  ON call_classifications
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can create classifications"
  ON call_classifications
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );
