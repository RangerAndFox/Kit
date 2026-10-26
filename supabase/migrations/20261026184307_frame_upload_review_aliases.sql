-- Preserve both the original source and approved rename as logical-file aliases.
-- Additive follow-up: the already-applied reconciliation migration is immutable.
create index frame_upload_approvals_completed_source on public.frame_upload_approvals(project_id,lower(source_path),updated_at desc)
  where state='complete' and frame_file_id is not null;

-- Consolidate derived slots only; retain every approval, decision, upload and
-- Slack receipt. The old slot is kept inert for history, not deleted.
do $$
declare c public.frame_upload_approvals; target public.frame_upload_review_slots; other public.frame_upload_review_slots;
  newest uuid; completed uuid; watermark timestamptz;
begin
  perform id from public.projects order by id for update;
  perform id from public.frame_upload_review_slots order by id for update;
  for c in select * from public.frame_upload_approvals where state='complete' and frame_file_id is not null
    and renamed_path is not null and lower(renamed_path)<>lower(source_path) order by created_at,id loop
    select s.* into target from public.frame_upload_review_slots s join public.frame_upload_approvals a on a.review_slot_id=s.id where a.id=c.id;
    for other in select s.* from public.frame_upload_review_slots s where s.project_id=c.project_id and s.workspace_id=c.workspace_id
      and s.id<>target.id and s.current_approval_id is not null
      and (s.path_key in (lower(c.source_path),lower(c.renamed_path)) or exists(
        select 1 from public.frame_upload_approvals a where a.review_slot_id=s.id and
          (lower(a.source_path) in (lower(c.source_path),lower(c.renamed_path)) or lower(a.renamed_path) in (lower(c.source_path),lower(c.renamed_path)))))
      order by s.id loop
      if target.slack_channel_id is not null and other.slack_channel_id is not null and target.slack_channel_id<>other.slack_channel_id then
        raise exception 'Private reviewer groups differ; manual alias reconciliation required';
      end if;
      update public.frame_upload_approvals set review_slot_id=target.id where review_slot_id=other.id and workspace_id=c.workspace_id and project_id=c.project_id;
      select id into newest from public.frame_upload_approvals where review_slot_id=target.id
        order by coalesce(nullif(source_payload->>'source_modified_at','')::timestamptz,created_at) desc,created_at desc,id desc limit 1;
      select id into completed from public.frame_upload_approvals where review_slot_id=target.id and state='complete' and frame_file_id is not null order by updated_at desc,id desc limit 1;
      select max(coalesce(nullif(source_payload->>'source_modified_at','')::timestamptz,created_at)) into watermark from public.frame_upload_approvals where review_slot_id=target.id;
      update public.frame_upload_review_slots set current_approval_id=newest,completed_approval_id=completed,source_modified_at=watermark,
        notice_token=null,notice_claimed_at=null,notice_dirty=true,generation=generation+1,updated_at=now() where id=target.id;
      update public.frame_upload_review_slots set current_approval_id=null,completed_approval_id=null,notice_token=null,notice_claimed_at=null,
        notice_dirty=false,generation=generation+1,last_error='Consolidated logical-file aliases; historical slot retained',updated_at=now() where id=other.id;
    end loop;
  end loop;
end $$;

create or replace function public.register_frame_upload_source(p_project uuid,p_source jsonb,p_size bigint,p_suggested text)
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
      where x.project_id=p_project and x.current_approval_id is not null and
        (x.path_key=key or lower(head.renamed_path)=key or head.source_file_id=p_source->>'dropboxId'
          or exists(select 1 from public.frame_upload_approvals a where a.review_slot_id=x.id
            and (lower(a.source_path)=key or lower(a.renamed_path)=key)))
      order by (x.completed_approval_id is not null) desc,(x.path_key=key) desc,x.id limit 1;
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
    anchor_approval_id=coalesce(anchor_approval_id,r.id),source_modified_at=greatest(modified,source_modified_at),notice_dirty=true,generation=generation+1,updated_at=now() where id=s.id;
  return r.id;
