create unique index if not exists projects_workspace_id_id_key
  on public.projects (workspace_id, id);

do $migration$
declare
  table_name text;
  constraint_name text;
begin
  foreach table_name in array array[
    'action_breakdowns', 'archive_activity', 'archive_jobs', 'autonomy_settings',
    'behance_draft_jobs', 'brains', 'call_classifications', 'call_transcripts',
    'deliverables', 'feedback_items', 'financial_entries', 'generated_documents',
    'kit_actions', 'milestones', 'permission_requests', 'pilots', 'project_access',
    'project_creation_requests', 'project_documents', 'project_update_requests',
    'scope_events', 'sentiment_snapshots', 'time_entries', 'workback_schedules'
  ] loop
    constraint_name := table_name || '_workspace_project_fkey';
    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', table_name)::regclass
        and conname = constraint_name
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (workspace_id, project_id) references public.projects(workspace_id, id) not valid',
        table_name,
        constraint_name
      );
      execute format(
        'alter table public.%I validate constraint %I',
        table_name,
        constraint_name
      );
    end if;
  end loop;
end
$migration$;
