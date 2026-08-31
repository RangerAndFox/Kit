-- Permission requests table
CREATE TABLE permission_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  requested_scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'granted', 'denied')) DEFAULT 'pending',
  responder_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  response_message text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at timestamp with time zone
);

CREATE INDEX idx_permission_requests_workspace_id ON permission_requests(workspace_id);
CREATE INDEX idx_permission_requests_requester_id ON permission_requests(requester_id);
CREATE INDEX idx_permission_requests_status ON permission_requests(workspace_id, status);
CREATE INDEX idx_permission_requests_created_at ON permission_requests(workspace_id, created_at DESC);

-- Daily task cards table
CREATE TABLE daily_task_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  card_date date NOT NULL,
  tasks jsonb,
  status text NOT NULL CHECK (status IN ('draft', 'pending_review', 'approved', 'distributed', 'completed')) DEFAULT 'draft',
  reviewer_notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  distributed_at timestamp with time zone
);

CREATE INDEX idx_daily_task_cards_workspace_id ON daily_task_cards(workspace_id);
CREATE INDEX idx_daily_task_cards_project_id ON daily_task_cards(project_id);
CREATE INDEX idx_daily_task_cards_team_member_id ON daily_task_cards(team_member_id);
CREATE INDEX idx_daily_task_cards_card_date ON daily_task_cards(workspace_id, card_date DESC);
CREATE INDEX idx_daily_task_cards_status ON daily_task_cards(workspace_id, status);

-- Autonomy settings table
CREATE TABLE autonomy_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  autonomy_level text NOT NULL CHECK (autonomy_level IN ('ask_first', 'auto_draft', 'auto_send')) DEFAULT 'ask_first',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_autonomy_settings_workspace_id ON autonomy_settings(workspace_id);
CREATE INDEX idx_autonomy_settings_project_id ON autonomy_settings(project_id);
CREATE INDEX idx_autonomy_settings_action_type ON autonomy_settings(workspace_id, action_type);

-- Transcription routing table
CREATE TABLE transcription_routing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_type text NOT NULL,
  pattern text NOT NULL,
  target_stream text NOT NULL CHECK (target_stream IN ('team', 'founder')),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_transcription_routing_workspace_id ON transcription_routing(workspace_id);
CREATE INDEX idx_transcription_routing_rule_type ON transcription_routing(workspace_id, rule_type);

-- Founder content access table
CREATE TABLE founder_content_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id uuid REFERENCES project_documents(id) ON DELETE CASCADE,
  action text NOT NULL,
  accessed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_founder_content_access_workspace_id ON founder_content_access(workspace_id);
CREATE INDEX idx_founder_content_access_user_id ON founder_content_access(user_id);
CREATE INDEX idx_founder_content_access_accessed_at ON founder_content_access(workspace_id, accessed_at DESC);

-- Enable RLS on all permissions tables
ALTER TABLE permission_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_task_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE autonomy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcription_routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_content_access ENABLE ROW LEVEL SECURITY;

-- RLS Policies for permission_requests
CREATE POLICY "Users can view their own permission requests"
  ON permission_requests
  FOR SELECT
  USING (
    requester_id IN (
      SELECT id FROM team_members WHERE user_id = auth.uid()
    )
    OR
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

CREATE POLICY "Team members can create permission requests"
  ON permission_requests
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can update permission requests"
  ON permission_requests
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for daily_task_cards
CREATE POLICY "Team members can view task cards"
  ON daily_task_cards
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Team members can create task cards"
  ON daily_task_cards
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can update task cards"
  ON daily_task_cards
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for autonomy_settings
CREATE POLICY "Workspace members can view autonomy settings"
  ON autonomy_settings
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can manage autonomy settings"
  ON autonomy_settings
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

CREATE POLICY "Founders can update autonomy settings"
  ON autonomy_settings
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for transcription_routing
CREATE POLICY "Workspace members can view routing"
  ON transcription_routing
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can manage routing"
  ON transcription_routing
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for founder_content_access
CREATE POLICY "Founders can view their own access logs"
  ON founder_content_access
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

CREATE POLICY "System can create access logs"
  ON founder_content_access
  FOR INSERT
  WITH CHECK (true);
