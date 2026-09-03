-- Close the remaining authenticated-user policies inherited from the original
-- Kit.Studio schema. These tables have no workspace_id and are written only by
-- trusted service-role code, so they must never be reachable through the public
-- Data API by anon/authenticated sessions.
--
-- A restrictive false policy wins even while the legacy permissive policies
-- remain in the baseline. service_role and database owners bypass RLS.

begin;

create policy "Deny API access (service-only)" on public.artifacts
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.bible_versions
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.character_sheets
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.delivery_specs
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.edit_decisions
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.gates
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.generation_tasks
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.intake_messages
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.intake_sessions
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.model_catalog
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.model_research_log
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.model_scores
  as restrictive for all to public using (false) with check (false);
create policy "Deny API access (service-only)" on public.storyboard_panels
  as restrictive for all to public using (false) with check (false);

commit;
