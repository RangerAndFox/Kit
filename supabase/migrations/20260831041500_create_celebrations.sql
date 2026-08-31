-- Global studio celebrations used by Kit's daily Slack celebration runner.
create table public.celebrations (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  label text not null,
  fire_date date not null,
  created_by text,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint celebrations_kind_label_date unique (kind, label, fire_date)
);

create index celebrations_due_idx
  on public.celebrations (fire_date, kind)
  where posted_at is null;

alter table public.celebrations enable row level security;
revoke all on table public.celebrations from public, anon, authenticated;
grant all on table public.celebrations to service_role;

create policy "Deny API access (service-only)" on public.celebrations
  as restrictive for all to public
  using (false)
  with check (false);
