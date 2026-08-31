-- Per-project settings (Option B: a settings table keyed by project_id).
--
-- A missing row means "all defaults apply", so nothing needs to seed a row at
-- project-creation time — absence is the default. The first setting is the
-- Frame.io delivery-upload toggle: some projects don't use Frame.io for review,
-- so producers can turn the automatic Dropbox->Frame.io mirror off per project.
--
-- Future per-project toggles (auto-caption, delivery notify prefs, etc.) get
-- their own columns here.

CREATE TABLE IF NOT EXISTS project_settings (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  frameio_upload_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

COMMENT ON TABLE project_settings IS 'Per-project toggles. A missing row means defaults apply.';
COMMENT ON COLUMN project_settings.frameio_upload_enabled IS 'When false, the Dropbox->Frame.io delivery watcher skips mirroring this project''s delivery files; they stay in Dropbox only.';
COMMENT ON COLUMN project_settings.updated_by IS 'Slack user ID of whoever last changed a setting.';

-- Match the rest of the schema: RLS on, no policies. Kit reaches this table
-- only through the service-role client, which bypasses RLS; anon/authenticated
-- roles get no access.
ALTER TABLE project_settings ENABLE ROW LEVEL SECURITY;
