import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('feedback registration, removals, leases, private grants and stale-worker protection', async () => {
  const db = new PGlite()
  const project='11111111-1111-4111-8111-111111111111', token='22222222-2222-4222-8222-222222222222', other='33333333-3333-4333-8333-333333333333'
  const source={key:'a'.repeat(64),provider:'figma',fileId:'FILE',url:'https://www.figma.com/design/FILE',label:'Deck'}
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create table projects(id uuid primary key); insert into projects values('${project}');`)
    await db.exec(await readFile(new URL('../supabase/migrations/20261010132354_project_feedback_sources.sql',import.meta.url),'utf8'))
    const register=async(s:unknown[])=>db.query('select register_project_feedback($1,$2::jsonb)',[project,JSON.stringify(s)])
    await register([source]); await register([source])
    const rows=(await db.query<{id:string;active:boolean}>('select * from project_feedback_sources')).rows
    assert.equal(rows.length,1);const id=rows[0].id
    const claim=async(t=token)=>(await db.query<{ok:boolean}>('select claim_project_feedback($1,$2) as ok',[id,t])).rows[0].ok
    assert.equal(await claim(),true);assert.equal(await claim(other),false)
    const finish=async(t=token)=>(await db.query<{ok:boolean}>('select finish_project_feedback($1,$2,$3,$4,$5,$6,$7) as ok',[id,t,'{"comments":[]}','heading','body',null,3600])).rows[0].ok
    assert.equal(await finish(other),false)
    await register([source]);assert.equal(await finish(),true) // unchanged discovery must not invalidate a worker
    assert.equal(await claim(),false) // not due
    await register([{...source,label:'Changed'}]);assert.equal(await claim(),true)
    await register([]);assert.equal(await finish(),false) // removal invalidates in-flight token
    assert.equal((await db.query<{active:boolean}>('select active from project_feedback_sources')).rows[0].active,false)
    await register([source]);assert.equal(await claim(),true)
    await db.exec(`update project_feedback_sources set lease_expires_at=now()-interval '1 second'`)
    assert.equal(await finish(),false);assert.equal(await claim(other),true)
    await assert.rejects(register([{...source,key:'x'}]),/check constraint/)
    await assert.rejects(register([{...source,key:'a'.repeat(12)+'b'.repeat(52)},source]),/unique constraint/)
    const permissions=(await db.query<{ok:boolean}>("select has_table_privilege('authenticated','project_feedback_sources','select') as ok")).rows[0].ok
    assert.equal(permissions,false)
    assert.equal((await db.query<{ok:boolean}>("select has_function_privilege('anon','register_project_feedback(uuid,jsonb)','execute') as ok")).rows[0].ok,false)
  } finally { await db.close() }
})
