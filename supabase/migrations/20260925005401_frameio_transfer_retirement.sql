-- Explicit, audited retirement for historical Frame.io delivery-transfer rows
-- (e.g. the Fabric 2637 queue). Retirement must:
--   * PREVENT REPLAY of the transfer without ever marking it delivered, and
--   * PRESERVE the historical rows and an auditable record of who/why/when.
--
-- Mechanism: additive nullable columns + an append-only audit table + a claim
-- guard. NOTHING here marks a row `ready`. Draft only — not applied in this
-- review; no production data is mutated by this file.

-- 1. Transfer-level retirement marker. A retired transfer keeps its current
--    state (history preserved); it is simply excluded from any re-drive/sweep.
--    The CHECK makes "retired AND delivered" unrepresentable, so retirement can
--    never be confused with successful delivery.
alter table public.frameio_delivery_transfers
  add column if not exists retired_at timestamptz,
  add column if not exists retired_reason text,
  add column if not exists retired_by text;

alter table public.frameio_delivery_transfers
  drop constraint if exists frameio_transfer_retired_not_delivered;
alter table public.frameio_delivery_transfers
  add constraint frameio_transfer_retired_not_delivered
  check (retired_at is null or state <> 'ready');

create index if not exists frameio_delivery_transfers_retired_idx
  on public.frameio_delivery_transfers (retired_at) where retired_at is not null;

-- 2. Inbox-level retirement marker, so a retired item's durable event cannot be
--    reclaimed and re-driven (belt-and-suspenders with moving it out of the
--    claimable statuses).
alter table public.dropbox_event_inbox
  add column if not exists retired_at timestamptz,
  add column if not exists retired_reason text;

create index if not exists dropbox_event_inbox_retired_idx
  on public.dropbox_event_inbox (retired_at) where retired_at is not null;

-- 3. Append-only audit trail. One row per retirement action; never updated or
--    deleted. Captures the pre-retirement state + the evidence the decision was
--    based on (e.g. "inbox events all complete; no successful sibling").
create table if not exists public.frameio_transfer_retirements (
  id uuid primary key default gen_random_uuid(),
  -- Keep a snapshot after project deletion; never cascade away the audit.
  transfer_id uuid not null unique,
  project_id uuid,
  dropbox_file_id text,
  dropbox_rev text,
  prior_state text not null,
  reason text not null,
  retired_by text not null,
  evidence jsonb,
  retired_at timestamptz not null default now()
);
create index if not exists frameio_transfer_retirements_transfer_idx
  on public.frameio_transfer_retirements (transfer_id);

alter table public.frameio_transfer_retirements enable row level security;
revoke all on table public.frameio_transfer_retirements from public, anon, authenticated, service_role;
grant select on table public.frameio_transfer_retirements to service_role;
create policy "Service role only" on public.frameio_transfer_retirements
  for all to service_role using (true) with check (true);

-- 4. Claim guard: a retired inbox event is never claimed for processing. This is
--    the exact production claim_dropbox_events body with `and retired_at is null`
--    added to the candidate filter — nothing else changes.
create or replace function public.claim_dropbox_events(p_worker_id text, p_limit integer default 10, p_lease_seconds integer default 300)
 returns setof dropbox_event_inbox
 language sql
 set search_path to 'public'
as $function$
  with candidates as (
    select id from public.dropbox_event_inbox
    where retired_at is null
      and ((status in ('pending', 'retryable') and next_attempt_at <= now())
        or (status = 'processing' and claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 30))))
    order by next_attempt_at, created_at
    for update skip locked
    limit least(greatest(p_limit, 1), 100)
  )
  update public.dropbox_event_inbox i
    set status = 'processing', attempt_count = i.attempt_count + 1,
        claim_token = gen_random_uuid(), claimed_by = p_worker_id,
        claimed_at = now(), updated_at = now()
  from candidates c where i.id = c.id
  returning i.*;
$function$;

