-- Covering indexes for unindexed foreign keys (Supabase performance advisor).
--
-- All cheap at current row counts; these keep joins/cascades from degrading
-- as the tables grow. Only Kit-owned tables are touched (storyboard_panels /
-- generation_tasks etc. belong to a different app sharing this database).

CREATE INDEX IF NOT EXISTS action_breakdowns_approved_by_idx ON action_breakdowns (approved_by);
CREATE INDEX IF NOT EXISTS archive_activity_project_id_idx ON archive_activity (project_id);
CREATE INDEX IF NOT EXISTS autonomy_settings_project_id_idx ON autonomy_settings (project_id);
CREATE INDEX IF NOT EXISTS autonomy_settings_set_by_idx ON autonomy_settings (set_by);
CREATE INDEX IF NOT EXISTS brain_scavenger_candidates_source_doc_id_idx ON brain_scavenger_candidates (source_doc_id);
CREATE INDEX IF NOT EXISTS call_classifications_document_id_idx ON call_classifications (document_id);
CREATE INDEX IF NOT EXISTS daily_hours_checkins_staff_id_idx ON daily_hours_checkins (staff_id);
CREATE INDEX IF NOT EXISTS daily_task_cards_approved_by_idx ON daily_task_cards (approved_by);
CREATE INDEX IF NOT EXISTS feedback_items_assigned_to_idx ON feedback_items (assigned_to);
CREATE INDEX IF NOT EXISTS founder_content_access_document_id_idx ON founder_content_access (document_id);
CREATE INDEX IF NOT EXISTS freelancer_onboardings_artist_staff_id_idx ON freelancer_onboardings (artist_staff_id);
CREATE INDEX IF NOT EXISTS generated_documents_created_by_idx ON generated_documents (created_by);
CREATE INDEX IF NOT EXISTS integrations_connected_by_idx ON integrations (connected_by);
CREATE INDEX IF NOT EXISTS kit_actions_approved_by_idx ON kit_actions (approved_by);
CREATE INDEX IF NOT EXISTS meeting_briefings_project_id_idx ON meeting_briefings (project_id);
CREATE INDEX IF NOT EXISTS milestones_assigned_to_idx ON milestones (assigned_to);
CREATE INDEX IF NOT EXISTS permission_requests_project_id_idx ON permission_requests (project_id);
CREATE INDEX IF NOT EXISTS permission_requests_responded_by_idx ON permission_requests (responded_by);
CREATE INDEX IF NOT EXISTS render_jobs_profile_id_idx ON render_jobs (profile_id);
CREATE INDEX IF NOT EXISTS render_workers_current_job_id_idx ON render_workers (current_job_id);
CREATE INDEX IF NOT EXISTS scope_events_feedback_item_id_idx ON scope_events (feedback_item_id);
CREATE INDEX IF NOT EXISTS storyboard_jobs_workspace_id_idx ON storyboard_jobs (workspace_id);
