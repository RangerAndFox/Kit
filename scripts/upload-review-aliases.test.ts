import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
const ws='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222'
const path='/production/2026/project/09_Outgoing/01_Client Progress/original.mp4',renamed=path.replace('original.mp4','R&F_Client_Project.mp4')
test('renamed legacy receipts retain original-path identity, exact revision proof and private controls',async()=>{
  const db=new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to service_role;
      create table workspaces(id uuid primary key);create table projects(id uuid primary key,workspace_id uuid,status text,unique(workspace_id,id));
      create table dropbox_event_inbox(event_key text unique,event_type text,payload jsonb,source_cursor text);
      insert into workspaces values('${ws}');insert into projects values('${project}','${ws}','active');`)
    for(const file of ['20261010143816_frame_upload_approvals.sql','20261010153609_frame_upload_collision_owner.sql']) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'))
    const old=(await db.query<{id:string}>(`insert into frame_upload_approvals(workspace_id,project_id,source_file_id,source_rev,source_size,source_path,source_payload,suggested_name,state,frame_file_id,renamed_path,slack_channel_id,slack_message_ts,created_at,updated_at)
      values($1,$2,'id:old','abcdef12345',100,$3,'{}','R&F_Client_Project.mp4','complete','frame-original',$4,'GTEAM','100.1','2026-10-23T23:00:00Z','2026-10-23T23:01:00Z') returning id`,[ws,project,path,renamed])).rows[0].id
    const pending=(await db.query<{id:string}>(`insert into frame_upload_approvals(workspace_id,project_id,source_file_id,source_rev,source_size,source_path,source_payload,suggested_name,slack_channel_id,slack_message_ts,created_at)
      values($1,$2,'id:new','abcdef54321',100,$3,'{}','R&F_Client_Project.mp4','GTEAM','200.1','2026-10-24T23:00:00Z') returning id`,[ws,project,path])).rows[0].id
    await db.exec(await readFile(new URL('../supabase/migrations/20261026181526_frame_upload_review_reconciliation.sql',import.meta.url),'utf8'))
    const obsolete=(await db.query<{id:string}>(`insert into frame_upload_approvals(workspace_id,project_id,source_file_id,source_rev,source_size,source_path,source_payload,suggested_name,review_slot_id,created_at)
      select $1,$2,'id:obsolete','abcdef11111',100,$3,'{}','R&F_Client_Project.mp4',review_slot_id,'2026-10-24T22:00:00Z' from frame_upload_approvals where id=$4 returning id`,[ws,project,path,pending])).rows[0].id
    assert.equal((await db.query<{n:number}>('select count(*)::int n from frame_upload_review_slots')).rows[0].n,2)
    const history=(await db.query('select state,frame_file_id,upload_attempted_at,updated_at from frame_upload_approvals where id=$1',[old])).rows[0]
    await db.exec(await readFile(new URL('../supabase/migrations/20261026183233_frame_upload_review_aliases.sql',import.meta.url),'utf8'))
    await db.exec('set role service_role')
    const slots=(await db.query<{id:string;review_slot_id:string}>('select id,review_slot_id from frame_upload_approvals where id in ($1,$2)',[old,pending])).rows
    assert.equal(slots[0].review_slot_id,slots[1].review_slot_id)
    const slot=slots[0].review_slot_id
    assert.equal((await db.query<{ok:boolean}>("select decide_frame_upload($1,$2,'U1','R&F_Client_Project.mp4','new') ok",[obsolete,ws])).rows[0].ok,false,'uneditable legacy cards cannot authorize obsolete media')
    await db.query("update frame_upload_approvals set state='collision',approved_by='U1',approval_version=1 where id=$1",[obsolete])
    assert.equal((await db.query<{ok:boolean}>("select resolve_frame_upload_collision($1,$2,'U1',1,'R&F_Client_Project.mp4','skip') ok",[obsolete,ws])).rows[0].ok,false)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[obsolete])).rows[0].state,'collision','a refused stale collision retains its original state')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from frame_upload_review_slots')).rows[0].n,2,'derived history is retained, not deleted')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from frame_upload_review_slots where current_approval_id is not null')).rows[0].n,1)
    const find=async(p=path,hash='a'.repeat(64))=>(await db.query<{r:{id:string}|null}>('select find_completed_frame_upload_receipt($1,$2,100,$3) r',[project,p,hash])).rows[0].r
    assert.equal(await find(),null,'legacy receipts are not fabricated as hashed')
    assert.equal((await db.query<{r:{id:string}}>('select find_unhashed_frame_upload_receipt($1,$2,100) r',[project,path])).rows[0].r.id,old)
    const save=async(file='id:old',workspace=ws)=>(await db.query<{ok:boolean}>('select save_frame_upload_receipt_hash($1,$2,$3,$4,100,$5) ok',[old,workspace,file,'abcdef12345','a'.repeat(64)])).rows[0].ok
    assert.equal(await save('id:wrong'),false);assert.equal(await save('id:old','33333333-3333-4333-8333-333333333333'),false)
    assert.equal(await save(),true)
    assert.equal((await find())!.id,old);assert.equal((await find(renamed))!.id,old)
    assert.equal(await find(path,'b'.repeat(64)),null,'same-size different bytes are not a receipt match')
    assert.deepEqual((await db.query('select state,frame_file_id,upload_attempted_at,updated_at from frame_upload_approvals where id=$1',[old])).rows[0],history)
    const source={path,name:'original.mp4',dropboxId:'id:new',rev:'abcdef54321',content_hash:'a'.repeat(64),source_modified_at:'2026-10-24T23:00:00Z',verified_frame_file_id:'frame-original'}
    await db.query('select register_frame_upload_source($1,$2,100,$3)',[project,JSON.stringify(source),'R&F_Client_Project.mp4'])
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[pending])).rows[0].state,'superseded')
    assert.equal((await db.query<{current_approval_id:string}>('select current_approval_id from frame_upload_review_slots where id=$1',[slot])).rows[0].current_approval_id,old)
    const fresh=(await db.query<{id:string}>('select register_frame_upload_source($1,$2,100,$3) id',[project,JSON.stringify({...source,dropboxId:'id:changed',rev:'abcdef67890',content_hash:'b'.repeat(64),source_modified_at:'2026-10-25T23:00:00Z',verified_frame_file_id:undefined}),'R&F_Client_Project.mp4'])).rows[0].id
    assert.equal((await db.query<{state:string;review_slot_id:string}>('select state,review_slot_id from frame_upload_approvals where id=$1',[fresh])).rows[0].review_slot_id,slot)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[fresh])).rows[0].state,'awaiting')
    const token='44444444-4444-4444-8444-444444444444'
    const context=(await db.query<{r:{slot:{generation:number};dirty_approvals:unknown[]}}>('select claim_frame_upload_review_slot($1,$2) r',[slot,token])).rows[0].r
    await db.query('select finish_frame_upload_review_notice($1,$2,$3,true,$4)',[slot,token,context.slot.generation,JSON.stringify(context.dirty_approvals)])
    assert.equal((await db.query<{notice_dirty:boolean}>('select notice_dirty from frame_upload_review_slots where id=$1',[slot])).rows[0].notice_dirty,true,'unclosed legacy copy remains retryable despite successful current outcome ack')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n,0)
    for(const role of ['anon','authenticated']) {
      await db.exec(`reset role;set role ${role}`)
      await assert.rejects(db.query('select find_unhashed_frame_upload_receipt($1,$2,100)',[project,path]),/permission denied/)
      await assert.rejects(save(),/permission denied/)
    }
  } finally { await db.close() }
})
