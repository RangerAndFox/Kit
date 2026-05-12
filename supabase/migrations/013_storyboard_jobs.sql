-- ============================================================
-- 013: Storyboard Jobs
--
-- Checkpoint table for the storyboard provisioner. Every storyboard
-- creation persists its parsed frames here BEFORE calling Boords, so
-- a failure mid-create can be resumed via `/storyboard resume <jobId>`.
--
-- On success the row's status flips to 'complete' and boords_storyboard_id
-- is populated. On failure the row sits as 'failed' until resumed or
-- garbage-collected.
-- ============================================================

CREATE TABLE IF NOT EXISTS storyboard_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id text,                 -- Slack user id (we don't always have an auth uuid here)
  channel_id text,              -- Slack channel to post the result into
  project_name text NOT NULL,
  -- Parsed Boords frame array: [{label, sound, action, duration}, ...]
  frames jsonb NOT NULL,
  -- How far into `frames` we've successfully sent to Boords.
  -- 0 on a fresh job, frames.length on a complete job.
  last_frame_index int NOT NULL DEFAULT 0,
  -- 'pending' | 'in_progress' | 'complete' | 'failed'
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'complete', 'failed')),
  -- Mirror of the modal inputs so a resume can recreate the storyboard
  -- with the same description / aspect ratio / seconds per frame.
  aspect_ratio text,
  seconds_per_frame int,
  video_style text,
  mode_used text,
  -- Populated on the first successful create call; on resume we append
  -- to this storyboard instead of creating a new one.
  boords_storyboard_id text,
  boords_url text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storyboard_jobs_user
  ON storyboard_jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storyboard_jobs_status
  ON storyboard_jobs(status, created_at DESC);
