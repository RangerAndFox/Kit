-- Health checks have three outcomes. Unknown is never a successful job result.
alter table public.system_health drop constraint system_health_status_check;
alter table public.system_health add constraint system_health_status_check
  check (status in ('up', 'down', 'unknown'));

create table public.health_reports (
  id text primary key,
  observed_at timestamptz not null,
  payload jsonb not null,
  plan jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint health_report_planned_before_complete check (completed_at is null or plan is not null)
);
alter table public.health_reports enable row level security;
revoke all on public.health_reports from public, anon, authenticated;
grant select, insert, update on public.health_reports to service_role;
create index health_reports_pending on public.health_reports(created_at, id) where completed_at is null;

-- Called only after the durable Slack receipt is acknowledged (or a silent
-- no-change plan). Completion and state must commit together, never separately.
create function public.complete_health_report(p_id text) returns void
language plpgsql security definer set search_path = public
as $$
declare report public.health_reports; item jsonb; outcome text;
begin
  select * into strict report from public.health_reports where id = p_id for update;
  if report.completed_at is not null then return; end if;
  if report.plan is null then raise exception 'Health report has no delivery plan'; end if;
  for item in select * from jsonb_array_elements(report.plan->'checks') loop
    outcome := case when (item->>'unknown')::boolean is true then 'unknown'
      when (item->>'ok')::boolean is true then 'up' else 'down' end;
    insert into public.system_health(key, status, detail, since, checked_at)
      values(item->>'key', outcome, item->>'detail', report.observed_at, report.observed_at)
    on conflict (key) do update set
      status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at,
      since = case when system_health.status = excluded.status then system_health.since else excluded.since end
    where system_health.checked_at < excluded.checked_at;
  end loop;
  update public.health_reports set completed_at = now() where id = p_id;
end;
$$;
revoke all on function public.complete_health_report(text) from public, anon, authenticated;
grant execute on function public.complete_health_report(text) to service_role;
