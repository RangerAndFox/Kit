-- Private provider snapshots. No browser/client role can read source comments.
create table public.project_feedback_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_key text not null,
  source jsonb not null,
  active boolean not null default true,
  snapshot jsonb,
  heading_hash text,
  body_hash text,
  error_code text,
  checked_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  unique(project_id,source_key),
  check (source_key ~ '^[a-f0-9]{64}$'),
  check (jsonb_typeof(source)='object' and source ?& array['key','provider','fileId','url','label']),
  check ((source->>'key'=source_key) is true),
  check ((source->>'provider' in ('figma','drive','dropbox')) is true)
);
alter table public.project_feedback_sources enable row level security;
revoke all on public.project_feedback_sources from public,anon,authenticated;
grant select,insert,update,delete on public.project_feedback_sources to service_role;
create index project_feedback_due on public.project_feedback_sources(next_attempt_at);
create unique index project_feedback_marker on public.project_feedback_sources(project_id,left(source_key,12));

create function public.register_project_feedback(p_project uuid,p_sources jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare item jsonb;
begin
  if p_sources is null or jsonb_typeof(p_sources)<>'array' or jsonb_array_length(p_sources)>30 then raise exception 'invalid feedback sources'; end if;
  -- One transaction for all additions/removals. Changing a source invalidates
  -- its old worker's token, preventing stale worker checkpoint commits.
  update public.project_feedback_sources set active=false,next_attempt_at=now(),lease_token=null,lease_expires_at=null
    where project_id=p_project and active and not exists(select 1 from jsonb_array_elements(p_sources) s where s->>'key'=source_key);
  for item in select * from jsonb_array_elements(p_sources) loop
    insert into public.project_feedback_sources(project_id,source_key,source) values(p_project,item->>'key',item)
    on conflict(project_id,source_key) do update set source=excluded.source,active=true,next_attempt_at=now(),lease_token=null,lease_expires_at=null
      where project_feedback_sources.source is distinct from excluded.source or not project_feedback_sources.active;
  end loop;
end $$;

create function public.claim_project_feedback(p_id uuid,p_token uuid)
returns boolean language sql security invoker set search_path='' as $$
  with claimed as (update public.project_feedback_sources set lease_token=p_token,lease_expires_at=now()+interval '15 minutes'
    where id=p_id and next_attempt_at<=now() and (lease_expires_at is null or lease_expires_at<now()) returning 1)
  select exists(select 1 from claimed);
$$;
create function public.finish_project_feedback(p_id uuid,p_token uuid,p_snapshot jsonb,p_heading text,p_body text,p_error text,p_delay integer)
returns boolean language sql security invoker set search_path='' as $$
  with done as (update public.project_feedback_sources set snapshot=coalesce(p_snapshot,snapshot),heading_hash=p_heading,body_hash=p_body,
    error_code=p_error,checked_at=now(),next_attempt_at=now()+make_interval(secs=>greatest(300,least(2678400,p_delay))),lease_token=null,lease_expires_at=null
    where id=p_id and lease_token=p_token and lease_expires_at>now() returning 1)
  select exists(select 1 from done);
$$;
revoke all on function public.register_project_feedback(uuid,jsonb),public.claim_project_feedback(uuid,uuid),public.finish_project_feedback(uuid,uuid,jsonb,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.register_project_feedback(uuid,jsonb),public.claim_project_feedback(uuid,uuid),public.finish_project_feedback(uuid,uuid,jsonb,text,text,text,integer) to service_role;
