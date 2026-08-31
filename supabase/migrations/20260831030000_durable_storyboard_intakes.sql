create table if not exists public.storyboard_intakes (
  token text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.storyboard_intakes enable row level security;
revoke all on table public.storyboard_intakes from public, anon, authenticated;
grant select, insert, update, delete on table public.storyboard_intakes to service_role;
create policy "Service role only" on public.storyboard_intakes
  for all to service_role using (true) with check (true);
create index if not exists storyboard_intakes_expiry_idx on public.storyboard_intakes (expires_at);

