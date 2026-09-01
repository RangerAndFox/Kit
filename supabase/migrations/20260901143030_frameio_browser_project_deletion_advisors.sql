create index if not exists frameio_project_deletion_jobs_workspace_idx
  on public.frameio_project_deletion_jobs(workspace_id);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'frameio_project_deletion_jobs'
      and policyname = 'frameio_project_deletion_jobs_service_only'
  ) then
    create policy frameio_project_deletion_jobs_service_only
      on public.frameio_project_deletion_jobs
      for all to public
      using (false)
      with check (false);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'frameio_workers'
      and policyname = 'frameio_workers_service_only'
  ) then
    create policy frameio_workers_service_only
      on public.frameio_workers
      for all to public
      using (false)
      with check (false);
  end if;
end
$$;
