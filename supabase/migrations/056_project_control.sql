-- 056_project_control.sql
-- Project Control Source-of-Truth Synchronization.
--
-- Binds each newly created Kit project to exactly one authoritative row in the
-- production Google Sheet ("Master Project List") and exactly one Slack Project
-- Control Canvas. The Sheet is authoritative; the Canvas is a one-way rendered
-- view. This migration adds the DURABLE STATE the mission requires:
--
--   1. project_creation_requests — an idempotency ledger keyed by the Slack
--      view.id, replacing the in-memory pending-provision Map. A Railway
--      restart or Slack retry resumes the SAME request instead of creating a
--      second project. An intentional duplicate is a NEW view.id -> new row.
--
--   2. project_control_bindings — the single owner of the project<->Sheet<->
--      Canvas binding, with DB-enforced "one binding / one canvas / one sheet
--      developer-metadata record per project". Creation lifecycle and sync
--      lifecycle are separate columns.
--
--   3. sheet_sync_state — one row per workbook holding the coarse Drive-version
--      cursor plus lease columns for the exclusive creation claim and the
--      exclusive sync claim (row-based leases, mirroring 055's claim model),
--      each with a monotonic ownership fence.
--
--   4. project_provisioning_steps — a per-(project, service) durable step ledger
--      so a restart resumes only the incomplete services (durable execution).
--
-- Durability columns folded in: project_creation_requests.fence +
-- .replace_target_project_id + terminal 'cancelled' status; sheet_sync_state
-- creation_fence/sync_fence; a workbook-scoped binding recovery index. Kept in
-- this single unapplied migration (rather than a follow-up) so rollout is one
-- step and cannot drift.
--
-- Conventions mirror 055_meeting_briefing_deliveries.sql: lowercase DDL,
-- create-if-not-exists, named check constraints, claimed_at/lease_expires_at
-- leases, unique identity keys, table comments. The only change to an existing
-- table is an additive nullable projects.creation_request_id column plus a
-- partial unique index (section 0); no other existing column is altered, no
-- historical drift is repaired, and no existing project is backfilled.

begin;

-- ─── 0. Durable request → project identity ───────────────────────────────────
-- Lets a retry discover an already-created project even if the ledger's
-- project_id link write never landed (a crash between the projects insert and
-- the ledger update). Nullable; unique only for non-null values. This is NOT the
-- project number or name — those are not idempotency keys.
alter table public.projects add column if not exists creation_request_id text;
create unique index if not exists ux_projects_creation_request_id
  on public.projects(creation_request_id) where creation_request_id is not null;

-- ─── 1. Project creation request ledger ──────────────────────────────────────
-- Identity = the Slack view.id of the submitted new-project modal. Stable across
-- Socket-Mode redelivery of the same submission, so a retry reloads this row
-- rather than inserting a second project. Duplicate-resolution button actions
-- carry ONLY request_key and rehydrate their state from here.
create table if not exists public.project_creation_requests (
  id uuid primary key default gen_random_uuid(),
  -- Slack view.id (e.g. 'V0123ABCD'). The stable idempotency key.
  request_key text not null,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  -- The Slack user who submitted the modal. Authoritative for authorizing the
  -- duplicate/replace/cancel actions (never trust button visibility / id secrecy).
  requested_by_slack_user_id text,
  -- Normalized submission payload (the extracted modal form). The single source
  -- for resuming/replaying provisioning after a restart.
  submission jsonb not null default '{}'::jsonb,
  -- Duplicate/replace decision when the project number already existed.
  --   null            -> no clash / not yet decided
  --   'create'        -> proceed as a new distinct project
  --   'duplicate'     -> user chose to create a duplicate anyway
  --   'replace'       -> user chose to archive the old project first
  decision text
    constraint project_creation_requests_decision_check
    check (decision is null or decision in ('create', 'duplicate', 'replace')),
  -- The exact project a 'replace' decision must archive, persisted BEFORE the
  -- prompt is replaced or anything is archived — so a crash mid-replace is
  -- recoverable and a replay archives the right target (never the replacement).
  replace_target_project_id uuid references public.projects(id) on delete set null,
  -- The canonical project this request produced (set once inserted).
  project_id uuid references public.projects(id) on delete set null,
  -- 'cancelled' is a TERMINAL user cancel, distinct from a retryable 'error', so
  -- the Railway recovery sweep never resumes a request the user cancelled.
  status text not null default 'pending'
    constraint project_creation_requests_status_check
    check (status in ('pending', 'awaiting_decision', 'provisioning', 'completed', 'error', 'cancelled')),
  attempts integer not null default 0,
  -- Lease so only one worker drives a given request at a time; an expired lease
  -- is reclaimable after a crash.
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  -- Monotonic ownership epoch: bumped on each reclaim, unchanged by a renewal.
  -- The acquisition-unique holder + a compare-and-set ownership check before
  -- every irreversible external write is the enforced fence (a reclaimed worker
  -- fails its next renew and stops before writing).
  fence bigint not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One ledger row per Slack submission id. Guarantees idempotent creation:
  -- a redelivered view_submission cannot create a second request/project.
  constraint project_creation_requests_request_key_unique unique (request_key)
);

create index if not exists project_creation_requests_status_idx
  on public.project_creation_requests (status, lease_expires_at);

comment on table public.project_creation_requests is
  'Idempotency ledger for new-project provisioning, keyed by Slack view.id. Replaces the in-memory pending-provision Map so restarts/retries resume the same request. One row per submission; an intentional duplicate is a new view.id.';

-- ─── 2. Project Control binding ──────────────────────────────────────────────
-- The single owner of the project <-> Master-Project-List-row <-> Project
-- Control Canvas association. DB constraints enforce the mission's "exactly
-- one" guarantees.
create table if not exists public.project_control_bindings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Sheet identity.
  spreadsheet_id text not null,
  sheet_id bigint not null,
  -- Sheets developer metadata id for kit_project_id=<projects.id>. The DURABLE
  -- row binding: survives row moves/inserts. Null until the Sheet step commits.
  row_metadata_id bigint,
  -- Which template Canvas the Project Control Canvas was rendered from, and a
  -- hash + normalized markdown snapshot of that template AT BIND TIME. All
  -- later syncs render from this stored snapshot, never from the live template.
  source_template_file_id text,
  source_template_hash text,
  template_markdown text,
  -- The one bound Project Control Canvas.
  canvas_id text,
  canvas_url text,
  -- Creation lifecycle (Railway-owned): the binding walks this once.
  creation_state text not null default 'pending_sheet'
    constraint project_control_bindings_creation_state_check
    check (creation_state in ('pending_sheet', 'sheet_bound', 'pending_canvas', 'connected')),
  -- Sync lifecycle (Vercel/Inngest-owned): recurring.
  sync_status text not null default 'pending'
    constraint project_control_bindings_sync_status_check
    check (sync_status in ('pending', 'synced', 'error', 'orphaned')),
  -- Fine-grained change detector: hash of the normalized authoritative Sheet row
  -- (including hyperlink targets) at the last successful render.
  last_row_hash text,
  -- (sync/creation status indexes below also serve the Railway recovery sweep,
  -- which lists non-'connected' bindings to re-drive.)
  last_synced_at timestamptz,
  -- Actionable error + persisted notification dedupe so an error/orphan state is
  -- announced once per transition, not every sync tick.
  error text,
  error_notified_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One binding per project.
  constraint project_control_bindings_project_unique unique (project_id),
  -- One Sheet developer-metadata record per project (no two projects share one).
  constraint project_control_bindings_metadata_unique
    unique (spreadsheet_id, row_metadata_id),
  -- One bound Canvas globally (a canvas cannot be claimed by two projects).
  constraint project_control_bindings_canvas_unique unique (canvas_id)
);

