alter table public.render_jobs
  add column if not exists deadline_claim_token uuid,
  add column if not exists deadline_lease_until timestamptz;

create or replace function public.claim_deadline_parent(p_worker text, p_lease_seconds integer default 300)
returns setof public.render_jobs
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  select id into v_id from public.render_jobs
  where job_type='ae_render' and render_backend='deadline' and status='processing'
    and (deadline_claim_token is null or deadline_lease_until < now())
  order by created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  return query update public.render_jobs set
    claimed_by=p_worker, claimed_at=now(), deadline_claim_token=gen_random_uuid(),
    deadline_lease_until=now()+make_interval(secs=>greatest(p_lease_seconds,60)), updated_at=now()
  where id=v_id returning *;
end;
$$;

revoke all on function public.claim_deadline_parent(text, integer) from public, anon, authenticated;
grant execute on function public.claim_deadline_parent(text, integer) to service_role;

