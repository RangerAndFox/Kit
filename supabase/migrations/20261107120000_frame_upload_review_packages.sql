-- A folder owns notification only. Decisions and execution remain exact-file fenced.
create function public.frame_upload_package_root(p_path text) returns text
language sql immutable strict set search_path=public as $$
  select case when p_path like '/%' and position('/02_delivery/' in lower(p_path))>0
    and split_part(lower(p_path),'/02_delivery/',2)<>'' then
    split_part(lower(p_path),'/02_delivery/',1)||'/02_delivery'||
    case when position('/' in split_part(lower(p_path),'/02_delivery/',2))>0
      then '/'||split_part(split_part(lower(p_path),'/02_delivery/',2),'/',1) else '' end
  end$$;
create table public.frame_upload_review_packages (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid not null,
  root_path text not null check(root_path like '/%' and root_path=lower(root_path)),
  generation bigint not null default 1, notice_dirty boolean not null default false,
  notice_token uuid, notice_claimed_at timestamptz, slack_channel_id text, slack_message_ts text,
  blocked_reason text, last_error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(project_id,root_path), unique(workspace_id,project_id,id),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id) on delete cascade
);
alter table public.frame_upload_review_packages enable row level security;
revoke all on public.frame_upload_review_packages from public,anon,authenticated;
grant select,insert,update on public.frame_upload_review_packages to service_role;
create index frame_upload_review_packages_dirty on public.frame_upload_review_packages(updated_at,id) where notice_dirty;
alter table public.frame_upload_review_slots add column package_id uuid;
alter table public.frame_upload_review_slots add constraint frame_upload_review_slot_package_scope
  foreign key(workspace_id,project_id,package_id) references public.frame_upload_review_packages(workspace_id,project_id,id);
create index frame_upload_review_slots_package on public.frame_upload_review_slots(package_id,id);

-- Adopt, never replay historical activity or erase any file's receipt.
insert into public.frame_upload_review_packages(workspace_id,project_id,root_path)
select distinct workspace_id,project_id,public.frame_upload_package_root(path_key)
from public.frame_upload_review_slots where public.frame_upload_package_root(path_key) is not null;
update public.frame_upload_review_slots s set package_id=p.id from public.frame_upload_review_packages p
where s.workspace_id=p.workspace_id and s.project_id=p.project_id and public.frame_upload_package_root(s.path_key)=p.root_path;
update public.frame_upload_review_packages p set slack_channel_id=r.slack_channel_id,slack_message_ts=r.slack_message_ts
from (select distinct on(s.package_id) s.package_id,s.slack_channel_id,s.slack_message_ts
  from public.frame_upload_review_slots s left join public.frame_upload_approvals a on a.id=s.anchor_approval_id
  where s.package_id is not null and s.slack_channel_id is not null and s.slack_message_ts is not null
  order by s.package_id,a.created_at nulls last,s.id) r where p.id=r.package_id;
update public.frame_upload_review_packages p set blocked_reason='Private reviewer groups differ; manual reconciliation required'
where (select count(distinct slack_channel_id) from public.frame_upload_review_slots where package_id=p.id)>1;

-- A channel without a persisted timestamp may be an already-sent Slack POST.
-- Do not treat it as permission to create a second card.
update public.frame_upload_review_packages p set blocked_reason='Legacy Slack send outcome requires reconciliation'
where blocked_reason is null and exists(select 1 from public.frame_upload_review_slots s
  where s.package_id=p.id and s.slack_channel_id is not null and s.slack_message_ts is null);

create function public.guard_frame_upload_package_routing() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if new.package_id is not null and new.slack_channel_id is not null then
    update public.frame_upload_review_packages p set blocked_reason=coalesce(blocked_reason,
      case when new.slack_message_ts is null then 'Legacy Slack send outcome requires reconciliation'
        else 'Private reviewer groups differ; manual reconciliation required' end)
    where p.id=new.package_id and (new.slack_message_ts is null
      or (p.slack_channel_id is not null and p.slack_channel_id<>new.slack_channel_id)
      or exists(select 1 from public.frame_upload_review_slots s where s.package_id=p.id
        and s.slack_channel_id is not null and s.slack_channel_id<>new.slack_channel_id));
  end if;
  return new;
end $$;
create trigger frame_upload_package_routing_guard after insert or update of slack_channel_id,slack_message_ts,package_id
on public.frame_upload_review_slots for each row execute function public.guard_frame_upload_package_routing();
revoke all on function public.guard_frame_upload_package_routing() from public,anon,authenticated;
grant execute on function public.guard_frame_upload_package_routing() to service_role;