create index if not exists project_control_bindings_sync_idx
  on public.project_control_bindings (sync_status, last_synced_at);

create index if not exists project_control_bindings_creation_idx
  on public.project_control_bindings (creation_state);

-- Railway recovery sweep: list a workbook's non-'connected' (incomplete)
-- bindings to re-drive them (the Vercel sync ignores non-connected bindings).
create index if not exists project_control_bindings_recovery_idx
  on public.project_control_bindings (spreadsheet_id, creation_state);

comment on table public.project_control_bindings is
  'Authoritative binding of a Kit project to one Master Project List row (via Sheets developer metadata kit_project_id) and one Slack Project Control Canvas. Creation and sync lifecycles are separate. Renders always use the stored template snapshot, not the live template.';

-- ─── 3. Workbook sync state (cursor + leases) ────────────────────────────────
-- One row per workbook. Holds the coarse Drive file-version cursor and two
-- exclusive leases: creation (row writes) and sync (canvas renders). Both are
-- compare-and-set against *_lease_expires_at.
create table if not exists public.sheet_sync_state (
  spreadsheet_id text primary key,
  -- Coarse cursor: Drive files.get(fields='version'). Advanced only when a full
  -- sync pass succeeded and the version was stable across the pass.
  drive_version text,
  cursor_advanced_at timestamptz,
  -- Exclusive creation claim (Railway acquires before writing a new row).
  creation_lease_holder text,
  creation_lease_expires_at timestamptz,
  creation_fence bigint not null default 0,
  -- Exclusive sync claim (Inngest acquires before a sync pass).
  sync_lease_holder text,
  sync_lease_expires_at timestamptz,
  sync_fence bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sheet_sync_state is
  'Per-workbook coarse Drive-version cursor plus exclusive creation and sync leases (with monotonic ownership fences) for Project Control synchronization.';

-- ─── 4. Per-service durable provisioning step ledger ─────────────────────────
-- Identity = (project_id, service). Memoizes each external service provision so
-- a Railway restart mid-provision resumes ONLY the incomplete services instead
-- of re-running the whole fan-out. Combined with per-service reconcile-before-
-- create in each agent, provisioning is effectively exactly-once.
create table if not exists public.project_provisioning_steps (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Agent/service key (e.g. 'dropbox', 'frameio', 'harvest', 'slack').
  service text not null,
  status text not null default 'pending'
    constraint project_provisioning_steps_status_check
    check (status in ('pending', 'running', 'done', 'failed')),
  -- The per-service agent result, memoized so a resumed run reuses it.
  result jsonb,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One step row per service per project: idempotent, resume-safe fan-out.
  constraint project_provisioning_steps_project_service_unique
    unique (project_id, service)
);

create index if not exists project_provisioning_steps_project_idx
  on public.project_provisioning_steps (project_id);

comment on table public.project_provisioning_steps is
  'Per-(project, service) durable provisioning step ledger. Memoizes each external service provision so a Railway restart resumes only the incomplete services.';

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- These are Kit-internal operational tables written/read ONLY by the service
-- role (Railway creation + Vercel/Inngest sync). Enable RLS with NO policies so
-- anon/authenticated clients get nothing; the service-role key bypasses RLS.
-- Mirrors 016_rls_token_tables.sql (dropbox_state / frameio_token_state).
alter table public.project_creation_requests enable row level security;
alter table public.project_control_bindings enable row level security;
alter table public.sheet_sync_state enable row level security;
alter table public.project_provisioning_steps enable row level security;

commit;
