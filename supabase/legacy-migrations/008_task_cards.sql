-- Task cards table for daily task management
CREATE TABLE task_cards (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_type text NOT NULL,
  title text NOT NULL,
  description text,
  assigned_to uuid REFERENCES team_members(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'distributed', 'completed')) DEFAULT 'draft',
  priority text NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium',
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES milestones(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  approved_at timestamp with time zone,
  distributed_at timestamp with time zone
);

CREATE INDEX idx_task_cards_workspace_id ON task_cards(workspace_id);
CREATE INDEX idx_task_cards_project_id ON task_cards(project_id);
CREATE INDEX idx_task_cards_status ON task_cards(workspace_id, status);
CREATE INDEX idx_task_cards_priority ON task_cards(workspace_id, priority);
CREATE INDEX idx_task_cards_assigned_to ON task_cards(workspace_id, assigned_to);
CREATE INDEX idx_task_cards_created_at ON task_cards(workspace_id, created_at DESC);
CREATE INDEX idx_task_cards_date_status ON task_cards(workspace_id, DATE(created_at), status);

-- Enable RLS on task_cards
ALTER TABLE task_cards ENABLE ROW LEVEL SECURITY;

-- RLS Policies for task_cards
CREATE POLICY "Workspace members can view task cards"
  ON task_cards
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can create task cards"
  ON task_cards
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

CREATE POLICY "Founders and producers can update task cards"
  ON task_cards
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );
