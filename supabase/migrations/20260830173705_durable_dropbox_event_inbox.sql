-- Durable Dropbox webhook intake.
--
-- Dropbox cursors describe a stream, not a work queue. Advancing the cursor
-- before a provider side effect can lose work; retaining it after one poison
-- item repeats every successful item in the batch. This table separates those
-- concerns: intake and cursor advancement are one transaction, while workers
-- claim and retry individual events with a fenced lease.

begin;

create table public.dropbox_event_inbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null check (event_type in ('accessibility_srt', 'ae_render', 'frameio_delivery')),
  payload jsonb not null,
  source_cursor text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'retryable', 'complete', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 8 check (max_attempts > 0),
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index dropbox_event_inbox_claim_idx
  on public.dropbox_event_inbox (next_attempt_at, created_at)
  where status in ('pending', 'retryable', 'processing');

alter table public.dropbox_event_inbox enable row level security;

-- Atomically persist the actionable events from one Dropbox delta response and
-- advance the singleton stream cursor. A stale caller cannot advance over a
-- newer caller because the cursor row is locked and compared first.
create or replace function public.ingest_dropbox_event_batch(
  p_previous_cursor text,
  p_new_cursor text,
  p_events jsonb
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current_cursor text;
  v_inserted integer := 0;
begin
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' then
    raise exception 'p_events must be a JSON array';
  end if;

  select cursor into v_current_cursor
    from public.dropbox_state
    where id = 'singleton'
    for update;

  if not found then
    raise exception 'Dropbox cursor singleton is not initialized';
  end if;
  if v_current_cursor is distinct from p_previous_cursor then
    raise exception 'Dropbox cursor changed concurrently';
  end if;

  insert into public.dropbox_event_inbox (
    event_key, event_type, payload, source_cursor
  )
  select
    e.event_key,
    e.event_type,
    e.payload,
    p_new_cursor
  from jsonb_to_recordset(coalesce(p_events, '[]'::jsonb))
    as e(event_key text, event_type text, payload jsonb)
  where e.event_key is not null
    and e.event_type is not null
    and e.payload is not null
  on conflict (event_key) do nothing;

  get diagnostics v_inserted = row_count;

  update public.dropbox_state
    set cursor = p_new_cursor, updated_at = now()
    where id = 'singleton';

  return v_inserted;
end;
$$;

-- Claim due work with SKIP LOCKED so multiple Bolt instances can safely drain
-- the same inbox during a rolling deploy. Expired leases are reclaimable.
create or replace function public.claim_dropbox_events(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 300
)
returns setof public.dropbox_event_inbox
language sql
security invoker
set search_path = public
as $$
  with candidates as (
    select id
    from public.dropbox_event_inbox
    where (
      status in ('pending', 'retryable') and next_attempt_at <= now()
    ) or (
      status = 'processing'
      and claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 30))
    )
    order by next_attempt_at, created_at
    for update skip locked
    limit least(greatest(p_limit, 1), 100)
  )
  update public.dropbox_event_inbox i
    set status = 'processing',
        attempt_count = i.attempt_count + 1,
        claim_token = gen_random_uuid(),
        claimed_by = p_worker_id,
        claimed_at = now(),
        updated_at = now()
  from candidates c
  where i.id = c.id
  returning i.*;
$$;

create or replace function public.complete_dropbox_event(
  p_event_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.dropbox_event_inbox
    set status = 'complete',
        completed_at = now(),
        claim_token = null,
        claimed_by = null,
        claimed_at = null,
        last_error = null,
        updated_at = now()
    where id = p_event_id
      and status = 'processing'
      and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.fail_dropbox_event(
  p_event_id uuid,
  p_claim_token uuid,
  p_error text
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
begin
  update public.dropbox_event_inbox
    set status = case when attempt_count >= max_attempts then 'dead_letter' else 'retryable' end,
        next_attempt_at = case
          when attempt_count >= max_attempts then next_attempt_at
          else now() + make_interval(
            secs => least(3600, 30 * (2 ^ least(attempt_count - 1, 7)))::integer
          )
        end,
        claim_token = null,
        claimed_by = null,
        claimed_at = null,
        last_error = left(coalesce(p_error, 'unknown error'), 4000),
        updated_at = now()
    where id = p_event_id
      and status = 'processing'
      and claim_token = p_claim_token
    returning status into v_status;
  return v_status;
end;
$$;

revoke all on table public.dropbox_event_inbox from public, anon, authenticated;
grant all on table public.dropbox_event_inbox to service_role;

revoke all on function public.ingest_dropbox_event_batch(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_dropbox_events(text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_dropbox_event(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_dropbox_event(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ingest_dropbox_event_batch(text, text, jsonb) to service_role;
grant execute on function public.claim_dropbox_events(text, integer, integer) to service_role;
grant execute on function public.complete_dropbox_event(uuid, uuid) to service_role;
grant execute on function public.fail_dropbox_event(uuid, uuid, text) to service_role;

commit;