create function public.assign_frame_upload_package() returns trigger
language plpgsql security invoker set search_path=public as $$
declare root text; source_path text;
begin
  select a.source_path into source_path from public.frame_upload_approvals a where a.id=new.current_approval_id;
  root:=public.frame_upload_package_root(coalesce(source_path,new.path_key));
  if root is not null then
    insert into public.frame_upload_review_packages(workspace_id,project_id,root_path)
      values(new.workspace_id,new.project_id,root) on conflict(project_id,root_path) do nothing;
    select id into new.package_id from public.frame_upload_review_packages
      where workspace_id=new.workspace_id and project_id=new.project_id and root_path=root;
  else
    new.package_id:=null;
  end if;
  return new;
end $$;
create trigger frame_upload_slot_package_assignment before insert or update of path_key,current_approval_id on public.frame_upload_review_slots
for each row execute function public.assign_frame_upload_package();
create function public.dirty_frame_upload_package() returns trigger
language plpgsql security invoker set search_path=public as $$
declare package uuid;
begin
  if tg_table_name='frame_upload_review_slots' then
    if tg_op='UPDATE' and new.current_approval_id is not distinct from old.current_approval_id and new.generation=old.generation then return new; end if;
    if tg_op='UPDATE' and old.package_id is distinct from new.package_id then
      update public.frame_upload_review_packages set generation=generation+1,notice_dirty=true,updated_at=now() where id=old.package_id;
    end if;
    package:=new.package_id;
  else
    if (new.state,new.approval_version,new.approved_name,new.detail,new.frame_file_id) is not distinct from
       (old.state,old.approval_version,old.approved_name,old.detail,old.frame_file_id) then return new; end if;
    select package_id into package from public.frame_upload_review_slots where id=new.review_slot_id and current_approval_id=new.id;
  end if;
  update public.frame_upload_review_packages set generation=generation+1,notice_dirty=true,updated_at=now() where id=package;
  return new;
end $$;
create trigger frame_upload_slot_package_dirty after insert or update of current_approval_id,generation on public.frame_upload_review_slots
for each row execute function public.dirty_frame_upload_package();
create trigger frame_upload_outcome_package_dirty after update of state,approval_version,approved_name,detail,frame_file_id on public.frame_upload_approvals
for each row execute function public.dirty_frame_upload_package();

create function public.list_pending_frame_upload_packages(p_request uuid default null) returns setof public.frame_upload_review_packages
language sql security invoker set search_path=public as $$
  select p.* from public.frame_upload_review_packages p join public.projects project on project.id=p.project_id
  where p.notice_dirty and p.blocked_reason is null and coalesce(project.status,'') not in ('archived','cancelled')
    and (p_request is null or p.id=(select s.package_id from public.frame_upload_approvals a join public.frame_upload_review_slots s on s.id=a.review_slot_id where a.id=p_request))
  order by p.updated_at,p.id limit 10
