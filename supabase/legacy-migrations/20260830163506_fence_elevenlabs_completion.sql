create or replace function public.complete_elevenlabs_studio_job(
  p_job_id uuid,
  p_worker_id text,
  p_claimed_at timestamptz,
  p_project_id text,
  p_url text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_storyboard_job_id uuid;
begin
  update public.elevenlabs_studio_jobs
  set status = 'complete',
      studio_project_id = p_project_id,
      studio_url = p_url,
      error = null,
      completed_at = now(),
      heartbeat_at = now(),
      updated_at = now()
  where id = p_job_id
    and claimed_by = p_worker_id
    and claimed_at = p_claimed_at
    and status in ('claimed', 'opening_studio', 'filling_project', 'saving_draft')
  returning storyboard_job_id into v_storyboard_job_id;

  if v_storyboard_job_id is null then
    return false;
  end if;

  update public.storyboard_jobs
  set elevenlabs_project_id = p_project_id,
      elevenlabs_url = p_url,
      elevenlabs_status = 'complete',
      elevenlabs_error = null,
      updated_at = now()
  where id = v_storyboard_job_id;

  return true;
end;
$$;

revoke all on function public.complete_elevenlabs_studio_job(uuid, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.complete_elevenlabs_studio_job(uuid, text, timestamptz, text, text) to service_role;

comment on function public.complete_elevenlabs_studio_job(uuid, text, timestamptz, text, text) is
  'Atomically fences a Studio worker attempt and checkpoints the related storyboard job.';
