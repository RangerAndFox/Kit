import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('upload decisions are atomic, workspace scoped, replay safe and private', async () => {
  const db = new PGlite()
  const workspace = '11111111-1111-4111-8111-111111111111', project = '22222222-2222-4222-8222-222222222222'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to service_role;
      create table workspaces(id uuid primary key);
      create table projects(id uuid primary key, workspace_id uuid,unique(workspace_id,id));
      create table dropbox_event_inbox(id uuid default gen_random_uuid(),event_key text unique,event_type text,payload jsonb,source_cursor text not null);
      insert into workspaces values('${workspace}');insert into projects values('${project}','${workspace}');`)
    await db.exec(await readFile(new URL('../supabase/migrations/20261010143816_frame_upload_approvals.sql',import.meta.url),'utf8'))
    await db.exec(await readFile(new URL('../supabase/migrations/20261010153609_frame_upload_collision_owner.sql',import.meta.url),'utf8'))
    await db.exec('set role service_role')
    const create = async (rev: string) => (await db.query<{id:string}>(`insert into frame_upload_approvals(workspace_id,project_id,source_file_id,source_rev,source_size,source_path,source_payload,suggested_name)
      values($1,$2,'id:source',$3,100,'/production/test.mov','{"subfolder":"02_Delivery","name":"v1/test.mov"}','R&F_A_B_Edit_V1.mov') returning id`,[workspace,project,rev])).rows[0].id
    const decide = (id:string, choice='new', ws=workspace) => db.query<{ok:boolean}>('select decide_frame_upload($1,$2,$3,$4,$5) ok',[id,ws,'U123','R&F_A_B_Edit_V1.mov',choice])
    const first = await create('one')
    const token = '33333333-3333-4333-8333-333333333333'
    const claim = () => db.query<{ok:boolean}>('select claim_frame_upload_notice($1,$2) ok',[first,token])
    assert.equal((await claim()).rows[0].ok,true)
    assert.equal((await claim()).rows[0].ok,false,'an active notice lease has one sender')
    await db.query('update frame_upload_approvals set notice_token=null where id=$1',[first])
    assert.equal((await claim()).rows[0].ok,true,'a released notice can refresh without waiting for lease expiry')
    assert.equal((await decide(first,'new',project)).rows[0].ok,false)
    assert.equal((await decide(first)).rows[0].ok,true)
    assert.equal((await decide(first)).rows[0].ok,false)
    assert.equal((await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n,1)
    const second = await create('two')
    await assert.rejects(decide(second),/duplicate key/)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[second])).rows[0].state,'awaiting','failed destination reservation rolls back decision')
    assert.equal((await decide(second,'skip')).rows[0].ok,true)
    assert.equal((await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n,1,'skip never queues work')
    await db.query("update frame_upload_approvals set state='awaiting' where id=$1",[first])
    assert.equal((await decide(first)).rows[0].ok,true)
    const events = (await db.query<{payload:{approvalVersion:number}}>('select payload from dropbox_event_inbox order by event_key')).rows
    assert.deepEqual(events.map(r=>r.payload.approvalVersion),[1,2],'re-review gets a new fenced execution event')
    const competing = await create('competing')
    const submit = (actor: string, name: string) => db.query<{ok:boolean}>(
      'select decide_frame_upload($1,$2,$3,$4,$5) ok', [competing,workspace,actor,name,'new'])
    const competitors = [
      { actor: 'UPRODUCER', name: 'R&F_A_B_Edit_V3.mov' },
      { actor: 'UCD', name: 'R&F_A_B_Anim_R3.mov' },
    ]
    const outcomes = await Promise.all(competitors.map(c => submit(c.actor,c.name)))
    assert.equal(outcomes.filter(r => r.rows[0].ok).length,1,'only one competing reviewer wins')
    const winner = competitors[outcomes.findIndex(r => r.rows[0].ok)]
    const saved = (await db.query<{approved_by:string,approved_name:string,approval_version:number}>(
      'select approved_by,approved_name,approval_version from frame_upload_approvals where id=$1',[competing])).rows[0]
    assert.deepEqual(saved,{approved_by:winner.actor,approved_name:winner.name,approval_version:1})
    assert.equal((await db.query<{n:number}>("select count(*)::int n from dropbox_event_inbox where payload->>'approvalRequestId'=$1",[competing])).rows[0].n,1)
    const stale = await db.query("update frame_upload_approvals set state='superseded' where id=$1 and state='awaiting' and approval_version=0 returning id",[competing])
    assert.equal(stale.rows.length,0,'a stale review source check cannot overwrite the winner')
    const pause = (version=1) => db.query<{ok:boolean}>('select pause_frame_upload_collision($1,$2) ok',[competing,version])
    assert.equal((await pause(0)).rows[0].ok,false,'stale workers cannot pause a newer approval')
    assert.equal((await pause()).rows[0].ok,true)
    assert.equal((await pause()).rows[0].ok,false,'pause is idempotent')
    const resolve = (actor=winner.actor,version=1,choice='keep_both',ws=workspace,name=winner.name.replace(/\.mov$/,'_02.mov')) => db.query<{ok:boolean}>(
      'select resolve_frame_upload_collision($1,$2,$3,$4,$5,$6) ok',[competing,ws,actor,version,name,choice])
    assert.equal((await submit('UOTHER','R&F_A_B_New_V5.mov')).rows[0].ok,false,'shared review cannot steal a collision')
    assert.equal((await resolve('UOTHER')).rows[0].ok,false)
    assert.equal((await resolve(winner.actor,0)).rows[0].ok,false)
    assert.equal((await resolve(winner.actor,1,'skip',project)).rows[0].ok,false)
    await assert.rejects(resolve(winner.actor,1,'new'),/approved filename cannot be changed/)
    await assert.rejects(resolve(winner.actor,1,'keep_both',workspace,'R&F_A_B_Wrong_V9_02.mov'),/numbered approved filename/)
    await assert.rejects(resolve(winner.actor,1,'replace',workspace,winner.name),/Replacement target required/)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[competing])).rows[0].state,'collision','invalid resolution rolls back')
    const resolutions = await Promise.all([resolve(),resolve(winner.actor,1,'skip')])
    assert.equal(resolutions.filter(r=>r.rows[0].ok).length,1,'only one concurrent collision decision queues work')
    const resolved = (await db.query<{approved_by:string,approval_version:number,state:string}>('select approved_by,approval_version,state from frame_upload_approvals where id=$1',[competing])).rows[0]
    assert.equal(resolved.approved_by,winner.actor)
    assert.equal(resolved.approval_version,2)
    assert.equal((await pause()).rows[0].ok,false,'old event cannot reopen resolved work')
    assert.equal((await resolve()).rows[0].ok,false,'repeat collision form cannot enqueue twice')
    if (resolved.state==='approved') {
      assert.equal((await pause(2)).rows[0].ok,true,'a new late collision returns to the same owner')
      assert.equal((await resolve(winner.actor,1,'skip')).rows[0].ok,false,'previous-cycle forms are fenced')
      const countBefore=(await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n
      assert.equal((await resolve(winner.actor,2,'skip')).rows[0].ok,true)
      assert.equal((await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n,countBefore,'collision skip never queues an upload')
    }
    // An exact replacement retains the original reviewer and pins its target.
    await db.query("update frame_upload_approvals set state='complete' where id=$1",[first])
    const replacement=await create('replacement')
    assert.equal((await decide(replacement)).rows[0].ok,true)
    assert.equal((await db.query<{ok:boolean}>('select pause_frame_upload_collision($1,1) ok',[replacement])).rows[0].ok,true)
    const replacementArgs=[replacement,workspace,'U123',1,'R&F_A_B_Edit_V1.mov','replace','old-frame-file','file']
    assert.equal((await db.query<{ok:boolean}>('select resolve_frame_upload_collision($1,$2,$3,$4,$5,$6,$7,$8) ok',replacementArgs)).rows[0].ok,true)
    assert.deepEqual((await db.query('select decision,conflict_id,approved_by,approval_version from frame_upload_approvals where id=$1',[replacement])).rows[0],
      {decision:'replace',conflict_id:'old-frame-file',approved_by:'U123',approval_version:2})
    await db.query("update frame_upload_approvals set upload_attempted_at=now() where id=$1",[replacement])
    assert.equal((await db.query<{ok:boolean}>('select pause_frame_upload_collision($1,2) ok',[replacement])).rows[0].ok,false,'an attempted upload can never be rearmed as a collision')
    for (const role of ['anon','authenticated']) {
      await db.exec(`reset role;set role ${role}`)
      await assert.rejects(db.exec('select * from frame_upload_approvals'),/permission denied/)
      await assert.rejects(decide(first),/permission denied/)
      await assert.rejects(pause(),/permission denied/)
      await assert.rejects(resolve(),/permission denied/)
    }
  } finally { await db.close() }
})
