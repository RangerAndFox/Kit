-- Farm status table
CREATE TABLE farm_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_name text NOT NULL,
  status text,
  job_name text,
  progress numeric,
  gpu_temp numeric,
  reported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_farm_status_workspace_id ON farm_status(workspace_id);
CREATE INDEX idx_farm_status_node_name ON farm_status(workspace_id, node_name);
CREATE INDEX idx_farm_status_reported_at ON farm_status(workspace_id, reported_at DESC);

-- Archive activity table
CREATE TABLE archive_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  action text NOT NULL,
  path text,
  size_bytes bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_archive_activity_workspace_id ON archive_activity(workspace_id);
CREATE INDEX idx_archive_activity_project_id ON archive_activity(project_id);
CREATE INDEX idx_archive_activity_created_at ON archive_activity(workspace_id, created_at DESC);

-- Financial entries table
CREATE TABLE financial_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  entry_type text NOT NULL CHECK (entry_type IN ('invoice', 'expense', 'payment')),
  amount numeric NOT NULL,
  description text,
  vendor text,
  due_date date,
  paid_date date,
  status text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_financial_entries_workspace_id ON financial_entries(workspace_id);
CREATE INDEX idx_financial_entries_project_id ON financial_entries(project_id);
CREATE INDEX idx_financial_entries_entry_type ON financial_entries(workspace_id, entry_type);
CREATE INDEX idx_financial_entries_status ON financial_entries(workspace_id, status);
CREATE INDEX idx_financial_entries_created_at ON financial_entries(workspace_id, created_at DESC);

-- Enable RLS on all studio ops tables
ALTER TABLE farm_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_entries ENABLE ROW LEVEL SECURITY;

-- RLS Policies for farm_status
CREATE POLICY "Workspace members can view farm status"
  ON farm_status
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can create farm status"
  ON farm_status
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

CREATE POLICY "Founders can update farm status"
  ON farm_status
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for archive_activity
CREATE POLICY "Workspace members can view archive activity"
  ON archive_activity
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can create archive activity"
  ON archive_activity
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for financial_entries
CREATE POLICY "Workspace members can view financial entries"
  ON financial_entries
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can create financial entries"
  ON financial_entries
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

CREATE POLICY "Founders and producers can update financial entries"
  ON financial_entries
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );
