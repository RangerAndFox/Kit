-- Run ONLY in a disposable Supabase branch. All synthetic writes roll back.
begin;
do $$ begin
  if exists(select 1 from public.workspaces) then
    raise exception 'REFUSING: hosted culture test requires an empty disposable branch';
  end if;
end $$;
insert into public.workspaces(id,name,slug,slack_team_id)
values('11111111-1111-4111-8111-111111111111','Culture test','culture-test','T12345678');
set local role service_role;
do $test$
declare
  ws uuid := '11111111-1111-4111-8111-111111111111';
  meme uuid := '33333333-3333-4333-8333-333333333333';
  owner uuid := '44444444-4444-4444-8444-444444444444';
  other_owner uuid := '55555555-5555-4555-8555-555555555555';
  item jsonb := '{"id":"33333333-3333-4333-8333-333333333333","revision":0,"kind":"custom","name":"Studio wins","briefing":"Synthetic fixture","channel_id":"C12345678","template_id":"rotation","status":"draft","schedule":"once","month_day":null,"weekday":null,"fire_date":"2026-09-14","local_time":"09:00","timezone":"UTC","person_id":null,"person_name":null}';
  saved public.culture_memes;
  job public.culture_posts;
  empty_job public.culture_posts;
  blocked boolean;
begin
  assert public.initialize_culture(ws,'test-admin','C12345678','UTC',now()+interval '1 hour','[]'), 'initialize';
  assert not public.initialize_culture(ws,'test-admin','C12345678','UTC',now()+interval '1 hour','[]'), 'idempotent setup';
  saved := public.save_culture_meme(ws,'test-admin',item,false);
  assert saved.revision=1 and saved.status='draft', 'draft save';
  item := item || '{"revision":1,"status":"enabled"}';
  blocked := false;
  begin perform public.save_culture_meme(ws,'test-admin',item,false);
  exception when others then blocked := sqlerrm='culture_review_required'; end;
  assert blocked, 'review gate';
  saved := public.save_culture_meme(ws,'test-admin',item,true);
  assert saved.revision=2, 'revision increment';
  empty_job := public.claim_culture_post(ws,meme,2,'day',owner);
  assert empty_job.id is null, 'handover gate';
  update public.culture_workspaces set starts_at=now()-interval '1 minute' where workspace_id=ws;
  job := public.claim_culture_post(ws,meme,2,'day',owner);
  assert job.id is not null, 'claim';
  empty_job := public.claim_culture_post(ws,meme,2,'day',other_owner);
  assert empty_job.id is null, 'duplicate claim denied';
  assert not public.begin_culture_send(job.id,other_owner), 'owner fencing';
  assert public.begin_culture_send(job.id,owner), 'begin send';
  blocked := false;
  begin perform public.save_culture_meme(ws,'test-admin',item||'{"revision":2,"status":"paused"}',false);
  exception when others then blocked := sqlerrm='culture_send_in_progress'; end;
  assert blocked, 'in-flight edit gate';
  update public.culture_posts set lease_until=now()-interval '1 minute' where id=job.id;
  empty_job := public.claim_culture_post(ws,meme,2,'day',other_owner);
  assert empty_job.id is null, 'ambiguous sends cannot replay';
  assert (select status='review' from public.culture_posts where id=job.id), 'review state';
  job := public.claim_culture_post(ws,meme,2,'next-day',owner);
  saved := public.save_culture_meme(ws,'test-admin',item||'{"revision":2,"status":"paused"}',false);
  assert saved.status='paused' and saved.revision=3, 'pause';
  insert into public.workspaces(id,name,slug,slack_team_id)
  values('22222222-2222-4222-8222-222222222222','Other fixture','other-fixture','T87654321');
  insert into public.culture_workspaces(workspace_id,default_channel_id,timezone,starts_at)
  values('22222222-2222-4222-8222-222222222222','C87654321','UTC',now());
  blocked := false;
  begin
    perform public.save_culture_meme('22222222-2222-4222-8222-222222222222','other-admin',item||'{"revision":3,"status":"paused"}',false);
  exception when others then blocked := sqlerrm='culture_not_found'; end;
  assert blocked, 'cross-workspace edit denied';
  assert not public.begin_culture_send(job.id,owner), 'pause fences preparation';
  assert (select status='cancelled' from public.culture_posts where id=job.id), 'cancelled preparation';
  assert (select count(*)=3 from public.culture_audit where workspace_id=ws), 'durable audit';
  blocked := false;
  begin perform public.save_culture_meme(ws,'test-admin',item,true);
  exception when others then blocked := sqlerrm='culture_edit_conflict'; end;
  assert blocked, 'stale edit rejected';
end $test$;
reset role;
do $security$
declare role_name text; table_name text; signature text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    foreach table_name in array array['culture_workspaces','culture_memes','culture_posts','culture_audit'] loop
      assert not has_table_privilege(role_name,'public.'||table_name,'select,insert,update,delete'), 'no public table grants';
      assert (select relrowsecurity from pg_class where oid=('public.'||table_name)::regclass), 'RLS enabled';
    end loop;
    foreach signature in array array['save_culture_meme(uuid,text,jsonb,boolean,text)','initialize_culture(uuid,text,text,text,timestamp with time zone,jsonb)','claim_culture_post(uuid,uuid,integer,text,uuid)','begin_culture_send(uuid,uuid)'] loop
      assert not has_function_privilege(role_name,'public.'||signature,'execute'), 'no public RPC grants';
    end loop;
  end loop;
end $security$;
rollback;
select 'PASS: hosted service-role migration, draft/confirmation gates, cutover, audit, deduplication, lease fencing, pause, RLS and public RPC denial; synthetic writes rolled back' as result;
