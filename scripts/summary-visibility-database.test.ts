import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('financial summaries are restricted, including writes from the old deployed version', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated;
      create table project_documents(id int primary key, doc_type text, visibility_tier text, content text);
      insert into project_documents values(1,'project_summary','team','Budget: $10000'),(2,'note','team','Team note');`)
    await db.exec(await readFile(new URL('../supabase/migrations/20260925161544_project_summary_visibility.sql', import.meta.url), 'utf8'))
    await db.exec("update project_documents set visibility_tier='team' where id=1; insert into project_documents values(3,'project_summary','team','Private SOW'),(4,'project_summary_safe','team','Status: active')")
    const result = await db.query<{ id: number; visibility_tier: string }>('select id,visibility_tier from project_documents order by id')
    assert.deepEqual(result.rows.map(r => r.visibility_tier), ['founder','team','founder','team'])
    assert.equal((await db.query<{content:string}>('select content from project_documents where id=1')).rows[0].content, 'Budget: $10000')
  } finally { await db.close() }
})
