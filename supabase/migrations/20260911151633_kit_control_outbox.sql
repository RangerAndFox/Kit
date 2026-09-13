-- Internal-only durable control actions and Slack notification deliveries.
-- Filename aligned with the applied production migration version.
create table public.kit_control_outbox (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  action_id uuid references public.kit_actions(id) on delete cascade,
  kind text not null check (kind in ('sync_alert','control_action')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','retry','sent','review')),
  attempts integer not null default 0,
  send_started boolean not null default false,
  slack_ts text,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.kit_control_outbox enable row level security;
revoke all on public.kit_control_outbox from public, anon, authenticated;
grant all on public.kit_control_outbox to service_role;
create index kit_control_outbox_pending on public.kit_control_outbox(next_attempt_at) where status in ('pending','retry','processing');
create index kit_control_outbox_project on public.kit_control_outbox(project_id);
create index kit_control_outbox_action on public.kit_control_outbox(action_id);

-- The old marker now means durably ENQUEUED, never "Slack confirmed".
create function public.enqueue_project_sync_alert(p_project_id uuid, p_key text, p_channel text, p_text text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare previous text;
begin
  select error_notified_key into previous from public.project_control_bindings where project_id=p_project_id for update;
  if not found or previous is not distinct from p_key then return false; end if;
  if coalesce(p_channel,'')='' then raise exception 'Alert channel not configured'; end if;
  insert into public.kit_control_outbox(project_id,kind,payload)
    values(p_project_id,'sync_alert',jsonb_build_object('channel',p_channel,'text',p_text));
  update public.project_control_bindings set error_notified_key=p_key where project_id=p_project_id;
  return true;
end $$;

create function public.enqueue_control_action(p_id uuid,p_workspace_id uuid,p_project_id uuid,p_action text,p_actor uuid,p_job_id uuid default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
begin
  if p_action not in ('reconcile_project','retry_behance') then raise exception 'Invalid action'; end if;
  if not exists(select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id) then raise exception 'Project not found'; end if;
  insert into public.kit_actions(id,workspace_id,project_id,action_type,title,body,priority,status,requires_approval,min_tier_to_view)
    values(p_id,p_workspace_id,p_project_id,'control_center:'||p_action,p_action,
      'Durably queued by authenticated administrator '||p_actor::text||'. Request '||p_id::text,'normal','approved',false,'founder');
  insert into public.kit_control_outbox(id,project_id,action_id,kind,payload)
    values(p_id,p_project_id,p_id,'control_action',jsonb_build_object('action',p_action,'workspaceId',p_workspace_id,'actor',p_actor,'jobId',p_job_id));
  return p_id;
end $$;

create function public.claim_control_outbox(p_id uuid,p_token uuid)
returns setof public.kit_control_outbox language sql security invoker set search_path = '' as $$
  update public.kit_control_outbox set status='processing',lease_token=p_token,lease_until=now()+interval '6 minutes',attempts=attempts+1,updated_at=now()
  where id=p_id and next_attempt_at<=now() and (status in ('pending','retry') or (status='processing' and lease_until<now()))
  returning *;
$$;

-- Receipt + human-facing audit are one transaction. A failed checkpoint can be retried safely.
create function public.finish_control_outbox(p_id uuid,p_token uuid,p_status text,p_error text default null,p_slack_ts text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare action uuid;
begin
  if p_status not in ('retry','sent','review') then raise exception 'Invalid completion'; end if;
  update public.kit_control_outbox set status=p_status,last_error=p_error,slack_ts=coalesce(p_slack_ts,slack_ts),lease_token=null,lease_until=null,
    next_attempt_at=now()+interval '1 minute',updated_at=now()
    where id=p_id and lease_token=p_token and lease_until>now() returning action_id into action;
  if not found then return false; end if;
  if action is not null then
    update public.kit_actions set status=case when p_status='sent' then 'sent' else 'approved' end,
      body='Control request '||p_id::text||': '||case when p_status='sent' then 'Action completed (Behance retry means queued for draft creation, not published).' when p_status='review' then 'Needs manual review.' else 'Retry pending.' end,
      acted_at=case when p_status='sent' then now() else null end where id=action;
  end if;
  return true;
end $$;
revoke all on function public.enqueue_project_sync_alert(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.enqueue_control_action(uuid,uuid,uuid,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.claim_control_outbox(uuid,uuid) from public,anon,authenticated;
revoke all on function public.finish_control_outbox(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.enqueue_project_sync_alert(uuid,text,text,text) to service_role;
grant execute on function public.enqueue_control_action(uuid,uuid,uuid,text,uuid,uuid) to service_role;
grant execute on function public.claim_control_outbox(uuid,uuid) to service_role;
grant execute on function public.finish_control_outbox(uuid,uuid,text,text,text) to service_role;
