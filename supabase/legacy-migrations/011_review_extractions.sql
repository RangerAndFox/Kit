-- Review note extractions from Frame.io
-- Stores extracted comment data so Figma boards can be generated on demand

CREATE TABLE IF NOT EXISTS review_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_id text NOT NULL,
  asset_name text NOT NULL,
  source_url text,
  slack_channel_id text,
  slack_thread_ts text,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_comments integer DEFAULT 0,
  thumbnails_found integer DEFAULT 0,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_extractions_asset
  ON review_extractions(asset_id);
CREATE INDEX IF NOT EXISTS idx_review_extractions_workspace
  ON review_extractions(workspace_id);
