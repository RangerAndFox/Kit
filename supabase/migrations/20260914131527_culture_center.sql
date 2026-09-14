-- Culture configuration is service-only. Web handlers authorize a verified
-- founder/admin and derive workspace scope before invoking these functions.
create table public.culture_workspaces (
  workspace_id uuid primary key references public.workspaces(id),
  starts_at timestamptz not null,
  default_channel_id text not null check (default_channel_id ~ '^[CG][A-Z0-9]{8,}$'),
  timezone text not null,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.culture_memes (
  id uuid primary key,
  workspace_id uuid not null references public.culture_workspaces(workspace_id),
  legacy_key text,
  kind text not null check (kind in ('birthday','timesheet','holiday','delivery','custom')),
  name text not null check (length(name) between 1 and 100),
  briefing text not null default '' check (length(briefing) <= 600),
  channel_id text not null check (channel_id ~ '^[CG][A-Z0-9]{8,}$'),
  template_id text not null default 'rotation',
  status text not null default 'draft' check (status in ('draft','enabled','paused')),
  schedule text not null check (schedule in ('annual','weekly','once','holiday','delivery')),
  month_day text check (month_day ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  weekday integer check (weekday between 0 and 6),
  fire_date date,
  local_time text not null default '09:00' check (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text not null,
  person_id text check (person_id ~ '^[UW][A-Z0-9]{8,}$'),
  person_name text,
  revision integer not null default 1,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, legacy_key),
  unique (workspace_id, id),
  check (schedule <> 'annual' or month_day is not null),
  check (schedule <> 'weekly' or weekday is not null),
  check (schedule <> 'once' or fire_date is not null),
  check (kind <> 'birthday' or (schedule='annual' and person_id is not null and person_name is not null))
);
create unique index culture_one_birthday_per_person on public.culture_memes(workspace_id,person_id) where kind='birthday';
create index culture_memes_workspace_status on public.culture_memes(workspace_id,status);
create table public.culture_posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  meme_id uuid not null,
  occurrence_key text not null check (length(occurrence_key) <= 150),
  revision integer not null,
  name text not null,
  channel_id text not null,
  status text not null default 'claimed' check (status in ('claimed','sending','posted','failed','review','cancelled')),
  owner uuid not null,
  lease_until timestamptz not null,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  slack_ts text,
  error text,
  foreign key (workspace_id,meme_id) references public.culture_memes(workspace_id,id),
  unique (meme_id,occurrence_key)
);
create index culture_posts_history on public.culture_posts(workspace_id,created_at desc);
create index culture_posts_inflight on public.culture_posts(meme_id,status) where status in ('claimed','sending');
create table public.culture_audit (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id),
  meme_id uuid not null,
  actor text not null,
  revision integer not null,
  action text not null,
  created_at timestamptz not null default now()
);
create index culture_audit_workspace on public.culture_audit(workspace_id,created_at desc);

alter table public.culture_workspaces enable row level security;
alter table public.culture_memes enable row level security;
alter table public.culture_posts enable row level security;
alter table public.culture_audit enable row level security;
revoke all on public.culture_workspaces,public.culture_memes,public.culture_posts,public.culture_audit from public,anon,authenticated;
grant all on public.culture_workspaces,public.culture_memes,public.culture_posts,public.culture_audit to service_role;
grant usage,select on sequence public.culture_audit_id_seq to service_role;

create function public.save_culture_meme(p_workspace uuid,p_actor text,p_item jsonb,p_confirm boolean default false,p_legacy_key text default null)
returns public.culture_memes language plpgsql security invoker set search_path=public,pg_temp as $$
declare old public.culture_memes; item public.culture_memes; result public.culture_memes;
begin
  -- Lock workspace first to serialize inserts and enforce a bounded collection.
  perform 1 from public.culture_workspaces where workspace_id=p_workspace for update;
  if not found then raise exception 'culture_not_initialized'; end if;
  item := jsonb_populate_record(null::public.culture_memes,p_item);
  select * into old from public.culture_memes where id=item.id and workspace_id=p_workspace for update;
  if found then
    if old.revision <> item.revision then raise exception 'culture_edit_conflict'; end if;
    if old.kind <> item.kind then raise exception 'culture_kind_immutable'; end if;
    if exists(select 1 from public.culture_posts where meme_id=old.id and status='sending') then raise exception 'culture_send_in_progress'; end if;
  else
    if item.revision <> 0 then raise exception 'culture_not_found'; end if;
    if (select count(*) from public.culture_memes where workspace_id=p_workspace)>=500 then raise exception 'culture_limit'; end if;
    if item.status <> 'draft' and p_legacy_key is null then raise exception 'culture_draft_required'; end if;
  end if;
  if item.status='enabled' and not p_confirm then raise exception 'culture_review_required'; end if;
  insert into public.culture_memes(id,workspace_id,legacy_key,kind,name,briefing,channel_id,template_id,status,schedule,month_day,weekday,fire_date,local_time,timezone,person_id,person_name,created_by,updated_by)
  values(item.id,p_workspace,p_legacy_key,item.kind,item.name,item.briefing,item.channel_id,item.template_id,item.status,item.schedule,item.month_day,item.weekday,item.fire_date,item.local_time,item.timezone,item.person_id,item.person_name,p_actor,p_actor)
  on conflict(id) do update set name=excluded.name,briefing=excluded.briefing,channel_id=excluded.channel_id,template_id=excluded.template_id,status=excluded.status,
    schedule=excluded.schedule,month_day=excluded.month_day,weekday=excluded.weekday,fire_date=excluded.fire_date,local_time=excluded.local_time,timezone=excluded.timezone,
    person_id=excluded.person_id,person_name=excluded.person_name,revision=culture_memes.revision+1,updated_at=now(),updated_by=p_actor
    where culture_memes.workspace_id=p_workspace
  returning * into result;
  if result.id is null then raise exception 'culture_not_found'; end if;
  update public.culture_posts set status='cancelled',error='Configuration changed before sending' where meme_id=result.id and status in ('claimed','failed');
  insert into public.culture_audit(workspace_id,meme_id,actor,revision,action) values(p_workspace,result.id,p_actor,result.revision,case when old.id is null then 'created' else 'updated' end);
  return result;
