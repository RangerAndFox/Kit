-- Delivery — Per-project specs/ folder scan: make each backlog checkpoint a
-- single ownership-conditional transaction. Forward-only follow-up to 060.
--
-- WHY: 060's backlog re-asserted the lease (renewSpecsScanLeaseFenced) and THEN
-- ran separate enqueue / delete / complete statements. A stale invocation could
-- pass the renewal, lose its lease to a reclaim, and still mutate the frontier.
-- These functions fold the ownership check AND the mutation into one transaction
-- (holder+fence verified under a row lock on the singleton state row), so a
-- stale caller mutates nothing. 059/060 are untouched.

-- Atomically complete ONE backlog folder visit: enqueue its children
-- (idempotent) and delete the parent — but ONLY if the caller still owns the
-- lease at its fence. All-or-nothing: a stale caller changes nothing, leaving
-- the parent in the frontier for the real owner to re-visit (deterministic
-- replay). Enqueue-before-delete is subsumed by transactional atomicity.
create or replace function public.specs_backlog_commit_folder(
  p_holder text,
  p_fence bigint,
  p_parent text,
  p_children text[]
) returns boolean
language plpgsql
as $$
declare
  v_owned boolean;
begin
  -- Lock the singleton so a concurrent lease claim cannot slip between the
  -- ownership check and the mutation.
  select (lease_holder = p_holder and fence = p_fence)
    into v_owned
    from public.delivery_specs_scan_state
    where id = 'singleton'
    for update;

  if not coalesce(v_owned, false) then
    return false;
  end if;

  if p_children is not null and array_length(p_children, 1) is not null then
    insert into public.delivery_specs_scan_frontier (path)
    select unnest(p_children)
    on conflict (path) do nothing;
  end if;

  delete from public.delivery_specs_scan_frontier where path = p_parent;

  return true;
end;
$$;

-- Atomically mark the backlog complete ONLY when the caller owns the lease AND
-- the frontier is empty — both verified in the same transaction, so completion
-- can never be recorded while any folder remains to visit. Returns true iff set.
create or replace function public.specs_backlog_mark_complete_if_empty(
  p_holder text,
  p_fence bigint
) returns boolean
language plpgsql
as $$
declare
  v_owned boolean;
  v_remaining bigint;
begin
  select (lease_holder = p_holder and fence = p_fence)
    into v_owned
    from public.delivery_specs_scan_state
    where id = 'singleton'
    for update;

  if not coalesce(v_owned, false) then
    return false;
  end if;

  select count(*) into v_remaining from public.delivery_specs_scan_frontier;
  if v_remaining > 0 then
    return false;
  end if;

  update public.delivery_specs_scan_state
    set backlog_complete = true, updated_at = now()
    where id = 'singleton';

  return true;
end;
$$;

-- Backend-only: these mutate scan state, so lock them to the service role
-- (SECURITY INVOKER — they run as the caller, which bypasses RLS). anon /
-- authenticated must not be able to invoke them.
revoke execute on function public.specs_backlog_commit_folder(text, bigint, text, text[]) from public;
revoke execute on function public.specs_backlog_mark_complete_if_empty(text, bigint) from public;
grant execute on function public.specs_backlog_commit_folder(text, bigint, text, text[]) to service_role;
grant execute on function public.specs_backlog_mark_complete_if_empty(text, bigint) to service_role;
