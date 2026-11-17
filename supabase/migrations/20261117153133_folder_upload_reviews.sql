-- Folder decisions are atomic snapshots; execution/receipts remain per exact file.
create function public.frame_upload_folder_path(p_path text) returns text
language sql immutable strict set search_path=public as $$
  select case when lower(p_path) ~ '^/production/[0-9]{4}/[^/]+/09_outgoing/(01_client progress|02_delivery)/[^/]+'
    then array_to_string(parts[1:least(array_length(parts,1)-1,7)],'/') end
  from (select string_to_array(lower(p_path),'/') parts) x
$$;
revoke all on function public.frame_upload_folder_path(text) from public,anon,authenticated;
grant execute on function public.frame_upload_folder_path(text) to service_role;

create table public.frame_upload_folder_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  folder_path text not null check(folder_path=lower(folder_path) and folder_path like '/production/%'),
  generation bigint not null default 1,
  manifest jsonb not null default '[]',
  slack_channel_id text,
  slack_message_ts text,
  notice_token uuid,
  notice_claimed_at timestamptz,
  notice_dirty boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(project_id,folder_path),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id) on delete cascade
);
alter table public.frame_upload_folder_reviews enable row level security;
revoke all on public.frame_upload_folder_reviews from public,anon,authenticated;
grant all on public.frame_upload_folder_reviews to service_role;
create index frame_upload_folder_workspace_project on public.frame_upload_folder_reviews(workspace_id,project_id);
create index frame_upload_approval_folder on public.frame_upload_approvals(project_id,public.frame_upload_folder_path(source_path));
alter table public.frame_upload_review_slots add column folder_notice_closed boolean not null default false;

create function public.frame_upload_folder_manifest(p_project uuid,p_folder text) returns jsonb
language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'version',a.approval_version) order by a.id),'[]')
  from public.frame_upload_review_slots s join public.frame_upload_approvals a on a.id=s.current_approval_id
  where s.project_id=p_project and a.project_id=p_project and a.workspace_id=s.workspace_id
    and public.frame_upload_folder_path(a.source_path)=p_folder and a.state='awaiting'
$$;

create function public.prepare_frame_upload_folder(p_project uuid,p_folder text) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare ws uuid; f public.frame_upload_folder_reviews; m jsonb; files jsonb; slots jsonb; dirty jsonb; legacy jsonb; old_channel text; old_ts text;
begin
  -- Same lock/order as register_frame_upload_source: a new file cannot slip into a decision.
  select workspace_id into ws from public.projects where id=p_project and coalesce(status,'') not in ('archived','cancelled') for update;
  if not found or p_folder is null or p_folder<>lower(p_folder) then return null; end if;
  m:=public.frame_upload_folder_manifest(p_project,p_folder);
  select * into f from public.frame_upload_folder_reviews where project_id=p_project and folder_path=p_folder;
  if f.id is null then
    if not exists(select 1 from public.frame_upload_review_slots s join public.frame_upload_approvals a on a.id=s.current_approval_id where s.project_id=p_project and public.frame_upload_folder_path(a.source_path)=p_folder) then return null; end if;
    select s.slack_channel_id,s.slack_message_ts into old_channel,old_ts from public.frame_upload_review_slots s
      join public.frame_upload_approvals a on a.id=s.current_approval_id where s.project_id=p_project
      and public.frame_upload_folder_path(a.source_path)=p_folder and s.slack_channel_id is not null and s.slack_message_ts is not null
      order by s.slack_message_ts,s.id limit 1;
    insert into public.frame_upload_folder_reviews(workspace_id,project_id,folder_path,manifest,slack_channel_id,slack_message_ts)
      values(ws,p_project,p_folder,m,old_channel,old_ts) returning * into f;
  elsif f.manifest is distinct from m then
    update public.frame_upload_folder_reviews set manifest=m,generation=generation+1,notice_dirty=true,updated_at=now() where id=f.id returning * into f;
  end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.source_path,a.id),'[]') into files
    from public.frame_upload_review_slots s join public.frame_upload_approvals a on a.id=s.current_approval_id
    where s.project_id=p_project and a.project_id=p_project and public.frame_upload_folder_path(a.source_path)=p_folder;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]') into slots
    from public.frame_upload_review_slots s join public.frame_upload_approvals a on a.id=s.current_approval_id
    where s.project_id=p_project and public.frame_upload_folder_path(a.source_path)=p_folder;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'updated_at',a.updated_at) order by a.id),'[]') into dirty
    from public.frame_upload_approvals a where a.project_id=p_project and a.notice_dirty
      and a.review_slot_id in (select (v->>'id')::uuid from jsonb_array_elements(slots) v);
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') into legacy
    from public.frame_upload_approvals a where a.project_id=p_project and not a.review_notice_closed and a.slack_message_ts is not null
      and a.review_slot_id in (select (v->>'id')::uuid from jsonb_array_elements(slots) v);
  return jsonb_build_object('folder',to_jsonb(f),'files',files,'slots',slots,'dirty',dirty,'legacy',legacy);
