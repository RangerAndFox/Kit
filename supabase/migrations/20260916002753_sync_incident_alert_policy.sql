-- Version aligned with the applied production migration.
-- Incident history is private and survives recovery. Never retain raw provider
-- responses here: they may contain credentials, share URLs or client data.
create table public.project_sync_incidents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  failure_count integer not null default 1 check (failure_count > 0),
  reason text not null,
  resolved_at timestamptz,
  alert_outbox_id uuid references public.kit_control_outbox(id) on delete set null,
  recovery_outbox_id uuid references public.kit_control_outbox(id) on delete set null
);
create unique index project_sync_one_open_incident on public.project_sync_incidents(project_id) where resolved_at is null;
create index project_sync_incident_history on public.project_sync_incidents(project_id,first_failed_at desc);
alter table public.project_sync_incidents enable row level security;
revoke all on public.project_sync_incidents from public,anon,authenticated;
grant all on public.project_sync_incidents to service_role;

-- Keep the existing RPC signature for rolling deploy compatibility. Binding lock
-- serializes attempts/recovery and atomically commits incident + outbox state.
create or replace function public.enqueue_project_sync_alert(p_project_id uuid,p_key text,p_channel text,p_text text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  incident public.project_sync_incidents%rowtype;
  label text;
  detail_url text;
  reason_code text;
  outbox_id uuid;
begin
  perform 1 from public.project_control_bindings where project_id=p_project_id for update;
  if not found then return false; end if;
  select * into incident from public.project_sync_incidents where project_id=p_project_id and resolved_at is null;
  select coalesce(project_code,'Project') || ' — ' || name into label from public.projects where id=p_project_id;
  label := replace(replace(replace(label,'&','&amp;'),'<','&lt;'),'>','&gt;');
  detail_url := 'https://kit-amber.vercel.app/control-center/projects/' || p_project_id::text;

  if p_key like 'ok:%' then
    if incident.id is null then return false; end if;
    update public.project_sync_incidents set resolved_at=now() where id=incident.id;
    -- Quiet recovery unless this sustained incident warranted an alert.
    if incident.alert_outbox_id is null then return false; end if;
    select payload->>'channel' into p_channel from public.kit_control_outbox where id=incident.alert_outbox_id;
    insert into public.kit_control_outbox(project_id,kind,payload) values(p_project_id,'sync_alert',
      jsonb_build_object('channel',p_channel,'priorAlertId',incident.alert_outbox_id,
        'text',':large_green_circle: ' || label || ' is back in sync. <' || detail_url || '|View sync history>')) returning id into outbox_id;
    update public.project_sync_incidents set recovery_outbox_id=outbox_id where id=incident.id;
    update public.project_control_bindings set error_notified_key=p_key where project_id=p_project_id;
    return true;
  end if;

  -- Whitelist categories, including legacy callers during rollout.
  reason_code := case
    when p_key ~* '(429|rate.limit|quota)' then 'Provider rate limit'
    when p_key ~* '(timeout|timed.out|abort)' then 'Provider timeout'
    when p_key ~* '(403|401|permission|auth|access.denied|not.in.channel)' then 'Provider access denied'
    when p_key ~* '(orphan|metadata|404|not.found)' then 'Missing sheet row or provider resource'
    when p_key ~* '(network|fetch|50[234]|unavailable)' then 'Provider unavailable'
    else 'Sync operation failed' end;
  if incident.id is null then
    insert into public.project_sync_incidents(project_id,reason) values(p_project_id,reason_code) returning * into incident;
  else
    update public.project_sync_incidents set failure_count=failure_count+1,last_failed_at=now(),reason=reason_code
      where id=incident.id returning * into incident;
  end if;
  if incident.alert_outbox_id is not null or incident.failure_count < 3
    or now() < incident.first_failed_at + interval '5 minutes' then return false; end if;
  -- Sync details are private; never fall back to a studio/public channel.
  if coalesce(p_channel,'') !~ '^D[A-Z0-9]+$' then raise exception 'Private sync alert destination not configured'; end if;
  insert into public.kit_control_outbox(project_id,kind,payload) values(p_project_id,'sync_alert',
    jsonb_build_object('channel',p_channel,'text',':red_circle: ' || label ||
      ' has not synced after repeated attempts over at least five minutes. Kit is still retrying. <' || detail_url || '|Inspect and retry>')) returning id into outbox_id;
  update public.project_sync_incidents set alert_outbox_id=outbox_id where id=incident.id;
  update public.project_control_bindings set error_notified_key=p_key where project_id=p_project_id;
  return true;
end $$;
revoke all on function public.enqueue_project_sync_alert(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.enqueue_project_sync_alert(uuid,text,text,text) to service_role;
