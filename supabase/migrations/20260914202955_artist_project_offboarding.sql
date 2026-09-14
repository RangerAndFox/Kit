-- Service-only access ledger. Project removal never removes time, files, people or paperwork.
create table public.artist_project_engagements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  artist_email text not null check (artist_email = lower(btrim(artist_email)) and position('@' in artist_email)>1),
  artist_name text not null,
  artist_slack_id text,
  state text not null default 'active' check (state in ('active','onboarding','offboarding','offboarded')),
  revision integer not null default 0,
  owner uuid,
  grants jsonb not null default '{}',
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(workspace_id,project_id,artist_email)
);
create index artist_engagement_project on public.artist_project_engagements(project_id);
create table public.artist_offboarding_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  engagement_id uuid not null references public.artist_project_engagements(id) on delete cascade,
  actor text not null,
  snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending','running','partial','complete','cancelled')),
  owner uuid, lease_until timestamptz,
  results jsonb not null default '{}',
  expires_at timestamptz not null default now()+interval '30 minutes',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index artist_offboarding_engagement on public.artist_offboarding_requests(engagement_id);
create table public.artist_access_audit (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  engagement_id uuid not null,
  request_id uuid,
  actor text not null,
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.artist_project_engagements enable row level security;
alter table public.artist_offboarding_requests enable row level security;
alter table public.artist_access_audit enable row level security;
revoke all on public.artist_project_engagements, public.artist_offboarding_requests, public.artist_access_audit from public, anon, authenticated, service_role;
grant select,insert,update,delete on public.artist_project_engagements, public.artist_offboarding_requests to service_role;
grant select,insert on public.artist_access_audit to service_role;
grant usage,select on sequence public.artist_access_audit_id_seq to service_role;

create function public.artist_access_authorized(p_workspace uuid,p_actor text) returns boolean
language sql stable security invoker set search_path=public as $$
 select exists(select 1 from public.team_members where workspace_id=p_workspace and slack_user_id=p_actor and is_active is true and role in ('founder','admin','owner','producer'));
$$;

-- One project/person lock covers onboarding AND offboarding. An interrupted
-- onboarding is held for manual reconciliation; it must never be reclaimed
-- automatically while an old provider request could still grant access.
create function public.artist_access_begin(p_workspace uuid,p_project uuid,p_email text,p_name text,p_actor text,p_owner uuid,p_legacy boolean default false)
returns public.artist_project_engagements language plpgsql security invoker set search_path=public as $$
declare e public.artist_project_engagements;
begin
 if not artist_access_authorized(p_workspace,p_actor) or not exists(select 1 from projects where id=p_project and workspace_id=p_workspace) then raise exception 'artist_access_denied'; end if;
 if p_owner is null then raise exception 'artist_owner_required'; end if;
 if p_legacy and not exists(select 1 from freelancer_onboardings where project_id=p_project and lower(btrim(artist_email))=lower(btrim(p_email))) then raise exception 'artist_history_missing'; end if;
 insert into artist_project_engagements(workspace_id,project_id,artist_email,artist_name)
 values(p_workspace,p_project,lower(btrim(p_email)),p_name) on conflict do nothing;
 select * into e from artist_project_engagements where workspace_id=p_workspace and project_id=p_project and artist_email=lower(btrim(p_email)) for update;
 if p_legacy then return e; end if;
 if e.state <> 'active' then raise exception 'artist_access_held_for_review'; end if;
 update artist_project_engagements set state='onboarding',owner=p_owner,revision=revision+1,artist_name=p_name,updated_at=now() where id=e.id returning * into e;
 insert into artist_access_audit(workspace_id,engagement_id,actor,action) values(p_workspace,e.id,p_actor,'onboarding_started');
 return e;
end $$;

create function public.artist_access_record(p_workspace uuid,p_id uuid,p_owner uuid,p_actor text,p_service text,p_grant jsonb)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
 if not artist_access_authorized(p_workspace,p_actor) or p_service not in ('slack','dropbox','frameio','harvest') then raise exception 'artist_access_denied'; end if;
 update artist_project_engagements set grants=jsonb_set(grants,array[p_service],coalesce(grants->p_service,'{}'::jsonb)||jsonb_strip_nulls(p_grant)),
 artist_slack_id=case when p_service='slack' then coalesce(p_grant->>'subject',artist_slack_id) else artist_slack_id end,updated_at=now()
 where id=p_id and workspace_id=p_workspace and state='onboarding' and owner=p_owner;
 if not found then raise exception 'artist_access_ownership_lost'; end if;
 insert into artist_access_audit(workspace_id,engagement_id,actor,action,detail) values(p_workspace,p_id,p_actor,'grant_result',jsonb_build_object('service',p_service,'status',p_grant->>'status'));
 return true;
end $$;

create function public.artist_access_finish_onboarding(p_workspace uuid,p_id uuid,p_owner uuid,p_actor text)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
 if not artist_access_authorized(p_workspace,p_actor) then raise exception 'artist_access_denied'; end if;
 update artist_project_engagements set state='active',owner=null,updated_at=now() where id=p_id and workspace_id=p_workspace and state='onboarding' and owner=p_owner;
 if not found then raise exception 'artist_access_ownership_lost'; end if;
 insert into artist_access_audit(workspace_id,engagement_id,actor,action) values(p_workspace,p_id,p_actor,'onboarding_finished');
 return true;
end $$;

create function public.artist_offboard_prepare(p_workspace uuid,p_id uuid,p_actor text,p_snapshot jsonb)
returns public.artist_offboarding_requests language plpgsql security invoker set search_path=public as $$
declare e public.artist_project_engagements; r public.artist_offboarding_requests;
begin
 if not artist_access_authorized(p_workspace,p_actor) then raise exception 'artist_access_denied'; end if;
 select * into e from artist_project_engagements where id=p_id and workspace_id=p_workspace for update;
 if not found or e.state<>'active' or (p_snapshot#>>'{engagement,revision}')::integer is distinct from e.revision
 or p_snapshot#>>'{engagement,id}' is distinct from e.id::text
 or p_snapshot#>>'{engagement,workspace_id}' is distinct from e.workspace_id::text
 or p_snapshot#>>'{engagement,project_id}' is distinct from e.project_id::text
 or p_snapshot#>>'{engagement,artist_email}' is distinct from e.artist_email then raise exception 'artist_access_changed'; end if;
 insert into artist_offboarding_requests(workspace_id,engagement_id,actor,snapshot) values(p_workspace,p_id,p_actor,p_snapshot) returning * into r;
 insert into artist_access_audit(workspace_id,engagement_id,request_id,actor,action) values(p_workspace,p_id,r.id,p_actor,'offboarding_prepared');
 return r;
end $$;

create function public.artist_offboard_claim(p_workspace uuid,p_id uuid,p_actor text,p_owner uuid,p_cancel boolean default false)
returns public.artist_offboarding_requests language plpgsql security invoker set search_path=public as $$
declare e public.artist_project_engagements; r public.artist_offboarding_requests;
begin
 if not artist_access_authorized(p_workspace,p_actor) or p_owner is null then raise exception 'artist_access_denied'; end if;
 select * into r from artist_offboarding_requests where id=p_id and workspace_id=p_workspace and actor=p_actor for update;
 if not found then raise exception 'artist_request_missing'; end if;
 if p_cancel then
   if r.status<>'pending' then raise exception 'artist_request_already_started'; end if;
   update artist_offboarding_requests set status='cancelled',updated_at=now() where id=r.id returning * into r;
 else
   if r.status in ('cancelled','complete') or (r.status='pending' and r.expires_at<=now()) or (r.status='running' and r.lease_until>now()) then raise exception 'artist_request_unavailable'; end if;
   select * into e from artist_project_engagements where id=r.engagement_id for update;
   if r.status='pending' then
     if e.state<>'active' or e.revision<>(r.snapshot#>>'{engagement,revision}')::integer then raise exception 'artist_access_changed'; end if;
     update artist_project_engagements set state='offboarding',revision=revision+1,ended_at=now(),updated_at=now() where id=e.id;
   elsif e.state<>'offboarding' then raise exception 'artist_access_changed'; end if;
   update artist_offboarding_requests set status='running',owner=p_owner,lease_until=now()+interval '10 minutes',updated_at=now() where id=r.id returning * into r;
 end if;
 insert into artist_access_audit(workspace_id,engagement_id,request_id,actor,action) values(p_workspace,r.engagement_id,r.id,p_actor,case when p_cancel then 'offboarding_cancelled' else 'offboarding_started' end);
 return r;
end $$;

create function public.artist_offboard_checkpoint(p_workspace uuid,p_id uuid,p_actor text,p_owner uuid,p_step text default null,p_result jsonb default null,p_finish boolean default false)
returns boolean language plpgsql security invoker set search_path=public as $$
declare r public.artist_offboarding_requests; done boolean;
begin
 if not artist_access_authorized(p_workspace,p_actor) then raise exception 'artist_access_denied'; end if;
 select * into r from artist_offboarding_requests where id=p_id and workspace_id=p_workspace and actor=p_actor and owner=p_owner and status='running' and lease_until>now() for update;
 if not found then raise exception 'artist_access_ownership_lost'; end if;
 if p_step is not null then
   if p_step not in ('slack','dropbox','frameio','kit_access','assignments','harvest') or coalesce(p_result->>'status','') not in ('removed','retained','review','failed') then raise exception 'artist_result_invalid'; end if;
   r.results:=jsonb_set(r.results,array[p_step],p_result);
   insert into artist_access_audit(workspace_id,engagement_id,request_id,actor,action,detail) values(p_workspace,r.engagement_id,r.id,p_actor,'offboarding_step',jsonb_build_object('step',p_step,'result',p_result));
 end if;
 if p_finish then
   select bool_and(coalesce(r.results->s->>'status','') in ('removed','retained')) into done from unnest(array['slack','dropbox','frameio','kit_access','assignments','harvest']) s;
   if done then update artist_project_engagements set state='offboarded',updated_at=now() where id=r.engagement_id; end if;
 end if;
 update artist_offboarding_requests set results=r.results,status=case when p_finish then case when done then 'complete' else 'partial' end else 'running' end,
 lease_until=case when p_finish then null else now()+interval '10 minutes' end,owner=case when p_finish then null else p_owner end,updated_at=now() where id=r.id;
 return true;
end $$;

revoke all on function public.artist_access_authorized(uuid,text),public.artist_access_begin(uuid,uuid,text,text,text,uuid,boolean),public.artist_access_record(uuid,uuid,uuid,text,text,jsonb),public.artist_access_finish_onboarding(uuid,uuid,uuid,text),public.artist_offboard_prepare(uuid,uuid,text,jsonb),public.artist_offboard_claim(uuid,uuid,text,uuid,boolean),public.artist_offboard_checkpoint(uuid,uuid,text,uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.artist_access_authorized(uuid,text),public.artist_access_begin(uuid,uuid,text,text,text,uuid,boolean),public.artist_access_record(uuid,uuid,uuid,text,text,jsonb),public.artist_access_finish_onboarding(uuid,uuid,uuid,text),public.artist_offboard_prepare(uuid,uuid,text,jsonb),public.artist_offboard_claim(uuid,uuid,text,uuid,boolean),public.artist_offboard_checkpoint(uuid,uuid,text,uuid,text,jsonb,boolean) to service_role;
