-- Dropbox batches are represented by one reusable Frame.io folder share.
-- Individual files still have durable transfer rows, while this ledger keeps
-- Last Share and producer notifications at the useful folder level.
create table if not exists public.frameio_folder_shares (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  frameio_project_id text not null,
  frameio_folder_id text not null,
  folder_path text not null,
  share_name text not null,
  share_url text not null,
  last_file_name text,
  file_count integer not null default 1 check (file_count > 0),
  last_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, frameio_folder_id)
);

alter table public.frameio_folder_shares enable row level security;
revoke all on table public.frameio_folder_shares from public, anon, authenticated;
grant select, insert, update, delete on table public.frameio_folder_shares to service_role;

create policy "Service role only" on public.frameio_folder_shares
  for all to service_role using (true) with check (true);

create index if not exists frameio_folder_shares_project_updated_idx
  on public.frameio_folder_shares (project_id, updated_at desc);

-- Old per-file recovery records must not replay another burst after this
-- folder-level behavior ships. Already-posted producer decisions remain intact.
update public.project_share_events
set status = 'superseded', updated_at = now()
where status = 'pending' and slack_message_ts is null;
