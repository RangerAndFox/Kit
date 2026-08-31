-- Delivery — Per-project specs/ folder scan: durable cursor + exclusive lease.
--
-- The specs scan (Inngest cron `delivery-specs-scan`, every minute on Vercel)
-- used to enumerate the ENTIRE Dropbox /production tree on every tick. As the
-- tree grew, a single Dropbox list_folder page exceeded dropboxRpc's 15s
-- AbortSignal budget ("The operation was aborted due to timeout") and the run
-- failed every minute.
--
-- This table gives that scan its OWN persisted state so it can bound work per
-- invocation (invariant 7 — proportional to new activity, not total history):
--
--   * `cursor` — the Dropbox list_folder cursor. In `bootstrap` phase it is the
--     recursive enumeration continuation; when enumeration is exhausted the
--     SAME cursor becomes the `delta` continuation cursor. Distinct from Bolt's
--     `dropbox_state.singleton` cursor (a different table + owner) so the two
--     watchers never advance each other's cursor (invariant 10).
--   * `phase` — 'bootstrap' (one bounded full enumeration so pre-existing and
--     outage-period specs are recorded, never silently skipped) → 'delta'
--     (list_folder/continue from the persisted cursor). No re-seed to
--     get_latest_cursor, which would drop the backlog.
--   * lease columns — a DB-level compare-and-set lease so overlapping cron runs
--     (Vercel may invoke concurrently; the function also retries) cannot process
--     the same cursor at once. A contending run exits successfully as skipped.
--     `fence` is a monotonic ownership epoch: cursor writes are holder+fence
--     conditional so a stale holder reclaimed after a pause cannot clobber the
--     new holder. The lease expires on its own so a crashed run self-recovers.
--
-- Single-row table (id defaults to 'singleton'); seeded below.

create table if not exists public.delivery_specs_scan_state (
  id text primary key default 'singleton',
  phase text not null default 'bootstrap' check (phase in ('bootstrap', 'delta')),
  cursor text,
  lease_holder text,
  lease_expires_at timestamptz,
  fence bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.delivery_specs_scan_state (id) values ('singleton')
  on conflict (id) do nothing;

-- RLS — service role only (matching project convention for backend-only state,
-- e.g. dropbox_state / seen_dropbox_files). No policies: anon/authenticated keys
-- are locked out; the service role bypasses RLS.
alter table public.delivery_specs_scan_state enable row level security;
