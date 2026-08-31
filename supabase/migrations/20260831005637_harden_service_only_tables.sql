-- Make service-only tables explicitly deny all API roles.
-- service_role and database owners bypass RLS for backend operations.

alter extension vector set schema extensions;

alter function public.pilots_evidence_immutable() set search_path = public, pg_temp;
alter function public.pilots_generation_guard() set search_path = public, pg_temp;
alter function public.specs_backlog_commit_folder(text, bigint, text, text[]) set search_path = public, pg_temp;
alter function public.specs_backlog_mark_complete_if_empty(text, bigint) set search_path = public, pg_temp;

-- Keep RLS helper functions executable by API roles without exposing them as RPC endpoints.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

alter function public.get_user_tier(uuid) set schema private;
alter function public.get_user_workspace_ids() set schema private;
alter function public.is_founder(uuid) set schema private;
alter function public.is_founder_or_producer(uuid) set schema private;

revoke all on function private.get_user_tier(uuid) from public, anon, authenticated;
revoke all on function private.get_user_workspace_ids() from public, anon, authenticated;
revoke all on function private.is_founder(uuid) from public, anon, authenticated;
revoke all on function private.is_founder_or_producer(uuid) from public, anon, authenticated;

grant execute on function private.get_user_tier(uuid) to anon, authenticated;
grant execute on function private.get_user_workspace_ids() to anon, authenticated;
grant execute on function private.is_founder(uuid) to anon, authenticated;
grant execute on function private.is_founder_or_producer(uuid) to anon, authenticated;

create policy "Deny API access (service-only)" on public.accessibility_jobs
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.archive_job_steps
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.archive_jobs
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.behance_draft_jobs
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.behance_workers
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.birthdays
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.brain_revisions
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.brain_scavenger_candidates
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.brains
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.call_transcripts
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.conversation_state
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.cron_heartbeats
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.daily_hours_checkins
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.daily_hours_reminders
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.delivery_profiles
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.delivery_spec_intake
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.delivery_specs_scan_frontier
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.delivery_specs_scan_state
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.dropbox_event_inbox
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.dropbox_state
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.elevenlabs_studio_jobs
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.elevenlabs_workers
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.frameio_token_state
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.freelancer_onboardings
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.freelancer_paperwork
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.harvest_user_map
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.hours_missing_alerts
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.managed_agent_registry
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.meeting_briefing_deliveries
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.meeting_briefings
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.pilot_evidence
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.pilot_generations
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.pilot_material_maps
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.pilot_references
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.pilot_validations
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.pilots
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.plaud_token_state
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.project_control_bindings
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.project_control_canvases
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.project_creation_requests
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.project_provisioning_steps
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.project_settings
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.project_share_events
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.project_update_requests
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.project_update_steps
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.render_jobs
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.render_workers
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.review_extractions
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.seen_dropbox_files
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.sheet_sync_state
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.staff
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.staff_time_off
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.storyboard_jobs
  as restrictive for all to public
  using (false)
  with check (false);

create policy "Deny API access (service-only)" on public.system_health
  as restrictive for all to public
  using (false)
  with check (false);
