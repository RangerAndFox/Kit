-- 063_project_update.sql
-- Durable state for the "update project" flow.
--
-- Editing an already-provisioned project ripples a rename across every outlet
-- (Slack channel, Harvest, Dropbox folder, Frame.io, the Master Project List row
-- + Canvas, and the Supabase projects row). Like creation, the ripple must be
-- idempotent and crash-resumable: a Railway restart mid-ripple must resume only
-- the services that have not yet applied, never double-apply a rename.
--
-- This mirrors 056's create-side durability, deliberately with SEPARATE tables:
--
--   1. project_update_requests — an idempotency ledger keyed by the update
--      modal's Slack view.id. Holds the submitted form + the computed plan, the
--      apply/cancel decision (committed by the confirm button via compare-and-set),
--      status, and a per-request lease + fence. A redelivered submission or a
--      restart resumes the SAME request.
--
--   2. project_update_steps — a per-(update_request, service) durable step ledger,
--      identical in shape to project_provisioning_steps but keyed by the update
--      request (NOT the project). Reusing project_provisioning_steps would collide
--      with the create-side rows (service='slack' etc. already 'done') and would
--      feed update steps into the CREATE recovery sweep. A distinct table keeps
--      the two recovery domains isolated.
--
-- Conventions mirror 056_project_control.sql: lowercase DDL, create-if-not-exists,
-- named check constraints, claimed_at/lease_expires_at leases with a monotonic
-- fence, unique identity keys, table comments, RLS with no policies (service-role
-- only). No existing table or column is altered.

begin;

-- ─── 1. Project update request ledger ────────────────────────────────────────
-- Identity = the Slack view.id of the submitted update modal. Stable across
-- Socket-Mode redelivery of the same submission, so a retry reloads this row
-- rather than starting a second ripple. The confirm/cancel button actions carry
-- ONLY request_key and rehydrate their state (submission + plan) from here.
create table if not exists public.project_update_requests (
  id uuid primary key default gen_random_uuid(),
  -- Slack view.id (e.g. 'V0123ABCD'). The stable idempotency key.
  request_key text not null,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  -- The project being edited.
  project_id uuid not null references public.projects(id) on delete cascade,
  -- The Slack user who submitted the modal. Authoritative for authorizing the
  -- confirm/cancel actions (never trust button visibility / id secrecy).
  requested_by_slack_user_id text,
  -- Normalized submission payload (the extracted update-modal form). The single
  -- source for resuming/replaying the ripple after a restart.
  submission jsonb not null default '{}'::jsonb,
  -- The computed UpdatePlan (field changes + derived strings + service flags),
  -- persisted at prompt time so the confirm click applies exactly what was shown.
  plan jsonb not null default '{}'::jsonb,
  -- Apply/cancel decision, recorded by the confirm/cancel compare-and-set.
  --   null      -> not yet decided
  --   'apply'   -> user confirmed the ripple
  --   'cancel'  -> user cancelled (terminal)
  decision text
    constraint project_update_requests_decision_check
    check (decision is null or decision in ('apply', 'cancel')),
  -- 'cancelled' is a TERMINAL user cancel, distinct from a retryable 'error', so
  -- the Railway recovery sweep never resumes a ripple the user cancelled.
  status text not null default 'pending'
    constraint project_update_requests_status_check
    check (status in ('pending', 'awaiting_confirm', 'applying', 'completed', 'error', 'cancelled')),
  attempts integer not null default 0,
  -- Lease so only one worker drives a given ripple at a time; an expired lease is
  -- reclaimable after a crash.
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  -- Monotonic ownership epoch: bumped on each reclaim, unchanged by a renewal.
  fence bigint not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One ledger row per Slack submission id. A redelivered view_submission cannot
  -- start a second ripple.
  constraint project_update_requests_request_key_unique unique (request_key)
);

create index if not exists project_update_requests_status_idx
  on public.project_update_requests (status, lease_expires_at);
create index if not exists project_update_requests_project_idx
  on public.project_update_requests (project_id);

comment on table public.project_update_requests is
  'Idempotency ledger for the update-project ripple, keyed by the update modal Slack view.id. Holds the submitted form + computed plan; the confirm/cancel actions rehydrate from here. One row per submission; a restart/redelivery resumes the same ripple.';

-- ─── 2. Per-service durable update steps ─────────────────────────────────────
-- Same deterministic-ownership shape as project_provisioning_steps, but keyed by
-- the update request so each ripple has its own fresh step ledger (a project can
-- be edited many times over its life). service is 'slack' | 'frameio' | 'harvest'
-- | 'dropbox' | 'sheet' | 'supabase'.
create table if not exists public.project_update_steps (
  id uuid primary key default gen_random_uuid(),
  update_request_id uuid not null
    references public.project_update_requests(id) on delete cascade,
  -- Denormalized for convenience / recovery queries.
  project_id uuid not null references public.projects(id) on delete cascade,
  service text not null,
  -- Lifecycle:
  --   pending  -> not yet run
  --   running  -> a holder is executing it (claim held)
  --   done     -> succeeded (terminal-success)
  --   failed   -> RETRYABLE failure; the recovery sweep will re-run it
  --   terminal -> PERMANENT failure; visible, never auto-retried, blocks completion
  status text not null default 'pending'
    constraint project_update_steps_status_check
    check (status in ('pending', 'running', 'done', 'failed', 'terminal')),
  -- The per-service rename result, memoized so a resumed run reuses it.
  result jsonb,
  error text,
  -- Deterministic per-step ownership (mirrors project_provisioning_steps): a
  -- worker claims the step atomically before executing; the final result write is
  -- conditional on the exact holder + fence, so a reclaimed stale worker cannot
  -- commit over a newer holder.
  claim_holder text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  fence bigint not null default 0,
  attempts integer not null default 0,
  -- Normalized input hash: detects a changed submission so a stale memoized
  -- result isn't reused for different inputs.
  input_hash text,
  -- Persisted external identity, written the instant it is known.
  external_id text,
  external_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One step row per service per update request: idempotent, resume-safe fan-out.
  constraint project_update_steps_request_service_unique
    unique (update_request_id, service)
);

create index if not exists project_update_steps_request_idx
  on public.project_update_steps (update_request_id);
create index if not exists project_update_steps_project_idx
  on public.project_update_steps (project_id);
-- Recovery sweep: find steps that still need work (not done/terminal) whose lease
-- is free/expired.
create index if not exists project_update_steps_recovery_idx
  on public.project_update_steps (status, lease_expires_at);

comment on table public.project_update_steps is
  'Per-(update_request, service) durable step ledger for the update-project ripple, with deterministic per-step ownership (holder/fence/lease). Memoizes each external rename so a restart resumes only the incomplete services; final writes are holder/fence-conditional. Separate from project_provisioning_steps so update recovery never crosses into create recovery.';

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Kit-internal operational tables written/read ONLY by the service role (Railway
-- ripple + recovery). Enable RLS with NO policies so anon/authenticated clients
-- get nothing; the service-role key bypasses RLS. Mirrors 056.
alter table public.project_update_requests enable row level security;
alter table public.project_update_steps enable row level security;

commit;