end $$;

create function public.list_frame_upload_folder_notices(p_request uuid default null) returns table(project_id uuid,folder_path text)
language sql security invoker set search_path=public as $$
  select s.project_id,public.frame_upload_folder_path(a.source_path) from public.frame_upload_review_slots s
  join public.frame_upload_approvals a on a.id=s.current_approval_id join public.projects p on p.id=s.project_id
  where (s.notice_dirty or exists(select 1 from public.frame_upload_approvals d where d.review_slot_id=s.id and d.notice_dirty)
    or exists(select 1 from public.frame_upload_folder_reviews f where f.project_id=s.project_id and f.folder_path=public.frame_upload_folder_path(a.source_path) and f.notice_dirty)
    or (a.state='awaiting' and not exists(select 1 from public.frame_upload_folder_reviews f where f.project_id=s.project_id and f.folder_path=public.frame_upload_folder_path(a.source_path))))
    and coalesce(p.status,'') not in ('archived','cancelled') and public.frame_upload_folder_path(a.source_path) is not null
    and (p_request is null or public.frame_upload_folder_path(a.source_path)=(select public.frame_upload_folder_path(r.source_path) from public.frame_upload_approvals r where r.id=p_request and r.project_id=s.project_id))
  group by s.project_id,public.frame_upload_folder_path(a.source_path) order by min(s.updated_at),s.project_id limit 10
$$;

