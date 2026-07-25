-- Delivery — Per-project specs/ folder scan: split live delta from historical
-- backlog recovery. Forward-only follow-up to migration 059.
--
-- WHY: 059's bootstrap phase enumerated /production with a single recursive
-- `list_folder` call. In production that first page exceeds dropboxRpc's 15s
-- AbortSignal budget before returning, so discovery never checkpoints
-- (delivery_specs_scan_state stays phase='bootstrap', cursor=null, while fence
-- climbs). Page-count bounding cannot help because page ONE never completes.
--
-- NEW MODEL (two independent, converging paths through the SAME ledger):
--   * LIVE DELTA — the cursor is seeded via `list_folder/get_latest_cursor`
--     (anchored to "now", NO enumeration), then polled with
--     `list_folder/continue`. `delivery_specs_scan_state.cursor` holds it;
--     NULL means "not yet seeded" (the current production state upgrades on its
--     next run). phase flips 'bootstrap' -> 'delta' at seed. New activity is
--     processable immediately, before backlog recovery finishes.
--   * HISTORICAL BACKLOG — a persisted, NON-recursive breadth-first traversal.
--     Each visit lists ONE folder (fast), records specs files into the shared
--     seen_dropbox_files ledger, and enqueues child folders. The frontier below
--     is the durable resume point (survives timeout / crash / redeploy / lease
--     reclaim). `backlog_complete` is the explicit terminal flag; a completed
--     backlog never restarts, and completion never disables live delta polling.
--
-- Compatible with 059: reuses the existing state row + lease/fence; the
-- phase CHECK ('bootstrap','delta') is unchanged. No existing data is rewritten.

-- Explicit backlog-completion flag on the existing singleton state row.
alter table public.delivery_specs_scan_state
  add column if not exists backlog_complete boolean not null default false;

-- Persisted non-recursive traversal frontier: the set of folders still to
-- visit. `path` is the Dropbox folder path (primary key → enqueue is idempotent
-- via ON CONFLICT DO NOTHING, so replay after a partial visit cannot duplicate
-- work). Rows are deleted once their folder has been listed and its children
-- enqueued. Empty-after-seeding == drained (mirrored by backlog_complete).
create table if not exists public.delivery_specs_scan_frontier (
  path text primary key,
  created_at timestamptz not null default now()
);

-- Deterministic oldest-first drain order for bounded, resumable traversal.
create index if not exists delivery_specs_scan_frontier_order_idx
  on public.delivery_specs_scan_frontier (created_at, path);

-- RLS — service role only (matching dropbox_state / seen_dropbox_files /
-- delivery_specs_scan_state). No policies: anon/authenticated are locked out;
-- the service role bypasses RLS.
alter table public.delivery_specs_scan_frontier enable row level security;
