-- Make the projects aggregate a complete deletion boundary.
--
-- The workspace/project consistency migration added a second FK to many child
-- tables without an ON DELETE action. That NO ACTION constraint overrode the
-- intended CASCADE/SET NULL behavior of the original project_id FK and made an
-- administrator-confirmed project deletion stop at the first populated table.
begin;

do $migration$
declare
  table_name text;
begin
  -- These rows are owned by a project and must leave with it. Recreate both
  -- constraints so the simple and workspace-consistency FKs agree.
  foreach table_name in array array[
    'action_breakdowns', 'archive_activity', 'archive_jobs', 'autonomy_settings',
    'behance_draft_jobs', 'call_classifications', 'deliverables', 'feedback_items',
    'financial_entries', 'generated_documents', 'kit_actions', 'milestones',
    'permission_requests', 'pilots', 'project_access', 'project_documents',
    'project_update_requests', 'scope_events', 'sentiment_snapshots',
    'time_entries', 'workback_schedules'
  ] loop
    execute format(
      'alter table public.%I drop constraint if exists %I',
      table_name,
      table_name || '_project_id_fkey'
    );
    execute format(
      'alter table public.%I add constraint %I foreign key (project_id) references public.projects(id) on delete cascade',
      table_name,
      table_name || '_project_id_fkey'
    );
    execute format(
      'alter table public.%I drop constraint if exists %I',
      table_name,
      table_name || '_workspace_project_fkey'
    );
    execute format(
      'alter table public.%I add constraint %I foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete cascade',
      table_name,
      table_name || '_workspace_project_fkey'
    );
  end loop;

  -- These records can outlive a project. Preserve their workspace identity and
  -- clear only project_id when the referenced project is removed.
  foreach table_name in array array[
    'brains', 'call_transcripts', 'project_creation_requests'
  ] loop
    execute format(
      'alter table public.%I drop constraint if exists %I',
      table_name,
      table_name || '_project_id_fkey'
    );
    execute format(
      'alter table public.%I add constraint %I foreign key (project_id) references public.projects(id) on delete set null',
      table_name,
      table_name || '_project_id_fkey'
    );
    execute format(
      'alter table public.%I drop constraint if exists %I',
      table_name,
      table_name || '_workspace_project_fkey'
    );
    execute format(
      'alter table public.%I add constraint %I foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete set null (project_id)',
      table_name,
      table_name || '_workspace_project_fkey'
    );
  end loop;
end
$migration$;

-- Document-level audit/access rows cannot survive their source document.
alter table public.call_classifications
  drop constraint if exists call_classifications_document_id_fkey;
alter table public.call_classifications
  add constraint call_classifications_document_id_fkey
  foreign key (document_id) references public.project_documents(id) on delete cascade;

alter table public.founder_content_access
  drop constraint if exists founder_content_access_document_id_fkey;
alter table public.founder_content_access
  add constraint founder_content_access_document_id_fkey
  foreign key (document_id) references public.project_documents(id) on delete cascade;

commit;
