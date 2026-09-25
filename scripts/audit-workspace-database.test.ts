import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'

test('actual audit migration rejects unscoped retrieval and cross-workspace membership', async () => {
  const db = new PGlite({ extensions: { vector } })
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  const member = '33333333-3333-4333-8333-333333333333'
  try {
    await db.exec(`create extension vector;
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to service_role;
      create table team_members(id uuid primary key, workspace_id uuid not null);
      create table project_access(workspace_id uuid not null, team_member_id uuid not null);
      create table project_documents(id uuid primary key, title text, content text, doc_type text,
        source_url text, project_id uuid, workspace_id uuid, metadata jsonb, visibility_tier text, embedding vector(3));`)
    await db.exec(await readFile(new URL('../supabase/migrations/20260925155214_audit_workspace_boundaries.sql', import.meta.url), 'utf8'))
    await db.query('insert into team_members values($1,$2)', [member, a])
    await db.query("insert into project_documents(id,title,workspace_id,visibility_tier,embedding) values ($1,'A',$1,'team','[1,0,0]'),($2,'B',$2,'team','[1,0,0]')", [a,b])
    await db.exec('set role service_role')
    await assert.rejects(db.query("select * from match_documents('[1,0,0]')"), /Workspace is required/)
    const found = await db.query<{title:string}>("select * from match_documents('[1,0,0]',10,$1)", [a])
    assert.deepEqual(found.rows.map(row => row.title), ['A'])
    await assert.rejects(db.query('insert into project_access values($1,$2)', [b, member]), /project_access_workspace_member_fkey/)
    await db.query('insert into project_access values($1,$2)', [a, member])
    await assert.rejects(db.query('update team_members set workspace_id=$1 where id=$2', [b, member]), /project_access_workspace_member_fkey/)
    await db.exec('reset role; set role anon')
    await assert.rejects(db.query("select * from match_documents('[1,0,0]',10,$1)", [a]), /permission denied/)
  } finally { await db.close() }
})
