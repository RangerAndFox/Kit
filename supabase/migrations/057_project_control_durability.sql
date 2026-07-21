-- 057_project_control_durability.sql
-- Project Control — durable-execution hardening (UNAPPLIED).
--
-- Layers the durability guarantees on top of 056 without altering any 056
-- object. Additive only: one new table plus additive columns and indexes. Safe
-- to leave in place; no existing column is altered and no data is backfilled.
--
--   1. project_provisioning_steps — a per-(project, service) durable step
--      ledger. Provisioning fans out to several external services (Dropbox,
--      Frame.io, Harvest, Slack, …). Before this table the fan-out kept its
--      progress only in memory, so a Railway restart mid-provision re-ran every
--      service. This ledger memoizes each service's outcome so a resume runs
--      ONLY the steps that have not reached 'done' — recurring work scales with
--      new activity, not total history (invariant 8/9).
--
--   2. Fence tokens — a monotonically increasing counter on every lease-bearing
--      row (project_creation_requests, sheet_sync_state). Each reclaim bumps the
--      fence; a renewal keeps it. Combined with the acquisition-unique holder
--      token this fences stale writers: a worker whose lease was reclaimed sees
--      a newer fence and stops, instead of clobbering the new holder's work
--      (invariant 10 — cursor/lease ownership is explicit).
--
--   3. Recovery index — lets the Railway recovery sweep cheaply find the
--      incomplete bindings it must re-drive.
--
-- Conventions mirror 055/056: lowercase DDL, create-if-not-exists, named check
-- constraints, table comments, RLS enabled with NO policies (service-role only).

begin;

-- ─── 1. Per-service durable provisioning step ledger ─────────────────────────
-- Identity = (project_id, service). One row per service per project. A resume
-- reads the 'done' rows and skips them; only non-'done' services re-run. The
-- stored result is the exact per-service agent result so a resumed run rebuilds
-- the same aggregate summary/links without re-calling the service.
create table if not exists public.project_provisioning_steps (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Agent/service key (e.g. 'dropbox', 'frameio', 'harvest', 'slack').
  service text not null,
  status text not null default 'pending'
    constraint project_provisioning_steps_status_check
    check (status in ('pending', 'running', 'done', 'failed')),
  -- The per-service agent result (success/url/id/message/error), memoized so a
  -- resumed provisioning run reuses it rather than re-invoking the service.
  result jsonb,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One step row per service per project: guarantees idempotent, resume-safe
  -- fan-out (a redelivered / resumed run cannot double-run a completed service).
  constraint project_provisioning_steps_project_service_unique
    unique (project_id, service)
);

create index if not exists project_provisioning_steps_project_idx
  on public.project_provisioning_steps (project_id);

comment on table public.project_provisioning_steps is
  'Per-(project, service) durable provisioning step ledger. Memoizes each external service provision so a Railway restart resumes only the incomplete services instead of re-running the whole fan-out.';

-- ─── 2. Fence tokens on the lease-bearing rows ───────────────────────────────
-- Monotonic per-resource counter. claim() bumps it on a reclaim; renew() leaves
-- it unchanged (same holder keeps its fence). A worker retains the fence it was
-- granted and refuses to write once it observes a newer one — fencing a stale
-- worker whose lease was reclaimed after a pause/GC.
alter table public.project_creation_requests
  add column if not exists fence bigint not null default 0;

alter table public.sheet_sync_state
  add column if not exists creation_fence bigint not null default 0;

alter table public.sheet_sync_state
  add column if not exists sync_fence bigint not null default 0;

-- ─── 2b. Terminal 'cancelled' request status ─────────────────────────────────
-- A user-cancelled request must be terminal so the Railway recovery sweep never
-- resumes it (a plain 'error' is retryable; a cancel is not). Widen the 056
-- status check to admit 'cancelled'. Existing rows are unaffected (additive).
alter table public.project_creation_requests
  drop constraint if exists project_creation_requests_status_check;
alter table public.project_creation_requests
  add constraint project_creation_requests_status_check
  check (status in ('pending', 'awaiting_decision', 'provisioning', 'completed', 'error', 'cancelled'));

-- ─── 3. Recovery index ───────────────────────────────────────────────────────
-- The Railway recovery sweep lists bindings that never reached 'connected'
-- (incomplete creation) to re-drive them. 056 already indexes creation_state;
-- this composite makes the workbook-scoped incomplete-binding scan a range read.
create index if not exists project_control_bindings_recovery_idx
  on public.project_control_bindings (spreadsheet_id, creation_state);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Service-role-only operational table, like 056. Enable RLS with no policies so
-- anon/authenticated clients get nothing; the service-role key bypasses RLS.
alter table public.project_provisioning_steps enable row level security;

commit;