$$;
create function public.claim_frame_upload_package_notice(p_id uuid,p_token uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  if p_token is null then return false; end if;
  update public.frame_upload_review_packages p set notice_token=p_token,notice_claimed_at=now()
  where id=p_id and notice_dirty and blocked_reason is null
    and (notice_token is null or notice_claimed_at<now()-interval '2 minutes')
    and exists(select 1 from public.projects where id=p.project_id and coalesce(status,'') not in ('archived','cancelled'));
  return found;
end $$;
create function public.save_frame_upload_package_receipt(p_id uuid,p_token uuid,p_channel text,p_ts text) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  -- Reserve the recipient before Slack; a null timestamp never erases a receipt.
  if nullif(p_channel,'') is null or p_ts='' then return false; end if;
  update public.frame_upload_review_packages set slack_channel_id=p_channel,slack_message_ts=coalesce(p_ts,slack_message_ts)
    where id=p_id and notice_token=p_token and blocked_reason is null and notice_claimed_at>now()-interval '2 minutes'
    and (slack_channel_id is null or slack_channel_id=p_channel) and (p_ts is null or slack_message_ts is null or slack_message_ts=p_ts);
  return found;
end $$;
create function public.finish_frame_upload_package_notice(p_id uuid,p_token uuid,p_generation bigint,p_success boolean) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_review_packages set notice_token=null,
    notice_dirty=not(p_success and blocked_reason is null and generation=p_generation and notice_claimed_at>now()-interval '2 minutes'),
    last_error=case when p_success then null else 'Package update deferred; retry pending' end,updated_at=now()
    where id=p_id and notice_token=p_token;
  return found;
end $$;
create function public.get_frame_upload_package_page(p_id uuid,p_after uuid default null,p_limit integer default 10) returns jsonb
language sql stable security invoker set search_path=public as $$
  with heads as (
    select s.id slot_id,a.*,
      case when a.state='complete' then (
        select t.frameio_share_url from public.frameio_delivery_transfers t
        join public.projects scoped on scoped.id=t.project_id and scoped.workspace_id=a.workspace_id
        where t.project_id=a.project_id and t.frameio_file_id=a.frame_file_id
          and t.dropbox_file_id=a.source_file_id and t.dropbox_rev=a.source_rev and t.state='ready' and t.retired_at is null
      ) end as frame_review_url
    from public.frame_upload_review_slots s join public.frame_upload_approvals a on a.id=s.current_approval_id
    where s.package_id=p_id
  ), page as (select * from heads where p_after is null or slot_id>p_after order by slot_id limit greatest(1,least(coalesce(p_limit,10),20)))
  select jsonb_build_object('package',to_jsonb(p),'approvals',coalesce((select jsonb_agg(to_jsonb(page) order by slot_id) from page),'[]'::jsonb),
    'total',(select count(*) from heads),'awaiting',(select count(*) from heads where state='awaiting'),
    'next_cursor',(select max(slot_id::text) from page having exists(select 1 from heads where slot_id>(select max(slot_id::text)::uuid from page))))
  from public.frame_upload_review_packages p where p.id=p_id and (p_after is null or exists(select 1 from public.frame_upload_review_slots where package_id=p_id and id=p_after))
$$;

revoke all on function public.frame_upload_package_root(text), public.assign_frame_upload_package(), public.dirty_frame_upload_package(),
  public.list_pending_frame_upload_packages(uuid),public.claim_frame_upload_package_notice(uuid,uuid),
  public.save_frame_upload_package_receipt(uuid,uuid,text,text),public.finish_frame_upload_package_notice(uuid,uuid,bigint,boolean),
  public.get_frame_upload_package_page(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.frame_upload_package_root(text), public.assign_frame_upload_package(), public.dirty_frame_upload_package(),
  public.list_pending_frame_upload_packages(uuid),public.claim_frame_upload_package_notice(uuid,uuid),
  public.save_frame_upload_package_receipt(uuid,uuid,text,text),public.finish_frame_upload_package_notice(uuid,uuid,bigint,boolean),
  public.get_frame_upload_package_page(uuid,uuid,integer) to service_role;





-- Package-owned upload completions still synchronize project share history and
-- Sheets. Their Slack notification belongs to the folder, not each file.
alter table public.project_share_events add column notification_disposition text not null default 'separate'
  check(notification_disposition in ('separate','package'));


-- Retire old per-file controls only after a compatible folder anchor exists.
-- Preserve every original Slack receipt, decision and execution record.
alter table public.frame_upload_review_slots add column package_notice_closed boolean not null default false;
create function public.close_frame_upload_package_legacy_notice(
  p_slot uuid,p_token uuid,p_package uuid,p_channel text,p_ts text) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_review_slots s set package_notice_closed=true
  where s.id=p_slot and s.package_id=p_package and s.notice_token=p_token
    and s.notice_claimed_at>now()-interval '2 minutes'
    and s.slack_channel_id=p_channel and s.slack_message_ts=p_ts
    and exists(select 1 from public.frame_upload_review_packages p
      where p.id=s.package_id and p.workspace_id=s.workspace_id and p.project_id=s.project_id
        and p.blocked_reason is null and p.slack_channel_id=p_channel
        and p.slack_message_ts is not null and p.slack_message_ts<>p_ts);
  return found;
end $$;
revoke all on function public.close_frame_upload_package_legacy_notice(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.close_frame_upload_package_legacy_notice(uuid,uuid,uuid,text,text) to service_role;

-- Existing active packages with an adopted anchor get a quiet update, never a
-- new POST. Completed-only history and packages with no anchor remain inert.
update public.frame_upload_review_packages p set notice_dirty=true
where p.blocked_reason is null and p.slack_channel_id is not null and p.slack_message_ts is not null
  and exists(select 1 from public.frame_upload_review_slots s join public.frame_upload_approvals a on a.id=s.current_approval_id
    where s.package_id=p.id and a.state='awaiting');
update public.frame_upload_review_slots s set notice_dirty=true
from public.frame_upload_review_packages p
where p.id=s.package_id and p.notice_dirty and p.blocked_reason is null
  and s.slack_channel_id=p.slack_channel_id and s.slack_message_ts is not null
  and s.slack_message_ts<>p.slack_message_ts;

-- Package-owned slots still fence collision/legacy edits, but must not invent
-- a per-file channel reservation that could be mistaken for an unknown POST.
create function public.renew_frame_upload_review_lease(p_id uuid,p_token uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_review_slots set notice_claimed_at=now()
    where id=p_id and notice_token=p_token and notice_claimed_at>now()-interval '2 minutes';
  return found;
end $$;
revoke all on function public.renew_frame_upload_review_lease(uuid,uuid) from public,anon,authenticated;
grant execute on function public.renew_frame_upload_review_lease(uuid,uuid) to service_role;
