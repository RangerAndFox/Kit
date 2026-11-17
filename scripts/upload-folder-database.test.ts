import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { folderNames, uploadFolderPath, type FolderContext } from '../src/lib/delivery/upload-folder'

const ws='11111111-1111-4111-8111-111111111111', project='22222222-2222-4222-8222-222222222222'
const root='/production/2026/2646_Microsoft_Foundry/09_Outgoing/02_Delivery/111726'
test('folder snapshot: one winner, exact revision membership, atomic queue/cancel, leases and tenant isolation',async()=>{
  const db=new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to service_role;
      create table workspaces(id uuid primary key);create table projects(id uuid primary key,workspace_id uuid,status text,unique(workspace_id,id));
      create table dropbox_event_inbox(event_key text unique,event_type text,payload jsonb,source_cursor text);
      insert into workspaces values('${ws}');insert into projects values('${project}','${ws}','active');`)
    for(const file of ['20261010143816_frame_upload_approvals.sql','20261010153609_frame_upload_collision_owner.sql','20261026181526_frame_upload_review_reconciliation.sql','20261026184307_frame_upload_review_aliases.sql','20261117153133_folder_upload_reviews.sql']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'))
    }
    await db.exec('set role service_role')
    const register=async(file:string,id=file,rev='abcdef12345')=>(await db.query<{id:string}>('select register_frame_upload_source($1,$2,100,$3) id',[project,JSON.stringify({path:`${root}/${file}`,name:`111726/${file}`,safeName:'2646_Microsoft_Foundry',subfolder:'02_Delivery',year:'2026',dropboxId:`id:${id}`,rev,source_modified_at:new Date().toISOString()}),'R&F_Microsoft_Foundry.mp4'])).rows[0].id
    for(const file of ['Web/01_Video/edit.mp4','Web/02_Accessibility Files/captions.ttml','Web/02_Accessibility Files/captions.vtt','Web/02_Accessibility Files/captions.txt']) await register(file)
    await db.exec("update frame_upload_review_slots s set slack_channel_id='GSHARED',slack_message_ts='100.'||x.rn from (select id,row_number() over(order by id) rn from frame_upload_review_slots) x where x.id=s.id; update frame_upload_review_slots set notice_dirty=false; update frame_upload_approvals set notice_dirty=false")
    assert.equal((await db.query('select * from list_frame_upload_folder_notices(null)')).rows.length,1,'already-acknowledged pending per-file cards are adopted without replaying detection')
    const prepare=async()=>(await db.query<{c:FolderContext}>('select prepare_frame_upload_folder($1,$2) c',[project,uploadFolderPath(`${root}/Web/01_Video/edit.mp4`)])).rows[0].c
    const first=await prepare()
    assert.equal(first.files.length,4);assert.equal(first.folder.manifest.length,4)
    assert.equal(first.folder.slack_message_ts,'100.1','reuse one existing message rather than pinging the reviewers again')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from frame_upload_folder_reviews')).rows[0].n,1,'video and caption subfolders share one request')
    const token='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444'
    assert.equal((await db.query<{ok:boolean}>('select claim_frame_upload_folder_notice($1,$2) ok',[first.folder.id,token])).rows[0].ok,true)
    assert.equal((await db.query<{ok:boolean}>('select claim_frame_upload_folder_notice($1,$2) ok',[first.folder.id,other])).rows[0].ok,false)
    assert.equal((await db.query<{ok:boolean}>('select save_frame_upload_folder_notice($1,$2,$3,$4) ok',[first.folder.id,token,'GSHARED','100.1'])).rows[0].ok,true)
    assert.equal((await db.query<{ok:boolean}>('select save_frame_upload_folder_notice($1,$2,$3,$4) ok',[first.folder.id,token,'GOTHER','200.1'])).rows[0].ok,false)
    const decide=async(c:FolderContext,cancel=false,actor='UPRODUCER',workspace=ws)=>(await db.query<{ok:boolean}>('select decide_frame_upload_folder($1,$2,$3,$4,$5,$6) ok',[c.folder.id,workspace,actor,c.folder.generation,JSON.stringify(cancel?[]:folderNames(c,'R&F_Microsoft_Foundry','111726')),cancel])).rows[0].ok
    assert.equal(await decide(first,false,'UARTIST','99999999-9999-4999-8999-999999999999'),false)
    // Incomplete/invalid manifests must roll back every file and queue insert.
    await assert.rejects(db.query('select decide_frame_upload_folder($1,$2,$3,$4,$5,false)',[first.folder.id,ws,'UPRODUCER',first.folder.generation,JSON.stringify([{id:first.files[0].id,name:'bad.mov'}])]))
    const partial=folderNames(first,'R&F_Microsoft_Foundry','111726')
    const last=[...partial].sort((a,b)=>a.id.localeCompare(b.id)).at(-1)!
    last.name='../bad.mp4'
    await assert.rejects(db.query('select decide_frame_upload_folder($1,$2,$3,$4,$5,false)',[first.folder.id,ws,'UPRODUCER',first.folder.generation,JSON.stringify(partial)]))
    assert.equal((await db.query<{n:number}>("select count(*)::int n from frame_upload_approvals where state='awaiting'")).rows[0].n,4,'a late failure rolls back earlier row decisions')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n,0)
    assert.equal(await decide(first),true)
    assert.equal(await decide(first,false,'UCD'),false,'simultaneous second reviewer cannot rename or queue again')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n,4)
    assert.equal((await db.query<{n:number}>("select count(*)::int n from frame_upload_approvals where approved_by='UPRODUCER' and state='approved'")).rows[0].n,4)
    const added=await register('Web/03_Stills/later.jpg')
    assert.equal(await decide(first),false,'new arrivals never inherit an earlier folder approval')
    const second=await prepare()
    assert.equal(second.folder.manifest.length,1)
    const replacement=await register('Web/03_Stills/later.jpg','replacement','abcdef54321')
    assert.equal(await decide(second),false,'changed media invalidates an open modal')
    const third=await prepare()
    assert.equal(third.files.find(f=>f.id===replacement)?.state,'awaiting')
    assert.equal(await decide(third,true),true)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[replacement])).rows[0].state,'skipped')
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[added])).rows[0].state,'superseded')
    assert.equal((await db.query<{n:number}>('select count(*)::int n from dropbox_event_inbox')).rows[0].n,4,'cancel has no upload effect')
    // An outcome arriving during Slack rendering cannot be acknowledged by an old snapshot.
    const row=first.files[0]
    await db.query("update frame_upload_approvals set state='complete',frame_file_id='frame-ready',notice_dirty=true,updated_at=clock_timestamp() where id=$1",[row.id])
    const current=await prepare()
    await db.query('select finish_frame_upload_folder_notice($1,$2,$3,true,$4)',[current.folder.id,token,current.folder.generation,JSON.stringify(first.dirty)])
    assert.equal((await db.query<{dirty:boolean}>('select notice_dirty dirty from frame_upload_approvals where id=$1',[row.id])).rows[0].dirty,true)
    assert.equal((await db.query<{state:string}>('select state from frame_upload_approvals where id=$1',[row.id])).rows[0].state,'complete')
    for(const role of ['anon','authenticated']) {
      await db.exec(`reset role;set role ${role}`)
      await assert.rejects(db.exec('select * from frame_upload_folder_reviews'),/permission denied/)
      await assert.rejects(prepare(),/permission denied/)
      await assert.rejects(decide(third),/permission denied/)
    }
  } finally {await db.close()}
})
