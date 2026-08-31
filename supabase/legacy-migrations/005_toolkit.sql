-- Workback schedules table
CREATE TABLE workback_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  schedule jsonb,
  confidence_score numeric,
  risk_flags jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_workback_schedules_workspace_id ON workback_schedules(workspace_id);
CREATE INDEX idx_workback_schedules_project_id ON workback_schedules(project_id);
CREATE INDEX idx_workback_schedules_created_at ON workback_schedules(project_id, created_at DESC);

-- Generated documents table
CREATE TABLE generated_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  content text,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_generated_documents_workspace_id ON generated_documents(workspace_id);
CREATE INDEX idx_generated_documents_project_id ON generated_documents(project_id);
CREATE INDEX idx_generated_documents_doc_type ON generated_documents(workspace_id, doc_type);
CREATE INDEX idx_generated_documents_created_at ON generated_documents(project_id, created_at DESC);

-- Templates table
CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_type text NOT NULL,
  name text NOT NULL,
  content text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_templates_workspace_id ON templates(workspace_id);
CREATE INDEX idx_templates_template_type ON templates(workspace_id, template_type);

-- Pitch log table
CREATE TABLE pitch_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_name text NOT NULL,
  project_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'won', 'lost')),
  value numeric,
  submitted_at timestamp with time zone,
  decided_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_pitch_log_workspace_id ON pitch_log(workspace_id);
CREATE INDEX idx_pitch_log_status ON pitch_log(workspace_id, status);
CREATE INDEX idx_pitch_log_submitted_at ON pitch_log(workspace_id, submitted_at DESC);

-- Enable RLS on all toolkit tables
ALTER TABLE workback_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitch_log ENABLE ROW LEVEL SECURITY;

-- RLS Policies for workback_schedules
CREATE POLICY "Workspace members can view schedules"
  ON workback_schedules
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can create schedules"
  ON workback_schedules
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

-- RLS Policies for generated_documents
CREATE POLICY "Workspace members can view generated documents"
  ON generated_documents
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can create documents"
  ON generated_documents
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

-- RLS Policies for templates
CREATE POLICY "Workspace members can view templates"
  ON templates
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can create templates"
  ON templates
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

CREATE POLICY "Founders can update templates"
  ON templates
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for pitch_log
CREATE POLICY "Workspace members can view pitch log"
  ON pitch_log
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can create pitch entries"
  ON pitch_log
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

CREATE POLICY "Founders and producers can update pitch entries"
  ON pitch_log
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );
