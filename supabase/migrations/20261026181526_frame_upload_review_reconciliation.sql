-- One private review card per logical file, not per Dropbox ID/revision.
-- Railway still owns detection, approval execution and the bounded outbox.
alter table public.frame_upload_approvals
  add constraint frame_upload_approvals_workspace_project_id unique(workspace_id,project_id,id);
create table public.frame_upload_review_slots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  path_key text not null check(path_key like '/%' and path_key=lower(path_key)),
  current_approval_id uuid,
  anchor_approval_id uuid,
  completed_approval_id uuid,
  source_modified_at timestamptz,
  generation bigint not null default 1,
  notice_dirty boolean not null default true,
  notice_token uuid,
  notice_claimed_at timestamptz,
  slack_channel_id text,
  slack_message_ts text,
  last_error text,
  updated_at timestamptz not null default now(),
  unique(project_id,path_key),
  unique(workspace_id,project_id,id),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id) on delete cascade,
  foreign key(workspace_id,project_id,current_approval_id) references public.frame_upload_approvals(workspace_id,project_id,id),
  foreign key(workspace_id,project_id,anchor_approval_id) references public.frame_upload_approvals(workspace_id,project_id,id),
  foreign key(workspace_id,project_id,completed_approval_id) references public.frame_upload_approvals(workspace_id,project_id,id)
);
alter table public.frame_upload_review_slots enable row level security;
revoke all on public.frame_upload_review_slots from public,anon,authenticated;
grant select,insert,update on public.frame_upload_review_slots to service_role;
create index frame_upload_review_slots_dirty on public.frame_upload_review_slots(updated_at) where notice_dirty;
alter table public.frame_upload_approvals add column review_slot_id uuid, add column review_notice_closed boolean not null default false;
alter table public.frame_upload_approvals add constraint frame_upload_approval_review_scope
  foreign key(workspace_id,project_id,review_slot_id) references public.frame_upload_review_slots(workspace_id,project_id,id);
create index frame_upload_approvals_review_slot on public.frame_upload_approvals(review_slot_id);
create index frame_upload_approvals_dirty_slot on public.frame_upload_approvals(review_slot_id,updated_at) where notice_dirty;
create index frame_upload_approvals_completed_path on public.frame_upload_approvals(project_id,lower(coalesce(renamed_path,source_path)),updated_at desc)
  where state='complete' and frame_file_id is not null;

-- Adopt receipts without sending, deleting, approving or uploading anything.
-- Legacy pending approvals are reconciled only after a fresh provider read.
insert into public.frame_upload_review_slots(workspace_id,project_id,path_key,current_approval_id,anchor_approval_id,completed_approval_id,slack_channel_id,slack_message_ts,source_modified_at,notice_dirty)
select workspace_id,project_id,lower(coalesce(renamed_path,source_path)),
  (array_agg(id order by created_at desc,id desc))[1],
  (array_agg(id order by (slack_message_ts is not null) desc,(slack_channel_id is not null) desc,created_at,id))[1],
  (array_agg(id order by updated_at desc,id desc) filter(where state='complete' and frame_file_id is not null))[1],
  (array_agg(slack_channel_id order by (slack_message_ts is not null) desc,created_at,id) filter(where slack_channel_id is not null))[1],
  (array_agg(slack_message_ts order by created_at,id) filter(where slack_message_ts is not null and slack_channel_id is not null))[1],
  max(coalesce(nullif(source_payload->>'source_modified_at','')::timestamptz,created_at)),
  bool_or(notice_dirty) or (count(distinct slack_message_ts)>1 and bool_or(state='awaiting'))
from public.frame_upload_approvals group by workspace_id,project_id,lower(coalesce(renamed_path,source_path));
update public.frame_upload_approvals a set review_slot_id=s.id
from public.frame_upload_review_slots s where a.project_id=s.project_id and a.workspace_id=s.workspace_id
  and lower(coalesce(a.renamed_path,a.source_path))=s.path_key;

-- Short DB-only transaction. Serialize registration per project; source reads
-- and Slack/Frame calls happen outside this lock. Older observations cannot
-- replace a newer logical-file head. All write RPCs remain service-only.
create function public.register_frame_upload_source(p_project uuid,p_source jsonb,p_size bigint,p_suggested text)
returns uuid language plpgsql security invoker set search_path=public as $$
declare ws uuid; r public.frame_upload_approvals; s public.frame_upload_review_slots;
  previous public.frame_upload_approvals; done public.frame_upload_approvals;
  key text; modified timestamptz; prior_modified timestamptz; hash text; duplicate boolean:=false;
begin
  select workspace_id into ws from public.projects where id=p_project and coalesce(status,'') not in ('archived','cancelled') for update;
  if not found then return null; end if;
  key:=lower(p_source->>'path');
  if key is null or key not like '/%' or coalesce(p_source->>'dropboxId','') not like 'id:%'
    or coalesce(p_source->>'rev','') !~ '^[a-f0-9]{9,}$' or p_size is null or p_size<=0 then raise exception 'Invalid upload source'; end if;
  modified:=coalesce(nullif(p_source->>'source_modified_at','')::timestamptz,now());
  hash:=lower(p_source->>'content_hash');
  if hash is not null and hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid content hash'; end if;
  select * into r from public.frame_upload_approvals where project_id=p_project and source_file_id=p_source->>'dropboxId' and source_rev=p_source->>'rev';
  if found and r.review_slot_id is not null then
    select * into s from public.frame_upload_review_slots where id=r.review_slot_id;
  else
    select x.* into s from public.frame_upload_review_slots x
      left join public.frame_upload_approvals head on head.id=x.current_approval_id
      where x.project_id=p_project and (x.path_key=key or lower(head.renamed_path)=key or head.source_file_id=p_source->>'dropboxId')
      order by (x.path_key=key) desc,x.id limit 1;
  end if;
  if s.id is null then
    insert into public.frame_upload_review_slots(workspace_id,project_id,path_key) values(ws,p_project,key) returning * into s;
  end if;
  -- Retire only unattempted obsolete requests. Never rearm an attempted POST,
  -- change a completed receipt, or transfer another reviewer's collision.
  select * into previous from public.frame_upload_approvals where id=s.current_approval_id;
  prior_modified:=greatest(s.source_modified_at,coalesce(nullif(previous.source_payload->>'source_modified_at','')::timestamptz,previous.created_at));
  if r.id is null then
    insert into public.frame_upload_approvals(workspace_id,project_id,source_file_id,source_rev,source_size,source_path,source_payload,suggested_name,review_slot_id)
    values(ws,p_project,p_source->>'dropboxId',p_source->>'rev',p_size,p_source->>'path',p_source||jsonb_build_object('sizeBytes',p_size),p_suggested,s.id)
    returning * into r;
  elsif r.source_size<>p_size then raise exception 'Immutable source size changed';
  end if;
  if r.review_slot_id is null then update public.frame_upload_approvals set review_slot_id=s.id where id=r.id; end if;
  -- A fresh read may enrich a legacy pending snapshot, never its decision.
  if r.state='awaiting' and r.upload_attempted_at is null then
    update public.frame_upload_approvals set source_payload=source_payload||jsonb_strip_nulls(jsonb_build_object('content_hash',hash,'source_modified_at',p_source->>'source_modified_at')),
      suggested_name=case when approved_by is null then p_suggested else suggested_name end where id=r.id;
  end if;
  if s.current_approval_id is distinct from r.id and prior_modified is not null and modified<prior_modified then
    update public.frame_upload_approvals set state='superseded',detail='A newer source observation already owns the shared review.',notice_dirty=true,updated_at=now()
      where id=r.id and state='awaiting' and upload_attempted_at is null;
    return r.id;
  end if;
  select * into done from public.frame_upload_approvals where review_slot_id=s.id and state='complete' and frame_file_id is not null order by updated_at desc,id desc limit 1;
  duplicate:=done.id is not null and done.id<>r.id and done.source_size=p_size and hash is not null and
    ((r.state='awaiting' and r.upload_attempted_at is null) or (r.state='superseded' and r.source_payload->>'duplicate_of_approval_id'=done.id::text)) and
    p_source->>'verified_frame_file_id'=done.frame_file_id and
    hash=coalesce(lower(done.source_payload->>'content_hash'),lower(done.source_payload->'rename_intent'->>'content_hash'));
  update public.frame_upload_approvals set state='superseded',detail='A verified current Dropbox source replaced this request. Use the shared review card.',notice_dirty=true,updated_at=now()
    where project_id=p_project and workspace_id=ws and id<>r.id and (review_slot_id=s.id or (source_file_id=r.source_file_id and source_rev<>r.source_rev))
      and state in ('awaiting','approved','collision') and upload_attempted_at is null
      and coalesce(nullif(source_payload->>'source_modified_at','')::timestamptz,created_at)<=modified;
  if duplicate and r.state='awaiting' and r.upload_attempted_at is null then
    update public.frame_upload_approvals set state='superseded',detail='Identical approved bytes already have a completed Frame receipt. No new upload queued.',
      source_payload=source_payload||jsonb_build_object('duplicate_of_approval_id',done.id),notice_dirty=true,updated_at=now() where id=r.id;
  end if;
  update public.frame_upload_review_slots set current_approval_id=case when duplicate then done.id else r.id end,
    completed_approval_id=coalesce(done.id,completed_approval_id),
    anchor_approval_id=coalesce(anchor_approval_id,r.id),path_key=key,source_modified_at=greatest(modified,source_modified_at),notice_dirty=true,generation=generation+1,updated_at=now() where id=s.id;
  return r.id;
end $$;
revoke all on function public.register_frame_upload_source(uuid,jsonb,bigint,text) from public,anon,authenticated;
grant execute on function public.register_frame_upload_source(uuid,jsonb,bigint,text) to service_role;

create function public.find_completed_frame_upload_receipt(p_project uuid,p_path text,p_size bigint,p_hash text) returns jsonb
language sql security invoker set search_path=public as $$
  select to_jsonb(a) from public.frame_upload_approvals a where project_id=p_project and state='complete' and frame_file_id is not null
    and lower(coalesce(renamed_path,source_path))=lower(p_path) and source_size=p_size and p_hash ~ '^[a-f0-9]{64}$'
    and coalesce(lower(source_payload->>'content_hash'),lower(source_payload->'rename_intent'->>'content_hash'))=p_hash
  order by updated_at desc,id desc limit 1
$$;
revoke all on function public.find_completed_frame_upload_receipt(uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function public.find_completed_frame_upload_receipt(uuid,text,bigint,text) to service_role;

-- Existing per-approval dirty flags remain the outcome outbox, including during
-- a rolling deploy. Avoid row->slot update triggers (opposite lock order to
-- source registration). The publisher coalesces dirty rows into their slot.
create function public.list_pending_frame_upload_reviews(p_request uuid default null) returns setof public.frame_upload_review_slots
language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_review_slots set notice_dirty=true where id in (
    select s.id from public.frame_upload_approvals a join public.frame_upload_review_slots s on s.id=a.review_slot_id join public.projects p on p.id=a.project_id
    where a.notice_dirty and a.review_slot_id is not null and coalesce(p.status,'') not in ('archived','cancelled')
      and (p_request is null or a.id=p_request) group by s.id order by s.updated_at,s.id limit 30);
  return query select s.* from public.frame_upload_review_slots s join public.projects p on p.id=s.project_id
    where s.notice_dirty and coalesce(p.status,'') not in ('archived','cancelled') and
      (p_request is null or s.id=(select review_slot_id from public.frame_upload_approvals where id=p_request))
    order by s.updated_at,s.id limit 10;
end $$;
revoke all on function public.list_pending_frame_upload_reviews(uuid) from public,anon,authenticated;
grant execute on function public.list_pending_frame_upload_reviews(uuid) to service_role;

create function public.claim_frame_upload_review_slot(p_id uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare s public.frame_upload_review_slots; legacy jsonb; completed uuid; dirty jsonb;
begin
  update public.frame_upload_review_slots set notice_token=p_token,notice_claimed_at=now()
    where id=p_id and notice_dirty and (notice_token is null or notice_claimed_at<now()-interval '2 minutes') returning * into s;
  if not found then return null; end if;
  select id into completed from public.frame_upload_approvals where review_slot_id=s.id and state='complete' and frame_file_id is not null order by updated_at desc,id desc limit 1;
  if completed is not null then
    update public.frame_upload_review_slots set completed_approval_id=completed where id=s.id;
    s.completed_approval_id:=completed;
  end if;
  select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) into legacy from
    (select * from public.frame_upload_approvals where review_slot_id=s.id and not review_notice_closed
      and slack_message_ts is not null and (slack_message_ts is distinct from s.slack_message_ts or slack_channel_id is distinct from s.slack_channel_id)
      order by created_at,id limit 10) a;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'updated_at',a.updated_at)),'[]'::jsonb) into dirty from
    (select id,updated_at from public.frame_upload_approvals where review_slot_id=s.id and notice_dirty order by updated_at,id limit 50) a;
  return jsonb_build_object('slot',to_jsonb(s),'current',(select to_jsonb(a) from public.frame_upload_approvals a where id=s.current_approval_id),
    'completed',(select to_jsonb(a) from public.frame_upload_approvals a where id=s.completed_approval_id),'legacy',legacy,'dirty_approvals',dirty);
end $$;
revoke all on function public.claim_frame_upload_review_slot(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_frame_upload_review_slot(uuid,uuid) to service_role;

create function public.save_frame_upload_review_receipt(p_id uuid,p_token uuid,p_channel text,p_ts text default null) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_review_slots set slack_channel_id=p_channel,slack_message_ts=coalesce(p_ts,slack_message_ts)
    where id=p_id and notice_token=p_token and notice_claimed_at>now()-interval '2 minutes'
      and (slack_channel_id is null or slack_channel_id=p_channel) and (p_ts is null or slack_message_ts is null or slack_message_ts=p_ts);
  return found;
end $$;
revoke all on function public.save_frame_upload_review_receipt(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.save_frame_upload_review_receipt(uuid,uuid,text,text) to service_role;

create function public.close_legacy_frame_upload_notice(p_slot uuid,p_token uuid,p_approval uuid,p_ts text) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_approvals a set review_notice_closed=true where id=p_approval and review_slot_id=p_slot and slack_message_ts=p_ts
    and exists(select 1 from public.frame_upload_review_slots s where s.id=p_slot and s.notice_token=p_token and s.notice_claimed_at>now()-interval '2 minutes');
  return found;
end $$;
revoke all on function public.close_legacy_frame_upload_notice(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.close_legacy_frame_upload_notice(uuid,uuid,uuid,text) to service_role;

create function public.finish_frame_upload_review_notice(p_id uuid,p_token uuid,p_generation bigint,p_success boolean,p_seen jsonb) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  -- Ack only state snapshots actually rendered. A late outcome/replacement must
  -- remain dirty even when it arrives while Slack is processing an update.
  if p_success and exists(select 1 from public.frame_upload_review_slots where id=p_id and notice_token=p_token and notice_claimed_at>now()-interval '2 minutes') then
    update public.frame_upload_approvals a set notice_dirty=false from jsonb_to_recordset(p_seen) as seen(id uuid,updated_at timestamptz)
      where a.id=seen.id and a.review_slot_id=p_id and a.updated_at=seen.updated_at;
  end if;
  update public.frame_upload_review_slots s set notice_token=null,notice_dirty=not(p_success and notice_claimed_at>now()-interval '2 minutes' and generation=p_generation
      and not exists(select 1 from public.frame_upload_approvals a where a.review_slot_id=s.id and a.notice_dirty)
      and not exists(select 1 from public.frame_upload_approvals a where a.review_slot_id=s.id and not a.review_notice_closed
        and a.slack_message_ts is not null and (a.slack_message_ts is distinct from s.slack_message_ts or a.slack_channel_id is distinct from s.slack_channel_id))),
      last_error=case when p_success then null else 'Review update deferred; retry pending' end,updated_at=now()
    where id=p_id and notice_token=p_token;
  return found;
end $$;
revoke all on function public.finish_frame_upload_review_notice(uuid,uuid,bigint,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.finish_frame_upload_review_notice(uuid,uuid,bigint,boolean,jsonb) to service_role;
