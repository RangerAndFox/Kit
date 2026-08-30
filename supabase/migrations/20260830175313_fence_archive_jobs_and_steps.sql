-- Fenced leases for archive jobs and provider steps. Inngest retries, Slack
-- retries, and rolling deployments may overlap; only the current lease owner
-- may mutate the job or finish a provider step.
begin;

alter table public.archive_jobs
  add column claim_token uuid,
  add column claimed_by text,
  add column claimed_at timestamptz;

alter table public.archive_job_steps
  add column claim_token uuid,
  add column claimed_by text,
  add column claimed_at timestamptz;

create or replace function public.acquire_archive_job_lease(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 7200
)
returns setof public.archive_jobs
language sql
security invoker
set search_path = public
as $$
  update public.archive_jobs
    set claim_token = gen_random_uuid(),
        claimed_by = p_worker_id,
        claimed_at = now(),
        updated_at = now()
    where id = p_job_id
      and status in (
        'queued', 'validating', 'preparing_media', 'uploading_vimeo',
        'creating_wordpress', 'creating_buffer', 'preparing_behance'
      )
      and (
        claim_token is null
        or claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 300))
      )
    returning *;
$$;

create or replace function public.claim_archive_step(
  p_job_id uuid,
  p_step_name text,
  p_worker_id text,
  p_lease_seconds integer default 7200
)
returns setof public.archive_job_steps
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_step public.archive_job_steps%rowtype;
begin
  insert into public.archive_job_steps(job_id, step_name, status)
    values (p_job_id, p_step_name, 'pending')
    on conflict (job_id, step_name) do nothing;

  select * into v_step
    from public.archive_job_steps
    where job_id = p_job_id and step_name = p_step_name
    for update;

  if v_step.status in ('complete', 'skipped') then
    return next v_step;
    return;
  end if;
  if v_step.status = 'running'
     and v_step.claim_token is not null
     and v_step.claimed_at >= now() - make_interval(secs => greatest(p_lease_seconds, 300)) then
    return;
  end if;

  update public.archive_job_steps
    set status = 'running',
        attempt = attempt + 1,
        claim_token = gen_random_uuid(),
        claimed_by = p_worker_id,
        claimed_at = now(),
        error = null,
        started_at = now(),
        completed_at = null,
        updated_at = now()
    where id = v_step.id
    returning * into v_step;
  return next v_step;
end;
$$;

create or replace function public.finish_archive_step_fenced(
  p_job_id uuid,
  p_step_name text,
  p_claim_token uuid,
  p_status text,
  p_result jsonb default '{}'::jsonb,
  p_error text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_status not in ('complete', 'failed', 'skipped') then
    raise exception 'Invalid archive step terminal status';
  end if;
  update public.archive_job_steps
    set status = p_status,
        result = coalesce(p_result, '{}'::jsonb),
        error = p_error,
        completed_at = now(),
        claim_token = null,
        claimed_by = null,
        claimed_at = null,
        updated_at = now()
    where job_id = p_job_id
      and step_name = p_step_name
      and status = 'running'
      and claim_token = p_claim_token;
  return found;
end;
$$;

revoke all on function public.acquire_archive_job_lease(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.claim_archive_step(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.finish_archive_step_fenced(uuid, text, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.acquire_archive_job_lease(uuid, text, integer) to service_role;
grant execute on function public.claim_archive_step(uuid, text, text, integer) to service_role;
grant execute on function public.finish_archive_step_fenced(uuid, text, uuid, text, jsonb, text) to service_role;

commit;
