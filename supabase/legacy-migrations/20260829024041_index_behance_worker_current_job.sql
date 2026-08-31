create index if not exists behance_workers_current_job_idx
  on public.behance_workers (current_job_id)
  where current_job_id is not null;