create function public.claim_frame_upload_folder_notice(p_id uuid,p_token uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_folder_reviews set notice_token=p_token,notice_claimed_at=now()
    where id=p_id and (notice_token is null or notice_claimed_at<now()-interval '5 minutes');
  return found;
end $$;

create function public.save_frame_upload_folder_notice(p_id uuid,p_token uuid,p_channel text,p_ts text default null) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_folder_reviews set slack_channel_id=p_channel,slack_message_ts=coalesce(p_ts,slack_message_ts)
    where id=p_id and notice_token=p_token and notice_claimed_at>now()-interval '5 minutes'
      and (slack_channel_id is null or slack_channel_id=p_channel) and (p_ts is null or slack_message_ts is null or slack_message_ts=p_ts);
  return found;
end $$;

create function public.finish_frame_upload_folder_notice(p_id uuid,p_token uuid,p_generation bigint,p_success boolean,p_seen jsonb) returns boolean
language plpgsql security invoker set search_path=public as $$
declare f public.frame_upload_folder_reviews;
begin
  select * into f from public.frame_upload_folder_reviews where id=p_id and notice_token=p_token and notice_claimed_at>now()-interval '5 minutes' for update;
  if not found then return false; end if;
  if p_success and f.generation=p_generation then
    update public.frame_upload_approvals a set notice_dirty=false from jsonb_to_recordset(p_seen) x(id uuid,updated_at timestamptz)
      where a.id=x.id and a.updated_at=x.updated_at and a.project_id=f.project_id and a.workspace_id=f.workspace_id
        and exists(select 1 from public.frame_upload_review_slots s join public.frame_upload_approvals h on h.id=s.current_approval_id
          where s.id=a.review_slot_id and public.frame_upload_folder_path(h.source_path)=f.folder_path);
    update public.frame_upload_approvals a set review_notice_closed=true where a.project_id=f.project_id
      and a.id in (select (v->>'id')::uuid from jsonb_array_elements(p_seen) v);
    update public.frame_upload_review_slots s set folder_notice_closed=true,
      notice_dirty=exists(select 1 from public.frame_upload_approvals a where a.review_slot_id=s.id and a.notice_dirty),updated_at=now()
      where s.project_id=f.project_id and exists(select 1 from public.frame_upload_approvals h where h.id=s.current_approval_id and public.frame_upload_folder_path(h.source_path)=f.folder_path);
  else
    -- A failed/changed folder rotates behind other work without losing its dirty hold.
    update public.frame_upload_review_slots s set updated_at=now() where s.project_id=f.project_id
      and exists(select 1 from public.frame_upload_approvals h where h.id=s.current_approval_id and public.frame_upload_folder_path(h.source_path)=f.folder_path);
  end if;
  update public.frame_upload_folder_reviews set notice_token=null,notice_dirty=not(p_success and generation=p_generation and not exists(
    select 1 from public.frame_upload_review_slots s join public.frame_upload_approvals h on h.id=s.current_approval_id
      where s.project_id=f.project_id and public.frame_upload_folder_path(h.source_path)=f.folder_path and s.notice_dirty)),updated_at=now()
    where id=p_id and notice_token=p_token;
  return true;
end $$;

create function public.decide_frame_upload_folder(p_id uuid,p_workspace uuid,p_actor text,p_generation bigint,p_names jsonb,p_cancel boolean default false) returns boolean
language plpgsql security invoker set search_path=public as $$
declare f public.frame_upload_folder_reviews; pid uuid; m jsonb; r public.frame_upload_approvals; chosen text;
begin
  select project_id into pid from public.frame_upload_folder_reviews where id=p_id and workspace_id=p_workspace;
  if not found then return false; end if;
  perform id from public.projects where id=pid and workspace_id=p_workspace and coalesce(status,'') not in ('archived','cancelled') for update;
  if not found then return false; end if;
  select * into f from public.frame_upload_folder_reviews where id=p_id for update;
  m:=public.frame_upload_folder_manifest(pid,f.folder_path);
  if f.generation<>p_generation or f.manifest<>m or m='[]' then return false; end if;
  if nullif(p_actor,'') is null or p_cancel is null then raise exception 'Invalid folder decision'; end if;
  if not p_cancel and (jsonb_typeof(p_names)<>'array' or jsonb_array_length(p_names)<>jsonb_array_length(m)) then raise exception 'Incomplete filename manifest'; end if;
  for r in select a.* from public.frame_upload_approvals a join jsonb_array_elements(m) v on a.id=(v->>'id')::uuid order by a.id for update of a loop
    if not p_cancel then
      if (select count(*) from jsonb_array_elements(p_names) n where n->>'id'=r.id::text)<>1 then raise exception 'Filename manifest changed'; end if;
      select n->>'name' into chosen from jsonb_array_elements(p_names) n where n->>'id'=r.id::text;
      if chosen is null or chosen !~ '^R&F_' or length(chosen)>240 or chosen ~ '[/\\]' or chosen ~ '[[:cntrl:]]'
        or lower(substring(chosen from '\.[a-zA-Z0-9]{1,8}$')) is distinct from lower(substring(r.source_path from '\.[a-zA-Z0-9]{1,8}$')) then raise exception 'Invalid filename'; end if;
    else chosen:=''; end if;
    if not public.decide_frame_upload(r.id,p_workspace,p_actor,chosen,case when p_cancel then 'skip' else 'new' end) then raise exception 'Folder decision changed'; end if;
  end loop;
  update public.frame_upload_folder_reviews set manifest='[]',generation=generation+1,notice_dirty=true,updated_at=now() where id=p_id;
  return true;
end $$;

-- New RPCs are backend-only. No public/user access to approval identities.
revoke all on function public.frame_upload_folder_manifest(uuid,text),public.prepare_frame_upload_folder(uuid,text),public.list_frame_upload_folder_notices(uuid),public.claim_frame_upload_folder_notice(uuid,uuid),public.save_frame_upload_folder_notice(uuid,uuid,text,text),public.finish_frame_upload_folder_notice(uuid,uuid,bigint,boolean,jsonb),public.decide_frame_upload_folder(uuid,uuid,text,bigint,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.frame_upload_folder_manifest(uuid,text),public.prepare_frame_upload_folder(uuid,text),public.list_frame_upload_folder_notices(uuid),public.claim_frame_upload_folder_notice(uuid,uuid),public.save_frame_upload_folder_notice(uuid,uuid,text,text),public.finish_frame_upload_folder_notice(uuid,uuid,bigint,boolean,jsonb),public.decide_frame_upload_folder(uuid,uuid,text,bigint,jsonb,boolean) to service_role;

-- Existing pending rows are discovered lazily by the new publisher. The migration
-- does not dirty old-runtime cards or approve/queue anything during rollout.
