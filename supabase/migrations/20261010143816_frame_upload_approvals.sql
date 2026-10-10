-- Railway remains the only outgoing-folder observer and upload executor.
-- Human review is a durable, service-only boundary, not a Slack-message flag.
create table public.frame_upload_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_file_id text not null,
  source_rev text not null,
  source_size bigint not null check (source_size > 0),
  source_path text not null,
  source_payload jsonb not null,
  suggested_name text not null,
  state text not null default 'awaiting' check (state in ('awaiting','approved','uploading','complete','skipped','superseded','needs_review')),
  approval_version integer not null default 0,
  approved_name text,
  decision text check (decision in ('new','replace','keep_both','skip')),
  approved_by text,
  approved_at timestamptz,
  conflict_id text,
  conflict_type text check (conflict_type in ('file','version_stack')),
  destination_key text,
  upload_attempted_at timestamptz,
  frame_file_id text,
  version_stack_id text,
  renamed_path text,
  slack_channel_id text,
  slack_message_ts text,
  notice_claimed_at timestamptz,
  notice_token uuid,
  notice_dirty boolean not null default true,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, source_file_id, source_rev),
  foreign key (workspace_id, project_id) references public.projects(workspace_id,id) on delete cascade
);
alter table public.frame_upload_approvals enable row level security;
revoke all on public.frame_upload_approvals from public, anon, authenticated;
grant all on public.frame_upload_approvals to service_role;
create index frame_upload_approvals_notice on public.frame_upload_approvals(updated_at) where notice_dirty;
create index frame_upload_approvals_workspace_project on public.frame_upload_approvals(workspace_id,project_id);
-- Two different Dropbox files cannot race an upload into the same named slot.
create unique index frame_upload_approvals_destination_lock on public.frame_upload_approvals(project_id,destination_key)
  where state in ('approved','uploading');

create function public.decide_frame_upload(p_id uuid,p_workspace uuid,p_actor text,p_name text,p_decision text,
  p_conflict_id text default null,p_conflict_type text default null)
returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.frame_upload_approvals; target text;
begin
  select * into r from public.frame_upload_approvals where id=p_id and workspace_id=p_workspace for update;
  if not found or r.state <> 'awaiting' then return false; end if;
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

create function public.claim_frame_upload_notice(p_id uuid,p_token uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
  update public.frame_upload_approvals set notice_token=p_token,notice_claimed_at=now()
    where id=p_id and notice_dirty and (notice_token is null or notice_claimed_at<now()-interval '2 minutes');
  return found;
end $$;
revoke all on function public.claim_frame_upload_notice(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_frame_upload_notice(uuid,uuid) to service_role;
