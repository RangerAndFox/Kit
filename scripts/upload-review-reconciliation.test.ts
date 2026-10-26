import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const ws='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222'
const path='/production/2026/project/09_Outgoing/01_Client Progress/edit.mp4'
const migration='20261024222101_frame_upload_review_reconciliation.sql'
const source=(id:string,rev:string,extra:Record<string,unknown>={})=>({path,name:'edit.mp4',safeName:'project',year:'2026',subfolder:'01_Client Progress',dropboxId:id,rev,source_modified_at:'2026-10-24T19:23:00Z',...extra})
test('logical-file review reconciles recreated sources and reuses receipts without replaying uploads',async()=>{
  const db=new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to service_role;
      create table workspaces(id uuid primary key);create table projects(id uuid primary key,workspace_id uuid,status text,unique(workspace_id,id));
      create table dropbox_event_inbox(event_key text unique,event_type text,payload jsonb,source_cursor text);
      insert into workspaces values('${ws}');insert into projects values('${project}','${ws}','active');`)
    for(const file of ['20261010143816_frame_upload_approvals.sql','20261010153609_frame_upload_collision_owner.sql']) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'))
    const insert=async(id:string,size:number,state:string,created:string,ts:string)=>{
      const r=await db.query<{id:string}>(`insert into frame_upload_approvals(workspace_id,project_id,source_file_id,source_rev,source_size,source_path,source_payload,suggested_name,state,frame_file_id,slack_channel_id,slack_message_ts,created_at)
        values($1,$2,$3,'abcdef12345',$4,$5,$6,'R&F_Client_Project.mp4',$7,case when $7='complete' then 'frame-original' end,'GTEAM',$8,$9) returning id`,
        [ws,project,id,size,path,JSON.stringify(source(id,'abcdef12345',{content_hash:state==='complete'?'a'.repeat(64):undefined,source_modified_at:created})),state,ts,created])
      return r.rows[0].id
    }
    const complete=await insert('id:original',100,'complete','2026-10-23T23:00:00Z','100.1')
    const obsolete=await insert('id:old-copy',110,'awaiting','2026-10-24T14:35:00Z','200.1')
    const current=await insert('id:current',120,'awaiting','2026-10-24T19:23:00Z','300.1')
    await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),'utf8'))
    await db.exec('set role service_role')
    const slot=(await db.query<{id:string;current_approval_id:string;completed_approval_id:string;slack_message_ts:string}>('select * from frame_upload_review_slots')).rows[0]
    assert.equal(slot.current_approval_id,current);assert.equal(slot.completed_approval_id,complete);assert.equal(slot.slack_message_ts,'100.1')
    const register=async(s:ReturnType<typeof source>,size=120)=> (await db.query<{id:string}>('select register_frame_upload_source($1,$2,$3,$4) id',[project,JSON.stringify(s),size,'R&F_Client_Project.mp4'])).rows[0].id
    assert.equal(await register(source('id:current','abcdef12345',{content_hash:'b'.repeat(64)})),current)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[obsolete])).rows[0].state,'superseded')
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[complete])).rows[0].state,'complete')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n,0,'reconciliation never queues an upload')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from frame_upload_approvals')).rows[0].n,3,'same revision registration is idempotent')
    const token='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444'
    const claim=async(t=token)=> (await db.query<{context:{slot:{generation:number};legacy:Array<{id:string;slack_message_ts:string}>;dirty_approvals:unknown[]}|null}>('select claim_frame_upload_review_slot($1,$2) context',[slot.id,t])).rows[0].context
    const context=(await claim())!
    assert.equal(await claim(other),null,'one logical-file sender owns all revisions')
    assert.deepEqual(context.legacy.map(r=>r.slack_message_ts).sort(),['200.1','300.1'])
    assert.equal((await db.query<{ok:boolean}>('select save_frame_upload_review_receipt($1,$2,$3,$4) ok',[slot.id,other,'GTEAM','100.1'])).rows[0].ok,false)
    assert.equal((await db.query<{ok:boolean}>('select save_frame_upload_review_receipt($1,$2,$3,$4) ok',[slot.id,token,'GOTHER','100.1'])).rows[0].ok,false,'an existing receipt cannot move to another group')
    assert.equal((await db.query<{ok:boolean}>('select save_frame_upload_review_receipt($1,$2,$3,$4) ok',[slot.id,token,'GTEAM','999.1'])).rows[0].ok,false,'a new timestamp cannot replace the known shared receipt')
    for(const old of context.legacy) await db.query('select close_legacy_frame_upload_notice($1,$2,$3,$4)',[slot.id,token,old.id,old.slack_message_ts])
    // An approval arriving while Slack is updating must remain actionable.
    await db.query("update frame_upload_approvals set state='approved',approved_by='U123',updated_at=clock_timestamp(),notice_dirty=true where id=$1",[current])
    await db.query('select finish_frame_upload_review_notice($1,$2,$3,true,$4)',[slot.id,token,context.slot.generation,JSON.stringify(context.dirty_approvals)])
    assert.equal((await db.query<{notice_dirty:boolean}>('select notice_dirty from frame_upload_review_slots where id=$1',[slot.id])).rows[0].notice_dirty,true)
    const again=(await claim())!
    await db.query('select finish_frame_upload_review_notice($1,$2,$3,true,$4)',[slot.id,token,again.slot.generation,JSON.stringify(again.dirty_approvals)])
    assert.equal((await db.query<{notice_dirty:boolean}>('select notice_dirty from frame_upload_review_slots where id=$1',[slot.id])).rows[0].notice_dirty,false)
    // Changed ID and bytes never inherits approval; the old POST stays fenced.
    await db.query('update frame_upload_approvals set upload_attempted_at=now() where id=$1',[current])
    const next=await register(source('id:replacement','abcdef54321',{source_modified_at:'2026-10-24T20:00:00Z',content_hash:'c'.repeat(64)}),130)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[next])).rows[0].state,'awaiting')
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[current])).rows[0].state,'approved','do not retire an attempted upload')
    const unverified=await register(source('id:hash-without-provider-proof','abcdefccccc',{source_modified_at:'2026-10-24T20:30:00Z',content_hash:'a'.repeat(64)}),100)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[unverified])).rows[0].state,'awaiting','a matching hash without live Frame verification cannot consume new work')
    const duplicate=await register(source('id:identical','abcdef67890',{source_modified_at:'2026-10-24T21:00:00Z',content_hash:'a'.repeat(64),verified_frame_file_id:'frame-original'}),100)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[duplicate])).rows[0].state,'superseded')
    assert.equal((await db.query<{current_approval_id:string}>('select current_approval_id from frame_upload_review_slots where id=$1',[slot.id])).rows[0].current_approval_id,complete)
    const late=await register(source('id:late-old','abcdef98765',{source_modified_at:'2026-10-24T20:45:00Z'}),120)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[late])).rows[0].state,'superseded')
    assert.equal((await db.query<{current_approval_id:string}>('select current_approval_id from frame_upload_review_slots where id=$1',[slot.id])).rows[0].current_approval_id,complete,'out-of-order detection cannot revive an obsolete source')
    const otherPath=await register(source('id:other-path','abcdefaaaaa',{path:path.replace('edit.mp4','other.mp4')}))
    assert.notEqual((await db.query<{review_slot_id:string}>('select review_slot_id from frame_upload_approvals where id=$1',[otherPath])).rows[0].review_slot_id,slot.id)
    const inFlight=(await claim())!
    const newer=await register(source('id:during-slack-update','abcdefbbbbb',{source_modified_at:'2026-10-24T22:00:00Z'}),140)
    await db.query('select finish_frame_upload_review_notice($1,$2,$3,true,$4)',[slot.id,token,inFlight.slot.generation,JSON.stringify(inFlight.dirty_approvals)])
    assert.equal((await db.query<{notice_dirty:boolean}>('select notice_dirty from frame_upload_review_slots where id=$1',[slot.id])).rows[0].notice_dirty,true,'a replacement arriving mid-render must remain dirty')
    const leased=(await claim())!
    await db.query("update frame_upload_review_slots set notice_claimed_at=now()-interval '3 minutes' where id=$1",[slot.id])
    assert.ok(await claim(other),'expired leases can be recovered')
    assert.equal((await db.query<{ok:boolean}>('select finish_frame_upload_review_notice($1,$2,$3,true,$4) ok',[slot.id,token,leased.slot.generation,JSON.stringify(leased.dirty_approvals)])).rows[0].ok,false,'stale sender cannot ack the new owner')
    assert.equal((await db.query<{ok:boolean}>("select decide_frame_upload($1,$2,'U123','R&F_Client_Project.mp4','new') ok",[obsolete,ws])).rows[0].ok,false,'an old card cannot approve the new file')
    const ws2='55555555-5555-4555-8555-555555555555',project2='66666666-6666-4666-8666-666666666666'
    await db.query('insert into workspaces values($1)',[ws2]);await db.query("insert into projects values($1,$2,'active')",[project2,ws2])
    const otherWorkspace=(await db.query<{id:string}>('select register_frame_upload_source($1,$2,120,$3) id',[project2,JSON.stringify(source('id:tenant2','abcdef12345')),'R&F_Other_Project.mp4'])).rows[0].id
    await assert.rejects(db.query('update frame_upload_review_slots set current_approval_id=$1 where id=$2',[otherWorkspace,slot.id]),/foreign key/)
    await assert.rejects(db.query('update frame_upload_approvals set review_slot_id=$1 where id=$2',[slot.id,otherWorkspace]),/foreign key/)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[newer])).rows[0].state,'awaiting')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n,0)
    await db.query("update projects set status='archived' where id=$1",[project2])
    const listed=await db.query<{project_id:string}>('select * from list_pending_frame_upload_reviews(null)')
    assert.ok(listed.rows.every(r=>r.project_id!==project2),'archived projects cannot replay notification history')
    await db.exec('update frame_upload_review_slots set notice_dirty=false;update frame_upload_approvals set notice_dirty=false')
    await db.query(`insert into frame_upload_approvals(workspace_id,project_id,source_file_id,source_rev,source_size,source_path,source_payload,suggested_name,state,review_slot_id,updated_at)
      select $1,$2,'id:obsolete-'||g,'abcdef'||lpad(g::text,5,'0'),100,$3,'{}','R&F_Client_Project.mp4','superseded',$4,'2026-10-23T00:00:00Z'
      from generate_series(1,35) g`,[ws,project,path,slot.id])
    await db.query('update frame_upload_approvals set notice_dirty=true where id=$1',[otherPath])
    const fair=await db.query<{id:string}>('select id from list_pending_frame_upload_reviews(null)')
    const otherSlot=(await db.query<{review_slot_id:string}>('select review_slot_id from frame_upload_approvals where id=$1',[otherPath])).rows[0].review_slot_id
    assert.ok(fair.rows.some(r=>r.id===otherSlot),'many dirty revisions of one file cannot starve another logical card')
    for(const role of ['anon','authenticated']) {
      await db.exec(`reset role;set role ${role}`)
      await assert.rejects(db.exec('select * from frame_upload_review_slots'),/permission denied/)
      await assert.rejects(register(source('id:attack','abcdefaaaaa')),/permission denied/)
      await assert.rejects(claim(),/permission denied/)
      await assert.rejects(db.query('select find_completed_frame_upload_receipt($1,$2,100,$3)',[project,path,'a'.repeat(64)]),/permission denied/)
      await assert.rejects(db.query('select * from list_pending_frame_upload_reviews(null)'),/permission denied/)
    }
    await db.exec('reset role;set role service_role')
    await db.query('delete from projects where id=$1',[project2])
    assert.equal((await db.query<{n:number}>('select count(*)::int n from frame_upload_review_slots where project_id=$1',[project2])).rows[0].n,0,'existing project deletion still cascades across review history')
  }finally{await db.close()}
})
