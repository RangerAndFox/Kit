-- Slack controls are bound to immutable projects; receipt delivery reuses the
-- existing service-only, retry-safe outbox. No public grants or new scheduler.
alter table public.project_control_bindings
  add column refresh_channel_id text,
  add column refresh_message_ts text,
  add column refresh_message_url text,
  add column refresh_started_at timestamptz;

create function public.enqueue_slack_project_refresh(p_workspace_id uuid,p_project_id uuid,p_actor text,p_dm_channel text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare request_id uuid; receipt_id uuid; project_label text;
begin
  if coalesce(p_actor,'') !~ '^[UW][A-Z0-9]+$' or coalesce(p_dm_channel,'') !~ '^D[A-Z0-9]+$' then raise exception 'Invalid Slack identity'; end if;
  select p.project_code into project_label from public.projects p
    join public.project_control_bindings b on b.project_id=p.id
    where p.id=p_project_id and p.workspace_id=p_workspace_id and b.creation_state='connected'
    for update of b;
  if not found then raise exception 'Project is not connected'; end if;
  select id into request_id from public.kit_control_outbox
    where project_id=p_project_id and kind='control_action'
      and payload->>'source'='slack_refresh' and status in ('pending','processing','retry')
    order by created_at limit 1;
  if request_id is null then
    insert into public.kit_control_outbox(project_id,kind,payload)
      values(p_project_id,'control_action',jsonb_build_object('action','reconcile_project','source','slack_refresh',
        'workspaceId',p_workspace_id,'actor',p_actor)) returning id into request_id;
  end if;
  -- Each requester gets one private receipt for this run, even if many people
  -- click the public control. Deferred until the parent is durably complete.
  receipt_id := md5(request_id::text||':'||p_actor)::uuid;
  insert into public.kit_control_outbox(id,project_id,kind,payload,next_attempt_at)
    values(receipt_id,p_project_id,'sync_alert',jsonb_build_object('refreshId',request_id,'channel',p_dm_channel,
      'projectLabel',regexp_replace(coalesce(project_label,'Project'),'[^A-Za-z0-9 _-]','','g')),'infinity')
    on conflict (id) do nothing;
  return request_id;
end $$;

create function public.finish_slack_project_refresh(p_id uuid,p_token uuid,p_status text,p_error text default null,p_slack_ts text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare finished boolean; synced_at timestamptz;
begin
  finished := public.finish_control_outbox(p_id,p_token,p_status,p_error,p_slack_ts);
  if not finished then return false; end if;
  if p_status in ('sent','review') then
    select b.last_synced_at into synced_at from public.project_control_bindings b
      join public.kit_control_outbox o on o.project_id=b.project_id where o.id=p_id;
    update public.kit_control_outbox set next_attempt_at=now(), updated_at=now(),
      payload=payload||jsonb_build_object('text',case when p_status='sent' then
        '✅ '||(payload->>'projectLabel')||' synced successfully. Overview, Reference and Schedule have been refreshed from the saved Sheet data. Notes & Feedback were preserved. Last synced: '||coalesce(to_char(synced_at at time zone 'America/New_York','Mon DD, YYYY HH12:MI AM'),'see Overview')||' Eastern.'
        else '⚠️ '||(payload->>'projectLabel')||' could not finish syncing. Your Sheet edits are retained. Kit needs attention; the last successful sync remains recorded. Try Sync now again or ask an administrator to inspect the control center.' end)
      where kind='sync_alert' and payload->>'refreshId'=p_id::text and status='pending';
  end if;
  return true;
end $$;
revoke all on function public.enqueue_slack_project_refresh(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.finish_slack_project_refresh(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.enqueue_slack_project_refresh(uuid,uuid,text,text) to service_role;
grant execute on function public.finish_slack_project_refresh(uuid,uuid,text,text,text) to service_role;
