-- 023_client_profiles_harvest_id.sql
-- Adds harvest_client_id to client_profiles for idempotent backfill from Harvest.
-- Part of studio-knowledge Phase 3 (contacts).

begin;

alter table public.client_profiles
  add column if not exists harvest_client_id bigint;

create unique index if not exists client_profiles_harvest_client_id_key
  on public.client_profiles (harvest_client_id) where harvest_client_id is not null;

create index if not exists client_profiles_client_name_idx
  on public.client_profiles (client_name);

commit;
