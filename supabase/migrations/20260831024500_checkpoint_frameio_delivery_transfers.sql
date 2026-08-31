-- Bind every Dropbox file revision to exactly one Frame.io file. This ledger
-- prevents same-name revisions and inbox retries from reusing stale media.
create table if not exists public.frameio_delivery_transfers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dropbox_file_id text not null,
  dropbox_rev text not null,
  frameio_project_id text not null,
  frameio_folder_id text not null,
  frameio_file_id text not null,
  frameio_status_path text not null,
  frameio_view_url text not null,
  frameio_share_url text,
  state text not null default 'processing' check (state in ('processing','ready','failed')),
  last_provider_status text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, dropbox_file_id, dropbox_rev),
  unique (frameio_file_id)
);

alter table public.frameio_delivery_transfers enable row level security;
revoke all on table public.frameio_delivery_transfers from public, anon, authenticated;
grant select, insert, update, delete on table public.frameio_delivery_transfers to service_role;

create policy "Service role only" on public.frameio_delivery_transfers
  for all to service_role using (true) with check (true);

create index if not exists frameio_delivery_transfers_pending_idx
  on public.frameio_delivery_transfers (state, updated_at)
  where state = 'processing';

