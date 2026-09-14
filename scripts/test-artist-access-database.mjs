// Synthetic, isolated Postgres test: no provider credentials or network calls.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
const {PGlite}=await import(process.env.ARTIST_PGLITE_PATH ? pathToFileURL(process.env.ARTIST_PGLITE_PATH).href : '@electric-sql/pglite')
const db=new PGlite()
const ws='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222', project='33333333-3333-4333-8333-333333333333'
const owner='44444444-4444-4444-8444-444444444444', next='55555555-5555-4555-8555-555555555555'
const begin=(workspace=ws,actor='UPRODUCER',legacy=false)=>db.query('select * from artist_access_begin($1,$2,$3,$4,$5,$6,$7)',[workspace,project,'Artist@Example.com','Artist Example',actor,owner,legacy])
let assertions=0
const rejects=async(promise,pattern)=>{await assert.rejects(promise,pattern);assertions++}
try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table workspaces(id uuid primary key);create table projects(id uuid primary key,workspace_id uuid);
 create table team_members(workspace_id uuid,slack_user_id text,role text,is_active boolean default true);
 create table freelancer_onboardings(project_id uuid,artist_email text);
 grant select on workspaces,projects,team_members,freelancer_onboardings to service_role;
 alter default privileges in schema public grant all on tables to service_role;`)
 await db.query('insert into workspaces values($1),($2)',[ws,other]);await db.query('insert into projects values($1,$2)',[project,ws])
 await db.query("insert into team_members values($1,'UPRODUCER','producer',true),($1,'UARTIST','artist',true),($1,'UADMIN','founder',true),($1,'UINACTIVE','producer',false)",[ws])
 await db.query('insert into freelancer_onboardings values($1,$2)',[project,'artist@example.com'])
 await db.exec(await readFile(new URL('../supabase/migrations/20260914202955_artist_project_offboarding.sql',import.meta.url),'utf8'))
 await db.exec('set role service_role')
 await rejects(begin(other),/denied/);await rejects(begin(ws,'UARTIST'),/denied/);await rejects(begin(ws,'UINACTIVE'),/denied/)
 await rejects(db.query('delete from artist_access_audit'),/permission denied/)
 await rejects(db.query("update artist_access_audit set action='forged'"),/permission denied/)
 const e=(await begin()).rows[0];assert.equal(e.state,'onboarding');assert.equal(e.artist_email,'artist@example.com');assertions+=2
 await rejects(begin(),/held/)
 const prepare=(snapshot={engagement:e})=>db.query('select * from artist_offboard_prepare($1,$2,$3,$4)',[ws,e.id,'UPRODUCER',JSON.stringify(snapshot)])
 await rejects(prepare(),/changed/)
 await rejects(db.query('select artist_access_record($1,$2,$3,$4,$5,$6)',[ws,e.id,next,'UPRODUCER','slack','{}']),/ownership/)
 await db.query('select artist_access_record($1,$2,$3,$4,$5,$6)',[ws,e.id,owner,'UPRODUCER','slack',JSON.stringify({resource:'CPROJECT',subject:'UARTIST',status:'ok'})])
 await db.query('select artist_access_record($1,$2,$3,$4,$5,$6)',[ws,e.id,owner,'UPRODUCER','slack',JSON.stringify({status:'failed'})])
 await db.query('select artist_access_finish_onboarding($1,$2,$3,$4)',[ws,e.id,owner,'UPRODUCER'])
 const active=(await begin(ws,'UPRODUCER',true)).rows[0]
 assert.equal(active.grants.slack.subject,'UARTIST');assertions++
 await rejects(prepare({}),/changed/)
 await rejects(prepare({engagement:{...active,workspace_id:other}}),/changed/)
 const make=()=>prepare({engagement:active})
 const r=(await make()).rows[0], cancelled=(await make()).rows[0], competing=(await make()).rows[0]
 const claim=(id,by=owner,actor='UPRODUCER',cancel=false)=>db.query('select * from artist_offboard_claim($1,$2,$3,$4,$5)',[ws,id,actor,by,cancel])
 assert.equal((await claim(cancelled.id,owner,'UPRODUCER',true)).rows[0].status,'cancelled');assertions++
 await rejects(claim(cancelled.id),/unavailable/)
 await rejects(claim(r.id,owner,'UADMIN'),/missing/)
 await claim(r.id)
 await rejects(claim(r.id,next),/unavailable/);await rejects(claim(competing.id,next),/changed/);await rejects(begin(),/held/)
 const checkpoint=(by=owner,step=null,result=null,finish=false)=>db.query('select artist_offboard_checkpoint($1,$2,$3,$4,$5,$6,$7)',[ws,r.id,'UPRODUCER',by,step,result?JSON.stringify(result):null,finish])
 await rejects(checkpoint(next),/ownership/)
 await rejects(checkpoint(owner,'slack',{}),/invalid/)
 await checkpoint(owner,'slack',{status:'removed',detail:'verified'})
 await checkpoint(owner,'frameio',{status:'review',detail:'provider outage'})
 await checkpoint(owner,null,null,true)
 assert.equal((await db.query('select status from artist_offboarding_requests where id=$1',[r.id])).rows[0].status,'partial');assertions++
 await claim(r.id,next)
 await rejects(checkpoint(owner),/ownership/)
 for (const step of ['dropbox','frameio','kit_access','assignments','harvest']) await checkpoint(next,step,{status:step==='harvest'?'retained':'removed',detail:'verified'})
 await checkpoint(next,null,null,true)
 assert.equal((await db.query('select state from artist_project_engagements where id=$1',[e.id])).rows[0].state,'offboarded');assertions++
 await rejects(begin(),/held/)
 await rejects(db.exec('delete from artist_access_audit'),/permission denied/)
 assert.ok((await db.query('select count(*)::int as n from artist_access_audit')).rows[0].n>=10);assertions++
 await db.exec('reset role')
 for (const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`)
  await rejects(begin(),/permission denied/)
  for (const table of ['artist_project_engagements','artist_offboarding_requests','artist_access_audit']) await rejects(db.query(`select * from ${table}`),/permission denied/)
  await db.exec('reset role')
 }
 assert.equal((await db.query('select count(*)::int as n from freelancer_onboardings')).rows[0].n,1);assertions++
 console.log(`PASS ${assertions} assertions: actual migration, service-role execution, actor/workspace checks, audit durability, onboarding/offboarding race hold, stale cards, cancellation, retries, fencing, no public grants, retained history.`)
} finally {await db.close()}