-- Only this service-only transaction writes the audit. Exact identity, version,
-- event manifest and ALL processing leases are checked before any write.
create or replace function public.retire_frameio_transfer(
  p_transfer_id uuid, p_project_id uuid, p_dropbox_file_id text, p_dropbox_rev text,
  p_expected_updated_at timestamptz, p_expected_event_ids uuid[],
  p_reason text, p_actor text, p_dry_run boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.frameio_delivery_transfers%rowtype;
  event_ids uuid[];
  expected_ids uuid[];
  audit_exists boolean;
begin
  if nullif(trim(p_reason),'') is null or nullif(trim(p_actor),'') is null
    or p_expected_updated_at is null or p_expected_event_ids is null then
    raise exception 'retirement requires an exact manifest, reason and actor';
  end if;
  select * into t from public.frameio_delivery_transfers where id=p_transfer_id for update;
  if not found or t.project_id is distinct from p_project_id
    or t.dropbox_file_id is distinct from p_dropbox_file_id
    or t.dropbox_rev is distinct from p_dropbox_rev then
    raise exception 'retirement identity mismatch';
  end if;
  if t.state='ready' then raise exception 'delivered transfer cannot be retired'; end if;
  perform id from public.dropbox_event_inbox
    where event_type='frameio_delivery' and payload->>'dropboxId'=t.dropbox_file_id
      and payload->>'rev'=t.dropbox_rev order by id for update;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into event_ids
    from public.dropbox_event_inbox where event_type='frameio_delivery'
      and payload->>'dropboxId'=t.dropbox_file_id and payload->>'rev'=t.dropbox_rev;
  select coalesce(array_agg(x order by x),'{}'::uuid[]) into expected_ids from unnest(p_expected_event_ids) x;
  if event_ids is distinct from expected_ids then raise exception 'retirement inbox manifest changed'; end if;
  -- Even an expired claim may have an old worker still running. Never retire
  -- it underneath that worker; let normal fenced recovery finish it first.
  if exists(select 1 from public.dropbox_event_inbox where id=any(event_ids) and status='processing') then
    raise exception 'retirement blocked by an in-flight worker';
  end if;
  select exists(select 1 from public.frameio_transfer_retirements where transfer_id=t.id) into audit_exists;
  if t.retired_at is not null then
    if not audit_exists or exists(select 1 from public.dropbox_event_inbox where id=any(event_ids) and retired_at is null) then
      raise exception 'inconsistent historical retirement requires review';
    end if;
    return jsonb_build_object('transferId',t.id,'disposition','already_retired','inboxEvents',cardinality(event_ids));
  end if;
  if t.updated_at is distinct from p_expected_updated_at then raise exception 'retirement transfer changed'; end if;
  if p_dry_run is distinct from false then
    return jsonb_build_object('transferId',t.id,'disposition','eligible','inboxEvents',cardinality(event_ids));
  end if;
  insert into public.frameio_transfer_retirements
    (transfer_id,project_id,dropbox_file_id,dropbox_rev,prior_state,reason,retired_by,evidence)
    values(t.id,t.project_id,t.dropbox_file_id,t.dropbox_rev,t.state,p_reason,p_actor,
      jsonb_build_object('event_ids',event_ids,'expected_updated_at',p_expected_updated_at));
  update public.frameio_delivery_transfers set retired_at=now(),retired_reason=p_reason,
    retired_by=p_actor,updated_at=now() where id=t.id;
  update public.dropbox_event_inbox set retired_at=now(),retired_reason=p_reason,updated_at=now()
    where id=any(event_ids);
  return jsonb_build_object('transferId',t.id,'disposition','retired','inboxEvents',cardinality(event_ids));
end;
$$;
revoke all on function public.retire_frameio_transfer(uuid,uuid,text,text,timestamptz,uuid[],text,text,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.retire_frameio_transfer(uuid,uuid,text,text,timestamptz,uuid[],text,text,boolean) to service_role;

create or replace function public.reject_frameio_retirement_audit_mutation()
returns trigger language plpgsql set search_path='' as $$
begin raise exception 'retirement audit is append-only'; end;
$$;
revoke all on function public.reject_frameio_retirement_audit_mutation() from public,anon,authenticated,service_role;
create trigger frameio_retirement_audit_immutable before update or delete
on public.frameio_transfer_retirements for each row execute function public.reject_frameio_retirement_audit_mutation();

create or replace function public.guard_retired_frameio_transfer()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.retired_at is not null and new is distinct from old then
    raise exception 'retired transfer cannot be updated';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_retired_frameio_transfer() from public,anon,authenticated,service_role;
create trigger guard_retired_frameio_transfer before update on public.frameio_delivery_transfers
for each row execute function public.guard_retired_frameio_transfer();
