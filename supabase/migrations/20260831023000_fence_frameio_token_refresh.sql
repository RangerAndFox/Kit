-- Fence the singleton Adobe/Frame.io rotating-token refresh lease.
-- A stale holder must never overwrite or release credentials produced by a
-- newer holder after the original lease expires.

alter table public.frameio_token_state
  add column if not exists refresh_holder uuid,
  add column if not exists refresh_fence bigint not null default 0;

create or replace function public.claim_frameio_token_refresh(p_holder uuid, p_lease_seconds integer default 30)
returns table (claimed boolean, fence bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fence bigint;
begin
  update public.frameio_token_state
  set refresh_holder = p_holder,
      refresh_fence = refresh_fence + 1,
      refreshing_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
      updated_at = now()
  where id = 'singleton'
    and (refresh_holder is null or refreshing_until is null or refreshing_until < now())
  returning refresh_fence into v_fence;

  return query select v_fence is not null, v_fence;
end;
$$;

create or replace function public.finish_frameio_token_refresh(
  p_holder uuid,
  p_fence bigint,
  p_refresh_token text,
  p_access_token text,
  p_access_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.frameio_token_state
  set refresh_token = p_refresh_token,
      access_token = p_access_token,
      access_expires_at = p_access_expires_at,
      refresh_holder = null,
      refreshing_until = null,
      updated_at = now()
  where id = 'singleton'
    and refresh_holder = p_holder
    and refresh_fence = p_fence
    and refreshing_until >= now();
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.release_frameio_token_refresh(p_holder uuid, p_fence bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.frameio_token_state
  set refresh_holder = null,
      refreshing_until = null,
      updated_at = now()
  where id = 'singleton'
    and refresh_holder = p_holder
    and refresh_fence = p_fence;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.claim_frameio_token_refresh(uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_frameio_token_refresh(uuid, bigint, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.release_frameio_token_refresh(uuid, bigint) from public, anon, authenticated;
grant execute on function public.claim_frameio_token_refresh(uuid, integer) to service_role;
grant execute on function public.finish_frameio_token_refresh(uuid, bigint, text, text, timestamptz) to service_role;
grant execute on function public.release_frameio_token_refresh(uuid, bigint) to service_role;