end $$;

create function public.initialize_culture(p_workspace uuid,p_actor text,p_channel text,p_timezone text,p_starts_at timestamptz,p_items jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare item jsonb;
begin
  -- Legacy tables are global: import only after the caller verifies the Slack
  -- team binding AND there is exactly one studio. Never choose a first workspace.
  if (select count(*) from public.workspaces)<>1 or not exists(select 1 from public.workspaces where id=p_workspace and slack_team_id is not null) then raise exception 'culture_legacy_scope_ambiguous'; end if;
  if p_starts_at <= now() or p_starts_at > now()+interval '27 hours' then raise exception 'culture_invalid_cutover'; end if;
  insert into public.culture_workspaces(workspace_id,starts_at,default_channel_id,timezone) values(p_workspace,p_starts_at,p_channel,p_timezone) on conflict do nothing;
  if not found then return false; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    perform public.save_culture_meme(p_workspace,p_actor,item,true,item->>'legacy_key');
  end loop;
  return true;
end $$;

create function public.claim_culture_post(p_workspace uuid,p_meme uuid,p_revision integer,p_key text,p_owner uuid)
returns public.culture_posts language plpgsql security invoker set search_path=public,pg_temp as $$
declare item public.culture_memes; result public.culture_posts;
begin
  select * into item from public.culture_memes where id=p_meme and workspace_id=p_workspace for update;
  if not found or item.status<>'enabled' or item.revision<>p_revision then return null; end if;
  if not exists(select 1 from public.culture_workspaces where workspace_id=p_workspace and starts_at<=now()) then return null; end if;
  -- Unknown sends never become retryable. Expired preparation can be reclaimed.
  update public.culture_posts set status='review',error='Slack acknowledgement not confirmed; do not repost automatically' where meme_id=p_meme and status='sending' and lease_until<now();
  insert into public.culture_posts(workspace_id,meme_id,occurrence_key,revision,name,channel_id,owner,lease_until)
    values(p_workspace,p_meme,p_key,p_revision,item.name,item.channel_id,p_owner,now()+interval '3 minutes')
    on conflict(meme_id,occurrence_key) do update set owner=p_owner,lease_until=now()+interval '3 minutes',status='claimed',revision=p_revision,name=item.name,channel_id=item.channel_id,error=null
    where culture_posts.status in ('claimed','failed') and culture_posts.lease_until<now() and culture_posts.revision=p_revision
    returning * into result;
  return result;
end $$;

create function public.begin_culture_send(p_post uuid,p_owner uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare job public.culture_posts; item public.culture_memes;
begin
  select * into job from public.culture_posts where id=p_post;
  if not found then return false; end if;
  select * into item from public.culture_memes where id=job.meme_id for update;
  if item.status<>'enabled' or item.revision<>job.revision then return false; end if;
  update public.culture_posts set status='sending',lease_until=now()+interval '3 minutes'
    where id=p_post and owner=p_owner and status='claimed' and lease_until>now();
  return found;
end $$;

revoke all on function public.save_culture_meme(uuid,text,jsonb,boolean,text),public.initialize_culture(uuid,text,text,text,timestamptz,jsonb),public.claim_culture_post(uuid,uuid,integer,text,uuid),public.begin_culture_send(uuid,uuid) from public,anon,authenticated;
grant execute on function public.save_culture_meme(uuid,text,jsonb,boolean,text),public.initialize_culture(uuid,text,text,text,timestamptz,jsonb),public.claim_culture_post(uuid,uuid,integer,text,uuid),public.begin_culture_send(uuid,uuid) to service_role;
