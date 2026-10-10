-- A collision belongs to the original approver, not the shared review card.
alter table public.frame_upload_approvals drop constraint frame_upload_approvals_state_check;
alter table public.frame_upload_approvals add constraint frame_upload_approvals_state_check
  check (state in ('awaiting','approved','collision','uploading','complete','skipped','superseded','needs_review'));
alter table public.frame_upload_approvals
  add column collision_channel_id text,
  add column collision_message_ts text;

create function public.pause_frame_upload_collision(p_id uuid,p_version integer)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_approvals set state='collision',notice_dirty=true,updated_at=now(),
    detail='The Frame destination has a same-name file or changed after review. Waiting for the original approver.'
    where id=p_id and approval_version=p_version and state='approved'
      and approved_by is not null and upload_attempted_at is null;
  return found;
end $$;
revoke all on function public.pause_frame_upload_collision(uuid,integer) from public,anon,authenticated;
grant execute on function public.pause_frame_upload_collision(uuid,integer) to service_role;

create function public.resolve_frame_upload_collision(p_id uuid,p_workspace uuid,p_actor text,p_version integer,
  p_name text,p_decision text,p_conflict_id text default null,p_conflict_type text default null)
returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.frame_upload_approvals; accepted boolean; stem text; ext text; suffix text;
begin
  select * into r from public.frame_upload_approvals where id=p_id and workspace_id=p_workspace for update;
  if not found or r.state <> 'collision' or r.approval_version is distinct from p_version
    or r.approved_by is distinct from p_actor or r.upload_attempted_at is not null then return false; end if;
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

-- Recover only pre-upload collision reviews reopened by the previous worker.
update public.frame_upload_approvals set state='collision',notice_dirty=true,updated_at=now()
  where state='awaiting' and approved_by is not null and upload_attempted_at is null;
