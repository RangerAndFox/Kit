import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { UploadPackagePage } from '../src/lib/delivery/upload-package'
const migration = '20261107120000_frame_upload_review_packages.sql'
const ws='00000000-0000-0000-0000-000000000001', project='00000000-0000-0000-0000-000000000002'
const token='00000000-0000-0000-0000-000000000003', other='00000000-0000-0000-0000-000000000004'
async function fixture() {
  const db=new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table workspaces(id uuid primary key);
    create table projects(id uuid primary key,workspace_id uuid references workspaces(id),status text,unique(workspace_id,id));
    create table project_share_events(id uuid primary key);
    create table dropbox_event_inbox(id uuid primary key default gen_random_uuid(),event_key text unique,event_type text,payload jsonb,source_cursor text,
      status text,next_attempt_at timestamptz default now(),created_at timestamptz default now(),
      claimed_at timestamptz,attempt_count int default 0,claim_token uuid,claimed_by text,updated_at timestamptz default now());
    insert into workspaces values('${ws}'); insert into projects values('${project}','${ws}','active');`)
  for (const file of ['20260831024500_checkpoint_frameio_delivery_transfers.sql','20260925005401_frameio_transfer_retirement.sql','20261010143816_frame_upload_approvals.sql','20261010153609_frame_upload_collision_owner.sql','20261026181526_frame_upload_review_reconciliation.sql','20261026184307_frame_upload_review_aliases.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url),'utf8'))
  }
  return db
}
async function apply(db:PGlite) { await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),'utf8')) }
async function source(db:PGlite,path:string,id:string) {
  return (await db.query<{id:string}>('select register_frame_upload_source($1,$2,100,$3) id',[project,JSON.stringify({path,dropboxId:`id:${id}`,rev:'123456789abc',name:path.split('/').pop(),subfolder:'02_Delivery',source_modified_at:new Date().toISOString()}),'R&F_test.mov'])).rows[0].id
}
async function scalar<T=string>(db:PGlite,sql:string,params:unknown[]=[]):Promise<T> { return Object.values((await db.query(sql,params)).rows[0] as object)[0] as T }

test('delivery package root excludes Client Progress and groups nested paths',async()=>{
 const db=await fixture(); try { await apply(db)
  for (const [path,root] of [['/P/02_Delivery/a.mov','/p/02_delivery'],['/P/02_Delivery/Campaign/a.mov','/p/02_delivery/campaign'],['/P/02_Delivery/Campaign/deep/more/a.mov','/p/02_delivery/campaign'],['/P/01_Client Progress/a.mov',null]])
    assert.equal(await scalar(db,'select frame_upload_package_root($1)',[path]),root)
 } finally {await db.close()}
})
test('one bounded package outbox, stable pages and fenced immutable receipts',async()=>{
 const db=await fixture(); try {await apply(db)
  for(let i=0;i<12;i++) await source(db,`/P/02_Delivery/Batch/f${i}.mov`,`${i}`)
  await source(db,'/P/01_Client Progress/a.mov','progress')
  assert.equal(await scalar(db,'select count(*) from frame_upload_review_packages'),1)
  assert.equal(await scalar(db,"select package_id from frame_upload_review_slots where path_key like '%progress%'"),null)
  const pkg=await scalar(db,'select id from frame_upload_review_packages')
  assert.equal(await scalar(db,'select claim_frame_upload_package_notice($1,$2)',[pkg,token]),true)
  assert.equal(await scalar(db,'select claim_frame_upload_package_notice($1,$2)',[pkg,other]),false)
  const page=await scalar<UploadPackagePage>(db,'select get_frame_upload_package_page($1,null,10)',[pkg])
  assert.equal(page.total,12); assert.equal(page.awaiting,12); assert.equal(page.approvals.length,10)
  const next=await scalar<UploadPackagePage>(db,'select get_frame_upload_package_page($1,$2,10)',[pkg,page.next_cursor])
  assert.equal(next.approvals.length,2); assert.equal(next.next_cursor,null)
  assert.equal(await scalar(db,'select get_frame_upload_package_page($1,$2,10)',[pkg,other]),null)
  assert.equal(await scalar(db,"select save_frame_upload_package_receipt($1,$2,'G1','1.2')",[pkg,token]),true)
  assert.equal(await scalar(db,"select save_frame_upload_package_receipt($1,$2,'G2','1.2')",[pkg,token]),false)
  await db.query("update frame_upload_approvals set state='skipped' where id=$1",[page.approvals[0].id])
  assert.equal(await scalar(db,'select finish_frame_upload_package_notice($1,$2,$3,true)',[pkg,token,page.package.generation]),true)
  assert.equal(await scalar(db,'select notice_dirty from frame_upload_review_packages'),true)
  assert.equal(await scalar(db,'select claim_frame_upload_package_notice($1,$2)',[pkg,other]),true)
  await db.exec("update frame_upload_review_packages set notice_claimed_at=now()-interval '3 minutes'")
  assert.equal(await scalar(db,"select save_frame_upload_package_receipt($1,$2,'G1','1.2')",[pkg,other]),false)
  assert.equal(await scalar(db,'select claim_frame_upload_package_notice($1,$2)',[pkg,token]),true)
  assert.equal(await scalar(db,'select finish_frame_upload_package_notice($1,$2,100,true)',[pkg,other]),false)
  assert.equal(await scalar(db,"select has_function_privilege('authenticated','get_frame_upload_package_page(uuid,uuid,integer)','execute')"),false)
 } finally {await db.close()}
})
test('migration preserves history and refuses mixed private routing',async()=>{
 const db=await fixture(); try {
  await source(db,'/P/02_Delivery/Batch/a.mov','a'); await source(db,'/P/02_Delivery/Batch/b.mov','b')
  await db.exec("update frame_upload_review_slots set slack_channel_id=case when path_key like '%a.mov' then 'G1' else 'G2' end,slack_message_ts='1.1'; update frame_upload_approvals set state='complete',frame_file_id='frame-receipt'")
  await apply(db)
  assert.equal(await scalar(db,'select notice_dirty from frame_upload_review_packages'),false)
  assert.equal(await scalar(db,'select count(*) from frame_upload_review_slots where slack_message_ts is not null'),2)
  assert.equal(await scalar(db,"select count(*) from frame_upload_approvals where state='complete' and frame_file_id='frame-receipt'"),2)
  await source(db,'/P/02_Delivery/Batch/c.mov','c')
  const pkg=await scalar(db,'select id from frame_upload_review_packages')
  assert.equal(await scalar(db,'select claim_frame_upload_package_notice($1,$2)',[pkg,token]),false)
 } finally {await db.close()}
})

test('root moves retain approvals and receipts; workspace FK and pending bounds hold',async()=>{
 const db=await fixture(); try {await apply(db)
  const id=await source(db,'/P/02_Delivery/First/a.mov','move')
  const original=await scalar(db,'select package_id from frame_upload_review_slots')
  const slot=await scalar(db,'select id from frame_upload_review_slots')
  await db.exec("update frame_upload_review_packages set notice_dirty=false; update frame_upload_review_slots set slack_channel_id='G1',slack_message_ts='1.2'")
  await db.query("update frame_upload_approvals set source_path='/P/02_Delivery/Second/a.mov' where id=$1",[id])
  await db.query('update frame_upload_review_slots set current_approval_id=$1,generation=generation+1 where id=$2',[id,slot])
  assert.notEqual(await scalar(db,'select package_id from frame_upload_review_slots'),original)
  assert.equal(await scalar(db,'select notice_dirty from frame_upload_review_packages where id=$1',[original]),true)
  assert.equal(await scalar(db,'select slack_message_ts from frame_upload_review_slots'),'1.2')
  await db.query("update frame_upload_approvals set source_path='/P/01_Client Progress/a.mov' where id=$1",[id])
  await db.query('update frame_upload_review_slots set current_approval_id=$1,generation=generation+1 where id=$2',[id,slot])
  assert.equal(await scalar(db,'select package_id from frame_upload_review_slots'),null)
  await db.query('insert into workspaces values($1)',[other])
  await db.query('insert into projects values($1,$2,\'active\')',[token,other])
  await db.query("insert into frame_upload_review_packages(workspace_id,project_id,root_path) values($1,$2,'/other/02_delivery')",[other,token])
  const foreign=await scalar(db,'select id from frame_upload_review_packages where workspace_id=$1',[other])
  await assert.rejects(db.query('update frame_upload_review_slots set package_id=$1 where id=$2',[foreign,slot]),/foreign key/)
  for(let i=0;i<12;i++) await source(db,`/P/02_Delivery/batch${i}/a.mov`,`batch${i}`)
  assert.equal((await db.query('select * from list_pending_frame_upload_packages()')).rows.length,10)
  assert.equal(await scalar(db,"select has_table_privilege('anon','frame_upload_review_packages','select')"),false)
 } finally {await db.close()}
})

test('legacy ambiguous sends block publication and compatible receipts adopt without replay',async()=>{
 for(const ambiguous of [false,true]) {
  const db=await fixture(); try {
   await source(db,'/P/02_Delivery/Batch/a.mov','a')
   await db.query('update frame_upload_review_slots set slack_channel_id=$1,slack_message_ts=$2',['G1',ambiguous?null:'1.1'])
   await apply(db)
   const pkg=await scalar(db,'select id from frame_upload_review_packages')
   assert.equal(await scalar(db,'select notice_dirty from frame_upload_review_packages'),!ambiguous)
   assert.equal(await scalar(db,'select slack_message_ts from frame_upload_review_packages'),ambiguous?null:'1.1')
   await source(db,'/P/02_Delivery/Batch/b.mov','b')
   assert.equal(await scalar(db,'select claim_frame_upload_package_notice($1,$2)',[pkg,token]),!ambiguous)
   if(!ambiguous) {
    const generation=await scalar(db,'select generation from frame_upload_review_packages')
    await db.exec('update frame_upload_approvals set notice_dirty=false; update frame_upload_review_slots set notice_dirty=false')
    assert.equal(await scalar(db,'select generation from frame_upload_review_packages'),generation)
    await db.exec("update frame_upload_review_slots set slack_channel_id='G1',slack_message_ts=null where path_key like '%b.mov'")
    assert.match(await scalar(db,'select blocked_reason from frame_upload_review_packages'),/outcome requires reconciliation/)
    assert.equal(await scalar(db,"select save_frame_upload_package_receipt($1,$2,'G1','1.1')",[pkg,token]),false)
    await scalar(db,'select finish_frame_upload_package_notice($1,$2,$3,true)',[pkg,token,generation])
    assert.equal(await scalar(db,'select notice_dirty from frame_upload_review_packages'),true)
   }
  } finally {await db.close()}
 }
})


test('channel reservation precedes posting and never erases or switches a receipt',async()=>{
 const db=await fixture(); try {await apply(db)
  await source(db,'/P/02_Delivery/Batch/a.mov','reservation')
  const pkg=await scalar(db,'select id from frame_upload_review_packages')
  const reserve=(owner:string,channel:string|null,ts:string|null)=>scalar(db,'select save_frame_upload_package_receipt($1,$2,$3,$4)',[pkg,owner,channel,ts])
  assert.equal(await scalar(db,'select claim_frame_upload_package_notice($1,$2)',[pkg,token]),true)
  assert.equal(await reserve(token,'G1',null),true)
  assert.equal(await scalar(db,'select slack_channel_id from frame_upload_review_packages'),'G1')
  assert.equal(await scalar(db,'select slack_message_ts from frame_upload_review_packages'),null)
  assert.equal(await reserve(token,'G2',null),false)
  assert.equal(await reserve(other,'G1',null),false)
  assert.equal(await reserve(token,null,null),false)
  assert.equal(await reserve(token,'',null),false)
  assert.equal(await reserve(token,'G1',''),false)
  assert.equal(await reserve(token,'G1','1.2'),true)
  assert.equal(await reserve(token,'G1',null),true)
  assert.equal(await scalar(db,'select slack_message_ts from frame_upload_review_packages'),'1.2')
  assert.equal(await reserve(token,'G1','2.3'),false)
  assert.equal(await reserve(token,'G2','1.2'),false)
  await db.exec("update frame_upload_review_packages set notice_claimed_at=now()-interval '3 minutes'")
  assert.equal(await reserve(token,'G1',null),false)
  assert.equal(await scalar(db,'select claim_frame_upload_package_notice($1,$2)',[pkg,other]),true)
  assert.equal(await reserve(token,'G1',null),false)
  assert.equal(await reserve(other,'G1',null),true)
  await db.exec("update frame_upload_review_packages set blocked_reason='routing requires reconciliation'")
  assert.equal(await reserve(other,'G1',null),false)
 } finally {await db.close()}
})


test('canonical file card retirement is lease-, receipt-, package- and group-fenced',async()=>{
 const db=await fixture(); try {
  await source(db,'/P/02_Delivery/Batch/a.mov','old-a')
  await source(db,'/P/02_Delivery/Batch/b.mov','old-b')
  await source(db,'/P/02_Delivery/Done/a.mov','done-a')
  await db.exec(`update frame_upload_review_slots set notice_dirty=false,slack_channel_id='G1',slack_message_ts=case when path_key like '%/a.mov' then '1.1' else '1.2' end;
    update frame_upload_approvals set state='complete',frame_file_id='done' where source_path like '%/Done/%';`)
  await apply(db)
  const pkg=await scalar(db,"select id from frame_upload_review_packages where root_path like '%/batch'")
  const done=await scalar(db,"select id from frame_upload_review_packages where root_path like '%/done'")
  assert.equal(await scalar(db,'select notice_dirty from frame_upload_review_packages where id=$1',[pkg]),true)
  assert.equal(await scalar(db,'select notice_dirty from frame_upload_review_packages where id=$1',[done]),false)
  const anchor=await scalar(db,'select slack_message_ts from frame_upload_review_packages where id=$1',[pkg])
  const slot=await scalar(db,'select id from frame_upload_review_slots where package_id=$1 and slack_message_ts<>$2',[pkg,anchor])
  const ts=await scalar(db,'select slack_message_ts from frame_upload_review_slots where id=$1',[slot])
  assert.equal(await scalar(db,'select notice_dirty from frame_upload_review_slots where id=$1',[slot]),true)
  const close=(owner:string,p= pkg,ch='G1',stamp=ts)=>scalar(db,'select close_frame_upload_package_legacy_notice($1,$2,$3,$4,$5)',[slot,owner,p,ch,stamp])
  assert.equal(await close(token),false)
  await scalar(db,'select claim_frame_upload_review_slot($1,$2)',[slot,token])
  assert.equal(await close(other),false)
  assert.equal(await close(token,done),false)
  assert.equal(await close(token,pkg,'G2'),false)
  assert.equal(await close(token,pkg,'G1','wrong'),false)
  await db.query("update frame_upload_review_packages set blocked_reason='private routing changed' where id=$1",[pkg])
  assert.equal(await close(token),false)
  await db.query('update frame_upload_review_packages set blocked_reason=null where id=$1',[pkg])
  await db.query("update frame_upload_review_slots set notice_claimed_at=now()-interval '3 minutes' where id=$1",[slot])
  assert.equal(await close(token),false)
  await scalar(db,'select claim_frame_upload_review_slot($1,$2)',[slot,other])
  assert.equal(await close(token),false)
  assert.equal(await close(other),true)
  assert.equal(await scalar(db,'select package_notice_closed from frame_upload_review_slots where id=$1',[slot]),true)
  assert.equal(await scalar(db,'select slack_message_ts from frame_upload_review_slots where id=$1',[slot]),ts)
  assert.equal(await scalar(db,'select slack_message_ts from frame_upload_review_packages where id=$1',[pkg]),anchor)
  const canonical=await scalar(db,'select id from frame_upload_review_slots where package_id=$1 and slack_message_ts=$2',[pkg,anchor])
  await db.query('update frame_upload_review_slots set notice_dirty=true where id=$1',[canonical])
  await scalar(db,'select claim_frame_upload_review_slot($1,$2)',[canonical,token])
  assert.equal(await scalar(db,'select close_frame_upload_package_legacy_notice($1,$2,$3,$4,$5)',[canonical,token,pkg,'G1',anchor]),false)
  assert.equal(await scalar(db,"select has_function_privilege('authenticated','close_frame_upload_package_legacy_notice(uuid,uuid,uuid,text,text)','execute')"),false)
 } finally {await db.close()}
})

test('package slot lease renewal extends only live ownership without synthetic receipts',async()=>{
 const db=await fixture(); try {await apply(db)
  await source(db,'/P/02_Delivery/Batch/a.mov','renew')
  const slot=await scalar(db,'select id from frame_upload_review_slots')
  const generation=await scalar(db,'select generation from frame_upload_review_slots')
  const renew=(owner:string)=>scalar(db,'select renew_frame_upload_review_lease($1,$2)',[slot,owner])
  assert.equal(await renew(token),false)
  await scalar(db,'select claim_frame_upload_review_slot($1,$2)',[slot,token])
  await db.exec("update frame_upload_review_slots set notice_claimed_at=now()-interval '1 minute'")
  assert.equal(await renew(other),false)
  assert.equal(await renew(token),true)
  assert.equal(await scalar(db,"select notice_claimed_at>now()-interval '5 seconds' from frame_upload_review_slots"),true)
  assert.equal(await scalar(db,'select slack_channel_id from frame_upload_review_slots'),null)
  assert.equal(await scalar(db,'select slack_message_ts from frame_upload_review_slots'),null)
  assert.equal(await scalar(db,'select generation from frame_upload_review_slots'),generation)
  await db.exec("update frame_upload_review_slots set notice_claimed_at=now()-interval '3 minutes'")
  assert.equal(await renew(token),false)
  await scalar(db,'select claim_frame_upload_review_slot($1,$2)',[slot,other])
  assert.equal(await renew(token),false)
  assert.equal(await renew(other),true)
  assert.equal(await scalar(db,"select has_function_privilege('anon','renew_frame_upload_review_lease(uuid,uuid)','execute')"),false)
 } finally {await db.close()}
})


test('folder review links require completed current exact-source scoped transfer receipts',async()=>{
 const db=await fixture(); try {await apply(db)
  const id=await source(db,'/P/02_Delivery/Batch/a.mov','review-link')
  const pkg=await scalar(db,'select id from frame_upload_review_packages')
  const link=async()=>{
    const page=await scalar<UploadPackagePage & {approvals:Array<{frame_review_url:string|null}>}>(db,'select get_frame_upload_package_page($1)',[pkg])
    return page.approvals[0].frame_review_url
  }
  await db.query(`insert into frameio_delivery_transfers(project_id,dropbox_file_id,dropbox_rev,frameio_project_id,frameio_folder_id,frameio_file_id,frameio_status_path,frameio_view_url,frameio_share_url,state)
    values($1,'id:review-link','123456789abc','frame-project','folder','frame-file','status','view','https://f.io/verified-receipt','ready')`,[project])
  await db.query("update frame_upload_approvals set frame_file_id='frame-file' where id=$1",[id])
  assert.equal(await link(),null)
  await db.query("update frame_upload_approvals set state='complete' where id=$1",[id])
  assert.equal(await link(),'https://f.io/verified-receipt')
  await db.exec("update frameio_delivery_transfers set frameio_file_id='other-frame'")
  assert.equal(await link(),null)
  await db.exec("update frameio_delivery_transfers set frameio_file_id='frame-file',dropbox_rev='other-revision'")
  assert.equal(await link(),null)
  await db.exec("update frameio_delivery_transfers set dropbox_rev='123456789abc',dropbox_file_id='id:other-file'")
  assert.equal(await link(),null)
  await db.exec("update frameio_delivery_transfers set dropbox_file_id='id:review-link',state='processing'")
  assert.equal(await link(),null)
  await db.query('insert into workspaces values($1)',[other])
  await db.query("insert into projects values($1,$2,'active')",[token,other])
  await db.query("update frameio_delivery_transfers set state='ready',project_id=$1",[token])
  assert.equal(await link(),null)
  await db.query('update frameio_delivery_transfers set project_id=$1',[project])
  assert.equal(await link(),'https://f.io/verified-receipt')
  await assert.rejects(db.exec("update frameio_delivery_transfers set retired_at=now()"),/check constraint/)
  await db.exec("update frameio_delivery_transfers set state='failed',retired_at=now(),retired_reason='test retirement',retired_by='test'")
  assert.equal(await link(),null)
 } finally {await db.close()}
})
