create index if not exists archive_jobs_workspace_idx
  on public.archive_jobs (workspace_id, created_at desc);