end $$;
revoke all on function public.register_frame_upload_source(uuid,jsonb,bigint,text) from public,anon,authenticated;
grant execute on function public.register_frame_upload_source(uuid,jsonb,bigint,text) to service_role;


create or replace function public.find_completed_frame_upload_receipt(p_project uuid,p_path text,p_size bigint,p_hash text) returns jsonb
language sql security invoker set search_path=public as $$
  select to_jsonb(a) from public.frame_upload_approvals a where project_id=p_project and state='complete' and frame_file_id is not null
    and (lower(source_path)=lower(p_path) or lower(renamed_path)=lower(p_path)) and source_size=p_size and p_hash ~ '^[a-f0-9]{64}$'
    and coalesce(lower(source_payload->>'content_hash'),lower(source_payload->'rename_intent'->>'content_hash'))=p_hash
  order by updated_at desc,id desc limit 1
$$;
revoke all on function public.find_completed_frame_upload_receipt(uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function public.find_completed_frame_upload_receipt(uuid,text,bigint,text) to service_role;

-- This candidate is intentionally a separate RPC. Old application versions
-- must never mistake an unhashed candidate for verified exact-byte evidence.
create function public.find_unhashed_frame_upload_receipt(p_project uuid,p_path text,p_size bigint) returns jsonb
language sql security invoker set search_path=public as $$
  select to_jsonb(a) from public.frame_upload_approvals a where project_id=p_project and state='complete' and frame_file_id is not null
    and (lower(source_path)=lower(p_path) or lower(renamed_path)=lower(p_path)) and source_size=p_size
    and coalesce(source_payload->>'content_hash',source_payload->'rename_intent'->>'content_hash') is null
  order by updated_at desc,id desc limit 1
$$;
revoke all on function public.find_unhashed_frame_upload_receipt(uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.find_unhashed_frame_upload_receipt(uuid,text,bigint) to service_role;

create function public.save_frame_upload_receipt_hash(p_id uuid,p_workspace uuid,p_file text,p_rev text,p_size bigint,p_hash text) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  -- Append provenance only. Keep the original decision, Frame receipt, upload
  -- timestamps, state and updated_at unchanged.
  update public.frame_upload_approvals set source_payload=source_payload||jsonb_build_object(
    'content_hash',p_hash,'receipt_hash_verified_at',now(),'receipt_hash_source','dropbox-historical-revision')
    where id=p_id and workspace_id=p_workspace and state='complete' and frame_file_id is not null
      and source_file_id=p_file and source_rev=p_rev and source_size=p_size
      and coalesce(source_payload->>'content_hash',source_payload->'rename_intent'->>'content_hash') is null;
  return found;
end $$;
revoke all on function public.save_frame_upload_receipt_hash(uuid,uuid,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.save_frame_upload_receipt_hash(uuid,uuid,text,text,bigint,text) to service_role;

-- Even an uneditable legacy Slack card must fail closed at the decision gate.
create or replace function public.decide_frame_upload(p_id uuid,p_workspace uuid,p_actor text,p_name text,p_decision text,
  p_conflict_id text default null,p_conflict_type text default null)
returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.frame_upload_approvals; target text;
begin
  select * into r from public.frame_upload_approvals where id=p_id and workspace_id=p_workspace for update;
  if not found or r.state <> 'awaiting' then return false; end if;
  if not exists(select 1 from public.frame_upload_review_slots s where s.id=r.review_slot_id
    and s.workspace_id=r.workspace_id and s.project_id=r.project_id and s.current_approval_id=r.id) then return false; end if;
  if nullif(p_actor,'') is null or p_decision is null or p_decision not in ('new','replace','keep_both','skip') then
    raise exception 'Invalid upload decision';
  end if;
  if p_decision <> 'skip' and (p_name is null or length(p_name)>240 or p_name !~ '^R&F_' or p_name ~ '[/\\]' or p_name ~ '[[:cntrl:]]') then
    raise exception 'Invalid client-facing filename';
  end if;
  if p_decision='replace' and (p_conflict_id is null or p_conflict_type is null or p_conflict_type not in ('file','version_stack')) then
    raise exception 'Replacement target required';
  end if;
  target := lower((r.source_payload->>'subfolder') || '/' || regexp_replace(r.source_payload->>'name','[^/]+$','') || coalesce(p_name,''));
  update public.frame_upload_approvals set state=case when p_decision='skip' then 'skipped' else 'approved' end,
    approved_name=p_name,decision=p_decision,approved_by=p_actor,approved_at=now(),
    conflict_id=p_conflict_id,conflict_type=p_conflict_type,destination_key=target,approval_version=approval_version+1,
    notice_dirty=true,updated_at=now() where id=p_id;
  if p_decision <> 'skip' then
    -- Separate execution event avoids racing completion of the detection event.
    insert into public.dropbox_event_inbox(event_key,event_type,payload,source_cursor)
      values ('frame-approved:'||r.id||':'||(r.approval_version+1),'frameio_delivery',
        r.source_payload || jsonb_build_object('approvalRequestId',r.id,'approvalVersion',r.approval_version+1),'human-approval')
      on conflict(event_key) do nothing;
  end if;
  return true;
end $$;
revoke all on function public.decide_frame_upload(uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.decide_frame_upload(uuid,uuid,text,text,text,text,text) to service_role;


create or replace function public.resolve_frame_upload_collision(p_id uuid,p_workspace uuid,p_actor text,p_version integer,
  p_name text,p_decision text,p_conflict_id text default null,p_conflict_type text default null)
returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.frame_upload_approvals; accepted boolean; stem text; ext text; suffix text;
begin
  select * into r from public.frame_upload_approvals where id=p_id and workspace_id=p_workspace for update;
  if not found or r.state <> 'collision' or r.approval_version is distinct from p_version
    or r.approved_by is distinct from p_actor or r.upload_attempted_at is not null then return false; end if;
  if not exists(select 1 from public.frame_upload_review_slots s where s.id=r.review_slot_id
    and s.workspace_id=r.workspace_id and s.project_id=r.project_id and s.current_approval_id=r.id) then return false; end if;
  if p_decision in ('new','replace') and p_name is distinct from r.approved_name then
    raise exception 'The approved filename cannot be changed by a collision decision';
  end if;
  if p_decision='keep_both' then
    ext := coalesce(substring(r.approved_name from '\.[a-zA-Z0-9]{1,8}$'),'');
    stem := left(r.approved_name,length(r.approved_name)-length(ext));
    suffix := substring(p_name from length(stem)+1 for greatest(0,length(p_name)-length(stem)-length(ext)));
    if p_name is null or left(p_name,length(stem)) <> stem or right(p_name,length(ext)) <> ext
      or suffix !~ '^_[0-9]{2,3}$' then raise exception 'Keep both requires a numbered approved filename'; end if;
    if substring(suffix from 2)::integer < 2 then raise exception 'Keep both number must start at 02'; end if;
  end if;
  -- Reuse the existing atomic destination reservation + execution-event outbox.
  -- The temporary state is invisible outside this transaction/row lock.
  update public.frame_upload_approvals set state='awaiting' where id=p_id;
  accepted := public.decide_frame_upload(p_id,p_workspace,p_actor,
    case when p_decision='skip' then r.approved_name else p_name end,p_decision,p_conflict_id,p_conflict_type);
  update public.frame_upload_approvals set approved_at=r.approved_at,detail=null where id=p_id;
  return accepted;
end $$;
revoke all on function public.resolve_frame_upload_collision(uuid,uuid,text,integer,text,text,text,text) from public,anon,authenticated;
grant execute on function public.resolve_frame_upload_collision(uuid,uuid,text,integer,text,text,text,text) to service_role;
