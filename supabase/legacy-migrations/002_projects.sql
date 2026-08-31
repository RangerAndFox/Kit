-- Projects table
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  client_name text,
  project_code text,
  project_type text,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'on_hold', 'wrapped', 'archived')),
  phase text,
  start_date date,
  due_date date,
  budget_total numeric,
  budget_spent numeric DEFAULT 0,
  margin_target numeric,
  revision_rounds_total int,
  revision_rounds_used int DEFAULT 0,
  brief text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_projects_workspace_id ON projects(workspace_id);
CREATE INDEX idx_projects_status ON projects(workspace_id, status);
CREATE INDEX idx_projects_created_at ON projects(workspace_id, created_at DESC);

-- Project access table
CREATE TABLE project_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  granted_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE(project_id, team_member_id)
);

CREATE INDEX idx_project_access_project_id ON project_access(project_id);
CREATE INDEX idx_project_access_team_member_id ON project_access(team_member_id);

-- Milestones table
CREATE TABLE milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  due_date date,
  status text NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'overdue')),
  sort_order int,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_milestones_workspace_id ON milestones(workspace_id);
CREATE INDEX idx_milestones_project_id ON milestones(project_id);
CREATE INDEX idx_milestones_status ON milestones(project_id, status);

-- Deliverables table
CREATE TABLE deliverables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('not_started', 'in_progress', 'internal_review', 'client_review', 'approved', 'delivered')),
  delivery_url text,
  specs jsonb,
  sort_order int,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_deliverables_workspace_id ON deliverables(workspace_id);
CREATE INDEX idx_deliverables_project_id ON deliverables(project_id);
CREATE INDEX idx_deliverables_status ON deliverables(project_id, status);

-- Client profiles table
CREATE TABLE client_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  contact_email text,
  contact_name text,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_client_profiles_workspace_id ON client_profiles(workspace_id);

-- Enable RLS on all projects tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies for projects
CREATE POLICY "Workspace members can view projects"
  ON projects
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can insert projects"
  ON projects
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

CREATE POLICY "Founders and producers can update projects"
  ON projects
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

-- RLS Policies for project_access
CREATE POLICY "Workspace members can view access"
  ON project_access
  FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM projects WHERE workspace_id IN (
        SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Founders and producers can manage access"
  ON project_access
  FOR INSERT
  WITH CHECK (
    project_id IN (
      SELECT p.id FROM projects p
      WHERE p.workspace_id IN (
        SELECT tm.workspace_id FROM team_members tm
        WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
      )
    )
  );

-- RLS Policies for milestones
CREATE POLICY "Workspace members can view milestones"
  ON milestones
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can manage milestones"
  ON milestones
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

CREATE POLICY "Founders and producers can update milestones"
  ON milestones
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

-- RLS Policies for deliverables
CREATE POLICY "Workspace members can view deliverables"
  ON deliverables
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can manage deliverables"
  ON deliverables
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

CREATE POLICY "Founders and producers can update deliverables"
  ON deliverables
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

-- RLS Policies for client_profiles
CREATE POLICY "Workspace members can view client profiles"
  ON client_profiles
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can manage client profiles"
  ON client_profiles
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

CREATE POLICY "Founders and producers can update client profiles"
  ON client_profiles
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );
