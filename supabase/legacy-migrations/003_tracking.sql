-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Time entries table
CREATE TABLE time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  hours numeric NOT NULL,
  category text,
  description text,
  date date NOT NULL,
  billable boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_time_entries_workspace_id ON time_entries(workspace_id);
CREATE INDEX idx_time_entries_project_id ON time_entries(project_id);
CREATE INDEX idx_time_entries_team_member_id ON time_entries(team_member_id);
CREATE INDEX idx_time_entries_date ON time_entries(workspace_id, date);

-- Feedback items table
CREATE TABLE feedback_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source text,
  content text NOT NULL,
  sentiment text CHECK (sentiment IN ('positive', 'neutral', 'negative', 'mixed')),
  priority text CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL CHECK (status IN ('new', 'acknowledged', 'in_progress', 'resolved')),
  source_url text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at timestamp with time zone
);

CREATE INDEX idx_feedback_items_workspace_id ON feedback_items(workspace_id);
CREATE INDEX idx_feedback_items_project_id ON feedback_items(project_id);
CREATE INDEX idx_feedback_items_status ON feedback_items(workspace_id, status);
CREATE INDEX idx_feedback_items_priority ON feedback_items(workspace_id, priority);

-- Project documents table with vector embeddings
CREATE TABLE project_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text,
  doc_type text,
  visibility_tier text NOT NULL CHECK (visibility_tier IN ('team', 'founder')) DEFAULT 'team',
  embedding vector(1536),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_project_documents_workspace_id ON project_documents(workspace_id);
CREATE INDEX idx_project_documents_project_id ON project_documents(project_id);
CREATE INDEX idx_project_documents_visibility ON project_documents(workspace_id, visibility_tier);
CREATE INDEX idx_project_documents_embedding ON project_documents USING ivfflat (embedding vector_cosine_ops);

-- Sentiment snapshots table
CREATE TABLE sentiment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  score numeric NOT NULL,
  summary text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_sentiment_snapshots_workspace_id ON sentiment_snapshots(workspace_id);
CREATE INDEX idx_sentiment_snapshots_project_id ON sentiment_snapshots(project_id);
CREATE INDEX idx_sentiment_snapshots_created_at ON sentiment_snapshots(project_id, created_at DESC);

-- Scope events table
CREATE TABLE scope_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  description text,
  budget_impact numeric,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_scope_events_workspace_id ON scope_events(workspace_id);
CREATE INDEX idx_scope_events_project_id ON scope_events(project_id);
CREATE INDEX idx_scope_events_created_at ON scope_events(project_id, created_at DESC);

-- Enable RLS on all tracking tables
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sentiment_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_events ENABLE ROW LEVEL SECURITY;

-- RLS Policies for time_entries
CREATE POLICY "Workspace members can view time entries"
  ON time_entries
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert their own time entries"
  ON time_entries
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
    AND
    team_member_id IN (
      SELECT id FROM team_members WHERE user_id = auth.uid()
    )
  );

-- RLS Policies for feedback_items
CREATE POLICY "Workspace members can view feedback"
  ON feedback_items
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Workspace members can create feedback"
  ON feedback_items
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

-- RLS Policies for project_documents - dual-layer security
CREATE POLICY "Workspace members can view team documents"
  ON project_documents
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
    AND
    (visibility_tier = 'team' OR auth.uid() IN (
      SELECT user_id FROM team_members WHERE role = 'founder' AND workspace_id = project_documents.workspace_id
    ))
  );

CREATE POLICY "Workspace members can create documents"
  ON project_documents
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

-- RLS Policies for sentiment_snapshots
CREATE POLICY "Workspace members can view sentiment"
  ON sentiment_snapshots
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders can create sentiment snapshots"
  ON sentiment_snapshots
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role = 'founder'
    )
  );

-- RLS Policies for scope_events
CREATE POLICY "Workspace members can view scope events"
  ON scope_events
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM team_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Founders and producers can create scope events"
  ON scope_events
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT tm.workspace_id FROM team_members tm
      WHERE tm.user_id = auth.uid() AND tm.role IN ('founder', 'producer')
    )
  );

-- RPC function for semantic search
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5,
  p_workspace_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_user_role text DEFAULT 'artist'
)
RETURNS TABLE (id uuid, title text, content text, doc_type text, project_id uuid, similarity float)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pd.id,
    pd.title,
    pd.content,
    pd.doc_type,
    pd.project_id,
    (1 - (pd.embedding <=> query_embedding))::float as similarity
  FROM project_documents pd
  WHERE
    (p_workspace_id IS NULL OR pd.workspace_id = p_workspace_id)
    AND
    (p_project_id IS NULL OR pd.project_id = p_project_id)
    AND
    (
      pd.visibility_tier = 'team'
      OR
      (pd.visibility_tier = 'founder' AND p_user_role = 'founder')
    )
    AND
    (1 - (pd.embedding <=> query_embedding)) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
