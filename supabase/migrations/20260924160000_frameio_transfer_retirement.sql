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
  transfer_id uuid not null references public.frameio_delivery_transfers(id) on delete cascade,
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
revoke all on table public.frameio_transfer_retirements from public, anon, authenticated;
grant select, insert on table public.frameio_transfer_retirements to service_role;
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
